'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'

// Building names for every "Building" / "Location" dropdown, managed in
// Settings → Manage → Buildings (supabase/migration_buildings.sql).
// Until that table exists the original built-in names are used.

export const DEFAULT_BUILDINGS = ['Building A', 'Building B', 'Building C', 'Data Center', 'Library', 'Admin Building']

export interface Building { id: string; name: string; created_at?: string }

export function useBuildings() {
  const [rows, setRows] = useState<Building[]>([])
  const [managed, setManaged] = useState(false)

  const load = useCallback(async () => {
    const { data, error } = await supabase.from('buildings').select('*').order('name')
    if (error) { setRows([]); setManaged(false); return }
    setRows((data ?? []) as Building[])
    setManaged(true)
  }, [])

  useEffect(() => {
    load()
    // A unique name per use: several components can use this hook at once
    const ch = supabase.channel(`buildings-rt-${crypto.randomUUID()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'buildings' }, load)
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [load])

  // Same array between renders unless the list changes (safe in effect dependencies)
  const names = useMemo(() => managed ? rows.map(r => r.name) : DEFAULT_BUILDINGS, [managed, rows])
  return { buildings: rows, names, managed, reload: load }
}

// Dropdown options: "Unassigned", the managed buildings, and the current
// value (so a device's existing location is never hidden)
export function locationOptions(names: string[], ...current: (string | null | undefined)[]) {
  return [...new Set(['Unassigned', ...names, ...current.filter((c): c is string => !!c)])]
}
