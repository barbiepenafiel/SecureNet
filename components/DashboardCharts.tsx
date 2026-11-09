'use client'

import { useEffect, useRef } from 'react'
import { Chart, registerables } from 'chart.js'

Chart.register(...registerables)

function hrs24() { return Array.from({ length: 24 }, (_, i) => `${i}:00`) }
// Deterministic 24h traffic (Mbps) — business-hours curve, no Math.random()
const INBOUND  = [120,110,105,100,108,130,185,295,485,565,595,615,625,595,585,605,560,490,380,278,208,178,158,138]
const OUTBOUND = [ 60, 54, 52, 50, 55, 65, 92,148,243,283,298,308,312,297,292,302,282,247,192,138,105, 90, 80, 70]

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

export function TrafficChart() {
  const ref = useRef<HTMLCanvasElement>(null)
  const chart = useRef<Chart | null>(null)

  useEffect(() => {
    if (!ref.current) return
    chart.current = new Chart(ref.current, {
      type: 'line',
      data: {
        labels: hrs24(),
        datasets: [
          { label: 'Inbound',  data: INBOUND,  borderColor: '#2f81f7', backgroundColor: 'rgba(47,129,247,.1)', fill: true, tension: .4, pointRadius: 0 },
          { label: 'Outbound', data: OUTBOUND, borderColor: '#3fb950', backgroundColor: 'rgba(63,185,80,.07)',  fill: true, tension: .4, pointRadius: 0 },
        ],
      },
      options: { ...BASE, plugins: { ...BASE.plugins, legend: { display: true, labels: { color: '#8b949e', font: { size: 11 } } } } },
    })
    return () => chart.current?.destroy()
  }, [])

  return (
    <div style={{ position: 'relative', height: 200 }}>
      <canvas ref={ref} />
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
