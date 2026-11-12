'use client'

// Traffic graph for every SNMP device (Traffic page).
// One chart per device: total inbound / outbound across its interfaces,
// from traffic_samples (written by the agent's SNMP polls). Gaps are shown
// as gaps — no values are filled in when a device wasn't polled.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Chart, registerables } from 'chart.js'
import { supabase } from '@/lib/supabase'
import { usePolling } from '@/lib/usePolling'

Chart.register(...registerables)

type Range = '1h' | '6h' | '24h'
const RANGES: Record<Range, { ms: number; bucketMs: number; label: string }> = {
  '1h':  { ms: 3_600_000,  bucketMs: 60_000,  label: '1 h · 1-min steps' },
  '6h':  { ms: 21_600_000, bucketMs: 300_000, label: '6 h · 5-min steps' },
  '24h': { ms: 86_400_000, bucketMs: 900_000, label: '24 h · 15-min steps' },
}

interface Dev { id: string; name: string; ip: string; type: string; status: string; cpu: number; mem: number; uptime: string | null }
interface Sample { device_name: string; interface: string; in_mbps: number | string; out_mbps: number | string; sampled_at: string }

// A device is "SNMP" when it actually returned SNMP data (not just has a community set)
const answeredSnmp = (d: Dev) => d.cpu > 0 || d.mem > 0 || (!!d.uptime && d.uptime !== '—')
const isLoopback   = (iface: string) => /^lo\d*$|loopback/i.test(iface)

const STATUS: Record<string, [string, string]> = {
  up: ['chip-ok', 'Online'], warn: ['chip-warn', 'Warning'], down: ['chip-crit', 'Offline'],
  maint: ['chip-maint', 'Maintenance'], unreachable: ['chip-off', 'Unreachable'], unknown: ['chip-off', 'Unknown'],
}

function fmtRate(mbps: number) {
  if (mbps >= 1000) return `${(mbps / 1000).toFixed(2)} Gbps`
  if (mbps >= 1)    return `${mbps.toFixed(2)} Mbps`
  return `${(mbps * 1000).toFixed(1)} Kbps`
}

// ── One device's chart ───────────────────────────────────────────────────────
function DeviceChart({ labels, inData, outData, unit }: {
  labels: string[]; inData: (number | null)[]; outData: (number | null)[]; unit: string
}) {
  const ref   = useRef<HTMLCanvasElement>(null)
  const chart = useRef<Chart | null>(null)

  useEffect(() => {
    if (!ref.current) return
    chart.current = new Chart(ref.current, {
      type: 'line',
      data: { labels: [], datasets: [
        { label: 'Inbound',  data: [], borderColor: '#2f81f7', backgroundColor: 'rgba(47,129,247,.08)', fill: true, tension: .3, pointRadius: 0, borderWidth: 2 },
        { label: 'Outbound', data: [], borderColor: '#3fb950', tension: .3, pointRadius: 0, borderWidth: 2 },
      ] },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: true, labels: { color: '#8b949e', font: { size: 11 }, boxWidth: 12 } },
          tooltip: { backgroundColor: '#161b22', borderColor: '#30363d', borderWidth: 1, titleColor: '#e6edf3', bodyColor: '#8b949e' },
        },
        scales: {
          x: { grid: { color: 'rgba(48,54,61,.25)' }, ticks: { color: '#6e7681', font: { size: 10 }, maxTicksLimit: 8, maxRotation: 0 } },
          y: { beginAtZero: true, grid: { color: 'rgba(48,54,61,.25)' }, ticks: { color: '#6e7681', font: { size: 10 } } },
        },
      },
    })
    return () => { chart.current?.destroy(); chart.current = null }
  }, [])

  // Update in place (no flicker when new samples arrive)
  useEffect(() => {
    const c = chart.current
    if (!c) return
    c.data.labels = labels
    c.data.datasets[0].data = inData
    c.data.datasets[1].data = outData
    c.data.datasets[0].label = `Inbound (${unit})`
    c.data.datasets[1].label = `Outbound (${unit})`
    c.update('none')
  }, [labels, inData, outData, unit])

  return <div style={{ position: 'relative', height: 170 }}><canvas ref={ref} /></div>
}

