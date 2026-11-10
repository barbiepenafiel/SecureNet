/**
 * NetWatch DB Migration
 * Creates missing tables and disables RLS so the dashboard can read data.
 * Usage: node poller/migrate.js
 */

const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '.env') })
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: false })

const { Client } = require('./node_modules/pg')

const projectRef = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '')
  .replace('https://', '').replace('.supabase.co', '')

const SQL = `
-- Create scan_results with all columns
CREATE TABLE IF NOT EXISTS scan_results (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  ip          TEXT        NOT NULL,
  mac         TEXT,
  hostname    TEXT,
  vendor      TEXT,
  device_type TEXT,
  scan_type   TEXT        NOT NULL DEFAULT 'icmp',
  responded   BOOLEAN     NOT NULL DEFAULT FALSE,
  latency_ms  INTEGER,
  scanned_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS scan_results_scanned_at_idx ON scan_results(scanned_at DESC);
CREATE INDEX IF NOT EXISTS scan_results_ip_idx ON scan_results(ip);

-- Add columns if table existed without them
ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS vendor      TEXT;
ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS device_type TEXT;

-- Create traffic_samples
CREATE TABLE IF NOT EXISTS traffic_samples (
  id          BIGSERIAL     PRIMARY KEY,
  device_name TEXT          NOT NULL,
  interface   TEXT          NOT NULL DEFAULT 'eth0',
  in_mbps     NUMERIC(10,4) DEFAULT 0,
  out_mbps    NUMERIC(10,4) DEFAULT 0,
  sampled_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS traffic_samples_sampled_at_idx ON traffic_samples(sampled_at DESC);

-- Create status_events if missing
CREATE TABLE IF NOT EXISTS status_events (
  id          BIGSERIAL   PRIMARY KEY,
  device_name TEXT        NOT NULL,
  old_status  TEXT,
  new_status  TEXT,
  changed_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Create report_snapshots if missing
CREATE TABLE IF NOT EXISTS report_snapshots (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  title       TEXT        NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  data        JSONB
);

-- Disable RLS on all tables
ALTER TABLE devices             DISABLE ROW LEVEL SECURITY;
ALTER TABLE alerts              DISABLE ROW LEVEL SECURITY;
ALTER TABLE clients             DISABLE ROW LEVEL SECURITY;
ALTER TABLE sla_data            DISABLE ROW LEVEL SECURITY;
ALTER TABLE scan_results        DISABLE ROW LEVEL SECURITY;
ALTER TABLE traffic_samples     DISABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log           DISABLE ROW LEVEL SECURITY;
ALTER TABLE config_backups      DISABLE ROW LEVEL SECURITY;
ALTER TABLE lifecycle           DISABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_windows DISABLE ROW LEVEL SECURITY;
ALTER TABLE status_events       DISABLE ROW LEVEL SECURITY;
ALTER TABLE report_snapshots    DISABLE ROW LEVEL SECURITY;
`

async function tryConnect(config, label) {
  const client = new Client(config)
  try {
    await client.connect()
    console.log(`Connected via ${label}`)
    return client
  } catch (e) {
    await client.end().catch(() => {})
    return null
  }
}

async function main() {
  console.log('NetWatch DB Migration')
  console.log(`Project: ${projectRef}\n`)

  const dbUrl = process.env.SUPABASE_DB_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  let client = null

  // 1. Try explicit DB URL from env (most reliable)
  if (dbUrl) {
    client = await tryConnect(dbUrl, 'SUPABASE_DB_URL')
  }

  // 2. Try connection pooler with service role key as password
  if (!client && projectRef && serviceKey) {
    for (const region of ['us-east-1', 'us-west-1', 'eu-west-1', 'ap-southeast-1']) {
      client = await tryConnect({
        host:     `aws-0-${region}.pooler.supabase.com`,
        port:     5432,
        database: 'postgres',
        user:     `postgres.${projectRef}`,
        password: serviceKey,
        ssl:      { rejectUnauthorized: false },
        connectionTimeoutMillis: 5000,
      }, `pooler (${region})`)
      if (client) break
    }
  }

  // 3. Try direct connection with service role key
  if (!client && projectRef && serviceKey) {
    client = await tryConnect({
      host:     `db.${projectRef}.supabase.co`,
      port:     5432,
      database: 'postgres',
      user:     'postgres',
      password: serviceKey,
      ssl:      { rejectUnauthorized: false },
      connectionTimeoutMillis: 5000,
    }, 'direct connection')
  }

  if (!client) {
    console.error('\n❌ Could not connect to Supabase database.')
    console.error('\nTo fix: add your database URL to poller/.env or the root .env:')
    console.error('  SUPABASE_DB_URL=postgresql://postgres:PASSWORD@db.PROJECT.supabase.co:5432/postgres')
    console.error('\nGet the URL from: supabase.com → your project → Settings → Database → Connection string')
    process.exit(1)
  }

  try {
    console.log('Running migration SQL...')
    await client.query(SQL)
    console.log('\n✅ Migration complete! Tables created and RLS disabled.')
    console.log('   Restart the agent and refresh the Vercel dashboard.')
  } catch (e) {
    console.error('\n❌ Migration failed:', e.message)
    process.exit(1)
  } finally {
    await client.end()
  }
}

main()
