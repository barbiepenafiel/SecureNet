import { createClient } from '@supabase/supabase-js'

const url  = process.env.NEXT_PUBLIC_SUPABASE_URL!
const key  = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!

// Browser-safe singleton (untyped client — tables cast at call site)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const supabase = createClient<any>(url, key)

// Server-side helper
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createServerClient() { return createClient<any>(url, key) }
