-- ─────────────────────────────────────────────────────────────
-- SNMP connection settings per device
-- Run once in the Supabase SQL Editor. Safe to run more than once.
--
-- Lets a device be monitored at an address other than the one on its
-- record — for example the router's address over a VPN, or its address on
-- another subnet that this computer has a route to.
--   snmp_host     address SNMP is sent to (NULL = the device's own ip)
--   snmp_version  '2c' (default) or '1'
-- snmp_community and snmp_port already exist.
-- ─────────────────────────────────────────────────────────────

ALTER TABLE devices ADD COLUMN IF NOT EXISTS snmp_host    TEXT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS snmp_version TEXT NOT NULL DEFAULT '2c';

DO $$
BEGIN
  ALTER TABLE devices ADD CONSTRAINT devices_snmp_version_check CHECK (snmp_version IN ('1', '2c'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

NOTIFY pgrst, 'reload schema';
