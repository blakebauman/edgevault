import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import type { AppEnv } from '../src/context'
import { enforceOrgPolicy } from '../src/middleware/org-policy'

/**
 * Org access policy: require-MFA and SSO-only.
 *
 * These were previously checked in the auth worker behind
 * `session.activeOrganizationId`, a column read in several places and written
 * in none — so both controls could be switched on and enforced nothing. The
 * checks now run where the org is actually known. That regression was silent,
 * so it gets tests.
 */

const ORG = 'org-under-test'
const USER = 'user-1'

type Policy = { requireStepUpForReveal: boolean; requireMfa: boolean; ssoOnly: boolean }

/**
 * Drive `enforceOrgPolicy` through a real Hono request so `c.var`, `c.json`,
 * and `executionCtx.waitUntil` behave as they do in production. The database
 * and audit queue are the only stubs.
 */
async function check(
  _policy: Policy,
  amr: string[],
): Promise<{ status: number; body: { error?: string }; audited: string[] }> {
  const audited: string[] = []
  const app = new Hono<AppEnv>()

  app.get('/probe', async (c) => {
    c.set('userId', USER)
    c.set('amr', amr)
    c.set('database', {} as never)
    const refused = await enforceOrgPolicy(c, ORG)
    return refused ?? c.json({ ok: true })
  })

  const bindings = {
    ...env,
    AUDIT_QUEUE: {
      send: async (message: { action: string; detail?: Record<string, string> }) => {
        audited.push(message.detail?.reason ?? message.action)
      },
    },
  } as unknown as Env

  const ctx = createExecutionContext()
  const res = await app.fetch(new Request('https://api.test/probe'), bindings, ctx)
  await waitOnExecutionContext(ctx)
  return { status: res.status, body: (await res.json()) as { error?: string }, audited }
}

// The policy and MFA lookups are module-level imports in org-policy.ts, so they
// are stubbed at the module boundary rather than injected.
vi.mock('../src/database/queries', () => ({
  getOrgSecurityPolicy: vi.fn(),
  userHasConfirmedTotp: vi.fn(),
  getAuthenticatorsByUser: vi.fn(),
}))

const queries = await import('../src/database/queries')

function stub(policy: Policy, factors: { totp?: boolean; passkeys?: number }) {
  vi.mocked(queries.getOrgSecurityPolicy).mockResolvedValue(policy)
  vi.mocked(queries.userHasConfirmedTotp).mockResolvedValue(factors.totp ?? false)
  vi.mocked(queries.getAuthenticatorsByUser).mockResolvedValue(
    Array.from({ length: factors.passkeys ?? 0 }, (_, i) => ({ id: `k${i}` })),
  )
}

const OPEN: Policy = { requireStepUpForReveal: true, requireMfa: false, ssoOnly: false }

describe('enforceOrgPolicy', () => {
  it('lets everyone through when neither control is on, without touching the database', async () => {
    stub(OPEN, {})
    const { status } = await check(OPEN, ['pwd'])
    expect(status).toBe(200)
    // The cheap path matters: this runs on every workspace request.
    expect(queries.userHasConfirmedTotp).not.toHaveBeenCalled()
  })

  describe('require-MFA', () => {
    const policy: Policy = { ...OPEN, requireMfa: true }

    it('admits a token that already carries the mfa factor', async () => {
      stub(policy, {})
      const { status } = await check(policy, ['pwd', 'mfa'])
      expect(status).toBe(200)
      // Claim was sufficient; no fallback lookup needed.
      expect(queries.userHasConfirmedTotp).not.toHaveBeenCalled()
    })

    it('refuses a token without it, and records the refusal', async () => {
      stub(policy, {})
      const { status, body, audited } = await check(policy, ['pwd'])
      expect(status).toBe(403)
      expect(body.error).toBe('mfa_required_by_org')
      expect(audited).toEqual(['mfa_required_by_org'])
    })

    it('admits someone who enrolled after their token was minted', async () => {
      // Otherwise enrolling leaves you locked out for the rest of the token's
      // 15 minutes, which reads as broken rather than strict.
      stub(policy, { totp: true })
      const { status, audited } = await check(policy, ['pwd'])
      expect(status).toBe(200)
      expect(audited).toEqual([])
    })

    it('accepts a passkey as the second factor', async () => {
      stub(policy, { passkeys: 1 })
      expect((await check(policy, ['pwd'])).status).toBe(200)
    })
  })

  describe('SSO-only', () => {
    const policy: Policy = { ...OPEN, ssoOnly: true }

    it('admits a session established through the IdP', async () => {
      stub(policy, {})
      expect((await check(policy, ['sso'])).status).toBe(200)
    })

    it('refuses a password session even when it has a second factor', async () => {
      stub(policy, { totp: true })
      const { status, body, audited } = await check(policy, ['pwd', 'mfa'])
      expect(status).toBe(403)
      expect(body.error).toBe('sso_required_by_org')
      expect(audited).toEqual(['sso_required_by_org'])
    })

    it('refuses a token with no amr claim at all', async () => {
      // An access token minted before this claim existed must not be treated
      // as satisfying the policy.
      stub(policy, {})
      expect((await check(policy, [])).status).toBe(403)
    })
  })

  it('checks SSO before MFA, so the stricter refusal is the one reported', async () => {
    stub({ ...OPEN, ssoOnly: true, requireMfa: true }, {})
    const { body } = await check({ ...OPEN, ssoOnly: true, requireMfa: true }, ['pwd'])
    expect(body.error).toBe('sso_required_by_org')
  })
})
