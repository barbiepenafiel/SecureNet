-- Daily auto-generated report snapshots
-- Run in Supabase SQL Editor

CREATE TABLE IF NOT EXISTS report_snapshots (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  generated_at    TIMESTAMPTZ DEFAULT NOW(),
  period_label    TEXT NOT NULL,          -- e.g. "2026-11-06 (daily)"
  total_devices   INTEGER DEFAULT 0,
  online_count    INTEGER DEFAULT 0,
  offline_count   INTEGER DEFAULT 0,
  warn_count      INTEGER DEFAULT 0,
  total_alerts    INTEGER DEFAULT 0,
  crit_alerts     INTEGER DEFAULT 0,
  resolved_alerts INTEGER DEFAULT 0,
  avg_uptime_pct  NUMERIC(5,2),
  avg_latency_ms  NUMERIC(8,2),
  top_issue       TEXT,
  summary_text    TEXT,
  generated_by    TEXT DEFAULT 'auto'
);

CREATE INDEX IF NOT EXISTS report_snapshots_generated_at_idx ON report_snapshots(generated_at DESC);

ALTER TABLE report_snapshots DISABLE ROW LEVEL SECURITY;
