// SNMP status diagnosis (server only) — the dashboard-side twin of
// poller/snmp-status.js, used by lib/device-probe.ts when the dashboard
// itself runs on the LAN. Same five states, same rules:
//   responding   the device answered SNMP
//   unreachable  no path to the device from this server's current network
//   disabled     reachable, and it refused UDP 161 (nothing is listening)
//   auth_failed  reachable, SNMP answered before, now silent (access refused)
//   timeout      reachable, no reply and no refusal
import os from 'os'
import dgram from 'dgram'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/

export type SnmpStatus = 'responding' | 'unreachable' | 'disabled' | 'auth_failed' | 'timeout'

// The local address the OS would use to reach `ip` (follows the routing table). No packet is sent.
function sourceAddressFor(ip: string): Promise<string | null> {
  return new Promise(resolve => {
    const s = dgram.createSocket('udp4')
    const done = (v: string | null) => { try { s.close() } catch { /* already closed */ } resolve(v) }
    s.once('error', () => done(null))
    try { s.connect(9, ip, () => { try { done(s.address().address) } catch { done(null) } }) }
    catch { done(null) }
  })
}

async function serverLocation(ip: string) {
  const src = await sourceAddressFor(ip)
  if (!src || src === '0.0.0.0') return 'this server has no network connection'
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if ((list ?? []).some(a => a.family === 'IPv4' && a.address === src)) return `this server is at ${src} on ${name}`
  }
  return `this server is at ${src}`
}

function ownAddresses() {
  const out = new Set<string>()
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4') out.add(a.address)
  }
  return out
}

// 'closed' = the device refused the port (ICMP port unreachable), 'reply' =
// something answered, 'silent' = neither. Node hides the refusal on Windows,
// so .NET is used there.
async function udpPortState(ip: string, port: number): Promise<'closed' | 'reply' | 'silent'> {
  if (!IPV4.test(ip) || !Number.isInteger(port) || port < 1 || port > 65535 || ownAddresses().has(ip)) return 'silent'
  try {
    if (process.platform === 'win32') {
      const script =
        `$u = New-Object System.Net.Sockets.UdpClient; try { $u.Client.ReceiveTimeout = 1500; $u.Connect('${ip}', ${port}); ` +
        `[void]$u.Send([byte[]](0x30, 0x00), 2); $ep = New-Object System.Net.IPEndPoint([System.Net.IPAddress]::Any, 0); ` +
        `[void]$u.Receive([ref]$ep); 'reply' } catch [System.Net.Sockets.SocketException] { ` +
        `if ($_.Exception.SocketErrorCode -eq 'ConnectionReset') { 'closed' } else { 'silent' } } catch { 'silent' } finally { $u.Close() }`
      const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', script], { timeout: 10_000, windowsHide: true })
      const out = stdout.trim()
      return out === 'closed' || out === 'reply' ? out : 'silent'
    }
    return await new Promise(resolve => {
      const s = dgram.createSocket('udp4')
      const done = (v: 'closed' | 'reply' | 'silent') => { clearTimeout(t); try { s.close() } catch { /* already closed */ } resolve(v) }
      const t = setTimeout(() => done('silent'), 1500)
      s.once('error', (e: NodeJS.ErrnoException) => done(e.code === 'ECONNREFUSED' ? 'closed' : 'silent'))
      s.once('message', () => done('reply'))
      try { s.connect(port, ip, () => s.send(Buffer.from([0x30, 0x00]), err => { if (err) done('silent') })) }
      catch { done('silent') }
    })
  } catch {
    return 'silent'
  }
}

// For a device that did not answer SNMP
export async function diagnoseNoAnswer(o: {
  ip: string; port?: number; community?: string | null; reachable: boolean; everAnswered?: boolean
}): Promise<{ status: SnmpStatus; detail: string }> {
  const port = o.port ?? 161
  const where = await serverLocation(o.ip)
  const community = o.community ? ` "${o.community}"` : ''

  if (!o.reachable) {
    return {
      status: 'unreachable',
      detail: `${o.ip} cannot be reached from the current network (${where}) — it does not answer. ` +
              `The device is off, or it is on a network there is no route to. This says nothing about whether SNMP is enabled on it.`,
    }
  }
  if (await udpPortState(o.ip, port) === 'closed') {
    return {
      status: 'disabled',
      detail: `${o.ip} is reachable but refused UDP port ${port} — the SNMP service is not running on it. Enable SNMP on the device.`,
    }
  }
  if (o.everAnswered) {
    return {
      status: 'auth_failed',
      detail: `${o.ip} is reachable and SNMP answered before, but it now ignores this server (${where}). ` +
              `The device is refusing access: check that the community${community} is still correct and that this address is in the device's allowed SNMP addresses.`,
    }
  }
  return {
    status: 'timeout',
    detail: `${o.ip} is reachable but did not answer SNMP on UDP ${port} and did not refuse it (${where}). ` +
            `Either the community${community} is wrong, this address is not allowed by the device, a firewall is dropping UDP ${port}, or SNMP is not enabled.`,
  }
}
