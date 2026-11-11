-- ─────────────────────────────────────────────────────────────
-- Latency history for the dashboard's "Network Latency — Last 24h" chart
-- Run once in the Supabase SQL Editor. Safe to run more than once.
--
-- The agent (poller/agent.js) saves one row per device per minute with
-- its average ping time and status. Rows older than 7 days are removed
-- by the agent automatically.
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS latency_samples (
  id          BIGSERIAL PRIMARY KEY,
  device_id   UUID REFERENCES devices(id) ON DELETE CASCADE,
  device_name TEXT NOT NULL,
  ip          TEXT NOT NULL,
  status      TEXT NOT NULL,          -- up / warn / unreachable / down / unknown
  latency_ms  INTEGER,                -- average ping that minute; NULL when it didn't answer ping
  sampled_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS latency_samples_sampled_at_idx ON latency_samples (sampled_at DESC);

ALTER TABLE latency_samples ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS latency_samples_read ON latency_samples;
CREATE POLICY latency_samples_read ON latency_samples FOR SELECT TO authenticated USING (true);

-- Last 24 h in 15-minute steps:
--   online_ms  = average latency of devices that were Online
--   warning_ms = average latency of devices in Warning
--   offline    = how many devices were Offline (they have no latency)
CREATE OR REPLACE VIEW latency_15min
WITH (security_invoker = on) AS
SELECT
  date_bin('15 minutes', sampled_at, TIMESTAMPTZ '2000-01-01') AS bucket,
  ROUND(AVG(latency_ms) FILTER (WHERE status = 'up'))::INTEGER   AS online_ms,
  ROUND(AVG(latency_ms) FILTER (WHERE status = 'warn'))::INTEGER AS warning_ms,
  COUNT(DISTINCT device_id) FILTER (WHERE status = 'up')         AS online_devices,
  COUNT(DISTINCT device_id) FILTER (WHERE status = 'warn')       AS warning_devices,
  COUNT(DISTINCT device_id) FILTER (WHERE status = 'down')       AS offline_devices
FROM latency_samples
WHERE sampled_at > now() - INTERVAL '24 hours'
GROUP BY 1
ORDER BY 1;

GRANT SELECT ON latency_15min TO authenticated;

NOTIFY pgrst, 'reload schema';
