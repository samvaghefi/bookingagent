-- Migration: add reminder_sent column to bookings table
-- Run this in the Supabase SQL editor before deploying the updated server code.

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS reminder_sent boolean NOT NULL DEFAULT false;

-- Optional index: speeds up the hourly job query (bookings due for a reminder)
CREATE INDEX IF NOT EXISTS idx_bookings_reminder
  ON bookings (appointment_date, reminder_sent)
  WHERE reminder_sent = false;
