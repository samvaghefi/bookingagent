-- Run this in your Supabase SQL editor before first use of the competitor monitor.

-- Competitor snapshots: stores hashes for pricing/main pages and seen GUIDs for news
CREATE TABLE IF NOT EXISTS competitor_snapshots (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  competitor_name text NOT NULL,
  snapshot_type text NOT NULL, -- 'pricing', 'main', 'news_guid'
  content_hash text,
  content_text text,
  guid text, -- for news items
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(competitor_name, snapshot_type, guid)
);

-- Report log: one row per run
CREATE TABLE IF NOT EXISTS competitor_report_log (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  run_date date NOT NULL DEFAULT CURRENT_DATE,
  changes_detected integer DEFAULT 0,
  email_sent boolean DEFAULT false,
  report_summary text,
  created_at timestamptz DEFAULT now()
);
