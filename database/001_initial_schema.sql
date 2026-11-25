-- QR-payment-system: PostgreSQL / Supabase database foundation.
-- Run once in a NEW development database, using a database administrator.
-- This migration DOES NOT connect index.html or implement an order API.
-- Currency amounts are integer cents. All timestamps use timezone-aware UTC storage.
-- RLS is enabled with no public policies: browser access is intentionally denied.
-- Use a trusted backend for guest orders. NEVER put a service-role key in HTML.
-- Staff authentication, API authorization, rate limiting, payment webhooks and
-- transactional server-side price calculation must be implemented before a pilot.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE public.restaurants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  currency text NOT NULL DEFAULT 'EUR' CHECK (currency = 'EUR'),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.restaurant_tables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES public.restaurants(id),
  table_number integer NOT NULL CHECK (table_number > 0),
  -- Public routing token, NOT authentication. Staff must accept cash orders.
  qr_token uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  active boolean NOT NULL DEFAULT true,
  UNIQUE (restaurant_id, table_number),
  UNIQUE (restaurant_id, id)
);

CREATE TABLE public.products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES public.restaurants(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  description text NOT NULL DEFAULT '',
  category text NOT NULL CHECK (length(category) BETWEEN 1 AND 80),
  price_cents integer NOT NULL CHECK (price_cents >= 0),
  allergens text NOT NULL DEFAULT '',
  available boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  UNIQUE (restaurant_id, id)
);

CREATE TABLE public.product_options (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES public.restaurants(id),
  product_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  price_cents integer NOT NULL CHECK (price_cents >= 0),
  allergens text NOT NULL DEFAULT '',
  available boolean NOT NULL DEFAULT true,
  FOREIGN KEY (restaurant_id, product_id)
    REFERENCES public.products(restaurant_id, id),
  UNIQUE (restaurant_id, product_id, id)
);

CREATE TABLE public.staff_memberships (
  restaurant_id uuid NOT NULL REFERENCES public.restaurants(id),
  -- Identity supplied by the backend's verified authentication provider.
  -- With Supabase, link this to auth.users in a separate auth migration.
  user_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'manager', 'staff')),
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (restaurant_id, user_id)
);

CREATE TABLE public.orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  restaurant_id uuid NOT NULL REFERENCES public.restaurants(id),
  table_id uuid NOT NULL,
  -- Retry the same submission with the same idempotency key.
  idempotency_key uuid NOT NULL,
  -- Store only the SHA-256 hash of a backend-generated random guest secret.
  -- The order UUID / QR token alone must never grant access to an order.
  guest_access_token_hash text NOT NULL CHECK (guest_access_token_hash ~ '^[0-9a-f]{64}$'),
  payment_method text NOT NULL CHECK (payment_method IN ('cash', 'online')),
  payment_status text NOT NULL DEFAULT 'unpaid'
    CHECK (payment_status IN ('unpaid', 'pending', 'paid', 'failed', 'refunded')),
  status text NOT NULL DEFAULT 'awaiting_acceptance'
    CHECK (status IN ('awaiting_payment', 'awaiting_acceptance', 'received',
                      'preparing', 'ready', 'served', 'rejected', 'cancelled')),
  total_cents integer NOT NULL CHECK (total_cents >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (restaurant_id, table_id)
    REFERENCES public.restaurant_tables(restaurant_id, id),
  UNIQUE (restaurant_id, id),
  UNIQUE (restaurant_id, idempotency_key),
  CHECK (payment_method <> 'online' OR status IN
    ('awaiting_payment', 'rejected', 'cancelled') OR payment_status = 'paid')
);

CREATE TABLE public.order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES public.restaurants(id),
  order_id uuid NOT NULL,
  product_id uuid NOT NULL,
  option_id uuid,
  -- Snapshot: historical orders keep the names/prices used at order time.
  product_name text NOT NULL,
  option_name text,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  unit_price_cents integer NOT NULL CHECK (unit_price_cents >= 0),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 180),
  FOREIGN KEY (restaurant_id, order_id)
    REFERENCES public.orders(restaurant_id, id),
  FOREIGN KEY (restaurant_id, product_id)
    REFERENCES public.products(restaurant_id, id),
  FOREIGN KEY (restaurant_id, product_id, option_id)
    REFERENCES public.product_options(restaurant_id, product_id, id)
);

CREATE TABLE public.payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES public.restaurants(id),
  order_id uuid NOT NULL,
  method text NOT NULL CHECK (method IN ('cash', 'online')),
  status text NOT NULL CHECK (status IN ('pending', 'paid', 'failed', 'refunded')),
  amount_cents integer NOT NULL CHECK (amount_cents >= 0),
  provider text,
  provider_payment_id text,
  recorded_by_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz,
  FOREIGN KEY (restaurant_id, order_id)
    REFERENCES public.orders(restaurant_id, id),
  FOREIGN KEY (restaurant_id, recorded_by_user_id)
    REFERENCES public.staff_memberships(restaurant_id, user_id),
  UNIQUE (provider, provider_payment_id),
  CHECK (method <> 'online' OR (provider IS NOT NULL AND provider_payment_id IS NOT NULL)),
  CHECK (method <> 'cash' OR status <> 'paid' OR recorded_by_user_id IS NOT NULL),
  CHECK (status <> 'paid' OR paid_at IS NOT NULL)
);

