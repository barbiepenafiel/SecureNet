import { triggerRound, monitorStatus } from '@/lib/alert-monitor'

export const runtime = 'nodejs'

// The server timer (instrumentation.ts) already runs a round every 15 s.
// The dashboard calls this too; extra calls reuse the latest round.
export async function POST() {
  try {
    return Response.json(await triggerRound())
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 })
  }
}

// Current failure streaks and timer status
export async function GET() {
  return Response.json(monitorStatus())
}
