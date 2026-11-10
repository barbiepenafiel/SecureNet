-- Paste this ENTIRE block into Supabase SQL Editor and click Run
-- supabase.com → your project → SQL Editor

-- 1. Create scan_results (with all columns the agent needs)
CREATE TABLE IF NOT EXISTS scan_results (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  ip          TEXT        NOT NULL,
  mac         TEXT,
  hostname    TEXT,
  vendor      TEXT,
  device_type TEXT,
  scan_type   TEXT        NOT NULL DEFAULT 'icmp',
  responded   BOOLEAN     NOT NULL DEFAULT FALSE,
  latency_ms  INTEGER,
  scanned_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS scan_results_scanned_at_idx ON scan_results(scanned_at DESC);
CREATE INDEX IF NOT EXISTS scan_results_ip_idx         ON scan_results(ip);

-- 2. Add columns if table already existed without them
ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS vendor      TEXT;
ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS device_type TEXT;

-- 3. Create traffic_samples if it doesn't exist
CREATE TABLE IF NOT EXISTS traffic_samples (
  id          BIGSERIAL   PRIMARY KEY,
  device_name TEXT        NOT NULL,
  interface   TEXT        NOT NULL DEFAULT 'eth0',
  in_mbps     NUMERIC(10,4) DEFAULT 0,
  out_mbps    NUMERIC(10,4) DEFAULT 0,
  sampled_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS traffic_samples_sampled_at_idx ON traffic_samples(sampled_at DESC);

-- 4. Disable RLS on every table so the dashboard can read without policies
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
