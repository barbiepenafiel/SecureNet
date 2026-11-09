/**
 * NetWatch — Synthetic traffic data generator (Option 1 fallback)
 *
 * Use this when snmpsim won't start (Python version incompatibility).
 * Generates realistic bandwidth data matching the snmprec increment values
 * and writes directly to Supabase — no Python or SNMP required.
 *
 * Run:  node gen-data.js
 * Stop: Ctrl+C
 */

const path = require('path')
// Load .env from poller/ first, then fall back to project root
require('dotenv').config({ path: path.join(__dirname, '.env') })
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: false })
const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
)

// Device profiles — mirrors snmprec increment values (bytes/sec)
// inBytesPerSec / outBytesPerSec derived from snmprec increment fields
const PROFILES = [
  { name: 'Core-FW-1',  iface: 'GigabitEthernet0/0', inBps: 6_500_000, outBps: 3_500_000, cpu: 32, mem: 44 },
  { name: 'Core-SW-1',  iface: 'TenGigE0/1',          inBps:14_750_000, outBps:12_250_000, cpu: 28, mem: 51 },
  { name: 'SW-A1',      iface: 'GigabitEthernet0/1',  inBps: 3_125_000, outBps: 1_750_000, cpu: 18, mem: 38 },
  { name: 'SW-A2',      iface: 'GigabitEthernet0/1',  inBps: 2_750_000, outBps: 1_500_000, cpu: 15, mem: 35 },
  // SW-B2 intentionally omitted — simulates DOWN device
  { name: 'SW-C1',      iface: 'GigabitEthernet0/1',  inBps: 1_875_000, outBps: 1_250_000, cpu: 12, mem: 32 },
  { name: 'AP-A-01',    iface: 'wlan0',                inBps:   937_500, outBps:   500_000, cpu:  8, mem: 42 },
  { name: 'AP-A-02',    iface: 'wlan0',                inBps:   750_000, outBps:   375_000, cpu:  7, mem: 40 },
  { name: 'AP-A-03',    iface: 'wlan0',                inBps: 1_125_000, outBps:   625_000, cpu: 11, mem: 44 },
  { name: 'AP-A-04',    iface: 'wlan0',                inBps: 1_875_000, outBps: 1_000_000, cpu: 19, mem: 48 },
  { name: 'AP-C-01',    iface: 'wlan0',                inBps:   500_000, outBps:   250_000, cpu:  5, mem: 38 },
  { name: 'AP-C-02',    iface: 'wlan0',                inBps:   625_000, outBps:   312_500, cpu:  6, mem: 39 },
  { name: 'SRV-DC-01',  iface: 'ens192',               inBps: 2_500_000, outBps: 1_875_000, cpu: 55, mem: 72 },
  { name: 'SRV-DC-02',  iface: 'ens192',               inBps: 2_250_000, outBps: 1_875_000, cpu: 41, mem: 68 },
  { name: 'SRV-DC-03',  iface: 'ens192',               inBps: 1_500_000, outBps: 1_000_000, cpu: 28, mem: 55 },
]

const INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '60000', 10)

// Business-hours traffic multiplier (index = hour of day, 0-23)
const HOUR_MULT = [
  0.22, 0.20, 0.19, 0.18, 0.20, 0.24, // 0-5  (night)
  0.34, 0.53, 0.87, 1.00, 1.05, 1.08, // 6-11 (morning ramp)
  1.10, 1.07, 1.04, 1.06, 0.98, 0.86, // 12-17 (business hours)
  0.67, 0.49, 0.37, 0.31, 0.28, 0.25, // 18-23 (evening wind-down)
]

function jitter(base, pct = 0.08) {
  return base * (1 + (Math.random() * 2 - 1) * pct)
}

async function poll() {
  const hour = new Date().getHours()
  const mult = HOUR_MULT[hour]
  const rows = []

  for (const p of PROFILES) {
    const inMbps  = jitter(p.inBps  * mult * 8 / 1_000_000, 0.07)
    const outMbps = jitter(p.outBps * mult * 8 / 1_000_000, 0.07)
    rows.push({
      device_name: p.name,
      interface:   p.iface,
      in_mbps:     parseFloat(inMbps.toFixed(3)),
      out_mbps:    parseFloat(outMbps.toFixed(3)),
    })
  }

  // Insert traffic samples
  const { error: insErr } = await supabase.from('traffic_samples').insert(rows)
  if (insErr) {
    console.error(`[${ts()}] INSERT error:`, insErr.message)
    return
  }

  // Update devices table (cpu/mem reflect current load)
  for (const p of PROFILES) {
    const hour = new Date().getHours()
    const mult = HOUR_MULT[hour]
    const cpu = Math.min(99, Math.round(jitter(p.cpu * (0.5 + mult * 0.5))))
    const mem = Math.min(99, Math.round(jitter(p.mem, 0.03)))
    await supabase.from('devices').update({ cpu, mem, status: 'up', updated_at: new Date().toISOString() })
      .eq('name', p.name)
  }

  // Mark SW-B2 as down (no traffic data for it)
  await supabase.from('devices').update({ status: 'down', cpu: 0, mem: 0, updated_at: new Date().toISOString() })
    .eq('name', 'SW-B2')

  const totalIn  = rows.reduce((s, r) => s + r.in_mbps,  0)
  const totalOut = rows.reduce((s, r) => s + r.out_mbps, 0)
  console.log(`[${ts()}] Wrote ${rows.length} samples | Total ↓${totalIn.toFixed(1)} Mbps ↑${totalOut.toFixed(1)} Mbps`)
}

function ts() {
  return new Date().toTimeString().slice(0, 8)
}

async function main() {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
    console.error('Missing NEXT_PUBLIC_SUPABASE_URL — add it to poller/.env or the project root .env')
    process.exit(1)
  }
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ||
              process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
              process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  if (!key) {
    console.error('Missing Supabase key — set SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_SUPABASE_ANON_KEY, or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY')
    process.exit(1)
  }

  console.log(`NetWatch data generator started — interval ${INTERVAL_MS / 1000}s`)
  console.log(`Writing to: ${process.env.NEXT_PUBLIC_SUPABASE_URL}`)
  console.log('Press Ctrl+C to stop.\n')

  await poll()
  setInterval(poll, INTERVAL_MS)
}

main().catch(err => { console.error(err); process.exit(1) })
