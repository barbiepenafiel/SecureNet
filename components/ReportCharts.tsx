'use client'

import { useEffect, useRef } from 'react'
import { Chart, registerables } from 'chart.js'

Chart.register(...registerables)

const TIP = {
  backgroundColor: '#1c2128',
  borderColor: '#30363d',
  borderWidth: 1,
  titleColor: '#e6edf3',
  bodyColor: '#8b949e',
}
const GRID = 'rgba(48,54,61,.5)'
const TICK = { color: '#6e7681', font: { size: 10 } } as const

export function LatencyTrendChart({ labels, avg, min, max }: {
  labels: string[]; avg: number[]; min: number[]; max: number[]
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    if (!ref.current) return
    const c = new Chart(ref.current, {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: 'Avg Latency (ms)', data: avg, borderColor: '#22c55e', backgroundColor: 'rgba(34,197,94,.1)', fill: true, tension: .4, pointRadius: 2, pointHoverRadius: 4 },
          { label: 'Min (ms)',         data: min, borderColor: '#3fb950', borderDash: [4,3], tension: .4, pointRadius: 0, fill: false },
          { label: 'Max (ms)',         data: max, borderColor: '#f85149', borderDash: [4,3], tension: .4, pointRadius: 0, fill: false },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: true, labels: { color: '#8b949e', font: { size: 11 }, boxWidth: 24, padding: 16 } }, tooltip: TIP },
        scales: {
          x: { grid: { color: GRID }, ticks: { ...TICK, maxTicksLimit: 8 } },
          y: { grid: { color: GRID }, ticks: TICK },
        },
      },
    })
    return () => c.destroy()
  }, [labels, avg, min, max])
  return <div style={{ position: 'relative', height: 220 }}><canvas ref={ref} /></div>
}

export function AlertBreakdownChart({ crit, warn, acked }: { crit: number; warn: number; acked: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const unackedCrit = Math.max(0, crit - acked)
  useEffect(() => {
    if (!ref.current) return
    // Show placeholder slice so chart never renders empty
    const data   = [unackedCrit, warn, acked]
    const hasAny = data.some(v => v > 0)
    const c = new Chart(ref.current, {
      type: 'doughnut',
      data: {
        labels: ['Critical (Unresolved)', 'Warning', 'Acknowledged'],
        datasets: [{
          data: hasAny ? data : [1],
          backgroundColor: hasAny ? ['#f85149', '#d29922', '#22c55e'] : ['#30363d'],
          borderWidth: 0, hoverOffset: 6,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '65%',
        plugins: {
          legend: {
            display: hasAny,
            position: 'bottom',
            labels: { color: '#8b949e', font: { size: 11 }, padding: 12 },
          },
          tooltip: hasAny ? TIP : { enabled: false },
        },
      },
    })
    return () => c.destroy()
  }, [unackedCrit, warn, acked])

  const total = crit + warn
  return (
    <div style={{ position: 'relative', height: 240 }}>
      <canvas ref={ref} />
      {/* Centre label */}
      <div style={{ position: 'absolute', top: '42%', left: '50%', transform: 'translate(-50%,-50%)', textAlign: 'center', pointerEvents: 'none' }}>
        <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--text)' }}>{total}</div>
        <div style={{ fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.05em' }}>alerts</div>
      </div>
    </div>
  )
}

export function IncidentFrequencyChart({ labels, downtime, highLatency, recovery }: {
  labels: string[]; downtime: number[]; highLatency: number[]; recovery: number[]
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    if (!ref.current) return
    const c = new Chart(ref.current, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: 'Downtime',     data: downtime,    backgroundColor: '#f85149', stack: 'a', borderRadius: 2 },
          { label: 'High Latency', data: highLatency, backgroundColor: '#d29922', stack: 'a', borderRadius: 2 },
          { label: 'Recovery',     data: recovery,    backgroundColor: '#22c55e', stack: 'a', borderRadius: 2 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: true, labels: { color: '#8b949e', font: { size: 11 }, boxWidth: 12, padding: 12 } }, tooltip: TIP },
        scales: {
          x: { stacked: true, grid: { color: GRID }, ticks: TICK },
          y: { stacked: true, grid: { color: GRID }, ticks: TICK },
        },
      },
    })
    return () => c.destroy()
  }, [labels, downtime, highLatency, recovery])
  return <div style={{ position: 'relative', height: 220 }}><canvas ref={ref} /></div>
}

