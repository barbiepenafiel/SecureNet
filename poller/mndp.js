/**
 * MikroTik Neighbor Discovery listener (used by mikrotik.js).
 *
 * Every MikroTik router announces itself about once a minute with a
 * broadcast on UDP 5678 (the same thing WinBox's "Neighbors" list uses).
 * The announcement works at the link level — it arrives even when the
 * router's IP address is in a different subnet than this computer, or
 * clashes with it. It tells the agent, on whatever network it is on now:
 *   • that the router is connected and powered on
 *   • the address and port (interface) it is announcing from
 * Listening only; nothing is changed on the router.
 */

const os    = require('os')
const dgram = require('dgram')

const PORT        = 5678
const REFRESH_MS  = 30_000     // ask neighbours to announce (they also do it on their own every 60 s)
const FRESH_MS    = 150_000    // an announcement older than this no longer counts
const TLV = { 1: 'mac', 5: 'identity', 7: 'version', 8: 'platform', 12: 'board', 16: 'port', 17: 'ip' }

const neighbors = new Map()    // MAC → { mac, ip, identity, board, version, port, at }
let socket = null

function parse(buf) {
  const out = {}
  for (let o = 4; o + 4 <= buf.length;) {
    const type = buf.readUInt16BE(o), len = buf.readUInt16BE(o + 2)
    const v = buf.subarray(o + 4, o + 4 + len)
    const name = TLV[type]
    if (name === 'mac' && len === 6)     out.mac = [...v].map(b => b.toString(16).padStart(2, '0')).join(':').toUpperCase()
    else if (name === 'ip' && len === 4) out.ip = [...v].join('.')
    else if (name && name !== 'mac' && name !== 'ip') out[name] = v.toString('utf8')
    o += 4 + len
  }
  return out.mac ? out : null
}

// Broadcast address of every network this computer is attached to
function broadcastAddresses() {
  const out = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal || !a.netmask) continue
      const ip = a.address.split('.').map(Number), mask = a.netmask.split('.').map(Number)
      out.push(ip.map((b, i) => (b | (~mask[i] & 255))).join('.'))
    }
  }
  return out
}

function start() {
  if (socket) return
  try {
    socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    socket.on('message', buf => {
      const n = parse(buf)
      if (n) neighbors.set(n.mac, { ...n, at: Date.now() })
    })
    // Port busy (e.g. WinBox is open) or blocked: discovery is simply unavailable
    socket.on('error', () => { try { socket.close() } catch {} socket = null })
    socket.bind(PORT, '0.0.0.0', () => {
      try { socket.setBroadcast(true) } catch {}
      const ask = () => { for (const b of broadcastAddresses()) { try { socket?.send(Buffer.alloc(4), PORT, b) } catch {} } }
      ask()
      setInterval(ask, REFRESH_MS).unref()
    })
  } catch {
    socket = null
  }
}

// A router currently announcing itself with one of these MAC addresses
function find(macs) {
  const now = Date.now()
  for (const n of neighbors.values()) {
    if (now - n.at < FRESH_MS && macs.has(n.mac)) return n
  }
  return null
}

module.exports = { start, find }
