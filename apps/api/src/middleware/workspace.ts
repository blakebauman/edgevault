import type { MiddlewareHandler } from 'hono'
import type { AppEnv } from '../context'
import { getMemberRole, getWorkspaceWithOrg } from '../database/queries'

/**
 * Authorize access to a workspace: the authenticated user must be a member of
 * the organization that owns the workspace (looked up in Neon). Sets `orgId` +
 * the caller's `role`. Must run after withDatabase + requireAuth.
 */
export const requireWorkspaceMember: MiddlewareHandler<AppEnv> = async (c, next) => {
  const workspaceId = c.req.param('workspaceId')
  if (!workspaceId) return c.json({ error: 'not_found' }, 404)

  const workspace = await getWorkspaceWithOrg(c.var.database, workspaceId)
  if (!workspace) return c.json({ error: 'workspace_not_found' }, 404)

  const role = await getMemberRole(c.var.database, workspace.organizationId, c.var.userId)
  if (!role) return c.json({ error: 'forbidden' }, 403)

  c.set('orgId', workspace.organizationId)
  c.set('role', role)
  await next()
}
