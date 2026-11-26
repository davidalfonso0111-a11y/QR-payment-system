-- Run AFTER 009 in Supabase SQL Editor as administrator.
-- Owner-only controls:
--  * Restaurant-wide alert settings (sound on/off, which sound, volume,
--    repeat on/off and interval 30/60/120 s). Every staff device follows them.
--  * Changing prices of products and options.
-- Only memberships with role 'owner' may change these; the database enforces it.
BEGIN;

ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS staff_settings jsonb NOT NULL
  DEFAULT '{"sound": true, "preset": "lounge", "volume": 70, "repeat": false, "repeat_seconds": 30}'::jsonb;

-- Staff restaurant list (replaces 008 version): adds the settings.
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
    'live_topic', 'staff-' || r.staff_realtime_key::text,
    'settings', r.staff_settings
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

-- Owner: save alert settings. Unknown keys are ignored; values are validated.
CREATE OR REPLACE FUNCTION public.qr_owner_update_settings(p_restaurant_id uuid, p_settings jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid; v_new jsonb; v_key uuid;
BEGIN
  v_user := public.qr_require_staff(p_restaurant_id, ARRAY['owner']);
  IF jsonb_typeof(p_settings) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Settings must be an object' USING ERRCODE = '22023';
  END IF;
  IF (p_settings ? 'sound' AND jsonb_typeof(p_settings->'sound') <> 'boolean')
    OR (p_settings ? 'repeat' AND jsonb_typeof(p_settings->'repeat') <> 'boolean')
    OR (p_settings ? 'preset' AND (p_settings->>'preset') NOT IN ('bell','glasses','doorbell','lounge','register','alert'))
    OR (p_settings ? 'volume' AND (jsonb_typeof(p_settings->'volume') <> 'number' OR (p_settings->>'volume')::numeric NOT BETWEEN 10 AND 100))
    OR (p_settings ? 'repeat_seconds' AND (p_settings->>'repeat_seconds') NOT IN ('30','60','120')) THEN
    RAISE EXCEPTION 'Invalid settings' USING ERRCODE = '22023';
  END IF;
  UPDATE public.restaurants r
    SET staff_settings = r.staff_settings || (SELECT COALESCE(jsonb_object_agg(k, p_settings->k), '{}'::jsonb)
      FROM unnest(ARRAY['sound','preset','volume','repeat','repeat_seconds']) AS k WHERE p_settings ? k)
    WHERE r.id = p_restaurant_id
    RETURNING r.staff_settings, r.staff_realtime_key INTO v_new, v_key;
  -- let every open staff page pick up the change
  PERFORM public.qr_realtime_ping('staff-' || v_key::text);
  RETURN v_new;
END;
$$;
REVOKE ALL ON FUNCTION public.qr_owner_update_settings(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.qr_owner_update_settings(uuid, jsonb) TO authenticated;

-- Owner: change the price (in cents) of a product or an option.
-- Existing orders keep the price they were placed at (order_items snapshot).
CREATE OR REPLACE FUNCTION public.qr_owner_set_price(
  p_restaurant_id uuid, p_kind text, p_id uuid, p_price_cents integer
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid; v_name text;
BEGIN
  v_user := public.qr_require_staff(p_restaurant_id, ARRAY['owner']);
  IF p_price_cents IS NULL OR p_price_cents < 0 OR p_price_cents > 100000 THEN
    RAISE EXCEPTION 'Prijs moet tussen 0 en 1000 euro liggen' USING ERRCODE = '22023';
  END IF;
  IF p_kind = 'product' THEN
    UPDATE public.products SET price_cents = p_price_cents
      WHERE id = p_id AND restaurant_id = p_restaurant_id RETURNING name INTO v_name;
  ELSIF p_kind = 'option' THEN
    UPDATE public.product_options SET price_cents = p_price_cents
      WHERE id = p_id AND restaurant_id = p_restaurant_id RETURNING name INTO v_name;
  ELSE
    RAISE EXCEPTION 'Unknown item kind' USING ERRCODE = '22023';
  END IF;
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'Item not found in this restaurant' USING ERRCODE = '22023';
  END IF;
  RETURN jsonb_build_object('id', p_id, 'kind', p_kind, 'price_cents', p_price_cents);
END;
$$;
REVOKE ALL ON FUNCTION public.qr_owner_set_price(uuid, text, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.qr_owner_set_price(uuid, text, uuid, integer) TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;

-- Install success normally says: Success. No rows returned.
