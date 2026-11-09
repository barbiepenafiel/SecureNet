declare module 'net-snmp' {
  export interface VarBind {
    oid: string
    type: number
    value: unknown
  }
  export const Version1: number
  export const Version2c: number
  export function createSession(target: string, community: string, options?: Record<string, unknown>): {
    get(oids: string[], callback: (err: Error | null, varbinds: VarBind[]) => void): void
    close(): void
  }
}
