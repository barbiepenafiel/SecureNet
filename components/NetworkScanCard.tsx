'use client'

import { useState, useEffect } from 'react'
import type { ScanResult } from '@/lib/database.types'

interface ScanStats { total: number; icmp: number; arp: number }

export default function NetworkScanCard() {
  const [subnet,   setSubnet]   = useState('192.168.1')
  const [scanning, setScanning] = useState(false)
  const [results,  setResults]  = useState<ScanResult[]>([])
  const [stats,    setStats]    = useState<ScanStats | null>(null)
  const [lastScan, setLastScan] = useState<string | null>(null)
  const [error,    setError]    = useState<string | null>(null)

  useEffect(() => {
    // Restore saved subnet from localStorage (client-only, after mount)
    const initSaved = localStorage.getItem('nms_scan_subnet')
    if (initSaved) {
      const parts = initSaved.split('.')
      const normalized = parts.length >= 4 ? parts.slice(0, 3).join('.') : initSaved
      setSubnet(normalized)
      if (normalized !== initSaved) localStorage.setItem('nms_scan_subnet', normalized)
    }

    fetch('/api/scan')
      .then(r => r.json())
      .then(d => {
        const cached: ScanResult[] = d.results ?? []
        const detectedSubnets: string[] = d.detected_subnets ?? (d.detected_subnet ? [d.detected_subnet] : [])

        // Resolve the correct subnet: prefer server-detected physical over localStorage
        const saved = localStorage.getItem('nms_scan_subnet')
        const normalSaved = saved ? (saved.split('.').length >= 4 ? saved.split('.').slice(0, 3).join('.') : saved) : null
        const savedIsPhysical = !!normalSaved && detectedSubnets.includes(normalSaved)
        const activeSub = savedIsPhysical ? normalSaved! : (detectedSubnets[0] ?? normalSaved ?? '192.168.1')

        // Update UI and storage if subnet changed
        if (activeSub !== normalSaved) {
          setSubnet(activeSub)
          localStorage.setItem('nms_scan_subnet', activeSub)
          // Subnet changed — cached results are from the wrong network, rescan immediately
          scan(activeSub)
          return
        }

        // Subnet is correct — use cached results or rescan if stale/empty
        if (cached.length) {
          setResults(cached)
          setLastScan(d.scanned_at)
          setStats({ total: cached.length, icmp: cached.filter(x => x.responded).length, arp: cached.filter(x => x.mac !== null).length })
          const age = d.scanned_at ? Date.now() - new Date(d.scanned_at).getTime() : Infinity
          if (age > 5 * 60 * 1000) scan(activeSub)
        } else {
          scan(activeSub)
        }
      })
      .catch(() => autoScan())
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function scan(sub: string) {
    setScanning(true)
    setError(null)
    try {
      const res = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subnet: sub }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error ?? 'Scan failed')
      const r: ScanResult[] = d.results ?? []
      setResults(r)
      setLastScan(d.scanned_at)
      setStats({ total: r.length, icmp: r.filter(x => x.responded).length, arp: r.filter(x => x.mac !== null).length })
      // Broadcast so other components (DiscoveredKpi, etc.) update instantly
      window.dispatchEvent(new CustomEvent('nms:scan-complete', { detail: { results: r } }))
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Unknown error')
    } finally {
      setScanning(false)
    }
  }

  function autoScan() { scan(subnet) }
  function runScan()  { scan(subnet) }

  const topHosts = results.slice(0, 6)

  return (
    <div className="card">
      <div className="card-header">
        🔍 Network Discovery
        <div className="card-header-actions" suppressHydrationWarning>
          <input
            suppressHydrationWarning
            className="form-input"
            style={{ width: 130, fontSize: 12 }}
            value={subnet}
            onChange={e => {
              // Auto-normalize: strip last octet if a full IP is entered (e.g. "192.168.1.1" → "192.168.1")
              const val = e.target.value
              const parts = val.split('.')
              const normalized = parts.length >= 4 ? parts.slice(0, 3).join('.') : val
              setSubnet(normalized)
              localStorage.setItem('nms_scan_subnet', normalized)
            }}
            placeholder="e.g. 192.168.1"
            disabled={scanning}
          />
          <button className="btn btn-sm btn-primary" onClick={runScan} disabled={scanning}>
            {scanning ? 'Scanning…' : 'Scan'}
          </button>
        </div>
      </div>
      <div className="card-body">
        {scanning && (
          <div style={{ color: 'var(--info)', fontSize: 13, marginBottom: 10 }}>
            ⏳ Running ICMP + ARP scan on {subnet}.0/24…
          </div>
        )}
        {error && (
          <div style={{ color: 'var(--crit)', fontSize: 13, marginBottom: 10 }}>{error}</div>
        )}

        {stats ? (
          <>
            <div style={{ display: 'flex', gap: 24, marginBottom: 14 }}>
              <div>
                <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 2 }}>Discovered</div>
                <div style={{ fontSize: 22, fontWeight: 700 }}>{stats.total}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 2 }}>ICMP</div>
                <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--ok)' }}>{stats.icmp}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 2 }}>ARP</div>
                <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--info)' }}>{stats.arp}</div>
              </div>
            </div>

            <div style={{ fontSize: 12 }}>
              {topHosts.map((r, i) => (
                <div key={r.id ?? i} style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '5px 0', borderBottom: '1px solid var(--border)',
                }}>
                  <span className="mono" style={{ flex: '0 0 108px', fontSize: 11 }}>{r.ip}</span>
                  {/* Vendor + device type */}
                  <span style={{ flex: 1, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.vendor ? (
                      <>
                        <span style={{ color: 'var(--text2)', fontWeight: 600 }}>{r.vendor}</span>
                        {r.device_type && (
                          <span style={{ color: 'var(--text3)', marginLeft: 4 }}>· {r.device_type}</span>
                        )}
                      </>
                    ) : (
                      <span style={{ color: 'var(--text3)' }}>{r.mac ?? '—'}</span>
                    )}
                  </span>
                  <span className={`chip chip-${r.responded ? 'ok' : 'off'}`} style={{ fontSize: 10 }}>
                    {r.scan_type}
                  </span>
                  {r.latency_ms != null && (
                    <span style={{ color: 'var(--text3)', fontSize: 11, flex: '0 0 40px', textAlign: 'right' }}>
                      {r.latency_ms}ms
                    </span>
                  )}
                </div>
              ))}
              {results.length > 6 && (
                <div style={{ padding: '6px 0', color: 'var(--text3)', fontSize: 11 }}>
                  +{results.length - 6} more — see <a href="/devices" style={{ color: 'var(--accent)' }}>Devices</a>
                </div>
              )}
            </div>
          </>
        ) : !scanning ? null : null}

        {lastScan && (
          <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 10 }}>
            Last scan: {new Date(lastScan).toLocaleString()}
          </div>
        )}
      </div>
    </div>
  )
}
