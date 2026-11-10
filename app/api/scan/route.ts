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

    // The agent replaces the table each sweep with hosts verified live by ICMP or fresh ARP.
    const { data, error } = await sb
      .from('scan_results')
      .select('*')
      .order('scanned_at', { ascending: false })
      .limit(1000)

    if (error) throw error

    // Deduplicate by IP, keeping the most recent entry
    const seen = new Set<string>()
    const unique = (data ?? []).filter(r => {
      if (seen.has(r.ip)) return false
      seen.add(r.ip)
      return true
    })

    const scanned_at = unique[0]?.scanned_at ?? null

    return NextResponse.json({ results: unique, scanned_at })
  } catch {
    return NextResponse.json({ results: [], scanned_at: null })
  }
}

// POST: just return current scan data — the agent handles actual scanning.
export async function POST() {
  return GET()
}