export function PeakFailureHoursChart({ labels, counts }: { labels: string[]; counts: number[] }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    if (!ref.current) return
    const max = Math.max(...counts)
    const colors = counts.map(v => v === max && max > 0 ? '#f85149' : '#d29922')
    const c = new Chart(ref.current, {
      type: 'bar',
      data: { labels, datasets: [{ label: 'Incidents', data: counts, backgroundColor: colors, borderRadius: 2 }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: TIP },
        scales: {
          x: { grid: { color: GRID }, ticks: { ...TICK, maxTicksLimit: 12 } },
          y: { grid: { color: GRID }, ticks: TICK },
        },
      },
    })
    return () => c.destroy()
  }, [labels, counts])
  return <div style={{ position: 'relative', height: 220 }}><canvas ref={ref} /></div>
}

export function TopDevicesChart({ labels, counts }: { labels: string[]; counts: number[] }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    if (!ref.current) return
    const max = Math.max(...counts)
    const colors = counts.map(v => v === max && max > 0 ? '#f85149' : '#2f81f7')
    const c = new Chart(ref.current, {
      type: 'bar',
      data: { labels, datasets: [{ label: 'Incidents', data: counts, backgroundColor: colors, borderRadius: 2 }] },
      options: {
        indexAxis: 'y',
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: TIP },
        scales: {
          x: { grid: { color: GRID }, ticks: TICK },
          y: { grid: { display: false }, ticks: { color: '#8b949e', font: { size: 10 } } },
        },
      },
    })
    return () => c.destroy()
  }, [labels, counts])
  return <div style={{ position: 'relative', height: Math.max(180, labels.length * 32) }}><canvas ref={ref} /></div>
}

export function LocationHealthChart({ labels, uptime, downtime }: {
  labels: string[]; uptime: number[]; downtime: number[]
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    if (!ref.current) return
    const c = new Chart(ref.current, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: 'Uptime',   data: uptime,   backgroundColor: '#22c55e', stack: 'a' },
          { label: 'Downtime', data: downtime,  backgroundColor: '#f85149', stack: 'a' },
        ],
      },
      options: {
        indexAxis: 'y',
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: true, labels: { color: '#8b949e', font: { size: 11 }, boxWidth: 12 } }, tooltip: TIP },
        scales: {
          x: { stacked: true, max: 100, grid: { color: GRID }, ticks: { ...TICK, callback: (v) => v + '%' } },
          y: { stacked: true, grid: { display: false }, ticks: { color: '#8b949e', font: { size: 10 } } },
        },
      },
    })
    return () => c.destroy()
  }, [labels, uptime, downtime])
  return <div style={{ position: 'relative', height: Math.max(160, labels.length * 40) }}><canvas ref={ref} /></div>
}

export function UptimeDowntimeChart({ labels, uptime, downtime }: {
  labels: string[]; uptime: number[]; downtime: number[]
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    if (!ref.current) return
    const c = new Chart(ref.current, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: 'Uptime',   data: uptime,  backgroundColor: '#22c55e', stack: 'a', barThickness: 12 },
          { label: 'Downtime', data: downtime, backgroundColor: '#f85149', stack: 'a', barThickness: 12 },
        ],
      },
      options: {
        indexAxis: 'y',
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: true, labels: { color: '#8b949e', font: { size: 11 }, boxWidth: 12 } }, tooltip: TIP },
        scales: {
          x: { stacked: true, max: 100, grid: { color: GRID }, ticks: { ...TICK, callback: (v) => v + '%' } },
          y: { stacked: true, grid: { display: false }, ticks: { color: '#6e7681', font: { size: 9 } } },
        },
      },
    })
    return () => c.destroy()
  }, [labels, uptime, downtime])
  return <div style={{ position: 'relative', height: labels.length * 20 + 50 }}><canvas ref={ref} /></div>
}
