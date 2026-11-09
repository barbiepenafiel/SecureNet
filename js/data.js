// ── Sample data ──────────────────────────────────────────────

const DEVICES = [
  { name:'Core-FW-1',  type:'Firewall',      ip:'192.168.1.1',   loc:'Data Center', status:'up',   uptime:'47d 3h',  cpu:22,  mem:38 },
  { name:'Core-SW-1',  type:'Switch',         ip:'192.168.1.2',   loc:'Data Center', status:'warn', uptime:'47d 3h',  cpu:87,  mem:61 },
  { name:'SW-A1',      type:'Switch',         ip:'192.168.1.10',  loc:'Building A',  status:'up',   uptime:'32d 1h',  cpu:12,  mem:24 },
  { name:'SW-A2',      type:'Switch',         ip:'192.168.1.11',  loc:'Building A',  status:'up',   uptime:'32d 1h',  cpu:9,   mem:19 },
  { name:'SW-B2',      type:'Switch',         ip:'192.168.2.10',  loc:'Building B',  status:'down', uptime:'—',       cpu:0,   mem:0  },
  { name:'SW-C1',      type:'Switch',         ip:'192.168.3.10',  loc:'Building C',  status:'up',   uptime:'18d 7h',  cpu:14,  mem:31 },
  { name:'AP-A-01',    type:'Access Point',   ip:'192.168.1.21',  loc:'Building A',  status:'up',   uptime:'32d',     cpu:18,  mem:42 },
  { name:'AP-A-02',    type:'Access Point',   ip:'192.168.1.22',  loc:'Building A',  status:'up',   uptime:'32d',     cpu:22,  mem:44 },
  { name:'AP-A-03',    type:'Access Point',   ip:'192.168.1.23',  loc:'Building A',  status:'up',   uptime:'30d',     cpu:16,  mem:40 },
  { name:'AP-A-04',    type:'Access Point',   ip:'192.168.1.24',  loc:'Building A',  status:'up',   uptime:'30d',     cpu:21,  mem:46 },
  { name:'AP-B-01',    type:'Access Point',   ip:'192.168.2.21',  loc:'Building B',  status:'down', uptime:'—',       cpu:0,   mem:0  },
  { name:'AP-B-02',    type:'Access Point',   ip:'192.168.2.22',  loc:'Building B',  status:'down', uptime:'—',       cpu:0,   mem:0  },
  { name:'AP-C-01',    type:'Access Point',   ip:'192.168.3.21',  loc:'Building C',  status:'up',   uptime:'18d',     cpu:19,  mem:38 },
  { name:'AP-C-02',    type:'Access Point',   ip:'192.168.3.22',  loc:'Building C',  status:'up',   uptime:'18d',     cpu:14,  mem:33 },
  { name:'SRV-DC-01',  type:'Server',         ip:'10.0.0.10',     loc:'Data Center', status:'up',   uptime:'90d 11h', cpu:34,  mem:72 },
  { name:'SRV-DC-02',  type:'Server',         ip:'10.0.0.11',     loc:'Data Center', status:'up',   uptime:'90d 11h', cpu:41,  mem:68 },
  { name:'SRV-DC-03',  type:'Server',         ip:'10.0.0.12',     loc:'Data Center', status:'up',   uptime:'60d 2h',  cpu:28,  mem:55 },
];

