// ── Navigation ───────────────────────────────────────────────
const VIEW_LABELS = {
  dashboard: ['Dashboard','Overview'],
  devices:   ['Devices','All devices'],
  alerts:    ['Alerts','Active incidents'],
  topology:  ['Topology','Auto-discovered map'],
  floorplan: ['Floor Plan','Building A — Floor 1'],
  clients:   ['Clients','Connected endpoints'],
  traffic:   ['Traffic','Bandwidth & applications'],
  sla:       ['SLA / Uptime','30-day availability'],
  lifecycle: ['Lifecycle','Warranty & firmware'],
  config:    ['Config Backup','Backup & diff'],
  reports:   ['Reports','Scheduled exports'],
  settings:  ['Settings','Configuration'],
  auditlog:  ['Audit Log','Activity history'],
};

document.querySelectorAll('.nav-item[data-view]').forEach(el => {
  el.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(x => x.classList.remove('active'));
    document.querySelectorAll('.view').forEach(x => x.classList.remove('active'));
    el.classList.add('active');
    const v = el.dataset.view;
    document.getElementById('view-' + v).classList.add('active');
    const lbl = VIEW_LABELS[v] || [v, ''];
    document.getElementById('topbar-title').textContent = lbl[0];
    document.getElementById('topbar-sub').textContent = lbl[1];
    if (v === 'traffic') initTrafficCharts();
  });
});

// ── Helpers ──────────────────────────────────────────────────
function statusChip(s) {
  const map = { up:'<span class="chip chip-ok">Up</span>', warn:'<span class="chip chip-warn">Warning</span>', down:'<span class="chip chip-crit">Down</span>', maint:'<span class="chip chip-maint">Maintenance</span>' };
  return map[s] || s;
}
function cpuBadge(v) {
  if (!v) return '—';
  const c = v >= 90 ? 'var(--crit)' : v >= 75 ? 'var(--warn)' : 'var(--ok)';
  return `<span style="color:${c};font-weight:500">${v}%</span>`;
}
function makeUptimeBar(pct) {
  const segs = 30;
  const downSegs = Math.round((1 - pct / 100) * segs);
  return '<div class="uptime-bar">' + Array.from({ length: segs }, (_, i) => {
    const c = i >= segs - downSegs ? '#f85149' : '#3fb950';
    return `<div class="uptime-seg" style="background:${c};opacity:.7"></div>`;
  }).join('') + '</div>';
}

// ── Devices view ─────────────────────────────────────────────
function renderDevices(list) {
  document.getElementById('device-count').textContent = list.length;
  document.getElementById('devices-tbody').innerHTML = list.map(d => `
    <tr>
      <td><strong>${d.name}</strong></td>
      <td><span class="tag">${d.type}</span></td>
      <td class="mono">${d.ip}</td>
      <td>${d.loc}</td>
      <td>${statusChip(d.status)}</td>
      <td class="mono" style="font-size:12px">${d.uptime}</td>
      <td>${cpuBadge(d.cpu)}</td>
      <td>
        <div class="tbl-actions">
          <button class="btn btn-sm" onclick="showDeviceDetail('${d.name}')">Details</button>
          <button class="btn btn-sm" onclick="alert('Pinging ${d.name}…')">Ping</button>
        </div>
      </td>
    </tr>`).join('');
}
renderDevices(DEVICES);

document.getElementById('device-search').addEventListener('input', e => {
  const q = e.target.value.toLowerCase();
  renderDevices(DEVICES.filter(d => d.name.toLowerCase().includes(q) || d.ip.includes(q) || d.loc.toLowerCase().includes(q)));
});
document.getElementById('device-type').addEventListener('change', e => {
  const q = e.target.value;
  renderDevices(q ? DEVICES.filter(d => d.type === q) : DEVICES);
});
document.getElementById('device-bldg').addEventListener('change', e => {
  const q = e.target.value;
  renderDevices(q ? DEVICES.filter(d => d.loc === q) : DEVICES);
});

