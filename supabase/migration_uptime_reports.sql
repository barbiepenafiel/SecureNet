-- ─────────────────────────────────────────────────────────────
-- Uptime / downtime reports
-- Run once in the Supabase SQL Editor (safe to run more than once).
--
-- 1. devices.network_mac — the hardware address of the router (gateway) of
--    the network where the agent last saw the device. Two networks can use
--    the same numbers (e.g. 192.168.0.x at home and at school); with this the
--    agent records "not checked" instead of "offline" for a device that
--    belongs to a network it isn't on.
-- 2. Availability for any date range from what the agent measured
--    (latency_samples), each record weighted by the time it really covers
--    (see device_coverage). Time with no record is "not measured" — never
--    assumed online or offline.
-- 3. Availability over time (trend / status timeline) in fixed steps.
-- The Reports page works before this is run (slower, same rules).
-- ─────────────────────────────────────────────────────────────

ALTER TABLE devices ADD COLUMN IF NOT EXISTS network_mac TEXT;

CREATE INDEX IF NOT EXISTS latency_samples_device_time_idx ON latency_samples (device_id, sampled_at);

-- How long each record covers. The agent saves one row per device about once
-- a minute, at the end of a check round — in practice every 50–130 s. Each row
-- stands for the time since that device's previous row (its status is the
-- latest of that stretch); after a gap over 5 minutes (agent off or paused)
-- it counts as one minute. This also makes a duplicate record (e.g. two
-- agents writing seconds apart) add only those seconds, never a second minute.
CREATE OR REPLACE FUNCTION device_coverage(p_from TIMESTAMPTZ, p_to TIMESTAMPTZ)
RETURNS TABLE (device_id UUID, sampled_at TIMESTAMPTZ, state TEXT, seconds NUMERIC, latency_ms INTEGER)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT x.device_id, x.sampled_at,
         CASE WHEN x.status IN ('up', 'warn')          THEN 'up'
              WHEN x.status IN ('down', 'unreachable') THEN 'down'
              ELSE 'unknown' END,
         CASE WHEN x.prev IS NULL OR x.sampled_at - x.prev > INTERVAL '5 minutes' THEN 60
              ELSE EXTRACT(EPOCH FROM x.sampled_at - x.prev) END,
         x.latency_ms
  FROM (
    SELECT s.device_id, s.sampled_at, s.status, s.latency_ms,
           LAG(s.sampled_at) OVER (PARTITION BY s.device_id ORDER BY s.sampled_at, s.id) AS prev
    FROM latency_samples s
    WHERE s.sampled_at >= p_from - INTERVAL '5 minutes' AND s.sampled_at < p_to AND s.device_id IS NOT NULL
  ) x
  WHERE x.sampled_at >= p_from
$$;

-- Minutes Online / Offline / not checkable per device in [p_from, p_to)
CREATE OR REPLACE FUNCTION device_availability_range(p_from TIMESTAMPTZ, p_to TIMESTAMPTZ)
RETURNS TABLE (device_id UUID, up_min BIGINT, down_min BIGINT, unknown_min BIGINT,
               avg_latency_ms NUMERIC, first_sample TIMESTAMPTZ, last_sample TIMESTAMPTZ,
               last_up TIMESTAMPTZ)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT c.device_id,
         ROUND(COALESCE(SUM(c.seconds) FILTER (WHERE c.state = 'up'), 0) / 60)::BIGINT,
         ROUND(COALESCE(SUM(c.seconds) FILTER (WHERE c.state = 'down'), 0) / 60)::BIGINT,
         ROUND(COALESCE(SUM(c.seconds) FILTER (WHERE c.state = 'unknown'), 0) / 60)::BIGINT,
         ROUND(AVG(c.latency_ms) FILTER (WHERE c.latency_ms IS NOT NULL), 1),
         MIN(c.sampled_at), MAX(c.sampled_at),
         MAX(c.sampled_at) FILTER (WHERE c.state = 'up')
  FROM device_coverage(p_from, p_to) c
  GROUP BY c.device_id
$$;

-- Online / Offline / not-checkable minutes per step of p_bucket_min minutes,
-- for one device (p_device) or all devices (NULL)
CREATE OR REPLACE FUNCTION availability_timeline(p_from TIMESTAMPTZ, p_to TIMESTAMPTZ,
                                                 p_bucket_min INTEGER, p_device UUID DEFAULT NULL)
RETURNS TABLE (bucket TIMESTAMPTZ, up_min BIGINT, down_min BIGINT, unknown_min BIGINT, devices BIGINT)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT date_bin(make_interval(mins => p_bucket_min), c.sampled_at, p_from) AS b,
         ROUND(COALESCE(SUM(c.seconds) FILTER (WHERE c.state = 'up'), 0) / 60)::BIGINT,
         ROUND(COALESCE(SUM(c.seconds) FILTER (WHERE c.state = 'down'), 0) / 60)::BIGINT,
         ROUND(COALESCE(SUM(c.seconds) FILTER (WHERE c.state = 'unknown'), 0) / 60)::BIGINT,
         COUNT(DISTINCT c.device_id)
  FROM device_coverage(p_from, p_to) c
  WHERE p_device IS NULL OR c.device_id = p_device
  GROUP BY b
  ORDER BY b
$$;

GRANT EXECUTE ON FUNCTION device_coverage(TIMESTAMPTZ, TIMESTAMPTZ)                        TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION device_availability_range(TIMESTAMPTZ, TIMESTAMPTZ)              TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION availability_timeline(TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, UUID)   TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
