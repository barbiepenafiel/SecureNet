/**
 * MikroTik RouterOS SNMP collector (used by agent.js)
 *
 * Every 15 s (MIKROTIK_POLL_MS) for each MikroTik router in `devices`:
 *   - system: identity, model/board, RouterOS version, firmware, serial,
 *             uptime, CPU load (all cores), memory, disk, temperature, voltage
 *   - interfaces: name, comment, MAC, MTU, speed, enabled/link status,
 *             IP addresses, live in/out rate, totals, errors, drops
 * and writes it to mikrotik_routers / mikrotik_interfaces (live view),
 * devices (cpu, mem, uptime, model, firmware) and, every 60 s
 * (MIKROTIK_HISTORY_MS), traffic_samples (history for the Traffic page).
 *
 * A device is checked for RouterOS (sysObjectID under MikroTik's enterprise
 * number 14988) when it has an SNMP community and is either added manually
 * or has a MikroTik MAC address. SNMP v2c, read-only — nothing is written to
 * the router.
 */

const { exec }      = require('child_process')
const { promisify } = require('util')
const os   = require('os')
const snmp = require('net-snmp')
const st   = require('./snmp-status')   // reachability check + SNMP status diagnosis
const mndp = require('./mndp')          // MikroTik discovery broadcasts (is the router connected, and at which address?)

const execAsync = promisify(exec)

const POLL_MS    = parseInt(process.env.MIKROTIK_POLL_MS    ?? '15000', 10)
const HISTORY_MS = parseInt(process.env.MIKROTIK_HISTORY_MS ?? '60000', 10)
const RECHECK_NO_ANSWER_MS = 60_000        // device didn't answer SNMP: try again in 1 min
const RECHECK_OTHER_MS     = 10 * 60_000   // answered, but not RouterOS: check again in 10 min

const MIKROTIK_ENTERPRISE = '1.3.6.1.4.1.14988.'

// MikroTik (Routerboard.com) MAC prefixes
const MIKROTIK_OUI = new Set([
  '000C42', '085531', '18FD74', '2CC81B', '2CC8D9', '488F5A', '48A97E', '48A98A',
  '4C5E0C', '64D154', '6C3B6B', '744D28', '74AD0C', '789A18', 'B8690A', 'B869F4',
  'C4AD34', 'CC2DE0', 'D401C3', 'D4CA6D', 'DC2C6E', 'E48027', 'E48D8C', 'F41E57',
])

// ── OIDs ──────────────────────────────────────────────────────────────────────
// Scalars (one GET)
const SCALARS = {
  sysDescr:          '1.3.6.1.2.1.1.1.0',          // "RouterOS RB750Gr3"
  sysObjectID:       '1.3.6.1.2.1.1.2.0',          // 1.3.6.1.4.1.14988.1 on RouterOS
  sysUpTime:         '1.3.6.1.2.1.1.3.0',          // SNMP agent uptime (fallback)
  sysContact:        '1.3.6.1.2.1.1.4.0',
  sysName:           '1.3.6.1.2.1.1.5.0',          // /system identity
  sysLocation:       '1.3.6.1.2.1.1.6.0',
  hrSystemUptime:    '1.3.6.1.2.1.25.1.1.0',       // router uptime
  mtxrLicVersion:    '1.3.6.1.4.1.14988.1.1.4.4.0', // RouterOS version
  mtxrSerialNumber:  '1.3.6.1.4.1.14988.1.1.7.3.0',
  mtxrFirmware:      '1.3.6.1.4.1.14988.1.1.7.4.0', // RouterBOOT version
  mtxrBoardName:     '1.3.6.1.4.1.14988.1.1.7.8.0',
  mtxrHlVoltage:     '1.3.6.1.4.1.14988.1.1.3.8.0',  // RouterOS 6: decivolts
  mtxrHlTemperature: '1.3.6.1.4.1.14988.1.1.3.10.0', // RouterOS 6: deci-°C
}
// Tables (walked)
const TABLES = {
  ifEntry:         '1.3.6.1.2.1.2.2.1',             // IF-MIB ifTable
  ifXEntry:        '1.3.6.1.2.1.31.1.1.1',          // IF-MIB ifXTable (names, 64-bit counters)
  ipAddrEntry:     '1.3.6.1.2.1.4.20.1',            // IP-MIB ipAddrTable
  hrProcessorLoad: '1.3.6.1.2.1.25.3.3.1.2',        // HOST-RESOURCES-MIB, one row per core
  hrStorageEntry:  '1.3.6.1.2.1.25.2.3.1',          // HOST-RESOURCES-MIB memory + disk
  mtxrGaugeEntry:  '1.3.6.1.4.1.14988.1.1.3.100.1', // RouterOS 7 health sensors
}
const HR_STORAGE_RAM  = '1.3.6.1.2.1.25.2.1.2'
const HR_STORAGE_DISK = '1.3.6.1.2.1.25.2.1.4'
const IF_STATUS = { 1: 'up', 2: 'down', 3: 'testing', 4: 'unknown', 5: 'dormant', 6: 'notPresent', 7: 'lowerLayerDown' }

