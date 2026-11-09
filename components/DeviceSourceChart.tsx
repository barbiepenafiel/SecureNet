'use client'

import { useEffect, useRef, useState } from 'react'
import { Chart, registerables } from 'chart.js'
import { supabase } from '@/lib/supabase'

Chart.register(...registerables)

interface Counts {
  snmpOnline: number; snmpOffline: number
  icmpOnline: number; icmpOffline: number
  arpOnline:  number; arpOffline:  number
}

export default function DeviceSourceChart() {
  const ref    = useRef<HTMLCanvasElement>(null)
  const chart  = useRef<Chart | null>(null)
  const [counts, setCounts] = useState<Counts | null>(null)

  useEffect(() => {
    async function load() {
      const [{ data: devices }, scanRes] = await Promise.all([
        supabase.from('devices').select('ip, status, cpu, mem, snmp_community'),
        fetch('/api/scan').then(r => r.ok ? r.json() : { results: [] }).catch(() => ({ results: [] })),
      ])

      const devList = (devices ?? []) as { ip: string; status: string; cpu: number; mem: number; snmp_community: string | null }[]
      const managedIps = new Set(devList.map(d => d.ip))

      // A device is truly SNMP only if it has real SNMP data (cpu/mem polled) or snmp_community set
      const snmpDevs = devList.filter(d => d.snmp_community || d.cpu > 0 || d.mem > 0)
      const snmpIps  = new Set(snmpDevs.map(d => d.ip))

      // Managed devices without SNMP data = were added from ICMP/ARP discovery
      const icmpManaged = devList.filter(d => !snmpIps.has(d.ip))

      const snmpOnline  = snmpDevs.filter(d => d.status === 'up' || d.status === 'warn').length
      const snmpOffline = snmpDevs.filter(d => d.status === 'down').length

      // Discovered from scan — not in managed devices table
      const scanResults = (scanRes.results ?? []) as { ip: string; scan_type: string; responded: boolean }[]
      const unmanaged   = scanResults.filter(h => !managedIps.has(h.ip))

      // ICMP = managed-without-SNMP + unmanaged icmp/both scans
      const icmpScan   = unmanaged.filter(h => h.scan_type === 'icmp' || h.scan_type === 'both')
      const icmpOnline  = icmpManaged.filter(d => d.status === 'up' || d.status === 'warn').length
                        + icmpScan.filter(h => h.responded).length
      const icmpOffline = icmpManaged.filter(d => d.status === 'down').length
                        + icmpScan.filter(h => !h.responded).length

      // ARP = unmanaged arp-only scans
      const arpScan    = unmanaged.filter(h => h.scan_type === 'arp')
      const arpOnline  = arpScan.filter(h => h.responded).length
      const arpOffline = arpScan.filter(h => !h.responded).length

      setCounts({ snmpOnline, snmpOffline, icmpOnline, icmpOffline, arpOnline, arpOffline })
    }
    load()
  }, [])

  useEffect(() => {
    if (!ref.current || !counts) return
    chart.current?.destroy()

    const { snmpOnline, snmpOffline, icmpOnline, icmpOffline, arpOnline, arpOffline } = counts
    const data   = [snmpOnline, snmpOffline, icmpOnline, icmpOffline, arpOnline, arpOffline]
    const hasAny = data.some(v => v > 0)

    chart.current = new Chart(ref.current, {
      type: 'doughnut',
      data: {
        labels: ['SNMP Online', 'SNMP Offline', 'ICMP Online', 'ICMP Offline', 'ARP Online', 'ARP Offline'],
        datasets: [{
          data: hasAny ? data : [1],
          backgroundColor: hasAny
            ? ['#3fb950', '#f85149', '#2f81f7', '#f0883e', '#a371f7', '#d29922']
            : ['#2f81f720'],
          borderWidth: 2,
          borderColor: 'transparent',
          hoverOffset: 6,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '65%',
        plugins: {
          legend: {
            display: true, position: 'bottom',
            labels: { color: '#8b949e', font: { size: 10 }, padding: 8,
              filter: (item) => (data[item.index!] ?? 0) > 0,
            },
          },
          tooltip: {
            backgroundColor: '#161b22', borderColor: '#30363d', borderWidth: 1,
            callbacks: { label: (ctx) => ` ${ctx.label}: ${ctx.raw}` },
          },
        },
      },
    })
    return () => { chart.current?.destroy() }
  }, [counts])

  const total   = counts ? Object.values(counts).reduce((a, b) => a + b, 0) : 0
  const online  = counts ? counts.snmpOnline + counts.icmpOnline + counts.arpOnline : 0

  return (
    <div style={{ position: 'relative', height: 220 }}>
      {!counts && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text3)', fontSize: 13 }}>
          Loading…
        </div>
      )}
      <canvas ref={ref} />
      {counts && (
        <div style={{ position: 'absolute', top: '40%', left: '50%', transform: 'translate(-50%,-50%)', textAlign: 'center', pointerEvents: 'none' }}>
          <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text)' }}>{total}</div>
          <div style={{ fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.05em' }}>devices</div>
          <div style={{ fontSize: 11, color: 'var(--ok)', marginTop: 2 }}>{online} online</div>
        </div>
      )}
    </div>
  )
}
