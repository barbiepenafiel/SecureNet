-- ─────────────────────────────────────────────────────────────
-- Research objectives: real topology links, alert thresholds,
-- email notifications, availability analytics.
-- Run once in the Supabase SQL Editor. Safe to run more than once.
-- ─────────────────────────────────────────────────────────────

-- ── 1. Alert thresholds (Settings → Alert Thresholds) ────────────────────
-- Read by the agent: latency, CPU, memory, flapping and grace period.
-- grace_period_min starts at 0 so offline alerts keep firing as soon as a
-- device is confirmed offline (3 missed checks); raise it in Settings to wait.
CREATE TABLE IF NOT EXISTS alert_config (
  id               UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  cpu_warn_pct     INTEGER DEFAULT 80  CHECK (cpu_warn_pct BETWEEN 1 AND 100),
  cpu_crit_pct     INTEGER DEFAULT 95  CHECK (cpu_crit_pct BETWEEN 1 AND 100),
  mem_warn_pct     INTEGER DEFAULT 85  CHECK (mem_warn_pct BETWEEN 1 AND 100),
  mem_crit_pct     INTEGER DEFAULT 95  CHECK (mem_crit_pct BETWEEN 1 AND 100),
  latency_warn_ms  INTEGER DEFAULT 100,
  latency_crit_ms  INTEGER DEFAULT 250,
  flap_threshold   INTEGER DEFAULT 3   CHECK (flap_threshold BETWEEN 1 AND 20),
  grace_period_min INTEGER DEFAULT 0   CHECK (grace_period_min BETWEEN 0 AND 60),
  updated_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_by       TEXT DEFAULT 'system'
);
INSERT INTO alert_config (cpu_warn_pct, cpu_crit_pct, mem_warn_pct, mem_crit_pct,
                          latency_warn_ms, latency_crit_ms, flap_threshold, grace_period_min)
SELECT 80, 95, 85, 95, 100, 250, 3, 0
WHERE NOT EXISTS (SELECT 1 FROM alert_config);

-- Signed-in users can read thresholds; changes go through /api/alert-config
-- (Network Admin only, server-side).
ALTER TABLE alert_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS alert_config_read ON alert_config;
CREATE POLICY alert_config_read ON alert_config FOR SELECT TO authenticated USING (true);

-- ── 2. Real topology links (device → the device it is connected to) ──────
-- parent_source: 'snmp'    = learned from a router's ARP / bridge table
--                'gateway' = on the agent's network, behind its default gateway
--                'manual'  = set by an admin (never overwritten by the agent)
ALTER TABLE devices ADD COLUMN IF NOT EXISTS parent_id         UUID REFERENCES devices(id) ON DELETE SET NULL;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS parent_port       TEXT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS parent_source     TEXT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS parent_updated_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS devices_parent_id_idx ON devices(parent_id);

-- ── 3. Email notifications ───────────────────────────────────────────────
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS emailed_at            TIMESTAMPTZ;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS resolution_emailed_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS notification_recipients (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  email        TEXT NOT NULL UNIQUE,
  name         TEXT,
  min_severity TEXT NOT NULL DEFAULT 'crit' CHECK (min_severity IN ('crit', 'warn')),
  daily_report BOOLEAN NOT NULL DEFAULT true,
  enabled      BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE notification_recipients ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notification_recipients_read  ON notification_recipients;
DROP POLICY IF EXISTS notification_recipients_write ON notification_recipients;
CREATE POLICY notification_recipients_read  ON notification_recipients FOR SELECT TO authenticated USING (is_net_admin());
CREATE POLICY notification_recipients_write ON notification_recipients FOR ALL    TO authenticated
  USING (is_net_admin()) WITH CHECK (is_net_admin());

-- The agent holds the SMTP settings (poller/.env) and reports whether email
-- is set up; Settings → "Send Test Email" is run by the agent as a job.
ALTER TABLE agent_status ADD COLUMN IF NOT EXISTS email_status TEXT;
DO $$
BEGIN
  IF to_regclass('public.agent_jobs') IS NOT NULL THEN
    ALTER TABLE agent_jobs DROP CONSTRAINT IF EXISTS agent_jobs_type_check;
    ALTER TABLE agent_jobs ADD CONSTRAINT agent_jobs_type_check
      CHECK (type IN ('probe', 'config_snapshot', 'email_test'));
  END IF;
END $$;

-- Daily report delivery
ALTER TABLE report_snapshots ADD COLUMN IF NOT EXISTS emailed_at TIMESTAMPTZ;
ALTER TABLE report_snapshots ADD COLUMN IF NOT EXISTS emailed_to TEXT;

-- ── 4. Availability analytics (from latency_samples, 1 row/device/minute) ─
CREATE INDEX IF NOT EXISTS latency_samples_device_time_idx ON latency_samples (device_id, sampled_at DESC);

-- Minutes Online / Offline / not measurable per device since `since`
CREATE OR REPLACE FUNCTION device_availability(since TIMESTAMPTZ)
RETURNS TABLE (device_id UUID, up_min BIGINT, down_min BIGINT, unknown_min BIGINT,
               avg_latency_ms NUMERIC, first_sample TIMESTAMPTZ)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT device_id,
         COUNT(*) FILTER (WHERE status IN ('up', 'warn')),
         COUNT(*) FILTER (WHERE status IN ('down', 'unreachable')),
         COUNT(*) FILTER (WHERE status NOT IN ('up', 'warn', 'down', 'unreachable')),
         ROUND(AVG(latency_ms) FILTER (WHERE latency_ms IS NOT NULL), 1),
         MIN(sampled_at)
  FROM latency_samples
  WHERE sampled_at >= since AND device_id IS NOT NULL
  GROUP BY device_id
$$;

-- Network latency in fixed steps since `since`
CREATE OR REPLACE FUNCTION latency_trend(since TIMESTAMPTZ, bucket_min INTEGER)
RETURNS TABLE (bucket TIMESTAMPTZ, avg_ms NUMERIC, min_ms INTEGER, max_ms INTEGER,
               samples BIGINT, offline_devices BIGINT)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT date_bin(make_interval(mins => bucket_min), sampled_at, TIMESTAMPTZ '2000-01-01') AS b,
         ROUND(AVG(latency_ms), 1), MIN(latency_ms), MAX(latency_ms),
         COUNT(latency_ms),
         COUNT(DISTINCT device_id) FILTER (WHERE status = 'down')
  FROM latency_samples
  WHERE sampled_at >= since
  GROUP BY b
  ORDER BY b
$$;

GRANT EXECUTE ON FUNCTION device_availability(TIMESTAMPTZ)        TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION latency_trend(TIMESTAMPTZ, INTEGER)     TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
