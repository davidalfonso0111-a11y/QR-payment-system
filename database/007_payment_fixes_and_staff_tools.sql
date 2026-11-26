-- Run AFTER 006_online_payments.sql in Supabase SQL Editor as administrator.
--
-- Fixes
--  * A retried online checkout could create a second Mollie payment. When the
--    first one expired, the whole order was cancelled, even if the guest then
--    paid the second one (paid money, order invisible to staff).
--    Now an order is only cancelled for a failed payment when NO other payment
--    is still pending, and a late successful payment reopens such an order.
--  * A payment that arrives after staff cancelled/rejected the order, or a
--    second successful payment for the same order, is recorded and flagged as
--    "needs refund" instead of being silently ignored.
--  * Online orders no longer log a misleading 'guest_cash_order_created' event.
--
-- New
--  * Staff: reject (awaiting acceptance) / cancel (later) an order.
--  * Owner/manager: refunds. Online refunds run through /api/staff-refund
--    (Mollie), cash refunds are registered directly.
--  * Staff: menu overview and "sold out" toggle for products and options.
--  * Staff order list now includes payments, cancel reason and needs_refund.
BEGIN;

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS cancel_reason text;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.orders'::regclass AND conname = 'orders_cancel_reason_check') THEN
    ALTER TABLE public.orders ADD CONSTRAINT orders_cancel_reason_check
      CHECK (cancel_reason IS NULL OR cancel_reason IN ('payment_failed', 'staff'));
  END IF;
END;
$$;

ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS refunded_at timestamptz;
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS refund_provider_id text;
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS refunded_by_user_id uuid;

-- ---------------------------------------------------------------------------
-- Internal helper: verify the logged-in user has an active membership with one
-- of the given roles. Not executable by API roles; only used inside other
-- SECURITY DEFINER functions.
CREATE OR REPLACE FUNCTION public.qr_require_staff(p_restaurant_id uuid, p_roles text[])
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_user uuid := auth.uid();
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Staff login required' USING ERRCODE = '42501';
  END IF;
  PERFORM 1
  FROM public.staff_memberships m
  JOIN public.restaurants r ON r.id = m.restaurant_id
  WHERE m.restaurant_id = p_restaurant_id AND m.user_id = v_user
    AND m.active AND r.active AND m.role = ANY (p_roles)
  FOR SHARE OF m, r;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No sufficient staff access to this restaurant' USING ERRCODE = '42501';
  END IF;
  RETURN v_user;
END;
$$;
REVOKE ALL ON FUNCTION public.qr_require_staff(uuid, text[]) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Online order creation: same validation as before, correct audit event.
CREATE OR REPLACE FUNCTION public.qr_create_online_order(
  p_qr_token uuid, p_idempotency_key uuid, p_guest_secret text, p_items jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  t public.restaurant_tables%ROWTYPE;
  prev public.orders%ROWTYPE;
  res jsonb;
  oid uuid;
  secret_hash text;
  request_hash text;
BEGIN
  IF p_qr_token IS NULL OR p_idempotency_key IS NULL
    OR p_guest_secret IS NULL OR p_guest_secret !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Ongeldige bestelaanvraag';
  END IF;
  secret_hash := encode(sha256(convert_to(p_guest_secret,'UTF8')),'hex');
  request_hash := encode(sha256(convert_to(p_items::text,'UTF8')),'hex');

  SELECT rt.* INTO t FROM public.restaurant_tables rt
    JOIN public.restaurants r ON r.id = rt.restaurant_id
    WHERE rt.qr_token = p_qr_token AND rt.active AND r.active;
  IF NOT FOUND THEN RAISE EXCEPTION 'Tafel niet beschikbaar'; END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(t.restaurant_id::text || ':' || p_idempotency_key::text, 0));
  SELECT * INTO prev FROM public.orders
    WHERE restaurant_id = t.restaurant_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF prev.table_id <> t.id OR prev.payment_method <> 'online'
      OR prev.guest_access_token_hash <> secret_hash
      OR prev.guest_request_hash IS DISTINCT FROM request_hash THEN
      RAISE EXCEPTION 'Bestelpoging komt niet overeen';
    END IF;
    RETURN jsonb_build_object('id', prev.id, 'order_number', prev.order_number,
      'total_cents', prev.total_cents, 'status', prev.status,
      'payment_status', prev.payment_status, 'replayed', true);
  END IF;

  res := public.qr_create_cash_order(p_qr_token, p_idempotency_key, p_guest_secret, p_items);
  oid := (res->>'id')::uuid;
  UPDATE public.orders
    SET payment_method = 'online', payment_status = 'pending', status = 'awaiting_payment'
    WHERE id = oid;
  -- The shared creation logic logged a cash event; this order is not cash.
  DELETE FROM public.order_events
    WHERE order_id = oid AND event_type = 'guest_cash_order_created';
  INSERT INTO public.order_events(restaurant_id, order_id, event_type, details)
    VALUES (t.restaurant_id, oid, 'online_order_created',
      jsonb_build_object('source', 'server'));
  RETURN jsonb_build_object('id', oid, 'order_number', res->'order_number',
    'total_cents', res->'total_cents', 'status', 'awaiting_payment',
    'payment_status', 'pending', 'replayed', false);