// ── SNMP helpers ──────────────────────────────────────────────────────────────
function openSession(dev) {
  const s = snmp.createSession(dev.ip, dev.snmp_community, {
    port: dev.snmp_port ?? 161, version: st.versionOf(dev.snmp_version), timeout: 2000, retries: 1,
  })
  s.on('error', () => {})   // socket errors must not crash the agent
  return s
}

const snmpGet = (s, oids) => new Promise(resolve => {
  s.get(oids, (err, vb) => resolve(err ? null : vb))
})

// All varbinds under `base` (empty when the router doesn't support it)
const walk = (s, base) => new Promise(resolve => {
  const out = []
  s.subtree(base, 20,
    vbs => { for (const vb of vbs) if (!snmp.isVarbindError(vb)) out.push(vb) },
    () => resolve(out))
})

// Varbinds of a table entry → Map(rowIndex → { column: varbind })
function toRows(varbinds, entryOid) {
  const prefix = entryOid + '.'
  const rows = new Map()
  for (const vb of varbinds) {
    if (!vb.oid.startsWith(prefix)) continue
    const rest = vb.oid.slice(prefix.length)
    const dot  = rest.indexOf('.')
    if (dot < 0) continue
    const col = Number(rest.slice(0, dot))
    const idx = rest.slice(dot + 1)
    if (!rows.has(idx)) rows.set(idx, {})
    rows.get(idx)[col] = vb
  }
  return rows
}

const ok  = vb => vb && !snmp.isVarbindError(vb) && vb.value !== undefined && vb.value !== null
const str = vb => ok(vb) ? (Buffer.isBuffer(vb.value) ? vb.value.toString('utf8') : String(vb.value)).replace(/\0/g, '').trim() || null : null
// Counter64 arrives as a big-endian Buffer; everything else as a number
const big = vb => {
  if (!ok(vb)) return null
  if (Buffer.isBuffer(vb.value)) return vb.value.reduce((a, b) => (a << 8n) | BigInt(b), 0n)
  const n = Number(vb.value)
  return Number.isFinite(n) ? BigInt(Math.trunc(n)) : null
}
const num = vb => { const b = big(vb); return b === null ? null : Number(b) }
const mac = vb => ok(vb) && Buffer.isBuffer(vb.value) && vb.value.length === 6
  ? [...vb.value].map(b => b.toString(16).padStart(2, '0')).join(':').toUpperCase()
  : null
const maskToPrefix = m => m ? m.split('.').reduce((n, o) => n + (Number(o) >>> 0).toString(2).replace(/0/g, '').length, 0) : null

function fmtUptime(secs) {
  const d = Math.floor(secs / 86400), h = Math.floor((secs % 86400) / 3600), m = Math.floor((secs % 3600) / 60)
  return d > 0 ? `${d}d ${h}h ${m}m` : `${h}h ${m}m`
}

