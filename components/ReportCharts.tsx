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

// Minutes → "3d 4h", "5h 12m", "42m"
export function fmtDurationMin(min: number) {
  const m = Math.max(0, Math.round(min))
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60
  return d ? `${d}d ${h}h` : h ? `${h}h ${mm}m` : `${mm}m`
}

// unit 'pct': uptime/downtime are percentages (0–100) — stacked bars.
// unit 'min': uptime/downtime are measured minutes Online / Offline — a line
// chart in the dashboard theme colors: one point per device for each line, dotted guide
// lines down to the axis, time (minutes, hours or days to suit the period)
// on the vertical axis, exact time and share in the tooltip.
// `notes` (time view): one extra tooltip line per device, e.g. "Now: Online"
export function UptimeDowntimeChart({ labels, uptime, downtime, unit = 'pct', notes }: {
  labels: string[]; uptime: number[]; downtime: number[]; unit?: 'pct' | 'min'; notes?: string[]
}) {
  if (unit === 'min') return <UptimeDowntimeLines labels={labels} uptime={uptime} downtime={downtime} notes={notes} />
  return <UptimeDowntimeBars labels={labels} uptime={uptime} downtime={downtime} />
}

function UptimeDowntimeBars({ labels, uptime, downtime }: { labels: string[]; uptime: number[]; downtime: number[] }) {
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

// Colors from the dashboard theme (app/globals.css :root), read when the
// chart is drawn; the fallbacks are the same values
function themeColors() {
  const css = typeof window !== 'undefined' ? getComputedStyle(document.documentElement) : null
  const v = (name: string, fallback: string) => css?.getPropertyValue(name).trim() || fallback
  return {
    surface: v('--surface', '#ffffff'),
    grid:    v('--border',  '#d0e4d8'),
    axis:    v('--border2', '#b8d4c4'),
    text:    v('--text3',   '#6b8a76'),
    up:      v('--ok',      '#16a34a'),
    down:    v('--warn',    '#d97706'),
  }
}

function UptimeDowntimeLines({ labels, uptime, downtime, notes }: { labels: string[]; uptime: number[]; downtime: number[]; notes?: string[] }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    if (!ref.current) return
    const T = themeColors()
    const longest = Math.max(0, ...uptime, ...downtime)
    const [div, suffix, unitName] = longest >= 2 * 1440 ? [1440, 'd', 'Days'] : longest >= 120 ? [60, 'h', 'Hours'] : [1, 'm', 'Minutes']
    const scale = (arr: number[]) => arr.map(v => Math.round((v / div) * 100) / 100)
    // Short x labels: the device name without the "(ip)" suffix (full label in the tooltip)
    const short = labels.map(l => {
      // "Device 192.168.0.10" → "192.168.0.10", so the part that differs stays visible
      const name = l.replace(/\s*\([\d.]+\)\s*$/, '').replace(/^Device\s+/, '')
      return name.length > 16 ? name.slice(0, 15) + '…' : name
    })

    // Dotted guide line from each device's higher point down to the axis
    const dropLines = {
      id: 'dropLines',
      beforeDatasetsDraw(chart: Chart) {
        const { ctx, chartArea } = chart
        const a = chart.getDatasetMeta(0), b = chart.getDatasetMeta(1)
        ctx.save()
        ctx.setLineDash([2, 3])
        ctx.lineWidth = 1
        ctx.strokeStyle = T.axis
        a.data.forEach((p, i) => {
          const pa = p as unknown as { x: number; y: number }
          const pb = b.data[i] as unknown as { x: number; y: number } | undefined
          const top = Math.min(pa.y, pb?.y ?? pa.y)
          ctx.beginPath()
          ctx.moveTo(pa.x, top)
          ctx.lineTo(pa.x, chartArea.bottom)
          ctx.stroke()
        })
        ctx.restore()
      },
    }

    const line = (label: string, data: number[], color: string) => ({
      label, data, borderColor: color, backgroundColor: color,
      borderWidth: 2, tension: 0,
      pointRadius: 4, pointHoverRadius: 6, pointBorderWidth: 2,
      pointBackgroundColor: T.surface, pointBorderColor: color,
    })

    const c = new Chart(ref.current, {
      type: 'line',
      data: {
        labels: short,
        datasets: [line('Uptime', scale(uptime), T.up), line('Downtime', scale(downtime), T.down)],
      },
      plugins: [dropLines],
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        layout: { padding: { top: 8, right: 12 } },
        plugins: {
          legend: {
            position: 'bottom',
            labels: { color: T.text, font: { size: 11 }, boxWidth: 18, boxHeight: 2, padding: 18 },
          },
          tooltip: {
            ...TIP,
            callbacks: {
              title: (items) => labels[items[0]?.dataIndex ?? 0] ?? '',
              footer: (items) => notes?.[items[0]?.dataIndex ?? -1] ?? '',
              label: (ctx) => {
                const i = ctx.dataIndex
                const min = (ctx.datasetIndex === 0 ? uptime : downtime)[i] ?? 0
                const all = (uptime[i] ?? 0) + (downtime[i] ?? 0)
                const pct = all ? Math.round((min / all) * 1000) / 10 : 0
                return ` ${ctx.dataset.label}: ${fmtDurationMin(min)} (${pct}%)`
              },
            },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            border: { color: T.axis },
            ticks: { color: T.text, font: { size: 9 }, maxRotation: 45, minRotation: 45, autoSkip: false },
          },
          y: {
            beginAtZero: true,
            grid: { color: T.grid },
            border: { color: T.axis },
            ticks: { color: T.text, font: { size: 10 }, callback: (v) => `${v}${suffix}` },
            title: { display: true, text: unitName, color: T.text, font: { size: 11 } },
          },
        },
      },
    })
    return () => c.destroy()
  }, [labels, uptime, downtime, notes])
  return (
    <div style={{ position: 'relative', height: 340 }}><canvas ref={ref} /></div>
  )
}

