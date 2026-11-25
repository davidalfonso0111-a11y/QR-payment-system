-- Staff authentication and restaurant-scoped read access.
-- Run in Supabase SQL Editor as database administrator.
-- Does NOT create users, assign memberships or activate a staff website.
-- Create accounts through Supabase Auth; NEVER store passwords in this file.
BEGIN;

-- Fail atomically if existing memberships point to nonexistent Auth users.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.staff_memberships'::regclass
      AND conname = 'staff_memberships_auth_user_fk'
  ) THEN
    ALTER TABLE public.staff_memberships
      ADD CONSTRAINT staff_memberships_auth_user_fk
      FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS staff_memberships_active_user_idx
  ON public.staff_memberships(user_id, restaurant_id) WHERE active;

ALTER TABLE public.staff_memberships ENABLE ROW LEVEL SECURITY;
-- No self-assignment or role changes from a browser. Admin SQL only for now.
REVOKE ALL ON TABLE public.staff_memberships FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.staff_memberships TO authenticated;
DROP POLICY IF EXISTS qr_staff_read_own_memberships ON public.staff_memberships;
CREATE POLICY qr_staff_read_own_memberships
  ON public.staff_memberships FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()) AND active);

-- Writes will be introduced through separate, audited staff RPCs.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.orders, public.order_items, public.payments, public.order_events
  FROM PUBLIC, anon, authenticated;

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
    'id', r.id, 'name', r.name, 'currency', r.currency, 'role', m.role
  ) ORDER BY r.name), '[]'::jsonb)
  INTO v_result
  FROM public.staff_memberships m
  JOIN public.restaurants r ON r.id = m.restaurant_id
  WHERE m.user_id = v_user AND m.active AND r.active
    AND m.role IN ('owner', 'manager', 'staff');
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.qr_staff_orders(
  p_restaurant_id uuid,
  p_limit integer DEFAULT 100
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_user uuid := auth.uid(); v_result jsonb;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Staff login required' USING ERRCODE = '42501';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 200 THEN
    RAISE EXCEPTION 'Limit must be between 1 and 200' USING ERRCODE = '22023';
  END IF;
  -- Read current DB membership, never browser-supplied roles or metadata.
  PERFORM 1
  FROM public.staff_memberships m
  JOIN public.restaurants r ON r.id = m.restaurant_id
  WHERE m.restaurant_id = p_restaurant_id AND m.user_id = v_user
    AND m.active AND r.active AND m.role IN ('owner', 'manager', 'staff')
  FOR SHARE OF m, r;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No active staff access to this restaurant'
      USING ERRCODE = '42501';
  END IF;

  -- Explicit output fields: never expose guest tokens or request hashes.
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
      'total_cents', o.total_cents,
      'created_at', o.created_at,
      'updated_at', o.updated_at,
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

-- PostgreSQL grants function execution to PUBLIC by default: remove it.
REVOKE ALL ON FUNCTION public.qr_staff_restaurants() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.qr_staff_orders(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.qr_staff_restaurants() TO authenticated;
GRANT EXECUTE ON FUNCTION public.qr_staff_orders(uuid, integer) TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;

-- ACCOUNT SETUP (do separately after this migration):
-- 1. In Supabase Authentication create/invite a staff user.
-- 2. Copy its Auth user UUID, not a password or secret API key.
-- 3. As administrator, explicitly assign it to the intended restaurant:
-- INSERT INTO public.staff_memberships (restaurant_id, user_id, role, active)
-- VALUES ('11111111-1111-4111-8111-111111111111', 'REPLACE_WITH_AUTH_USER_UUID', 'owner', true);
-- Do not derive authorization from user-editable Auth metadata.
-- Deactivate membership to revoke restaurant access; retain audit history.
-- Test RPCs using a real staff JWT. SQL Editor as postgres has no auth.uid()
-- by default, so calling these RPCs there should fail with login required.
-- Acceptance/payment write functions and staff UI follow in next migrations.
