-- Alert details: device name, IP, MAC, location, detection method, status.
-- Run once in the Supabase SQL Editor.
-- (The app still works before this is run — the details are also kept in `meta`.)

ALTER TABLE alerts ADD COLUMN IF NOT EXISTS device_name      TEXT;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS device_ip        TEXT;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS device_mac       TEXT;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS location         TEXT;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS detection_method TEXT;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS status           TEXT
  CHECK (status IS NULL OR status IN ('online', 'offline'));

CREATE INDEX IF NOT EXISTS alerts_created_at_idx ON alerts (created_at DESC);
CREATE INDEX IF NOT EXISTS alerts_device_ip_idx  ON alerts (device_ip);

-- Refresh the API schema cache so the new columns are usable immediately
NOTIFY pgrst, 'reload schema';
