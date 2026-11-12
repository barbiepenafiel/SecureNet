-- ─────────────────────────────────────────────────────────────
-- OPTIONAL: alert when the monitoring agent itself stops reporting
-- Run once in the Supabase SQL Editor. Safe to run more than once.
--
-- The agent raises alerts for devices — but if the agent's own machine is
-- switched off or loses internet, nothing is left to raise an alert. This
-- check runs inside the database every minute (pg_cron), so it works with
-- no browser open and no agent running:
--   • no heartbeat for 3 minutes → critical alert "Monitoring agent is offline"
--   • heartbeat returns          → that alert is resolved automatically
--
-- To remove it later:  SELECT cron.unschedule('securenet-agent-watchdog');
-- ─────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pg_cron;

CREATE OR REPLACE FUNCTION public.securenet_agent_watchdog()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  agent   TEXT;
  newest  TIMESTAMPTZ;
  open_id alerts.id%TYPE;
BEGIN
  SELECT id, last_seen INTO agent, newest FROM agent_status ORDER BY last_seen DESC LIMIT 1;
  IF newest IS NULL THEN RETURN; END IF;   -- no agent has ever reported

  SELECT id INTO open_id FROM alerts
   WHERE title = 'Monitoring agent is offline' AND resolved_at IS NULL
   ORDER BY created_at DESC LIMIT 1;

  IF newest < now() - INTERVAL '3 minutes' THEN
    IF open_id IS NULL THEN
      INSERT INTO alerts (severity, title, meta, acked, suppressed, root_cause)
      VALUES (
        'crit',
        'Monitoring agent is offline',
        'Agent: ' || agent || ' · Last report: ' || to_char(newest AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC · Status: Offline',
        false, false,
        'The SecureNet agent has not reported for over 3 minutes — device statuses are not being updated. '
          || 'Check that the agent machine is powered on, has internet access, and that the securenet-agent service is running.'
      );
    END IF;
  ELSIF open_id IS NOT NULL THEN
    UPDATE alerts
       SET acked = true, resolved_at = now(), resolved_by = 'System (watchdog)',
           resolution_notes = 'The agent is reporting again'
     WHERE id = open_id;
  END IF;
END $$;

-- Only the scheduler runs it — not dashboard users
REVOKE ALL ON FUNCTION public.securenet_agent_watchdog() FROM PUBLIC, anon, authenticated;

-- Every minute (re-running this replaces the existing schedule of the same name)
SELECT cron.schedule('securenet-agent-watchdog', '* * * * *', $$SELECT public.securenet_agent_watchdog()$$);