// ── Alerts view ──────────────────────────────────────────────
function renderAlerts(filter = 'all') {
  let list = ALERTS;
  if (filter === 'active')     list = ALERTS.filter(a => !a.acked && !a.suppressed);
  if (filter === 'acked')      list = ALERTS.filter(a => a.acked);
  if (filter === 'suppressed') list = ALERTS.filter(a => a.suppressed);
  document.getElementById('alerts-list').innerHTML = list.map(a => `
    <div class="alert-item ${a.suppressed ? 'suppressed' : ''}">
      <div class="alert-sev alert-sev-${a.sev}"></div>
      <div class="alert-body">
        <div class="alert-title">${a.title}
          ${a.suppressed ? '<span class="chip chip-off" style="font-size:11px;margin-left:6px">suppressed</span>' : ''}
          ${a.acked      ? '<span class="chip chip-ok"  style="font-size:11px;margin-left:6px">acked</span>' : ''}
        </div>
        <div class="alert-meta">${a.meta}</div>
      </div>
      <div class="alert-actions">
        ${!a.acked && !a.suppressed ? `<button class="btn btn-sm" onclick="ackAlertById(${a.id})">Ack</button>` : ''}
        <button class="btn btn-sm" onclick="showAlertDetail(${a.id})">Details</button>
      </div>
    </div>`).join('') || '<div style="padding:20px;color:var(--text3);text-align:center">No alerts in this category.</div>';
}
renderAlerts();

