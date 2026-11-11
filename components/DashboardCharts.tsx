'use client'

import { useEffect, useRef, useState } from 'react'
import { Chart, registerables } from 'chart.js'
import { supabase } from '@/lib/supabase'

Chart.register(...registerables)

const BASE = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: { display: false },
    tooltip: { backgroundColor: '#161b22', borderColor: '#30363d', borderWidth: 1, titleColor: '#e6edf3', bodyColor: '#8b949e' },
  },
  scales: {
    x: { grid: { color: 'rgba(48,54,61,.5)' }, ticks: { color: '#6e7681', font: { size: 11 } } },
    y: { grid: { color: 'rgba(48,54,61,.5)' }, ticks: { color: '#6e7681', font: { size: 11 } } },
  },
} as const

// ── Network Latency — Last 24h ────────────────────────────────────────────────
// Real data from latency_samples (written by the agent once a minute), shown
// in 15-minute steps:
//   Online  — average ping (ms) of devices that were Online
//   Warning — average ping (ms) of devices in Warning (high latency)
//   Offline — number of devices that were Offline (they don't answer ping,
//             so they have no latency) — right-hand scale
type LatencyRow = { bucket: string; online_ms: number | null; warning_ms: number | null; offline_devices: number }

const BUCKET_MS = 15 * 60 * 1000
const BUCKETS   = 96   // 24 h

export function LatencyChart() {
  const ref = useRef<HTMLCanvasElement>(null)
  const chart = useRef<Chart | null>(null)
  const [note, setNote] = useState<string | null>('Loading latency…')

  useEffect(() => {
    if (!ref.current) return
    chart.current = new Chart(ref.current, {
      data: {
        labels: [],
        datasets: [
          { type: 'line', label: 'Online',  data: [], yAxisID: 'y',  borderColor: '#3fb950', backgroundColor: 'rgba(63,185,80,.10)', fill: true, tension: .35, pointRadius: 0, pointHoverRadius: 4, spanGaps: false },
          { type: 'line', label: 'Warning', data: [], yAxisID: 'y',  borderColor: '#d29922', backgroundColor: 'rgba(210,153,34,.10)', fill: true, tension: .35, pointRadius: 0, pointHoverRadius: 4, spanGaps: false },
          { type: 'bar',  label: 'Offline', data: [], yAxisID: 'y1', backgroundColor: 'rgba(248,81,73,.55)', borderColor: '#f85149', borderWidth: 0, barPercentage: 1, categoryPercentage: .9 },
        ],
      },
      options: {
        ...BASE,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          ...BASE.plugins,
          legend: { display: true, labels: { color: '#8b949e', font: { size: 11 } } },
          tooltip: {
            ...BASE.plugins.tooltip,
            callbacks: {
              label: ctx => {
                const v = ctx.parsed.y
                if (v == null) return `${ctx.dataset.label}: —`
                return ctx.dataset.label === 'Offline'
                  ? `Offline: ${v} device${v === 1 ? '' : 's'}`
                  : `${ctx.dataset.label}: ${v} ms average`
              },
            },
          },
        },
        scales: {
          x:  { ...BASE.scales.x, ticks: { ...BASE.scales.x.ticks, maxTicksLimit: 12, autoSkip: true, maxRotation: 0 } },
          y:  { ...BASE.scales.y, beginAtZero: true, title: { display: true, text: 'Latency (ms)', color: '#6e7681', font: { size: 11 } } },
          y1: { position: 'right', beginAtZero: true, grid: { drawOnChartArea: false },
                ticks: { color: '#f85149', font: { size: 11 }, precision: 0 },
                title: { display: true, text: 'Offline devices', color: '#f85149', font: { size: 11 } } },
        },
      },
    })

    async function load() {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      const { data, error } = await supabase.from('latency_15min').select('*').gte('bucket', since)
      if (error) { setNote('Latency history isn’t set up yet — run supabase/migration_latency_history.sql'); return }

      // 96 fixed 15-minute slots ending now; empty slots stay as gaps
      const byBucket = new Map((data as LatencyRow[]).map(r => [new Date(r.bucket).getTime(), r]))
      const end = Math.floor(Date.now() / BUCKET_MS) * BUCKET_MS
      const labels: string[] = [], online: (number | null)[] = [], warning: (number | null)[] = [], offline: (number | null)[] = []
      for (let i = BUCKETS - 1; i >= 0; i--) {
        const t = end - i * BUCKET_MS
        const r = byBucket.get(t)
        labels.push(new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }))
        online.push(r?.online_ms ?? null)
        warning.push(r?.warning_ms ?? null)
        offline.push(r ? Number(r.offline_devices) || null : null)
      }
      const c = chart.current
      if (!c) return
      c.data.labels = labels
      c.data.datasets[0].data = online
      c.data.datasets[1].data = warning
      c.data.datasets[2].data = offline
      c.update('none')
      setNote(data.length ? null : 'Collecting latency… the first points appear about a minute after the agent starts')
    }

    load()
    const t = setInterval(() => { if (document.visibilityState === 'visible') load() }, 30_000)
    return () => { clearInterval(t); chart.current?.destroy(); chart.current = null }
  }, [])

  return (
    <div style={{ position: 'relative', height: 200 }}>
      <canvas ref={ref} />
      {note && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 12, color: 'var(--text3)', textAlign: 'center', padding: 16, pointerEvents: 'none',
        }}>{note}</div>
      )}
    </div>
  )
}

