-- Run AFTER 001_initial_schema.sql in Supabase SQL Editor.
-- Development API: menu and cash orders only. No staff access or online payment.
-- QR tokens are routing identifiers, NOT proof that a guest is present.
-- Keep staff acceptance mandatory. Add gateway/IP rate limits before a public pilot.
BEGIN;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS guest_request_hash text;

CREATE OR REPLACE FUNCTION public.qr_guest_menu(p_qr_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE t public.restaurant_tables%ROWTYPE; r public.restaurants%ROWTYPE;
BEGIN
  SELECT * INTO t FROM public.restaurant_tables WHERE qr_token = p_qr_token AND active;
  IF NOT FOUND THEN RAISE EXCEPTION 'Tafel niet beschikbaar'; END IF;
  SELECT * INTO r FROM public.restaurants WHERE id = t.restaurant_id AND active;
  IF NOT FOUND THEN RAISE EXCEPTION 'Zaak niet beschikbaar'; END IF;
  RETURN jsonb_build_object(
    'restaurant', jsonb_build_object('name',r.name,'currency',r.currency),
    'table_number',t.table_number,
    'products',COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id',p.id,'name',p.name,'description',p.description,'category',p.category,
      'price_cents',p.price_cents,'allergens',p.allergens,
      'options',COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id',o.id,'name',o.name,'price_cents',o.price_cents,'allergens',o.allergens
      ) ORDER BY o.name) FROM public.product_options o
        WHERE o.restaurant_id=r.id AND o.product_id=p.id AND o.available),'[]'::jsonb)
    ) ORDER BY p.sort_order,p.name) FROM public.products p
      WHERE p.restaurant_id=r.id AND p.available),'[]'::jsonb)
  );
END;
$$;

