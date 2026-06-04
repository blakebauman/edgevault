/** Shared real-time event contract between the workspace DO and clients. */

export type ConfigEventKind = 'config' | 'flag' | 'secret'

export type WorkspaceEvent =
  | {
      type: 'config.changed'
      environmentId: string
      key: string
      kind: ConfigEventKind
      version: number
      at: number
    }
  | { type: 'config.deleted'; environmentId: string; key: string; at: number }
  | { type: 'environment.created'; environmentId: string; slug: string; at: number }
  | {
      type: 'promotion.completed'
      key: string
      sourceEnvironmentId: string
      targetEnvironmentId: string
      at: number
    }
  | { type: 'presence'; users: string[]; at: number }
  | { type: 'pong'; at: number }

/** Messages a client may send to the server. */
export type ClientMessage = { type: 'ping' }

export function parseWorkspaceEvent(data: string): WorkspaceEvent | null {
  try {
    const value = JSON.parse(data) as { type?: unknown }
    return typeof value.type === 'string' ? (value as WorkspaceEvent) : null
  } catch {
    return null
  }
}
