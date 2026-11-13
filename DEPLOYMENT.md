# SmartCampus SecureNet — Deployment

How SecureNet runs with **no terminal and no `npm run dev`**.

```
                 Internet                                │            Campus network (private)
                                                         │
  Browser ──HTTPS──► Vercel (dashboard, API routes)      │
                        │  reads / writes                │
                        ▼                                │
                    Supabase  ◄──── outbound HTTPS ──────┼──── SecureNet agent (pm2, starts at login)
            (database, login, realtime)                  │        on the monitoring laptop
                        │                                │            │  ICMP · ARP · SNMP
                        └── realtime push ──► Browser    │            ▼
                                                         │     MikroTik hEX, switches, servers, clients
```

- **Vercel** hosts the dashboard at https://netwatch-nms.vercel.app. It can never reach `192.168.x.x`, so it
  never pings or polls anything — it only shows what is in Supabase.
- **The agent** (`poller/agent.js`) is the only part that touches the campus network. It runs on the
  monitoring laptop and only makes *outbound* HTTPS connections to Supabase — no ports are opened into the
  campus and no VPN is needed.
- **Supabase** sits between them: the agent writes, the dashboard reads and receives live updates.
- When the dashboard needs something from the LAN (Add Device detection, Config Backup), it leaves a
  request in the `agent_jobs` table; the agent runs it within ~2 seconds and writes the answer back.

Vercel Cron and Supabase Edge Functions cannot replace the agent: they run in the cloud and have no route
to private campus addresses (and ARP only works from inside the same network).

---

## Setup

### 1. Database (Supabase → SQL Editor)

Each file is safe to run more than once.

| File | Purpose |
|---|---|
| `supabase/migration_agent_jobs.sql` | **Required.** Request queue for Add Device / Config Backup on the hosted dashboard. |
| `supabase/migration_snmp_status.sql` | Shows why a device isn't answering SNMP: unreachable, disabled, authentication failed or timeout. |
| `supabase/migration_agent_watchdog.sql` | Optional. Raises a critical alert if the agent stops reporting for 3 minutes. |

### 2. Dashboard (Vercel)

The project `netwatch-nms` has these Production variables:
`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `GEMINI_API_KEY`.

To publish new code, run in the project folder:

```powershell
vercel --prod
```

### 3. Agent (monitoring laptop, Windows)

The agent runs under pm2 as `securenet` and starts by itself at login: a script in the Windows Startup
folder (`start-securenet.bat`) runs `pm2 resurrect`, which restores the saved pm2 list.

It reads the Supabase URL and service-role key from `.env` in the project folder. To set it up again from
scratch:

```powershell
pm2 start C:\Projects\NMS\poller\agent.js --name securenet --cwd C:\Projects\NMS\poller
pm2 save
```

---

## Day-to-day

| | |
|---|---|
| Is the agent running? | `pm2 list` |
| Live log | `pm2 logs securenet` |
| Restart (after changing agent code or `.env`) | `pm2 restart securenet` |
| Stop | `pm2 stop securenet` |

In the dashboard, the indicator at the top right turns red and reads **"Agent offline — data not
updating"** when the agent has not reported for a minute. With the watchdog installed you also get a
critical alert.

Optional settings in `poller/.env` (or the project `.env`):

| Setting | Default | Meaning |
|---|---|---|
| `SCAN_INTERVAL_MS` | `15000` | Device check / network sweep interval |
| `POLL_INTERVAL_MS` | `60000` | Generic SNMP poll interval |
| `MIKROTIK_POLL_MS` | `15000` | MikroTik SNMP poll interval |
| `JOB_POLL_MS` | `2000` | How often dashboard requests are picked up |
| `AGENT_PRIORITY` | `0` | If the agent is ever started on a second computer, the higher priority one monitors and the other stands by |

---

## Security

- **No inbound access to campus.** The agent only makes outbound HTTPS connections to Supabase.
- **The service_role key** gives full database access. It lives only in the local `.env` file and in
  Vercel's encrypted environment variables. It is never sent to browsers and must never be committed to Git.
- **Requests to the agent** (`agent_jobs`) can only be created by the server-side API after checking the
  signed-in user's permission (`devices.manage` / `config.manage`); dashboard users have no direct access
  to that table. The agent validates every request again before running it, and finished requests are
  deleted after an hour.
- **SNMP is read-only** (v2c). Keep each device's community restricted to the monitoring laptop's IP address.

---

## What runs where

| Function | Where it runs |
|---|---|
| Network sweep, discovery, online/offline status, alerts (ICMP + ARP) | Agent |
| MikroTik SNMP (system, CPU, memory, interfaces, traffic) | Agent |
| SNMP for other devices (uptime, CPU, memory, model, firmware, traffic) | Agent |
| Add Device live detection, Config Backup snapshots | Agent, on request from the dashboard |
| Dashboard pages, login, roles, reports, AI insights | Vercel |
| Data, realtime updates, agent watchdog | Supabase |

Running the dashboard locally (`npm run dev`) still works for development. When the agent is reporting,
the local server leaves all monitoring to it; with no agent running, the local server falls back to doing
the checks itself.

---

## Limits to know about

- **Monitoring runs only while the laptop is on, signed in and on the campus network.** When it is off or
  asleep, device statuses stop updating; the dashboard stays reachable, shows the last data and says the
  agent is offline.
- **On another network** (home, hotspot) the agent scans that network instead: it would add that network's
  devices and could mark manually added campus devices offline.
- **Email notifications and the daily report snapshot** are triggered from an open dashboard tab
  (and email needs `SMTP_*` variables, which are not configured).
- **Devices on other subnets** (for example behind the hEX) are only reachable if the laptop has a route to
  them, and ARP/MAC detection only works on the laptop's own subnet.