END;
$$;

-- Server only: Mollie payment ids still pending for an order, newest first.
-- Used so a retried checkout reuses an open payment instead of creating more.
CREATE OR REPLACE FUNCTION public.qr_online_pending_payments(p_order_id uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT COALESCE(jsonb_agg(p.provider_payment_id ORDER BY p.created_at DESC), '[]'::jsonb)
  FROM public.payments p
  WHERE p.order_id = p_order_id AND p.method = 'online'
    AND p.provider = 'mollie' AND p.status = 'pending';
$$;

-- ---------------------------------------------------------------------------
-- Apply a payment status that the server re-fetched from Mollie.
CREATE OR REPLACE FUNCTION public.qr_apply_mollie_status(
  p_provider_payment_id text, p_mollie_status text,
  p_amount_cents integer, p_currency text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_order_id uuid;
  pay public.payments%ROWTYPE;
  o public.orders%ROWTYPE;
BEGIN
  SELECT order_id INTO v_order_id FROM public.payments
    WHERE provider = 'mollie' AND provider_payment_id = p_provider_payment_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Onbekende betaling'; END IF;
  -- Lock order first, then payment: same order as every other writer.
  SELECT * INTO o FROM public.orders WHERE id = v_order_id FOR UPDATE;
  SELECT * INTO pay FROM public.payments
    WHERE provider = 'mollie' AND provider_payment_id = p_provider_payment_id FOR UPDATE;

  -- Final states never go back (Mollie keeps status 'paid' after a refund).
  IF pay.status IN ('paid', 'refunded') THEN
    RETURN jsonb_build_object('result', 'already_processed', 'order_id', o.id);
  END IF;

  IF p_mollie_status = 'paid' THEN
    IF p_currency IS DISTINCT FROM 'EUR' OR p_amount_cents IS DISTINCT FROM pay.amount_cents
      OR pay.amount_cents <> o.total_cents THEN
      INSERT INTO public.order_events(restaurant_id, order_id, event_type, details)
        VALUES (o.restaurant_id, o.id, 'online_payment_amount_mismatch',
          jsonb_build_object('payment_id', pay.id, 'paid_cents', p_amount_cents,
            'expected_cents', o.total_cents));
      RETURN jsonb_build_object('result', 'amount_mismatch', 'order_id', o.id);
    END IF;

    UPDATE public.payments SET status = 'paid', paid_at = now() WHERE id = pay.id;

    IF o.payment_status = 'paid' THEN
      -- Guest paid twice (e.g. two tabs). Keep the order, flag for refund.
      INSERT INTO public.order_events(restaurant_id, order_id, event_type, details)
        VALUES (o.restaurant_id, o.id, 'online_payment_duplicate_needs_refund',
          jsonb_build_object('payment_id', pay.id));
      RETURN jsonb_build_object('result', 'duplicate', 'order_id', o.id);
    END IF;

    IF o.status = 'awaiting_payment'
      OR (o.status = 'cancelled' AND o.cancel_reason = 'payment_failed') THEN
      UPDATE public.orders
        SET payment_status = 'paid', status = 'received', cancel_reason = NULL
        WHERE id = o.id;
      INSERT INTO public.order_events(restaurant_id, order_id, event_type, details)
        VALUES (o.restaurant_id, o.id, 'online_payment_paid',
          jsonb_build_object('provider', 'mollie', 'payment_id', pay.id,
            'reopened', o.status = 'cancelled'));
      RETURN jsonb_build_object('result', 'paid', 'order_id', o.id);
    END IF;

    -- Staff already rejected/cancelled the order: money must go back.
    UPDATE public.orders SET payment_status = 'paid' WHERE id = o.id;
    INSERT INTO public.order_events(restaurant_id, order_id, event_type, details)
      VALUES (o.restaurant_id, o.id, 'online_payment_late_needs_refund',
        jsonb_build_object('payment_id', pay.id, 'order_status', o.status));
    RETURN jsonb_build_object('result', 'late_needs_refund', 'order_id', o.id);
  END IF;

  IF p_mollie_status IN ('failed', 'canceled', 'expired') THEN
    IF pay.status = 'failed' THEN
      RETURN jsonb_build_object('result', 'already_processed', 'order_id', o.id);
    END IF;
    UPDATE public.payments SET status = 'failed' WHERE id = pay.id;
    INSERT INTO public.order_events(restaurant_id, order_id, event_type, details)
      VALUES (o.restaurant_id, o.id, 'online_payment_' || p_mollie_status,
        jsonb_build_object('provider', 'mollie', 'payment_id', pay.id));
    -- Only give up on the order when no other payment attempt is still open.
    IF o.status = 'awaiting_payment' AND NOT EXISTS (
      SELECT 1 FROM public.payments p
      WHERE p.order_id = o.id AND p.id <> pay.id AND p.status IN ('pending', 'paid')
    ) THEN
      UPDATE public.orders
        SET payment_status = 'failed', status = 'cancelled', cancel_reason = 'payment_failed'
        WHERE id = o.id;
      RETURN jsonb_build_object('result', 'failed', 'order_id', o.id);
    END IF;
    RETURN jsonb_build_object('result', 'attempt_failed', 'order_id', o.id);
  END IF;

  RETURN jsonb_build_object('result', 'still_open', 'order_id', o.id);
END;
$$;

-- ---------------------------------------------------------------------------
-- Staff order list (replaces 003 version): adds payments, cancel reason and a
-- needs_refund flag. Still never exposes guest secrets or request hashes.
CREATE OR REPLACE FUNCTION public.qr_staff_orders(
  p_restaurant_id uuid,
  p_limit integer DEFAULT 100
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_result jsonb;
BEGIN
  PERFORM public.qr_require_staff(p_restaurant_id, ARRAY['owner','manager','staff']);
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 200 THEN
    RAISE EXCEPTION 'Limit must be between 1 and 200' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(jsonb_agg(x.payload ORDER BY x.created_at DESC, x.id DESC), '[]'::jsonb)
  INTO v_result
  FROM (
    SELECT o.id, o.created_at, jsonb_build_object(
      'id', o.id,
      'order_number', o.order_number,
      'restaurant_id', o.restaurant_id,
      'table_number', t.table_number,
      'payment_method', o.payment_method,
      'payment_status', o.payment_status,
      'status', o.status,
      'cancel_reason', o.cancel_reason,
      'total_cents', o.total_cents,
      'created_at', o.created_at,
      'updated_at', o.updated_at,
      'needs_refund', (
        (o.status IN ('rejected','cancelled') AND EXISTS (
          SELECT 1 FROM public.payments p
          WHERE p.restaurant_id = o.restaurant_id AND p.order_id = o.id AND p.status = 'paid'))
        OR (SELECT count(*) FROM public.payments p
            WHERE p.restaurant_id = o.restaurant_id AND p.order_id = o.id AND p.status = 'paid') > 1
      ),
      'payments', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', p.id, 'method', p.method, 'status', p.status,
          'amount_cents', p.amount_cents, 'paid_at', p.paid_at,
          'refunded_at', p.refunded_at
        ) ORDER BY p.created_at)
        FROM public.payments p
        WHERE p.restaurant_id = o.restaurant_id AND p.order_id = o.id
      ), '[]'::jsonb),
      'items', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', i.id,
          'product_name', i.product_name,
          'option_name', i.option_name,
          'quantity', i.quantity,
          'unit_price_cents', i.unit_price_cents,
          'note', i.note
        ) ORDER BY i.id)
        FROM public.order_items i
        WHERE i.restaurant_id = o.restaurant_id AND i.order_id = o.id
      ), '[]'::jsonb)
    ) AS payload
    FROM public.orders o
    JOIN public.restaurant_tables t
      ON t.restaurant_id = o.restaurant_id AND t.id = o.table_id
    WHERE o.restaurant_id = p_restaurant_id
    ORDER BY o.created_at DESC, o.id DESC
    LIMIT p_limit
  ) x;
  RETURN v_result;