// ── State ─────────────────────────────────────────────────────────────────────
let db = null
const probed      = new Map()   // deviceId → { mikrotik: boolean, at }
const mikrotikIds = new Set()   // devices confirmed as RouterOS
const prevCounter = new Map()   // `${deviceId}:${ifIndex}` → { inO, outO, hc, ts }
const prevUptime  = new Map()   // deviceId → seconds (detects reboots)
const lastHistory = new Map()   // deviceId → ms of last traffic_samples write
const lastState   = new Map()   // deviceId → 'ok' | error text (log only on change)
let tablesMissingLogged = false

const looksMikrotik = d =>
  (d.mac && MIKROTIK_OUI.has(d.mac.replace(/[:-]/g, '').slice(0, 6).toUpperCase())) ||
  /mikrotik|routeros|routerboard/i.test(`${d.vendor ?? ''} ${d.model ?? ''} ${d.name ?? ''}`)

// ── Adapting to the network the agent is on right now ────────────────────────
// A router has several addresses (one per interface). The address stored on
// its device record is only reachable from some networks, so when it doesn't
// answer the collector also tries the router's other addresses and the
// agent's current default gateway — and accepts one only if the serial
// number proves it is the same router.

// What we already know about each router, from earlier successful polls
let knownCache = { at: 0, map: new Map() }   // deviceId → { serial, everAnswered, addresses[] }
async function knownRouters() {
  if (Date.now() - knownCache.at < 60_000) return knownCache.map
  const map = new Map()
  const [r, i] = await Promise.all([
    db.from('mikrotik_routers').select('device_id, serial, uptime_seconds'),
    db.from('mikrotik_interfaces').select('device_id, ip_addresses, mac'),
  ])
  for (const row of r.data ?? []) {
    map.set(row.device_id, { serial: row.serial ?? null, everAnswered: row.uptime_seconds !== null || !!row.serial, addresses: [], macs: new Set() })
  }
  for (const row of i.data ?? []) {
    const k = map.get(row.device_id)
    if (!k) continue
    for (const a of row.ip_addresses ?? []) k.addresses.push(String(a).split('/')[0])
    if (row.mac) k.macs.add(String(row.mac).toUpperCase())
  }
  if (!r.error) knownCache = { at: Date.now(), map }
  return map
}

// Default gateway(s) of the network(s) the agent is connected to now
let gatewayCache = { at: 0, list: [] }
async function currentGateways() {
  if (Date.now() - gatewayCache.at < 30_000) return gatewayCache.list
  let list = []
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execAsync('route print -4 0.0.0.0', { timeout: 5000, windowsHide: true })
      list = [...stdout.matchAll(/^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+([\d.]+)\s+[\d.]+\s+\d+/gm)].map(m => m[1])
    } else {
      const { stdout } = await execAsync('ip -4 route show default', { timeout: 5000 })
      list = [...stdout.matchAll(/via ([\d.]+)/g)].map(m => m[1])
    }
  } catch { /* no routing information — no extra candidates */ }
  gatewayCache = { at: Date.now(), list }
  return list
}

// Other addresses where this router might answer from the current network
async function alternateAddresses(dev, known, announced = null, recordIp = null) {
  const own = st.ownAddresses()
  // First the address the router is announcing right now, then the address on
  // its device record, its other known addresses and the gateway
  const set = new Set([...(announced ? [announced] : []), ...(recordIp ? [recordIp] : []), ...(known?.addresses ?? []), ...(await currentGateways())])
  set.delete(dev.ip)
  return [...set].filter(ip => st.IPV4.test(ip) && !own.has(ip)).slice(0, 12)
}

// This computer's adapter on the same network as `ip` (name), or null
function adapterFor(ip) {
  const toInt = a => a.split('.').reduce((n, o) => ((n << 8) | Number(o)) >>> 0, 0)
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal || !a.cidr) continue
      const prefix = Number(a.cidr.split('/')[1])
      const mask = prefix === 0 ? 0 : (0xFFFFFFFF << (32 - prefix)) >>> 0
      if (((toInt(a.address) & mask) >>> 0) === ((toInt(ip) & mask) >>> 0)) return name
    }
  }
  return null
}

