'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import type { Alert } from '@/lib/database.types'

export default function AlertsKpi() {
  const [alerts, setAlerts] = useState<Alert[]>([])

  async function load() {
    const { data } = await supabase
      .from('alerts')
      .select('id, severity, acked, suppressed')
      .eq('suppressed', false)
    setAlerts(data ?? [])
  }

  useEffect(() => {
    load()
    const ch = supabase
      .channel('kpi-alerts-rt')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'alerts' }, load)
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [])

  const active = alerts.filter(a => !a.acked).length
  const crit   = alerts.filter(a => a.severity === 'crit' && !a.acked).length
  const warn   = alerts.filter(a => a.severity === 'warn' && !a.acked).length

  return (
    <div className="kpi kpi-warn">
      <div className="kpi-inner">
        <div>
          <div className="kpi-label">Alerts Today</div>
          <div className="kpi-value">{active}</div>
          <div className="kpi-sub">{crit} critical · {warn} warning</div>
        </div>
        <div className="kpi-icon kpi-icon-warn">🔔</div>
      </div>
    </div>
  )
}
