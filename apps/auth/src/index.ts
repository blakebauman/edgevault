import { buildJwks, signAccessToken } from '@edgevault/auth'
import { createDatabase } from '@edgevault/database'
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from './context'
import { clearSessionCookie, getSessionToken, setSessionCookie } from './cookies'
import { getKeys } from './keys'
import {
  createSession,
  createUser,
  invalidateSession,
  validateSessionToken,
  verifyCredentials,
} from './services'

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
  c.set('db', conn.db)
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

app.post('/sign-up/email', zValidator('json', signUpSchema), async (c) => {
  const input = c.req.valid('json')
  const user = await createUser(c.var.db, input)
  if (!user) return c.json({ error: 'email_taken' }, 409)

  const { token, expiresAt } = await createSession(c.var.db, user.id, {
    ipAddress: c.req.header('cf-connecting-ip'),
    userAgent: c.req.header('user-agent'),
  })
  setSessionCookie(c, token, expiresAt)
  return c.json({ user }, 201)
})

const signInSchema = z.object({
  email: z.email(),
  password: z.string().min(1).max(256),
})

app.post('/sign-in/email', zValidator('json', signInSchema), async (c) => {
  const { email, password } = c.req.valid('json')
  const user = await verifyCredentials(c.var.db, email, password)
  if (!user) return c.json({ error: 'invalid_credentials' }, 401)

  const { token, expiresAt } = await createSession(c.var.db, user.id, {
    ipAddress: c.req.header('cf-connecting-ip'),
    userAgent: c.req.header('user-agent'),
  })
  setSessionCookie(c, token, expiresAt)
  return c.json({ user })
})

app.post('/sign-out', async (c) => {
  const token = getSessionToken(c)
  if (token) await invalidateSession(c.var.db, token)
  clearSessionCookie(c)
  return c.json({ ok: true })
})

app.get('/session', async (c) => {
  const token = getSessionToken(c)
  if (!token) return c.json({ session: null })
  const session = await validateSessionToken(c.var.db, token)
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
app.post('/token', async (c) => {
  const token = getSessionToken(c)
  if (!token) return c.json({ error: 'no_session' }, 401)
  const session = await validateSessionToken(c.var.db, token)
  if (!session) return c.json({ error: 'no_session' }, 401)

  const { signing } = await getKeys(c.env)
  const accessToken = await signAccessToken(
    { sub: session.user.id, org: session.activeOrganizationId ?? undefined },
    signing,
    { issuer: c.env.AUTH_ISSUER, expiresIn: '15m' },
  )
  return c.json({ accessToken, tokenType: 'Bearer', expiresIn: 900 })
})

export default app
