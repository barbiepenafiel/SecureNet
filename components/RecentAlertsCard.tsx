'use client'

import { useEffect, useState, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import type { Alert, ScanResult } from '@/lib/database.types'

type ScanRow = Pick<ScanResult, 'ip' | 'mac' | 'scan_type' | 'responded' | 'latency_ms' | 'scanned_at'>

export default function RecentAlertsCard() {
  const [alerts,   setAlerts]   = useState<Alert[]>([])
  const [scanRows, setScanRows] = useState<ScanRow[]>([])

  const scanBuffer = useRef<ScanRow[]>([])
  const scanTimer  = useRef<ReturnType<typeof setTimeout> | null>(null)

  async function loadAlerts() {
    const { data } = await supabase
      .from('alerts')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(4)
    setAlerts(data ?? [])
  }

  async function loadScans() {
    const { data } = await supabase
      .from('scan_results')
      .select('ip, mac, scan_type, responded, latency_ms, scanned_at')
      .order('scanned_at', { ascending: false })
      .limit(50)
    if (!data?.length) return
    // Deduplicate by IP
    const seen = new Set<string>()
    const unique = data.filter((r: { ip: string }) => {
      if (seen.has(r.ip)) return false
      seen.add(r.ip); return true
    })
    setScanRows(unique.slice(0, 3))
  }

  useEffect(() => {
    loadAlerts()
    loadScans()

    // Real-time: alerts table
    const alertCh = supabase
      .channel('ra-alerts-rt')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'alerts' }, loadAlerts)
      .subscribe()

    // Real-time: scan_results table (batch inserts → debounce)
    const scanCh = supabase
      .channel('ra-scans-rt')
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'scan_results' },
        (payload) => {
          scanBuffer.current.push(payload.new as ScanRow)
          if (scanTimer.current) clearTimeout(scanTimer.current)
          scanTimer.current = setTimeout(() => {
            // Deduplicate buffer by IP, keep top 3
            const seen = new Set<string>()
            const unique = scanBuffer.current.filter((r) => {
              if (seen.has(r.ip)) return false
              seen.add(r.ip); return true
            })
            setScanRows(unique.slice(0, 3))
            scanBuffer.current = []
            scanTimer.current  = null
          }, 2000)
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(alertCh)
      supabase.removeChannel(scanCh)
      if (scanTimer.current) clearTimeout(scanTimer.current)
    }
  }, [])

  return (
    <div className="card">
      <div className="card-header">
        Recent Alerts
        <a href="/alerts" style={{ fontSize: 11, color: 'var(--accent)', marginLeft: 'auto', textDecoration: 'none' }}>
          View all →
        </a>
      </div>

      {/* ── Alert rows ── */}
      {alerts.map(a => (
        <div key={`a-${a.id}`} className={`alert-item${a.suppressed ? ' suppressed' : ''}`}>
          <div className={`alert-sev-${a.severity}`} />
          <div className="alert-body">
            <div className="alert-title">
              {a.title}
              {a.suppressed && <span className="chip chip-off" style={{ fontSize: 11, marginLeft: 6 }}>inactive</span>}
              {a.acked && !a.suppressed && <span className="chip chip-ok" style={{ fontSize: 11, marginLeft: 6 }}>active</span>}
            </div>
            <div className="alert-meta">
              <span>{a.root_cause ? `Root cause: ${a.root_cause}` : a.meta}</span>
            </div>
          </div>
          <span className={`chip chip-${a.severity === 'crit' ? 'crit' : a.severity === 'warn' ? 'warn' : 'info'}`}
            style={{ fontSize: 10, flexShrink: 0, alignSelf: 'center' }}>
            {a.severity.toUpperCase()}
          </span>
        </div>
      ))}

      {/* ── Section divider ── */}
      {scanRows.length > 0 && (
        <div style={{
          margin: '4px 16px 2px', borderTop: '1px solid var(--border)', paddingTop: 6,
          fontSize: 10, color: 'var(--text3)', fontWeight: 600, letterSpacing: .5,
        }}>
          ICMP / ARP DISCOVERED
        </div>
      )}

      {/* ── Discovered host rows ── */}
      {scanRows.map((s, i) => (
        <div key={`s-${s.ip}-${i}`} className="alert-item">
          <div style={{ width: 3, background: 'var(--accent)', borderRadius: 2, flexShrink: 0, alignSelf: 'stretch' }} />
          <div className="alert-body">
            <div className="alert-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span className="mono" style={{ fontSize: 12 }}>{s.ip}</span>
              <span className="chip chip-info" style={{ fontSize: 10 }}>{s.scan_type.toUpperCase()}</span>
              {s.responded && <span className="chip chip-ok" style={{ fontSize: 10 }}>ICMP OK</span>}
            </div>
            <div className="alert-meta">
              <span>
                {s.mac ?? 'No MAC'}
                {s.latency_ms != null ? ` · ${s.latency_ms}ms` : ''}
                {' · '}{new Date(s.scanned_at).toLocaleTimeString()}
              </span>
            </div>
          </div>
          <span className="chip chip-info" style={{ fontSize: 10, flexShrink: 0, alignSelf: 'center' }}>
            DISCOVERED
          </span>
        </div>
      ))}

      {alerts.length === 0 && scanRows.length === 0 && (
        <div style={{ padding: 24, color: 'var(--text3)', textAlign: 'center', fontSize: 13 }}>
          No alerts or discoveries yet
        </div>
      )}
    </div>
  )
}
