'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import type { Alert } from '@/lib/database.types'

export default function AlertsKpi() {
  const [alerts, setAlerts] = useState<Alert[]>([])

  async function load() {
    const midnight = new Date()
    midnight.setHours(0, 0, 0, 0)   // local midnight
    const { data } = await supabase
      .from('alerts')
      .select('id, severity, acked, suppressed, resolved_at')
      .eq('suppressed', false)
      .gte('created_at', midnight.toISOString())
    setAlerts((data ?? []) as Alert[])
  }

  useEffect(() => {
    load()
    const ch = supabase
      .channel('kpi-alerts-rt')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'alerts' }, load)
      .subscribe()
    // Backup refresh every 5 s in case realtime isn't enabled for alerts
    const poll = setInterval(() => { if (document.visibilityState === 'visible') load() }, 5_000)
    return () => { supabase.removeChannel(ch); clearInterval(poll) }
  }, [])

  const today   = alerts.length
  const offline = alerts.filter(a => a.severity === 'crit').length
  const online  = alerts.filter(a => a.severity === 'info').length
  const open    = alerts.filter(a => a.severity !== 'info' && !a.resolved_at).length

  return (
    <div className="kpi kpi-warn">
      <div className="kpi-inner">
        <div>
          <div className="kpi-label">Alerts Today</div>
          <div className="kpi-value">{today}</div>
          <div className="kpi-sub">{offline} offline · {online} back online · {open} open</div>
        </div>
        <div className="kpi-icon kpi-icon-warn">🔔</div>
      </div>
    </div>
  )
}
