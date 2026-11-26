-- Run AFTER 008 in Supabase SQL Editor as administrator.
-- Also FIXES ordering with an option (broken since 002).
-- SIPS: rename the development restaurant, replace the food menu with a
-- spirits/wine/champagne menu, and add presentation fields:
--   products.image_url    optional https URL of a bottle photo (transparent PNG works best)
--   products.bottle       fallback bottle drawing when there is no photo
--   products.glass        glass the drink is served in
--   products.liquid_color drink colour (hex) for the glass and pour animation
--   products.ice          served with ice by default
-- PRICES ARE EXAMPLES. Adjust them in Table Editor > products (price_cents, in cents).
BEGIN;

ALTER TABLE public.products ADD COLUMN IF NOT EXISTS image_url text;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS bottle text NOT NULL DEFAULT 'whisky';
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS glass text NOT NULL DEFAULT 'tumbler';
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS liquid_color text NOT NULL DEFAULT '#c8862a';
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS ice boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.products'::regclass AND conname = 'products_presentation_check') THEN
    ALTER TABLE public.products ADD CONSTRAINT products_presentation_check CHECK (
      (image_url IS NULL OR (image_url ~ '^https://' AND length(image_url) <= 500))
      AND bottle IN ('whisky','bourbon','rum','gin','vodka','tequila','cognac','wine_red','wine_white','champagne')
      AND glass IN ('tumbler','wine','flute','snifter','copa','highball')
      AND liquid_color ~ '^#[0-9a-fA-F]{6}$');
  END IF;
END;
$$;

-- Rename the development restaurant.
UPDATE public.restaurants
  SET name = 'SIPS', slug = 'sips'
  WHERE id = '11111111-1111-4111-8111-111111111111';

-- Remove the old food menu. Products that appear in past orders cannot be
-- deleted (order history keeps them); those are switched off instead.
DELETE FROM public.product_options o
  WHERE o.restaurant_id = '11111111-1111-4111-8111-111111111111'
    AND NOT EXISTS (SELECT 1 FROM public.order_items i WHERE i.option_id = o.id);
UPDATE public.product_options SET available = false
  WHERE restaurant_id = '11111111-1111-4111-8111-111111111111';
DELETE FROM public.products p
  WHERE p.restaurant_id = '11111111-1111-4111-8111-111111111111'
    AND NOT EXISTS (SELECT 1 FROM public.order_items i WHERE i.product_id = p.id)
    AND NOT EXISTS (SELECT 1 FROM public.product_options o WHERE o.product_id = p.id);
UPDATE public.products SET available = false, sort_order = 9999
  WHERE restaurant_id = '11111111-1111-4111-8111-111111111111';

-- New SIPS menu (example prices, per glass unless stated).
INSERT INTO public.products
  (restaurant_id, name, description, category, price_cents, allergens, sort_order, bottle, glass, liquid_color, ice)
