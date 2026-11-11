-- ─────────────────────────────────────────────────────────────
-- Real-time alerts
-- Run once in the Supabase SQL Editor.
--
-- Turns on Supabase Realtime for the alerts table, so a new alert appears
-- on the dashboard the moment the monitor saves it (no page refresh).
-- Safe to run more than once.
-- ─────────────────────────────────────────────────────────────

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE alerts;
EXCEPTION WHEN duplicate_object THEN NULL;   -- already enabled
END $$;

-- Send the whole row on UPDATE/DELETE so the dashboard can tell when an
-- alert gets resolved (it then drops out of Recent Alerts immediately)
ALTER TABLE alerts REPLICA IDENTITY FULL;
