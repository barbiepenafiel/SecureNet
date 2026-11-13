-- ─────────────────────────────────────────────────────────────
-- SNMP monitoring: Online → Warning → Offline per device
-- Run once in the Supabase SQL Editor. Safe to run more than once.
--
-- The agent (poller/snmp-status.js) checks every device that has answered
-- SNMP, every 10 s, from whatever network it is on:
--   snmp_state       online  · answered the last check
--                    warning · missed a check, being re-checked every few seconds
--                    offline · no SNMP reply for 2 minutes (3+ checks) — alert raised
--                    unknown · the agent has no path to the device right now
--                              (e.g. the laptop is on another Wi-Fi) — nothing concluded
--   snmp_fail_count  checks missed in a row
--   snmp_down_since  first missed check of the current outage
--   snmp_last_ok_at  last SNMP reply
-- devices.status is not touched — it stays the ICMP/ARP status.
-- ─────────────────────────────────────────────────────────────

ALTER TABLE devices ADD COLUMN IF NOT EXISTS snmp_state      TEXT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS snmp_fail_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS snmp_down_since TIMESTAMPTZ;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS snmp_last_ok_at TIMESTAMPTZ;

DO $$
BEGIN
  ALTER TABLE devices ADD CONSTRAINT devices_snmp_state_check
    CHECK (snmp_state IS NULL OR snmp_state IN ('online', 'warning', 'offline', 'unknown'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

NOTIFY pgrst, 'reload schema';
