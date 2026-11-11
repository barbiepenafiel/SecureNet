'use client'

import { useEffect, useState, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import type { Device, ScanResult } from '@/lib/database.types'

declare global { interface WindowEventMap { 'nms:scan-complete': CustomEvent<{ results: ScanResult[] }> } }

interface ClientRow {
  key: string
  ip: string
  mac: string | null
  hostname: string | null
  vendor: string | null
  device_type: string | null
  scan_type: string        // 'icmp' | 'arp' | 'both' | 'snmp'
  responded: boolean
  latency_ms: number | null
  scanned_at: string
  isSnmp: boolean          // monitored via SNMP
  snmpStatus?: string      // device status from devices table
  uptime?: string
  cpu?: number
  mem?: number
}

function MethodBadge({ type }: { type: string }) {
  const colors: Record<string, { bg: string; fg: string }> = {
    icmp: { bg: 'rgba(47,129,247,.12)',   fg: '#2f81f7' },
    arp:  { bg: 'rgba(63,185,80,.12)',    fg: '#3fb950' },
    both: { bg: 'rgba(63,185,80,.12)',    fg: '#3fb950' },
    snmp: { bg: 'rgba(163,113,247,.15)', fg: '#a371f7' },
  }
  const c = colors[type] ?? { bg: 'var(--bg2)', fg: 'var(--text3)' }
  return (
    <span className="chip" style={{ background: c.bg, color: c.fg, fontSize: 10 }}>
      {type.toUpperCase()}
    </span>
  )
}

function StatusChip({ status, responded }: { status?: string; responded: boolean }) {
  if (status === 'up'   || (!status && responded))  return <span className="chip chip-ok">up</span>
  if (status === 'warn')                             return <span className="chip chip-warn">warn</span>
  if (status === 'down')                             return <span className="chip chip-crit">down</span>
  return <span className="chip chip-warn">arp</span>
}

export default function ClientsPage() {
  const [clients, setClients] = useState<ClientRow[]>([])
  const [loading, setLoading] = useState(true)
  const [lastUp,  setLastUp]  = useState('')
  const [search,  setSearch]  = useState('')

  const load = useCallback(async () => {
    const [scanRes, { data: devData }] = await Promise.all([
      fetch('/api/scan').then(r => r.json()).catch(() => ({ results: [] })),
      supabase.from('devices').select('*').neq('status', 'maint'),
    ])

    const scans:   ScanResult[] = scanRes.results ?? []
    const devices: Device[]     = (devData ?? []) as Device[]
    const managedIPMap = new Map(devices.map(d => [d.ip, d]))

    // Start with SNMP-monitored devices (always included)
    const seen = new Map<string, ClientRow>()
    for (const dev of devices) {
      seen.set(dev.ip, {
        key:         dev.ip,
        ip:          dev.ip,
        mac:         null,
        hostname:    dev.name,
        vendor:      null,
        device_type: dev.type,
        scan_type:   'snmp',
        responded:   dev.status === 'up' || dev.status === 'warn',
        latency_ms:  null,
        scanned_at:  dev.updated_at,
        isSnmp:      true,
        snmpStatus:  dev.status,
        uptime:      dev.uptime,
        cpu:         dev.cpu,
        mem:         dev.mem,
      })
    }

    // Merge scan results — enrich SNMP entries with MAC/vendor, add new entries
    for (const s of scans) {
      const existing = seen.get(s.ip)
      if (existing) {
        // Enrich SNMP device with MAC + vendor from scan
        if (!existing.mac && s.mac)         existing.mac    = s.mac
        if (!existing.vendor && s.vendor)   existing.vendor = s.vendor
        if (s.latency_ms != null)           existing.latency_ms = s.latency_ms
        // Keep latest scan_at if scan is more recent
        if (s.scanned_at > existing.scanned_at) existing.scanned_at = s.scanned_at
      } else {
        // New entry from scan (not in SNMP-managed devices)
        const key = s.mac ?? s.ip
        const prev = seen.get(key)
        if (!prev || s.scanned_at > prev.scanned_at) {
          seen.set(key, {
            key,
            ip:          s.ip,
            mac:         s.mac,
            hostname:    s.hostname,
            vendor:      s.vendor,
            device_type: s.device_type,
            scan_type:   s.scan_type,
            responded:   s.responded,
            latency_ms:  s.latency_ms,
            scanned_at:  s.scanned_at,
            isSnmp:      false,
            snmpStatus:  undefined,
          })
        }
      }
    }

    setClients(
      Array.from(seen.values()).sort((a, b) => {
        // SNMP devices first, then by last seen desc
        if (a.isSnmp !== b.isSnmp) return a.isSnmp ? -1 : 1
        return new Date(b.scanned_at).getTime() - new Date(a.scanned_at).getTime()
      })
    )
    setLastUp(new Date().toLocaleTimeString())
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
    const onScan = () => load()
    window.addEventListener('nms:scan-complete', onScan)

    // Auto-refresh every 60s to pick up latest ping results from monitor
    const timer = setInterval(() => { if (document.visibilityState === "visible") load() }, 5_000)

    // Real-time refresh when device SNMP data updates
    const ch = supabase.channel('clients-snmp')
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'devices' }, load)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'scan_results' }, load)
      .subscribe()
    return () => {
      window.removeEventListener('nms:scan-complete', onScan)
      clearInterval(timer)
      supabase.removeChannel(ch)
    }
  }, [load])

  const online  = clients.filter(c => c.responded || c.snmpStatus === 'up').length
  const rogues  = clients.filter(c => !c.hostname && !c.vendor && !c.isSnmp).length
  const snmpCnt = clients.filter(c => c.isSnmp).length

  const filtered = search
    ? clients.filter(c =>
        c.ip?.includes(search) ||
        c.mac?.toLowerCase().includes(search.toLowerCase()) ||
        c.hostname?.toLowerCase().includes(search.toLowerCase()) ||
        c.vendor?.toLowerCase().includes(search.toLowerCase()) ||
        c.device_type?.toLowerCase().includes(search.toLowerCase())
      )
    : clients

  if (loading) return (
    <div style={{ padding: 40, textAlign: 'center', color: 'var(--text3)' }}>
      Loading…
    </div>
  )

  return (
    <>
      {/* KPIs */}
      <div className="kpi-row-3">
        <div className="kpi kpi-info">
          <div className="kpi-label">Online Now</div>
          <div className="kpi-value">{online}</div>
          <div className="kpi-sub">responding devices</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">SNMP Monitored</div>
          <div className="kpi-value" style={{ color: 'var(--info)' }}>{snmpCnt}</div>
          <div className="kpi-sub">with real-time metrics</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Total Tracked</div>
          <div className="kpi-value" style={{ color: 'var(--text2)' }}>{clients.length}</div>
          <div className="kpi-sub">{rogues > 0 ? `${rogues} unidentified` : 'all identified'}</div>
        </div>
      </div>

      {/* Table */}
      <div className="card">
        <div className="card-header" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span>Client Activity</span>
          <span style={{ fontSize: 11, color: 'var(--ok)', fontWeight: 400 }}>
            ● Live · auto-refresh 1 min{lastUp && ` · updated ${lastUp}`}
          </span>
          <div style={{ marginLeft: 'auto' }}>
            <input suppressHydrationWarning
              className="form-input"
              style={{ width: 190, fontSize: 12 }}
              placeholder="Search IP / MAC / hostname…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
        </div>

        {clients.length === 0 ? (
          <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--text3)' }}>
            <div style={{ fontSize: 24, marginBottom: 8 }}>🔍</div>
            <div style={{ fontWeight: 600 }}>No devices found</div>
            <div style={{ fontSize: 12, marginTop: 4 }}>
              Add devices in the Devices page or run a network scan from the Dashboard.
            </div>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Hostname / MAC</th>
                  <th>IP</th>
                  <th>Vendor / Type</th>
                  <th>Method</th>
                  <th>Uptime</th>
                  <th>CPU</th>
                  <th>Memory</th>
                  <th>Latency</th>
                  <th>Last Seen</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(c => {
                  const displayName = c.hostname ?? c.vendor ?? 'Unknown'
                  const isUnknown   = !c.hostname && !c.vendor && !c.isSnmp
                  return (
                    <tr key={c.key}>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                          <span style={{ fontWeight: isUnknown ? 400 : 500, color: isUnknown ? 'var(--warn)' : undefined }}>
                            {displayName}
                          </span>
                          {c.isSnmp && (
                            <span style={{ fontSize: 10, background: 'rgba(163,113,247,.15)', color: '#a371f7', borderRadius: 4, padding: '1px 5px' }}>
                              SNMP
                            </span>
                          )}
                        </div>
                        {c.mac && <div className="mono" style={{ fontSize: 11, color: 'var(--text3)' }}>{c.mac}</div>}
                      </td>
                      <td className="mono" style={{ fontSize: 12 }}>{c.ip}</td>
                      <td style={{ fontSize: 12 }}>
                        <div>{c.vendor ?? (c.isSnmp ? '—' : <span style={{ color: 'var(--text3)' }}>Unknown</span>)}</div>
                        {c.device_type && <div style={{ fontSize: 11, color: 'var(--text3)' }}>{c.device_type}</div>}
                      </td>
                      <td><MethodBadge type={c.scan_type} /></td>
                      <td style={{ fontSize: 12, color: 'var(--text3)' }}>{c.uptime ?? '—'}</td>
                      <td style={{ fontSize: 12 }}>
                        {c.cpu != null && c.cpu > 0
                          ? <span style={{ color: c.cpu > 80 ? 'var(--crit)' : c.cpu > 60 ? 'var(--warn)' : 'var(--ok)' }}>{c.cpu}%</span>
                          : <span style={{ color: 'var(--text3)' }}>—</span>}
                      </td>
                      <td style={{ fontSize: 12 }}>
                        {c.mem != null && c.mem > 0
                          ? <span style={{ color: c.mem > 85 ? 'var(--crit)' : c.mem > 70 ? 'var(--warn)' : 'var(--ok)' }}>{c.mem}%</span>
                          : <span style={{ color: 'var(--text3)' }}>—</span>}
                      </td>
                      <td style={{ color: 'var(--text3)', fontSize: 12 }}>
                        {c.latency_ms != null ? `${c.latency_ms} ms` : '—'}
                      </td>
                      <td style={{ color: 'var(--text3)', fontSize: 12 }}>
                        {new Date(c.scanned_at).toLocaleString()}
                      </td>
                      <td><StatusChip status={c.snmpStatus} responded={c.responded} /></td>
                    </tr>
                  )
                })}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={10} style={{ textAlign: 'center', color: 'var(--text3)', padding: 20 }}>
                      No results match "{search}"
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        <div style={{ padding: '8px 16px', fontSize: 11, color: 'var(--text3)', borderTop: '1px solid var(--border)' }}>
          <span style={{ color: '#a371f7' }}>SNMP</span> = managed device with live metrics ·
          ICMP/ARP = discovered by network scan ·
          {rogues > 0 && <span style={{ color: 'var(--warn)', marginLeft: 4 }}>{rogues} unidentified device(s) detected</span>}
        </div>
      </div>
    </>
  )
}
