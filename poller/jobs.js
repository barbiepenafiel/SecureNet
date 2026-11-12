/**
 * Runs LAN requests from the dashboard (used by agent.js).
 *
 * The dashboard may be hosted on Vercel, which cannot reach private
 * addresses. It writes a row to `agent_jobs` (supabase/migration_agent_jobs.sql);
 * this module picks it up within ~2 s, runs it on the campus network and
 * writes the result back:
 *   probe            Add Device: check one IP by ICMP / ARP / SNMP / DNS
 *   config_snapshot  Config Backup: read system + interface info over SNMP
 * Read-only on the devices. Inputs are validated here as well as in the
 * dashboard, so nothing unexpected ever reaches the shell.
 */

const os   = require('os')
const snmp = require('net-snmp')
const { probeDevice, IPV4 } = require('./probe')

const POLL_MS      = parseInt(process.env.JOB_POLL_MS ?? '2000', 10)
const MAX_AGE_MS   = 2 * 60_000        // older requests are abandoned, never run late
const KEEP_MS      = 60 * 60_000       // finished jobs are removed after an hour (they can hold SNMP communities)
const RETRY_MISSING_MS = 60_000        // table not installed yet: look again in a minute
const AGENT_ID     = os.hostname()

// ── Config snapshot (same text as the dashboard's /api/config-backup) ────────
function snmpGet(ip, community, port, oids) {
  return new Promise(resolve => {
    let s = null
    try {
      s = snmp.createSession(ip, community, { port, timeout: 3000, retries: 1, version: snmp.Version2c })
      s.on('error', () => { try { s.close() } catch {} resolve([]) })
      s.get(oids, (err, vb) => { try { s.close() } catch {} resolve(err ? [] : (vb ?? [])) })
    } catch {
      try { s?.close() } catch {}
      resolve([])
    }
  })
}
const val = vb => (vb && !snmp.isVarbindError(vb) && vb.value != null ? vb.value : undefined)

async function buildSnapshot(ip, community, port, deviceName, deviceType) {
  const sysVb = await snmpGet(ip, community, port, [
    '1.3.6.1.2.1.1.1.0', '1.3.6.1.2.1.1.5.0', '1.3.6.1.2.1.1.3.0',   // sysDescr, sysName, sysUpTime
    '1.3.6.1.2.1.1.4.0', '1.3.6.1.2.1.1.6.0', '1.3.6.1.2.1.2.1.0',   // sysContact, sysLocation, ifNumber
  ])
  const sysDescr  = val(sysVb[0])?.toString() ?? '—'
  const sysName   = val(sysVb[1])?.toString() ?? deviceName
  const totalSecs = Math.floor(Number(val(sysVb[2]) ?? 0) / 100)
  const uptime    = `${Math.floor(totalSecs / 86400)}d ${Math.floor((totalSecs % 86400) / 3600)}h ${Math.floor((totalSecs % 3600) / 60)}m`
  const contact   = val(sysVb[3])?.toString() ?? '—'
  const location  = val(sysVb[4])?.toString() ?? '—'
  const ifCount   = Number(val(sysVb[5]) ?? 0)

  const ifLines = []
  if (ifCount > 0) {
    const idxs = Array.from({ length: Math.min(ifCount, 10) }, (_, i) => i + 1)
    const ifVb = await snmpGet(ip, community, port, idxs.flatMap(i => [`1.3.6.1.2.1.2.2.1.2.${i}`, `1.3.6.1.2.1.2.2.1.8.${i}`]))
    for (let i = 0; i < idxs.length; i++) {
      const name  = val(ifVb[i * 2])?.toString() ?? `if${i + 1}`
      const state = Number(val(ifVb[i * 2 + 1]) ?? 2) === 1 ? 'up' : 'down'
      ifLines.push(`  interface ${name}`, `    admin-status: ${state}`)
    }
  }

  return [
    `! Snapshot: ${deviceName} (${deviceType})`,
    `! Generated: ${new Date().toISOString()}`,
    `! Source: SNMP v2c @ ${ip}`,
    `!`,
    `hostname ${sysName}`,
    `!`,
    `system-description ${sysDescr.replace(/\n/g, ' ')}`,
    `system-uptime ${uptime}`,
    `system-contact ${contact}`,
    `system-location ${location}`,
    `!`,
    `! Interfaces (${ifCount} total):`,
    ...ifLines,
    `!`,
    `! end`,
  ].join('\n')
}