export function DevicePieChart({ up, warn, down }: { up: number; warn: number; down: number }) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    if (!ref.current) return
    const c = new Chart(ref.current, {
      type: 'doughnut',
      data: {
        labels: ['Online', 'Warning', 'Offline'],
        datasets: [{ data: [up, warn, down], backgroundColor: ['#3fb950', '#d29922', '#f85149'], borderWidth: 0, hoverOffset: 4 }],
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '70%',
        plugins: { legend: { display: true, position: 'bottom', labels: { color: '#8b949e', font: { size: 11 }, padding: 12 } }, tooltip: { backgroundColor: '#161b22', borderColor: '#30363d', borderWidth: 1 } },
      },
    })
    return () => c.destroy()
  }, [up, warn, down])

  return <div style={{ position: 'relative', height: 160 }}><canvas ref={ref} /></div>
}

export function SlaDonutChart({ buildings }: { buildings: { bldg: string; pct: number }[] }) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    if (!ref.current || !buildings.length) return
    const colors = buildings.map(b => b.pct >= 99.5 ? '#3fb950' : b.pct >= 98 ? '#d29922' : '#f85149')
    const c = new Chart(ref.current, {
      type: 'doughnut',
      data: {
        labels: buildings.map(b => b.bldg),
        datasets: [{
          data: buildings.map(() => 1), // equal segments
          backgroundColor: colors,
          borderWidth: 2,
          borderColor: '#0d1117',
          hoverOffset: 6,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '65%',
        plugins: {
          legend: {
            display: true, position: 'bottom',
            labels: { color: '#8b949e', font: { size: 11 }, padding: 10,
              generateLabels: (chart) => buildings.map((b, i) => ({
                text: `${b.bldg}  ${b.pct.toFixed(1)}%`,
                fillStyle: colors[i],
                strokeStyle: colors[i],
                lineWidth: 0,
                index: i,
                hidden: false,
                datasetIndex: 0,
              })),
            },
          },
          tooltip: {
            backgroundColor: '#161b22', borderColor: '#30363d', borderWidth: 1,
            callbacks: {
              label: (ctx) => {
                const b = buildings[ctx.dataIndex]
                return ` ${b.pct.toFixed(1)}% uptime${b.pct < 99.5 ? ' — Below target' : ''}`
              },
            },
          },
        },
      },
    })
    return () => c.destroy()
  }, [buildings])

  const total = buildings.length
  const met   = buildings.filter(b => b.pct >= 99.5).length

  return (
    <div style={{ position: 'relative', height: 220 }}>
      <canvas ref={ref} />
      <div style={{ position: 'absolute', top: '40%', left: '50%', transform: 'translate(-50%,-50%)', textAlign: 'center', pointerEvents: 'none' }}>
        <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text)' }}>{met}/{total}</div>
        <div style={{ fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.05em' }}>met SLA</div>
      </div>
    </div>
  )
}
