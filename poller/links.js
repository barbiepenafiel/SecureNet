/**
 * Topology links: which device each device is connected to (devices.parent_id).
 *
 * Learned only from what the network reports — nothing is guessed from
 * IP numbering:
 *   'snmp'    — a MikroTik router's own tables, read over SNMP (read-only):
 *                 bridge forwarding table  MAC → bridge port → ifName  (e.g. ether2)
 *                 ARP table                IP/MAC → interface           (e.g. bridge1)
 *                 default route            next hop = the router's own upstream
 *   'gateway' — the device answered on the agent's own network, so it is on
 *               the same segment as that network's default gateway
 *   'manual'  — set by an admin in Settings → Manage; never changed here
 *
 * A link is kept when the device is not seen (an offline device is still
 * plugged in where it was); it is changed only by newer evidence.
 * Needs supabase/migration_objectives.sql (parent_* columns).
 */

const snmp = require('net-snmp')

const OID = {
  ifName:        '1.3.6.1.2.1.31.1.1.1.1',
  ifDescr:       '1.3.6.1.2.1.2.2.1.2',
  arpPhys:       '1.3.6.1.2.1.4.22.1.2',      // ipNetToMediaPhysAddress.<ifIndex>.<ip>
  fdbPort:       '1.3.6.1.2.1.17.4.3.1.2',    // dot1dTpFdbPort.<mac>
  fdbStatus:     '1.3.6.1.2.1.17.4.3.1.3',    // 3 = learned, 4 = self
  bridgeIfIndex: '1.3.6.1.2.1.17.1.4.1.2',    // dot1dBasePortIfIndex.<port>
  routeNextHop:  '1.3.6.1.2.1.4.21.1.7.0.0.0.0',
  routeIfIndex:  '1.3.6.1.2.1.4.21.1.2.0.0.0.0',
}

const RUN_EVERY_MS = 60_000
let lastRun = 0
let columnsOk = true
let retryAt = 0

const macOf = buf => [...buf].map(b => b.toString(16).padStart(2, '0')).join(':').toUpperCase()

function session(host, community, port) {
  return snmp.createSession(host, community, { port, version: snmp.Version2c, timeout: 3000, retries: 1 })
}
function walk(s, oid) {
  return new Promise(resolve => {
    const out = []
    s.subtree(oid, 40, vbs => { for (const v of vbs) if (!snmp.isVarbindError(v)) out.push(v) }, err => resolve(err ? null : out))
  })
}
function get(s, oids) {
  return new Promise(resolve => s.get(oids, (err, vbs) => resolve(err ? null : vbs)))
}
const suffix = (oid, base) => oid.slice(base.length + 1).split('.').map(Number)

// What one router knows about its neighbours
async function readRouter(host, community, port) {
  const s = session(host, community, port)
  try {
    const names = await walk(s, OID.ifName)
    if (!names) return null                                   // not answering SNMP from here
    const ifName = new Map(names.map(v => [suffix(v.oid, OID.ifName)[0], v.value.toString()]))
    const [arp, fdb, fdbSt, bridge, route] = await Promise.all([
      walk(s, OID.arpPhys), walk(s, OID.fdbPort), walk(s, OID.fdbStatus), walk(s, OID.bridgeIfIndex),
      get(s, [OID.routeNextHop, OID.routeIfIndex]),
    ])
    const portIf = new Map((bridge ?? []).map(v => [suffix(v.oid, OID.bridgeIfIndex)[0], Number(v.value)]))
    const self = new Set((fdbSt ?? []).filter(v => Number(v.value) === 4).map(v => suffix(v.oid, OID.fdbStatus).join('.')))

    // MAC → physical port (bridge forwarding table, learned entries only)
    const macPort = new Map()
    for (const v of fdb ?? []) {
      const key = suffix(v.oid, OID.fdbPort)
      if (self.has(key.join('.')) || Number(v.value) === 0) continue
      const ifIndex = portIf.get(Number(v.value))
      const name = ifIndex != null ? ifName.get(ifIndex) : null
      if (name) macPort.set(macOf(Buffer.from(key)), name)
    }
    // IP/MAC → interface (ARP)
    const arpRows = []
    for (const v of arp ?? []) {
      const [ifIndex, ...ip] = suffix(v.oid, OID.arpPhys)
      if (!Buffer.isBuffer(v.value) || v.value.length !== 6) continue
      arpRows.push({ ifIndex, ip: ip.join('.'), mac: macOf(v.value) })
    }
    const nextHop = route && !snmp.isVarbindError(route[0]) ? String(route[0].value) : null
    const upIf = route && !snmp.isVarbindError(route[1]) ? Number(route[1].value) : null
    return { ifName, macPort, arpRows, nextHop: nextHop && nextHop !== '0.0.0.0' ? nextHop : null, upIf }
  } finally {
    try { s.close() } catch {}
  }
}