// The router is announcing itself on the cable/Wi-Fi (so it is connected and
// on), yet ping and SNMP get nothing. Explain why, if the announcement shows it.
function linkLevelExplanation(seen) {
  const where = `it is announcing itself from its port ${seen.port ?? '(unknown)'} with address ${seen.ip}`
  if (st.ownAddresses().has(seen.ip)) {
    const adapter = adapterFor(seen.ip) ?? 'the adapter it is plugged into'
    return `The router is connected and powered on (${where}), but that is the same address this computer uses on ${adapter}. ` +
           `Two devices with the same address cannot exchange ping or SNMP. Change one of them: turn off Internet Connection Sharing on ${adapter} ` +
           `(or set ${adapter} to obtain its address automatically), or give the router's port a different address.`
  }
  if (!adapterFor(seen.ip)) {
    return `The router is connected and powered on (${where}), but that address is not in any network this computer is on, so ping and SNMP cannot reach it. ` +
           `Give this computer an address in the router's network (set the adapter to obtain its address automatically), or plug into a router port on a network this computer uses.`
  }
  return null
}

// mikrotik_routers.snmp_status needs supabase/migration_snmp_status.sql;
// without it the row is saved as before
let statusColumn = true
let statusRetryAt = 0
async function upsertRouter(row, status) {
  if (statusColumn || Date.now() > statusRetryAt) {
    const { error } = await db.from('mikrotik_routers').upsert({ ...row, snmp_status: status })
    if (!error) { statusColumn = true; return null }
    if (!/snmp_status/.test(error.message)) return error
    statusColumn = false
    statusRetryAt = Date.now() + 5 * 60_000
  }
  const { error } = await db.from('mikrotik_routers').upsert(row)
  return error
}

function tableError(error) {
  if (!error) return false
  if (/schema cache|does not exist|relation/i.test(error.message)) {
    if (!tablesMissingLogged) console.log('  [mikrotik] run supabase/migration_mikrotik_snmp.sql to store router details (device CPU/memory/uptime are still updated)')
    tablesMissingLogged = true
  } else {
    console.log(`  [mikrotik] write failed: ${error.message}`)
  }
  return true
}

