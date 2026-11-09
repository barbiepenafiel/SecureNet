import { createServerClient } from '@/lib/supabase'
import type { Device } from '@/lib/database.types'
import TopologyHub from '@/components/TopologyHub'

export const dynamic = 'force-dynamic'

export default async function FloorPlanPage() {
  const db = createServerClient()
  const { data: devData } = await db.from('devices').select('*').order('name')
  const devs = (devData ?? []) as Device[]
  return <TopologyHub devs={devs} clientCounts={{}} />
}
