-- ─────────────────────────────────────────────────────────────
-- Hosted deployment: let the Vercel dashboard ask the campus agent to do
-- things that need LAN access (the dashboard itself cannot reach 192.168.x.x).
-- Run once in the Supabase SQL Editor. Safe to run more than once.
--
--   agent_jobs            — small request queue. The dashboard inserts a job
--                           ("probe this IP", "snapshot these devices"), the
--                           agent (poller/jobs.js) runs it on the LAN and
--                           writes the result back.
--   agent_status.priority — when two agents are running (e.g. the campus
--                           server and a laptop), the higher priority one
--                           monitors and the other stands by.
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agent_jobs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type         TEXT NOT NULL CHECK (type IN ('probe', 'config_snapshot')),
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'error')),
  result       JSONB,
  error        TEXT,
  requested_by TEXT,                 -- dashboard user who asked
  agent_id     TEXT,                 -- agent that ran it
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at   TIMESTAMPTZ,
  finished_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS agent_jobs_pending_idx ON agent_jobs (created_at) WHERE status = 'pending';

-- Jobs can contain SNMP community strings: no access for dashboard users at
-- all. Only the service role (the agent and the server-side API routes) can
-- read or write — RLS is on and there are deliberately no policies.
ALTER TABLE agent_jobs ENABLE ROW LEVEL SECURITY;

ALTER TABLE agent_status ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 0;

NOTIFY pgrst, 'reload schema';
