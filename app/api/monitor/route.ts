import { exec } from 'child_process'
import { promisify } from 'util'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'

const execAsync = promisify(exec)

// Managed device tracking
const failStreak    = new Map<string, number>()
const alertedIPs    = new Set<string>()

// Discovered device tracking (from scan_results)
const discStreak    = new Map<string, number>()
const discAlerted   = new Set<string>()

const FAIL_THRESHOLD = 1   // mark down after 1 failed ping (demo mode)

function adminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  )
}

async function pingOnce(ip: string): Promise<boolean> {
  try {
    const { stdout } = await execAsync(`ping -n 1 -w 1000 ${ip}`, { timeout: 2500 })
    return /Reply from/i.test(stdout) || /TTL=/i.test(stdout)
  } catch {
    return false
  }
}

export async function POST() {
  const db  = adminClient()
  const now = new Date().toISOString()

  // ── 1. Ping managed devices ───────────────────────────────────────────────
  const { data: devices } = await db
    .from('devices')
    .select('id, name, ip, status, location')
    .neq('status', 'maint')

  const managedResults = await Promise.all((devices ?? []).map(async (dev) => {
    const up = await pingOnce(dev.ip)

    if (up) {
      const prevStreak = failStreak.get(dev.id) ?? 0
      failStreak.set(dev.id, 0)

      if (dev.status === 'down') {
        await Promise.all([
          db.from('devices').update({ status: 'up' }).eq('id', dev.id),
          db.from('alerts')
            .update({ suppressed: true })
            .ilike('meta', `%IP: ${dev.ip}%`)
            .not('meta', 'ilike', '%[Discovered]%')
            .eq('suppressed', false),
        ])
        db.from('status_events').insert({ device_id: dev.id, device_name: dev.name, device_ip: dev.ip, old_status: 'down', new_status: 'up' })
          .then(() => null).then(() => null)
        alertedIPs.delete(dev.ip)
      }
      return { source: 'managed', name: dev.name, ip: dev.ip, up: true, streak: 0, prevStreak }
    }

    const streak = (failStreak.get(dev.id) ?? 0) + 1
    failStreak.set(dev.id, streak)

    if (dev.status !== 'down') {
      await db.from('devices').update({ status: 'down' }).eq('id', dev.id)
      db.from('status_events').insert({ device_id: dev.id, device_name: dev.name, device_ip: dev.ip, old_status: dev.status, new_status: 'down' })
        .then(() => null).then(() => null)
    }

    if (streak >= FAIL_THRESHOLD && !alertedIPs.has(dev.ip)) {
      alertedIPs.add(dev.ip)
      const { data: existing } = await db.from('alerts')
        .select('id')
        .ilike('title', `%${dev.name} unreachable%`)
        .not('meta', 'ilike', '%[Discovered]%')
        .eq('suppressed', false).limit(1)

      if (!existing?.length) {
        await db.from('alerts').insert({
          title:      `${dev.name} unreachable`,
          meta:       `IP: ${dev.ip} · ${dev.location} · failed ${streak} consecutive ping checks`,
          severity:   'crit',
          acked:      false,
          suppressed: false,
          root_cause: `No ICMP response from ${dev.ip} — check cable, power, and upstream switch`,
        })
        try {
          await fetch(`${process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'}/api/notify/email`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
          })
        } catch { /* email optional */ }
      }
    }

    return { source: 'managed', name: dev.name, ip: dev.ip, up: false, streak }
  }))

  // ── 2. Ping discovered devices (from last 60 min of scan_results) ─────────
  const sinceTs = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const { data: scanRows } = await db
    .from('scan_results')
    .select('ip, vendor, device_type, responded')
    .gte('scanned_at', sinceTs)
    .order('scanned_at', { ascending: false })

  // Deduplicate — keep one entry per IP (most recent)
  const managedIpSet = new Set((devices ?? []).map(d => d.ip))
  const discoveredMap = new Map<string, { ip: string; vendor: string | null; device_type: string | null }>()
  for (const r of (scanRows ?? [])) {
    if (!discoveredMap.has(r.ip) && !managedIpSet.has(r.ip)) {
      discoveredMap.set(r.ip, r)
    }
  }

  const discoveredResults = await Promise.all([...discoveredMap.values()].map(async (r) => {
    const up = await pingOnce(r.ip)

    if (up) {
      discStreak.set(r.ip, 0)
      if (discAlerted.has(r.ip)) {
        // Recovered — suppress the discovered alert
        db.from('alerts')
          .update({ suppressed: true })
          .ilike('meta', `%[Discovered]%${r.ip}%`)
          .eq('suppressed', false)
          .then(() => null).then(() => null)
        discAlerted.delete(r.ip)
      }
      return { source: 'discovered', ip: r.ip, up: true, streak: 0 }
    }

    const streak = (discStreak.get(r.ip) ?? 0) + 1
    discStreak.set(r.ip, streak)

    if (streak >= FAIL_THRESHOLD && !discAlerted.has(r.ip)) {
      discAlerted.add(r.ip)
      const label = r.vendor ?? r.ip
      const { data: existing } = await db.from('alerts')
        .select('id')
        .ilike('meta', `%[Discovered]%${r.ip}%`)
        .eq('suppressed', false).limit(1)

      if (!existing?.length) {
        await db.from('alerts').insert({
          title:      `${label} unreachable`,
          meta:       `[Discovered] IP: ${r.ip} · ${r.device_type ?? 'Unknown'} · failed ${streak} consecutive ping checks`,
          severity:   'crit',
          acked:      false,
          suppressed: false,
          root_cause: `Discovered device at ${r.ip} stopped responding — may have disconnected from the network`,
        })
      }
    }

    return { source: 'discovered', ip: r.ip, up: false, streak }
  }))

  // Persist discovered device ping results so pages can show live Online/Offline status
  if (discoveredResults.length > 0) {
    db.from('scan_results').insert(
      discoveredResults.map(r => ({
        ip:         r.ip,
        responded:  r.up,
        scanned_at: now,
        scan_type:  (discoveredMap.get(r.ip) as { device_type?: string } | undefined)
                      ? 'icmp' : 'icmp',
        latency_ms: null,
        vendor:     null,
        device_type: null,
      }))
    ).then(() => null).catch(() => null)
  }

  return Response.json({
    checked:    (devices?.length ?? 0) + discoveredMap.size,
    managed:    managedResults,
    discovered: discoveredResults,
    checkedAt:  now,
  })
}

// GET — return current failure streaks
export async function GET() {
  const managed:    Record<string, number> = {}
  const discovered: Record<string, number> = {}
  failStreak.forEach((v, k) => { managed[k]    = v })
  discStreak.forEach((v, k) => { discovered[k] = v })
  return Response.json({ managed, discovered, alertedCount: alertedIPs.size + discAlerted.size })
}
