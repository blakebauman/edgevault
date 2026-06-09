import { generateToken, hashToken } from '@edgevault/auth'
import type { InvitationEmailJob } from '@edgevault/edge-protocol'
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../context'
import {
  createOrganization,
  createWorkspace,
  getMemberRole,
  getOrgRequiresStepUpForReveal,
  isOrgMember,
  listOrganizationsForUser,
  listWorkspaces,
  setOrgRequireStepUpForReveal,
} from '../database/queries'
import type { VaultDurableObject } from '../durable-objects/vault'

/** Organization + workspace management, backed by Neon (via Hyperdrive). */

const nameSlug = z.object({ name: z.string().min(1).max(120), slug: z.string().min(1).max(80) })

/** Enqueue the invitation email — fully materialized, delivered by apps/notify. */
async function sendInvitationEmail(
  env: Env,
  to: string,
  role: string,
  invitation: { id: string; expiresAt: Date; organizationName: string; inviterName: string | null },
): Promise<void> {
  const job: InvitationEmailJob = {
    kind: 'invitation-email',
    to,
    organizationName: invitation.organizationName,
    inviterName: invitation.inviterName ?? 'A teammate',
    role,
    acceptUrl: `${env.CONSOLE_URL}/invite/${invitation.id}`,
    expiresAt: +invitation.expiresAt,
  }
  await env.NOTIFY_QUEUE.send(job)
}

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
    ) as DurableObjectStub<VaultDurableObject>
    await stub.ensureWorkspace({ id: workspace.id, name: workspace.name, organizationId: orgId })

    return c.json({ workspace }, 201)
  })
  .get('/:orgId/workspaces', async (c) => {
    const orgId = c.req.param('orgId')
    if (!(await isOrgMember(c.var.database, orgId, c.var.userId))) {
      return c.json({ error: 'forbidden' }, 403)
    }
    const workspaces = await listWorkspaces(c.var.database, orgId)
    // Fold in environment counts here (parallel DO RPC, no client round-trips) so
    // the console renders informative rows from one request instead of N+1.
    const withCounts = await Promise.all(
      workspaces.map(async (ws) => {
        const stub = c.env.WORKSPACE.get(
          c.env.WORKSPACE.idFromName(ws.id),
        ) as DurableObjectStub<VaultDurableObject>
        const environments = await stub.countEnvironments().catch(() => 0)
        return { ...ws, environments }
      }),
    )
    return c.json({ workspaces: withCounts })
  })
  // SCIM token status (owner/admin only). Returns `configured` only — never the
  // token or its hash — so the console can show whether provisioning is set up
  // without ever exposing the secret.
  .get('/:orgId/scim-token', async (c) => {
    const orgId = c.req.param('orgId')
    const role = await getMemberRole(c.var.database, orgId, c.var.userId)
    if (role !== 'owner' && role !== 'admin') return c.json({ error: 'forbidden' }, 403)

    const { getScimTokenHash } = await import('@edgevault/database')
    const configured = (await getScimTokenHash(c.var.database, orgId)) !== null
    return c.json({ configured })
  })
  // Provision (or rotate) the org's SCIM bearer token. Owner/admin only. The raw
  // token is returned exactly once and never persisted — only its SHA-256 is
  // stored (in scim_connections), which the SCIM surface checks. Re-issuing here
  // rotates: the previous token stops working as soon as the new hash is written.
  .post('/:orgId/scim-token', async (c) => {
    const orgId = c.req.param('orgId')
    const role = await getMemberRole(c.var.database, orgId, c.var.userId)
    if (role !== 'owner' && role !== 'admin') return c.json({ error: 'forbidden' }, 403)

    const { setScimTokenHash } = await import('@edgevault/database')
    const token = `evscim_${generateToken()}`
    await setScimTokenHash(c.var.database, orgId, hashToken(token))
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
  // changes go through Neon directly (the SCIM path is the automated equivalent
  // for IdP-provisioned orgs).
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
        // No account yet → email invitation instead of direct membership. The
        // invite link is a capability bound to this email; only an account
        // signed in with it can accept (see acceptInvitation).
        if (result.error === 'user_not_found') {
          const { createInvitation } = await import('@edgevault/database')
          const invitation = await createInvitation(c.var.database, {
            organizationId: orgId,
            email,
            role: newRole,
            inviterId: c.var.userId,
          })
          c.executionCtx.waitUntil(sendInvitationEmail(c.env, email, newRole, invitation))
          return c.json(
            {
              invited: true,
              invitation: {
                id: invitation.id,
                email,
                role: newRole,
                expiresAt: invitation.expiresAt,
              },
            },
            201,
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

  // --- Invitations (the email path for people without an account yet) ---
  .get('/:orgId/invitations', async (c) => {
    const orgId = c.req.param('orgId')
    const role = await getMemberRole(c.var.database, orgId, c.var.userId)
    if (role !== 'owner' && role !== 'admin') return c.json({ error: 'forbidden' }, 403)
    const { listPendingInvitations } = await import('@edgevault/database')
    const invitations = await listPendingInvitations(c.var.database, orgId)
    return c.json({ invitations })
  })
  .post('/:orgId/invitations/:invitationId/resend', async (c) => {
    const orgId = c.req.param('orgId')
    const role = await getMemberRole(c.var.database, orgId, c.var.userId)
    if (role !== 'owner' && role !== 'admin') return c.json({ error: 'forbidden' }, 403)
    const { createInvitation, getInvitation } = await import('@edgevault/database')
    const existing = await getInvitation(c.var.database, c.req.param('invitationId'))
    if (!existing || existing.organizationId !== orgId || existing.status !== 'pending') {
      return c.json({ error: 'not_found' }, 404)
    }
    // createInvitation refreshes the pending row in place (new 7-day expiry).
    const refreshed = await createInvitation(c.var.database, {
      organizationId: orgId,
      email: existing.email,
      role: existing.role,
      inviterId: c.var.userId,
    })
    c.executionCtx.waitUntil(sendInvitationEmail(c.env, existing.email, existing.role, refreshed))
    return c.json({ ok: true, expiresAt: refreshed.expiresAt })
  })
  .delete('/:orgId/invitations/:invitationId', async (c) => {
    const orgId = c.req.param('orgId')
    const role = await getMemberRole(c.var.database, orgId, c.var.userId)
    if (role !== 'owner' && role !== 'admin') return c.json({ error: 'forbidden' }, 403)
    const { revokeInvitation } = await import('@edgevault/database')
    const ok = await revokeInvitation(c.var.database, orgId, c.req.param('invitationId'))
    return ok ? c.json({ ok: true }) : c.json({ error: 'not_found' }, 404)
  })
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
  // --- Security policy (step-up before reveal) ---
  .get('/:orgId/security', async (c) => {
    const orgId = c.req.param('orgId')
    const role = await getMemberRole(c.var.database, orgId, c.var.userId)
    if (!role) return c.json({ error: 'forbidden' }, 403)
    return c.json({
      requireStepUpForReveal: await getOrgRequiresStepUpForReveal(c.var.database, orgId),
    })
  })
  .patch(
    '/:orgId/security',
    zValidator('json', z.object({ requireStepUpForReveal: z.boolean() })),
    async (c) => {
      const orgId = c.req.param('orgId')
      const role = await getMemberRole(c.var.database, orgId, c.var.userId)
      if (role !== 'owner' && role !== 'admin') return c.json({ error: 'forbidden' }, 403)
      await setOrgRequireStepUpForReveal(
        c.var.database,
        orgId,
        c.req.valid('json').requireStepUpForReveal,
      )
      return c.json({ ok: true })
    },
  )
