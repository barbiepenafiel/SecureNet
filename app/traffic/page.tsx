'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { Chart, registerables } from 'chart.js'
import { supabase } from '@/lib/supabase'
import type { Client, TrafficSample } from '@/lib/database.types'
import { usePolling } from '@/lib/usePolling'
import MikrotikRouterCard from '@/components/MikrotikRouterCard'
import SnmpTrafficGraphs from '@/components/SnmpTrafficGraphs'

Chart.register(...registerables)

const HOURS = Array.from({ length: 24 }, (_, i) => `${i}:00`)

const BASE_OPT = {
  responsive: true, maintainAspectRatio: false,
  plugins: {
    legend: { display: false },
    tooltip: { backgroundColor: '#161b22', borderColor: '#30363d', borderWidth: 1, titleColor: '#e6edf3', bodyColor: '#8b949e' },
  },
  scales: {
    x: { grid: { color: 'rgba(48,54,61,.5)' }, ticks: { color: '#6e7681', font: { size: 11 } } },
    y: { grid: { color: 'rgba(48,54,61,.5)' }, ticks: { color: '#6e7681', font: { size: 11 } } },
  },
} as const

// ── Top Devices by Traffic — real data bar chart ─────────────────────────────
function DeviceBandwidthChart({ rows }: { rows: { name: string; inMbps: number; outMbps: number }[] }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    if (!ref.current) return
    const c = new Chart(ref.current, {
      type: 'bar',
      data: {
        labels: rows.map(r => r.name),
        datasets: [
          { label: 'In (Mbps)',  data: rows.map(r => r.inMbps),  backgroundColor: '#2f81f7', borderRadius: 4 },
          { label: 'Out (Mbps)', data: rows.map(r => r.outMbps), backgroundColor: '#3fb950', borderRadius: 4 },
        ],
      },
      options: {
        ...BASE_OPT,
        plugins: {
          ...BASE_OPT.plugins,
          legend: { display: true, labels: { color: '#8b949e', font: { size: 11 } } },
        },
        scales: {
          x: BASE_OPT.scales.x,
          y: { ...BASE_OPT.scales.y, ticks: { ...BASE_OPT.scales.y.ticks, callback: (v: unknown) => `${v} Mbps` } },
        },
      },
    })
    return () => c.destroy()
  }, [rows])
  return <canvas ref={ref} height={220} />
}

// ── Empty state for device chart ─────────────────────────────────────────────
function NoTrafficYet() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: 220, color: 'var(--text3)', gap: 8 }}>
      <div style={{ fontSize: 32 }}>📡</div>
      <div style={{ fontWeight: 600, fontSize: 14 }}>No traffic samples yet</div>
    </div>
  )
}

// ── Interface utilization line chart ─────────────────────────────────────────
function IfaceChart({ labels, inData, outData, unit }: {
  labels: string[]; inData: number[]; outData: number[]; unit: string
}) {
  const ref   = useRef<HTMLCanvasElement>(null)
  const chart = useRef<Chart | null>(null)

  useEffect(() => {
    if (!ref.current) return
    if (chart.current) chart.current.destroy()
    chart.current = new Chart(ref.current, {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: `Inbound (${unit})`,  data: inData,  borderColor: '#2f81f7', tension: .4, pointRadius: 0, fill: true, backgroundColor: 'rgba(47,129,247,.08)' },
          { label: `Outbound (${unit})`, data: outData, borderColor: '#3fb950', tension: .4, pointRadius: 0 },
        ],
      },
      options: {
        ...BASE_OPT,
        plugins: { ...BASE_OPT.plugins, legend: { display: true, labels: { color: '#8b949e', font: { size: 11 } } } },
        scales: { x: BASE_OPT.scales.x, y: BASE_OPT.scales.y },
      },
    })
    return () => chart.current?.destroy()
  }, [labels, inData, outData, unit])

  return <canvas ref={ref} height={120} />
}

