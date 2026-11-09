/**
 * NetWatch — Database seeder
 * Run once: node seed.js
 */
const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '.env') })
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: false })
const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
)

async function upsert(table, rows, conflict = 'id') {
  const { error } = await supabase.from(table).upsert(rows, { onConflict: conflict, ignoreDuplicates: true })
  if (error) console.error(`  ✗ ${table}:`, error.message)
  else        console.log(`  ✓ ${table}: ${rows.length} rows`)
}

async function main() {
  console.log('Seeding NetWatch database...\n')

  // ── Devices ───────────────────────────────────────────────────────────────
  await upsert('devices', [
    { name: 'Core-FW-1',  type: 'Firewall',     ip: '192.168.1.1',   location: 'Data Center', status: 'up',   uptime: '47d 3h',  cpu: 22, mem: 38 },
    { name: 'Core-SW-1',  type: 'Switch',       ip: '192.168.1.2',   location: 'Data Center', status: 'warn', uptime: '47d 3h',  cpu: 87, mem: 61 },
    { name: 'SW-A1',      type: 'Switch',       ip: '192.168.1.10',  location: 'Building A',  status: 'up',   uptime: '32d 1h',  cpu: 12, mem: 24 },
    { name: 'SW-A2',      type: 'Switch',       ip: '192.168.1.11',  location: 'Building A',  status: 'up',   uptime: '32d 1h',  cpu:  9, mem: 19 },
    { name: 'SW-B2',      type: 'Switch',       ip: '192.168.2.10',  location: 'Building B',  status: 'down', uptime: '—',       cpu:  0, mem:  0 },
    { name: 'SW-C1',      type: 'Switch',       ip: '192.168.3.10',  location: 'Building C',  status: 'up',   uptime: '18d 7h',  cpu: 14, mem: 31 },
    { name: 'AP-A-01',    type: 'Access Point', ip: '192.168.1.21',  location: 'Building A',  status: 'up',   uptime: '32d',     cpu: 18, mem: 42 },
    { name: 'AP-A-02',    type: 'Access Point', ip: '192.168.1.22',  location: 'Building A',  status: 'up',   uptime: '32d',     cpu: 22, mem: 44 },
    { name: 'AP-A-03',    type: 'Access Point', ip: '192.168.1.23',  location: 'Building A',  status: 'up',   uptime: '30d',     cpu: 16, mem: 40 },
    { name: 'AP-A-04',    type: 'Access Point', ip: '192.168.1.24',  location: 'Building A',  status: 'up',   uptime: '30d',     cpu: 21, mem: 46 },
    { name: 'AP-B-01',    type: 'Access Point', ip: '192.168.2.21',  location: 'Building B',  status: 'down', uptime: '—',       cpu:  0, mem:  0 },
    { name: 'AP-B-02',    type: 'Access Point', ip: '192.168.2.22',  location: 'Building B',  status: 'down', uptime: '—',       cpu:  0, mem:  0 },
    { name: 'AP-C-01',    type: 'Access Point', ip: '192.168.3.21',  location: 'Building C',  status: 'up',   uptime: '18d',     cpu: 19, mem: 38 },
    { name: 'AP-C-02',    type: 'Access Point', ip: '192.168.3.22',  location: 'Building C',  status: 'up',   uptime: '18d',     cpu: 14, mem: 33 },
    { name: 'SRV-DC-01',  type: 'Server',       ip: '10.0.0.10',     location: 'Data Center', status: 'up',   uptime: '90d 11h', cpu: 34, mem: 72 },
    { name: 'SRV-DC-02',  type: 'Server',       ip: '10.0.0.11',     location: 'Data Center', status: 'up',   uptime: '90d 11h', cpu: 41, mem: 68 },
    { name: 'SRV-DC-03',  type: 'Server',       ip: '10.0.0.12',     location: 'Data Center', status: 'up',   uptime: '60d 2h',  cpu: 28, mem: 55 },
  ], 'name')

  // ── Alerts ────────────────────────────────────────────────────────────────
  // Delete existing first (alerts don't have a natural unique key)
  await supabase.from('alerts').delete().gt('id', 0)
  await upsert('alerts', [
    { severity: 'crit', title: 'Switch-B2 unreachable',        meta: 'Building B · 3 min ago',                 acked: false, suppressed: false, root_cause: null },
    { severity: 'crit', title: 'AP-B-01 unreachable',          meta: 'Root cause: Switch-B2',                  acked: false, suppressed: true,  root_cause: 'Switch-B2' },
    { severity: 'crit', title: 'AP-B-02 unreachable',          meta: 'Root cause: Switch-B2',                  acked: false, suppressed: true,  root_cause: 'Switch-B2' },
    { severity: 'warn', title: 'Core-SW-1 CPU 87%',            meta: 'Building A · Data Center · 12 min ago',  acked: false, suppressed: false, root_cause: null },
    { severity: 'warn', title: 'WAN uplink latency 180ms',     meta: 'Threshold: 100ms · 18 min ago',          acked: false, suppressed: false, root_cause: null },
    { severity: 'info', title: 'New firmware: SW-A1 → 1.0.5', meta: 'Current 1.0.4 · Available 1.0.5',        acked: false, suppressed: false, root_cause: null },
    { severity: 'warn', title: 'AP-A-04 clients near limit',   meta: '21/25 clients · Building A · Floor 1',   acked: true,  suppressed: false, root_cause: null },
  ], 'id')

  // ── Clients ───────────────────────────────────────────────────────────────
  await upsert('clients', [
    { hostname: 'LAPTOP-ADMIN-01',  mac: 'A4:C3:F0:81:2B:11', ip: '192.168.1.101', ap: 'AP-A-01', building: 'Building A', rssi: -52, tx: '2.4 GB', rx: '820 MB', first_seen: '2026-10-01 08:00:00+08', last_seen: new Date().toISOString(), status: 'up' },
    { hostname: 'DESKTOP-LAB-04',   mac: 'B8:27:EB:7C:3A:FF', ip: '192.168.1.104', ap: 'AP-A-02', building: 'Building A', rssi: -58, tx: '1.9 GB', rx: '240 MB', first_seen: '2026-09-15 08:00:00+08', last_seen: new Date().toISOString(), status: 'up' },
    { hostname: 'iPhone-B4:7E:F1',  mac: 'B4:7E:F1:CC:12:30', ip: '192.168.1.150', ap: 'AP-A-03', building: 'Building A', rssi: -68, tx: '1.1 GB', rx: '180 MB', first_seen: '2026-11-01 08:00:00+08', last_seen: new Date().toISOString(), status: 'up' },
    { hostname: 'WORKSTATION-C2',   mac: 'DC:A6:32:4B:11:22', ip: '192.168.3.102', ap: 'AP-C-01', building: 'Building C', rssi: -55, tx: '940 MB', rx: '310 MB', first_seen: '2026-08-20 08:00:00+08', last_seen: new Date().toISOString(), status: 'up' },
    { hostname: 'MacBook-9A:21:CD', mac: '9A:21:CD:EF:44:88', ip: '192.168.1.155', ap: 'AP-A-01', building: 'Building A', rssi: -61, tx: '880 MB', rx: '420 MB', first_seen: '2026-10-15 08:00:00+08', last_seen: new Date().toISOString(), status: 'up' },
    { hostname: 'Unknown',          mac: 'E4:5F:01:9D:72:AB', ip: '192.168.2.188', ap: '—',       building: 'Building B', rssi: -74, tx: '12 MB',  rx: '4 MB',   first_seen: '2026-11-04 10:00:00+08', last_seen: new Date().toISOString(), status: 'warn' },
    { hostname: 'TABLET-CLASS-01',  mac: 'FC:2A:9C:88:11:4D', ip: '192.168.1.170', ap: 'AP-A-04', building: 'Building A', rssi: -63, tx: '340 MB', rx: '90 MB',  first_seen: '2026-10-20 08:00:00+08', last_seen: new Date().toISOString(), status: 'up' },
  ], 'mac')

  // ── SLA Data ──────────────────────────────────────────────────────────────
  // sla_data has no unique constraint — delete then insert
  await supabase.from('sla_data').delete().gt('uptime_pct', -1)
  const { error: slaErr } = await supabase.from('sla_data').insert([
    { device_name: 'Core-FW-1', building: 'DC',     uptime_pct: 100.00, downtime: '0m',     incidents: 0, sla_target: 99.90 },
    { device_name: 'Core-SW-1', building: 'DC',     uptime_pct:  99.90, downtime: '43m',    incidents: 1, sla_target: 99.90 },
    { device_name: 'SW-A1',     building: 'Bldg A', uptime_pct: 100.00, downtime: '0m',     incidents: 0, sla_target: 99.50 },
    { device_name: 'SW-A2',     building: 'Bldg A', uptime_pct: 100.00, downtime: '0m',     incidents: 0, sla_target: 99.50 },
    { device_name: 'SW-B2',     building: 'Bldg B', uptime_pct:  98.10, downtime: '8h 12m', incidents: 3, sla_target: 99.50 },
    { device_name: 'AP-B-01',   building: 'Bldg B', uptime_pct:  98.10, downtime: '8h 12m', incidents: 3, sla_target: 99.00 },
    { device_name: 'SW-C1',     building: 'Bldg C', uptime_pct:  99.70, downtime: '2h 1m',  incidents: 1, sla_target: 99.50 },
    { device_name: 'SRV-DC-01', building: 'DC',     uptime_pct: 100.00, downtime: '0m',     incidents: 0, sla_target: 99.90 },
  ])
  if (slaErr) console.error('  ✗ sla_data:', slaErr.message)
  else        console.log('  ✓ sla_data: 8 rows')

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  await upsert('lifecycle', [
    { device_name: 'Core-FW-1', model: 'Cisco ASA 5516-X',   firmware: '9.14.3',  latest_fw: '9.14.5', warranty_date: '2027-06-30', eom_date: '2026-01-01', eol_date: '2028-01-01' },
    { device_name: 'Core-SW-1', model: 'Cisco Cat 9300-48P', firmware: '17.6.4',  latest_fw: '17.9.3', warranty_date: '2028-03-15', eom_date: '2027-06-01', eol_date: '2030-01-01' },
    { device_name: 'SW-A1',     model: 'TP-Link TL-SG3428',  firmware: '1.0.4',   latest_fw: '1.0.5',  warranty_date: '2025-12-01', eom_date: '2025-12-01', eol_date: '2027-06-01' },
    { device_name: 'SW-B2',     model: 'TP-Link TL-SG3428',  firmware: '1.0.3',   latest_fw: '1.0.5',  warranty_date: '2025-11-15', eom_date: '2025-12-01', eol_date: '2027-06-01' },
    { device_name: 'AP-A-01',   model: 'Omada EAP670',       firmware: '5.0.4',   latest_fw: '5.1.0',  warranty_date: '2026-05-20', eom_date: '2027-01-01', eol_date: '2029-01-01' },
    { device_name: 'AP-C-01',   model: 'Omada EAP670',       firmware: '5.1.0',   latest_fw: '5.1.0',  warranty_date: '2027-01-10', eom_date: '2027-01-01', eol_date: '2029-01-01' },
    { device_name: 'SRV-DC-01', model: 'Dell PowerEdge R750', firmware: '2.8.1',  latest_fw: '2.8.1',  warranty_date: '2028-09-01', eom_date: '2029-01-01', eol_date: '2031-01-01' },
  ], 'device_name')

  // ── Config Backups ────────────────────────────────────────────────────────
  await supabase.from('config_backups').delete().gt('id', 0)
  await upsert('config_backups', [
    { device_name: 'Core-FW-1', backed_up_at: '2026-11-04 02:14:00+08', size_kb: 48, changed: true,  backup_by: 'scheduler',
      content: '! Core-FW-1 — Cisco ASA 5516-X — 2026-11-04\nhostname Core-FW-1\ninterface GigabitEthernet0/0\n nameif outside\n ip address 203.0.113.100 255.255.255.0\ninterface GigabitEthernet0/1\n nameif inside\n ip address 192.168.1.1 255.255.0.0\nroute outside 0.0.0.0 0.0.0.0 203.0.113.2 1\nroute outside 0.0.0.0 0.0.0.0 203.0.114.1 10\naccess-list OUTSIDE_IN extended permit icmp any any\nnat (inside,outside) dynamic interface\nsnmp-server community nw2026 RO\nsnmp-server location DNSC Data Center\nlogging enable\nlogging buffered informational' },
    { device_name: 'Core-SW-1', backed_up_at: '2026-11-04 02:14:00+08', size_kb: 32, changed: false, backup_by: 'scheduler', content: null },
    { device_name: 'SW-A1',     backed_up_at: '2026-11-04 02:14:00+08', size_kb: 18, changed: false, backup_by: 'scheduler', content: null },
    { device_name: 'SW-B2',     backed_up_at: '2026-11-03 02:14:00+08', size_kb: 18, changed: false, backup_by: 'scheduler', content: null },
    { device_name: 'Core-FW-1', backed_up_at: '2026-11-03 02:14:00+08', size_kb: 47, changed: true,  backup_by: 'jdelacruz',
      content: '! Core-FW-1 — Cisco ASA 5516-X — 2026-11-03\nhostname Core-FW-1\ninterface GigabitEthernet0/0\n nameif outside\n ip address 203.0.113.100 255.255.255.0\ninterface GigabitEthernet0/1\n nameif inside\n ip address 192.168.1.1 255.255.0.0\nroute outside 0.0.0.0 0.0.0.0 203.0.113.1 1\naccess-list OUTSIDE_IN extended permit icmp any any\nnat (inside,outside) dynamic interface\nsnmp-server community public RO\nsnmp-server location DNSC Data Center\nlogging enable\nlogging buffered informational' },
  ], 'id')

  // ── Audit Log ─────────────────────────────────────────────────────────────
  await supabase.from('audit_log').delete().gt('id', 0)
  await upsert('audit_log', [
    { logged_at: '2026-11-04 10:42:11+08', user_name: 'Barbie Admin', user_ip: '192.168.1.5',  action: 'Alert Acknowledged', object_name: 'Core-SW-1 CPU',      before_val: 'active',          after_val: 'acked' },
    { logged_at: '2026-11-04 10:30:00+08', user_name: 'scheduler',    user_ip: '10.0.0.1',     action: 'Config Backup',      object_name: 'Core-FW-1',          before_val: '—',               after_val: '48 KB saved' },
    { logged_at: '2026-11-04 09:15:44+08', user_name: 'jdelacruz',    user_ip: '192.168.1.44', action: 'Threshold Changed',  object_name: 'CPU Critical',       before_val: '90%',             after_val: '95%' },
    { logged_at: '2026-11-04 08:00:00+08', user_name: 'scheduler',    user_ip: '10.0.0.1',     action: 'Report Sent',        object_name: 'Daily Alert Digest', before_val: '—',               after_val: 'Sent to oncall@' },
    { logged_at: '2026-11-03 23:14:02+08', user_name: 'jdelacruz',    user_ip: '192.168.1.44', action: 'Config Change',      object_name: 'Core-FW-1 routing',  before_val: '1 default route', after_val: '2 default routes' },
    { logged_at: '2026-11-03 09:01:11+08', user_name: 'Barbie Admin', user_ip: '192.168.1.5',  action: 'User Login',         object_name: 'penafiel.barbie@…',  before_val: '—',               after_val: 'Success' },
    { logged_at: '2026-11-02 14:23:08+08', user_name: 'msantos',      user_ip: '192.168.3.20', action: 'User Login',         object_name: 'msantos@dnsc.edu.ph', before_val: '—',              after_val: 'Success' },
    { logged_at: '2026-11-02 11:00:00+08', user_name: 'scheduler',    user_ip: '10.0.0.1',     action: 'Discovery Scan',     object_name: '192.168.0.0/16',     before_val: '—',               after_val: '17 devices found' },
  ], 'id')

  // ── Maintenance Windows ───────────────────────────────────────────────────
  await supabase.from('maintenance_windows').delete().gt('id', 0)
  await upsert('maintenance_windows', [
    { name: 'Weekly Patch Night',     devices: 'All switches',           starts_at: '2026-11-08 23:00:00+08', ends_at: '2026-11-09 03:00:00+08', recurrence: 'Weekly', note: 'Automated patch window',  status: 'Scheduled' },
    { name: 'Bldg B UPS Replacement', devices: 'SW-B2, AP-B-01, AP-B-02', starts_at: '2026-11-06 08:00:00+08', ends_at: '2026-11-06 12:00:00+08', recurrence: 'Once',   note: 'Hardware maintenance', status: 'Upcoming' },
  ], 'id')

  console.log('\nDone! Refresh http://localhost:3001 to see the data.')
}

main().catch(err => { console.error(err); process.exit(1) })
