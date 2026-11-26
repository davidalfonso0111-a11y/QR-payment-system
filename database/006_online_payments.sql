-- Run AFTER 005 in Supabase SQL Editor.
-- Online payments (Mollie). These functions are for the trusted server only
-- (Vercel API routes using the service_role key). Guests and staff in the
-- browser can NOT call them.
-- Flow: create order (awaiting_payment) -> attach Mollie payment id ->
-- Mollie webhook -> server re-fetches the payment from Mollie -> applies status.
-- An online order only becomes visible work for staff (status 'received')
-- after Mollie confirmed the payment with the correct amount.
BEGIN;

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

  -- Reuse the validated cash logic (server-side prices, limits, snapshots),
  -- then convert the order inside the same transaction.
  res := public.qr_create_cash_order(p_qr_token, p_idempotency_key, p_guest_secret, p_items);
  oid := (res->>'id')::uuid;
  UPDATE public.orders
    SET payment_method = 'online', payment_status = 'pending', status = 'awaiting_payment'
    WHERE id = oid;
  INSERT INTO public.order_events(restaurant_id, order_id, event_type, details)
    VALUES (t.restaurant_id, oid, 'online_order_created',
      jsonb_build_object('source', 'server'));
  RETURN jsonb_build_object('id', oid, 'order_number', res->'order_number',
    'total_cents', res->'total_cents', 'status', 'awaiting_payment',
    'payment_status', 'pending', 'replayed', false);
END;
$$;

CREATE OR REPLACE FUNCTION public.qr_attach_online_payment(
  p_order_id uuid, p_provider_payment_id text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE o public.orders%ROWTYPE;
BEGIN
  IF p_provider_payment_id IS NULL OR length(p_provider_payment_id) NOT BETWEEN 3 AND 80 THEN
    RAISE EXCEPTION 'Ongeldig betaal-ID';
  END IF;
  SELECT * INTO o FROM public.orders
    WHERE id = p_order_id AND payment_method = 'online' AND status = 'awaiting_payment'
    FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bestelling wacht niet op betaling'; END IF;
  INSERT INTO public.payments(restaurant_id, order_id, method, status, amount_cents,
    provider, provider_payment_id)
  VALUES (o.restaurant_id, o.id, 'online', 'pending', o.total_cents,
    'mollie', p_provider_payment_id)
  ON CONFLICT (provider, provider_payment_id) DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION public.qr_apply_mollie_status(
  p_provider_payment_id text, p_mollie_status text,
  p_amount_cents integer, p_currency text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  pay public.payments%ROWTYPE;
  o public.orders%ROWTYPE;
BEGIN
  SELECT * INTO pay FROM public.payments
    WHERE provider = 'mollie' AND provider_payment_id = p_provider_payment_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Onbekende betaling'; END IF;
  SELECT * INTO o FROM public.orders WHERE id = pay.order_id FOR UPDATE;

  IF pay.status = 'paid' THEN
    RETURN jsonb_build_object('result', 'already_paid', 'order_id', o.id);
  END IF;

  IF p_mollie_status = 'paid' THEN
    IF p_currency IS DISTINCT FROM 'EUR' OR p_amount_cents IS DISTINCT FROM o.total_cents
      OR pay.amount_cents <> o.total_cents THEN
      INSERT INTO public.order_events(restaurant_id, order_id, event_type, details)
        VALUES (o.restaurant_id, o.id, 'online_payment_amount_mismatch',
          jsonb_build_object('paid_cents', p_amount_cents, 'expected_cents', o.total_cents));
      RETURN jsonb_build_object('result', 'amount_mismatch', 'order_id', o.id);
    END IF;
    UPDATE public.payments SET status = 'paid', paid_at = now() WHERE id = pay.id;
    UPDATE public.orders
      SET payment_status = 'paid',
          status = CASE WHEN status = 'awaiting_payment' THEN 'received' ELSE status END
      WHERE id = o.id;
    INSERT INTO public.order_events(restaurant_id, order_id, event_type, details)
      VALUES (o.restaurant_id, o.id, 'online_payment_paid',
        jsonb_build_object('provider', 'mollie'));
    RETURN jsonb_build_object('result', 'paid', 'order_id', o.id);
  END IF;

  IF p_mollie_status IN ('failed', 'canceled', 'expired') THEN
    UPDATE public.payments SET status = 'failed' WHERE id = pay.id;
    UPDATE public.orders SET payment_status = 'failed', status = 'cancelled'
      WHERE id = o.id AND status = 'awaiting_payment';
    INSERT INTO public.order_events(restaurant_id, order_id, event_type, details)
      VALUES (o.restaurant_id, o.id, 'online_payment_' || p_mollie_status,
        jsonb_build_object('provider', 'mollie'));
    RETURN jsonb_build_object('result', 'failed', 'order_id', o.id);
  END IF;

  RETURN jsonb_build_object('result', 'still_open', 'order_id', o.id);
END;
$$;

-- Server only: remove default Supabase grants for browser roles.
REVOKE ALL ON FUNCTION public.qr_create_online_order(uuid, uuid, text, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.qr_attach_online_payment(uuid, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.qr_apply_mollie_status(text, text, integer, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.qr_create_online_order(uuid, uuid, text, jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.qr_attach_online_payment(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.qr_apply_mollie_status(text, text, integer, text)
  TO service_role;
COMMIT;
