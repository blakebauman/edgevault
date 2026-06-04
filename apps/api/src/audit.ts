import type { AuditEvent } from '@edgevault/edge-protocol'

/** Emit an audit event to the cold warehouse queue (consumed by apps/audit). */
export async function emitAudit(env: Env, event: Omit<AuditEvent, 'at'>): Promise<void> {
  await env.AUDIT_QUEUE.send({ ...event, at: Date.now() })
}
