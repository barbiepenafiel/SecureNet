-- Status event log — records every device status transition
-- Run in Supabase SQL Editor

CREATE TABLE IF NOT EXISTS status_events (
  id          BIGSERIAL PRIMARY KEY,
  device_id   UUID        NOT NULL,
  device_name TEXT        NOT NULL,
  device_ip   TEXT        NOT NULL,
  old_status  TEXT,
  new_status  TEXT        NOT NULL,
  changed_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS status_events_device_id_idx ON status_events(device_id);
CREATE INDEX IF NOT EXISTS status_events_changed_at_idx ON status_events(changed_at DESC);

ALTER TABLE status_events DISABLE ROW LEVEL SECURITY;
