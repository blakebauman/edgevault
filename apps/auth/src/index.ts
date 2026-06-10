import {
  buildJwks,
  buildOAuthUrl,
  exchangeOAuthCode,
  fetchOAuthIdentity,
  generatePkce,
  importVerificationKey,
  isOAuthProvider,
  type OAuthProvider,
  providerUsesPkce,
  randomState,
  signAccessToken,
  verifyAccessToken,
} from '@edgevault/auth'
import { createDatabase } from '@edgevault/database'
import { zValidator } from '@hono/zod-validator'
import { Hono, type MiddlewareHandler } from 'hono'
import { z } from 'zod'
import type { AppEnv } from './context'
import { clearSessionCookie, getSessionToken, setSessionCookie } from './cookies'
import { getKeys } from './keys'
import {
  confirmTotpEnrollment,
  disableTotp,
  signMfaChallenge,
  signRevealToken,
  startTotpEnrollment,
  totpStatus,
  userHasMfa,
  verifyMfaChallenge,
  verifyUserTotp,
} from './mfa'
import { enforceRateLimit, rateLimitByIp } from './rate-limit'
import { securityHeaders } from './security-headers'
import {
  createSession,
  createUser,
  getUserById,
  provisionOauthUser,
  provisionSsoUser,
  verifyCredentials,
} from './services'
import { invalidateSessionCached, validateSessionCached } from './session-cache'
import { ssoRoutes } from './sso'
import {
  buildAuthenticationOptions,
  buildRegistrationOptions,
  verifyAuthentication,
  verifyRegistration,
} from './webauthn'

/** Constant-time string compare for the internal shared secret. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * Authenticate a request by its Bearer access token (the same JWT api/delivery
 * verify), setting `userId`. Used by the MFA management routes, which the console
 * BFF calls on behalf of a signed-in user — they need the user, not a session.
 */
const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header('authorization')
  const token = header?.toLowerCase().startsWith('bearer ') ? header.slice(7) : undefined
  if (!token) return c.json({ error: 'unauthorized' }, 401)
  try {
    const { publicJwk } = await getKeys(c.env)
    const key = await importVerificationKey(publicJwk)
    const claims = await verifyAccessToken(token, key, { issuer: c.env.AUTH_ISSUER })
    c.set('userId', claims.sub)
  } catch {
    return c.json({ error: 'invalid_token' }, 401)
  }
  await next()
}

/**
 * EdgeVault auth service. Custom, zero-telemetry: email/password (Argon2id),
 * opaque DB-backed sessions (cached in AUTH_CACHE KV), EdDSA JWT/JWKS for
 * service-to-service verify, TOTP MFA, passkeys/WebAuthn, and social OAuth.
 * Enterprise SSO (OIDC/SAML) connection + login routes live in ./sso; SCIM
 * directory provisioning lives in the api worker.
 */

const app = new Hono<AppEnv>()

app.use('*', securityHeaders)

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

    // If the user has MFA enabled, stop here and return a short-lived challenge
    // instead of a session — the second factor is required at /mfa/totp/authenticate.
    if (await userHasMfa(c.var.database, user.id)) {
      const mfaToken = await signMfaChallenge(c.env, user.id)
      return c.json({ mfaRequired: true, mfaToken })
    }

    const { token, expiresAt } = await createSession(c.var.database, user.id, {
      ipAddress: c.req.header('cf-connecting-ip'),
      userAgent: c.req.header('user-agent'),
    })
    setSessionCookie(c, token, expiresAt)
    return c.json({ user })
  },
)

const mfaCodeSchema = z.object({ code: z.string().min(6).max(10) })

