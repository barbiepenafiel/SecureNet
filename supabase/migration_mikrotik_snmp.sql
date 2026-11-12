-- ─────────────────────────────────────────────────────────────
-- MikroTik RouterOS SNMP monitoring
-- Run once in the Supabase SQL Editor. Safe to run more than once.
--
-- The local agent (poller/agent.js → poller/mikrotik.js) polls every
-- MikroTik router over SNMP and keeps these two tables current:
--   mikrotik_routers    — one row per router (identity, model, RouterOS,
--                         uptime, CPU, memory, disk, temperature, voltage)
--   mikrotik_interfaces — one row per router interface (status, IPs, MAC,
--                         speed, live in/out rate, totals, errors, drops)
-- Traffic history goes to the existing traffic_samples table, so the
-- Traffic page charts the router too.
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS mikrotik_routers (
  device_id        UUID PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  device_name      TEXT NOT NULL,
  ip               TEXT NOT NULL,
  identity         TEXT,            -- sysName (/system identity)
  description      TEXT,            -- sysDescr
  board            TEXT,            -- e.g. RB750Gr3 (hEX)
  ros_version      TEXT,            -- RouterOS version
  firmware         TEXT,            -- RouterBOOT firmware
  serial           TEXT,
  sys_location     TEXT,
  sys_contact      TEXT,
  uptime_seconds   BIGINT,
  cpu_load         INTEGER,         -- % average of all cores
  cpu_cores        INTEGER,
  mem_total_bytes  BIGINT,
  mem_used_bytes   BIGINT,
  disk_total_bytes BIGINT,
  disk_used_bytes  BIGINT,
  temperature_c    NUMERIC(5,1),
  voltage_v        NUMERIC(5,1),
  reachable        BOOLEAN NOT NULL DEFAULT true,
  last_error       TEXT,
  polled_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mikrotik_interfaces (
  device_id     UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  if_index      INTEGER NOT NULL,
  name          TEXT,               -- ifName, e.g. ether1, bridge
  alias         TEXT,               -- interface comment (ifAlias)
  if_type       INTEGER,            -- IANA ifType (6 = ethernet, 209 = bridge, …)
  mac           TEXT,
  mtu           INTEGER,
  speed_mbps    BIGINT,             -- negotiated link speed
  admin_status  TEXT,               -- up / down (enabled / disabled)
  oper_status   TEXT,               -- up / down / … (link state)
  ip_addresses  TEXT[],             -- e.g. {192.168.88.1/24}
  in_bps        BIGINT,             -- live rate, bits per second
  out_bps       BIGINT,
  in_octets     NUMERIC,            -- totals since the router booted
  out_octets    NUMERIC,
  in_packets    NUMERIC,
  out_packets   NUMERIC,
  in_errors     BIGINT,
  out_errors    BIGINT,
  in_discards   BIGINT,
  out_discards  BIGINT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, if_index)
);

-- Signed-in dashboard users can read; only the agent (service role) writes
ALTER TABLE mikrotik_routers    ENABLE ROW LEVEL SECURITY;
ALTER TABLE mikrotik_interfaces ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mikrotik_routers_read    ON mikrotik_routers;
DROP POLICY IF EXISTS mikrotik_interfaces_read ON mikrotik_interfaces;
CREATE POLICY mikrotik_routers_read    ON mikrotik_routers    FOR SELECT TO authenticated USING (true);
CREATE POLICY mikrotik_interfaces_read ON mikrotik_interfaces FOR SELECT TO authenticated USING (true);

-- Live updates on the dashboard without refreshing
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE mikrotik_routers;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE mikrotik_interfaces;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

NOTIFY pgrst, 'reload schema';
