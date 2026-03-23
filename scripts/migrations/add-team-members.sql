-- Migration: add team_members column to businesses table
-- Adds a role field per member and migrates existing barbers data.
-- Run this in the Supabase SQL editor BEFORE deploying the updated server code.
--
-- NOTE: barbers is a text[] column (not jsonb), so we use unnest() to iterate it.

-- Step 1: Add new column (non-destructive, existing barbers data untouched)
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS team_members jsonb DEFAULT '[]'::jsonb;

-- Step 2: Migrate existing barbers data (text[] → jsonb array with name/role/calendarId)
UPDATE businesses
SET team_members = (
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object('name', name_val, 'role', '', 'calendarId', '')
    ),
    '[]'::jsonb
  )
  FROM unnest(barbers) AS name_val
)
WHERE barbers IS NOT NULL
  AND array_length(barbers, 1) > 0;

-- Note: the barbers column is intentionally kept intact for backward compatibility.
-- It can be dropped in a future cleanup migration once all code is fully migrated.