const ALERTS = [
  { id:1, sev:'crit', title:'Switch-B2 unreachable',         meta:'Building B · 3 min ago',                       acked:false, suppressed:false, rootCause:null },
  { id:2, sev:'crit', title:'AP-B-01 unreachable',           meta:'Root cause: Switch-B2',                        acked:false, suppressed:true,  rootCause:'Switch-B2' },
  { id:3, sev:'crit', title:'AP-B-02 unreachable',           meta:'Root cause: Switch-B2',                        acked:false, suppressed:true,  rootCause:'Switch-B2' },
  { id:4, sev:'warn', title:'Core-SW-1 CPU 87%',             meta:'Building A · Data Center · 12 min ago',        acked:false, suppressed:false, rootCause:null },
  { id:5, sev:'warn', title:'WAN uplink latency 180ms',      meta:'Threshold: 100ms · 18 min ago',                acked:false, suppressed:false, rootCause:null },
  { id:6, sev:'info', title:'New firmware: SW-A1 → 1.0.5',  meta:'Current 1.0.4 · Available 1.0.5',              acked:false, suppressed:false, rootCause:null },
  { id:7, sev:'warn', title:'AP-A-04 clients near limit',    meta:'21/25 clients · Building A · Floor 1',         acked:true,  suppressed:false, rootCause:null },
];

const CLIENTS = [
  { host:'LAPTOP-ADMIN-01',  mac:'A4:C3:F0:81:2B:11', ip:'192.168.1.101', ap:'AP-A-01', bldg:'Building A', rssi:-52, tx:'2.4 GB',  rx:'820 MB', first:'2026-10-01', last:'just now',  status:'up' },
  { host:'DESKTOP-LAB-04',   mac:'B8:27:EB:7C:3A:FF', ip:'192.168.1.104', ap:'AP-A-02', bldg:'Building A', rssi:-58, tx:'1.9 GB',  rx:'240 MB', first:'2026-09-15', last:'just now',  status:'up' },
  { host:'iPhone-B4:7E:F1',  mac:'B4:7E:F1:CC:12:30', ip:'192.168.1.150', ap:'AP-A-03', bldg:'Building A', rssi:-68, tx:'1.1 GB',  rx:'180 MB', first:'2026-11-01', last:'2 min ago', status:'up' },
  { host:'WORKSTATION-C2',   mac:'DC:A6:32:4B:11:22', ip:'192.168.3.102', ap:'AP-C-01', bldg:'Building C', rssi:-55, tx:'940 MB',  rx:'310 MB', first:'2026-08-20', last:'just now',  status:'up' },
  { host:'MacBook-9A:21:CD', mac:'9A:21:CD:EF:44:88', ip:'192.168.1.155', ap:'AP-A-01', bldg:'Building A', rssi:-61, tx:'880 MB',  rx:'420 MB', first:'2026-10-15', last:'just now',  status:'up' },
  { host:'Unknown',          mac:'E4:5F:01:9D:72:AB', ip:'192.168.2.188', ap:'—',       bldg:'Building B', rssi:-74, tx:'12 MB',   rx:'4 MB',   first:'2026-11-04', last:'offline',   status:'warn' },
  { host:'TABLET-CLASS-01',  mac:'FC:2A:9C:88:11:4D', ip:'192.168.1.170', ap:'AP-A-04', bldg:'Building A', rssi:-63, tx:'340 MB',  rx:'90 MB',  first:'2026-10-20', last:'just now',  status:'up' },
];

const SLA_DATA = [
  { name:'Core-FW-1', bldg:'DC',     uptime:100,  dt:'0m',      inc:0, target:99.9 },
  { name:'Core-SW-1', bldg:'DC',     uptime:99.9, dt:'43m',     inc:1, target:99.9 },
  { name:'SW-A1',     bldg:'Bldg A', uptime:100,  dt:'0m',      inc:0, target:99.5 },
  { name:'SW-A2',     bldg:'Bldg A', uptime:100,  dt:'0m',      inc:0, target:99.5 },
  { name:'SW-B2',     bldg:'Bldg B', uptime:98.1, dt:'8h 12m',  inc:3, target:99.5 },
  { name:'AP-B-01',   bldg:'Bldg B', uptime:98.1, dt:'8h 12m',  inc:3, target:99.0 },
  { name:'SW-C1',     bldg:'Bldg C', uptime:99.7, dt:'2h 1m',   inc:1, target:99.5 },
  { name:'SRV-DC-01', bldg:'DC',     uptime:100,  dt:'0m',      inc:0, target:99.9 },
];

