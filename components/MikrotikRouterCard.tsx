'use client'

// Live MikroTik router panel for the dashboard.
// Data comes from the local agent (poller/mikrotik.js), which polls the router
// over SNMP every 15 s and writes mikrotik_routers / mikrotik_interfaces.
// Updates arrive by Supabase realtime, with a 10 s poll as a fallback.

import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { usePolling } from '@/lib/usePolling'

interface Router {
  device_id: string; device_name: string; ip: string
  identity: string | null; description: string | null; board: string | null
  ros_version: string | null; firmware: string | null; serial: string | null
  sys_location: string | null
  uptime_seconds: number | null; cpu_load: number | null; cpu_cores: number | null
  mem_total_bytes: number | null; mem_used_bytes: number | null
  disk_total_bytes: number | null; disk_used_bytes: number | null
  temperature_c: number | null; voltage_v: number | null
  reachable: boolean; last_error: string | null; polled_at: string
}

interface Iface {
  device_id: string; if_index: number; name: string | null; alias: string | null
  if_type: number | null; mac: string | null; mtu: number | null; speed_mbps: number | null
  admin_status: string | null; oper_status: string | null; ip_addresses: string[] | null
  in_bps: number | null; out_bps: number | null
  in_octets: number | string | null; out_octets: number | string | null
  in_errors: number | null; out_errors: number | null
  in_discards: number | null; out_discards: number | null
}

const STALE_MS = 60_000   // no poll for a minute → the agent isn't reporting

