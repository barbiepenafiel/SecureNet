import { createServerClient } from '@/lib/supabase'
import type { Device } from '@/lib/database.types'
import TopologyHub from '@/components/TopologyHub'
import LiveRefresh from '@/components/LiveRefresh'

const LIVE_TABLES = ['devices']

export const dynamic = 'force-dynamic'

export default async function TopologyPage() {
  const db = createServerClient()
  const [{ data: devData }, { data: cliData }] = await Promise.all([
    db.from('devices').select('*').order('name'),
    db.from('clients').select('ap').not('ap', 'eq', '—'),
  ])

  const devs = (devData ?? []) as Device[]
  const clientCounts: Record<string, number> = {}
  ;(cliData ?? []).forEach((c: { ap: string }) => {
    if (c.ap) clientCounts[c.ap] = (clientCounts[c.ap] ?? 0) + 1
  })

  return (
    <>
      <LiveRefresh tables={LIVE_TABLES} />
      <TopologyHub mode="topology" devs={devs} clientCounts={clientCounts} />
    </>
  )
}
