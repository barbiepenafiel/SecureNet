// Runs once when the Next.js server starts.
// Starts the device monitor (ICMP → ARP → SNMP every 15 s, alerts on
// online/offline changes) so it keeps running even when no dashboard tab is
// open — browsers slow down timers in background tabs.
export async function register() {
  // This exact `if` form lets Next drop the Node-only code from the edge bundle.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // On Vercel the server can't reach the campus LAN; the local agent covers that.
    if (!process.env.VERCEL) {
      const { startMonitorTimer } = await import('./lib/alert-monitor')
      startMonitorTimer()
    }
  }
}
