import type { AuditEvent } from '@edgevault/edge-protocol'

/** Emit an audit event to the cold warehouse queue (consumed by apps/audit). */
export async function emitAudit(env: Env, event: Omit<AuditEvent, 'at'>): Promise<void> {
  await env.AUDIT_QUEUE.send({ ...event, at: Date.now() })
}

/**
 * Emit an org-scoped event — membership, policy, credentials, identity.
 *
 * These have no workspace, so `workspaceId` is empty and `organizationId`
 * carries the scope. Governance changes are exactly what an auditor asks for
 * first ("who granted admin, and when"), and until now none of them reached
 * the warehouse at all: it recorded configuration and secret operations only.
 *
 * Never throws into the request path. An audit write failing is worth knowing
 * about, but not worth failing the role change the user just made — the queue
 * has its own retries and a DLQ behind it.
 */
export async function emitOrgAudit(
  env: Env,
  event: Omit<AuditEvent, 'at' | 'workspaceId'> & { organizationId: string },
): Promise<void> {
  try {
    await env.AUDIT_QUEUE.send({ ...event, workspaceId: '', at: Date.now() })
  } catch (error) {
    console.error('org audit emit failed', event.action, error)
  }
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

/**
 * ai.rate_limited — a chat turn refused before any inference ran.
 *
 * Worth a cold record because it's the only signal that distinguishes a user
 * hitting the cap from the assistant being broken, and because a sustained run
 * of these is what abuse looks like.
 */
export function aiRateLimitedEvent(args: {
  workspaceId: string
  userId: string
}): Omit<AuditEvent, 'at'> {
  return {
    workspaceId: args.workspaceId,
    action: 'ai.rate_limited',
    resourceType: 'assistant',
    userId: args.userId,
  }
}

/**
 * ai.proposed — the assistant offered a change for a human to approve.
 *
 * The proposal itself never writes anything (see agent/proposals.ts), so this
 * records intent only. Pairing it with the `config.*` event that follows an
 * approval is what lets the warehouse answer "which changes originated with
 * the assistant, and did anyone act on them".
 */
export function aiProposalEvent(args: {
  workspaceId: string
  environmentId: string
  kind: string
  key: string
  userId: string
}): Omit<AuditEvent, 'at'> {
  return {
    workspaceId: args.workspaceId,
    environmentId: args.environmentId,
    action: 'ai.proposed',
    resourceType: args.kind,
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
  stepUp?: boolean
}): Omit<AuditEvent, 'at'> {
  return {
    workspaceId: args.workspaceId,
    environmentId: args.environmentId,
    action: 'secret.revealed',
    resourceType: args.kind,
    key: args.key,
    userId: args.userId,
    stepUp: args.stepUp,
  }
}
