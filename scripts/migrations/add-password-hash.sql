-- Add password_hash column for email/password authentication
-- This is nullable so existing Google OAuth accounts are unaffected

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS password_hash text;
