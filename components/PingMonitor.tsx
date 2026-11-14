'use client'

import { useEffect, useRef, useState } from 'react'
import { supabase } from '@/lib/supabase'

const INTERVAL_MS    = 30 * 1000  // scan / SNMP / report cycle
const PING_MS        = 15 * 1000  // device online/offline check (ICMP → ARP → SNMP)
const DEFAULT_SUBNET = '192.168.1'

interface MonitorResult { name: string; ip: string; up: boolean; streak: number; skipped?: boolean }
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
  const [agentOffline, setAgentOffline] = useState(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const pingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // ── Online/offline check every 15 s (the server creates the alerts) ──
  async function runMonitor() {
    try {
      const res = await fetch('/api/monitor', { method: 'POST' })
      if (!res.ok) return
      const data = await res.json()
      const results: MonitorResult[] = [
        ...(data.managed    ?? []),
        ...(data.discovered ?? []),
      ]
      // Count only confirmed outages (3 failed checks, on a reachable network)
      const threshold = Number(data.threshold) || 1
      setDownCount(results.filter(r => !r.up && !r.skipped && r.streak >= threshold).length)
      // Hosted dashboard: the campus agent does the checking — say so when it stops reporting
      setAgentOffline(data.agentOnline === false)
      setLastRun(new Date())
    } catch { /* silent background task */ }
  }

  async function runCycle() {
    setScanning(true)
    try {
      const subnet = localStorage.getItem('nms_scan_subnet') ?? DEFAULT_SUBNET

      // ── 1. Subnet scan ──
      const [scanRes] = await Promise.allSettled([
        fetch('/api/scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subnet }),
        }),
      ])

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
        .is('resolved_at', null)
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
        // Email for these alerts is sent by the agent (poller/notify.js), not from this tab
      }

      // ── 5. Poll SNMP for uptime/CPU/mem on all devices ──
      fetch('/api/snmp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .catch(() => {})

      // (The daily report snapshot is made and emailed by the agent — poller/notify.js)

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
      runMonitor()
      pingTimerRef.current = setInterval(runMonitor, PING_MS)
      runCycle()
      timerRef.current = setInterval(runCycle, INTERVAL_MS)
    }, 3_000)

    return () => {
      clearTimeout(boot)
      if (timerRef.current) clearInterval(timerRef.current)
      if (pingTimerRef.current) clearInterval(pingTimerRef.current)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const dotColor = agentOffline ? 'var(--crit)'
    : scanning
    ? 'var(--info)'
    : downCount > 0 ? 'var(--crit)'
    : lastRun     ? 'var(--ok)'
    : 'var(--text3)'

  const label = agentOffline ? 'Agent offline — data not updating'
    : scanning
    ? 'Scanning…'
    : downCount > 0 ? `${downCount} down`
    : lastRun       ? `Checked ${lastRun.toLocaleTimeString()}`
    : 'Monitor starting…'

  return (
    <div
      title={agentOffline
        ? 'The campus monitoring agent has not reported for over a minute. Device statuses are the last ones it sent. Monitoring resumes when the computer running the SecureNet agent is on and connected to the campus network.'
        : lastRun
        ? `Device check every 15 s (offline after 3 failed checks) · ${downCount} device(s) down · last: ${lastRun.toLocaleTimeString()}`
        : 'Device monitor starting…'}
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
      <span style={{ color: agentOffline || downCount > 0 ? 'var(--crit)' : 'inherit', fontWeight: agentOffline || downCount > 0 ? 600 : 400 }}>
        {label}
      </span>
    </div>
  )
}
