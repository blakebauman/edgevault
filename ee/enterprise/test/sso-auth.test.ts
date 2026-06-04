import { describe, expect, it } from 'vitest'
import app from '../src/index'

/**
 * The SSO surface must reject callers without the internal shared secret BEFORE
 * any database access, so these run DB-less under Node (no HYPERDRIVE needed).
 */

const env = {
  ENVIRONMENT: 'test',
  INTERNAL_TOKEN: 'super-secret-internal-token',
  // HYPERDRIVE intentionally absent — a rejected request must never reach it.
} as unknown as Env

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext

function call(path: string, headers: Record<string, string> = {}) {
  return app.fetch(
    new Request(`https://enterprise${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: '{}',
    }),
    env,
    ctx,
  )
}

describe('SSO internal-token gate', () => {
  it('rejects a missing token with 401 (no DB access)', async () => {
    const res = await call('/orgs/org-1/sso/start')
    expect(res.status).toBe(401)
  })

  it('rejects a wrong token with 401', async () => {
    const res = await call('/orgs/org-1/sso/start', { 'x-internal-token': 'nope' })
    expect(res.status).toBe(401)
  })

  it('rejects when no INTERNAL_TOKEN is configured (fails closed)', async () => {
    const res = await app.fetch(
      new Request('https://enterprise/orgs/org-1/sso/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-token': '' },
        body: '{}',
      }),
      { ENVIRONMENT: 'test' } as unknown as Env,
      ctx,
    )
    expect(res.status).toBe(401)
  })
})
