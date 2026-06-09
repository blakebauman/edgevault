import { decryptSecret, encryptSecret } from '@edgevault/crypto'
import {
  consumeSamlAssertion,
  getOrganizationIdBySlug,
  getSamlConnection,
  getSsoConnection,
  upsertSamlConnection,
  upsertSsoConnection,
} from '@edgevault/database'
import {
  buildAuthnRequest,
  buildAuthorizationUrl,
  exchangeCode,
  fetchDiscovery,
  generatePkce,
  importCertPublicKey,
  type OidcConnection,
  randomToken,
  verifyIdToken,
  verifySamlResponse,
} from '@edgevault/sso-saml'
import { type Context, Hono, type MiddlewareHandler } from 'hono'
import type { AppEnv } from './context'

/**
 * Enterprise SSO (OIDC + SAML 2.0) connection management and login verification.
 * Core feature. These endpoints are called only by the console BFF (a trusted
 * internal worker) over a service binding; the BFF performs the user-facing
 * authz (verified session + org-admin role) first. The shared INTERNAL_TOKEN
 * keeps them from being driven directly by the public. They verify the IdP
 * identity and return the claims — the session itself is minted by
 * /internal/sso/provision (this worker never mints one here).
 *
 * The per-org DB client is provided by the worker's root middleware
 * (c.var.database); these routes only resolve the org and set c.var.orgId.
 */

type SsoEnv = {
  Bindings: Env
  Variables: AppEnv['Variables'] & { orgId: string }
}

/** Constant-time compare of two equal-length strings. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const requireInternalToken: MiddlewareHandler<SsoEnv> = async (c, next) => {
  const presented = c.req.header('x-internal-token') ?? ''
  if (!c.env.INTERNAL_TOKEN || !timingSafeEqual(presented, c.env.INTERNAL_TOKEN)) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  await next()
}

/** Load + decrypt the org's OIDC connection into the sso-saml shape. */
async function loadOidcConnection(
  c: Context<SsoEnv>,
  orgId: string,
): Promise<OidcConnection | null> {
  const row = await getSsoConnection(c.var.database, orgId)
  if (!row) return null
  const clientSecret = await decryptSecret(
    c.env.MASTER_KEK,
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

export const ssoRoutes = new Hono<SsoEnv>()

// Authenticate the SSO/SAML surface before any org/DB work, so unauthenticated
// calls never touch Neon.
ssoRoutes.use('/orgs/:orgId/sso/*', requireInternalToken)
ssoRoutes.use('/orgs/:orgId/saml/*', requireInternalToken)

// Resolve the org for every org-scoped route. The param may be the org's id or
// its slug — SSO users type the slug they know.
ssoRoutes.use('/orgs/:orgId/*', async (c, next) => {
  let orgId = c.req.param('orgId')
  if (!UUID_RE.test(orgId)) {
    const resolved = await getOrganizationIdBySlug(c.var.database, orgId)
    if (!resolved) return c.json({ error: 'unknown_org' }, 404)
    orgId = resolved
  }
  c.set('orgId', orgId)
  await next()
})

// Configure (or rotate) the org's OIDC connection. The client secret is
// envelope-encrypted (keyed by org id) before it ever touches the database.
ssoRoutes.put('/orgs/:orgId/sso/connection', async (c) => {
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

  const envelope = await encryptSecret(c.env.MASTER_KEK, c.var.orgId, clientSecret)
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
ssoRoutes.get('/orgs/:orgId/sso/connection', async (c) => {
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
ssoRoutes.post('/orgs/:orgId/sso/start', async (c) => {
  const conn = await loadOidcConnection(c, c.var.orgId)
  if (!conn) return c.json({ error: 'sso_not_configured' }, 409)

  const discovery = await fetchDiscovery(conn.issuer)
  const pkce = await generatePkce()
  const state = randomToken()
  const nonce = randomToken()
  const authorizeUrl = buildAuthorizationUrl(conn, discovery, {
    state,
    nonce,
    codeChallenge: pkce.challenge,
  })
  return c.json({ authorizeUrl, state, nonce, codeVerifier: pkce.verifier, orgId: c.var.orgId })
})

// Complete the flow: verify the returned state, exchange the code, verify the
// ID token, and return the verified identity claims. The console turns these
// into an EdgeVault session via /internal/sso/provision.
ssoRoutes.post('/orgs/:orgId/sso/callback', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const code = str(body.code)
  const state = str(body.state)
  const expectedState = str(body.expectedState)
  const nonce = str(body.nonce)
  const codeVerifier = str(body.codeVerifier)
  if (!code || !state || !expectedState || !nonce || !codeVerifier) {
    return c.json({ error: 'invalid_request' }, 400)
  }
  if (!timingSafeEqual(state, expectedState)) {
    return c.json({ error: 'state_mismatch' }, 400)
  }

  const conn = await loadOidcConnection(c, c.var.orgId)
  if (!conn) return c.json({ error: 'sso_not_configured' }, 409)

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
ssoRoutes.put('/orgs/:orgId/saml/connection', async (c) => {
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
ssoRoutes.get('/orgs/:orgId/saml/connection', async (c) => {
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
ssoRoutes.post('/orgs/:orgId/saml/start', async (c) => {
  const row = await getSamlConnection(c.var.database, c.var.orgId)
  if (!row) return c.json({ error: 'saml_not_configured' }, 409)

  const { id, redirectUrl } = await buildAuthnRequest({
    spEntityId: row.spEntityId,
    acsUrl: row.acsUrl,
    idpSsoUrl: row.idpSsoUrl,
  })
  return c.json({ authnId: id, redirectUrl, orgId: c.var.orgId })
})

// Complete SAML SSO: verify the IdP's SAMLResponse (signature + conditions) and
// return the identity claims. The console turns these into a session via
// /internal/sso/provision.
ssoRoutes.post('/orgs/:orgId/saml/acs', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const samlResponse = str(body.samlResponse)
  if (!samlResponse) return c.json({ error: 'invalid_request' }, 400)
  const expectedInResponseTo = str(body.expectedInResponseTo) ?? undefined

  const row = await getSamlConnection(c.var.database, c.var.orgId)
  if (!row) return c.json({ error: 'saml_not_configured' }, 409)

  // HTTP-POST binding: SAMLResponse is base64 of the XML (not deflated).
  const xml = new TextDecoder().decode(
    Uint8Array.from(atob(samlResponse.replace(/\s+/g, '')), (ch) => ch.charCodeAt(0)),
  )
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
