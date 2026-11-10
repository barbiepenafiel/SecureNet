import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'

// Scanning is done by the local agent (poller/agent.js) running on campus.
// This route is read-only: it returns whatever the agent last wrote to Supabase.

function adminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  )
}

export async function GET() {
  try {
    const sb = adminClient()
    const { data, error } = await sb
      .from('scan_results')
      .select('*')
      .order('responded', { ascending: false })
      .order('latency_ms', { ascending: true, nullsFirst: false })
      .limit(500)

    if (error) throw error

    return NextResponse.json({
      results:    data ?? [],
      scanned_at: data?.[0]?.scanned_at ?? null,
    })
  } catch {
    return NextResponse.json({ results: [], scanned_at: null })
  }
}

// POST is intentionally disabled — scanning must run on the campus machine
// via `node poller/agent.js`, not on Vercel's servers.
export async function POST() {
  return NextResponse.json(
    { error: 'Scanning runs on the local agent (node poller/agent.js), not on Vercel.' },
    { status: 503 },
  )
}
