-- ─────────────────────────────────────────────────────────────
-- Notification bell
-- Run once in the Supabase SQL Editor (safe to run more than once).
--
-- Notifications ARE the rows of the existing `alerts` table (written by the
-- monitoring agent), so there is no second copy of them. This only adds what
-- the bell needs per signed-in user:
--   • notification_reads  — which alerts this user has read or cleared
--   • notification_cursor — "Mark all as read": everything up to this time is read
-- Each user sees and changes only their own rows (row-level security), and
-- only accounts with a SecureNet role (Network Admin / IT Staff) have access.
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS notification_reads (
  user_id    uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  alert_id   bigint      NOT NULL REFERENCES alerts(id)     ON DELETE CASCADE,
  read_at    timestamptz NOT NULL DEFAULT now(),
  cleared_at timestamptz,                        -- set = removed from this user's bell
  PRIMARY KEY (user_id, alert_id)
);
CREATE INDEX IF NOT EXISTS notification_reads_alert_idx ON notification_reads (alert_id);

CREATE TABLE IF NOT EXISTS notification_cursor (
  user_id     uuid        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  read_before timestamptz NOT NULL DEFAULT now()
);

-- Signed in with a SecureNet role
CREATE OR REPLACE FUNCTION has_notification_access()
RETURNS boolean
LANGUAGE sql STABLE
SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('net_admin', 'it_staff'));
$$;

ALTER TABLE notification_reads  ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_cursor ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS notification_reads_own ON notification_reads;
CREATE POLICY notification_reads_own ON notification_reads
  FOR ALL TO authenticated
  USING      (user_id = auth.uid() AND has_notification_access())
  WITH CHECK (user_id = auth.uid() AND has_notification_access());

DROP POLICY IF EXISTS notification_cursor_own ON notification_cursor;
CREATE POLICY notification_cursor_own ON notification_cursor
  FOR ALL TO authenticated
  USING      (user_id = auth.uid() AND has_notification_access())
  WITH CHECK (user_id = auth.uid() AND has_notification_access());

-- ── Unread rule ──────────────────────────────────────────────
-- An alert is unread for a user when it is not suppressed, is from the last
-- 7 days, is newer than their "Mark all as read" time, and they have not
-- read or cleared it. (Older alerts count as read so a new account does not
-- start with thousands of unread notifications; they stay in the history.)

CREATE OR REPLACE FUNCTION notification_unread_count()
RETURNS integer
LANGUAGE sql STABLE
SECURITY INVOKER SET search_path = public
AS $$
  SELECT CASE WHEN NOT has_notification_access() THEN 0 ELSE (
    SELECT count(*)::int FROM alerts a
    WHERE NOT a.suppressed
      AND a.created_at > GREATEST(
            COALESCE((SELECT read_before FROM notification_cursor WHERE user_id = auth.uid()), '-infinity'::timestamptz),
            now() - interval '7 days')
      AND NOT EXISTS (SELECT 1 FROM notification_reads r WHERE r.user_id = auth.uid() AND r.alert_id = a.id)
  ) END;
$$;

-- The signed-in user's notifications, newest first: the whole alert as JSON
-- plus this user's state. Shared by notification_list and notification_count.
--   p_before       — only alerts raised before this time (a later page's snapshot)
--   p_severity     — 'crit' | 'warn' | 'info' | NULL (all)
--   p_unread_only  — only unread
--   p_include_cleared — also return alerts this user cleared (history page)
DROP FUNCTION IF EXISTS notification_list(integer, timestamptz, text, boolean, boolean);

CREATE OR REPLACE FUNCTION notification_rows(
  p_before          timestamptz DEFAULT NULL,
  p_severity        text        DEFAULT NULL,
  p_unread_only     boolean     DEFAULT false,
  p_include_cleared boolean     DEFAULT false
)
RETURNS TABLE (alert jsonb, is_read boolean, cleared boolean, created_at timestamptz, id bigint)
LANGUAGE sql STABLE
SECURITY INVOKER SET search_path = public
AS $$
  WITH me AS (
    SELECT GREATEST(
      COALESCE((SELECT read_before FROM notification_cursor WHERE user_id = auth.uid()), '-infinity'::timestamptz),
      now() - interval '7 days') AS read_before
  ),
  n AS (
    SELECT a.*, r.read_at, r.cleared_at,
           (r.read_at IS NOT NULL OR a.created_at <= (SELECT read_before FROM me)) AS is_read
    FROM alerts a
    LEFT JOIN notification_reads r ON r.alert_id = a.id AND r.user_id = auth.uid()
    WHERE has_notification_access()
      AND NOT a.suppressed
      AND (p_before IS NULL OR a.created_at < p_before)
      AND (p_severity IS NULL OR a.severity = p_severity)
      AND (p_include_cleared OR r.cleared_at IS NULL)
  )
  SELECT to_jsonb(n) - 'read_at' - 'cleared_at' - 'is_read', n.is_read, n.cleared_at IS NOT NULL, n.created_at, n.id
  FROM n
  WHERE NOT p_unread_only OR NOT n.is_read;
$$;

-- One page: p_limit rows (max 200) after skipping p_offset
CREATE OR REPLACE FUNCTION notification_list(
  p_limit           integer     DEFAULT 20,
  p_offset          integer     DEFAULT 0,
  p_before          timestamptz DEFAULT NULL,
  p_severity        text        DEFAULT NULL,
  p_unread_only     boolean     DEFAULT false,
  p_include_cleared boolean     DEFAULT false
)
RETURNS TABLE (alert jsonb, is_read boolean, cleared boolean)
LANGUAGE sql STABLE
SECURITY INVOKER SET search_path = public
AS $$
  SELECT r.alert, r.is_read, r.cleared
  FROM notification_rows(p_before, p_severity, p_unread_only, p_include_cleared) r
  ORDER BY r.created_at DESC, r.id DESC
  LIMIT LEAST(GREATEST(p_limit, 1), 200) OFFSET GREATEST(p_offset, 0);
$$;

-- How many rows the same filters match (for "Showing 1–25 of N")
CREATE OR REPLACE FUNCTION notification_count(
  p_before          timestamptz DEFAULT NULL,
  p_severity        text        DEFAULT NULL,
  p_unread_only     boolean     DEFAULT false,
  p_include_cleared boolean     DEFAULT false
)
RETURNS integer
LANGUAGE sql STABLE
SECURITY INVOKER SET search_path = public
AS $$
  SELECT count(*)::int FROM notification_rows(p_before, p_severity, p_unread_only, p_include_cleared);
$$;

GRANT EXECUTE ON FUNCTION notification_unread_count() TO authenticated;
GRANT EXECUTE ON FUNCTION notification_rows(timestamptz, text, boolean, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION notification_list(integer, integer, timestamptz, text, boolean, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION notification_count(timestamptz, text, boolean, boolean) TO authenticated;

-- Read/clear in one tab updates the bell in the user's other tabs and devices
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE notification_reads;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE notification_cursor;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

NOTIFY pgrst, 'reload schema';