// Complete sign-in's second factor: exchange a valid MFA challenge + TOTP code
// for a real session. Rate-limited per IP like the other unauthenticated steps.
app.post(
  '/mfa/totp/authenticate',
  rateLimitByIp((e) => e.AUTH_IP_LIMITER, 'mfa-ip'),
  zValidator('json', z.object({ mfaToken: z.string().min(1), code: z.string().min(6).max(10) })),
  async (c) => {
    const { mfaToken, code } = c.req.valid('json')
    const userId = await verifyMfaChallenge(c.env, mfaToken)
    if (!userId) return c.json({ error: 'mfa_challenge_invalid' }, 401)
    if (!(await verifyUserTotp(c.env, c.var.database, userId, code))) {
      return c.json({ error: 'invalid_code' }, 401)
    }
    const { token, expiresAt } = await createSession(c.var.database, userId, {
      ipAddress: c.req.header('cf-connecting-ip'),
      userAgent: c.req.header('user-agent'),
    })
    setSessionCookie(c, token, expiresAt)
    return c.json({ ok: true })
  },
)

// Current user (access-token authenticated) — lets the console BFF resolve the
// caller's profile (e.g. email to prefill Stripe Checkout) from the JWT alone.
app.get('/me', requireUser, async (c) => {
  const user = await getUserById(c.var.database, c.var.userId)
  if (!user) return c.json({ error: 'not_found' }, 404)
  return c.json({ user })
})

// --- MFA management (access-token authenticated; the console BFF acts for the user) ---

app.get('/mfa/status', requireUser, async (c) => {
  return c.json(await totpStatus(c.var.database, c.var.userId))
})

app.post('/mfa/totp/setup', requireUser, async (c) => {
  const user = await getUserById(c.var.database, c.var.userId)
  if (!user) return c.json({ error: 'not_found' }, 404)
  const provisioning = await startTotpEnrollment(c.env, c.var.database, c.var.userId, user.email)
  return c.json(provisioning)
})

app.post('/mfa/totp/confirm', requireUser, zValidator('json', mfaCodeSchema), async (c) => {
  const ok = await confirmTotpEnrollment(
    c.env,
    c.var.database,
    c.var.userId,
    c.req.valid('json').code,
  )
  return ok ? c.json({ ok: true }) : c.json({ error: 'invalid_code' }, 400)
})

app.post('/mfa/totp/disable', requireUser, zValidator('json', mfaCodeSchema), async (c) => {
  const ok = await disableTotp(c.env, c.var.database, c.var.userId, c.req.valid('json').code)
  return ok ? c.json({ ok: true }) : c.json({ error: 'invalid_code' }, 400)
})

// --- WebAuthn / passkeys ---------------------------------------------------
// The console BFF passes the expected rpID/origin (from its own request) and
// round-trips the challenge in a cookie. Registration is access-token gated;
// authentication is public (discoverable login).

const rpSchema = z.object({ rpID: z.string().min(1) })
// Auth options additionally let the caller demand user verification — the
// reveal step-up ceremony passes 'required'; login omits it (→ 'preferred').
const authOptionsSchema = rpSchema.extend({
  userVerification: z.enum(['preferred', 'required']).optional(),
})
const verifySchema = z.object({
  response: z.unknown(),
  expectedChallenge: z.string().min(1),
  expectedOrigin: z.string().min(1),
  expectedRPID: z.string().min(1),
})

app.post('/webauthn/register/options', requireUser, zValidator('json', rpSchema), async (c) => {
  const user = await getUserById(c.var.database, c.var.userId)
  if (!user) return c.json({ error: 'not_found' }, 404)
  const options = await buildRegistrationOptions(c.var.database, {
    userId: c.var.userId,
    userName: user.email,
    rpID: c.req.valid('json').rpID,
  })
  return c.json(options)
})

app.post('/webauthn/register/verify', requireUser, zValidator('json', verifySchema), async (c) => {
  const body = c.req.valid('json')
  const ok = await verifyRegistration(c.var.database, {
    userId: c.var.userId,
    // biome-ignore lint/suspicious/noExplicitAny: the browser response shape is validated by the library
    response: body.response as any,
    expectedChallenge: body.expectedChallenge,
    expectedOrigin: body.expectedOrigin,
    expectedRPID: body.expectedRPID,
  })
  return ok ? c.json({ verified: true }) : c.json({ error: 'verification_failed' }, 400)
})

