// up = Online · down = Offline · unreachable = missed 1–2 checks ·
// unknown = the agent can't see this device's network
export type DeviceStatus = 'up' | 'warn' | 'down' | 'maint' | 'unreachable' | 'unknown'
export type AlertSeverity = 'crit' | 'warn' | 'info'

export interface Device {
  id: string
  name: string
  type: string
  ip: string
  location: string
  status: DeviceStatus
  uptime: string
  cpu: number
  mem: number
  model: string | null
  firmware: string | null
  snmp_community: string | null
  snmp_port: number | null
  created_at: string
  updated_at: string
  // Discovery (columns from supabase/migration_auto_discovery.sql)
  mac?: string | null
  hostname?: string | null
  vendor?: string | null
  source?: 'manual' | 'discovered'
  subnet?: string | null
  first_seen?: string | null
  last_seen?: string | null
  last_method?: string | null
  room_id?: string | null      // floor plan room (supabase/migration_floor_rooms.sql)
  // Topology link (supabase/migration_objectives.sql)
  parent_id?: string | null
  parent_port?: string | null
  parent_source?: 'snmp' | 'gateway' | 'manual' | null
  parent_updated_at?: string | null
}

export interface AgentStatus {
  id: string
  ip: string | null
  subnet: string | null
  interface: string | null
  hosts_seen: number
  last_seen: string
}

export interface Alert {
  id: number
  severity: AlertSeverity
  title: string
  meta: string
  acked: boolean
  suppressed: boolean
  root_cause: string | null
  resolution_notes: string | null
  resolved_at: string | null
  resolved_by: string | null
  created_at: string
  updated_at: string
  // Device details (columns from supabase/migration_alert_details.sql)
  device_name?: string | null
  device_ip?: string | null
  device_mac?: string | null
  location?: string | null
  detection_method?: string | null
  status?: 'online' | 'offline' | null
}

export interface AlertConfig {
  id: string
  cpu_warn_pct: number
  cpu_crit_pct: number
  mem_warn_pct: number
  mem_crit_pct: number
  latency_warn_ms: number
  latency_crit_ms: number
  flap_threshold: number
  grace_period_min: number
  updated_at: string
  updated_by: string
}

export interface Client {
  id: string
  hostname: string
  mac: string
  ip: string
  ap: string
  building: string
  rssi: number
  tx: string
  rx: string
  first_seen: string
  last_seen: string
  status: DeviceStatus
}

export interface SlaRecord {
  id: string
  device_name: string
  building: string
  uptime_pct: number
  downtime: string
  incidents: number
  sla_target: number
  period_start: string
  period_end: string
}

export interface LifecycleRecord {
  id: string
  device_name: string
  model: string
  firmware: string
  latest_fw: string
  warranty_date: string
  eom_date: string
  eol_date: string
}

export interface ConfigBackup {
  id: string
  device_name: string
  backed_up_at: string
  size_kb: number
  changed: boolean
  backup_by: string
  content: string | null
}

export interface AuditEntry {
  id: string
  logged_at: string
  user_name: string
  user_ip: string
  action: string
  object_name: string
  before_val: string
  after_val: string
}

export interface TrafficSample {
  id: number
  device_name: string
  interface: string
  in_mbps: number
  out_mbps: number
  sampled_at: string
}

export interface MaintenanceWindow {
  id: string
  name: string
  devices: string
  starts_at: string
  ends_at: string
  recurrence: string
  note: string | null
  status: string
}

export interface ScanResult {
  id: string
  ip: string
  mac: string | null
  hostname: string | null
  vendor: string | null
  device_type: string | null
  scan_type: 'icmp' | 'arp' | 'both'
  responded: boolean
  latency_ms: number | null
  scanned_at: string
}

// /api/notify/email — email is sent by the agent with its own SMTP settings
export interface SmtpStatus { configured: boolean; status: string | null; agentOnline: boolean; migrated: boolean }

export interface NotificationRecipient {
  id: string
  email: string
  name: string | null
  min_severity: 'crit' | 'warn'
  daily_report: boolean
  enabled: boolean
  created_at: string
}

export interface StatusEvent {
  id: number
  device_id: string
  device_name: string
  device_ip: string
  old_status: string | null
  new_status: string
  changed_at: string
}

export interface ReportSnapshot {
  id: string
  generated_at: string
  period_label: string
  total_devices: number
  online_count: number
  offline_count: number
  warn_count: number
  total_alerts: number
  crit_alerts: number
  resolved_alerts: number
  avg_uptime_pct: number | null
  avg_latency_ms: number | null
  top_issue: string | null
  summary_text: string | null
  generated_by: string
}

// Minimal DB generic type for createClient<Database>
export type Database = {
  public: {
    Tables: {
      devices: { Row: Device; Insert: Omit<Device, 'id' | 'created_at' | 'updated_at'>; Update: Partial<Device> }
      alerts: { Row: Alert; Insert: Omit<Alert, 'id' | 'created_at' | 'updated_at'>; Update: Partial<Alert> }
      clients: { Row: Client; Insert: Omit<Client, 'id'>; Update: Partial<Client> }
      sla_data: { Row: SlaRecord; Insert: Omit<SlaRecord, 'id'>; Update: Partial<SlaRecord> }
      lifecycle: { Row: LifecycleRecord; Insert: Omit<LifecycleRecord, 'id'>; Update: Partial<LifecycleRecord> }
      config_backups: { Row: ConfigBackup; Insert: Omit<ConfigBackup, 'id'>; Update: Partial<ConfigBackup> }
      audit_log: { Row: AuditEntry; Insert: Omit<AuditEntry, 'id'>; Update: Partial<AuditEntry> }
      maintenance_windows: { Row: MaintenanceWindow; Insert: Omit<MaintenanceWindow, 'id'>; Update: Partial<MaintenanceWindow> }
      scan_results:  { Row: ScanResult;  Insert: Omit<ScanResult, 'id' | 'scanned_at'>; Update: Partial<ScanResult> }
      alert_config:  { Row: AlertConfig; Insert: Omit<AlertConfig, 'id' | 'updated_at'>; Update: Partial<AlertConfig> }
    }
    Views: Record<string, never>
    Functions: Record<string, never>
  }
}
