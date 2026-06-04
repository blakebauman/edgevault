import { describe, expect, it } from 'vitest'
import app from '../src/index'

/**
 * Route tests under Node with a mocked `Env`. These cover DB-less routes (no
 * query is executed). The signup/signin/session/JWKS flow against real Neon is
 * exercised by the `wrangler dev` smoke test.
 */

const env = {
  // A syntactically valid connection string; never connected to (pg Pool is lazy
  // and these routes execute no query).
  HYPERDRIVE: { connectionString: 'postgresql://user:password@localhost:5432/edgevault' },
  ENVIRONMENT: 'test',
  SERVICE_NAME: 'edgevault-auth',
  AUTH_ISSUER: 'http://localhost:8788',
  JWT_PRIVATE_JWK: '{}',
} as unknown as Env

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext

function call(path: string, init?: RequestInit) {
  return app.fetch(new Request(`https://auth.test${path}`, init), env, ctx)
}

describe('GET /health', () => {
  it('returns ok', async () => {
    const res = await call('/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'ok', service: 'edgevault-auth' })
  })
})

describe('GET /session (no cookie)', () => {
  it('returns a null session without touching the database', async () => {
    const res = await call('/session')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ session: null })
  })
})

describe('POST /sign-out (no cookie)', () => {
  it('is idempotent', async () => {
    const res = await call('/sign-out', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
})

describe('POST /sign-up/email (validation)', () => {
  it('rejects an invalid email before any database call', async () => {
    const res = await call('/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email', password: 'longenough' }),
    })
    expect(res.status).toBe(400)
  })

  it('rejects a too-short password', async () => {
    const res = await call('/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'a@b.com', password: 'short' }),
    })
    expect(res.status).toBe(400)
  })
})
