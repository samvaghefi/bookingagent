-- Migration: add team_members column to businesses table
-- Adds a role field per member and migrates existing barbers data.
-- Run this in the Supabase SQL editor BEFORE deploying the updated server code.

-- Step 1: Add new column (non-destructive, existing barbers data untouched)
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS team_members jsonb DEFAULT '[]'::jsonb;

-- Step 2: Migrate existing barbers data into team_members, normalising:
--   - legacy string array: ["Sam","Alex"] → [{"name":"Sam","role":"","calendarId":""},...]
--   - object without role: {"name":"Sam","calendarId":"x"} → adds "role":""
--   - object with role: left unchanged
UPDATE businesses
SET team_members = (
  SELECT COALESCE(
    jsonb_agg(
      CASE
        WHEN jsonb_typeof(elem) = 'string'
          THEN jsonb_build_object('name', elem, 'role', '', 'calendarId', '')
        WHEN (elem->>'role') IS NULL
          THEN elem || jsonb_build_object('role', '')
        ELSE elem
      END
    ),
    '[]'::jsonb
  )
  FROM jsonb_array_elements(
    CASE
      WHEN jsonb_typeof(barbers) = 'array' THEN barbers
      ELSE '[]'::jsonb
    END
  ) AS elem
)
WHERE barbers IS NOT NULL
  AND jsonb_typeof(barbers) = 'array'
  AND jsonb_array_length(barbers) > 0;

-- Note: the barbers column is intentionally kept intact for backward compatibility.
-- It can be dropped in a future cleanup migration once all code is fully migrated.