VALUES
('11111111-1111-4111-8111-111111111111','Glenfiddich 12','Speyside single malt. Peer, eik en een zachte, ronde afdronk.','Whisky',1200,'Geen aangegeven allergenen.',10,'whisky','tumbler','#d09a3f',false),
('11111111-1111-4111-8111-111111111111','Lagavulin 16','Islay single malt. Turf, rook en zeezout. Voor wie het stevig wil.','Whisky',1600,'Geen aangegeven allergenen.',11,'whisky','tumbler','#a8621e',false),
('11111111-1111-4111-8111-111111111111','Nikka From the Barrel','Japanse blend, krachtig en kruidig, 51,4%.','Whisky',1400,'Geen aangegeven allergenen.',12,'whisky','tumbler','#b8732a',false),
('11111111-1111-4111-8111-111111111111','Woodford Reserve','Kentucky bourbon. Vanille, karamel en toast.','Whisky',1200,'Geen aangegeven allergenen.',13,'bourbon','tumbler','#b5651d',true),
('11111111-1111-4111-8111-111111111111','Diplomático Reserva Exclusiva','Venezolaanse rum. Toffee, sinaasappel en donkere suiker.','Rum',1100,'Geen aangegeven allergenen.',20,'rum','tumbler','#7a3b12',true),
('11111111-1111-4111-8111-111111111111','Ron Zacapa 23','Guatemalteekse rum, gerijpt op hoogte. Rijk en zoet.','Rum',1400,'Geen aangegeven allergenen.',21,'rum','tumbler','#6b2f0e',true),
('11111111-1111-4111-8111-111111111111','Hendrick''s & Tonic','Gin met komkommer en roos, premium tonic en veel ijs.','Gin',1400,'Tonic bevat kinine.',30,'gin','copa','#e9f3f1',true),
('11111111-1111-4111-8111-111111111111','Monkey 47 & Tonic','Schwarzwald-gin met 47 botanicals, premium tonic.','Gin',1600,'Tonic bevat kinine.',31,'gin','copa','#eef4ea',true),
('11111111-1111-4111-8111-111111111111','Hennessy VSOP','Cognac. Vanille, kruidnagel en geroosterd eikenhout.','Cognac',1400,'Geen aangegeven allergenen.',40,'cognac','snifter','#9c4a14',false),
('11111111-1111-4111-8111-111111111111','Rémy Martin XO','Cognac van de top. Gedroogd fruit, jasmijn en lange afdronk.','Cognac',2200,'Geen aangegeven allergenen.',41,'cognac','snifter','#8a3c10',false),
('11111111-1111-4111-8111-111111111111','Grey Goose','Franse vodka, zuiver en zacht. Ijskoud geserveerd.','Vodka & Tequila',1100,'Geen aangegeven allergenen.',50,'vodka','tumbler','#f1f5f7',true),
('11111111-1111-4111-8111-111111111111','Don Julio Reposado','Tequila, 8 maanden op eik. Agave, karamel, kaneel.','Vodka & Tequila',1300,'Geen aangegeven allergenen.',51,'tequila','tumbler','#e3b45a',false),
('11111111-1111-4111-8111-111111111111','Chardonnay','Witte wijn uit de Bourgogne. Boter, citrus en een vleugje eik.','Wijn',800,'Bevat sulfieten.',60,'wine_white','wine','#f2dc8c',false),
('11111111-1111-4111-8111-111111111111','Sauvignon Blanc','Frisse witte wijn uit de Loire. Groene appel en kruisbes.','Wijn',750,'Bevat sulfieten.',61,'wine_white','wine','#eee6a6',false),
('11111111-1111-4111-8111-111111111111','Pinot Noir','Lichte rode wijn. Kers, framboos en zachte tannines.','Wijn',850,'Bevat sulfieten.',62,'wine_red','wine','#7b1626',false),
('11111111-1111-4111-8111-111111111111','Rioja Crianza','Volle Spaanse rode wijn. Rood fruit, vanille en eik.','Wijn',800,'Bevat sulfieten.',63,'wine_red','wine','#5e0f1c',false),
('11111111-1111-4111-8111-111111111111','Moët & Chandon Brut Impérial','Champagne. Fris, fruitig en elegant.','Champagne',1500,'Bevat sulfieten.',70,'champagne','flute','#f4e3a1',false),
('11111111-1111-4111-8111-111111111111','Ruinart Blanc de Blancs','100% chardonnay champagne. Citrus, wit fruit en brioche.','Champagne',1900,'Bevat sulfieten.',71,'champagne','flute','#f6e8b0',false);

-- Serving options.
INSERT INTO public.product_options (restaurant_id, product_id, name, price_cents, allergens)
SELECT p.restaurant_id, p.id, x.name, x.price_cents, 'Geen aangegeven allergenen.'
FROM public.products p
JOIN (VALUES
  ('Whisky', 'On the rocks', 0),
  ('Whisky', 'Met een scheutje water', 0),
  ('Rum', 'Puur, zonder ijs', 0),
  ('Cognac', 'Met één ijsblok', 0),
  ('Vodka & Tequila', 'Dubbel (4 cl extra)', 600)
) AS x(category, name, price_cents) ON x.category = p.category
WHERE p.restaurant_id = '11111111-1111-4111-8111-111111111111' AND p.available;

INSERT INTO public.product_options (restaurant_id, product_id, name, price_cents, allergens)
SELECT p.restaurant_id, p.id, 'Hele fles (75 cl)',
  CASE p.category WHEN 'Champagne' THEN p.price_cents * 5 + 1000 ELSE p.price_cents * 4 + 600 END,
  'Bevat sulfieten.'
FROM public.products p
WHERE p.restaurant_id = '11111111-1111-4111-8111-111111111111' AND p.available
  AND p.category IN ('Wijn', 'Champagne');

-- Guest menu (replaces 002 version): adds presentation fields.
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
      'image_url',p.image_url,'bottle',p.bottle,'glass',p.glass,
      'liquid_color',p.liquid_color,'ice',p.ice,
      'options',COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id',o.id,'name',o.name,'price_cents',o.price_cents,'allergens',o.allergens
      ) ORDER BY o.price_cents, o.name) FROM public.product_options o
        WHERE o.restaurant_id=r.id AND o.product_id=p.id AND o.available),'[]'::jsonb)
    ) ORDER BY p.sort_order,p.name) FROM public.products p
      WHERE p.restaurant_id=r.id AND p.available),'[]'::jsonb)
  );
