import type { Database } from '@edgevault/database'
import {
  assertScimEntitled,
  SCIM_USER_SCHEMA,
  type ScimUser,
  toScimListResponse,
} from '@edgevault/ee-scim'
import { assertSsoEntitled } from '@edgevault/ee-sso-saml'
import { EntitlementError, type License } from '@edgevault/licensing'
import { Hono } from 'hono'
import { rowToLicense } from './entitlements'

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

// Enterprise SSO (OIDC) — start authorization (gated by `sso`).
app.get('/orgs/:orgId/sso/oidc/start', (c) => {
  assertSsoEntitled(c.var.license)
  // The per-org OIDC connection (issuer/clientId/encrypted secret) is stored by
  // the auth worker and lands with the SSO admin UI. The entitlement gate is
  // live now; until a connection is configured the flow cannot begin.
  return c.json({ error: 'sso_not_configured', detail: 'no OIDC connection for this org' }, 501)
})

export default app
