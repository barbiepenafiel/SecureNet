-- ─────────────────────────────────────────────────────────────
-- SNMP status: why a device is or isn't answering SNMP
-- Run once in the Supabase SQL Editor. Safe to run more than once.
--
-- The agent (poller/snmp-status.js) records one of five states per SNMP
-- device, judged from the network it is connected to at that moment:
--   responding   answered SNMP
--   unreachable  no path to the device from the agent's current network
--                (says nothing about whether SNMP is enabled on it)
--   disabled     reachable, and it refused UDP 161 — SNMP is switched off
--   auth_failed  reachable, SNMP answered before, now silent — access refused
--                (community changed, or the agent's address is not allowed)
--   timeout      reachable, no reply and no refusal
-- ─────────────────────────────────────────────────────────────

ALTER TABLE devices ADD COLUMN IF NOT EXISTS snmp_status     TEXT;         -- one of the five states above; NULL = not an SNMP device
ALTER TABLE devices ADD COLUMN IF NOT EXISTS snmp_detail     TEXT;         -- the reason, in plain words
ALTER TABLE devices ADD COLUMN IF NOT EXISTS snmp_checked_at TIMESTAMPTZ;  -- when the status last changed

ALTER TABLE mikrotik_routers ADD COLUMN IF NOT EXISTS snmp_status TEXT;    -- same states, for the router card

NOTIFY pgrst, 'reload schema';