// ── Collect one router ────────────────────────────────────────────────────────
async function collect(dev) {
  const s = openSession(dev)
  try {
    const keys = Object.keys(SCALARS)
    const vb = await snmpGet(s, Object.values(SCALARS))
    if (!vb) return null
    const v = Object.fromEntries(keys.map((k, i) => [k, vb[i]]))
    if (!(str(v.sysObjectID) ?? '').startsWith(MIKROTIK_ENTERPRISE)) return { notMikrotik: true }

    // Walk sequentially — gentler on the router's CPU than parallel walks
    const ifRows   = toRows(await walk(s, TABLES.ifEntry),        TABLES.ifEntry)
    const ifxRows  = toRows(await walk(s, TABLES.ifXEntry),       TABLES.ifXEntry)
    const ipRows   = toRows(await walk(s, TABLES.ipAddrEntry),    TABLES.ipAddrEntry)
    const cpuVbs   =        await walk(s, TABLES.hrProcessorLoad)
    const stRows   = toRows(await walk(s, TABLES.hrStorageEntry), TABLES.hrStorageEntry)
    const gauges   = toRows(await walk(s, TABLES.mtxrGaugeEntry), TABLES.mtxrGaugeEntry)

    // System
    const descr   = str(v.sysDescr)
    const board   = str(v.mtxrBoardName) ?? descr?.match(/RouterOS\s+(\S+)/i)?.[1] ?? null
    const ticks   = num(v.hrSystemUptime) ?? num(v.sysUpTime) ?? 0
    const uptime  = Math.floor(ticks / 100)
    const loads   = cpuVbs.map(num).filter(n => n !== null)
    const cpu     = loads.length ? Math.round(loads.reduce((a, b) => a + b, 0) / loads.length) : null

    let mem = null, disk = null
    for (const row of stRows.values()) {
      const type  = str(row[2]) ?? ''
      const label = str(row[3]) ?? ''
      const units = num(row[4]) ?? 1
      const entry = { total: (num(row[5]) ?? 0) * units, used: (num(row[6]) ?? 0) * units }
      if (!mem  && (type === HR_STORAGE_RAM  || /memory/i.test(label))) mem  = entry
      if (!disk && (type === HR_STORAGE_DISK || /disk/i.test(label)))   disk = entry
    }

    // Health: RouterOS 7 gauge table (unit 1 = °C, 3 = dV), RouterOS 6 scalars as fallback
    let temperature = null, voltage = null
    for (const row of gauges.values()) {
      const name = str(row[2]) ?? '', val = num(row[3]), unit = num(row[4])
      if (val === null) continue
      if (unit === 1 && (temperature === null || /cpu/i.test(name))) temperature = val
      if (unit === 3 && voltage === null) voltage = val / 10
    }
    if (temperature === null && num(v.mtxrHlTemperature) !== null) temperature = num(v.mtxrHlTemperature) / 10
    if (voltage     === null && num(v.mtxrHlVoltage)     !== null) voltage     = num(v.mtxrHlVoltage) / 10

    // Interfaces
    const now = Date.now()
    if ((prevUptime.get(dev.id) ?? 0) > uptime) {   // router rebooted: counters restarted
      for (const k of prevCounter.keys()) if (k.startsWith(`${dev.id}:`)) prevCounter.delete(k)
    }
    prevUptime.set(dev.id, uptime)

    const ips = new Map()   // ifIndex → ["ip/prefix"]
    for (const [ip, row] of ipRows) {
      const idx = num(row[2])
      if (idx === null) continue
      const prefix = maskToPrefix(str(row[3]))
      if (!ips.has(idx)) ips.set(idx, [])
      ips.get(idx).push(prefix === null ? ip : `${ip}/${prefix}`)
    }

    const interfaces = []
    for (const [key, row] of ifRows) {
      const idx = Number(key)
      const x   = ifxRows.get(key) ?? {}
      const hc  = big(x[6]) !== null && big(x[10]) !== null
      const inO  = hc ? big(x[6])  : big(row[10])
      const outO = hc ? big(x[10]) : big(row[16])
      const sum  = (...vbs) => vbs.reduce((a, b) => (big(b) === null ? a : (a ?? 0n) + big(b)), null)
      const inP  = hc ? sum(x[7], x[8], x[9])    : sum(row[11], row[12])
      const outP = hc ? sum(x[11], x[12], x[13]) : sum(row[17], row[18])

      // Live rate from the change since the last poll
      let inBps = null, outBps = null
      const ck = `${dev.id}:${idx}`
      const p  = prevCounter.get(ck)
      if (inO !== null && outO !== null) {
        if (p && p.hc === hc && now > p.ts) {
          const secs  = (now - p.ts) / 1000
          const delta = (cur, old) => cur >= old ? cur - old : (hc ? null : cur + (1n << 32n) - old)
          const dIn = delta(inO, p.inO), dOut = delta(outO, p.outO)
          if (dIn  !== null) inBps  = Math.round(Number(dIn  * 8n) / secs)
          if (dOut !== null) outBps = Math.round(Number(dOut * 8n) / secs)
        }
        prevCounter.set(ck, { inO, outO, hc, ts: now })
      }

      const highSpeed = num(x[15])
      interfaces.push({
        device_id:    dev.id,
        if_index:     idx,
        name:         str(x[1]) ?? str(row[2]) ?? `if${idx}`,
        alias:        str(x[18]),
        if_type:      num(row[3]),
        mac:          mac(row[6]),
        mtu:          num(row[4]),
        speed_mbps:   highSpeed ?? (num(row[5]) !== null ? Math.round(num(row[5]) / 1e6) : null),
        admin_status: IF_STATUS[num(row[7])] ?? null,
        oper_status:  IF_STATUS[num(row[8])] ?? null,
        ip_addresses: ips.get(idx) ?? [],
        in_bps:       inBps,
        out_bps:      outBps,
        in_octets:    inO  === null ? null : inO.toString(),
        out_octets:   outO === null ? null : outO.toString(),
        in_packets:   inP  === null ? null : inP.toString(),
        out_packets:  outP === null ? null : outP.toString(),
        in_errors:    num(row[14]),
        out_errors:   num(row[20]),
        in_discards:  num(row[13]),
        out_discards: num(row[19]),
        updated_at:   new Date(now).toISOString(),
      })
    }

    return {
      system: {
        identity: str(v.sysName), description: descr, board,
        ros_version: str(v.mtxrLicVersion) ?? descr?.match(/RouterOS\s+\S+\s+([\d.]+)/i)?.[1] ?? null,
        firmware: str(v.mtxrFirmware), serial: str(v.mtxrSerialNumber),
        sys_location: str(v.sysLocation), sys_contact: str(v.sysContact),
        uptime_seconds: uptime, cpu_load: cpu, cpu_cores: loads.length || null,
        mem_total_bytes: mem?.total ?? null, mem_used_bytes: mem?.used ?? null,
        disk_total_bytes: disk?.total ?? null, disk_used_bytes: disk?.used ?? null,
        temperature_c: temperature, voltage_v: voltage,
      },
      interfaces,
    }
  } finally {
    s.close()
  }
}

