import { buildJwks, signAccessToken } from '@edgevault/auth'
import { createDatabase } from '@edgevault/database'
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from './context'
import { clearSessionCookie, getSessionToken, setSessionCookie } from './cookies'
import { getKeys } from './keys'
import { enforceRateLimit, rateLimitByIp } from './rate-limit'
import {
  createSession,
  createUser,
  invalidateSession,
  provisionSsoUser,
  validateSessionToken,
  verifyCredentials,
} from './services'

/** Constant-time string compare for the internal shared secret. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * EdgeVault auth service. Custom, zero-telemetry: email/password (Argon2id),
 * opaque DB-backed sessions, and EdDSA JWT/JWKS for service-to-service verify.
 * Social OAuth, SSO/SCIM (ee/), passkeys, and KV session caching land later.
 */

const app = new Hono<AppEnv>()

// Per-request Drizzle client over Hyperdrive. The pool is closed after the
// response so the request isn't blocked on connection teardown.
app.use('*', async (c, next) => {
  const conn = createDatabase(c.env.HYPERDRIVE.connectionString)
  c.set('database', conn.database)
  try {
    await next()
  } finally {
    c.executionCtx.waitUntil(conn.close())
  }
})

app.get('/health', (c) => c.json({ status: 'ok', service: c.env.SERVICE_NAME ?? 'edgevault-auth' }))

app.get('/.well-known/jwks.json', async (c) => {
  const { publicJwk } = await getKeys(c.env)
  return c.json(buildJwks([publicJwk]))
})

const signUpSchema = z.object({
  email: z.email(),
  password: z.string().min(8).max(256),
  name: z.string().min(1).max(120).optional(),
})

app.post(
  '/sign-up/email',
  rateLimitByIp((e) => e.AUTH_IP_LIMITER, 'signup-ip'),
  zValidator('json', signUpSchema),
  async (c) => {
    const input = c.req.valid('json')
    const user = await createUser(c.var.database, input)
    if (!user) return c.json({ error: 'email_taken' }, 409)

    const { token, expiresAt } = await createSession(c.var.database, user.id, {
      ipAddress: c.req.header('cf-connecting-ip'),
      userAgent: c.req.header('user-agent'),
    })
    setSessionCookie(c, token, expiresAt)
    return c.json({ user }, 201)
  },
)

const signInSchema = z.object({
  email: z.email(),
  password: z.string().min(1).max(256),
})

app.post(
  '/sign-in/email',
  rateLimitByIp((e) => e.AUTH_IP_LIMITER, 'signin-ip'),
  zValidator('json', signInSchema),
  async (c) => {
    const { email, password } = c.req.valid('json')
    // Per-account throttle: slows targeted brute force of one email across IPs.
    const blocked = await enforceRateLimit(
      c,
      c.env.AUTH_ACCOUNT_LIMITER,
      `signin-acct:${email.toLowerCase()}`,
    )
    if (blocked) return blocked

    const user = await verifyCredentials(c.var.database, email, password)
    if (!user) return c.json({ error: 'invalid_credentials' }, 401)

    const { token, expiresAt } = await createSession(c.var.database, user.id, {
      ipAddress: c.req.header('cf-connecting-ip'),
      userAgent: c.req.header('user-agent'),
    })
    setSessionCookie(c, token, expiresAt)
    return c.json({ user })
  },
)

app.post('/sign-out', async (c) => {
  const token = getSessionToken(c)
  if (token) await invalidateSession(c.var.database, token)
  clearSessionCookie(c)
  return c.json({ ok: true })
})

app.get('/session', async (c) => {
  const token = getSessionToken(c)
  if (!token) return c.json({ session: null })
  const session = await validateSessionToken(c.var.database, token)
  if (!session) {
    clearSessionCookie(c)
    return c.json({ session: null })
  }
  return c.json({
    session: {
      user: session.user,
      activeOrganizationId: session.activeOrganizationId,
      expiresAt: session.expiresAt.toISOString(),
    },
  })
})

// Mint a short-lived access JWT for the current session, for api/delivery to
// verify statelessly against the JWKS.
app.post(
  '/token',
  rateLimitByIp((e) => e.AUTH_IP_LIMITER, 'token-ip'),
  async (c) => {
    const token = getSessionToken(c)
    if (!token) return c.json({ error: 'no_session' }, 401)
    const session = await validateSessionToken(c.var.database, token)
    if (!session) return c.json({ error: 'no_session' }, 401)

    const { signing } = await getKeys(c.env)
    const accessToken = await signAccessToken(
      { sub: session.user.id, org: session.activeOrganizationId ?? undefined },
      signing,
      { issuer: c.env.AUTH_ISSUER, expiresIn: '15m' },
    )
    return c.json({ accessToken, tokenType: 'Bearer', expiresIn: 900 })
  },
)

// Internal SSO provisioning — called only by the ee/enterprise worker (via the
// console BFF) after it has verified the IdP identity. Authenticated by a shared
// secret, not a user session. Establishes an EdgeVault session for the SSO user
// (JIT-creating the user + org membership) and returns it as a cookie, exactly
// like /sign-in, so the console can exchange it for an access token via /token.
app.post('/internal/sso/provision', async (c) => {
  const presented = c.req.header('x-internal-token') ?? ''
  if (!c.env.INTERNAL_TOKEN || !timingSafeEqual(presented, c.env.INTERNAL_TOKEN)) {
    return c.json({ error: 'unauthorized' }, 401)
  }

  const body = (await c.req.json().catch(() => ({}))) as {
    email?: unknown
    name?: unknown
    organizationId?: unknown
  }
  const email = typeof body.email === 'string' ? body.email : ''
  const organizationId = typeof body.organizationId === 'string' ? body.organizationId : ''
  if (!email || !organizationId) return c.json({ error: 'invalid_request' }, 400)

  const user = await provisionSsoUser(c.var.database, {
    email,
    name: typeof body.name === 'string' ? body.name : null,
    organizationId,
  })
  const { token, expiresAt } = await createSession(c.var.database, user.id, {
    ipAddress: c.req.header('cf-connecting-ip'),
    userAgent: c.req.header('user-agent'),
  })
  setSessionCookie(c, token, expiresAt)
  return c.json({ user })
})

export default app
