-- Run AFTER 007 in Supabase SQL Editor as administrator.
-- Live updates via Supabase Realtime "Broadcast from Database".
--
-- When an order or payment changes, the database sends a small "changed" signal.
-- The signal contains NO order data: the page then fetches the new status through
-- the existing, access-checked RPCs. So a leaked topic name reveals nothing more
-- than "something changed".
--
-- Topics (public broadcast channels, the topic name itself is the secret):
--  * guest:  'order-' || guest_access_token_hash   (only the guest's device can
--            compute this: it is the SHA-256 of the guest secret)
--  * staff:  'staff-' || restaurants.staff_realtime_key  (random, only returned
--            to logged-in staff by qr_staff_restaurants)
-- Pages keep polling slowly as a fallback if Realtime is unavailable.
BEGIN;

ALTER TABLE public.restaurants
  ADD COLUMN IF NOT EXISTS staff_realtime_key uuid NOT NULL DEFAULT gen_random_uuid();

CREATE OR REPLACE FUNCTION public.qr_realtime_ping(p_topic text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  -- realtime.send never raises inside triggers; the guard below also keeps
  -- orders working on a database without the Realtime extension.
  PERFORM realtime.send('{}'::jsonb, 'changed', p_topic, false);
EXCEPTION WHEN undefined_function OR invalid_schema_name THEN
  NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.qr_realtime_ping(text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.qr_orders_broadcast()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_key uuid;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.payment_status IS NOT DISTINCT FROM OLD.payment_status THEN
    RETURN NULL;
  END IF;
  PERFORM public.qr_realtime_ping('order-' || NEW.guest_access_token_hash);
  SELECT r.staff_realtime_key INTO v_key FROM public.restaurants r WHERE r.id = NEW.restaurant_id;
  IF v_key IS NOT NULL THEN
    PERFORM public.qr_realtime_ping('staff-' || v_key::text);
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.qr_orders_broadcast() FROM PUBLIC, anon, authenticated;

-- Payments can change without the order changing (e.g. a duplicate payment).
CREATE OR REPLACE FUNCTION public.qr_payments_broadcast()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_key uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NULL;
  END IF;
  SELECT r.staff_realtime_key INTO v_key FROM public.restaurants r WHERE r.id = NEW.restaurant_id;
  IF v_key IS NOT NULL THEN
    PERFORM public.qr_realtime_ping('staff-' || v_key::text);
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.qr_payments_broadcast() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS orders_broadcast ON public.orders;
CREATE TRIGGER orders_broadcast AFTER INSERT OR UPDATE ON public.orders
FOR EACH ROW EXECUTE FUNCTION public.qr_orders_broadcast();

DROP TRIGGER IF EXISTS payments_broadcast ON public.payments;
CREATE TRIGGER payments_broadcast AFTER INSERT OR UPDATE ON public.payments
FOR EACH ROW EXECUTE FUNCTION public.qr_payments_broadcast();

-- Staff restaurant list (replaces 003 version): adds the live topic.
CREATE OR REPLACE FUNCTION public.qr_staff_restaurants()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_user uuid := auth.uid(); v_result jsonb;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Staff login required' USING ERRCODE = '42501';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', r.id, 'name', r.name, 'currency', r.currency, 'role', m.role,
    'live_topic', 'staff-' || r.staff_realtime_key::text
  ) ORDER BY r.name), '[]'::jsonb)
  INTO v_result
  FROM public.staff_memberships m
  JOIN public.restaurants r ON r.id = m.restaurant_id
  WHERE m.user_id = v_user AND m.active AND r.active
    AND m.role IN ('owner', 'manager', 'staff');
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.qr_staff_restaurants() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.qr_staff_restaurants() TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;

-- Install success normally says: Success. No rows returned.
-- Requirement: Realtime > Settings must allow public channels (default).
-- If you disabled public access there, the pages fall back to polling.
