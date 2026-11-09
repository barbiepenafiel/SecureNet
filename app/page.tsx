import { createServerClient } from '@/lib/supabase'
import { TrafficChart, DevicePieChart } from '@/components/DashboardCharts'
import DeviceSourceChart from '@/components/DeviceSourceChart'
import NetworkScanCard from '@/components/NetworkScanCard'
import RecentAlertsCard from '@/components/RecentAlertsCard'
import AlertsKpi from '@/components/AlertsKpi'
import DiscoveredKpi from '@/components/DiscoveredKpi'
import type { Device, SlaRecord, Client } from '@/lib/database.types'

function statusChip(s: string) {
  const cls: Record<string, string>   = { up: 'chip-ok', warn: 'chip-warn', down: 'chip-crit', maint: 'chip-maint' }
  const label: Record<string, string> = { up: 'Online', warn: 'Warning', down: 'Offline', maint: 'Maintenance' }
  return <span className={`chip ${cls[s] ?? 'chip-off'}`}>{label[s] ?? s}</span>
}

function PBar({ pct, cls }: { pct: number; cls: string }) {
  return (
    <div className="pbar">
      <div className={`pbar-fill ${cls}`} style={{ width: `${pct}%` }} />
    </div>
  )
}

export const dynamic = 'force-dynamic'

