/**
 * Device list for the SNMP poller.
 *
 * POLL_MODE=sim  → targets snmpsim agents on localhost (127.0.0.1) at ports 1161+
 * POLL_MODE=vm   → targets real Ubuntu VMs on 192.168.56.x (VirtualBox host-only)
 *
 * Set the mode:
 *   Windows:  set POLL_MODE=sim && node poller.js
 *   Linux/Mac: POLL_MODE=vm node poller.js
 */

const MODE = process.env.POLL_MODE || 'sim'

const DEVICES = [
  //  name           simPort  vmIp              iface  skip
  { name: 'Core-FW-1',  port: 1161, ip: '192.168.56.101', iface: 1 },
  { name: 'Core-SW-1',  port: 1162, ip: '192.168.56.102', iface: 1 },
  { name: 'SW-A1',      port: 1163, ip: '192.168.56.103', iface: 1 },
  { name: 'SW-A2',      port: 1164, ip: '192.168.56.104', iface: 1 },
  // SW-B2 is DOWN — no SNMP, skip polling (poller marks it down)
  { name: 'SW-C1',      port: 1165, ip: '192.168.56.106', iface: 1 },
  { name: 'AP-A-01',    port: 1166, ip: '192.168.56.107', iface: 1 },
  { name: 'AP-A-02',    port: 1167, ip: '192.168.56.108', iface: 1 },
  { name: 'AP-A-03',    port: 1168, ip: '192.168.56.109', iface: 1 },
  { name: 'AP-A-04',    port: 1169, ip: '192.168.56.110', iface: 1 },
  { name: 'AP-C-01',    port: 1170, ip: '192.168.56.111', iface: 1 },
  { name: 'AP-C-02',    port: 1171, ip: '192.168.56.112', iface: 1 },
  { name: 'SRV-DC-01',  port: 1172, ip: '192.168.56.113', iface: 1 },
  { name: 'SRV-DC-02',  port: 1173, ip: '192.168.56.114', iface: 1 },
  { name: 'SRV-DC-03',  port: 1174, ip: '192.168.56.115', iface: 1 },
]

module.exports = DEVICES.map(d => ({
  name:      d.name,
  ip:        MODE === 'vm' ? d.ip : '127.0.0.1',
  port:      MODE === 'vm' ? 161  : d.port,
  community: 'nw2026',
  iface:     d.iface,
}))
