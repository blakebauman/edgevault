import { hashToken } from '@edgevault/auth'
import { SCIM_USER_SCHEMA, type ScimUser, toScimListResponse } from '@edgevault/scim'
import { Hono } from 'hono'
import type { AppEnv } from '../context'

/**
 * SCIM 2.0 directory surface (RFC 7643/7644). Called directly by the customer's
 * IdP (Okta, Entra ID, …) — not the console BFF — so it lives on the public api
 * worker and authenticates with the org's SCIM bearer token rather than a user
 * session. The token's SHA-256 is compared (constant-time) against the hash
 * stored in scim_connections (provisioned via /api/v1/organizations/:orgId/
 * scim-token). No stored hash → SCIM isn't configured for the org → deny.
 *
 * Mounted at /scim, so the IdP's SCIM base URL is
 * https://api.edgevault.io/scim/v2/{org} (resources under /Users).
 *
 * `@edgevault/database` is imported dynamically (like the other api routes) so
 * its `pg` (CommonJS) dependency stays out of the static module graph.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Constant-time compare of two equal-length hex digests. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export const scimRoutes = new Hono<AppEnv>().get('/v2/:orgId/Users', async (c) => {
  const { getOrganizationIdBySlug, getScimTokenHash } = await import('@edgevault/database')

  // The path param may be the org id or its slug (admins configure the slug
  // they know in the IdP). Resolve it before any auth work.
  let orgId = c.req.param('orgId')
  if (!UUID_RE.test(orgId)) {
    const resolved = await getOrganizationIdBySlug(c.var.database, orgId)
    if (!resolved) return c.json({ error: 'unknown_org' }, 404)
    orgId = resolved
  }

  const header = c.req.header('authorization')
  const token = header?.toLowerCase().startsWith('bearer ') ? header.slice(7) : undefined
  if (!token) return c.json({ error: 'unauthorized' }, 401)
  const expected = await getScimTokenHash(c.var.database, orgId)
  if (!expected || !timingSafeEqualHex(hashToken(token), expected)) {
    return c.json({ error: 'unauthorized' }, 401)
  }

  const { members, users } = await import('@edgevault/database')
  const { eq } = await import('drizzle-orm')
  const rows = await c.var.database
    .select({ id: users.id, email: users.email, name: users.name })
    .from(members)
    .innerJoin(users, eq(members.userId, users.id))
    .where(eq(members.organizationId, orgId))
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
