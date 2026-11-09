import { NextRequest, NextResponse } from 'next/server'
import { exec } from 'child_process'
import { promisify } from 'util'
import { createClient } from '@supabase/supabase-js'
import type { ScanResult } from '@/lib/database.types'
import { lookupOui } from '@/lib/oui'

export const runtime = 'nodejs'

const execAsync = promisify(exec)
const BATCH      = 30
const PING_MS    = 400

type ScanRow = Omit<ScanResult, 'id' | 'scanned_at'> & { scanned_at: string }

// In-memory fallback if scan_results table hasn't been created yet
let _memCache: ScanRow[] = []

function adminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  )
}

// Virtual adapter name keywords to skip (matched against adapter header line)
const VIRTUAL_KEYWORDS = ['virtualbox', 'vmware', 'vmnet', 'hyper-v', 'wsl', 'loopback', 'bluetooth', 'teredo', 'isatap', 'tunnel', 'pseudo', 'tap', 'miniport', 'virtual']

// Known virtual IP ranges — always skip regardless of adapter name
const VIRTUAL_PREFIXES = [
  '127.',      // loopback
  '169.254.',  // link-local (APIPA)
  '192.168.56.', // VirtualBox host-only (always this range)
  '192.168.99.', // Docker toolbox
]

// Detect all physical subnets line-by-line (block split is fragile on Windows)
async function detectSubnets(): Promise<string[]> {
  const subnets: string[] = []
  try {
    const { stdout } = await execAsync('ipconfig', { timeout: 5000 })
    let adapterName = ''
    for (const rawLine of stdout.split(/\r?\n/)) {
      const line = rawLine.trimEnd()
      // Adapter header: starts at column 0, ends with ":"
      if (/^\S.*:\s*$/.test(line)) {
        adapterName = line.toLowerCase()
        continue
      }
      // Skip if adapter name contains a virtual keyword
      if (VIRTUAL_KEYWORDS.some(k => adapterName.includes(k))) continue
      // Extract IPv4 address
      const ipMatch = line.match(/IPv4 Address[.\s]+:\s*([\d.]+)/i)
      if (!ipMatch) continue
      const ip = ipMatch[1].trim()
      // Skip virtual IP ranges
      if (VIRTUAL_PREFIXES.some(p => ip.startsWith(p))) continue
      const parts = ip.split('.')
      if (parts.length !== 4) continue
      const sub = `${parts[0]}.${parts[1]}.${parts[2]}`
      if (!subnets.includes(sub)) subnets.push(sub)
    }
  } catch {}
  return subnets
}

async function detectSubnet(): Promise<string | null> {
  const subs = await detectSubnets()
  return subs[0] ?? null
}

async function getArpTable(): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  try {
    const { stdout } = await execAsync('arp -a', { timeout: 5000 })
    for (const line of stdout.split('\n')) {
      const m = line.match(
        /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\s+((?:[\da-fA-F]{2}[-:]){5}[\da-fA-F]{2})\b/
      )
      if (m) map.set(m[1], m[2].replace(/-/g, ':').toUpperCase())
    }
  } catch {}
  return map
}

async function pingHost(ip: string): Promise<{ responded: boolean; latency_ms: number | null }> {
  try {
    const { stdout } = await execAsync(`ping -n 1 -w ${PING_MS} ${ip}`, {
      timeout: PING_MS + 600,
    })
    const responded = stdout.includes('Reply from') || /TTL=/i.test(stdout)
    const m = stdout.match(/Average\s*=\s*(\d+)ms/) ?? stdout.match(/time[<=](\d+)ms/)
    return { responded, latency_ms: m ? parseInt(m[1]) : responded ? 1 : null }
  } catch {
    return { responded: false, latency_ms: null }
  }
}

