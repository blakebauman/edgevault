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

describe('rate limiting', () => {
  // A fake limiter that blocks once `key` has been seen `limit` times, mirroring
  // the Workers Rate Limiting binding's { success } contract.
  function fakeLimiter(limit: number): RateLimit {
    const counts = new Map<string, number>()
    return {
      limit: async ({ key }: { key: string }) => {
        const next = (counts.get(key) ?? 0) + 1
        counts.set(key, next)
        return { success: next <= limit }
      },
    } as unknown as RateLimit
  }

  function callWith(envOverride: Partial<Record<string, unknown>>, body: unknown) {
    const e = { ...env, ...envOverride } as unknown as Env
    return app.fetch(
      new Request('https://auth.test/sign-up/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7' },
        body: JSON.stringify(body),
      }),
      e,
      ctx,
    )
  }

  it('429s once the per-IP limit is exceeded (and sets Retry-After)', async () => {
    const limiter = fakeLimiter(2)
    const valid = { email: 'rate@b.com', password: 'longenough' }
    // First two pass the limiter (then fail later at the DB, which we never reach
    // because the body is valid and createUser would query) — use an invalid
    // body so the request stops at validation, after the limiter runs.
    const bad = { email: 'not-an-email', password: 'longenough' }
    expect((await callWith({ AUTH_IP_LIMITER: limiter }, bad)).status).toBe(400)
    expect((await callWith({ AUTH_IP_LIMITER: limiter }, bad)).status).toBe(400)
    const blocked = await callWith({ AUTH_IP_LIMITER: limiter }, bad)
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('Retry-After')).toBe('60')
    expect(await blocked.json()).toMatchObject({ error: 'rate_limited' })
    void valid
  })

  it('fails open when no limiter binding is configured', async () => {
    // No AUTH_IP_LIMITER on env -> limiter is skipped, request proceeds to
    // validation (400 for a bad body), never a 429.
    const res = await callWith({}, { email: 'bad', password: 'longenough' })
    expect(res.status).toBe(400)
  })
})
