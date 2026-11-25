-- Run AFTER 001_initial_schema.sql in the Supabase SQL Editor.
-- This function is ONLY callable by a trusted backend using service_role.
-- Never put the service_role key in the website or share it in chat.
-- Does not deploy an HTTP endpoint or connect the prototype.
BEGIN;

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS request_hash text;

CREATE OR REPLACE FUNCTION public.qr_create_cash_order(
  p_qr_token uuid,
  p_idempotency_key uuid,
  p_guest_token_hash text,
  p_items jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_table public.restaurant_tables%ROWTYPE;
  v_order public.orders%ROWTYPE;
  v_product public.products%ROWTYPE;
  v_option public.product_options%ROWTYPE;
  v_item jsonb;
  v_lines jsonb := '[]'::jsonb;
  v_hash text;
  v_qty integer;
  v_note text;
  v_option_id uuid;
  v_unit bigint;
  v_total bigint := 0;
  v_units integer := 0;
  v_recent integer;
BEGIN
  IF p_qr_token IS NULL OR p_idempotency_key IS NULL
     OR p_guest_token_hash IS NULL
     OR p_guest_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE = '22023';
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'INVALID_ITEMS' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_items) NOT BETWEEN 1 AND 40 THEN
    RAISE EXCEPTION 'INVALID_ITEMS' USING ERRCODE = '22023';
  END IF;

  -- Lock serializes submissions for this table, including rate checks.
  SELECT t.* INTO v_table FROM public.restaurant_tables t
  WHERE t.qr_token = p_qr_token AND t.active FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TABLE_UNAVAILABLE' USING ERRCODE = '22023';
  END IF;

  v_hash := encode(sha256(convert_to(p_items::text, 'UTF8')), 'hex');
  SELECT o.* INTO v_order FROM public.orders o
  WHERE o.restaurant_id = v_table.restaurant_id
    AND o.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_order.table_id <> v_table.id
      OR v_order.guest_access_token_hash <> p_guest_token_hash
      OR v_order.request_hash IS DISTINCT FROM v_hash THEN
      RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE = '22023';
    END IF;
    RETURN jsonb_build_object('id', v_order.id,
      'order_number', v_order.order_number, 'total_cents', v_order.total_cents,
      'status', v_order.status, 'payment_status', v_order.payment_status,
      'table_number', v_table.table_number, 'replayed', true);
  END IF;

  PERFORM 1 FROM public.restaurants r
    WHERE r.id = v_table.restaurant_id AND r.active FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'RESTAURANT_UNAVAILABLE' USING ERRCODE = '22023';
  END IF;
  SELECT count(*) INTO v_recent FROM public.orders o
    WHERE o.table_id = v_table.id AND o.created_at > now() - interval '1 minute';
  IF v_recent >= 10 THEN
    RAISE EXCEPTION 'TABLE_RATE_LIMIT' USING ERRCODE = '22023';
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    IF jsonb_typeof(v_item) <> 'object'
      OR coalesce(jsonb_typeof(v_item->'product_id'), '') <> 'string'
      OR coalesce(jsonb_typeof(v_item->'quantity'), '') <> 'number'
      OR coalesce(v_item->>'quantity', '') !~ '^[0-9]{1,2}$'
      OR (v_item ? 'note' AND jsonb_typeof(v_item->'note') <> 'string')
      OR (v_item ? 'option_id' AND jsonb_typeof(v_item->'option_id') NOT IN ('string','null')) THEN
      RAISE EXCEPTION 'INVALID_ITEM' USING ERRCODE = '22023';
    END IF;
    v_qty := (v_item->>'quantity')::integer;
    v_note := coalesce(v_item->>'note', '');
    v_option_id := (v_item->>'option_id')::uuid;
    IF v_qty NOT BETWEEN 1 AND 99 OR length(v_note) > 180 THEN
      RAISE EXCEPTION 'INVALID_ITEM' USING ERRCODE = '22023';
    END IF;
    v_units := v_units + v_qty;
    IF v_units > 99 THEN
      RAISE EXCEPTION 'TOO_MANY_ITEMS' USING ERRCODE = '22023';
    END IF;

    SELECT p.* INTO v_product FROM public.products p
      WHERE p.id = (v_item->>'product_id')::uuid
        AND p.restaurant_id = v_table.restaurant_id AND p.available FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'PRODUCT_UNAVAILABLE' USING ERRCODE = '22023';
    END IF;
    v_unit := v_product.price_cents;
    v_option := NULL;
    IF v_option_id IS NOT NULL THEN
      SELECT x.* INTO v_option FROM public.product_options x
        WHERE x.id = v_option_id AND x.product_id = v_product.id
          AND x.restaurant_id = v_table.restaurant_id AND x.available FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'OPTION_UNAVAILABLE' USING ERRCODE = '22023';
      END IF;
      v_unit := v_unit + v_option.price_cents;
    END IF;
    v_total := v_total + v_unit * v_qty;
    IF v_total > 1000000 THEN
      RAISE EXCEPTION 'ORDER_TOO_LARGE' USING ERRCODE = '22023';
    END IF;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'product_id', v_product.id, 'product_name', v_product.name,
      'option_id', v_option_id, 'option_name', v_option.name,
      'quantity', v_qty, 'unit_price_cents', v_unit, 'note', v_note));
  END LOOP;

  INSERT INTO public.orders(restaurant_id, table_id, idempotency_key,
    guest_access_token_hash, request_hash, payment_method, payment_status, status, total_cents)
  VALUES(v_table.restaurant_id, v_table.id, p_idempotency_key,
    p_guest_token_hash, v_hash, 'cash', 'unpaid', 'awaiting_acceptance', v_total::integer)
  RETURNING * INTO v_order;

  INSERT INTO public.order_items(restaurant_id, order_id, product_id, option_id,
    product_name, option_name, quantity, unit_price_cents, note)
  SELECT v_table.restaurant_id, v_order.id, x.product_id, x.option_id,
    x.product_name, x.option_name, x.quantity, x.unit_price_cents, x.note
  FROM jsonb_to_recordset(v_lines) AS x(product_id uuid, option_id uuid,
    product_name text, option_name text, quantity integer, unit_price_cents integer, note text);

  INSERT INTO public.order_events(restaurant_id, order_id, event_type, details)
  VALUES(v_table.restaurant_id, v_order.id, 'cash_order_created',
    jsonb_build_object('total_cents', v_total));

  RETURN jsonb_build_object('id', v_order.id, 'order_number', v_order.order_number,
    'table_number', v_table.table_number, 'total_cents', v_order.total_cents,
    'status', v_order.status, 'payment_status', v_order.payment_status,
    'items', v_lines, 'replayed', false);
END;
$$;

REVOKE ALL ON FUNCTION public.qr_create_cash_order(uuid, uuid, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.qr_create_cash_order(uuid, uuid, text, jsonb) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.qr_create_cash_order(uuid, uuid, text, jsonb) TO service_role;
COMMIT;

-- Next: deploy a backend endpoint which calls this function.
-- Backend must generate a random guest secret (>=32 random bytes), hash it with
-- SHA-256, retain the same secret/key/body for retries, and return the secret
-- only to the submitting guest. Never return the hash or service key.
-- Backend also needs body-size limits, IP-based rate limiting and allowed-origin
-- configuration. The per-table DB limit here is not a substitute for these.
-- Acceptance, staff login, order tracking and cash receipt are separate features.
-- No real payment is recorded by this function.
