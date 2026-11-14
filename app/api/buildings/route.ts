import { createServerClient } from '@/lib/supabase'
import { requirePermission } from '@/lib/auth-server'

export const runtime = 'nodejs'

// Buildings list (Settings → Manage → Buildings). Network Admins only.
//   POST   { name }      add a building
//   PATCH  { id, name }  rename — also updates devices, floor plans, rooms
//                        and users' building access that use the old name
//   DELETE ?id=          delete — its devices become "Unassigned"; a
//                        building that still has floor plans can't be deleted

const clean = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim()

async function audit(by: string, action: string, object: string, before = '—', after = '—') {
  await createServerClient().from('audit_log').insert({
    user_name: by, user_ip: 'dashboard', action, object_name: object, before_val: before, after_val: after,
  }).then(() => {}, () => {})
}

function check(name: string): string | null {
  if (!name) return 'Enter a building name'
  if (name.length > 60) return 'Use 60 characters or fewer'
  if (/^(unassigned|all sites)$/i.test(name)) return `"${name}" is reserved`
  return null
}

async function nameTaken(name: string, exceptId?: string) {
  const { data } = await createServerClient().from('buildings').select('id').ilike('name', name.replace(/[%_\\]/g, '\\$&'))
  return (data ?? []).some(r => r.id !== exceptId)
}

export async function POST(req: Request) {
  const gate = await requirePermission('settings.manage')
  if (gate instanceof Response) return gate
  const name = clean((await req.json().catch(() => ({}))).name)
  const bad = check(name)
  if (bad) return Response.json({ error: bad }, { status: 400 })
  if (await nameTaken(name)) return Response.json({ error: `"${name}" already exists` }, { status: 409 })

  const { data, error } = await createServerClient().from('buildings').insert({ name }).select().single()
  if (error) return Response.json({ error: error.message }, { status: 500 })
  await audit(gate.full_name || gate.email, 'Building Added', name)
  return Response.json(data)
}

export async function PATCH(req: Request) {
  const gate = await requirePermission('settings.manage')
  if (gate instanceof Response) return gate
  const body = await req.json().catch(() => ({}))
  const id = String(body.id ?? '')
  const name = clean(body.name)
  const bad = check(name)
  if (bad) return Response.json({ error: bad }, { status: 400 })

  const db = createServerClient()
  const { data: cur } = await db.from('buildings').select('name').eq('id', id).single()
  if (!cur) return Response.json({ error: 'Building not found' }, { status: 404 })
  const old = cur.name as string
  if (old === name) return Response.json({ ok: true, moved: {} })
  if (await nameTaken(name, id)) return Response.json({ error: `"${name}" already exists` }, { status: 409 })

  const { error } = await db.from('buildings').update({ name }).eq('id', id)
  if (error) return Response.json({ error: error.message }, { status: 500 })

  // Everything that refers to the building by name follows the rename
  const moved: Record<string, number> = {}
  const follow = async (table: string, column: string) => {
    const { count, error: e } = await db.from(table).update({ [column]: name }, { count: 'exact' }).eq(column, old)
    if (!e) moved[table] = count ?? 0
  }
  await follow('devices', 'location')
  await follow('floor_plans', 'building')      // table may not exist yet — skipped then
  await follow('floor_rooms', 'building')
  await follow('profiles', 'building_access')

  await audit(gate.full_name || gate.email, 'Building Renamed', name, old, name)
  return Response.json({ ok: true, moved })
}

export async function DELETE(req: Request) {
  const gate = await requirePermission('settings.manage')
  if (gate instanceof Response) return gate
  const id = new URL(req.url).searchParams.get('id') ?? ''

  const db = createServerClient()
  const { data: cur } = await db.from('buildings').select('name').eq('id', id).single()
  if (!cur) return Response.json({ error: 'Building not found' }, { status: 404 })
  const name = cur.name as string

  const { count: plans } = await db.from('floor_plans').select('id', { count: 'exact', head: true }).eq('building', name)
  if (plans) return Response.json({ error: `${name} has ${plans} floor plan(s) — delete them under Floor plans first` }, { status: 409 })

  const { count: devices } = await db.from('devices').update({ location: 'Unassigned', room_id: null }, { count: 'exact' }).eq('location', name)
  await db.from('profiles').update({ building_access: 'All sites' }).eq('building_access', name)
  const { error } = await db.from('buildings').delete().eq('id', id)
  if (error) return Response.json({ error: error.message }, { status: 500 })

  await audit(gate.full_name || gate.email, 'Building Deleted', name, name, `${devices ?? 0} device(s) set to Unassigned`)
  return Response.json({ ok: true, devices: devices ?? 0 })
}