// Would linking child → parent create a loop?
function makesLoop(childId, parentId, parentOf) {
  const seen = new Set([childId])
  for (let p = parentId; p; p = parentOf.get(p)) {
    if (seen.has(p)) return true
    seen.add(p)
  }
  return false
}

/**
 * net: the agent's network this round ({ selfIp, gateway, cidr }), liveIps:
 * addresses that answered ICMP/ARP on it this round, neighbors: IP → MAC.
 */
async function update(db, net, liveIps, neighbors) {
  if (Date.now() - lastRun < RUN_EVERY_MS) return
  if (!columnsOk && Date.now() < retryAt) return
  lastRun = Date.now()

  const [{ data: devs, error }, { data: routers }] = await Promise.all([
    db.from('devices').select('id, name, ip, mac, type, status, snmp_community, snmp_port, parent_id, parent_port, parent_source'),
    db.from('mikrotik_routers').select('device_id, ip').then(r => r, () => ({ data: null })),
  ])
  if (error) {
    if (/parent_|column|schema cache/i.test(error.message)) {
      if (columnsOk) console.log('  [links] run supabase/migration_objectives.sql to store topology links (retrying every 5 min)')
      columnsOk = false
      retryAt = Date.now() + 5 * 60_000
    }
    return
  }
  columnsOk = true

  const byMac = new Map(devs.filter(d => d.mac).map(d => [d.mac.toUpperCase(), d]))
  const byIp = new Map()
  for (const d of devs) if (!byIp.has(d.ip)) byIp.set(d.ip, d)
  const byId = new Map(devs.map(d => [d.id, d]))
  const find = (ip, mac) => (mac && byMac.get(mac)) || (ip && byIp.get(ip)) || null

  const proposed = new Map()   // child id → { parentId, port, source, rank }
  const propose = (child, parent, port, source, rank) => {
    if (!child || !parent || child.id === parent.id) return
    if (child.parent_source === 'manual') return
    const cur = proposed.get(child.id)
    if (cur && cur.rank >= rank) return
    proposed.set(child.id, { parentId: parent.id, port: port ?? null, source, rank })
  }

  // ── Same segment as the agent's default gateway ───────────────────────────
  const gwMac = net?.gateway ? neighbors.get(net.gateway) : null
  const gateway = net?.gateway ? find(net.gateway, gwMac) : null
  if (gateway) {
    for (const ip of liveIps) {
      if (ip === net.gateway) continue
      propose(find(ip, neighbors.get(ip) ?? null), gateway, null, 'gateway', 1)
    }
  }

  // ── Routers' own tables ───────────────────────────────────────────────────
  for (const r of routers ?? []) {
    const dev = byId.get(r.device_id)
    if (!dev?.snmp_community) continue
    const hosts = [...new Set([r.ip, dev.ip].filter(Boolean))]
    let info = null
    for (const h of hosts) if ((info = await readRouter(h, dev.snmp_community, dev.snmp_port ?? 161).catch(() => null))) break
    if (!info) continue

    // The router's upstream (where its default route points)
    const up = info.nextHop ? byIp.get(info.nextHop) : null
    if (up) propose(dev, up, null, 'snmp', 3)

    // Devices on a physical port (most precise)
    for (const [mac, port] of info.macPort) {
      if (info.upIf != null && port === info.ifName.get(info.upIf)) continue
      propose(byMac.get(mac), dev, port, 'snmp', 3)
    }
    // Devices the router reaches on its other interfaces
    for (const a of info.arpRows) {
      if (a.ifIndex === info.upIf) continue                    // that side is upstream, not behind it
      propose(find(a.ip, a.mac), dev, info.ifName.get(a.ifIndex) ?? null, 'snmp', 2)
    }
    console.log(`  [links] ${dev.name}: ${info.macPort.size} port entries, ${info.arpRows.length} ARP entries${up ? `, upstream ${up.name}` : ''}`)
  }

  // ── Write changes (no loops) ──────────────────────────────────────────────
  const parentOf = new Map(devs.map(d => [d.id, d.parent_id]))
  for (const [id, p] of proposed) parentOf.set(id, p.parentId)
  let changed = 0
  for (const [id, p] of proposed) {
    const d = byId.get(id)
    if (makesLoop(id, p.parentId, new Map([...parentOf].filter(([k]) => k !== id)))) { parentOf.set(id, d.parent_id); continue }
    if (d.parent_id === p.parentId && (d.parent_port ?? null) === p.port && d.parent_source === p.source) continue
    const { error: e } = await db.from('devices').update({
      parent_id: p.parentId, parent_port: p.port, parent_source: p.source, parent_updated_at: new Date().toISOString(),
    }).eq('id', id).or('parent_source.is.null,parent_source.neq.manual')   // never overwrite an admin's link
    if (!e) changed++
  }
  if (changed) console.log(`  [links] ${changed} link(s) updated`)
}

module.exports = { update, readRouter }
