import { hashToken } from '@edgevault/auth'
import type { Database } from '@edgevault/database'
import {
  assertScimEntitled,
  SCIM_USER_SCHEMA,
  type ScimUser,
  toScimListResponse,
} from '@edgevault/ee-scim'
import { assertSsoEntitled, type OidcConnection } from '@edgevault/ee-sso-saml'
import { EntitlementError, type License } from '@edgevault/licensing'
import { Hono, type MiddlewareHandler } from 'hono'
import { rowToLicense } from './entitlements'

/** Constant-time compare of two equal-length hex digests. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * EdgeVault Enterprise worker (commercial — see ee/LICENSE).
 *
 * Mounts the enterprise SSO (OIDC) and SCIM surfaces, each gated by the org's
 * entitlements as read from Neon (written by the Managed Edge control-plane from
 * Stripe subscription state). This worker lives under `ee/`, so it may import
 * the commercial ee/ packages — the MIT core auth/api workers never do.
 *
 * `@edgevault/database` is imported dynamically so its `pg` (CommonJS) dependency
 * stays out of the static module graph (matches apps/api/middleware/database).
 */

type Vars = { database: Database; license: License; orgId: string }

const app = new Hono<{ Bindings: Env; Variables: Vars }>()

app.get('/health', (c) => c.json({ status: 'ok', worker: 'enterprise', env: c.env.ENVIRONMENT }))

// Authenticate the SSO/SAML surface (connection admin + login start/callback)
// BEFORE the org/license DB lookup, so unauthenticated calls never touch Neon.
// These are called only by the console BFF (a trusted internal worker), which
// performs the user-facing authz (verified session + org-admin role) first. The
// shared INTERNAL_TOKEN keeps the endpoints from being driven directly by the
// public, even though they reach the same fetch handler via the service binding.
const requireInternalToken: MiddlewareHandler<{ Bindings: Env; Variables: Vars }> = async (
  c,
  next,
) => {
  const presented = c.req.header('x-internal-token') ?? ''
  if (!c.env.INTERNAL_TOKEN || !timingSafeEqualHex(presented, c.env.INTERNAL_TOKEN)) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  await next()
}
app.use('/orgs/:orgId/sso/*', requireInternalToken)
app.use('/orgs/:orgId/saml/*', requireInternalToken)

// Resolve the org and load its license for every org-scoped route.
app.use('/orgs/:orgId/*', async (c, next) => {
  const orgId = c.req.param('orgId')
  const { createDatabase, getEntitlements } = await import('@edgevault/database')
  const conn = createDatabase(c.env.HYPERDRIVE.connectionString)
  const row = await getEntitlements(conn.database, orgId)
  c.set('database', conn.database)
  c.set('orgId', orgId)
  c.set('license', rowToLicense(orgId, row))
  try {
    await next()
  } finally {
    c.executionCtx.waitUntil(conn.close())
  }
})

// Authenticate the SCIM surface: the IdP must present the org's provisioning
// bearer token, whose SHA-256 we compare (constant-time) against the stored
// hash. No stored hash means SCIM isn't provisioned for this org — deny. This
// runs after the org middleware above, so c.var.database is set.
app.use('/orgs/:orgId/scim/*', async (c, next) => {
  const header = c.req.header('authorization')
  const token = header?.toLowerCase().startsWith('bearer ') ? header.slice(7) : undefined
  if (!token) return c.json({ error: 'unauthorized' }, 401)

  const { getScimTokenHash } = await import('@edgevault/database')
  const expected = await getScimTokenHash(c.var.database, c.var.orgId)
  if (!expected || !timingSafeEqualHex(hashToken(token), expected)) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  await next()
})

// A missing entitlement becomes 402 Payment Required, naming the entitlement key.
app.onError((err, c) => {
  if (err instanceof EntitlementError) {
    return c.json({ error: 'entitlement_required', entitlement: err.entitlement }, 402)
  }
  console.error('enterprise worker error', err)
  return c.json({ error: 'internal_error' }, 500)
})

// SCIM 2.0 — list the org's users as SCIM resources (gated by `scim`).
app.get('/orgs/:orgId/scim/v2/Users', async (c) => {
  assertScimEntitled(c.var.license)
  const { members, users } = await import('@edgevault/database')
  const { eq } = await import('drizzle-orm')
  const rows = await c.var.database
    .select({ id: users.id, email: users.email, name: users.name })
    .from(members)
    .innerJoin(users, eq(members.userId, users.id))
    .where(eq(members.organizationId, c.var.orgId))
  const resources: ScimUser[] = rows.map((u) => ({
    schemas: [SCIM_USER_SCHEMA],
    id: u.id,
    userName: u.email,
    name: u.name ? { formatted: u.name } : undefined,
    emails: [{ value: u.email, primary: true }],
    active: true,
  }))
  return c.json(toScimListResponse(resources))
})

