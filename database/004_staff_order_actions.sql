-- Run AFTER 003_staff_auth_access.sql in Supabase SQL Editor as administrator.
-- Adds RPC only; staff.html is NOT changed by this migration.
-- No anonymous access and no direct browser write permissions.
BEGIN;

CREATE OR REPLACE FUNCTION public.qr_staff_order_action(
  p_restaurant_id uuid,
  p_order_id uuid,
  p_action text,
  p_expected_status text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_order public.orders%ROWTYPE;
  v_next text;
  v_required text;
  v_replayed boolean := false;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Staff login required' USING ERRCODE = '42501';
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('accept','prepare','ready','serve','cash') THEN
    RAISE EXCEPTION 'Unknown staff action' USING ERRCODE = '22023';
  END IF;
  IF p_expected_status IS NULL THEN
    RAISE EXCEPTION 'Expected order status required' USING ERRCODE = '22023';
  END IF;

  -- Authorize against current DB membership; lock it against concurrent revocation.
  PERFORM 1
  FROM public.staff_memberships m
  JOIN public.restaurants r ON r.id = m.restaurant_id
  WHERE m.restaurant_id = p_restaurant_id AND m.user_id = v_user
    AND m.active AND r.active AND m.role IN ('owner','manager','staff')
  FOR SHARE OF m, r;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No active staff access to this restaurant' USING ERRCODE = '42501';
  END IF;

  SELECT o.* INTO v_order FROM public.orders o
  WHERE o.id = p_order_id AND o.restaurant_id = p_restaurant_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found in this restaurant' USING ERRCODE = '22023';
  END IF;

  IF p_action = 'cash' THEN
    IF v_order.payment_method <> 'cash' THEN
      RAISE EXCEPTION 'Only cash orders can be paid through this action' USING ERRCODE = '22023';
    END IF;
    IF v_order.payment_status = 'paid' THEN
      -- Network retries must not create another payment or audit event.
      PERFORM 1 FROM public.payments p
      WHERE p.restaurant_id = p_restaurant_id AND p.order_id = p_order_id
        AND p.method = 'cash' AND p.status = 'paid'
        AND p.amount_cents = v_order.total_cents;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Paid order has no matching cash record; administrator review required'
          USING ERRCODE = '22023';
      END IF;
      v_replayed := true;
    ELSE
      IF v_order.status <> p_expected_status THEN
        RAISE EXCEPTION 'Order changed; refresh before continuing' USING ERRCODE = '40001';
      END IF;
      IF v_order.status NOT IN ('received','preparing','ready','served')
        OR v_order.payment_status <> 'unpaid' THEN
        RAISE EXCEPTION 'Order is not eligible for cash registration' USING ERRCODE = '22023';
      END IF;
      PERFORM 1 FROM public.payments p
      WHERE p.restaurant_id = p_restaurant_id AND p.order_id = p_order_id
        AND p.status IN ('pending','paid','refunded');
      IF FOUND THEN
        RAISE EXCEPTION 'Existing payment needs administrator review' USING ERRCODE = '22023';
      END IF;

      INSERT INTO public.payments
        (restaurant_id, order_id, method, status, amount_cents, recorded_by_user_id, paid_at)
      VALUES (p_restaurant_id, p_order_id, 'cash', 'paid', v_order.total_cents, v_user, now());
      UPDATE public.orders SET payment_status = 'paid'
      WHERE id = p_order_id AND restaurant_id = p_restaurant_id;
      INSERT INTO public.order_events
        (restaurant_id, order_id, event_type, actor_user_id, details)
      VALUES (p_restaurant_id, p_order_id, 'cash_payment_recorded', v_user,
        jsonb_build_object('amount_cents', v_order.total_cents,
          'previous_payment_status', v_order.payment_status, 'payment_status', 'paid'));
    END IF;
  ELSE
    CASE p_action
      WHEN 'accept' THEN v_required := 'awaiting_acceptance'; v_next := 'received';
      WHEN 'prepare' THEN v_required := 'received'; v_next := 'preparing';
      WHEN 'ready' THEN v_required := 'preparing'; v_next := 'ready';
      WHEN 'serve' THEN v_required := 'ready'; v_next := 'served';
    END CASE;
    IF p_expected_status <> v_required THEN
      RAISE EXCEPTION 'Invalid expected status for this action' USING ERRCODE = '22023';
    END IF;
    IF v_order.status = v_next THEN
      v_replayed := true;
    ELSIF v_order.status <> v_required THEN
      RAISE EXCEPTION 'Order changed; refresh before continuing' USING ERRCODE = '40001';
    ELSE
      IF v_order.payment_method = 'online' AND v_order.payment_status <> 'paid' THEN
        RAISE EXCEPTION 'Online payment must be confirmed before preparation'
          USING ERRCODE = '22023';
      END IF;
      UPDATE public.orders SET status = v_next
      WHERE id = p_order_id AND restaurant_id = p_restaurant_id;
      INSERT INTO public.order_events
        (restaurant_id, order_id, event_type, actor_user_id, details)
      VALUES (p_restaurant_id, p_order_id, 'staff_status_changed', v_user,
        jsonb_build_object('action', p_action, 'previous_status', v_order.status, 'status', v_next));
    END IF;
  END IF;

  -- Explicit safe output; never return guest secrets or request hashes.
  SELECT o.* INTO v_order FROM public.orders o
  WHERE o.id = p_order_id AND o.restaurant_id = p_restaurant_id;
  RETURN jsonb_build_object(
    'id', v_order.id, 'order_number', v_order.order_number,
    'restaurant_id', v_order.restaurant_id, 'status', v_order.status,
    'payment_method', v_order.payment_method, 'payment_status', v_order.payment_status,
    'total_cents', v_order.total_cents, 'updated_at', v_order.updated_at,
    'replayed', v_replayed);
END;
$$;

REVOKE ALL ON FUNCTION public.qr_staff_order_action(uuid, uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.qr_staff_order_action(uuid, uuid, text, text)
  TO authenticated;
NOTIFY pgrst, 'reload schema';
COMMIT;

-- Install success normally says: Success. No rows returned.
-- Actions require a real logged-in staff JWT. SQL Editor has no auth.uid() by default.
-- After UI integration test: anonymous denied, other restaurant denied,
-- inactive membership denied, stale transition rejected, repeated cash records once.
-- Cash confirmation in UI must explicitly mean that money has actually been received.
-- Online payments, refunds, rejection and cancellation are not implemented here.
