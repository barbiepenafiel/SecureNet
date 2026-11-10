'use client'

import { useState, useEffect, useCallback } from 'react'
import type { ScanResult } from '@/lib/database.types'

interface ScanStats { total: number; icmp: number; arp: number }

const POLL_MS = 10_000 // refresh every 10 s to match agent scan cadence

export default function NetworkScanCard() {
  const [results,  setResults]  = useState<ScanResult[]>([])
  const [stats,    setStats]    = useState<ScanStats | null>(null)
  const [lastScan, setLastScan] = useState<string | null>(null)
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/scan')
      const d   = await res.json()
      const r: ScanResult[] = d.results ?? []
      setResults(r)
      setLastScan(d.scanned_at ?? null)
      setStats({ total: r.length, icmp: r.filter(x => x.responded).length, arp: r.filter(x => x.mac !== null).length })
      window.dispatchEvent(new CustomEvent('nms:scan-complete', { detail: { results: r } }))
    } catch {
      setError('Could not reach scan API')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, POLL_MS)
    return () => clearInterval(id)
  }, [refresh])

  const topHosts = results.slice(0, 6)

  return (
    <div className="card">
      <div className="card-header">
        🔍 Network Discovery
        <div className="card-header-actions" suppressHydrationWarning>
          <button
            suppressHydrationWarning
            className="btn btn-sm btn-primary"
            onClick={refresh}
            disabled={loading}
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>
      <div className="card-body">
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
        ) : !loading ? (
          <div style={{ color: 'var(--text3)', fontSize: 13 }}>Waiting for agent scan…</div>
        ) : null}

        {lastScan && (
          <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 10 }}>
            Last scan: {new Date(lastScan).toLocaleString()}
          </div>
        )}
      </div>
    </div>
  )
}
