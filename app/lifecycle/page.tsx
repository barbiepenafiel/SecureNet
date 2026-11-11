'use client'

import { useEffect, useState, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import type { Device, LifecycleRecord, ScanResult } from '@/lib/database.types'
import { usePolling } from '@/lib/usePolling'

const TODAY = new Date()

interface Row {
  id: string
  name: string
  ip: string
  deviceType: string
  source: 'snmp' | 'icmp' | 'arp' | 'both'
  devStatus: string
  // lifecycle fields (from lifecycle table if available)
  model: string | null
  firmware: string | null
  latest_fw: string | null
  warranty_date: string | null
  eom_date: string | null
  eol_date: string | null
  hasLifecycle: boolean
}

function expired(dateStr: string | null) {
  return !!dateStr && new Date(dateStr) < TODAY
}

function SourceBadge({ source }: { source: string }) {
  const map: Record<string, { bg: string; fg: string }> = {
    snmp: { bg: 'rgba(163,113,247,.15)', fg: '#a371f7' },
    icmp: { bg: 'rgba(47,129,247,.12)',  fg: '#2f81f7' },
    arp:  { bg: 'rgba(63,185,80,.12)',   fg: '#3fb950' },
    both: { bg: 'rgba(63,185,80,.12)',   fg: '#3fb950' },
  }
  const c = map[source] ?? { bg: 'var(--bg2)', fg: 'var(--text3)' }
  return (
    <span className="chip" style={{ background: c.bg, color: c.fg, fontSize: 10 }}>
      {source.toUpperCase()}
    </span>
  )
}

export default function LifecyclePage() {
  const [rows,    setRows]    = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [lastUp,  setLastUp]  = useState('')

  const load = useCallback(async () => {
    const [scanRes, devRes, lcRes, { data: scanHistory }] = await Promise.all([
      fetch('/api/scan').then(r => r.json()).catch(() => ({ results: [] })),
      supabase.from('devices').select('*').neq('status', 'maint'),
      supabase.from('lifecycle').select('*'),
      // Persistent scan history — survives device renames
      supabase.from('scan_results').select('ip, scan_type').order('scanned_at', { ascending: false }).limit(2000),
    ])

    const devices:   Device[]          = (devRes.data  ?? []) as Device[]
    const scans:     ScanResult[]      = scanRes.results ?? []
    const lcRecords: LifecycleRecord[] = (lcRes.data ?? []) as LifecycleRecord[]

    // Index lifecycle records by device name (lowercase for fuzzy match)
    const lcByName = new Map(lcRecords.map(r => [r.device_name.toLowerCase(), r]))

    // Build scan_type map from persisted scan_results (survives renames)
    // Most recent entry per IP wins; live /api/scan results take priority
    const scanTypeByIp = new Map<string, string>()
    // 1. Historical scan_results from Supabase (ordered newest first)
    for (const r of (scanHistory ?? [])) {
      if (!scanTypeByIp.has(r.ip)) scanTypeByIp.set(r.ip, r.scan_type ?? 'icmp')
    }
    // 2. Live scan results override (most up-to-date)
    for (const s of scans) {
      scanTypeByIp.set(s.ip, s.scan_type ?? scanTypeByIp.get(s.ip) ?? 'icmp')
    }

    const seen = new Map<string, Row>()

    // 1. Managed devices — source from scan history; fall back to snmp only if SNMP metrics exist
    for (const dev of devices) {
      const lc = lcByName.get(dev.name.toLowerCase())
      const scanType = scanTypeByIp.get(dev.ip)
      // If scan_results knows this IP, trust that scan_type (icmp/arp/both)
      // Only mark as snmp if no scan result found (device is SNMP-only, never ping-scanned)
      const source = scanType
        ? (scanType as 'icmp' | 'arp' | 'both')
        : 'snmp'
      seen.set(dev.ip, {
        id:            dev.id,
        name:          dev.name,
        ip:            dev.ip,
        deviceType:    dev.type,
        source,
        devStatus:     dev.status,
        model:         lc?.model    ?? dev.model    ?? null,
        firmware:      lc?.firmware ?? dev.firmware ?? null,
        latest_fw:     lc?.latest_fw ?? null,
        warranty_date: lc?.warranty_date ?? null,
        eom_date:      lc?.eom_date ?? null,
        eol_date:      lc?.eol_date ?? null,
        hasLifecycle:  !!(lc || dev.model || dev.firmware),
      })
    }

    // 2. Scan-discovered devices not already managed
    const managedIPs = new Set(devices.map(d => d.ip))
    for (const s of scans) {
      if (managedIPs.has(s.ip)) continue
      const key  = s.ip
      const name = s.hostname ?? s.vendor ?? s.ip
      const lc   = lcByName.get(name.toLowerCase())
      if (!seen.has(key)) {
        seen.set(key, {
          id:            key,
          name,
          ip:            s.ip,
          deviceType:    s.device_type ?? 'Unknown',
          source:        s.scan_type as 'icmp' | 'arp' | 'both',
          devStatus:     s.responded ? 'up' : 'warn',
          model:         lc?.model ?? null,
          firmware:      lc?.firmware ?? null,
          latest_fw:     lc?.latest_fw ?? null,
          warranty_date: lc?.warranty_date ?? null,
          eom_date:      lc?.eom_date ?? null,
          eol_date:      lc?.eol_date ?? null,
          hasLifecycle:  !!lc,
        })
      }
    }

    // Sort: SNMP first, then by name
    const sorted = Array.from(seen.values()).sort((a, b) => {
      if (a.source === 'snmp' && b.source !== 'snmp') return -1
      if (a.source !== 'snmp' && b.source === 'snmp') return  1
      return a.name.localeCompare(b.name)
    })

    setRows(sorted)
    setLastUp(new Date().toLocaleTimeString())
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
    const ch = supabase.channel('lifecycle-rt')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'devices' }, load)
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [load])
  // Keep data current without a manual refresh
  usePolling(load)

  if (loading) return (
    <div style={{ padding: 40, textAlign: 'center', color: 'var(--text3)' }}>
      Loading device inventory…
    </div>
  )

  const withLc    = rows.filter(r => r.hasLifecycle).length
  const warExpired = rows.filter(r => expired(r.warranty_date)).length
  const eomPast   = rows.filter(r => !expired(r.warranty_date) && expired(r.eom_date)).length

  return (
    <>
      {/* KPIs */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        {[
          { label: 'Total Devices',       value: rows.length,    color: 'var(--text)'  },
          { label: 'With Lifecycle Data', value: withLc,         color: 'var(--info)'  },
          { label: 'Warranty Expired',    value: warExpired,     color: warExpired  > 0 ? 'var(--crit)' : 'var(--ok)' },
          { label: 'End of Maintenance',  value: eomPast,        color: eomPast     > 0 ? 'var(--warn)' : 'var(--ok)' },
        ].map(k => (
          <div key={k.label} style={{ flex: '1 1 130px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 14px' }}>
            <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 4 }}>{k.label}</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: k.color }}>{k.value}</div>
          </div>
        ))}
      </div>

      <div className="card">
        <div className="card-header">
          Device Lifecycle Tracking
          <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 400, color: 'var(--ok)' }}>
            ● Live · SNMP + ICMP/ARP · updated {lastUp}
          </span>
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Device Name</th>
                <th>IP</th>
                <th>Type</th>
                <th>Source</th>
                <th>Model</th>
                <th>Current FW</th>
                <th>Latest FW</th>
                <th>Warranty Expiry</th>
                <th>End of Maint.</th>
                <th>End of Life</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={11} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>
                  No devices found. Add devices or run a scan from the Dashboard.
                </td></tr>
              )}
              {rows.map(r => {
                const fwOk   = !!r.firmware && r.firmware === r.latest_fw
                const warExp = expired(r.warranty_date)
                const eomExp = expired(r.eom_date)

                let statusLabel = 'Active'
                let statusChip  = 'ok'
                if (r.devStatus === 'down') { statusLabel = 'Offline';          statusChip = 'crit' }
                else if (warExp)            { statusLabel = 'Warranty Expired'; statusChip = 'crit' }
                else if (eomExp)            { statusLabel = 'End of Maint.';    statusChip = 'warn' }
                else if (r.firmware && !fwOk) { statusLabel = 'Update Available'; statusChip = 'warn' }
                else if (!r.hasLifecycle)   { statusLabel = 'No LC Data';       statusChip = 'off'  }

                return (
                  <tr key={r.id}>
                    <td><strong>{r.name}</strong></td>
                    <td className="mono" style={{ fontSize: 11, color: 'var(--text3)' }}>{r.ip}</td>
                    <td style={{ fontSize: 12, color: 'var(--text3)' }}>{r.deviceType}</td>
                    <td><SourceBadge source={r.source} /></td>
                    <td style={{ fontSize: 12 }}>{r.model ?? <span style={{ color: 'var(--text3)' }}>—</span>}</td>
                    <td className="mono" style={{ fontSize: 12 }}>{r.firmware ?? <span style={{ color: 'var(--text3)' }}>—</span>}</td>
                    <td className="mono" style={{ fontSize: 12, color: fwOk ? 'var(--ok)' : r.latest_fw ? 'var(--warn)' : 'var(--text3)' }}>
                      {r.latest_fw ?? '—'}{r.latest_fw && !fwOk ? ' ↑' : ''}
                    </td>
                    <td style={{ fontSize: 12, color: warExp ? 'var(--crit)' : 'var(--text2)' }}>
                      {r.warranty_date ?? '—'}{warExp ? ' ⚠' : ''}
                    </td>
                    <td style={{ fontSize: 12, color: eomExp ? 'var(--warn)' : 'var(--text3)' }}>
                      {r.eom_date ?? '—'}
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--text3)' }}>{r.eol_date ?? '—'}</td>
                    <td><span className={`chip chip-${statusChip}`}>{statusLabel}</span></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <div style={{ padding: '8px 16px', fontSize: 11, color: 'var(--text3)', borderTop: '1px solid var(--border)' }}>
          <span style={{ color: '#a371f7' }}>SNMP</span> = managed device ·
          <span style={{ color: '#2f81f7', marginLeft: 4 }}>ICMP</span> /
          <span style={{ color: '#3fb950', marginLeft: 2 }}>ARP</span> = scan-discovered ·
          Firmware &amp; warranty data can be added via the lifecycle table in Supabase.
        </div>
      </div>
    </>
  )
}
