-- Alert enhancements: resolution tracking + configurable thresholds
-- Run in Supabase SQL Editor

-- ── Resolution fields on alerts ────────────────────────────────────────
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS resolution_notes TEXT;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS resolved_at      TIMESTAMPTZ;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS resolved_by      TEXT;

-- ── Alert configuration (thresholds + flap detection) ──────────────────
CREATE TABLE IF NOT EXISTS alert_config (
  id               UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  cpu_warn_pct     INTEGER DEFAULT 80  CHECK (cpu_warn_pct BETWEEN 1 AND 100),
  cpu_crit_pct     INTEGER DEFAULT 95  CHECK (cpu_crit_pct BETWEEN 1 AND 100),
  mem_warn_pct     INTEGER DEFAULT 85  CHECK (mem_warn_pct BETWEEN 1 AND 100),
  mem_crit_pct     INTEGER DEFAULT 95  CHECK (mem_crit_pct BETWEEN 1 AND 100),
  latency_warn_ms  INTEGER DEFAULT 100,
  latency_crit_ms  INTEGER DEFAULT 250,
  flap_threshold   INTEGER DEFAULT 3   CHECK (flap_threshold BETWEEN 1 AND 20),
  grace_period_min INTEGER DEFAULT 5   CHECK (grace_period_min BETWEEN 0 AND 60),
  updated_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_by       TEXT DEFAULT 'system'
);

ALTER TABLE alert_config DISABLE ROW LEVEL SECURITY;

-- Seed one row if empty
INSERT INTO alert_config (cpu_warn_pct, cpu_crit_pct, mem_warn_pct, mem_crit_pct,
                          latency_warn_ms, latency_crit_ms, flap_threshold, grace_period_min)
SELECT 80, 95, 85, 95, 100, 250, 3, 5
WHERE NOT EXISTS (SELECT 1 FROM alert_config);