// ── Save ──────────────────────────────────────────────────────────────────────
// via: the address that answered, when it isn't the one on the device record
async function save(dev, data, via = null) {
  const ts = new Date().toISOString()
  const { system, interfaces } = data

  // devices: the fields every page already shows
  const memPct = system.mem_total_bytes ? Math.round((system.mem_used_bytes / system.mem_total_bytes) * 100) : null
  const patch = { uptime: fmtUptime(system.uptime_seconds), updated_at: ts }
  if (system.cpu_load !== null) patch.cpu = Math.max(0, Math.min(100, system.cpu_load))
  if (memPct !== null)          patch.mem = Math.max(0, Math.min(100, memPct))
  const extra = { vendor: 'MikroTik', type: 'Router' }
  if (system.board)       extra.model    = `MikroTik ${system.board}`
  if (system.ros_version) extra.firmware = `RouterOS ${system.ros_version}`
  // Auto-generated names ("Device 192.168.1.15") become the router's identity
  if (system.identity && /^(Device|Gateway) \d+\.\d+\.\d+\.\d+$|^MikroTik [0-9A-F]{4}$/i.test(dev.name)) {
    extra.name = system.identity
  }
  let { error } = await db.from('devices').update({ ...patch, ...extra }).eq('id', dev.id)
  if (error?.code === '23505' && extra.name) {   // identity already used by another device
    extra.name = `${system.identity} (${dev.ip})`
    ;({ error } = await db.from('devices').update({ ...patch, ...extra }).eq('id', dev.id))
  }
  let renamed = !error && !!extra.name
  if (error) {   // older schema without vendor/model/firmware: save the basics
    ;({ error } = await db.from('devices').update(patch).eq('id', dev.id))
    renamed = false
  }
  if (error) console.log(`  [mikrotik] device update failed: ${error.message}`)
  if (renamed) dev.name = extra.name
  const name = dev.name

  // Live router + interface view
  const routerError = await upsertRouter({
    device_id: dev.id, device_name: name, ip: via ?? dev.ip, ...system,
    reachable: true, last_error: null, polled_at: ts,
  }, 'responding')
  await st.writeDeviceStatus(db, dev.id, 'responding', via
    ? `Answering SNMP at ${via}. The address on the device record (${dev.ip}) is not reachable from the agent's current network.`
    : `Answering SNMP at ${dev.ip}.`)
  if (!tableError(routerError)) {
    if (interfaces.length) {
      const { error: e } = await db.from('mikrotik_interfaces').upsert(interfaces)
      tableError(e)
      // Drop interfaces removed from the router
      await db.from('mikrotik_interfaces').delete().eq('device_id', dev.id)
        .not('if_index', 'in', `(${interfaces.map(i => i.if_index).join(',')})`)
    }
  }

  // History for the Traffic page (once a minute)
  if (Date.now() - (lastHistory.get(dev.id) ?? 0) >= HISTORY_MS) {
    const rows = interfaces
      .filter(i => i.oper_status === 'up' && i.if_type !== 24 && i.in_bps !== null && i.out_bps !== null)
      .map(i => ({
        device_name: name, interface: i.name,
        in_mbps: +(i.in_bps / 1e6).toFixed(3), out_mbps: +(i.out_bps / 1e6).toFixed(3), sampled_at: ts,
      }))
    if (rows.length) {
      const { error: e } = await db.from('traffic_samples').insert(rows)
      if (e) console.log(`  [mikrotik] traffic history write failed: ${e.message}`)
      else lastHistory.set(dev.id, Date.now())
    }
    const up = interfaces.filter(i => i.oper_status === 'up').length
    console.log(`  [mikrotik] ${name} ${via ? `${via} (instead of ${dev.ip})` : dev.ip}: ${system.board ?? 'RouterOS'} ${system.ros_version ?? ''} · cpu ${system.cpu_load ?? '—'}% · mem ${memPct ?? '—'}% · ${interfaces.length} interfaces (${up} up)`)
  }
}