-- Caller sends product/option UUIDs, quantities and notes, NEVER trusted prices.
-- Generate and retain one idempotency UUID and a 64-character random hex secret
-- per checkout attempt. Retrying must reuse the EXACT same body and secret.
-- The secret must be generated using Web Crypto, not Math.random.
-- No public order lookup is exposed. Order identifiers alone grant no access.
CREATE OR REPLACE FUNCTION public.qr_create_cash_order(
  p_qr_token uuid, p_idempotency_key uuid, p_guest_secret text, p_items jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  t public.restaurant_tables%ROWTYPE;
  previous public.orders%ROWTYPE;
  created public.orders%ROWTYPE;
  product public.products%ROWTYPE;
  option_row public.product_options%ROWTYPE;
  item jsonb; lines jsonb := '[]'::jsonb;
  product_id uuid; option_id uuid; quantity integer; note_text text;
  unit_price bigint; amount bigint := 0;
  secret_hash text; request_hash text;
BEGIN
  IF p_qr_token IS NULL OR p_idempotency_key IS NULL
    OR p_guest_secret IS NULL OR p_guest_secret !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Ongeldige bestelaanvraag';
  END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Items moeten een lijst zijn';
  END IF;
  IF jsonb_array_length(p_items) NOT BETWEEN 1 AND 50 THEN
    RAISE EXCEPTION 'Kies tussen 1 en 50 bestelregels';
  END IF;
  secret_hash := encode(sha256(convert_to(p_guest_secret,'UTF8')),'hex');
  request_hash := encode(sha256(convert_to(p_items::text,'UTF8')),'hex');
  SELECT rt.* INTO t FROM public.restaurant_tables rt
    JOIN public.restaurants r ON r.id=rt.restaurant_id
    WHERE rt.qr_token=p_qr_token AND rt.active AND r.active;
  IF NOT FOUND THEN RAISE EXCEPTION 'Tafel niet beschikbaar'; END IF;

  -- Serialize duplicate requests, then new orders for this table.
  PERFORM pg_advisory_xact_lock(hashtextextended(t.restaurant_id::text || ':' || p_idempotency_key::text,0));
  SELECT * INTO previous FROM public.orders
    WHERE restaurant_id=t.restaurant_id AND idempotency_key=p_idempotency_key;
  IF FOUND THEN
    IF previous.table_id<>t.id OR previous.payment_method<>'cash'
      OR previous.guest_access_token_hash<>secret_hash
      OR previous.guest_request_hash IS DISTINCT FROM request_hash THEN
      RAISE EXCEPTION 'Bestelpoging komt niet overeen';
    END IF;
    RETURN jsonb_build_object('id',previous.id,'order_number',previous.order_number,
      'total_cents',previous.total_cents,'status',previous.status,
      'payment_status',previous.payment_status,'replayed',true);
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('qr-table:' || t.id::text,0));
  IF (SELECT count(*) FROM public.orders WHERE table_id=t.id
        AND created_at>now()-interval '1 minute')>=10
    OR (SELECT count(*) FROM public.orders WHERE table_id=t.id
        AND created_at>now()-interval '1 hour')>=100 THEN
    RAISE EXCEPTION 'Te veel bestellingen; vraag het personeel om hulp';
  END IF;

  FOR item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'Ongeldige bestelregel';
    END IF;
    IF COALESCE(item->>'quantity','') !~ '^[1-9][0-9]?$' THEN
      RAISE EXCEPTION 'Aantal moet tussen 1 en 99 liggen';
    END IF;
    quantity := (item->>'quantity')::integer;
    product_id := (item->>'product_id')::uuid;
    option_id := NULLIF(item->>'option_id','')::uuid;
    IF item ? 'note' AND jsonb_typeof(item->'note') NOT IN ('string','null') THEN
      RAISE EXCEPTION 'Opmerking moet tekst zijn';
    END IF;
    note_text := COALESCE(item->>'note','');
    IF length(note_text)>180 THEN RAISE EXCEPTION 'Opmerking is te lang'; END IF;
    SELECT * INTO product FROM public.products
      WHERE id=product_id AND restaurant_id=t.restaurant_id AND available FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Product niet beschikbaar'; END IF;
    unit_price := product.price_cents;
    option_row := NULL;
    IF option_id IS NOT NULL THEN
      SELECT * INTO option_row FROM public.product_options
        WHERE id=option_id AND product_id=product.id
          AND restaurant_id=t.restaurant_id AND available FOR SHARE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Optie niet beschikbaar'; END IF;
      unit_price := unit_price+option_row.price_cents;
    END IF;
    amount := amount+unit_price*quantity;
    IF amount>100000 THEN RAISE EXCEPTION 'Bestelling te groot; vraag het personeel om hulp'; END IF;
    lines := lines || jsonb_build_array(jsonb_build_object(
      'product_id',product.id,'option_id',option_id,'product_name',product.name,
      'option_name',option_row.name,'quantity',quantity,
      'unit_price_cents',unit_price,'note',note_text));
  END LOOP;

  INSERT INTO public.orders(restaurant_id,table_id,idempotency_key,
    guest_access_token_hash,guest_request_hash,payment_method,payment_status,status,total_cents)
  VALUES(t.restaurant_id,t.id,p_idempotency_key,secret_hash,request_hash,
    'cash','unpaid','awaiting_acceptance',amount::integer) RETURNING * INTO created;
  INSERT INTO public.order_items(restaurant_id,order_id,product_id,option_id,
    product_name,option_name,quantity,unit_price_cents,note)
  SELECT t.restaurant_id,created.id,x.product_id,x.option_id,x.product_name,
    x.option_name,x.quantity,x.unit_price_cents,x.note
  FROM jsonb_to_recordset(lines) AS x(product_id uuid,option_id uuid,
    product_name text,option_name text,quantity integer,unit_price_cents integer,note text);
  INSERT INTO public.order_events(restaurant_id,order_id,event_type,details)
    VALUES(t.restaurant_id,created.id,'guest_cash_order_created',
      jsonb_build_object('source','guest_rpc'));
  RETURN jsonb_build_object('id',created.id,'order_number',created.order_number,
    'total_cents',created.total_cents,'status',created.status,
    'payment_status',created.payment_status,'replayed',false);
END;
$$;

-- Table RLS remains enabled with no guest policies. Expose only these functions.
REVOKE ALL ON FUNCTION public.qr_guest_menu(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.qr_create_cash_order(uuid,uuid,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.qr_guest_menu(uuid) TO anon,authenticated;
GRANT EXECUTE ON FUNCTION public.qr_create_cash_order(uuid,uuid,text,jsonb) TO anon,authenticated;
COMMIT;

-- Read-only smoke test for development table 12:
-- SELECT public.qr_guest_menu('d5d46d46-8d68-41d4-8121-785d9dd0d308'::uuid);
-- This migration does not change index.html or create staff login.
