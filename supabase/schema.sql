-- NetWatch NMS — Supabase Schema
-- Run this in the Supabase SQL Editor (project: aslcrxdaochnzxernnqx)

-- ── Devices ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS devices (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  type        TEXT NOT NULL,
  ip          TEXT NOT NULL,
  location    TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'up'   CHECK (status IN ('up','warn','down','maint')),
  uptime      TEXT DEFAULT '—',
  cpu         INTEGER DEFAULT 0 CHECK (cpu BETWEEN 0 AND 100),
  mem         INTEGER DEFAULT 0 CHECK (mem BETWEEN 0 AND 100),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── Alerts ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS alerts (
  id          BIGSERIAL PRIMARY KEY,
  severity    TEXT NOT NULL CHECK (severity IN ('crit','warn','info')),
  title       TEXT NOT NULL,
  meta        TEXT DEFAULT '',
  acked       BOOLEAN DEFAULT FALSE,
  suppressed  BOOLEAN DEFAULT FALSE,
  root_cause  TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── Clients ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clients (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  hostname    TEXT NOT NULL,
  mac         TEXT NOT NULL UNIQUE,
  ip          TEXT NOT NULL,
  ap          TEXT NOT NULL DEFAULT '—',
  building    TEXT NOT NULL,
  rssi        INTEGER DEFAULT -70,
  tx          TEXT DEFAULT '0 MB',
  rx          TEXT DEFAULT '0 MB',
  first_seen  TIMESTAMPTZ DEFAULT NOW(),
  last_seen   TIMESTAMPTZ DEFAULT NOW(),
  status      TEXT DEFAULT 'up' CHECK (status IN ('up','warn','down'))
);

-- ── SLA Data ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sla_data (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  device_name  TEXT NOT NULL,
  building     TEXT NOT NULL,
  uptime_pct   NUMERIC(5,2) DEFAULT 100.00,
  downtime     TEXT DEFAULT '0m',
  incidents    INTEGER DEFAULT 0,
  sla_target   NUMERIC(5,2) DEFAULT 99.90,
  period_start DATE DEFAULT (CURRENT_DATE - INTERVAL '30 days'),
  period_end   DATE DEFAULT CURRENT_DATE
);

-- ── Lifecycle ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lifecycle (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  device_name   TEXT NOT NULL UNIQUE,
  model         TEXT NOT NULL,
  firmware      TEXT NOT NULL,
  latest_fw     TEXT NOT NULL,
  warranty_date DATE,
  eom_date      DATE,
  eol_date      DATE
);

-- ── Config Backups ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS config_backups (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  device_name   TEXT NOT NULL,
  backed_up_at  TIMESTAMPTZ DEFAULT NOW(),
  size_kb       INTEGER DEFAULT 0,
  changed       BOOLEAN DEFAULT FALSE,
  backup_by     TEXT DEFAULT 'scheduler',
  content       TEXT
);

-- ── Audit Log ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  logged_at    TIMESTAMPTZ DEFAULT NOW(),
  user_name    TEXT NOT NULL,
  user_ip      TEXT NOT NULL,
  action       TEXT NOT NULL,
  object_name  TEXT NOT NULL,
  before_val   TEXT DEFAULT '—',
  after_val    TEXT DEFAULT '—'
);

-- ── Maintenance Windows ────────────────────────────────────
CREATE TABLE IF NOT EXISTS maintenance_windows (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name        TEXT NOT NULL,
  devices     TEXT NOT NULL,
  starts_at   TIMESTAMPTZ NOT NULL,
  ends_at     TIMESTAMPTZ NOT NULL,
  recurrence  TEXT DEFAULT 'Once',
  note        TEXT,
  status      TEXT DEFAULT 'Scheduled'
);

-- ── Auto-update updated_at ─────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

CREATE OR REPLACE TRIGGER devices_updated_at
  BEFORE UPDATE ON devices FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE TRIGGER alerts_updated_at
  BEFORE UPDATE ON alerts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Disable RLS for internal tool (enable + add policies if public-facing) ──
ALTER TABLE devices             DISABLE ROW LEVEL SECURITY;
ALTER TABLE alerts              DISABLE ROW LEVEL SECURITY;
ALTER TABLE clients             DISABLE ROW LEVEL SECURITY;
ALTER TABLE sla_data            DISABLE ROW LEVEL SECURITY;
ALTER TABLE lifecycle           DISABLE ROW LEVEL SECURITY;
ALTER TABLE config_backups      DISABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log           DISABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_windows DISABLE ROW LEVEL SECURITY;
