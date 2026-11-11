import { createServerClient } from '@/lib/supabase'
import { requirePermission } from '@/lib/auth-server'
import type { Role } from '@/lib/roles'

const ROLES: Role[] = ['net_admin', 'it_staff']

async function audit(req: Request, actor: string, action: string, target: string, after = '—') {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'server'
  await createServerClient().from('audit_log').insert({
    user_name: actor, user_ip: ip, action, object_name: target, after_val: after,
  }).then(() => {}, () => {})
}

// List all users
export async function GET() {
  const gate = await requirePermission('users.manage')
  if (gate instanceof Response) return gate

  const { data, error } = await createServerClient()
    .from('profiles').select('*').order('created_at')
  if (error) return Response.json({ error: error.message }, { status: 500 })
  return Response.json({ users: data })
}

// Create a user with a temporary password
export async function POST(req: Request) {
  const gate = await requirePermission('users.manage')
  if (gate instanceof Response) return gate

  const body = await req.json().catch(() => ({}))
  const email = String(body.email ?? '').trim().toLowerCase()
  const password = String(body.password ?? '')
  const full_name = String(body.full_name ?? '').trim()
  const role = body.role as Role
  const building_access = String(body.building_access ?? 'All sites')

  if (!email || !full_name) return Response.json({ error: 'Name and email are required' }, { status: 400 })
  if (password.length < 8) return Response.json({ error: 'Password must be at least 8 characters' }, { status: 400 })
  if (!ROLES.includes(role)) return Response.json({ error: 'Invalid role' }, { status: 400 })

  const db = createServerClient()
  const { data, error } = await db.auth.admin.createUser({
    email, password, email_confirm: true,
    user_metadata: { full_name, role, building_access },
  })
  if (error) return Response.json({ error: error.message }, { status: 400 })

  // The trigger creates the profile; set the fields again in case it ran before metadata was read
  await db.from('profiles').upsert({ id: data.user.id, email, full_name, role, building_access })
  await audit(req, gate.full_name || gate.email, 'User Added', email, role)
  return Response.json({ ok: true })
}

// Change a user's role, name or building access
export async function PATCH(req: Request) {
  const gate = await requirePermission('users.manage')
  if (gate instanceof Response) return gate

  const body = await req.json().catch(() => ({}))
  const id = String(body.id ?? '')
  if (!id) return Response.json({ error: 'Missing user id' }, { status: 400 })

  const patch: Record<string, string> = {}
  if (body.role !== undefined) {
    if (!ROLES.includes(body.role)) return Response.json({ error: 'Invalid role' }, { status: 400 })
    if (id === gate.id && body.role !== 'net_admin') {
      return Response.json({ error: "You can't remove your own admin role" }, { status: 400 })
    }
    patch.role = body.role
  }
  if (body.full_name !== undefined) patch.full_name = String(body.full_name).trim()
  if (body.building_access !== undefined) patch.building_access = String(body.building_access)

  const db = createServerClient()
  const { data, error } = await db.from('profiles').update(patch).eq('id', id).select('email').single()
  if (error) return Response.json({ error: error.message }, { status: 500 })
  await audit(req, gate.full_name || gate.email, 'User Updated', data.email, JSON.stringify(patch))
  return Response.json({ ok: true })
}

// Remove a user's account
export async function DELETE(req: Request) {
  const gate = await requirePermission('users.manage')
  if (gate instanceof Response) return gate

  const id = new URL(req.url).searchParams.get('id') ?? ''
  if (!id) return Response.json({ error: 'Missing user id' }, { status: 400 })
  if (id === gate.id) return Response.json({ error: "You can't delete your own account" }, { status: 400 })

  const db = createServerClient()
  const { data: p } = await db.from('profiles').select('email').eq('id', id).single()
  const { error } = await db.auth.admin.deleteUser(id)
  if (error) return Response.json({ error: error.message }, { status: 500 })
  await audit(req, gate.full_name || gate.email, 'User Removed', p?.email ?? id)
  return Response.json({ ok: true })
}