export async function GET() {
  const detectedSubnets = await detectSubnets()
  const detectedSubnet  = detectedSubnets[0] ?? null

  // Try Supabase first, fall back to in-memory
  try {
    const sb = adminClient()
    const { data, error } = await sb
      .from('scan_results')
      .select('*')
      .order('responded', { ascending: false })
      .order('latency_ms', { ascending: true, nullsFirst: false })
      .limit(500)
    if (!error && data) {
      return NextResponse.json({ results: data, scanned_at: data[0]?.scanned_at ?? null, detected_subnet: detectedSubnet, detected_subnets: detectedSubnets })
    }
  } catch {}

  return NextResponse.json({ results: _memCache, scanned_at: _memCache[0]?.scanned_at ?? null, detected_subnet: detectedSubnet, detected_subnets: detectedSubnets })
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))

  // Build list of subnets to scan
  const detected = await detectSubnets()
  let subnetsToScan: string[]
  if (body.subnet) {
    const raw: string = body.subnet
    const p = raw.split('.')
    const normalized = p.length >= 4 ? p.slice(0, 3).join('.') : raw
    // If the requested subnet is virtual, ignore it and use detected
    const isVirtual = VIRTUAL_PREFIXES.some(vp => `${normalized}.`.startsWith(vp))
    subnetsToScan = isVirtual
      ? (detected.length ? detected : ['192.168.1'])
      : [normalized]
  } else {
    subnetsToScan = detected.length ? detected : ['192.168.1']
  }
  const subnet = subnetsToScan[0] // primary (used for upstream detection)

  // 1. ARP table (instant — reads OS cache)
  const arpTable = await getArpTable()

  // 2. ICMP ping scan across ALL detected subnets
  const allIps: string[] = []
  for (const sub of subnetsToScan) {
    for (let i = 1; i <= 254; i++) allIps.push(`${sub}.${i}`)
  }
  const icmpMap = new Map<string, { responded: boolean; latency_ms: number | null }>()

  for (let i = 0; i < allIps.length; i += BATCH) {
    const batch = allIps.slice(i, i + BATCH)
    const res = await Promise.all(batch.map(async ip => ({ ip, ...(await pingHost(ip)) })))
    for (const r of res) icmpMap.set(r.ip, { responded: r.responded, latency_ms: r.latency_ms })
  }

  // 3. Merge: only keep IPs that showed up in ICMP or ARP
  const scanned_at = new Date().toISOString()
  const rows: ScanRow[] = []

  for (const ip of allIps) {
    const inArp = arpTable.has(ip)
    const icmp  = icmpMap.get(ip)!
    if (!icmp.responded && !inArp) continue

    const scan_type: ScanResult['scan_type'] =
      icmp.responded && inArp ? 'both' : inArp ? 'arp' : 'icmp'

    const mac = arpTable.get(ip) ?? null
    const oui = lookupOui(mac, ip)

    rows.push({
      ip,
      mac,
      hostname:    null,
      vendor:      oui.vendor !== 'Unknown' ? oui.vendor : null,
      device_type: oui.device_type !== 'Unknown' ? oui.device_type : null,
      scan_type,
      responded:   icmp.responded,
      latency_ms:  icmp.latency_ms,
      scanned_at,
    })
  }

  // 3b. Auto-discover upstream router (one subnet below, e.g. 192.168.0.1 when scanning 192.168.1)
  const subParts = subnet.split('.')
  const thirdOctet = parseInt(subParts[2] ?? '1', 10)
  if (thirdOctet > 0) {
    const upstreamGw = `${subParts[0]}.${subParts[1]}.${thirdOctet - 1}.1`
    // Skip if already found in main scan
    if (!rows.find(r => r.ip === upstreamGw)) {
      const upPing = await pingHost(upstreamGw)
      if (upPing.responded) {
        const upMac = arpTable.get(upstreamGw) ?? null
        const upOui = lookupOui(upMac, upstreamGw)
        rows.unshift({
          ip:          upstreamGw,
          mac:         upMac,
          hostname:    null,
          vendor:      upOui.vendor !== 'Unknown' ? upOui.vendor : 'Upstream Router',
          device_type: 'Router',
          scan_type:   'icmp',
          responded:   true,
          latency_ms:  upPing.latency_ms,
          scanned_at,
        })
      }
    }
  }

  // 4. Persist — keep 30 days of history, do NOT wipe all records
  _memCache = rows
  try {
    const sb = adminClient()
    const { error: checkErr } = await sb.from('scan_results').select('id').limit(1)
    if (!checkErr) {
      // Delete records older than 30 days (retain historical latency data)
      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
      await sb.from('scan_results').delete().lt('scanned_at', cutoff)
      if (rows.length > 0) await sb.from('scan_results').insert(rows)
    }
  } catch {}

  return NextResponse.json({
    results: rows,
    scanned_at,
    stats: {
      total: rows.length,
      icmp:  rows.filter(r => r.responded).length,
      arp:   rows.filter(r => r.mac !== null).length,
    },
  })
}
