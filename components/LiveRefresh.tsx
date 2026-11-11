'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'

// Keeps a server-rendered page current without a manual refresh:
// re-renders when any of the given tables change (Supabase realtime), and
// every `intervalMs` as a fallback in case realtime isn't enabled for a table.
export default function LiveRefresh({ tables, intervalMs = 5_000 }: { tables: string[]; intervalMs?: number }) {
  const router = useRouter()
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    // Several rows often change together — refresh once
    const refresh = () => {
      if (pending.current) return
      pending.current = setTimeout(() => { pending.current = null; router.refresh() }, 1000)
    }

    const ch = supabase.channel(`live-refresh-${tables.join('-')}`)
    for (const table of tables) {
      ch.on('postgres_changes', { event: '*', schema: 'public', table }, refresh)
    }
    ch.subscribe()

    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') router.refresh()
    }, intervalMs)

    return () => {
      supabase.removeChannel(ch)
      clearInterval(timer)
      if (pending.current) clearTimeout(pending.current)
    }
  }, [router, tables, intervalMs])

  return null
}