// Data transferred per SNMP device in the report period (bytes → KB/MB/GB)
export function fmtBytes(b: number) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0, v = b
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(i ? 1 : 0)} ${units[i]}`
}

export function SnmpTrafficVolumeChart({ labels, inBytes, outBytes }: {
  labels: string[]; inBytes: number[]; outBytes: number[]
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    if (!ref.current) return
    const c = new Chart(ref.current, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: 'Data In',  data: inBytes,  backgroundColor: '#2f81f7', borderRadius: 3, barThickness: 12 },
          { label: 'Data Out', data: outBytes, backgroundColor: '#3fb950', borderRadius: 3, barThickness: 12 },
        ],
      },
      options: {
        indexAxis: 'y',
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: true, labels: { color: '#8b949e', font: { size: 11 }, boxWidth: 12 } },
          tooltip: { ...TIP, callbacks: { label: (ctx) => ` ${ctx.dataset.label}: ${fmtBytes(Number(ctx.raw))}` } },
        },
        scales: {
          x: { beginAtZero: true, grid: { color: GRID }, ticks: { ...TICK, callback: (v) => fmtBytes(Number(v)) } },
          y: { grid: { display: false }, ticks: { color: '#6e7681', font: { size: 10 } } },
        },
      },
    })
    return () => c.destroy()
  }, [labels, inBytes, outBytes])
  return <div style={{ position: 'relative', height: labels.length * 36 + 60 }}><canvas ref={ref} /></div>
}

// One device's availability over time: share of measured minutes Online in
// each step. A step with nothing measured is a gap (not 0 % and not 100 %).
export function AvailabilityTrendChart({ labels, uptimePct, details }: {
  labels: string[]
  uptimePct: (number | null)[]
  details: string[]            // tooltip line per step, e.g. "Online 14m · Offline 1m"
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    if (!ref.current) return
    const T = themeColors()
    const c = new Chart(ref.current, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'Availability', data: uptimePct, spanGaps: false,
          borderColor: T.up, backgroundColor: T.up + '22', fill: 'origin',
          borderWidth: 2, tension: 0.25,
          pointRadius: labels.length > 60 ? 0 : 3, pointHoverRadius: 5,
          pointBackgroundColor: T.surface, pointBorderColor: T.up, pointBorderWidth: 2,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            ...TIP,
            callbacks: {
              label: (ctx) => ctx.raw == null ? ' Not measured' : ` Online ${ctx.raw}% of measured time`,
              afterLabel: (ctx) => details[ctx.dataIndex] ?? '',
            },
          },
        },
        scales: {
          x: { grid: { display: false }, border: { color: T.axis }, ticks: { color: T.text, font: { size: 10 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } },
          y: { min: 0, max: 100, grid: { color: T.grid }, border: { color: T.axis }, ticks: { color: T.text, font: { size: 10 }, callback: (v) => `${v}%` } },
        },
      },
    })
    return () => c.destroy()
  }, [labels, uptimePct, details])
  return <div style={{ position: 'relative', height: 220 }}><canvas ref={ref} /></div>
}
