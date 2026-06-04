import { generateToken, hashToken } from '@edgevault/auth'
import { ENTITLEMENTS } from '@edgevault/licensing'
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../context'
import {
  createOrganization,
  createWorkspace,
  getMemberRole,
  isOrgMember,
  listOrganizationsForUser,
  listWorkspaces,
} from '../database/queries'
import type { WorkspaceDurableObject } from '../durable-objects/workspace'

/** Organization + workspace management, backed by Neon (via Hyperdrive). */

const nameSlug = z.object({ name: z.string().min(1).max(120), slug: z.string().min(1).max(80) })

export const organizationRoutes = new Hono<AppEnv>()
  .post('/', zValidator('json', nameSlug), async (c) => {
    const { name, slug } = c.req.valid('json')
    const organization = await createOrganization(c.var.database, {
      name,
      slug,
      userId: c.var.userId,
    })
    return c.json({ organization }, 201)
  })
  .get('/', async (c) => {
    const organizations = await listOrganizationsForUser(c.var.database, c.var.userId)
    return c.json({ organizations })
  })
  .post('/:orgId/workspaces', zValidator('json', nameSlug), async (c) => {
    const orgId = c.req.param('orgId')
    if (!(await isOrgMember(c.var.database, orgId, c.var.userId))) {
      return c.json({ error: 'forbidden' }, 403)
    }
    const { name, slug } = c.req.valid('json')
    const workspace = await createWorkspace(c.var.database, { organizationId: orgId, name, slug })

    // Seed the per-workspace Durable Object with its metadata.
    const stub = c.env.WORKSPACE.get(
      c.env.WORKSPACE.idFromName(workspace.id),
    ) as DurableObjectStub<WorkspaceDurableObject>
    await stub.ensureWorkspace({ id: workspace.id, name: workspace.name, organizationId: orgId })

    return c.json({ workspace }, 201)
  })
  .get('/:orgId/workspaces', async (c) => {
    const orgId = c.req.param('orgId')
    if (!(await isOrgMember(c.var.database, orgId, c.var.userId))) {
      return c.json({ error: 'forbidden' }, 403)
    }
    const workspaces = await listWorkspaces(c.var.database, orgId)
    return c.json({ workspaces })
  })
  // SCIM token status (owner/admin only). Returns booleans only — never the
  // token or its hash: `entitled` (org's plan includes SCIM) and `configured`
  // (a token has been provisioned). Lets the console show state without ever
  // exposing the secret.
  .get('/:orgId/scim-token', async (c) => {
    const orgId = c.req.param('orgId')
    const role = await getMemberRole(c.var.database, orgId, c.var.userId)
    if (role !== 'owner' && role !== 'admin') return c.json({ error: 'forbidden' }, 403)

    const { getEntitlements, getScimTokenHash } = await import('@edgevault/database')
    const entitlements = await getEntitlements(c.var.database, orgId)
    const entitled = entitlements?.entitlements.includes(ENTITLEMENTS.SCIM) ?? false
    const configured = (await getScimTokenHash(c.var.database, orgId)) !== null
    return c.json({ entitled, configured })
  })
  // Provision (or rotate) the org's SCIM bearer token. Owner/admin only, and
  // only for orgs entitled to SCIM. The raw token is returned exactly once and
  // never persisted — only its SHA-256 is stored, which the enterprise worker's
  // SCIM middleware checks. Re-issuing here rotates: the previous token stops
  // working as soon as the new hash is written.
  .post('/:orgId/scim-token', async (c) => {
    const orgId = c.req.param('orgId')
    const role = await getMemberRole(c.var.database, orgId, c.var.userId)
    if (role !== 'owner' && role !== 'admin') return c.json({ error: 'forbidden' }, 403)

    const { getEntitlements, setScimTokenHash } = await import('@edgevault/database')
    const entitlements = await getEntitlements(c.var.database, orgId)
    if (!entitlements?.entitlements.includes(ENTITLEMENTS.SCIM)) {
      return c.json({ error: 'entitlement_required', entitlement: ENTITLEMENTS.SCIM }, 402)
    }

    const token = `evscim_${generateToken()}`
    const stored = await setScimTokenHash(c.var.database, orgId, hashToken(token))
    // No entitlements row to update — treat as un-entitled rather than create one.
    if (!stored) {
      return c.json({ error: 'entitlement_required', entitlement: ENTITLEMENTS.SCIM }, 402)
    }
    return c.json(
      { token, tokenType: 'Bearer', note: 'Store this now — it is shown only once.' },
      201,
    )
  })
  // Revoke the org's SCIM token (owner/admin only). Idempotent.
  .delete('/:orgId/scim-token', async (c) => {
    const orgId = c.req.param('orgId')
    const role = await getMemberRole(c.var.database, orgId, c.var.userId)
    if (role !== 'owner' && role !== 'admin') return c.json({ error: 'forbidden' }, 403)
    const { setScimTokenHash } = await import('@edgevault/database')
    await setScimTokenHash(c.var.database, orgId, null)
    return c.json({ ok: true })
  })