// status: unreachable | disabled | auth_failed | timeout (see snmp-status.js)
async function saveNoAnswer(dev, status, message) {
  if (lastState.get(dev.id) !== message) {
    console.log(`  [mikrotik] ${dev.name} — ${st.LABEL[status]}: ${message}`)
    lastState.set(dev.id, message)
  }
  tableError(await upsertRouter({
    device_id: dev.id, device_name: dev.name, ip: dev.ip,
    reachable: false, last_error: message, polled_at: new Date().toISOString(),
  }, status))
  await st.writeDeviceStatus(db, dev.id, status, message)
}

// ── One round ─────────────────────────────────────────────────────────────────
async function round() {
  const { data: devices, error } = await db.from('devices').select('*')
  if (error || !devices) return

  const now = Date.now()
  const candidates = devices.filter(d =>
    d.snmp_community && d.status !== 'maint' &&
    (mikrotikIds.has(d.id) || looksMikrotik(d) || (d.source && d.source !== 'discovered')))

  // Forget devices that were deleted
  const present = new Set(devices.map(d => d.id))
  for (const id of mikrotikIds) if (!present.has(id)) mikrotikIds.delete(id)

  // Routers identified in earlier runs stay known across agent restarts
  const known = await knownRouters()
  for (const d of candidates) if (known.get(d.id)?.everAnswered) mikrotikIds.add(d.id)

  await Promise.all(candidates.map(async rec => {
    const p = probed.get(rec.id)
    if (!mikrotikIds.has(rec.id) && p && now - p.at < (p.answered ? RECHECK_OTHER_MS : RECHECK_NO_ANSWER_MS)) return

    // The address SNMP is sent to: the reachable address configured for this
    // device (e.g. its address over a VPN or on another subnet), otherwise
    // the address on the device record. Nothing here is tied to one network.
    const host = st.IPV4.test(rec.snmp_host ?? '') ? rec.snmp_host : rec.ip
    const dev  = host === rec.ip ? rec : { ...rec, ip: host }

    const community = dev.snmp_community
    const port      = dev.snmp_port ?? 161
    const ver       = st.versionOf(dev.snmp_version)
    const k         = known.get(dev.id)
    // Is this router announcing itself on a network the agent is attached to right now?
    const seen      = k?.macs.size ? mndp.find(k.macs) : null

    // 1. Is the device reachable from the network the agent is on now?
    //    A ping reply — or, for devices that block ping, one quick SNMP reply.
    //    Only then is the full SNMP collection attempted.
    let reachableAt = (await st.ping(dev.ip, 1)) || (await st.quickGet(dev.ip, community, port, undefined, ver)) ? dev.ip : null
    let data = null
    let via  = null
    let otherDevice = null   // MAC of a different device using the router's address on this network
    try {
      if (reachableAt) data = await collect(dev)

      // Something answered ping at that address but not SNMP. On another
      // network the same address can belong to a different device — if its
      // MAC is not one of this router's, the router itself is not reachable.
      if (reachableAt && !data && k?.macs.size) {
        const mac = await st.neighborMac(dev.ip)
        if (mac && !k.macs.has(mac)) { otherDevice = mac; reachableAt = null }
      }

      // 2. Not answering there: the same router at one of its other addresses
      //    (or the current gateway), proven by its serial number
      if (!data && k?.serial) {
        const alts = await alternateAddresses(dev, k, seen?.ip, rec.ip)
        const found = await Promise.all(alts.map(async ip => {
          const vb = await st.quickGet(ip, community, port, [SCALARS.mtxrSerialNumber], ver)
          return vb && str(vb[0]) === k.serial ? ip : null
        }))
        const alt = found.find(Boolean)
        if (alt) {
          reachableAt ??= alt
          const viaAlt = await collect({ ...dev, ip: alt })
          if (viaAlt && !viaAlt.notMikrotik) { data = viaAlt; via = alt }
        } else if (!reachableAt) {
          // No SNMP anywhere — is the router at least reachable at another
          // address? A ping reply alone proves nothing about WHICH device
          // answered (any gateway pings), so it only counts when the
          // address's MAC is one of this router's own interface MACs.
          const hits = await Promise.all(alts.map(async ip => {
            if (!(await st.ping(ip, 1))) return null
            const mac = await st.neighborMac(ip)
            return mac && k.macs.has(mac) ? ip : null
          }))
          reachableAt = hits.find(Boolean) ?? null
        }
      }
    } catch (e) { data = null; console.log(`  [mikrotik] ${dev.ip}: ${e.message}`) }

    if (!data) {
      probed.set(dev.id, { answered: false, at: now })
      const everAnswered = mikrotikIds.has(dev.id)
      // Report it on the dashboard only when it really is a MikroTik
      if (!everAnswered && !looksMikrotik(dev)) return
      // Unreachable, SNMP disabled, access refused or timeout — never
      // "disabled" just because there is no path from this network
      const diag = await st.diagnoseNoAnswer({ ip: reachableAt ?? dev.ip, port, community, reachable: !!reachableAt, everAnswered })
      if (otherDevice) {
        diag.detail = `${dev.ip} is being used by a different device (${otherDevice}) on the network the agent is on now, so the router itself cannot be reached from here. ` +
                      `This says nothing about whether SNMP is enabled on the router.`
      }
      // Connected at link level but no IP path (address clash / different subnet)
      const why = seen && !reachableAt ? linkLevelExplanation(seen) : null
      if (why) { diag.status = 'unreachable'; diag.detail = why }
      await saveNoAnswer(dev, diag.status, diag.detail)
      return
    }
    if (data.notMikrotik) {
      probed.set(dev.id, { answered: true, at: now })
      mikrotikIds.delete(dev.id)
      return
    }
    mikrotikIds.add(dev.id)
    probed.set(dev.id, { answered: true, at: now })
    const state = `ok ${via ?? dev.ip}`
    if (lastState.get(dev.id) !== state) {
      console.log(via
        ? `  [mikrotik] ${dev.name}: ${dev.ip} is not reachable from this network — connected at ${via} instead (same router, serial ${k.serial})`
        : `  [mikrotik] connected to ${dev.ip} over SNMP (${data.system.description ?? 'RouterOS'})`)
      lastState.set(dev.id, state)
    }
    await save(dev, data, via)
  }))
}

// ── Public API ────────────────────────────────────────────────────────────────
// isActive: () => boolean — false while this agent is standing by for another one
function start(supabase, isActive = () => true) {
  db = supabase
  mndp.start()
  const loop = async () => {
    const started = Date.now()
    try { if (isActive()) await round() } catch (e) { console.log(`  [mikrotik] round failed: ${e.message}`) }
    setTimeout(loop, Math.max(1000, POLL_MS - (Date.now() - started)))
  }
  loop()
}

// Devices this collector owns, so the generic SNMP poll leaves them alone
async function managedIds(supabase) {
  const ids = new Set(mikrotikIds)
  const { data } = await supabase.from('mikrotik_routers').select('device_id')
  for (const r of data ?? []) ids.add(r.device_id)
  return ids
}

module.exports = { start, managedIds, POLL_MS }
