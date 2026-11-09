/**
 * NetWatch SNMP Poller
 * Polls devices every 60 seconds via SNMP v2c, writes traffic_samples to Supabase,
 * and updates devices.cpu in real time.
 *
 * Reads device list from Supabase — add devices via the "+ Add Device" button in
 * the dashboard and they are picked up automatically on the next poll cycle.
 *
 * Usage:
 *   cd poller && node poller.js
 */

const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '.env') })
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: false })

const snmp = require('net-snmp')
const { createClient } = require('@supabase/supabase-js')

// ── Supabase ──────────────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
)

// ── Load device list from Supabase ────────────────────────────────────────────
async function loadDevices() {
  const { data, error } = await supabase
    .from('devices')
    .select('name, ip, snmp_community, snmp_port, status')
    .neq('status', 'down')
  if (error) {
    console.error('Failed to load devices from Supabase:', error.message)
    return []
  }
  // Only poll real network devices — VMs on 192.168.56.x host-only network
  // Simulated devices (10.x, 192.168.1.x etc.) are handled by gen-data.js
  const VM_SUBNET = process.env.SNMP_SUBNET || '192.168.56.'
  const devices = (data ?? []).filter(d => d.ip.startsWith(VM_SUBNET))
  return devices.map(d => ({
    name:      d.name,
    ip:        d.ip,
    port:      d.snmp_port  ?? 161,
    community: d.snmp_community ?? 'nw2026',
    iface:     1,
  }))
}

// ── SNMP OIDs ─────────────────────────────────────────────────────────────────
const OID = {
  sysName:     '1.3.6.1.2.1.1.5.0',
  sysUpTime:   '1.3.6.1.2.1.1.3.0',
  ifInOctets:  (i) => `1.3.6.1.2.1.2.2.1.10.${i}`,   // Counter32 — bytes in
  ifOutOctets: (i) => `1.3.6.1.2.1.2.2.1.16.${i}`,   // Counter32 — bytes out
  cpuLoad:     '1.3.6.1.2.1.25.3.3.1.2.1',           // hrProcessorLoad (%)
  memUsed:     '1.3.6.1.2.1.25.2.3.1.6.1',           // hrStorageUsed
  memTotal:    '1.3.6.1.2.1.25.2.3.1.5.1',           // hrStorageSize
}

// ── Delta tracking (previous poll values per device) ─────────────────────────
const prev = {}

// ── Poll one device ───────────────────────────────────────────────────────────
function pollDevice(device) {
  return new Promise((resolve) => {
    const session = snmp.createSession(device.ip, device.community, {
      port:     device.port,
      retries:  1,
      timeout:  3000,
      version:  snmp.Version2c,
    })

    const i = device.iface
    const oids = [
      OID.ifInOctets(i),
      OID.ifOutOctets(i),
      OID.cpuLoad,
      OID.memUsed,
      OID.memTotal,
    ]

    session.get(oids, (error, varbinds) => {
      session.close()

      if (error) {
        console.warn(`  ✗ ${device.name.padEnd(12)} ${error.message}`)
        resolve(null)
        return
      }

      try {
        const inBytes  = Number(varbinds[0]?.value ?? 0)
        const outBytes = Number(varbinds[1]?.value ?? 0)
        const cpu      = Number(varbinds[2]?.value ?? 0)
        const memUsed  = Number(varbinds[3]?.value ?? 0)
        const memTotal = Number(varbinds[4]?.value ?? 1)

        const mem = memTotal > 0 ? Math.round((memUsed / memTotal) * 100) : 0
        const now = Date.now()
        const key = device.name

        let inMbps = 0, outMbps = 0

        if (prev[key]) {
          const dtSec = (now - prev[key].ts) / 1000
          if (dtSec > 0) {
            // Handle 32-bit counter wrap at 4,294,967,296
            let dIn  = inBytes  - prev[key].inBytes
            let dOut = outBytes - prev[key].outBytes
            if (dIn  < 0) dIn  += 4_294_967_296
            if (dOut < 0) dOut += 4_294_967_296

            inMbps  = (dIn  * 8) / (dtSec * 1_000_000)
            outMbps = (dOut * 8) / (dtSec * 1_000_000)
          }
        }

        prev[key] = { ts: now, inBytes, outBytes }

        resolve({
          name: device.name, inMbps, outMbps, cpu, mem,
          iface: device.iface,
        })
      } catch (e) {
        console.warn(`  ✗ ${device.name} parse error: ${e.message}`)
        resolve(null)
      }
    })
  })
}

// ── Poll all devices and write to Supabase ────────────────────────────────────
async function pollAll() {
  const DEVICES = await loadDevices()
  const ts = new Date().toISOString()
  console.log(`\n[${ts}] Polling ${DEVICES.length} devices…`)

  const results = await Promise.allSettled(DEVICES.map(pollDevice))
  const ok = results
    .filter(r => r.status === 'fulfilled' && r.value)
    .map(r => r.value)

  if (ok.length === 0) {
    console.log('  No responses. Are snmpsim agents running? (see poller/snmpsim/start.bat)')
    return
  }

  // ── Write traffic_samples ──
  const { error: sErr } = await supabase.from('traffic_samples').insert(
    ok.map(s => ({
      device_name: s.name,
      interface:   `eth${s.iface - 1}`,
      in_mbps:     Math.max(0, parseFloat(s.inMbps.toFixed(3))),
      out_mbps:    Math.max(0, parseFloat(s.outMbps.toFixed(3))),
      sampled_at:  ts,
    }))
  )
  if (sErr) console.error('  Supabase write error:', sErr.message)

  // ── Update devices.cpu and devices.mem ──
  for (const s of ok) {
    if (s.cpu > 0 || s.mem > 0) {
      await supabase
        .from('devices')
        .update({ cpu: s.cpu, mem: s.mem })
        .eq('name', s.name)
    }
  }

  // ── Summary ──
  const top = [...ok].sort((a, b) => b.inMbps - a.inMbps).slice(0, 4)
  console.log(`  ✓ ${ok.length}/${DEVICES.length} responded`)
  top.forEach(s =>
    console.log(`    ${s.name.padEnd(14)} ↓${s.inMbps.toFixed(1).padStart(6)} Mbps  ↑${s.outMbps.toFixed(1).padStart(6)} Mbps  CPU ${s.cpu}%`)
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────
const INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? '60000', 10)
console.log(`NetWatch SNMP Poller`)
console.log(`  Devices: loaded from Supabase each cycle (add via "+ Add Device" in dashboard)`)
console.log(`  Interval: ${INTERVAL_MS / 1000}s`)
console.log(`  Press Ctrl+C to stop.\n`)

pollAll()
setInterval(pollAll, INTERVAL_MS)
