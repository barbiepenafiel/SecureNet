-- Run this in Supabase SQL Editor:
-- https://supabase.com/dashboard/project/aslcrxdaochnzxernnqx/sql/new

-- ── Status event log ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS status_events (
  id          BIGSERIAL PRIMARY KEY,
  device_id   UUID        NOT NULL,
  device_name TEXT        NOT NULL,
  device_ip   TEXT        NOT NULL,
  old_status  TEXT,
  new_status  TEXT        NOT NULL,
  changed_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS status_events_device_id_idx  ON status_events(device_id);
CREATE INDEX IF NOT EXISTS status_events_changed_at_idx ON status_events(changed_at DESC);
ALTER TABLE status_events DISABLE ROW LEVEL SECURITY;

-- ── Daily report snapshots ────────────────────────────────────
CREATE TABLE IF NOT EXISTS report_snapshots (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  generated_at    TIMESTAMPTZ DEFAULT NOW(),
  period_label    TEXT NOT NULL,
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
