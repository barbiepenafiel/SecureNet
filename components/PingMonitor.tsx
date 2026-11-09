'use client'

import { useEffect, useRef, useState } from 'react'
import { supabase } from '@/lib/supabase'

const INTERVAL_MS    = 30 * 1000  // 30 seconds (demo mode)
const DEFAULT_SUBNET = '192.168.1'

interface MonitorResult { name: string; ip: string; up: boolean; streak: number }
interface ScanHost      { ip: string; hostname: string | null; scan_type: string }

// ── Browser notification helper ──────────────────────────────────────────
function notify(title: string, body: string, tag: string) {
  if (typeof Notification === 'undefined') return
  if (Notification.permission !== 'granted') return
  try {
    new Notification(title, {
      body,
      tag,          // same tag = replaces duplicate, no double-ping
      icon: '/favicon.ico',
      silent: false,
    })
  } catch {}
}

function requestPermission() {
  if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
    Notification.requestPermission()
  }
}

// ── LocalStorage helpers (dedupe) ────────────────────────────────────────
function getSet(key: string): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(key) ?? '[]')) } catch { return new Set() }
}
function saveSet(key: string, s: Set<string>) {
  // Keep at most 200 entries so localStorage doesn't grow forever
  const arr = [...s].slice(-200)
  localStorage.setItem(key, JSON.stringify(arr))
}

export default function PingMonitor() {
  const [lastRun,   setLastRun]   = useState<Date | null>(null)
  const [downCount, setDownCount] = useState(0)
  const [scanning,  setScanning]  = useState(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  async function runCycle() {
    setScanning(true)
    try {
      const subnet = localStorage.getItem('nms_scan_subnet') ?? DEFAULT_SUBNET

      // ── 1. Run ping-monitor + full subnet scan in parallel ──
      const [monitorRes, scanRes] = await Promise.allSettled([
        fetch('/api/monitor', { method: 'POST' }),
        fetch('/api/scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subnet }),
        }),
      ])

      // ── 2. Process monitor results (device up/down) ──
      if (monitorRes.status === 'fulfilled' && monitorRes.value.ok) {
        const data = await monitorRes.value.json()
        const results: MonitorResult[] = [
          ...(data.managed    ?? []),
          ...(data.discovered ?? []),
        ]
        setDownCount(results.filter(r => !r.up).length)
      }

      // ── 3. Detect newly discovered hosts (dedupe by IP in localStorage) ──
      if (scanRes.status === 'fulfilled' && scanRes.value.ok) {
        const scanData = await scanRes.value.json()
        const hosts: ScanHost[] = scanData.results ?? []

        const seenIPs = getSet('nms_seen_ips')
        const newHosts = hosts.filter(h => !seenIPs.has(h.ip))

        newHosts.forEach(h => seenIPs.add(h.ip))
        saveSet('nms_seen_ips', seenIPs)

        // Notify for each genuinely new host (cap at 3 per cycle to avoid spam)
        newHosts.slice(0, 3).forEach(h => {
          notify(
            '🔍 New Host Discovered',
            `${h.ip}${h.hostname ? ` (${h.hostname})` : ''} · found via ${h.scan_type.toUpperCase()} on ${subnet}.0/24`,
            `host-${h.ip}`,
          )
        })
        if (newHosts.length > 3) {
          notify(
            '🔍 Multiple New Hosts Discovered',
            `${newHosts.length} new hosts found on ${subnet}.0/24`,
            `hosts-batch-${Date.now()}`,
          )
        }
      }

      // ── 4. Notify for recent unacked alerts (crit/warn) ──
      const sixMinAgo = new Date(Date.now() - 6 * 60 * 1000).toISOString()
      const { data: recentAlerts } = await supabase
        .from('alerts')
        .select('id, title, meta, severity')
        .eq('acked', false)
        .eq('suppressed', false)
        .in('severity', ['crit', 'warn'])
        .gte('created_at', sixMinAgo)
        .order('created_at', { ascending: false })

      if (recentAlerts?.length) {
        const notifiedAlerts = getSet('nms_notified_alert_ids')
        recentAlerts.forEach((a: { id: number; title: string; meta: string; severity: string }) => {
          const key = String(a.id)
          if (!notifiedAlerts.has(key)) {
            notifiedAlerts.add(key)
            const icon = a.severity === 'crit' ? '🔴' : '🟡'
            notify(
              `${icon} ${a.severity.toUpperCase()}: ${a.title}`,
              a.meta,
              `alert-${key}`,
            )
          }
        })
        saveSet('nms_notified_alert_ids', notifiedAlerts)

        // ── 4b. Send email notification for new critical alerts ──
        const hasCrit = recentAlerts.some((a: { severity: string }) => a.severity === 'crit')
        if (hasCrit) {
          fetch('/api/notify/email', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
            .catch(() => {}) // email is best-effort
        }
      }

      // ── 5. Poll SNMP for uptime/CPU/mem on all devices ──
      fetch('/api/snmp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .catch(() => {})

      // ── 6. Auto-generate daily report snapshot ──
      fetch('/api/reports/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auto: true }),
      }).catch(() => {})

      setLastRun(new Date())
    } catch {
      // silent background task
    } finally {
      setScanning(false)
    }
  }

  useEffect(() => {
    requestPermission()

    // First cycle 15 s after mount
    const boot = setTimeout(() => {
      runCycle()
      timerRef.current = setInterval(runCycle, INTERVAL_MS)
    }, 3_000)

    return () => {
      clearTimeout(boot)
      if (timerRef.current) clearInterval(timerRef.current)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const dotColor = scanning
    ? 'var(--info)'
    : downCount > 0 ? 'var(--crit)'
    : lastRun     ? 'var(--ok)'
    : 'var(--text3)'

  const label = scanning
    ? 'Scanning…'
    : downCount > 0 ? `${downCount} down`
    : lastRun       ? `Checked ${lastRun.toLocaleTimeString()}`
    : 'Monitor starting…'

  return (
    <div
      title={lastRun
        ? `Auto-scan every 5 min · ${downCount} device(s) down · last: ${lastRun.toLocaleTimeString()}`
        : 'Auto-scan + ping monitor starts in 15 s…'}
      style={{
        display: 'flex', alignItems: 'center', gap: 5,
        fontSize: 11, color: 'var(--text3)', userSelect: 'none', cursor: 'default',
      }}
    >
      <span style={{
        width: 7, height: 7, borderRadius: '50%',
        background: dotColor, display: 'inline-block',
        animation: scanning ? 'pulse 1s ease-in-out infinite' : 'none',
        boxShadow: downCount > 0 ? '0 0 0 2px rgba(248,81,73,.3)' : 'none',
      }} />
      <span style={{ color: downCount > 0 ? 'var(--crit)' : 'inherit', fontWeight: downCount > 0 ? 600 : 400 }}>
        {label}
      </span>
    </div>
  )
}