/** Load + decrypt the org's OIDC connection into the ee-sso-saml shape. */
async function loadOidcConnection(
  env: Env,
  database: Database,
  orgId: string,
): Promise<OidcConnection | null> {
  const { getSsoConnection } = await import('@edgevault/database')
  const row = await getSsoConnection(database, orgId)
  if (!row) return null
  const { decryptSecret } = await import('@edgevault/crypto')
  const clientSecret = await decryptSecret(
    env.MASTER_KEK,
    orgId,
    JSON.parse(row.encryptedClientSecret),
  )
  return {
    organizationId: orgId,
    issuer: row.issuer,
    clientId: row.clientId,
    clientSecret,
    redirectUri: row.redirectUri,
    scopes: row.scopes,
  }
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null
}

// Configure (or rotate) the org's OIDC connection. The client secret is
// envelope-encrypted (keyed by org id) before it ever touches the database.
app.put('/orgs/:orgId/sso/connection', async (c) => {
  assertSsoEntitled(c.var.license)
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const issuer = str(body.issuer)
  const clientId = str(body.clientId)
  const clientSecret = str(body.clientSecret)
  const redirectUri = str(body.redirectUri)
  if (!issuer || !clientId || !clientSecret || !redirectUri) {
    return c.json(
      { error: 'invalid_request', detail: 'issuer/clientId/clientSecret/redirectUri required' },
      400,
    )
  }
  const scopes = Array.isArray(body.scopes)
    ? body.scopes.filter((s): s is string => typeof s === 'string')
    : ['openid', 'email', 'profile']

  const { encryptSecret } = await import('@edgevault/crypto')
  const envelope = await encryptSecret(c.env.MASTER_KEK, c.var.orgId, clientSecret)
  const { upsertSsoConnection } = await import('@edgevault/database')
  await upsertSsoConnection(c.var.database, {
    organizationId: c.var.orgId,
    issuer,
    clientId,
    encryptedClientSecret: JSON.stringify(envelope),
    redirectUri,
    scopes,
  })
  return c.json({ ok: true, connection: { issuer, clientId, redirectUri, scopes } })
})

// Non-secret view of the connection (for the admin UI).
app.get('/orgs/:orgId/sso/connection', async (c) => {
  assertSsoEntitled(c.var.license)
  const { getSsoConnection } = await import('@edgevault/database')
  const row = await getSsoConnection(c.var.database, c.var.orgId)
  if (!row) return c.json({ configured: false }, 404)
  return c.json({
    configured: true,
    issuer: row.issuer,
    clientId: row.clientId,
    redirectUri: row.redirectUri,
    scopes: row.scopes,
  })
})

// Begin the OIDC authorization-code + PKCE flow. Returns the IdP authorize URL
// plus the state/nonce/codeVerifier for the console to stash in a signed cookie.
app.post('/orgs/:orgId/sso/start', async (c) => {
  assertSsoEntitled(c.var.license)
  const conn = await loadOidcConnection(c.env, c.var.database, c.var.orgId)
  if (!conn) return c.json({ error: 'sso_not_configured' }, 409)

  const { buildAuthorizationUrl, fetchDiscovery, generatePkce, randomToken } = await import(
    '@edgevault/ee-sso-saml'
  )
  const discovery = await fetchDiscovery(conn.issuer)
  const pkce = await generatePkce()
  const state = randomToken()
  const nonce = randomToken()
  const authorizeUrl = buildAuthorizationUrl(conn, discovery, {
    state,
    nonce,
    codeChallenge: pkce.challenge,
  })
  return c.json({ authorizeUrl, state, nonce, codeVerifier: pkce.verifier })
})

// Complete the flow: verify the returned state, exchange the code, verify the
// ID token, and return the verified identity claims. The console turns these
// into an EdgeVault session via the auth worker — this worker never mints one.
app.post('/orgs/:orgId/sso/callback', async (c) => {
  assertSsoEntitled(c.var.license)
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const code = str(body.code)
  const state = str(body.state)
  const expectedState = str(body.expectedState)
  const nonce = str(body.nonce)
  const codeVerifier = str(body.codeVerifier)
  if (!code || !state || !expectedState || !nonce || !codeVerifier) {
    return c.json({ error: 'invalid_request' }, 400)
  }
  if (!timingSafeEqualHex(state, expectedState)) {
    return c.json({ error: 'state_mismatch' }, 400)
  }

  const conn = await loadOidcConnection(c.env, c.var.database, c.var.orgId)
  if (!conn) return c.json({ error: 'sso_not_configured' }, 409)

  const { exchangeCode, fetchDiscovery, verifyIdToken } = await import('@edgevault/ee-sso-saml')
  const discovery = await fetchDiscovery(conn.issuer)
  const tokens = await exchangeCode(conn, discovery, { code, codeVerifier })
  const claims = await verifyIdToken(tokens.id_token, conn, discovery, nonce)
  const email = str(claims.email)
  if (!email) return c.json({ error: 'no_email_claim' }, 400)
  return c.json({ email, name: str(claims.name), subject: claims.sub })
})

// --- Enterprise SSO (SAML 2.0) ---------------------------------------------

