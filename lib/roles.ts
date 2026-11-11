// Role definitions shared by the browser, middleware and API routes.

export type Role = 'net_admin' | 'it_staff'

export const ROLE_LABEL: Record<Role, string> = {
  net_admin: 'Network Admin',
  it_staff:  'IT Staff',
}

export interface Profile {
  id: string
  email: string
  full_name: string
  role: Role
  building_access: string
  last_login: string | null
  created_at: string
}

// What each role is allowed to do.
//   Network Admin: everything.
//   IT Staff: watch the network and handle alerts, but not change
//   devices, settings, backups, users or maintenance windows.
export type Permission =
  | 'devices.manage'      // add / edit / delete devices, manual network scan
  | 'alerts.handle'       // acknowledge, resolve, reopen
  | 'alerts.suppress'     // suppress / unsuppress
  | 'maintenance.manage'  // create maintenance windows
  | 'settings.manage'     // settings page, alert thresholds
  | 'users.manage'        // add users, change roles
  | 'config.manage'       // config backup page
  | 'audit.view'          // audit log page

const PERMS: Record<Role, Permission[]> = {
  net_admin: [
    'devices.manage', 'alerts.handle', 'alerts.suppress', 'maintenance.manage',
    'settings.manage', 'users.manage', 'config.manage', 'audit.view',
  ],
  it_staff: ['alerts.handle'],
}

export function can(role: Role | null | undefined, perm: Permission): boolean {
  return !!role && PERMS[role].includes(perm)
}

// Pages only Network Admins can open
export const ADMIN_ONLY_PATHS = ['/settings', '/auditlog', '/config']

export function isAdminOnlyPath(path: string): boolean {
  return ADMIN_ONLY_PATHS.some(p => path === p || path.startsWith(p + '/'))
}
