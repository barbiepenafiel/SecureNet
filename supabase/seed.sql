-- NetWatch NMS — Seed Data
-- Run AFTER schema.sql

-- ── Devices ────────────────────────────────────────────────
INSERT INTO devices (name, type, ip, location, status, uptime, cpu, mem) VALUES
  ('Core-FW-1',  'Firewall',    '192.168.1.1',   'Data Center', 'up',   '47d 3h',  22, 38),
  ('Core-SW-1',  'Switch',      '192.168.1.2',   'Data Center', 'warn', '47d 3h',  87, 61),
  ('SW-A1',      'Switch',      '192.168.1.10',  'Building A',  'up',   '32d 1h',  12, 24),
  ('SW-A2',      'Switch',      '192.168.1.11',  'Building A',  'up',   '32d 1h',   9, 19),
  ('SW-B2',      'Switch',      '192.168.2.10',  'Building B',  'down', '—',        0,  0),
  ('SW-C1',      'Switch',      '192.168.3.10',  'Building C',  'up',   '18d 7h',  14, 31),
  ('AP-A-01',    'Access Point','192.168.1.21',  'Building A',  'up',   '32d',     18, 42),
  ('AP-A-02',    'Access Point','192.168.1.22',  'Building A',  'up',   '32d',     22, 44),
  ('AP-A-03',    'Access Point','192.168.1.23',  'Building A',  'up',   '30d',     16, 40),
  ('AP-A-04',    'Access Point','192.168.1.24',  'Building A',  'up',   '30d',     21, 46),
  ('AP-B-01',    'Access Point','192.168.2.21',  'Building B',  'down', '—',        0,  0),
  ('AP-B-02',    'Access Point','192.168.2.22',  'Building B',  'down', '—',        0,  0),
  ('AP-C-01',    'Access Point','192.168.3.21',  'Building C',  'up',   '18d',     19, 38),
  ('AP-C-02',    'Access Point','192.168.3.22',  'Building C',  'up',   '18d',     14, 33),
  ('SRV-DC-01',  'Server',      '10.0.0.10',     'Data Center', 'up',   '90d 11h', 34, 72),
  ('SRV-DC-02',  'Server',      '10.0.0.11',     'Data Center', 'up',   '90d 11h', 41, 68),
  ('SRV-DC-03',  'Server',      '10.0.0.12',     'Data Center', 'up',   '60d 2h',  28, 55)
ON CONFLICT (name) DO NOTHING;

-- ── Alerts ─────────────────────────────────────────────────
INSERT INTO alerts (severity, title, meta, acked, suppressed, root_cause) VALUES
  ('crit', 'Switch-B2 unreachable',         'Building B · 3 min ago',                   false, false, null),
  ('crit', 'AP-B-01 unreachable',           'Root cause: Switch-B2',                     false, true,  'Switch-B2'),
  ('crit', 'AP-B-02 unreachable',           'Root cause: Switch-B2',                     false, true,  'Switch-B2'),
  ('warn', 'Core-SW-1 CPU 87%',             'Building A · Data Center · 12 min ago',     false, false, null),
  ('warn', 'WAN uplink latency 180ms',      'Threshold: 100ms · 18 min ago',             false, false, null),
  ('info', 'New firmware: SW-A1 → 1.0.5',  'Current 1.0.4 · Available 1.0.5',           false, false, null),
  ('warn', 'AP-A-04 clients near limit',    '21/25 clients · Building A · Floor 1',      true,  false, null);