// Configure (or rotate) the org's SAML connection. The IdP certificate is a
// public key, so it is stored as-is (no encryption needed).
app.put('/orgs/:orgId/saml/connection', async (c) => {
  assertSsoEntitled(c.var.license)
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const idpEntityId = str(body.idpEntityId)
  const idpSsoUrl = str(body.idpSsoUrl)
  const idpCertificate = str(body.idpCertificate)
  const spEntityId = str(body.spEntityId)
  const acsUrl = str(body.acsUrl)
  if (!idpEntityId || !idpSsoUrl || !idpCertificate || !spEntityId || !acsUrl) {
    return c.json(
      {
        error: 'invalid_request',
        detail: 'idpEntityId/idpSsoUrl/idpCertificate/spEntityId/acsUrl required',
      },
      400,
    )
  }
  const { upsertSamlConnection } = await import('@edgevault/database')
  await upsertSamlConnection(c.var.database, {
    organizationId: c.var.orgId,
    idpEntityId,
    idpSsoUrl,
    idpCertificate,
    spEntityId,
    acsUrl,
  })
  return c.json({ ok: true, connection: { idpEntityId, idpSsoUrl, spEntityId, acsUrl } })
})

// Non-secret view of the SAML connection (for the admin UI).
app.get('/orgs/:orgId/saml/connection', async (c) => {
  assertSsoEntitled(c.var.license)
  const { getSamlConnection } = await import('@edgevault/database')
  const row = await getSamlConnection(c.var.database, c.var.orgId)
  if (!row) return c.json({ configured: false }, 404)
  return c.json({
    configured: true,
    idpEntityId: row.idpEntityId,
    idpSsoUrl: row.idpSsoUrl,
    spEntityId: row.spEntityId,
    acsUrl: row.acsUrl,
  })
})

// Begin SP-initiated SAML SSO: build the AuthnRequest + HTTP-Redirect URL. The
// console stores the returned request id and checks it against the response's
// InResponseTo at the ACS.
app.post('/orgs/:orgId/saml/start', async (c) => {
  assertSsoEntitled(c.var.license)
  const { getSamlConnection } = await import('@edgevault/database')
  const row = await getSamlConnection(c.var.database, c.var.orgId)
  if (!row) return c.json({ error: 'saml_not_configured' }, 409)

  const { buildAuthnRequest } = await import('@edgevault/ee-sso-saml')
  const { id, redirectUrl } = await buildAuthnRequest({
    spEntityId: row.spEntityId,
    acsUrl: row.acsUrl,
    idpSsoUrl: row.idpSsoUrl,
  })
  return c.json({ authnId: id, redirectUrl })
})

// Complete SAML SSO: verify the IdP's SAMLResponse (signature + conditions) and
// return the identity claims. The console turns these into a session via auth.
app.post('/orgs/:orgId/saml/acs', async (c) => {
  assertSsoEntitled(c.var.license)
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const samlResponse = str(body.samlResponse)
  if (!samlResponse) return c.json({ error: 'invalid_request' }, 400)
  const expectedInResponseTo = str(body.expectedInResponseTo) ?? undefined

  const { getSamlConnection, consumeSamlAssertion } = await import('@edgevault/database')
  const row = await getSamlConnection(c.var.database, c.var.orgId)
  if (!row) return c.json({ error: 'saml_not_configured' }, 409)

  // HTTP-POST binding: SAMLResponse is base64 of the XML (not deflated).
  const xml = new TextDecoder().decode(
    Uint8Array.from(atob(samlResponse.replace(/\s+/g, '')), (ch) => ch.charCodeAt(0)),
  )
  const { importCertPublicKey, verifySamlResponse } = await import('@edgevault/ee-sso-saml')
  try {
    const idpPublicKey = await importCertPublicKey(row.idpCertificate)
    const identity = await verifySamlResponse(xml, {
      idpPublicKey,
      audience: row.spEntityId,
      acsUrl: row.acsUrl,
      expectedInResponseTo,
    })
    if (!identity.email) return c.json({ error: 'no_email_claim' }, 400)

    // One-time use: only after the signature + conditions verified, atomically
    // claim the assertion ID. A missing ID can't be replay-protected, and a
    // second claim of the same ID (within its validity window) is a replay.
    if (!identity.assertionId) return c.json({ error: 'assertion_missing_id' }, 400)
    // Bound the replay window if the IdP gave no NotOnOrAfter (assertions normally
    // do); 10 minutes comfortably covers the 3-minute clock-skew allowance.
    const expiresAt = new Date(identity.notOnOrAfter ?? Date.now() + 10 * 60 * 1000)
    const fresh = await consumeSamlAssertion(c.var.database, {
      assertionId: identity.assertionId,
      organizationId: c.var.orgId,
      expiresAt,
    })
    if (!fresh) return c.json({ error: 'assertion_replayed' }, 401)

    return c.json({ email: identity.email, name: identity.name, subject: identity.nameId })
  } catch (err) {
    console.error('SAML verification failed', err)
    return c.json({ error: 'saml_verification_failed' }, 401)
  }
})

export default app
