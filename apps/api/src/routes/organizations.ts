import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../context'
import {
  createOrganization,
  createWorkspace,
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
