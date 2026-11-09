-- NetWatch NMS — Traffic Samples Table
-- Run this in the Supabase SQL Editor AFTER schema.sql

CREATE TABLE IF NOT EXISTS traffic_samples (
  id          BIGSERIAL PRIMARY KEY,
  device_name TEXT        NOT NULL,
  interface   TEXT        NOT NULL DEFAULT 'eth0',
  in_mbps     NUMERIC(10,3) DEFAULT 0,
  out_mbps    NUMERIC(10,3) DEFAULT 0,
  sampled_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for fast time-series queries
CREATE INDEX IF NOT EXISTS traffic_samples_device_time ON traffic_samples (device_name, sampled_at DESC);
CREATE INDEX IF NOT EXISTS traffic_samples_time        ON traffic_samples (sampled_at DESC);

-- Auto-delete samples older than 7 days (keeps DB lean)
-- Enable pg_cron extension in Supabase dashboard first, then uncomment:
-- SELECT cron.schedule('delete-old-traffic', '0 * * * *',
--   $$DELETE FROM traffic_samples WHERE sampled_at < NOW() - INTERVAL '7 days'$$);

ALTER TABLE traffic_samples DISABLE ROW LEVEL SECURITY;
