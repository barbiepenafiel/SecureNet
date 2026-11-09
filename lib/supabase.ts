import { createClient } from '@supabase/supabase-js'

const url  = process.env.NEXT_PUBLIC_SUPABASE_URL!
const key  = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!

// Browser-safe singleton (untyped client — tables cast at call site)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const supabase = createClient<any>(url, key)

// Server-side helper — uses service role key to bypass RLS
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createServerClient() {
  const serverKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? key
  return createClient<any>(url, serverKey)
}
