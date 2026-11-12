// Ask the campus agent to do LAN work for the dashboard (server only).
// The dashboard may be hosted on Vercel, which cannot reach private
// addresses; the agent (poller/jobs.js) picks jobs up from Supabase, runs
// them on the LAN and writes the result back.
import type { SupabaseClient } from '@supabase/supabase-js'

export const AGENT_FRESH_MS = 60_000   // an agent that reported in the last minute is online

export type AgentJobType = 'probe' | 'config_snapshot'

// Is an agent reporting right now?
export async function agentOnline(db: SupabaseClient): Promise<boolean> {
  const { data, error } = await db.from('agent_status').select('last_seen')
    .order('last_seen', { ascending: false }).limit(1)
  if (error || !data?.length) return false
  return Date.now() - new Date(data[0].last_seen).getTime() < AGENT_FRESH_MS
}

export type AgentJobOutcome<T> =
  | { ok: true; id: string; result: T }
  | { ok: false; status: number; error: string }

// Queue a job and wait for the agent's answer
export async function runAgentJob<T>(
  db: SupabaseClient, type: AgentJobType, payload: Record<string, unknown>,
  opts: { timeoutMs?: number; requestedBy?: string } = {},
): Promise<AgentJobOutcome<T>> {
  const { data: job, error } = await db.from('agent_jobs')
    .insert({ type, payload, requested_by: opts.requestedBy ?? null }).select('id').single()
  if (error || !job) {
    const missing = /schema cache|does not exist|relation/i.test(error?.message ?? '')
    return {
      ok: false, status: missing ? 501 : 500,
      error: missing ? 'Run supabase/migration_agent_jobs.sql in the Supabase SQL Editor to enable this on the hosted dashboard.'
                     : (error?.message ?? 'Could not queue the request'),
    }
  }

  const deadline = Date.now() + (opts.timeoutMs ?? 25_000)
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 700))
    const { data } = await db.from('agent_jobs').select('status, result, error').eq('id', job.id).single()
    if (data?.status === 'done')  return { ok: true, id: job.id, result: data.result as T }
    if (data?.status === 'error') return { ok: false, status: 502, error: data.error ?? 'The agent could not complete the request' }
  }
  // Never leave a stale request for the agent to run later
  await db.from('agent_jobs').delete().eq('id', job.id).eq('status', 'pending')
  return { ok: false, status: 504, error: 'The monitoring agent did not answer in time. Check that the computer running the SecureNet agent is on and connected to the campus network.' }
}

// Result of a finished job (used when saving, so the server trusts the
// agent's measurement rather than anything the browser sends)
export async function finishedJobResult<T>(db: SupabaseClient, id: string, type: AgentJobType): Promise<T | null> {
  const { data } = await db.from('agent_jobs').select('type, status, result').eq('id', id).single()
  return data?.type === type && data.status === 'done' ? (data.result as T) : null
}