-- ── Clients ────────────────────────────────────────────────
INSERT INTO clients (hostname, mac, ip, ap, building, rssi, tx, rx, first_seen, last_seen, status) VALUES
  ('LAPTOP-ADMIN-01',  'A4:C3:F0:81:2B:11', '192.168.1.101', 'AP-A-01', 'Building A', -52, '2.4 GB', '820 MB', '2026-10-01 08:00:00+08', NOW(), 'up'),
  ('DESKTOP-LAB-04',   'B8:27:EB:7C:3A:FF', '192.168.1.104', 'AP-A-02', 'Building A', -58, '1.9 GB', '240 MB', '2026-09-15 08:00:00+08', NOW(), 'up'),
  ('iPhone-B4:7E:F1',  'B4:7E:F1:CC:12:30', '192.168.1.150', 'AP-A-03', 'Building A', -68, '1.1 GB', '180 MB', '2026-11-01 08:00:00+08', NOW(), 'up'),
  ('WORKSTATION-C2',   'DC:A6:32:4B:11:22', '192.168.3.102', 'AP-C-01', 'Building C', -55, '940 MB', '310 MB', '2026-08-20 08:00:00+08', NOW(), 'up'),
  ('MacBook-9A:21:CD', '9A:21:CD:EF:44:88', '192.168.1.155', 'AP-A-01', 'Building A', -61, '880 MB', '420 MB', '2026-10-15 08:00:00+08', NOW(), 'up'),
  ('Unknown',          'E4:5F:01:9D:72:AB', '192.168.2.188', '—',       'Building B', -74, '12 MB',  '4 MB',   '2026-11-04 10:00:00+08', NOW(), 'warn'),
  ('TABLET-CLASS-01',  'FC:2A:9C:88:11:4D', '192.168.1.170', 'AP-A-04', 'Building A', -63, '340 MB', '90 MB',  '2026-10-20 08:00:00+08', NOW(), 'up')
ON CONFLICT (mac) DO NOTHING;

-- ── SLA Data ───────────────────────────────────────────────
INSERT INTO sla_data (device_name, building, uptime_pct, downtime, incidents, sla_target) VALUES
  ('Core-FW-1', 'DC',     100.00, '0m',     0, 99.90),
  ('Core-SW-1', 'DC',      99.90, '43m',    1, 99.90),
  ('SW-A1',     'Bldg A', 100.00, '0m',     0, 99.50),
  ('SW-A2',     'Bldg A', 100.00, '0m',     0, 99.50),
  ('SW-B2',     'Bldg B',  98.10, '8h 12m', 3, 99.50),
  ('AP-B-01',   'Bldg B',  98.10, '8h 12m', 3, 99.00),
  ('SW-C1',     'Bldg C',  99.70, '2h 1m',  1, 99.50),
  ('SRV-DC-01', 'DC',     100.00, '0m',     0, 99.90);

-- ── Lifecycle ──────────────────────────────────────────────
INSERT INTO lifecycle (device_name, model, firmware, latest_fw, warranty_date, eom_date, eol_date) VALUES
  ('Core-FW-1', 'Cisco ASA 5516-X',  '9.14.3',  '9.14.5', '2027-06-30', '2026-01-01', '2028-01-01'),
  ('Core-SW-1', 'Cisco Cat 9300-48P','17.6.4',  '17.9.3', '2028-03-15', '2027-06-01', '2030-01-01'),
  ('SW-A1',     'TP-Link TL-SG3428', '1.0.4',   '1.0.5',  '2025-12-01', '2025-12-01', '2027-06-01'),
  ('SW-B2',     'TP-Link TL-SG3428', '1.0.3',   '1.0.5',  '2025-11-15', '2025-12-01', '2027-06-01'),
  ('AP-A-01',   'Omada EAP670',      '5.0.4',   '5.1.0',  '2026-05-20', '2027-01-01', '2029-01-01'),
  ('AP-C-01',   'Omada EAP670',      '5.1.0',   '5.1.0',  '2027-01-10', '2027-01-01', '2029-01-01'),
  ('SRV-DC-01', 'Dell PowerEdge R750','2.8.1',  '2.8.1',  '2028-09-01', '2029-01-01', '2031-01-01')
ON CONFLICT (device_name) DO NOTHING;

