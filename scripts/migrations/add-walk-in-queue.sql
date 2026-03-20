-- Migration: add-walk-in-queue.sql
-- Run once in Supabase SQL editor

CREATE TABLE IF NOT EXISTS walk_in_queue (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       uuid NOT NULL REFERENCES businesses(id),
  customer_name     text NOT NULL,
  customer_phone    text NOT NULL,
  service           text,
  preferred_barber  text,
  status            text NOT NULL DEFAULT 'waiting',
  notified_at       timestamptz,
  served_at         timestamptz,
  removed_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS queue_enabled          boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS queue_notify_timeout   integer DEFAULT 10;