// ── Formatting ───────────────────────────────────────────────────────────────
function fmtBps(bps: number | null) {
  if (bps === null || bps === undefined) return '—'
  if (bps >= 1e9) return `${(bps / 1e9).toFixed(2)} Gbps`
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(2)} Mbps`
  if (bps >= 1e3) return `${(bps / 1e3).toFixed(1)} Kbps`
  return `${bps} bps`
}
function fmtBytes(b: number | string | null) {
  const n = Number(b)
  if (b === null || b === undefined || !Number.isFinite(n)) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0, v = n
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(i ? 1 : 0)} ${units[i]}`
}
function fmtUptime(secs: number | null) {
  if (secs === null || secs === undefined) return '—'
  const d = Math.floor(secs / 86400), h = Math.floor((secs % 86400) / 3600), m = Math.floor((secs % 3600) / 60)
  return d > 0 ? `${d}d ${h}h ${m}m` : `${h}h ${m}m`
}
function fmtSpeed(mbps: number | null) {
  if (!mbps) return '—'
  return mbps >= 1000 ? `${mbps / 1000} Gbps` : `${mbps} Mbps`
}
function ago(iso: string, now: number) {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000))
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`
}
const pct = (used: number | null, total: number | null) =>
  used !== null && total ? Math.round((used / total) * 100) : null
const barCls = (p: number) => p >= 90 ? 'pbar-crit' : p >= 75 ? 'pbar-warn' : 'pbar-ok'

function ifaceChip(i: Iface, live: boolean) {
  if (!live)                     return <span className="chip chip-off">Unknown</span>
  if (i.admin_status === 'down') return <span className="chip chip-off">Disabled</span>
  if (i.oper_status === 'up')    return <span className="chip chip-ok">Up</span>
  return <span className="chip chip-crit">Down</span>
}

// ── Pieces ───────────────────────────────────────────────────────────────────
function Stat({ label, value, sub, bar }: { label: string; value: string; sub?: string; bar?: number | null }) {
  return (
    <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px', minWidth: 0 }}>
      <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>{sub}</div>}
      {bar !== undefined && bar !== null && (
        <div className="pbar" style={{ marginTop: 6 }}>
          <div className={`pbar-fill ${barCls(bar)}`} style={{ width: `${Math.min(100, bar)}%` }} />
        </div>
      )}
    </div>
  )
}

function RouterPanel({ r, ifaces, now }: { r: Router; ifaces: Iface[]; now: number }) {
  const stale    = now - new Date(r.polled_at).getTime() > STALE_MS
  const hasData  = r.uptime_seconds !== null
  // Live = the router answered the latest poll. Otherwise nothing is shown
  // as current: live values become "—" / Unknown, older ones are labelled "last".
  const live     = r.reachable && !stale
  // Uptime keeps counting between polls
  const uptime   = hasData && live
    ? r.uptime_seconds! + Math.max(0, Math.floor((now - new Date(r.polled_at).getTime()) / 1000))
    : r.uptime_seconds
  const memPct   = pct(r.mem_used_bytes, r.mem_total_bytes)
  const diskPct  = pct(r.disk_used_bytes, r.disk_total_bytes)
  const rows     = ifaces.filter(i => i.if_type !== 24)   // hide loopback
    .sort((a, b) => a.if_index - b.if_index)
  const upCount  = rows.filter(i => i.oper_status === 'up' && i.admin_status !== 'down').length
  const totalIn  = rows.reduce((s, i) => s + (i.oper_status === 'up' ? i.in_bps ?? 0 : 0), 0)
  const totalOut = rows.reduce((s, i) => s + (i.oper_status === 'up' ? i.out_bps ?? 0 : 0), 0)

  return (
    <div className="card">
      <div className="card-header" style={{ flexWrap: 'wrap', gap: 8 }}>
        <span>📶 MikroTik Router — {r.identity ?? r.device_name}</span>
        <span className="mono" style={{ fontWeight: 400, color: 'var(--text3)' }}>{r.ip}</span>
        {!r.reachable
          ? <span className="chip chip-crit">No SNMP response</span>
          : stale
            ? <span className="chip chip-warn">Stale — agent not reporting</span>
            : <span className="chip chip-ok">SNMP Detected</span>}
        <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 400, color: 'var(--text3)' }}>
          updated {ago(r.polled_at, now)} · every 15 s
        </span>
      </div>

      <div className="card-body">
        {!r.reachable && (
          <div style={{ border: '1px solid var(--crit)', background: 'rgba(248,81,73,.08)', borderRadius: 8, padding: '10px 12px', marginBottom: 14, fontSize: 12, lineHeight: 1.6 }}>
            {hasData ? (
              <><strong style={{ color: 'var(--crit)' }}>Lost contact with the router.</strong>{' '}
                It stopped answering SNMP — it may be powered off, unplugged, or its SNMP settings changed.
                Live status and traffic are hidden until it answers again; values marked &ldquo;last&rdquo; are from the last successful poll.</>
            ) : (
              <><strong style={{ color: 'var(--crit)' }}>The router isn&apos;t answering SNMP.</strong>{' '}{r.last_error}</>
            )}
          </div>
        )}
        {r.reachable && stale && (
          <div style={{ border: '1px solid var(--warn)', background: 'rgba(210,153,34,.08)', borderRadius: 8, padding: '10px 12px', marginBottom: 14, fontSize: 12, lineHeight: 1.6 }}>
            <strong style={{ color: 'var(--warn)' }}>The SecureNet agent stopped reporting.</strong>{' '}
            The router&apos;s current state is unknown — check that the agent is running (<code className="mono">pm2 status securenet</code>).
          </div>
        )}

        {hasData && (
          <>
            {/* Identity */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 18px', fontSize: 12, color: 'var(--text2)', marginBottom: 12 }}>
              <span>Model <strong>{r.board ? `MikroTik ${r.board}` : '—'}</strong></span>
              <span>RouterOS <strong>{r.ros_version ?? '—'}</strong></span>
              <span>Firmware <strong>{r.firmware ?? '—'}</strong></span>
              <span>Serial <strong className="mono">{r.serial ?? '—'}</strong></span>
              {r.sys_location && <span>Location <strong>{r.sys_location}</strong></span>}
            </div>

            {/* Health */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10, marginBottom: 14 }}>
              <Stat label="Uptime" value={live ? fmtUptime(uptime) : '—'}
                    sub={live ? undefined : `last: ${fmtUptime(r.uptime_seconds)}`} />
              <Stat label="CPU load" value={live && r.cpu_load !== null ? `${r.cpu_load}%` : '—'}
                    sub={live ? (r.cpu_cores ? `${r.cpu_cores} cores` : undefined) : `last: ${r.cpu_load ?? '—'}%`}
                    bar={live ? r.cpu_load : null} />
              <Stat label="Memory" value={live && memPct !== null ? `${memPct}%` : '—'}
                    sub={live ? `${fmtBytes(r.mem_used_bytes)} of ${fmtBytes(r.mem_total_bytes)}` : `last: ${memPct ?? '—'}%`}
                    bar={live ? memPct : null} />
              <Stat label="Storage" value={live && diskPct !== null ? `${diskPct}%` : '—'}
                    sub={live ? `${fmtBytes(r.disk_used_bytes)} of ${fmtBytes(r.disk_total_bytes)}` : `last: ${diskPct ?? '—'}%`}
                    bar={live ? diskPct : null} />
              <Stat label="Traffic now" value={live ? `↓ ${fmtBps(totalIn)}` : '—'}
                    sub={live ? `↑ ${fmtBps(totalOut)}` : 'no data from router'} />
              {(r.temperature_c !== null || r.voltage_v !== null) && (
                <Stat label="Health"
                      value={!live ? '—' : r.temperature_c !== null ? `${Number(r.temperature_c)} °C` : `${Number(r.voltage_v)} V`}
                      sub={!live
                        ? `last: ${[r.temperature_c !== null && `${Number(r.temperature_c)} °C`, r.voltage_v !== null && `${Number(r.voltage_v)} V`].filter(Boolean).join(' · ')}`
                        : r.temperature_c !== null && r.voltage_v !== null ? `${Number(r.voltage_v)} V supply` : undefined} />
              )}
            </div>

            {/* Interfaces */}
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
              Interfaces <span style={{ fontWeight: 400, color: live ? 'var(--text3)' : 'var(--crit)' }}>
                {live ? `${upCount} of ${rows.length} up` : 'status unknown — router not answering'}
              </span>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Interface</th><th>Status</th><th>IP Address</th><th>MAC</th><th>Speed</th>
                    <th>↓ In</th><th>↑ Out</th><th>Total RX / TX</th><th>Errors / Drops</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr><td colSpan={9} style={{ textAlign: 'center', color: 'var(--text3)', padding: 18 }}>No interface data yet</td></tr>
                  ) : rows.map(i => {
                    const errs  = (i.in_errors ?? 0) + (i.out_errors ?? 0)
                    const drops = (i.in_discards ?? 0) + (i.out_discards ?? 0)
                    return (
                      <tr key={i.if_index}>
                        <td>
                          <strong>{i.name ?? `if${i.if_index}`}</strong>
                          {i.alias && <div style={{ fontSize: 11, color: 'var(--text3)' }}>{i.alias}</div>}
                        </td>
                        <td>{ifaceChip(i, live)}</td>
                        <td className="mono">{i.ip_addresses?.length ? i.ip_addresses.join(', ') : '—'}</td>
                        <td className="mono">{i.mac ?? '—'}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>{live && i.oper_status === 'up' ? fmtSpeed(i.speed_mbps) : '—'}</td>
                        <td style={{ color: 'var(--info)', whiteSpace: 'nowrap' }}>{live ? fmtBps(i.in_bps) : '—'}</td>
                        <td style={{ color: 'var(--ok)', whiteSpace: 'nowrap' }}>{live ? fmtBps(i.out_bps) : '—'}</td>
                        <td style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{fmtBytes(i.in_octets)} / {fmtBytes(i.out_octets)}</td>
                        <td style={{ whiteSpace: 'nowrap', fontSize: 12, color: errs || drops ? 'var(--warn)' : 'var(--text3)' }}>
                          {errs} / {drops}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ── Card ─────────────────────────────────────────────────────────────────────
export default function MikrotikRouterCard() {
  const [routers, setRouters] = useState<Router[]>([])
  const [ifaces,  setIfaces]  = useState<Iface[]>([])
  const [state,   setState]   = useState<'loading' | 'missing' | 'ready'>('loading')
  const [now,     setNow]     = useState(() => Date.now())
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(async () => {
    const [r, i] = await Promise.all([
      supabase.from('mikrotik_routers').select('*').order('device_name'),
      supabase.from('mikrotik_interfaces').select('*'),
    ])
    if (r.error) {
      setState(/schema cache|does not exist|relation/i.test(r.error.message) ? 'missing' : 'ready')
      return
    }
    setRouters((r.data ?? []) as Router[])
    setIfaces((i.data ?? []) as Iface[])
    setState('ready')
  }, [])

  useEffect(() => {
    load()
    // Many interface rows change at once each poll — reload once
    const refresh = () => {
      if (pending.current) return
      pending.current = setTimeout(() => { pending.current = null; load() }, 700)
    }
    const ch = supabase.channel('mikrotik-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'mikrotik_routers' }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'mikrotik_interfaces' }, refresh)
      .subscribe()
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => {
      supabase.removeChannel(ch)
      clearInterval(tick)
      if (pending.current) clearTimeout(pending.current)
    }
  }, [load])
  usePolling(load, 10_000)   // fallback if realtime isn't enabled

  if (state === 'loading') return null

  if (state === 'missing' || routers.length === 0) {
    return (
      <div className="card">
        <div className="card-header">📶 MikroTik Router</div>
        <div className="card-body" style={{ fontSize: 12, color: 'var(--text2)', lineHeight: 1.7 }}>
          {state === 'missing' ? (
            <>Router monitoring isn&apos;t set up in the database yet. Run{' '}
              <code className="mono">supabase/migration_mikrotik_snmp.sql</code> in the Supabase SQL Editor.</>
          ) : (
            <>No MikroTik router found yet. Enable SNMP on the router, then make sure the router is in
              {' '}<a href="/devices">Devices</a> with its SNMP community. The local agent detects RouterOS
              automatically and starts showing its data here within 15 seconds.</>
          )}
        </div>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {routers.map(r => (
        <RouterPanel key={r.device_id} r={r} now={now}
                     ifaces={ifaces.filter(i => i.device_id === r.device_id)} />
      ))}
    </div>
  )
}