const LIFECYCLE = [
  { name:'Core-FW-1', model:'Cisco ASA 5516-X',   fw:'9.14.3',  latest:'9.14.5', warranty:'2027-06-30', eom:'2026-01-01', eol:'2028-01-01' },
  { name:'Core-SW-1', model:'Cisco Cat 9300-48P',  fw:'17.6.4',  latest:'17.9.3', warranty:'2028-03-15', eom:'2027-06-01', eol:'2030-01-01' },
  { name:'SW-A1',     model:'TP-Link TL-SG3428',   fw:'1.0.4',   latest:'1.0.5',  warranty:'2025-12-01', eom:'2025-12-01', eol:'2027-06-01' },
  { name:'SW-B2',     model:'TP-Link TL-SG3428',   fw:'1.0.3',   latest:'1.0.5',  warranty:'2025-11-15', eom:'2025-12-01', eol:'2027-06-01' },
  { name:'AP-A-01',   model:'Omada EAP670',         fw:'5.0.4',   latest:'5.1.0',  warranty:'2026-05-20', eom:'2027-01-01', eol:'2029-01-01' },
  { name:'AP-C-01',   model:'Omada EAP670',         fw:'5.1.0',   latest:'5.1.0',  warranty:'2027-01-10', eom:'2027-01-01', eol:'2029-01-01' },
  { name:'SRV-DC-01', model:'Dell PowerEdge R750',  fw:'2.8.1',   latest:'2.8.1',  warranty:'2028-09-01', eom:'2029-01-01', eol:'2031-01-01' },
];

const CONFIG_BACKUPS = [
  { device:'Core-FW-1', ts:'2026-11-04 02:14', size:'48 KB', changed:true,  by:'scheduler' },
  { device:'Core-SW-1', ts:'2026-11-04 02:14', size:'32 KB', changed:false, by:'scheduler' },
  { device:'SW-A1',     ts:'2026-11-04 02:14', size:'18 KB', changed:false, by:'scheduler' },
  { device:'SW-B2',     ts:'2026-11-03 02:14', size:'18 KB', changed:false, by:'scheduler' },
  { device:'Core-FW-1', ts:'2026-11-03 02:14', size:'47 KB', changed:true,  by:'jdelacruz' },
];

const AUDIT_LOG = [
  { ts:'2026-11-04 10:42:11', user:'Barbie Admin',   ip:'192.168.1.5',  action:'Alert Acknowledged', obj:'Core-SW-1 CPU',      before:'active',       after:'acked' },
  { ts:'2026-11-04 10:30:00', user:'scheduler',      ip:'10.0.0.1',     action:'Config Backup',      obj:'Core-FW-1',          before:'—',            after:'48 KB saved' },
  { ts:'2026-11-04 09:15:44', user:'jdelacruz',      ip:'192.168.1.44', action:'Threshold Changed',  obj:'CPU Critical',       before:'90%',          after:'95%' },
  { ts:'2026-11-04 08:00:00', user:'scheduler',      ip:'10.0.0.1',     action:'Report Sent',        obj:'Daily Alert Digest', before:'—',            after:'Sent to oncall@' },
  { ts:'2026-11-03 23:14:02', user:'jdelacruz',      ip:'192.168.1.44', action:'Config Change',      obj:'Core-FW-1 routing',  before:'1 default route','after':'2 default routes' },
  { ts:'2026-11-03 09:01:11', user:'Barbie Admin',   ip:'192.168.1.5',  action:'User Login',         obj:'penafiel.barbie@…',  before:'—',            after:'Success' },
  { ts:'2026-11-02 14:23:08', user:'msantos',        ip:'192.168.3.20', action:'User Login',         obj:'msantos@dnsc.edu.ph',before:'—',            after:'Success' },
  { ts:'2026-11-02 11:00:00', user:'scheduler',      ip:'10.0.0.1',     action:'Discovery Scan',     obj:'192.168.0.0/16',     before:'—',            after:'47 devices found' },
];
