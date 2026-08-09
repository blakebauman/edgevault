import type { AuditEvent } from '@edgevault/edge-protocol'

/**
 * Org-scoped audit events from the auth worker.
 *
 * The warehouse recorded configuration and secret operations only — nothing
 * from the identity plane ever reached it. This is the first piece of that:
 * the policy refusals at `/token`, which are the evidence that require-MFA and
 * SSO-only actually bite.
 *
 * Deliberately *not* every successful token mint. Access tokens last 15
 * minutes and are re-minted for the life of a 30-day session, so a success
 * event per issuance would add thousands of rows per user per month and bury
 * the handful that mean something. A refusal is rare and always interesting.
 *
 * Never throws into the request path: failing a sign-in because an audit
 * write failed would trade a security record for an outage. The queue has
 * retries and a DLQ behind it.
 */
export async function emitAuthAudit(
  env: Env,
  event: Omit<AuditEvent, 'at' | 'workspaceId'> & { organizationId: string },
): Promise<void> {
  try {
    await env.AUDIT_QUEUE.send({ ...event, workspaceId: '', at: Date.now() })
  } catch (error) {
    console.error('auth audit emit failed', event.action, error)
  }
}
