import type { AuditEvent } from '@edgevault/edge-protocol'

/** Emit an audit event to the cold warehouse queue (consumed by apps/audit). */
export async function emitAudit(env: Env, event: Omit<AuditEvent, 'at'>): Promise<void> {
  await env.AUDIT_QUEUE.send({ ...event, at: Date.now() })
}

/**
 * Builders for the audit/notification events shared by the HTTP routes and the
 * MCP tools — one definition per action so the two surfaces can't drift (the
 * created/updated distinction, resourceType conventions, etc. live here).
 */

/** config.created / config.updated, keyed on whether this is the first revision. */
export function configChangeEvent(args: {
  workspaceId: string
  environmentId: string
  kind: string
  key: string
  version: number
  userId: string
}): Omit<AuditEvent, 'at'> {
  return {
    workspaceId: args.workspaceId,
    environmentId: args.environmentId,
    action: args.version === 1 ? 'config.created' : 'config.updated',
    resourceType: args.kind,
    key: args.key,
    userId: args.userId,
  }
}

/** config.promoted into the target environment. */
export function promoteEvent(args: {
  workspaceId: string
  targetEnvironmentId: string
  kind?: string
  key: string
  userId: string
}): Omit<AuditEvent, 'at'> {
  return {
    workspaceId: args.workspaceId,
    environmentId: args.targetEnvironmentId,
    action: 'config.promoted',
    resourceType: args.kind ?? 'config',
    key: args.key,
    userId: args.userId,
  }
}

/** secret.revealed — the single most sensitive action; always emitted. */
export function revealEvent(args: {
  workspaceId: string
  environmentId: string
  kind: string
  key: string
  userId: string
}): Omit<AuditEvent, 'at'> {
  return {
    workspaceId: args.workspaceId,
    environmentId: args.environmentId,
    action: 'secret.revealed',
    resourceType: args.kind,
    key: args.key,
    userId: args.userId,
  }
}
