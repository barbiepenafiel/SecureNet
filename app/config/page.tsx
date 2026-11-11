'use client'

import { useEffect, useState, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import type { ConfigBackup, Device } from '@/lib/database.types'
import { usePolling } from '@/lib/usePolling'

function lineDiff(oldText: string, newText: string) {
  const a   = oldText.split('\n').filter(l => l.trim())
  const b   = newText.split('\n').filter(l => l.trim())
  const bSet = new Set(b), aSet = new Set(a)
  return {
    context: a.filter(l => bSet.has(l)).slice(0, 3),
    removed: a.filter(l => !bSet.has(l)),
    added:   b.filter(l => !aSet.has(l)),
  }
}

interface DeviceRow {
  device: Device
  backups: ConfigBackup[]
}

export default function ConfigPage() {
  const [deviceRows, setDeviceRows] = useState<DeviceRow[]>([])
  const [allBackups, setAllBackups] = useState<ConfigBackup[]>([])
  const [diffTarget, setDiffTarget] = useState<ConfigBackup | null>(null)
  const [loading,    setLoading]    = useState(true)
  const [backing,    setBacking]    = useState(false)
  const [backingId,  setBackingId]  = useState<string | null>(null)
  const [lastUp,     setLastUp]     = useState('')
  const [msg,        setMsg]        = useState('')

  const load = useCallback(async () => {
    const [{ data: devData }, { data: bkData }] = await Promise.all([
      supabase.from('devices').select('*').neq('status', 'maint').order('name'),
      supabase.from('config_backups').select('*').order('backed_up_at', { ascending: false }),
    ])

    const devices = (devData ?? []) as Device[]
    const backups = (bkData  ?? []) as ConfigBackup[]

    // Group backups by device name, keeping only last 5 per device
    const byDevice = new Map<string, ConfigBackup[]>()
    for (const b of backups) {
      const arr = byDevice.get(b.device_name) ?? []
      if (arr.length < 5) arr.push(b)
      byDevice.set(b.device_name, arr)
    }

    // Only show real managed devices — ignore any backup entries for devices no longer in devices table
    const rows: DeviceRow[] = devices.map(d => ({
      device:  d,
      backups: byDevice.get(d.name) ?? [],
    }))

    setDeviceRows(rows)
    setAllBackups(backups)
    setLastUp(new Date().toLocaleTimeString())
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
    const ch = supabase.channel('config-rt')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'config_backups' }, load)
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [load])
  // Keep data current without a manual refresh
  usePolling(load, 10_000)

  async function backupAll() {
    setBacking(true)
    setMsg('')
    try {
      const res  = await fetch('/api/config-backup', { method: 'POST', body: '{}' })
      const data = await res.json()
      const changed = data.results?.filter((r: { changed: boolean }) => r.changed).length ?? 0
      setMsg(`✓ Backed up ${data.backed_up} device(s) — ${changed} change(s) detected`)
      load()
    } catch {
      setMsg('Backup failed')
    } finally {
      setBacking(false)
    }
  }

  async function backupOne(devId: string, devName: string) {
    setBackingId(devId)
    setMsg('')
    try {
      const res  = await fetch('/api/config-backup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: devId }),
      })
      const data = await res.json()
      const r    = data.results?.[0]
      setMsg(r ? `✓ ${devName}: ${r.changed ? 'changes detected' : 'no changes'}` : '✓ Done')
      load()
    } catch {
      setMsg('Backup failed')
    } finally {
      setBackingId(null)
    }
  }

  function showDiff(backup: ConfigBackup) {
    setDiffTarget(backup)
  }

  // Compute diff for selected backup vs its predecessor
  const diffContent = (() => {
    if (!diffTarget?.content) return null
    const prev = allBackups.find(b =>
      b.device_name === diffTarget.device_name &&
      b.id !== diffTarget.id &&
      b.content &&
      b.backed_up_at < diffTarget.backed_up_at
    )
    if (!prev?.content) return null
    return { diff: lineDiff(prev.content, diffTarget.content), prev, current: diffTarget }
  })()

  const totalDevices = deviceRows.length
  const neverBacked  = deviceRows.filter(r => r.backups.length === 0).length
  const withChanges  = deviceRows.filter(r => r.backups.some(b => b.changed)).length

  if (loading) return (
    <div style={{ padding: 40, textAlign: 'center', color: 'var(--text3)' }}>Loading config backup history…</div>
  )

  return (
    <div className="grid-70-30">
      {/* Left: backup history */}
      <div>
        {msg && (
          <div style={{ marginBottom: 10, padding: '8px 14px', borderRadius: 6, fontSize: 13,
            background: msg.startsWith('✓') ? 'rgba(63,185,80,.12)' : 'rgba(248,81,73,.12)',
            color: msg.startsWith('✓') ? 'var(--ok)' : 'var(--crit)',
            border: `1px solid ${msg.startsWith('✓') ? 'rgba(63,185,80,.3)' : 'rgba(248,81,73,.3)'}` }}>
            {msg}
          </div>
        )}

        {/* KPIs */}
        <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
          {[
            { label: 'Total Devices', value: totalDevices, color: 'var(--text)' },
            { label: 'Never Backed Up', value: neverBacked, color: neverBacked > 0 ? 'var(--warn)' : 'var(--ok)' },
            { label: 'With Changes', value: withChanges, color: withChanges > 0 ? 'var(--info)' : 'var(--text3)' },
          ].map(k => (
            <div key={k.label} style={{ flex: '1 1 100px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 12px' }}>
              <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 2 }}>{k.label}</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: k.color }}>{k.value}</div>
            </div>
          ))}
        </div>

        <div className="card">
          <div className="card-header">
            Config Backup History
            <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--ok)', marginLeft: 8 }}>
              ● Live{lastUp && ` · ${lastUp}`}
            </span>
            <div className="card-header-actions">
              <button suppressHydrationWarning className="btn btn-primary btn-sm" onClick={backupAll} disabled={backing}>
                {backing ? '…Backing up' : '⟳ Backup All'}
              </button>
            </div>
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table className="tbl">
              <thead>
                <tr><th>Device</th><th>Type</th><th>IP</th><th>Last Backup</th><th>Size</th><th>Changed</th><th>Actions</th></tr>
              </thead>
              <tbody>
                {deviceRows.map(({ device: dev, backups }) => {
                  const latest = backups[0]
                  return (
                    <tr key={dev.id}>
                      <td><strong>{dev.name}</strong></td>
                      <td style={{ fontSize: 12, color: 'var(--text3)' }}>{dev.type}</td>
                      <td className="mono" style={{ fontSize: 11, color: 'var(--text3)' }}>{dev.ip}</td>
                      <td style={{ fontSize: 12, color: 'var(--text3)' }}>
                        {latest ? new Date(latest.backed_up_at).toLocaleString() : <span style={{ color: 'var(--warn)' }}>Never</span>}
                      </td>
                      <td style={{ fontSize: 12 }}>{latest ? `${latest.size_kb} KB` : '—'}</td>
                      <td>
                        {!latest ? <span className="chip chip-off">—</span>
                          : latest.changed
                            ? <span className="chip chip-warn">Changed</span>
                            : <span className="chip chip-off">Same</span>}
                      </td>
                      <td>
                        <div className="tbl-actions">
                          <button suppressHydrationWarning
                            className="btn btn-sm btn-primary"
                            onClick={() => backupOne(dev.id, dev.name)}
                            disabled={backingId === dev.id}
                          >
                            {backingId === dev.id ? '…' : 'Backup'}
                          </button>
                          {latest?.content && (
                            <button suppressHydrationWarning className="btn btn-sm" onClick={() => {
                              const blob = new Blob([latest.content!], { type: 'text/plain' })
                              const a = document.createElement('a')
                              a.href = URL.createObjectURL(blob)
                              a.download = `${dev.name}_${new Date(latest.backed_up_at).toISOString().slice(0, 10)}.txt`
                              a.click()
                            }}>Download</button>
                          )}
                          {latest?.changed && latest?.content && (
                            <button suppressHydrationWarning className="btn btn-sm" onClick={() => showDiff(latest)}>Diff</button>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
                {deviceRows.length === 0 && (
                  <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>
                    No devices found. Add devices in the Devices page first.
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>

          <div style={{ padding: '8px 16px', fontSize: 11, color: 'var(--text3)', borderTop: '1px solid var(--border)' }}>
            Snapshots are collected via SNMP (sysDescr, interfaces). Click "Backup" or "Backup All" to capture a snapshot now.
          </div>
        </div>
      </div>

      {/* Right: diff preview */}
      <div className="card">
        <div className="card-header">Change Diff Preview</div>
        <div className="card-body">
          {diffContent ? (
            <div style={{ background: 'var(--surface2)', borderRadius: 'var(--r)', padding: 14, fontFamily: 'var(--mono)', fontSize: 12, lineHeight: 1.9, overflowX: 'auto', overflowY: 'auto', maxHeight: 480 }}>
              <div style={{ color: 'var(--text3)', marginBottom: 8, fontSize: 11 }}>
                {diffContent.current.device_name} —{' '}
                {new Date(diffContent.prev.backed_up_at).toLocaleDateString()} → {new Date(diffContent.current.backed_up_at).toLocaleDateString()}
              </div>
              {diffContent.diff.context.map((line, i) => (
                <div key={`ctx-${i}`} style={{ color: 'var(--text3)' }}> {line}</div>
              ))}
              {diffContent.diff.context.length > 0 && <div style={{ color: 'var(--text3)' }}>  ...</div>}
              {diffContent.diff.removed.map((line, i) => (
                <div key={`rm-${i}`} style={{ color: 'var(--crit)', background: 'rgba(248,81,73,.07)', borderRadius: 2, paddingLeft: 2 }}>- {line}</div>
              ))}
              {diffContent.diff.added.map((line, i) => (
                <div key={`add-${i}`} style={{ color: 'var(--ok)', background: 'rgba(63,185,80,.07)', borderRadius: 2, paddingLeft: 2 }}>+ {line}</div>
              ))}
              {diffContent.diff.removed.length === 0 && diffContent.diff.added.length === 0 && (
                <div style={{ color: 'var(--text3)' }}>No line-level changes detected.</div>
              )}
            </div>
          ) : diffTarget ? (
            <div style={{ background: 'var(--surface2)', borderRadius: 'var(--r)', padding: 14, fontFamily: 'var(--mono)', fontSize: 12, lineHeight: 1.9, overflowY: 'auto', maxHeight: 480 }}>
              <div style={{ color: 'var(--text3)', marginBottom: 8 }}>{diffTarget.device_name} — latest snapshot</div>
              {diffTarget.content?.split('\n').slice(0, 20).map((line, i) => (
                <div key={i} style={{ color: 'var(--text2)' }}>{line}</div>
              ))}
            </div>
          ) : (
            <div style={{ color: 'var(--text3)', padding: 16, fontSize: 13 }}>
              Click <strong>Diff</strong> on a changed backup row to preview what changed, or <strong>Backup All</strong> to capture a snapshot of all devices now.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
