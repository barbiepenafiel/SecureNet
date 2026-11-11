import { createServerClient } from '@/lib/supabase'
import type { Device } from '@/lib/database.types'
import TopologyHub from '@/components/TopologyHub'
import LiveRefresh from '@/components/LiveRefresh'

export const dynamic = 'force-dynamic'

const LIVE_TABLES = ['devices']

export default async function FloorPlanPage({ searchParams }: {
  searchParams: Promise<{ bldg?: string }>
}) {
  const { bldg } = await searchParams
  const db = createServerClient()
  const { data: devData } = await db.from('devices').select('*').order('name')
  const devs = (devData ?? []) as Device[]
  return (
    <>
      <LiveRefresh tables={LIVE_TABLES} />
      <TopologyHub mode="floorplan" devs={devs} clientCounts={{}} initialBldg={bldg} />
    </>
  )
}