app.post(
  '/webauthn/auth/options',
  rateLimitByIp((e) => e.AUTH_IP_LIMITER, 'webauthn-ip'),
  zValidator('json', authOptionsSchema),
  async (c) => {
    const { rpID, userVerification } = c.req.valid('json')
    return c.json(await buildAuthenticationOptions(rpID, userVerification ?? 'preferred'))
  },
)

app.post(
  '/webauthn/auth/verify',
  rateLimitByIp((e) => e.AUTH_IP_LIMITER, 'webauthn-ip'),
  zValidator('json', verifySchema),
  async (c) => {
    const body = c.req.valid('json')
    const userId = await verifyAuthentication(c.var.database, {
      // biome-ignore lint/suspicious/noExplicitAny: the browser response shape is validated by the library
      response: body.response as any,
      expectedChallenge: body.expectedChallenge,
      expectedOrigin: body.expectedOrigin,
      expectedRPID: body.expectedRPID,
    })
    if (!userId) return c.json({ error: 'verification_failed' }, 401)
    const { token, expiresAt } = await createSession(c.var.database, userId, {
      ipAddress: c.req.header('cf-connecting-ip'),
      userAgent: c.req.header('user-agent'),
    })
    setSessionCookie(c, token, expiresAt)
    return c.json({ ok: true })
  },
)

// --- Step-up reauth --------------------------------------------------------
// Mint a short-lived reveal token after a fresh second factor (passkey or
// TOTP). The secret-reveal path in `api` requires it: being signed in isn't
// enough to reveal a secret. Token-gated (requireUser) and bound to the current
// user — a passkey assertion for another account can't mint a token for this
// one. The console BFF round-trips the WebAuthn challenge in a cookie, exactly
// like the login and registration flows above.
// `org` scopes the minted reveal token to one organization. Auth doesn't verify
// membership here — it doesn't need to: the api re-checks the token's org
// against the workspace's real org AND independently enforces admin membership,
// so a forged/wrong org claim unlocks nothing.
const reauthSchema = z.intersection(
  z.object({ org: z.string().optional() }),
  z.discriminatedUnion('method', [
    z.object({ method: z.literal('totp'), code: z.string().min(6).max(10) }),
    z.object({
      method: z.literal('passkey'),
      response: z.unknown(),
      expectedChallenge: z.string().min(1),
      expectedOrigin: z.string().min(1),
      expectedRPID: z.string().min(1),
    }),
  ]),
)

app.post(
  '/reauth',
  // Rate-limited like every other factor-verifying route: step-up's own threat
  // model assumes the session may be compromised, so a held access token must
  // not be able to brute-force the 6-digit TOTP into a reveal token.
  rateLimitByIp((e) => e.AUTH_IP_LIMITER, 'reauth-ip'),
  requireUser,
  zValidator('json', reauthSchema),
  async (c) => {
    const body = c.req.valid('json')
    let ok = false
    if (body.method === 'totp') {
      ok = await verifyUserTotp(c.env, c.var.database, c.var.userId, body.code)
    } else {
      const assertedUserId = await verifyAuthentication(c.var.database, {
        // biome-ignore lint/suspicious/noExplicitAny: the browser response shape is validated by the library
        response: body.response as any,
        expectedChallenge: body.expectedChallenge,
        expectedOrigin: body.expectedOrigin,
        expectedRPID: body.expectedRPID,
        // Step-up demands a verified factor, not mere presence.
        requireUserVerification: true,
      })
      ok = assertedUserId !== null && assertedUserId === c.var.userId
    }
    if (!ok) return c.json({ error: 'reauth_failed' }, 401)
    // Scope the token to the workspace's org (sent by the BFF): a step-up in one
    // org can't unlock reveals in another (the api re-checks org === c.var.orgId).
    const revealToken = await signRevealToken(c.env, c.var.userId, body.org ?? null)
    return c.json({ revealToken, expiresIn: 300 })
  },
)