export default async function DashboardPage() {
  const db = createServerClient()

  const [
    { data: devices },
    { data: sla },
    { data: clientRows },
  ] = await Promise.all([
    db.from('devices').select('*').order('name'),
    db.from('sla_data').select('*').order('device_name'),
    db.from('clients').select('hostname, ap, status'),
  ])

  const devs    = (devices    ?? []) as Device[]
  const slaL    = (sla        ?? []) as SlaRecord[]
  const clientsL = (clientRows ?? []) as Pick<Client, 'hostname' | 'ap' | 'status'>[]
  // Real metrics derived from live data
  const onlineClients = clientsL.filter(c => c.status !== 'down').length

  const apCounts: Record<string, number> = {}
  clientsL.forEach(c => { if (c.ap && c.ap !== '—') apCounts[c.ap] = (apCounts[c.ap] ?? 0) + 1 })
  const [busiestAP, busiestCount] = Object.entries(apCounts).sort((a, b) => b[1] - a[1])[0] ?? ['—', 0]

  const highCPUDev = [...devs].sort((a, b) => b.cpu - a.cpu)[0]
  const downBldg = devs.filter(d => d.status === 'down')
  const downBldgGroups = downBldg.reduce<Record<string, number>>((acc, d) => {
    acc[d.location] = (acc[d.location] ?? 0) + 1; return acc
  }, {})
  const worstBldg = Object.entries(downBldgGroups).sort((a, b) => b[1] - a[1])[0]

  const up   = devs.filter(d => d.status === 'up').length
  const warn = devs.filter(d => d.status === 'warn').length
  const down = devs.filter(d => d.status === 'down').length
  const total = devs.length

  const avgSla = slaL.length
    ? (slaL.reduce((s, r) => s + Number(r.uptime_pct), 0) / slaL.length).toFixed(1)
    : '—'

  // SLA by building
  const bldgSla: Record<string, number[]> = {}
  slaL.forEach(r => {
    if (!bldgSla[r.building]) bldgSla[r.building] = []
    bldgSla[r.building].push(Number(r.uptime_pct))
  })
  const bldgAvg = Object.entries(bldgSla).map(([b, vals]) => ({
    bldg: b,
    pct: vals.reduce((s, v) => s + v, 0) / vals.length,
  }))

  return (
    <>
      {/* Hero banner */}
      <div className="hero-banner">
        <div className="hero-label">Network Infrastructure · Campus Devices</div>
        <div className="hero-title">Network Health</div>
        <div className="hero-desc">Monitor core services, reduce downtime, and keep everything connected.</div>
      </div>

      {/* KPI tiles */}
      <div className="kpi-row">
        {/* Combined: Devices + Clients */}
        <div className="kpi kpi-ok">
          <div className="kpi-inner">
            <div>
              <div className="kpi-label">Devices &amp; Clients</div>
              <div className="kpi-value">{total + onlineClients}</div>
              <div className="kpi-sub">{total} devices · {onlineClients} clients</div>
            </div>
            <div className="kpi-icon kpi-icon-ok">⊞</div>
          </div>
        </div>
        <div className="kpi kpi-ok">
          <div className="kpi-inner">
            <div>
              <div className="kpi-label">Online</div>
              <div className="kpi-value">{up}</div>
              <div className="kpi-sub">of {total} managed</div>
            </div>
            <div className="kpi-icon kpi-icon-ok">✓</div>
          </div>
        </div>
        <div className="kpi kpi-crit">
          <div className="kpi-inner">
            <div>
              <div className="kpi-label">Offline</div>
              <div className="kpi-value">{down}</div>
              <div className="kpi-sub">{warn} in warning state</div>
            </div>
            <div className="kpi-icon kpi-icon-crit">✕</div>
          </div>
        </div>
        <AlertsKpi />
        <DiscoveredKpi />
      </div>

      <div className="grid-70-30" style={{ marginBottom: 14 }}>
        {/* Left column: Traffic chart + Device Health + SLA */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="card">
            <div className="card-header">Network Traffic — Last 24h</div>
            <div className="card-body" style={{ padding: '12px 16px 12px' }}><TrafficChart /></div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            {/* Device health */}
            <div className="card">
              <div className="card-header">Device Health</div>
              <div className="card-body">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 14 }}>
                  {[
                    { label: 'Online',  count: up,   pct: total ? (up/total*100).toFixed(1)   : '0.0', cls: 'pbar-ok'   },
                    { label: 'Warning', count: warn, pct: total ? (warn/total*100).toFixed(1) : '0.0', cls: 'pbar-warn'  },
                    { label: 'Offline', count: down, pct: total ? (down/total*100).toFixed(1) : '0.0', cls: 'pbar-crit'  },
                  ].map(row => (
                    <div key={row.label}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5, fontSize: 12 }}>
                        <span>{row.label} <strong>{row.count}</strong></span>
                        <span>{row.pct}%</span>
                      </div>
                      <PBar pct={Number(row.pct)} cls={row.cls} />
                    </div>
                  ))}
                </div>
                <DevicePieChart up={up} warn={warn} down={down} />
              </div>
            </div>

            {/* Total Devices by Source */}
            <div className="card">
              <div className="card-header">
                Total Devices
                <span style={{ marginLeft: 8, fontWeight: 400, fontSize: 11, color: 'var(--text3)' }}>by source</span>
              </div>
              <div className="card-body">
                <DeviceSourceChart />
                <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text3)', borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                  SNMP = managed · ICMP = ping discovered · ARP = layer-2 discovered
                </div>
              </div>
            </div>
          </div>
        </div>

        <RecentAlertsCard />
      </div>

      {/* Network Discovery */}
      <div style={{ marginTop: 14, marginBottom: 14 }}>
        <NetworkScanCard />
      </div>

      {/* Recent devices table */}
      <div className="card" style={{ marginTop: 0 }}>
        <div className="card-header">
          Device Status
          <div className="card-header-actions">
            <a href="/devices" className="btn btn-sm">View All</a>
          </div>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table className="tbl">
            <thead>
              <tr><th>Device Name</th><th>Type</th><th>IP Address</th><th>Location</th><th>Status</th><th>CPU %</th><th>Uptime</th></tr>
            </thead>
            <tbody>
              {devs.slice(0, 8).map(d => (
                <tr key={d.id}>
                  <td><strong>{d.name}</strong></td>
                  <td><span className="tag">{d.type}</span></td>
                  <td className="mono">{d.ip}</td>
                  <td>{d.location}</td>
                  <td>{statusChip(d.status)}</td>
                  <td style={{ color: d.cpu >= 90 ? 'var(--crit)' : d.cpu >= 75 ? 'var(--warn)' : 'var(--ok)', fontWeight: 500 }}>
                    {d.cpu ? `${d.cpu}%` : '—'}
                  </td>
                  <td className="mono" style={{ fontSize: 12 }}>{d.uptime}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}
