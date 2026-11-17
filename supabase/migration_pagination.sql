-- ─────────────────────────────────────────────────────────────
-- Pagination support
-- Run once in the Supabase SQL Editor (safe to run more than once).
--
-- The Alerts page lists the most recent activity first: when an alert was
-- resolved, otherwise when it was raised. To page through that order in the
-- database (instead of downloading every alert), it is stored as a column
-- the database keeps up to date by itself, with an index.
-- Until this is run, the Alerts page pages by the time each alert was raised.
-- ─────────────────────────────────────────────────────────────

ALTER TABLE alerts ADD COLUMN IF NOT EXISTS last_activity timestamptz
  GENERATED ALWAYS AS (COALESCE(resolved_at, created_at)) STORED;

CREATE INDEX IF NOT EXISTS alerts_last_activity_idx ON alerts (last_activity DESC, id DESC);

-- Reports → Critical Incidents: critical alerts in a period, newest first
CREATE INDEX IF NOT EXISTS alerts_severity_created_idx ON alerts (severity, created_at DESC);

-- Audit log, newest first
CREATE INDEX IF NOT EXISTS audit_log_logged_at_idx ON audit_log (logged_at DESC);

NOTIFY pgrst, 'reload schema';
