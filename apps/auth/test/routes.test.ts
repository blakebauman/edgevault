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

  it('sets baseline security headers on every response', async () => {
    const res = await call('/health')
    expect(res.headers.get('Content-Security-Policy')).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    )
    expect(res.headers.get('Strict-Transport-Security')).toBe('max-age=31536000; includeSubDomains')
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(res.headers.get('X-Frame-Options')).toBe('DENY')
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer')
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

describe('POST /reauth (step-up)', () => {
  it('rejects without a bearer token before any database or key work', async () => {
    const res = await call('/reauth', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'totp', code: '123456' }),
    })
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: 'unauthorized' })
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

describe('account-lifecycle routes (validation, no DB)', () => {
  function post(path: string, body: unknown, headers: Record<string, string> = {}) {
    return call(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
  }

  it('POST /verify-email rejects a missing token before any database call', async () => {
    expect((await post('/verify-email', {})).status).toBe(400)
  })

  it('POST /verify-email/resend requires a bearer token', async () => {
    expect((await post('/verify-email/resend', {})).status).toBe(401)
  })

  it('POST /password/forgot validates the email shape', async () => {
    expect((await post('/password/forgot', { email: 'not-an-email' })).status).toBe(400)
  })

  it('POST /password/reset rejects a too-short replacement password', async () => {
    expect((await post('/password/reset', { token: 't', newPassword: 'short' })).status).toBe(400)
  })

  it('POST /password/change requires a bearer token', async () => {
    const res = await post('/password/change', {
      currentPassword: 'old-password',
      newPassword: 'new-password-1',
    })
    expect(res.status).toBe(401)
  })

  it('GET /sessions and the revoke routes require a bearer token', async () => {
    expect((await call('/sessions')).status).toBe(401)
    expect((await post('/sessions/revoke-all', {})).status).toBe(401)
  })

  it('POST /mfa/recovery/authenticate validates the body shape', async () => {
    expect((await post('/mfa/recovery/authenticate', { mfaToken: 'x' })).status).toBe(400)
    expect((await post('/mfa/recovery/authenticate', { mfaToken: 'x', code: 'a' })).status).toBe(
      400,
    )
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

  it('rate-limits /reauth ahead of auth, so a held session cannot brute-force TOTP', async () => {
    // fakeLimiter(0) blocks the first hit. The 429 (not 401) proves the limiter
    // runs before requireUser — without it, a compromised access token could
    // hammer the 6-digit code to mint a reveal token.
    const res = await app.fetch(
      new Request('https://auth.test/reauth', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9' },
        body: JSON.stringify({ method: 'totp', code: '123456' }),
      }),
      { ...env, AUTH_IP_LIMITER: fakeLimiter(0) } as unknown as Env,
      ctx,
    )
    expect(res.status).toBe(429)
    expect(await res.json()).toMatchObject({ error: 'rate_limited' })
  })
})
