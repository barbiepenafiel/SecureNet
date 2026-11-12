'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'

export default function AlertsKpi() {
  const [counts, setCounts] = useState({ today: 0, open: 0 })

  // Critical alerts only. Counted by the database (not by fetching rows),
  // so the number isn't capped at Supabase's 1000-row limit.
  async function load() {
    const midnight = new Date()
    midnight.setHours(0, 0, 0, 0)   // local midnight
    const crit = () => supabase
      .from('alerts')
      .select('id', { count: 'exact', head: true })
      .eq('severity', 'crit')
      .eq('suppressed', false)
      .gte('created_at', midnight.toISOString())
    const [all, open] = await Promise.all([crit(), crit().is('resolved_at', null)])
    if (all.error || open.error) return
    setCounts({ today: all.count ?? 0, open: open.count ?? 0 })
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

  const { today, open } = counts

  return (
    <div className="kpi kpi-warn">
      <div className="kpi-inner">
        <div>
          <div className="kpi-label">Critical Alerts Today</div>
          <div className="kpi-value">{today}</div>
          <div className="kpi-sub">{open} open · {today - open} resolved</div>
        </div>
        <div className="kpi-icon kpi-icon-warn">🔔</div>
      </div>
    </div>
  )
}
