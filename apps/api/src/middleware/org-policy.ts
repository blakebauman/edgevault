import type { Context } from 'hono'
import { emitOrgAudit } from '../audit'
import type { AppEnv } from '../context'
import {
  getAuthenticatorsByUser,
  getOrgSecurityPolicy,
  userHasConfirmedTotp,
} from '../database/queries'

/**
 * Enforce an organization's access policies — require-MFA and SSO-only.
 *
 * These live here, not in the auth worker, because the api is where the org is
 * actually known: it resolves one from the workspace being addressed, so a user
 * who belongs to a strict org and a relaxed one gets each org's rules on the
 * requests that touch it. Auth previously checked them at token issuance,
 * gated on a session's active organization — a column read in several places
 * and written in none, so neither control enforced anything.
 *
 * The token's `amr` claim is the fast path. On the *deny* path only, a second
 * factor is re-checked against the database: a user who just enrolled would
 * otherwise stay locked out for the remaining life of a token minted before
 * they did, which reads as the product being broken rather than strict.
 *
 * Returns a 403 Response when access is refused, or null to proceed.
 */
export async function enforceOrgPolicy(
  c: Context<AppEnv>,
  organizationId: string,
): Promise<Response | null> {
  const policy = await getOrgSecurityPolicy(c.var.database, organizationId)
  if (!policy.ssoOnly && !policy.requireMfa) return null

  const amr = c.var.amr
  // A refusal is the control doing its job, and "enabled" and "has actually
  // stopped someone" are different claims — only the second is evidence.
  const deny = (reason: string) =>
    emitOrgAudit(c.env, {
      organizationId,
      action: 'auth.access_denied',
      resourceType: 'auth',
      userId: c.var.userId,
      detail: { reason },
    })

  if (policy.ssoOnly && !amr.includes('sso')) {
    c.executionCtx.waitUntil(deny('sso_required_by_org'))
    return c.json(
      {
        error: 'sso_required_by_org',
        detail: 'This organization requires signing in through its identity provider.',
      },
      403,
    )
  }

  if (policy.requireMfa && !amr.includes('mfa')) {
    const enrolled =
      (await userHasConfirmedTotp(c.var.database, c.var.userId)) ||
      (await getAuthenticatorsByUser(c.var.database, c.var.userId)).length > 0
    if (!enrolled) {
      c.executionCtx.waitUntil(deny('mfa_required_by_org'))
      return c.json(
        {
          error: 'mfa_required_by_org',
          detail:
            'This organization requires two-factor authentication. Add an authenticator app or passkey in your account security settings.',
        },
        403,
      )
    }
  }

  return null
}