CREATE TABLE public.order_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id uuid NOT NULL REFERENCES public.restaurants(id),
  order_id uuid NOT NULL,
  event_type text NOT NULL CHECK (length(event_type) BETWEEN 1 AND 80),
  actor_user_id uuid,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (restaurant_id, order_id)
    REFERENCES public.orders(restaurant_id, id),
  FOREIGN KEY (restaurant_id, actor_user_id)
    REFERENCES public.staff_memberships(restaurant_id, user_id)
);

CREATE INDEX orders_restaurant_created_idx ON public.orders(restaurant_id, created_at DESC);
CREATE INDEX orders_restaurant_status_idx ON public.orders(restaurant_id, status);
CREATE INDEX order_items_order_idx ON public.order_items(restaurant_id, order_id);
CREATE INDEX payments_order_idx ON public.payments(restaurant_id, order_id);
CREATE INDEX order_events_order_idx ON public.order_events(restaurant_id, order_id, created_at);

CREATE FUNCTION public.qr_set_updated_at() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER orders_updated_at BEFORE UPDATE ON public.orders
FOR EACH ROW EXECUTE FUNCTION public.qr_set_updated_at();

ALTER TABLE public.restaurants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.restaurant_tables ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_options ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_events ENABLE ROW LEVEL SECURITY;

-- Fictitious development seed. No real orders or users are created.
INSERT INTO public.restaurants(id, name, slug)
VALUES ('11111111-1111-4111-8111-111111111111', 'Brasserie Linden', 'brasserie-linden');
INSERT INTO public.restaurant_tables(restaurant_id, table_number)
VALUES ('11111111-1111-4111-8111-111111111111', 12);
INSERT INTO public.products(restaurant_id, name, description, category, price_cents, allergens, sort_order)
VALUES
('11111111-1111-4111-8111-111111111111','Burrata & tomaat','Burrata, tomaten, basilicum en zuurdesem.','Eten',1250,'Melk, gluten (tarwe).',1),
('11111111-1111-4111-8111-111111111111','Burger van het huis','Rundvlees, cheddar, huisgemaakte saus en friet.','Eten',1850,'Gluten (tarwe), melk, ei, mosterd, sesam.',2),
('11111111-1111-4111-8111-111111111111','Groene bowl','Quinoa, avocado, groenten en tahindressing.','Eten',1500,'Sesam.',3),
('11111111-1111-4111-8111-111111111111','Krokante frietjes','Met huisgemaakte mayonaise.','Eten',550,'Ei, mosterd (mayonaise).',4),
('11111111-1111-4111-8111-111111111111','Huisgemaakte limonade','Citroen, munt en bruiswater.','Drinken',450,'Geen aangegeven allergenen.',5),
('11111111-1111-4111-8111-111111111111','Cappuccino','Espresso met melkschuim.','Drinken',380,'Melk.',6),
('11111111-1111-4111-8111-111111111111','Bruiswater','Mineraalwater, 250 ml.','Drinken',300,'Geen aangegeven allergenen.',7),
('11111111-1111-4111-8111-111111111111','Chocolade brownie','Brownie met vanille-ijs.','Dessert',800,'Gluten (tarwe), ei, melk, soja. Kan noten bevatten.',8);
INSERT INTO public.product_options(restaurant_id, product_id, name, price_cents, allergens)
SELECT restaurant_id, id,
  CASE name WHEN 'Burrata & tomaat' THEN 'Extra zuurdesem'
    WHEN 'Burger van het huis' THEN 'Extra cheddar'
    WHEN 'Groene bowl' THEN 'Extra avocado'
    ELSE 'Haverdrink in plaats van melk' END,
  CASE name WHEN 'Burrata & tomaat' THEN 200
    WHEN 'Burger van het huis' THEN 150
    WHEN 'Groene bowl' THEN 250 ELSE 50 END,
  CASE name WHEN 'Burrata & tomaat' THEN 'Gluten (tarwe).'
    WHEN 'Burger van het huis' THEN 'Melk.'
    WHEN 'Cappuccino' THEN 'Haver (mogelijk gluten); vraag personeel naar het product.'
    ELSE 'Geen aangegeven allergenen.' END
FROM public.products
WHERE restaurant_id = '11111111-1111-4111-8111-111111111111'
AND name IN ('Burrata & tomaat','Burger van het huis','Groene bowl','Cappuccino');
COMMIT;

-- After installation, inspect the generated development QR token as admin:
-- SELECT table_number, qr_token FROM public.restaurant_tables;
-- Next implementation: POST /api/orders (cash only initially).
-- The backend must validate the QR token, restaurant/table activity, products,
-- options, quantities and availability; read prices from the DB, never the browser;
-- insert order + items + audit event atomically; enforce idempotency and rate limits.
-- Staff endpoints must verify identity AND active membership for the order's restaurant.
-- State transitions and payment/order total consistency are backend responsibilities.
-- Online payment status must come from verified provider callbacks, not the guest.
