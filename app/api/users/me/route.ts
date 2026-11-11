import { createServerClient } from '@/lib/supabase'
import { requirePermission } from '@/lib/auth-server'

// Current user's profile
export async function GET() {
  const gate = await requirePermission()
  if (gate instanceof Response) return gate
  return Response.json(gate)
}

// Called right after sign-in to record the last login time
export async function POST() {
  const gate = await requirePermission()
  if (gate instanceof Response) return gate
  await createServerClient().from('profiles')
    .update({ last_login: new Date().toISOString() }).eq('id', gate.id)
  return Response.json({ ok: true })
}
