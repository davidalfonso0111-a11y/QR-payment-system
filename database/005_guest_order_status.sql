-- Run in Supabase SQL Editor after the existing migrations.
-- Read-only: requires BOTH the order UUID and its original guest secret.
-- Does not grant table access or expose secrets, staff identities or other orders.
BEGIN;

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
    'payment_method', o.payment_method,
    'payment_status', o.payment_status,
    'total_cents', o.total_cents,
    'created_at', o.created_at,
    'updated_at', o.updated_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.qr_guest_order_status(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.qr_guest_order_status(uuid, text)
  TO anon, authenticated;

COMMIT;

-- Never put the guest secret in a URL, logs or screenshots.
-- Clients should poll only while visible, with backoff on errors.
-- Add gateway/IP rate limiting before a public pilot.
-- Existing test orders cannot be accessed without their original guest secret.
-- This migration does not activate the website status screen.
