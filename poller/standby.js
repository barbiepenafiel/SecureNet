/**
 * One agent monitors at a time (used by agent.js).
 *
 * Two agents writing device status and alerts at once would fight each
 * other — e.g. if the agent is ever started on a second computer. Each
 * agent reports a priority with its heartbeat (AGENT_PRIORITY in
 * poller/.env, default 0). An agent stands by — no scanning, polling, alerts or
 * heartbeat — while another agent with a fresh heartbeat outranks it, and
 * takes over by itself within about a minute if that agent stops.
 *
 * Needs the `priority` column from supabase/migration_agent_jobs.sql;
 * without it every agent simply stays active, as before.
 */

const os = require('os')

const AGENT_ID = os.hostname()
const PRIORITY = parseInt(process.env.AGENT_PRIORITY ?? '0', 10) || 0
const FRESH_MS = 60_000

// Pure decision: which fresh agent (if any) outranks this one?
// Higher priority wins; on a tie the name that sorts first wins, so two
// equal agents always agree on who it is.
function outrankedBy(me, others, now) {
  return others.find(o =>
    o.id !== me.id &&
    now - new Date(o.last_seen).getTime() < FRESH_MS &&
    ((o.priority ?? 0) > me.priority || ((o.priority ?? 0) === me.priority && o.id < me.id))) ?? null
}

let standingBy = false

// Call once per monitoring round
async function refresh(db) {
  const { data, error } = await db.from('agent_status').select('id, last_seen, priority')
  if (error) {            // priority column not installed (or database unreachable): stay active
    standingBy = false
    return false
  }
  const primary = outrankedBy({ id: AGENT_ID, priority: PRIORITY }, data ?? [], Date.now())
  if (primary && !standingBy) {
    console.log(`  [standby] agent "${primary.id}" (priority ${primary.priority ?? 0}) is monitoring — this agent (priority ${PRIORITY}) is standing by`)
  } else if (!primary && standingBy) {
    console.log('  [standby] no other agent is reporting — this agent is taking over')
  }
  standingBy = !!primary
  return standingBy
}

module.exports = { refresh, isStandby: () => standingBy, outrankedBy, AGENT_ID, PRIORITY }