// ── All SNMP devices ─────────────────────────────────────────────────────────
export default function SnmpTrafficGraphs() {
  const [range,   setRange]   = useState<Range>('6h')
  const [devices, setDevices] = useState<Dev[]>([])
  const [samples, setSamples] = useState<Sample[]>([])
  const [loaded,  setLoaded]  = useState(false)
  const [now,     setNow]     = useState(() => Date.now())
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(async () => {
    const t = Date.now()
    const since = new Date(t - RANGES[range].ms).toISOString()
    const { data: devs } = await supabase.from('devices').select('id, name, ip, type, status, cpu, mem, uptime').order('name')
    const snmpDevs = ((devs ?? []) as Dev[]).filter(answeredSnmp)

    // Page through the samples — a single request is capped at 1000 rows
    const rows: Sample[] = []
    if (snmpDevs.length) {
      const names = snmpDevs.map(d => d.name)
      for (let from = 0; from < 50_000; from += 1000) {
        const { data, error } = await supabase.from('traffic_samples')
          .select('device_name, interface, in_mbps, out_mbps, sampled_at')
          .gte('sampled_at', since).in('device_name', names)
          .order('sampled_at').range(from, from + 999)
        if (error || !data?.length) break
        rows.push(...(data as Sample[]))
        if (data.length < 1000) break
      }
    }
    setDevices(snmpDevs); setSamples(rows); setNow(t); setLoaded(true)
  }, [range])

  useEffect(() => {
    load()
    const ch = supabase.channel('snmp-traffic-graphs')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'traffic_samples' }, () => {
        if (pending.current) return
        pending.current = setTimeout(() => { pending.current = null; load() }, 2000)   // a poll writes several rows at once
      })
      .subscribe()
    return () => { supabase.removeChannel(ch); if (pending.current) clearTimeout(pending.current) }
  }, [load])
  usePolling(load, 30_000)   // fallback if realtime isn't enabled

  // Per device: sum interfaces at each poll, then average per time step
  const graphs = useMemo(() => {
    const { ms, bucketMs } = RANGES[range]
    const start = Math.floor((now - ms) / bucketMs) * bucketMs
    const steps = Math.floor((now - start) / bucketMs) + 1
    const labels = Array.from({ length: steps }, (_, i) =>
      new Date(start + i * bucketMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))

    return devices.map(d => {
      const mine = samples.filter(s => s.device_name === d.name && !isLoopback(s.interface))
      const ifaces = [...new Set(mine.map(s => s.interface))].sort()

      const perPoll = new Map<string, { in: number; out: number }>()   // sampled_at → totals
      for (const s of mine) {
        const p = perPoll.get(s.sampled_at) ?? { in: 0, out: 0 }
        p.in += Number(s.in_mbps) || 0; p.out += Number(s.out_mbps) || 0
        perPoll.set(s.sampled_at, p)
      }
      const buckets = Array.from({ length: steps }, () => ({ in: 0, out: 0, n: 0 }))
      for (const [at, v] of perPoll) {
        const i = Math.floor((new Date(at).getTime() - start) / bucketMs)
        if (i < 0 || i >= steps) continue
        buckets[i].in += v.in; buckets[i].out += v.out; buckets[i].n++
      }
      const inMbps  = buckets.map(b => b.n ? b.in  / b.n : null)
      const outMbps = buckets.map(b => b.n ? b.out / b.n : null)

      const polls  = [...perPoll.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      const latest = polls.at(-1)
      const peakIn  = Math.max(0, ...polls.map(p => p[1].in))
      const peakOut = Math.max(0, ...polls.map(p => p[1].out))
      const kbps = Math.max(peakIn, peakOut) < 1
      const scale = (arr: (number | null)[]) => arr.map(v => v === null ? null : +(kbps ? v * 1000 : v).toFixed(3))

      return {
        d, ifaces, labels,
        inData: scale(inMbps), outData: scale(outMbps), unit: kbps ? 'Kbps' : 'Mbps',
        latest: latest ? { at: latest[0], ...latest[1] } : null, peakIn, peakOut,
      }
    })
  }, [devices, samples, range, now])

  return (
    <div className="card" style={{ marginTop: 14 }}>
      <div className="card-header" style={{ flexWrap: 'wrap', gap: 8 }}>
        SNMP Device Traffic
        <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--text3)' }}>
          total in / out across each device&apos;s interfaces · {RANGES[range].label}
        </span>
        <div className="card-header-actions" style={{ display: 'flex', gap: 4 }}>
          {(Object.keys(RANGES) as Range[]).map(r => (
            <button key={r} suppressHydrationWarning onClick={() => setRange(r)}
                    className={`btn btn-sm${r === range ? ' btn-primary' : ''}`}>{r}</button>
          ))}
        </div>
      </div>
      <div className="card-body">
        {!loaded ? (
          <div style={{ height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text3)' }}>Loading…</div>
        ) : graphs.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text3)', fontSize: 13 }}>
            No SNMP devices yet. Add one with <strong>+ Add Device</strong> — devices that answer SNMP get a graph here.
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 460px), 1fr))', gap: 14 }}>
            {graphs.map(g => {
              const [cls, label] = STATUS[g.d.status] ?? ['chip-off', g.d.status]
              const fresh = g.latest && now - new Date(g.latest.at).getTime() < 5 * 60_000
              return (
                <div key={g.d.id} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px', minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 2 }}>
                    <strong>{g.d.name}</strong>
                    <span className="mono" style={{ color: 'var(--text3)' }}>{g.d.ip}</span>
                    <span className={`chip ${cls}`}>{label}</span>
                    <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text3)' }}>{g.d.type}</span>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 8 }}>
                    {g.latest
                      ? <>{fresh ? 'Now' : `Last sample ${new Date(g.latest.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}{' '}
                          <span style={{ color: 'var(--info)' }}>↓ {fmtRate(g.latest.in)}</span>{' '}
                          <span style={{ color: 'var(--ok)' }}>↑ {fmtRate(g.latest.out)}</span>
                          {' · '}peak ↓ {fmtRate(g.peakIn)} ↑ {fmtRate(g.peakOut)}
                          {' · '}{g.ifaces.join(', ')}</>
                      : 'No traffic samples in this period'}
                  </div>
                  {g.latest
                    ? <DeviceChart labels={g.labels} inData={g.inData} outData={g.outData} unit={g.unit} />
                    : <div style={{ height: 170, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text3)', fontSize: 12, background: 'var(--surface2)', borderRadius: 6 }}>
                        Waiting for SNMP traffic data
                      </div>}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
