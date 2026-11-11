-- ─────────────────────────────────────────────────────────────
-- Automatic device discovery
-- Run once in the Supabase SQL Editor.
--
-- The agent (poller/agent.js) registers every device it finds on its
-- network into `devices` and keeps their status up to date.
-- ─────────────────────────────────────────────────────────────

-- 1. Discovery details on the existing devices table
ALTER TABLE devices ADD COLUMN IF NOT EXISTS mac         TEXT;          -- upper-case AA:BB:CC:DD:EE:FF
ALTER TABLE devices ADD COLUMN IF NOT EXISTS hostname    TEXT;          -- from reverse DNS, when available
ALTER TABLE devices ADD COLUMN IF NOT EXISTS vendor      TEXT;          -- from the MAC prefix
ALTER TABLE devices ADD COLUMN IF NOT EXISTS source      TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE devices ADD COLUMN IF NOT EXISTS subnet      TEXT;          -- e.g. 192.168.1.0/24
ALTER TABLE devices ADD COLUMN IF NOT EXISTS first_seen  TIMESTAMPTZ;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_seen   TIMESTAMPTZ;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_method TEXT;          -- ICMP / ARP / SNMP

ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_source_check;
ALTER TABLE devices ADD  CONSTRAINT devices_source_check CHECK (source IN ('manual', 'discovered'));

-- 2. More honest statuses
--    up = Online · down = Offline · unreachable = missed 1–2 checks
--    unknown = the agent can't currently see this device's network
ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_status_check;
ALTER TABLE devices ADD  CONSTRAINT devices_status_check
  CHECK (status IN ('up', 'warn', 'down', 'maint', 'unreachable', 'unknown'));

-- 3. One record per MAC address (no duplicates)
CREATE UNIQUE INDEX IF NOT EXISTS devices_mac_uidx ON devices (mac) WHERE mac IS NOT NULL;
CREATE INDEX        IF NOT EXISTS devices_ip_idx   ON devices (ip);

-- Existing devices count as first seen when they were added
UPDATE devices SET first_seen = created_at WHERE first_seen IS NULL;

-- 4. Agent heartbeat — lets the dashboard tell "offline" from "agent not reporting"
CREATE TABLE IF NOT EXISTS agent_status (
  id         TEXT PRIMARY KEY,               -- agent computer name
  ip         TEXT,
  subnet     TEXT,
  interface  TEXT,
  hosts_seen INTEGER DEFAULT 0,
  last_seen  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 5. Access rules (writes come from the agent/server with the service key)
ALTER TABLE devices      ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_status ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS devices_read  ON devices;
DROP POLICY IF EXISTS devices_write ON devices;
CREATE POLICY devices_read  ON devices FOR SELECT TO authenticated USING (true);
CREATE POLICY devices_write ON devices FOR ALL    TO authenticated
  USING (is_net_admin()) WITH CHECK (is_net_admin());

DROP POLICY IF EXISTS agent_status_read ON agent_status;
CREATE POLICY agent_status_read ON agent_status FOR SELECT TO authenticated USING (true);

-- 6. Live updates on the Devices page
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE devices;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE agent_status;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

NOTIFY pgrst, 'reload schema';