window.filterAlertTab = (el, tab) => {
  document.querySelectorAll('#view-alerts .tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  renderAlerts(tab);
};
window.ackAlertById = id => {
  const a = ALERTS.find(x => x.id === id);
  if (a) { a.acked = true; renderAlerts(); updateBadge(); }
};
window.ackAllAlerts = () => {
  ALERTS.forEach(a => { if (!a.suppressed) a.acked = true; });
  renderAlerts(); updateBadge();
};
function updateBadge() {
  const n = ALERTS.filter(a => !a.acked && !a.suppressed).length;
  document.getElementById('badge-alerts').textContent = n || '0';
}

// ── Clients view ─────────────────────────────────────────────
document.getElementById('clients-tbody').innerHTML = CLIENTS.map(c => `
  <tr>
    <td><div>${c.host}</div><div class="mono" style="color:var(--text3)">${c.mac}</div></td>
    <td class="mono">${c.ip}</td>
    <td>${c.ap}</td>
    <td>${c.bldg}</td>
    <td style="color:${c.rssi > -65 ? 'var(--ok)' : c.rssi > -75 ? 'var(--warn)' : 'var(--crit)'}">${c.rssi} dBm</td>
    <td>${c.tx} / ${c.rx}</td>
    <td style="color:var(--text3);font-size:12px">${c.first}</td>
    <td style="color:var(--text3);font-size:12px">${c.last}</td>
    <td>${statusChip(c.status)}</td>
  </tr>`).join('');

// ── SLA view ─────────────────────────────────────────────────
document.getElementById('sla-tbody').innerHTML = SLA_DATA.map(s => {
  const ok = s.uptime >= s.target;
  return `<tr>
    <td><strong>${s.name}</strong></td>
    <td>${s.bldg}</td>
    <td style="color:${ok ? 'var(--ok)' : 'var(--warn)'};font-weight:600">${s.uptime}%</td>
    <td style="color:var(--text3)">${s.dt}</td>
    <td>${s.inc}</td>
    <td>${s.target}%</td>
    <td>${ok ? '<span class="chip chip-ok">Met</span>' : '<span class="chip chip-warn">Below</span>'}</td>
    <td>${makeUptimeBar(s.uptime)}</td>
  </tr>`;
}).join('');

// ── Lifecycle view ───────────────────────────────────────────
const TODAY = new Date('2026-11-04');
document.getElementById('lifecycle-tbody').innerHTML = LIFECYCLE.map(d => {
  const fwOk  = d.fw === d.latest;
  const warExp = new Date(d.warranty) < TODAY;
  const eomExp = new Date(d.eom) < TODAY;
  return `<tr>
    <td><strong>${d.name}</strong></td>
    <td style="font-size:12px">${d.model}</td>
    <td class="mono">${d.fw}</td>
    <td class="mono" style="color:${fwOk ? 'var(--ok)' : 'var(--warn)'}">${d.latest}${fwOk ? '' : ' ↑'}</td>
    <td style="color:${warExp ? 'var(--crit)' : 'var(--text2)'}">${d.warranty}${warExp ? ' ⚠' : ''}</td>
    <td style="color:${eomExp ? 'var(--warn)' : 'var(--text3)'};font-size:12px">${d.eom}</td>
    <td style="font-size:12px;color:var(--text3)">${d.eol}</td>
    <td>${warExp ? '<span class="chip chip-crit">Expired</span>' : eomExp ? '<span class="chip chip-warn">EOM</span>' : fwOk ? '<span class="chip chip-ok">Current</span>' : '<span class="chip chip-warn">Update</span>'}</td>
  </tr>`;
}).join('');

// ── Config backup view ───────────────────────────────────────
document.getElementById('config-tbody').innerHTML = CONFIG_BACKUPS.map(c => `
  <tr>
    <td><strong>${c.device}</strong></td>
    <td class="mono" style="font-size:12px">${c.ts}</td>
    <td>${c.size}</td>
    <td>${c.changed ? '<span class="chip chip-warn">Changed</span>' : '<span class="chip chip-off">Same</span>'}</td>
    <td style="font-size:12px;color:var(--text3)">${c.by}</td>
    <td>
      <div class="tbl-actions">
        <button class="btn btn-sm" onclick="alert('Downloading config…')">Download</button>
        ${c.changed ? '<button class="btn btn-sm" onclick="showDiff()">Diff</button>' : ''}
      </div>
    </td>
  </tr>`).join('');

window.showDiff = () => openModal('Config Diff — Core-FW-1', `
  <div style="font-size:12px;color:var(--text3);margin-bottom:8px">2026-11-03 02:14 → 2026-11-04 02:14</div>
  <div style="background:var(--surface2);border-radius:var(--r);padding:14px;font-family:var(--mono);font-size:13px;line-height:1.8">
    <div style="color:var(--text3)">! ip routing</div>
    <div style="color:var(--crit)">- ip route 0.0.0.0/0 203.0.113.1</div>
    <div style="color:var(--ok)">+ ip route 0.0.0.0/0 203.0.113.2</div>
    <div style="color:var(--ok)">+ ip route 0.0.0.0/0 203.0.114.1 10</div>
    <div style="margin-top:8px;color:var(--text3)">! snmp</div>
    <div style="color:var(--crit)">- snmp-server community public RO</div>
    <div style="color:var(--ok)">+ snmp-server community nw2026 RO</div>
  </div>`);

// ── Audit log view ───────────────────────────────────────────
document.getElementById('audit-tbody').innerHTML = AUDIT_LOG.map(a => `
  <tr>
    <td class="mono" style="font-size:12px;white-space:nowrap">${a.ts}</td>
    <td>${a.user}</td>
    <td class="mono" style="font-size:11px;color:var(--text3)">${a.ip}</td>
    <td><span class="tag">${a.action}</span></td>
    <td style="font-size:12px">${a.obj}</td>
    <td class="mono" style="font-size:11px;color:var(--crit)">${a.before}</td>
    <td class="mono" style="font-size:11px;color:var(--ok)">${a.after}</td>
  </tr>`).join('');

// ── Dashboard charts ─────────────────────────────────────────
const chartBase = {
  responsive: true, maintainAspectRatio: false,
  plugins: {
    legend: { display: false },
    tooltip: { backgroundColor:'#161b22', borderColor:'#30363d', borderWidth:1, titleColor:'#e6edf3', bodyColor:'#8b949e' }
  },
  scales: {
    x: { grid:{ color:'rgba(48,54,61,.5)' }, ticks:{ color:'#6e7681', font:{size:11} } },
    y: { grid:{ color:'rgba(48,54,61,.5)' }, ticks:{ color:'#6e7681', font:{size:11} } }
  }
};

function hrs24() { return Array.from({length:24}, (_,i) => `${i}:00`); }
function rnd(min, range, n) { return Array.from({length:n}, () => Math.floor(Math.random() * range + min)); }

const trafficChart = new Chart(document.getElementById('trafficChart').getContext('2d'), {
  type: 'line',
  data: {
    labels: hrs24(),
    datasets: [
      { label:'Inbound',  data: rnd(200,600,24), borderColor:'#2f81f7', backgroundColor:'rgba(47,129,247,.1)', fill:true, tension:.4, pointRadius:0 },
      { label:'Outbound', data: rnd(100,400,24), borderColor:'#3fb950', backgroundColor:'rgba(63,185,80,.07)', fill:true, tension:.4, pointRadius:0 }
    ]
  },
  options: { ...chartBase, plugins:{ ...chartBase.plugins, legend:{ display:true, labels:{ color:'#8b949e', font:{size:11} } } } }
});

window.updateTrafficChart = range => {
  const pts = range === '24h' ? 24 : range === '7d' ? 7 : 30;
  trafficChart.data.labels = range === '24h' ? hrs24() : Array.from({length:pts}, (_,i) => `Day ${i+1}`);
  trafficChart.data.datasets[0].data = rnd(200, 600, pts);
  trafficChart.data.datasets[1].data = rnd(100, 400, pts);
  trafficChart.update();
};

new Chart(document.getElementById('devicePieChart').getContext('2d'), {
  type: 'doughnut',
  data: { labels:['Up','Warning','Down'], datasets:[{ data:[14,1,2], backgroundColor:['#3fb950','#d29922','#f85149'], borderWidth:0, hoverOffset:4 }] },
  options: { responsive:true, maintainAspectRatio:false, cutout:'70%',
    plugins:{ legend:{ display:true, position:'bottom', labels:{ color:'#8b949e', font:{size:11}, padding:12 } }, tooltip:{ backgroundColor:'#161b22', borderColor:'#30363d', borderWidth:1 } } }
});

// Traffic view charts (lazy init)
let trafficViewInited = false;
function initTrafficCharts() {
  if (trafficViewInited) return;
  trafficViewInited = true;
  new Chart(document.getElementById('appTrafficChart').getContext('2d'), {
    type: 'bar',
    data: {
      labels: ['HTTP/HTTPS','Video Stream','Microsoft 365','File Share','VoIP','Gaming','Cloud Backup','Social','Email','Other'],
      datasets: [{ data:[38,22,14,8,6,5,3,2,1,1], backgroundColor:'#2f81f7', borderRadius:4 }]
    },
    options: { ...chartBase, indexAxis:'y', scales:{ x:{ ...chartBase.scales.x, ticks:{ ...chartBase.scales.x.ticks, callback:v=>v+'%' } }, y:{ ...chartBase.scales.y } } }
  });
  new Chart(document.getElementById('ifaceChart').getContext('2d'), {
    type: 'line',
    data: {
      labels: hrs24(),
      datasets: [
        { label:'WAN (100 Mbps)', data: rnd(50,30,24), borderColor:'#2f81f7', tension:.4, pointRadius:0 },
        { label:'LAN Trunk',      data: rnd(25,25,24), borderColor:'#3fb950', tension:.4, pointRadius:0 }
      ]
    },
    options: { ...chartBase, plugins:{ ...chartBase.plugins, legend:{ display:true, labels:{ color:'#8b949e', font:{size:11} } } }, scales:{ ...chartBase.scales, y:{ ...chartBase.scales.y, ticks:{ ...chartBase.scales.y.ticks, callback:v=>v+'%' } } } }
  });
}

// ── Settings tabs ────────────────────────────────────────────
const STABS = ['notif','roles','maint','disc','integrations'];
window.switchSettingsTab = (el, id) => {
  document.querySelectorAll('#settings-tabs .tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  STABS.forEach(s => document.getElementById('stab-' + s).classList.toggle('hidden', s !== id));
};

// ── Floor plan tooltip ───────────────────────────────────────
window.showDeviceInfo = (name, type, ip, status, extra) => {
  const t = document.getElementById('fp-tooltip');
  t.innerHTML = `<strong>${name}</strong><br>${type} · ${ip}<br>Status: ${status}<br>${extra}`;
  t.classList.remove('hidden');
  t.style.left = '20px'; t.style.top = '20px';
  setTimeout(() => t.classList.add('hidden'), 3000);
};

// ── Modals ───────────────────────────────────────────────────
window.openModal = (title, body, footer) => {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = body;
  document.getElementById('modal-footer').innerHTML = footer || '<button class="btn" onclick="closeModal()">Close</button>';
  document.getElementById('modal-overlay').classList.remove('hidden');
};
window.closeModal = () => document.getElementById('modal-overlay').classList.add('hidden');
document.getElementById('modal-overlay').addEventListener('click', e => { if (e.target === document.getElementById('modal-overlay')) closeModal(); });

window.openAddDevice = () => openModal('Add Device', `
  <div class="form-row">
    <div class="form-group"><label class="form-label">Hostname</label><input class="form-input" placeholder="e.g. AP-A-05"></div>
    <div class="form-group"><label class="form-label">IP Address</label><input class="form-input" placeholder="192.168.1.x"></div>
  </div>
  <div class="form-row">
    <div class="form-group"><label class="form-label">Type</label><select class="form-select"><option>Router</option><option>Switch</option><option selected>Access Point</option><option>Server</option><option>Firewall</option></select></div>
    <div class="form-group"><label class="form-label">Building</label><select class="form-select"><option>Building A</option><option>Building B</option><option>Building C</option><option>Data Center</option></select></div>
  </div>
  <div class="form-group"><label class="form-label">SNMP Community</label><input class="form-input" placeholder="nw2026"></div>
  <div class="form-group"><label class="form-label">Tags</label><input class="form-input" placeholder="floor-1, wifi-6"></div>`,
  `<button class="btn" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="closeModal();alert('Device added!')">Add Device</button>`
);

window.openMaintenance = () => openModal('New Maintenance Window', `
  <div class="form-group"><label class="form-label">Name</label><input class="form-input" placeholder="e.g. Patch night"></div>
  <div class="form-group"><label class="form-label">Devices</label><input class="form-input" placeholder="SW-A1, SW-A2 or All"></div>
  <div class="form-row">
    <div class="form-group"><label class="form-label">Start</label><input class="form-input" type="datetime-local" value="2026-11-05T22:00"></div>
    <div class="form-group"><label class="form-label">End</label><input class="form-input" type="datetime-local" value="2026-11-06T02:00"></div>
  </div>
  <div class="form-group"><label class="form-label">Recurrence</label><select class="form-select"><option>Once</option><option>Weekly</option><option>Monthly</option></select></div>
  <div class="form-group"><label class="form-label">Note</label><textarea class="form-textarea" placeholder="Reason for maintenance…"></textarea></div>`,
  `<button class="btn" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="closeModal();alert('Maintenance window saved!')">Save</button>`
);

window.openNewReport = () => openModal('New Scheduled Report', `
  <div class="form-group"><label class="form-label">Report Name</label><input class="form-input" placeholder="e.g. Weekly Summary"></div>
  <div class="form-group"><label class="form-label">Template</label><select class="form-select"><option>Executive SLA Summary</option><option>Alert Trends</option><option>Wireless Client Report</option><option>Custom</option></select></div>
  <div class="form-row">
    <div class="form-group"><label class="form-label">Schedule</label><select class="form-select"><option>Daily</option><option selected>Weekly</option><option>Monthly</option></select></div>
    <div class="form-group"><label class="form-label">Time</label><input class="form-input" type="time" value="08:00"></div>
  </div>
  <div class="form-group"><label class="form-label">Recipients</label><input class="form-input" placeholder="email1@example.com, email2@example.com"></div>
  <div class="form-group"><label class="form-label">Format</label><select class="form-select"><option>PDF</option><option>HTML Email</option><option>CSV</option></select></div>`,
  `<button class="btn" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="closeModal();alert('Report scheduled!')">Schedule</button>`
);

window.openAddUser = () => openModal('Add User', `
  <div class="form-row">
    <div class="form-group"><label class="form-label">Full Name</label><input class="form-input"></div>
    <div class="form-group"><label class="form-label">Email</label><input class="form-input" type="email"></div>
  </div>
  <div class="form-row">
    <div class="form-group"><label class="form-label">Role</label><select class="form-select"><option>Admin</option><option>Viewer</option><option>Technician</option></select></div>
    <div class="form-group"><label class="form-label">Building Access</label><select class="form-select"><option>All sites</option><option>Building A</option><option>Building B</option><option>Building C</option></select></div>
  </div>
  <div class="form-group"><label class="form-label">Require MFA</label><label class="toggle"><input type="checkbox" checked><span class="toggle-slider"></span></label></div>`,
  `<button class="btn" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="closeModal();alert('User invited!')">Send Invite</button>`
);

window.showDeviceDetail = name => {
  const d = DEVICES.find(x => x.name === name);
  if (!d) return;
  openModal(`Device: ${d.name}`, `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px">
      <div><div class="form-label">Type</div><div>${d.type}</div></div>
      <div><div class="form-label">IP</div><div class="mono">${d.ip}</div></div>
      <div><div class="form-label">Location</div><div>${d.loc}</div></div>
      <div><div class="form-label">Status</div><div>${statusChip(d.status)}</div></div>
      <div><div class="form-label">Uptime</div><div class="mono">${d.uptime}</div></div>
      <div><div class="form-label">CPU / Mem</div><div>${cpuBadge(d.cpu)} / ${d.mem ? d.mem + '%' : '—'}</div></div>
    </div>
    <div style="font-weight:600;margin-bottom:8px">Recent Events</div>
    <div class="timeline">
      <div class="tl-item"><div class="tl-dot" style="background:var(--ok)"></div><div class="tl-body"><div class="tl-title">Device polled — OK</div><div class="tl-time">Just now</div></div></div>
      <div class="tl-item"><div class="tl-dot" style="background:var(--info)"></div><div class="tl-body"><div class="tl-title">Config backup completed</div><div class="tl-time">02:14 today</div></div></div>
    </div>`);
};

window.showAlertDetail = id => {
  const a = ALERTS.find(x => x.id === id);
  if (!a) return;
  openModal('Alert Detail', `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px">
      <div><div class="form-label">Severity</div><div class="chip chip-${a.sev}" style="display:inline-flex">${a.sev.toUpperCase()}</div></div>
      <div><div class="form-label">Status</div><div>${a.acked ? 'Acknowledged' : a.suppressed ? 'Suppressed' : 'Active'}</div></div>
    </div>
    <div class="form-label">Title</div><div style="margin-bottom:12px;font-weight:500">${a.title}</div>
    <div class="form-label">Details</div><div style="color:var(--text3);margin-bottom:14px">${a.meta}</div>
    <div style="padding:10px;background:var(--surface2);border-radius:var(--r);font-size:12px">
      <div style="font-weight:600;margin-bottom:6px">Escalation status</div>
      <div>L1: notified · L2: pending (15 min without ack)</div>
    </div>`,
    `<button class="btn" onclick="closeModal()">Close</button><button class="btn btn-ok" onclick="ackAlertById(${id});closeModal()">Acknowledge</button>`);
};

// ── Live clock ───────────────────────────────────────────────
function tickClock() {
  const el = document.getElementById('live-clock');
  if (el) el.textContent = new Date().toLocaleTimeString();
}
tickClock();
setInterval(tickClock, 1000);
