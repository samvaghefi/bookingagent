-- No-Show Deposits migration
-- Run once in Supabase SQL editor

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS deposit_enabled boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS deposit_amount  integer DEFAULT 2500; -- cents (CA$25)

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS deposit_status           text DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS stripe_setup_intent_id   text,
  ADD COLUMN IF NOT EXISTS stripe_payment_method_id text,
  ADD COLUMN IF NOT EXISTS stripe_customer_id       text;
