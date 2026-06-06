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

/** Postgres unique-violation (23505), as surfaced through drizzle/Hyperdrive. */
function isDuplicate(error: unknown): boolean {
  const text = error instanceof Error ? `${error.message} ${error.cause ?? ''}` : String(error)
  return text.includes('23505') || text.includes('duplicate key')
}

export const organizationRoutes = new Hono<AppEnv>()
  .post('/', zValidator('json', nameSlug), async (c) => {
    const { name, slug } = c.req.valid('json')
    try {
      const organization = await createOrganization(c.var.database, {
        name,
        slug,
        userId: c.var.userId,
      })
      return c.json({ organization }, 201)
    } catch (error) {
      if (isDuplicate(error)) {
        return c.json(
          { error: 'slug_taken', detail: 'An organization with that slug already exists.' },
          409,
        )
      }
      throw error
    }
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
    let workspace: Awaited<ReturnType<typeof createWorkspace>>
    try {
      workspace = await createWorkspace(c.var.database, { organizationId: orgId, name, slug })
    } catch (error) {
      if (isDuplicate(error)) {
        return c.json(
          {
            error: 'slug_taken',
            detail: 'A workspace with that slug already exists in this organization.',
          },
          409,
        )
      }
      throw error
    }

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

  // --- Members ---
  // Any member may see the roster; only owners/admins mutate it. Membership
  // changes go through Neon directly (the SCIM path in ee/ is the automated
  // equivalent for IdP-provisioned orgs).
  .get('/:orgId/members', async (c) => {
    const orgId = c.req.param('orgId')
    const role = await getMemberRole(c.var.database, orgId, c.var.userId)
    if (!role) return c.json({ error: 'forbidden' }, 403)
    const { listOrgMembers } = await import('@edgevault/database')
    const members = await listOrgMembers(c.var.database, orgId)
    return c.json({ members, role, viewerId: c.var.userId })
  })
  .post(
    '/:orgId/members',
    zValidator(
      'json',
      z.object({ email: z.email(), role: z.enum(['owner', 'admin', 'member']).default('member') }),
    ),
    async (c) => {
      const orgId = c.req.param('orgId')
      const role = await getMemberRole(c.var.database, orgId, c.var.userId)
      if (role !== 'owner' && role !== 'admin') return c.json({ error: 'forbidden' }, 403)
      const { email, role: newRole } = c.req.valid('json')
      // Only owners may mint other owners — admins can't escalate past themselves.
      if (newRole === 'owner' && role !== 'owner') {
        return c.json({ error: 'forbidden', detail: 'only an owner can add another owner' }, 403)
      }
      const { addOrgMember } = await import('@edgevault/database')
      const result = await addOrgMember(c.var.database, orgId, email, newRole)
      if (!result.ok) {
        if (result.error === 'user_not_found') {
          return c.json(
            { error: 'user_not_found', detail: 'No EdgeVault account uses that email yet.' },
            404,
          )
        }
        if (result.error === 'already_member') {
          return c.json({ error: 'already_member', detail: 'They are already a member.' }, 409)
        }
        return c.json({ error: result.error }, 400)
      }
      return c.json({ member: result.member }, 201)
    },
  )
  .patch(
    '/:orgId/members/:userId',
    zValidator('json', z.object({ role: z.enum(['owner', 'admin', 'member']) })),
    async (c) => {
      const orgId = c.req.param('orgId')
      const role = await getMemberRole(c.var.database, orgId, c.var.userId)
      if (role !== 'owner' && role !== 'admin') return c.json({ error: 'forbidden' }, 403)
      const { role: newRole } = c.req.valid('json')
      if (newRole === 'owner' && role !== 'owner') {
        return c.json({ error: 'forbidden', detail: 'only an owner can grant owner' }, 403)
      }
      const { updateOrgMemberRole } = await import('@edgevault/database')
      const result = await updateOrgMemberRole(
        c.var.database,
        orgId,
        c.req.param('userId'),
        newRole,
      )
      if (!result.ok) {
        if (result.error === 'last_owner') {
          return c.json(
            { error: 'last_owner', detail: 'An organization must keep at least one owner.' },
            409,
          )
        }
        return c.json({ error: result.error }, result.error === 'not_a_member' ? 404 : 400)
      }
      return c.json({ ok: true })
    },
  )
  .delete('/:orgId/members/:userId', async (c) => {
    const orgId = c.req.param('orgId')
    const role = await getMemberRole(c.var.database, orgId, c.var.userId)
    if (role !== 'owner' && role !== 'admin') return c.json({ error: 'forbidden' }, 403)
    const { removeOrgMember } = await import('@edgevault/database')
    const result = await removeOrgMember(c.var.database, orgId, c.req.param('userId'))
    if (!result.ok) {
      if (result.error === 'last_owner') {
        return c.json(
          { error: 'last_owner', detail: 'An organization must keep at least one owner.' },
          409,
        )
      }
      return c.json({ error: result.error }, result.error === 'not_a_member' ? 404 : 400)
    }
    return c.json({ ok: true })
  })