END;
$$;

-- ---------------------------------------------------------------------------
-- Staff: reject (still awaiting acceptance) or cancel (accepted, not served).
-- Paid orders can be cancelled too; they are then flagged needs_refund.
CREATE OR REPLACE FUNCTION public.qr_staff_cancel_order(
  p_restaurant_id uuid, p_order_id uuid, p_expected_status text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_user uuid;
  v_order public.orders%ROWTYPE;
  v_next text;
  v_replayed boolean := false;
BEGIN
  v_user := public.qr_require_staff(p_restaurant_id, ARRAY['owner','manager','staff']);
  IF p_expected_status IS NULL THEN
    RAISE EXCEPTION 'Expected order status required' USING ERRCODE = '22023';
  END IF;
  SELECT o.* INTO v_order FROM public.orders o
  WHERE o.id = p_order_id AND o.restaurant_id = p_restaurant_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found in this restaurant' USING ERRCODE = '22023';
  END IF;

  v_next := CASE WHEN p_expected_status = 'awaiting_acceptance' THEN 'rejected' ELSE 'cancelled' END;
  IF v_order.status = v_next AND v_order.cancel_reason = 'staff' THEN
    v_replayed := true;
  ELSIF v_order.status <> p_expected_status THEN
    RAISE EXCEPTION 'Order changed; refresh before continuing' USING ERRCODE = '40001';
  ELSIF v_order.status NOT IN ('awaiting_payment','awaiting_acceptance','received','preparing','ready') THEN
    RAISE EXCEPTION 'This order can no longer be cancelled' USING ERRCODE = '22023';
  ELSE
    UPDATE public.orders SET status = v_next, cancel_reason = 'staff'
    WHERE id = p_order_id AND restaurant_id = p_restaurant_id;
    INSERT INTO public.order_events (restaurant_id, order_id, event_type, actor_user_id, details)
    VALUES (p_restaurant_id, p_order_id, 'staff_order_' || v_next, v_user,
      jsonb_build_object('previous_status', v_order.status,
        'payment_status', v_order.payment_status));
  END IF;

  SELECT o.* INTO v_order FROM public.orders o
  WHERE o.id = p_order_id AND o.restaurant_id = p_restaurant_id;
  RETURN jsonb_build_object('id', v_order.id, 'order_number', v_order.order_number,
    'status', v_order.status, 'payment_status', v_order.payment_status,
    'replayed', v_replayed);
END;
$$;

-- ---------------------------------------------------------------------------
-- Refund rule shared by cash and online: a paid payment may be refunded when
-- the order was rejected/cancelled, or when it is an extra (duplicate) payment.
CREATE OR REPLACE FUNCTION public.qr_payment_refundable(p_payment_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.payments p
    JOIN public.orders o ON o.restaurant_id = p.restaurant_id AND o.id = p.order_id
    WHERE p.id = p_payment_id AND p.status = 'paid' AND p.refund_provider_id IS NULL
      AND (o.status IN ('rejected','cancelled')
        OR EXISTS (SELECT 1 FROM public.payments q
          WHERE q.order_id = p.order_id AND q.id <> p.id AND q.status = 'paid'
            AND (q.paid_at, q.id) < (p.paid_at, p.id)))
  );
$$;
REVOKE ALL ON FUNCTION public.qr_payment_refundable(uuid) FROM PUBLIC, anon, authenticated;

-- Internal: mark refunded and fix the order payment status.
CREATE OR REPLACE FUNCTION public.qr_mark_refunded(
  p_payment_id uuid, p_user uuid, p_refund_provider_id text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE pay public.payments%ROWTYPE;
BEGIN
  UPDATE public.payments
    SET status = 'refunded', refunded_at = now(),
        refund_provider_id = p_refund_provider_id, refunded_by_user_id = p_user
    WHERE id = p_payment_id RETURNING * INTO pay;
  IF NOT EXISTS (SELECT 1 FROM public.payments p
                 WHERE p.order_id = pay.order_id AND p.status = 'paid') THEN
    UPDATE public.orders SET payment_status = 'refunded'
      WHERE id = pay.order_id AND restaurant_id = pay.restaurant_id;
  END IF;
  INSERT INTO public.order_events (restaurant_id, order_id, event_type, actor_user_id, details)
  VALUES (pay.restaurant_id, pay.order_id, pay.method || '_payment_refunded', p_user,
    jsonb_build_object('payment_id', pay.id, 'amount_cents', pay.amount_cents,
      'refund_provider_id', p_refund_provider_id));
END;
$$;
REVOKE ALL ON FUNCTION public.qr_mark_refunded(uuid, uuid, text) FROM PUBLIC, anon, authenticated;

-- Owner/manager: register that cash was handed back.
CREATE OR REPLACE FUNCTION public.qr_staff_cash_refund(
  p_restaurant_id uuid, p_order_id uuid, p_payment_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid; pay public.payments%ROWTYPE;
BEGIN
  v_user := public.qr_require_staff(p_restaurant_id, ARRAY['owner','manager']);
  PERFORM 1 FROM public.orders o
    WHERE o.id = p_order_id AND o.restaurant_id = p_restaurant_id FOR UPDATE;
  SELECT p.* INTO pay FROM public.payments p
    WHERE p.id = p_payment_id AND p.order_id = p_order_id
      AND p.restaurant_id = p_restaurant_id FOR UPDATE;
  IF NOT FOUND OR pay.method <> 'cash' THEN
    RAISE EXCEPTION 'Cash payment not found for this order' USING ERRCODE = '22023';
  END IF;
  IF pay.status = 'refunded' THEN
    RETURN jsonb_build_object('payment_id', pay.id, 'replayed', true);
  END IF;
  IF NOT public.qr_payment_refundable(pay.id) THEN
    RAISE EXCEPTION 'Payment is not refundable; cancel the order first' USING ERRCODE = '22023';
  END IF;
  PERFORM public.qr_mark_refunded(pay.id, v_user, NULL);
  RETURN jsonb_build_object('payment_id', pay.id, 'replayed', false);
END;
$$;

-- Owner/manager, called by /api/staff-refund WITH THE STAFF USER'S JWT:
-- checks access and returns what the server needs to refund at Mollie.
CREATE OR REPLACE FUNCTION public.qr_staff_refund_prepare(
  p_restaurant_id uuid, p_order_id uuid, p_payment_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid; pay public.payments%ROWTYPE;
BEGIN
  v_user := public.qr_require_staff(p_restaurant_id, ARRAY['owner','manager']);
  SELECT p.* INTO pay FROM public.payments p
    WHERE p.id = p_payment_id AND p.order_id = p_order_id
      AND p.restaurant_id = p_restaurant_id;
  IF NOT FOUND OR pay.method <> 'online' OR pay.provider <> 'mollie' THEN
    RAISE EXCEPTION 'Online payment not found for this order' USING ERRCODE = '22023';
  END IF;
  IF pay.status = 'refunded' THEN
    RETURN jsonb_build_object('already_refunded', true);
  END IF;
  IF NOT public.qr_payment_refundable(pay.id) THEN
    RAISE EXCEPTION 'Payment is not refundable; cancel the order first' USING ERRCODE = '22023';
  END IF;
  RETURN jsonb_build_object('already_refunded', false,
    'provider_payment_id', pay.provider_payment_id,
    'amount_cents', pay.amount_cents, 'user_id', v_user,
    'order_number', (SELECT o.order_number FROM public.orders o WHERE o.id = pay.order_id));
END;
$$;

-- Server only: record a refund that Mollie accepted.
CREATE OR REPLACE FUNCTION public.qr_record_online_refund(
  p_provider_payment_id text, p_refund_id text, p_user_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE pay public.payments%ROWTYPE;
BEGIN
  SELECT p.* INTO pay FROM public.payments p
    WHERE p.provider = 'mollie' AND p.provider_payment_id = p_provider_payment_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Onbekende betaling'; END IF;
  PERFORM 1 FROM public.orders o WHERE o.id = pay.order_id FOR UPDATE;
  SELECT p.* INTO pay FROM public.payments p WHERE p.id = pay.id FOR UPDATE;
  IF pay.status = 'refunded' THEN
    RETURN jsonb_build_object('replayed', true);
  END IF;
  IF pay.status <> 'paid' THEN
    RAISE EXCEPTION 'Betaling is niet betaald';
  END IF;
  PERFORM public.qr_mark_refunded(pay.id, p_user_id, p_refund_id);
  RETURN jsonb_build_object('replayed', false);
END;
$$;

-- ---------------------------------------------------------------------------
-- Staff menu: see everything (also unavailable) and toggle "sold out".
CREATE OR REPLACE FUNCTION public.qr_staff_menu(p_restaurant_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_result jsonb;
BEGIN
  PERFORM public.qr_require_staff(p_restaurant_id, ARRAY['owner','manager','staff']);
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', p.id, 'name', p.name, 'category', p.category,
    'price_cents', p.price_cents, 'available', p.available,
    'options', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', o.id, 'name', o.name, 'price_cents', o.price_cents, 'available', o.available
      ) ORDER BY o.name) FROM public.product_options o
      WHERE o.restaurant_id = p.restaurant_id AND o.product_id = p.id), '[]'::jsonb)
  ) ORDER BY p.sort_order, p.name), '[]'::jsonb)
  INTO v_result
  FROM public.products p WHERE p.restaurant_id = p_restaurant_id;
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.qr_staff_set_available(
  p_restaurant_id uuid, p_kind text, p_id uuid, p_available boolean
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid; v_name text;
BEGIN
  v_user := public.qr_require_staff(p_restaurant_id, ARRAY['owner','manager','staff']);
  IF p_available IS NULL THEN
    RAISE EXCEPTION 'Availability required' USING ERRCODE = '22023';
  END IF;
  IF p_kind = 'product' THEN
    UPDATE public.products SET available = p_available
      WHERE id = p_id AND restaurant_id = p_restaurant_id RETURNING name INTO v_name;
  ELSIF p_kind = 'option' THEN
    UPDATE public.product_options SET available = p_available
      WHERE id = p_id AND restaurant_id = p_restaurant_id RETURNING name INTO v_name;
  ELSE
    RAISE EXCEPTION 'Unknown item kind' USING ERRCODE = '22023';
  END IF;
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'Item not found in this restaurant' USING ERRCODE = '22023';
  END IF;
  RETURN jsonb_build_object('id', p_id, 'kind', p_kind, 'available', p_available);
END;
$$;

-- ---------------------------------------------------------------------------
-- Guest status (replaces 005 version): also returns why an order was cancelled.
CREATE OR REPLACE FUNCTION public.qr_guest_order_status(
  p_order_id uuid,
  p_guest_secret text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  o public.orders%ROWTYPE;
BEGIN
  IF p_order_id IS NULL OR p_guest_secret IS NULL
     OR p_guest_secret !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Bestelling niet beschikbaar' USING ERRCODE = 'P0001';
  END IF;
  SELECT ord.* INTO o
  FROM public.orders ord
  WHERE ord.id = p_order_id
    AND ord.guest_access_token_hash =
      encode(sha256(convert_to(p_guest_secret, 'UTF8')), 'hex');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bestelling niet beschikbaar' USING ERRCODE = 'P0001';
  END IF;
  RETURN jsonb_build_object(
    'id', o.id,
    'order_number', o.order_number,
    'status', o.status,
    'cancel_reason', o.cancel_reason,
    'payment_method', o.payment_method,
    'payment_status', o.payment_status,
    'total_cents', o.total_cents,
    'created_at', o.created_at,
    'updated_at', o.updated_at
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants. PostgreSQL grants EXECUTE to PUBLIC by default: remove it everywhere.
REVOKE ALL ON FUNCTION public.qr_create_online_order(uuid, uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.qr_online_pending_payments(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.qr_apply_mollie_status(text, text, integer, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.qr_record_online_refund(text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.qr_create_online_order(uuid, uuid, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.qr_online_pending_payments(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.qr_apply_mollie_status(text, text, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.qr_record_online_refund(text, text, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.qr_staff_orders(uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.qr_staff_cancel_order(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.qr_staff_cash_refund(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.qr_staff_refund_prepare(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.qr_staff_menu(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.qr_staff_set_available(uuid, text, uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.qr_staff_orders(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.qr_staff_cancel_order(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.qr_staff_cash_refund(uuid, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.qr_staff_refund_prepare(uuid, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.qr_staff_menu(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.qr_staff_set_available(uuid, text, uuid, boolean) TO authenticated;

REVOKE ALL ON FUNCTION public.qr_guest_order_status(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.qr_guest_order_status(uuid, text) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;

-- Install success normally says: Success. No rows returned.
-- Refunds: only 'owner' and 'manager' memberships. Online refunds need the
-- Vercel route /api/staff-refund (Mollie key stays on the server).