// ── Handlers ─────────────────────────────────────────────────────────────────
const HANDLERS = {
  probe: p => probeDevice(String(p.ip ?? ''), p.community ? String(p.community) : null, p.port ?? 161),

  config_snapshot: async p => {
    const devices = Array.isArray(p.devices) ? p.devices.slice(0, 300) : []
    const snapshots = {}
    for (let i = 0; i < devices.length; i += 8) {
      await Promise.all(devices.slice(i, i + 8).map(async d => {
        const ip = String(d.ip ?? ''), port = Number(d.port) || 161
        const community = String(d.community ?? 'public')
        if (!IPV4.test(ip) || port < 1 || port > 65535 || community.length > 64) { snapshots[d.id] = null; return }
        try { snapshots[d.id] = await buildSnapshot(ip, community, port, String(d.name ?? ip), String(d.type ?? 'Device')) }
        catch { snapshots[d.id] = null }
      }))
    }
    return { snapshots }
  },
}

// ── Loop ─────────────────────────────────────────────────────────────────────
let missingLogged = false
let retryAt = 0
let cleanedAt = 0

async function runJob(db, job) {
  // Claim it — if another agent got there first, nothing is returned
  const { data: claimed } = await db.from('agent_jobs')
    .update({ status: 'running', agent_id: AGENT_ID, started_at: new Date().toISOString() })
    .eq('id', job.id).eq('status', 'pending').select('id')
  if (!claimed?.length) return

  const done = patch => db.from('agent_jobs').update({ ...patch, finished_at: new Date().toISOString() }).eq('id', job.id)
  const handler = HANDLERS[job.type]
  if (!handler) { await done({ status: 'error', error: `Unknown job type "${job.type}"` }); return }
  try {
    const result = await handler(job.payload ?? {})
    await done({ status: 'done', result })
    console.log(`  [jobs] ${job.type} done${job.type === 'probe' ? ` (${job.payload?.ip}: ${result.reachable ? 'reachable' : 'no answer'})` : ''}`)
  } catch (e) {
    await done({ status: 'error', error: String(e?.message ?? e).slice(0, 300) })
    console.log(`  [jobs] ${job.type} failed: ${e?.message ?? e}`)
  }
}

async function tick(db) {
  if (Date.now() < retryAt) return
  const { data, error } = await db.from('agent_jobs')
    .select('id, type, payload')
    .eq('status', 'pending')
    .gte('created_at', new Date(Date.now() - MAX_AGE_MS).toISOString())
    .order('created_at').limit(5)
  if (error) {
    if (/schema cache|does not exist|relation/i.test(error.message)) {
      if (!missingLogged) console.log('  [jobs] run supabase/migration_agent_jobs.sql so the hosted dashboard can use Add Device and Config Backup (checking again every minute)')
      missingLogged = true
    }
    retryAt = Date.now() + RETRY_MISSING_MS
    return
  }
  if (missingLogged) { console.log('  [jobs] ready — taking requests from the dashboard'); missingLogged = false }
  await Promise.all((data ?? []).map(job => runJob(db, job)))

  if (Date.now() - cleanedAt > 10 * 60_000) {
    cleanedAt = Date.now()
    await db.from('agent_jobs').delete().lt('created_at', new Date(Date.now() - KEEP_MS).toISOString()).then(() => {}, () => {})
  }
}

// isActive: () => boolean — false while this agent is standing by for another one
function start(db, isActive = () => true) {
  const loop = async () => {
    try { if (isActive()) await tick(db) } catch (e) { console.log(`  [jobs] ${e.message}`) }
    setTimeout(loop, POLL_MS)
  }
  loop()
}

module.exports = { start, POLL_MS }
