'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase' // used for real-time subscription only

type Row = { ip: string; responded: boolean; mac: string | null }

function tally(rows: Row[]) {
  const seen = new Set<string>()
  const unique = rows.filter(r => { if (seen.has(r.ip)) return false; seen.add(r.ip); return true })
  return { total: unique.length, icmp: unique.filter(r => r.responded).length, arp: unique.filter(r => r.mac !== null).length }
}

export default function DiscoveredKpi() {
  const [total,    setTotal]    = useState<number | null>(null)
  const [icmp,     setIcmp]     = useState(0)
  const [arp,      setArp]      = useState(0)
  const [scanning, setScanning] = useState(false)

  function apply(rows: Row[]) {
    const t = tally(rows)
    setTotal(t.total); setIcmp(t.icmp); setArp(t.arp)
  }

  async function load() {
    try {
      // Use /api/scan GET — already picks the freshest source (Supabase or in-memory cache)
      const res = await fetch('/api/scan')
      const d = await res.json()
      const rows: Row[] = d.results ?? []

      if (rows.length) { apply(rows); return }

      // No results — auto-trigger a scan using a physical subnet
      const detectedSubnets: string[] = d.detected_subnets ?? (d.detected_subnet ? [d.detected_subnet] : [])
      const savedSubnet = localStorage.getItem('nms_scan_subnet')
      const savedIsPhysical = savedSubnet && detectedSubnets.includes(savedSubnet)
      const subnet = (!savedIsPhysical && detectedSubnets[0]) ? detectedSubnets[0] : (savedSubnet ?? '192.168.1')
      if (!savedIsPhysical && detectedSubnets[0]) localStorage.setItem('nms_scan_subnet', detectedSubnets[0])
      setScanning(true)
      const scanRes = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subnet }),
      })
      const scanData = await scanRes.json()
      apply(scanData.results ?? [])
    } catch {
      setTotal(0)
    } finally {
      setScanning(false)
    }
  }

  useEffect(() => {
    load()

    // Listen for scan completions broadcast by NetworkScanCard / DevicesPage
    function onScanComplete(e: Event) {
      const rows: Row[] = (e as CustomEvent).detail?.results ?? []
      if (rows.length) apply(rows)
      else load()
    }
    window.addEventListener('nms:scan-complete', onScanComplete)

    // Supabase real-time (when table exists)
    const ch = supabase
      .channel('discovered-kpi-rt')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'scan_results' }, load)
      .subscribe()

    // Fallback poll every 15s
    const poll = setInterval(load, 15_000)

    return () => {
      window.removeEventListener('nms:scan-complete', onScanComplete)
      clearInterval(poll)
      supabase.removeChannel(ch)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="kpi kpi-ok">
      <div className="kpi-inner">
        <div>
          <div className="kpi-label">Discovered Hosts</div>
          <div className="kpi-value" style={{ color: 'var(--accent)' }}>
            {total === null ? (scanning ? '…' : '—') : total}
          </div>
          <div className="kpi-sub">
            {scanning ? 'Scanning network…' : `ICMP ${icmp} · ARP ${arp}`}
          </div>
        </div>
        <div className="kpi-icon kpi-icon-ok">◎</div>
      </div>
    </div>
  )
}
