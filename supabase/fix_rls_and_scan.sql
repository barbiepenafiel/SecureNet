-- Run this in your Supabase SQL Editor (supabase.com → project → SQL Editor)
-- Fixes: missing columns on scan_results, RLS blocking dashboard reads

-- 1. Add missing columns to scan_results (safe if already exist)
ALTER TABLE scan_results
  ADD COLUMN IF NOT EXISTS vendor      text,
  ADD COLUMN IF NOT EXISTS device_type text;

-- 2. Disable RLS on all tables so the dashboard can read without policies
--    (This is an internal tool — no public user accounts, so RLS adds no value)
ALTER TABLE devices             DISABLE ROW LEVEL SECURITY;
ALTER TABLE alerts              DISABLE ROW LEVEL SECURITY;
ALTER TABLE clients             DISABLE ROW LEVEL SECURITY;
ALTER TABLE sla_data            DISABLE ROW LEVEL SECURITY;
ALTER TABLE scan_results        DISABLE ROW LEVEL SECURITY;
ALTER TABLE traffic_samples     DISABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log           DISABLE ROW LEVEL SECURITY;
ALTER TABLE config_backups      DISABLE ROW LEVEL SECURITY;
ALTER TABLE lifecycle           DISABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_windows DISABLE ROW LEVEL SECURITY;
ALTER TABLE status_events       DISABLE ROW LEVEL SECURITY;
ALTER TABLE report_snapshots    DISABLE ROW LEVEL SECURITY;
