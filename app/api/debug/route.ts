import { createClient } from '@supabase/supabase-js'
import { requirePermission } from '@/lib/auth-server'

export const runtime = 'nodejs'

export async function GET() {
  const gate = await requirePermission('settings.manage')
  if (gate instanceof Response) return gate
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  const withService = createClient(url!, serviceKey!)
  const withAnon    = createClient(url!, anonKey!)

  const [svc, anon] = await Promise.all([
    withService.from('devices').select('id,name,status'),
    withAnon.from('devices').select('id,name,status'),
  ])

  return Response.json({
    url,
    hasServiceKey: !!serviceKey,
    hasAnonKey: !!anonKey,
    serviceKeyPrefix: serviceKey?.slice(0, 12),
    serviceResult: { data: svc.data, error: svc.error?.message },
    anonResult:    { data: anon.data, error: anon.error?.message },
  })
}