END;
$$;
REVOKE ALL ON FUNCTION public.qr_guest_menu(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.qr_guest_menu(uuid) TO anon, authenticated;

-- FIX (bug since 002): ordering a product WITH an option failed with
-- "column reference product_id is ambiguous". Variables renamed; logic unchanged.
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
  v_product_id uuid; v_option_id uuid; v_quantity integer; note_text text;
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
    v_quantity := (item->>'quantity')::integer;
    v_product_id := (item->>'product_id')::uuid;
    v_option_id := NULLIF(item->>'option_id','')::uuid;
    IF item ? 'note' AND jsonb_typeof(item->'note') NOT IN ('string','null') THEN
      RAISE EXCEPTION 'Opmerking moet tekst zijn';
    END IF;
    note_text := COALESCE(item->>'note','');
    IF length(note_text)>180 THEN RAISE EXCEPTION 'Opmerking is te lang'; END IF;
    SELECT * INTO product FROM public.products
      WHERE id=v_product_id AND restaurant_id=t.restaurant_id AND available FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Product niet beschikbaar'; END IF;
    unit_price := product.price_cents;
    option_row := NULL;
    IF v_option_id IS NOT NULL THEN
      SELECT * INTO option_row FROM public.product_options
        WHERE id=v_option_id AND product_options.product_id=product.id
          AND restaurant_id=t.restaurant_id AND available FOR SHARE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Optie niet beschikbaar'; END IF;
      unit_price := unit_price+option_row.price_cents;
    END IF;
    amount := amount+unit_price*v_quantity;
    IF amount>100000 THEN RAISE EXCEPTION 'Bestelling te groot; vraag het personeel om hulp'; END IF;
    lines := lines || jsonb_build_array(jsonb_build_object(
      'product_id',product.id,'option_id',v_option_id,'product_name',product.name,
      'option_name',option_row.name,'quantity',v_quantity,
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
REVOKE ALL ON FUNCTION public.qr_create_cash_order(uuid,uuid,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.qr_create_cash_order(uuid,uuid,text,jsonb) TO anon,authenticated;

-- Staff menu (replaces 007 version): adds the photo.
CREATE OR REPLACE FUNCTION public.qr_staff_menu(p_restaurant_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_result jsonb;
BEGIN
  PERFORM public.qr_require_staff(p_restaurant_id, ARRAY['owner','manager','staff']);
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', p.id, 'name', p.name, 'category', p.category,
    'price_cents', p.price_cents, 'available', p.available, 'image_url', p.image_url,
    'options', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', o.id, 'name', o.name, 'price_cents', o.price_cents, 'available', o.available
      ) ORDER BY o.price_cents, o.name) FROM public.product_options o
      WHERE o.restaurant_id = p.restaurant_id AND o.product_id = p.id), '[]'::jsonb)
  ) ORDER BY p.sort_order, p.name), '[]'::jsonb)
  INTO v_result
  FROM public.products p WHERE p.restaurant_id = p_restaurant_id AND p.sort_order < 9999;
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.qr_staff_menu(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.qr_staff_menu(uuid) TO authenticated;

-- Owner/manager: set or clear the bottle photo of a product.
CREATE OR REPLACE FUNCTION public.qr_staff_set_product_image(
  p_restaurant_id uuid, p_product_id uuid, p_image_url text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_url text := NULLIF(btrim(p_image_url), ''); v_name text;
BEGIN
  PERFORM public.qr_require_staff(p_restaurant_id, ARRAY['owner','manager']);
  IF v_url IS NOT NULL AND (v_url !~ '^https://[^\s"''<>]+$' OR length(v_url) > 500) THEN
    RAISE EXCEPTION 'Foto-adres moet met https:// beginnen' USING ERRCODE = '22023';
  END IF;
  UPDATE public.products SET image_url = v_url
    WHERE id = p_product_id AND restaurant_id = p_restaurant_id RETURNING name INTO v_name;
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'Product not found in this restaurant' USING ERRCODE = '22023';
  END IF;
  RETURN jsonb_build_object('id', p_product_id, 'image_url', v_url);
END;
$$;
REVOKE ALL ON FUNCTION public.qr_staff_set_product_image(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.qr_staff_set_product_image(uuid, uuid, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;

-- Install success normally says: Success. No rows returned.
-- Photos: Supabase > Storage > New bucket "bottles" (Public) > upload PNG >
-- copy the public URL > staff.html > Menu & uitverkocht > "Foto".