-- ── Config Backups ─────────────────────────────────────────
TRUNCATE TABLE config_backups;
INSERT INTO config_backups (device_name, backed_up_at, size_kb, changed, backup_by, content) VALUES
  ('Core-FW-1', '2026-11-04 02:14:00+08', 48, true, 'scheduler',
   E'! Core-FW-1 — Cisco ASA 5516-X — 2026-11-04\nhostname Core-FW-1\ninterface GigabitEthernet0/0\n nameif outside\n ip address 203.0.113.100 255.255.255.0\ninterface GigabitEthernet0/1\n nameif inside\n ip address 192.168.1.1 255.255.0.0\nroute outside 0.0.0.0 0.0.0.0 203.0.113.2 1\nroute outside 0.0.0.0 0.0.0.0 203.0.114.1 10\naccess-list OUTSIDE_IN extended permit icmp any any\nnat (inside,outside) dynamic interface\nsnmp-server community nw2026 RO\nsnmp-server location DNSC Data Center\nlogging enable\nlogging buffered informational'),
  ('Core-SW-1', '2026-11-04 02:14:00+08', 32, false, 'scheduler', null),
  ('SW-A1',     '2026-11-04 02:14:00+08', 18, false, 'scheduler', null),
  ('SW-B2',     '2026-11-03 02:14:00+08', 18, false, 'scheduler', null),
  ('Core-FW-1', '2026-11-03 02:14:00+08', 47, true,  'jdelacruz',
   E'! Core-FW-1 — Cisco ASA 5516-X — 2026-11-03\nhostname Core-FW-1\ninterface GigabitEthernet0/0\n nameif outside\n ip address 203.0.113.100 255.255.255.0\ninterface GigabitEthernet0/1\n nameif inside\n ip address 192.168.1.1 255.255.0.0\nroute outside 0.0.0.0 0.0.0.0 203.0.113.1 1\naccess-list OUTSIDE_IN extended permit icmp any any\nnat (inside,outside) dynamic interface\nsnmp-server community public RO\nsnmp-server location DNSC Data Center\nlogging enable\nlogging buffered informational');

-- ── Audit Log ──────────────────────────────────────────────
INSERT INTO audit_log (logged_at, user_name, user_ip, action, object_name, before_val, after_val) VALUES
  ('2026-11-04 10:42:11+08', 'Barbie Admin', '192.168.1.5',  'Alert Acknowledged', 'Core-SW-1 CPU',      'active',          'acked'),
  ('2026-11-04 10:30:00+08', 'scheduler',    '10.0.0.1',     'Config Backup',      'Core-FW-1',          '—',               '48 KB saved'),
  ('2026-11-04 09:15:44+08', 'jdelacruz',    '192.168.1.44', 'Threshold Changed',  'CPU Critical',       '90%',             '95%'),
  ('2026-11-04 08:00:00+08', 'scheduler',    '10.0.0.1',     'Report Sent',        'Daily Alert Digest', '—',               'Sent to oncall@'),
  ('2026-11-03 23:14:02+08', 'jdelacruz',    '192.168.1.44', 'Config Change',      'Core-FW-1 routing',  '1 default route', '2 default routes'),
  ('2026-11-03 09:01:11+08', 'Barbie Admin', '192.168.1.5',  'User Login',         'penafiel.barbie@…',  '—',               'Success'),
  ('2026-11-02 14:23:08+08', 'msantos',      '192.168.3.20', 'User Login',         'msantos@dnsc.edu.ph','—',               'Success'),
  ('2026-11-02 11:00:00+08', 'scheduler',    '10.0.0.1',     'Discovery Scan',     '192.168.0.0/16',     '—',               '17 devices found');

-- ── Maintenance Windows ────────────────────────────────────
INSERT INTO maintenance_windows (name, devices, starts_at, ends_at, recurrence, note, status) VALUES
  ('Weekly Patch Night',     'All switches',       '2026-11-08 23:00:00+08', '2026-11-09 03:00:00+08', 'Weekly', 'Automated patch window',      'Scheduled'),
  ('Bldg B UPS Replacement', 'SW-B2, AP-B-01, AP-B-02', '2026-11-06 08:00:00+08', '2026-11-06 12:00:00+08', 'Once', 'Hardware maintenance', 'Upcoming');