function parseMB(s: string): number {
  if (!s) return 0
  const [num, unit] = s.trim().split(' ')
  return unit?.toUpperCase() === 'GB' ? parseFloat(num) * 1024 : parseFloat(num)
}

function buildHourlyBuckets(samples: TrafficSample[]) {
  const buckets: Record<number, { in: number[]; out: number[] }> = {}
  for (let h = 0; h < 24; h++) buckets[h] = { in: [], out: [] }
  samples.forEach(s => {
    const h = new Date(s.sampled_at).getHours()
    buckets[h].in.push(Number(s.in_mbps))
    buckets[h].out.push(Number(s.out_mbps))
  })
  return Array.from({ length: 24 }, (_, h) => {
    const b   = buckets[h]
    const avg = (arr: number[]) => arr.length ? arr.reduce((a, v) => a + v, 0) / arr.length : 0
    return { hour: `${h}:00`, inMbps: avg(b.in), outMbps: avg(b.out) }
  })
}

// ── Page ─────────────────────────────────────────────────────────────────────
export default function TrafficPage() {
  const [samples, setSamples] = useState<TrafficSample[]>([])
  const [clients, setClients] = useState<Client[]>([])
  const [loading, setLoading] = useState(true)

  const loadData = useCallback(async () => {
    const since = new Date(Date.now() - 24 * 3_600_000).toISOString()
    const [{ data: s }, { data: c }] = await Promise.all([
      supabase.from('traffic_samples').select('*').gte('sampled_at', since).order('sampled_at'),
      supabase.from('clients').select('*'),
    ])
    setSamples((s ?? []) as TrafficSample[])
    setClients([...(c ?? []) as Client[]].sort((a, b) => parseMB(b.tx) - parseMB(a.tx)))
    setLoading(false)
  }, [])

  useEffect(() => {
    loadData()
    const ch = supabase.channel('traffic-live')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'traffic_samples' }, loadData)
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [loadData])
  // Keep data current without a manual refresh
  usePolling(loadData, 10_000)

  const hasReal = samples.length > 0

  // Hourly buckets for WAN chart
  const hourly    = hasReal ? buildHourlyBuckets(samples) : null
  const chartLabels = hourly ? hourly.map(b => b.hour) : HOURS
  const chartIn     = hourly ? hourly.map(b => parseFloat(b.inMbps.toFixed(4)))  : Array(24).fill(0)
  const chartOut    = hourly ? hourly.map(b => parseFloat(b.outMbps.toFixed(4))) : Array(24).fill(0)
  const chartUnit   = 'Mbps'

  // Top devices by traffic (last sample per device+interface)
  const latestPerKey: Record<string, TrafficSample> = {}
  samples.forEach(s => {
    const key = `${s.device_name}:${s.interface}`
    if (!latestPerKey[key] || s.sampled_at > latestPerKey[key].sampled_at)
      latestPerKey[key] = s
  })
  const deviceRows = Object.values(latestPerKey)
    .sort((a, b) => Number(b.in_mbps) + Number(b.out_mbps) - Number(a.in_mbps) - Number(a.out_mbps))
    .slice(0, 10)
    .map(s => ({ name: `${s.device_name} (${s.interface})`, inMbps: Number(s.in_mbps), outMbps: Number(s.out_mbps) }))

  // KPI totals
  const totalIn  = deviceRows.reduce((s, r) => s + r.inMbps,  0)
  const totalOut = deviceRows.reduce((s, r) => s + r.outMbps, 0)

  return (
    <>
      {/* MikroTik router (live SNMP from the local agent) */}
      <div style={{ marginBottom: 14 }}>
        <MikrotikRouterCard />
      </div>

      {/* KPI row */}
      {hasReal && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 14 }}>
          {[
            { label: 'Total Inbound',  value: `${totalIn.toFixed(2)} Mbps`,  color: '#2f81f7' },
            { label: 'Total Outbound', value: `${totalOut.toFixed(2)} Mbps`, color: '#3fb950' },
            { label: 'Devices Polled', value: `${new Set(samples.map(s => s.device_name)).size}`, color: 'var(--text2)' },
            { label: 'Samples (24h)',  value: `${samples.length}`,           color: 'var(--text2)' },
          ].map(k => (
            <div key={k.label} className="card" style={{ flex: '1 1 140px', padding: '12px 16px' }}>
              <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 4 }}>{k.label}</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: k.color }}>{k.value}</div>
            </div>
          ))}
        </div>
      )}

      <div className="grid-2" style={{ marginBottom: 14 }}>
        {/* Real device bandwidth chart */}
        <div className="card">
          <div className="card-header">
            Top Devices by Bandwidth
            {hasReal
              ? <span style={{ fontSize: 11, color: 'var(--ok)', fontWeight: 400, marginLeft: 8 }}>● live SNMP</span>
              : <span style={{ fontSize: 11, color: 'var(--text3)', fontWeight: 400, marginLeft: 8 }}>waiting for first poll…</span>}
          </div>
          <div className="card-body">
            {hasReal
              ? <DeviceBandwidthChart rows={deviceRows} />
              : <NoTrafficYet />}
          </div>
        </div>

        {/* Top Clients by Bandwidth */}
        <div className="card">
          <div className="card-header">
            {hasReal ? 'Live Interface Bandwidth' : 'Top Clients by Bandwidth'}
          </div>
          <div className="card-body">
            {hasReal ? (
              <table className="tbl">
                <thead><tr><th>Device</th><th>Interface</th><th>↓ In Mbps</th><th>↑ Out Mbps</th></tr></thead>
                <tbody>
                  {Object.values(latestPerKey)
                    .sort((a, b) => Number(b.in_mbps) - Number(a.in_mbps))
                    .slice(0, 8)
                    .map(s => (
                      <tr key={`${s.device_name}:${s.interface}`}>
                        <td><strong>{s.device_name}</strong></td>
                        <td style={{ fontSize: 12, color: 'var(--text3)' }}>{s.interface}</td>
                        <td style={{ color: 'var(--info)' }}>{Number(s.in_mbps).toFixed(4)}</td>
                        <td style={{ color: '#3fb950' }}>{Number(s.out_mbps).toFixed(4)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            ) : (
              <table className="tbl">
                <thead><tr><th>#</th><th>Client</th><th>AP</th><th>Down</th><th>Up</th></tr></thead>
                <tbody>
                  {clients.length === 0 ? (
                    <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>No client data</td></tr>
                  ) : clients.slice(0, 8).map((c, i) => (
                    <tr key={c.id}>
                      <td style={{ color: 'var(--text3)' }}>{i + 1}</td>
                      <td>
                        <div style={{ fontWeight: 500 }}>{c.hostname}</div>
                        <div className="mono" style={{ fontSize: 11, color: 'var(--text3)' }}>{c.mac}</div>
                      </td>
                      <td style={{ fontSize: 12 }}>{c.ap}</td>
                      <td style={{ color: 'var(--info)' }}>{c.tx}</td>
                      <td style={{ color: 'var(--text3)' }}>{c.rx}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {/* WAN / Interface Utilization chart */}
      <div className="card">
        <div className="card-header">
          WAN / Interface Utilization (24h)
          {hasReal
            ? <span style={{ fontSize: 11, color: 'var(--ok)', fontWeight: 400, marginLeft: 8 }}>● live · updates every 30s</span>
            : <span style={{ fontSize: 11, color: 'var(--text3)', fontWeight: 400, marginLeft: 8 }}>waiting for SNMP data…</span>}
        </div>
        <div className="card-body">
          {loading
            ? <div style={{ height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text3)' }}>Loading…</div>
            : <IfaceChart labels={chartLabels} inData={chartIn} outData={chartOut} unit={chartUnit} />}
        </div>
      </div>

      {/* Traffic graph per SNMP device */}
      <SnmpTrafficGraphs />
    </>
  )
}