// --- Social OAuth (GitHub / Google) ----------------------------------------
// The console BFF supplies the redirect URI (its own callback) and round-trips
// state + PKCE verifier in a cookie. Public + IP rate-limited.

function oauthCreds(
  env: Env,
  provider: OAuthProvider,
): { clientId: string; clientSecret: string } | null {
  const id = provider === 'github' ? env.GITHUB_CLIENT_ID : env.GOOGLE_CLIENT_ID
  const secret = provider === 'github' ? env.GITHUB_CLIENT_SECRET : env.GOOGLE_CLIENT_SECRET
  return id && secret ? { clientId: id, clientSecret: secret } : null
}

app.post(
  '/oauth/:provider/start',
  rateLimitByIp((e) => e.AUTH_IP_LIMITER, 'oauth-ip'),
  zValidator('json', z.object({ redirectUri: z.string().min(1) })),
  async (c) => {
    const provider = c.req.param('provider')
    if (!isOAuthProvider(provider)) return c.json({ error: 'unknown_provider' }, 404)
    const creds = oauthCreds(c.env, provider)
    if (!creds) return c.json({ error: 'provider_not_configured' }, 501)

    const state = randomState()
    const pkce = providerUsesPkce(provider) ? await generatePkce() : null
    const authorizeUrl = buildOAuthUrl(provider, {
      clientId: creds.clientId,
      redirectUri: c.req.valid('json').redirectUri,
      state,
      codeChallenge: pkce?.challenge,
    })
    return c.json({ authorizeUrl, state, codeVerifier: pkce?.verifier ?? null })
  },
)

app.post(
  '/oauth/:provider/callback',
  rateLimitByIp((e) => e.AUTH_IP_LIMITER, 'oauth-ip'),
  zValidator(
    'json',
    z.object({
      code: z.string().min(1),
      redirectUri: z.string().min(1),
      codeVerifier: z.string().optional(),
    }),
  ),
  async (c) => {
    const provider = c.req.param('provider')
    if (!isOAuthProvider(provider)) return c.json({ error: 'unknown_provider' }, 404)
    const creds = oauthCreds(c.env, provider)
    if (!creds) return c.json({ error: 'provider_not_configured' }, 501)
    const { code, redirectUri, codeVerifier } = c.req.valid('json')

    try {
      const tokens = await exchangeOAuthCode(provider, {
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
        code,
        redirectUri,
        codeVerifier,
      })
      const identity = await fetchOAuthIdentity(provider, tokens, { clientId: creds.clientId })
      if (!identity.email) return c.json({ error: 'no_verified_email' }, 400)

      const user = await provisionOauthUser(c.var.database, {
        providerId: provider,
        providerAccountId: identity.providerAccountId,
        email: identity.email,
        name: identity.name,
      })
      const { token, expiresAt } = await createSession(c.var.database, user.id, {
        ipAddress: c.req.header('cf-connecting-ip'),
        userAgent: c.req.header('user-agent'),
      })
      setSessionCookie(c, token, expiresAt)
      return c.json({ ok: true })
    } catch (err) {
      console.error('OAuth callback failed', err)
      return c.json({ error: 'oauth_failed' }, 401)
    }
  },
)

app.post('/sign-out', async (c) => {
  const token = getSessionToken(c)
  if (token) await invalidateSessionCached(c, token)
  clearSessionCookie(c)
  return c.json({ ok: true })
})

app.get('/session', async (c) => {
  const token = getSessionToken(c)
  if (!token) return c.json({ session: null })
  const session = await validateSessionCached(c, token)
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
    const session = await validateSessionCached(c, token)
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

// Enterprise SSO (OIDC + SAML) connection management + login verification,
// called by the console BFF over the service binding (INTERNAL_TOKEN-gated).
app.route('/', ssoRoutes)

export default app
