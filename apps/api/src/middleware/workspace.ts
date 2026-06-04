import type { MiddlewareHandler } from 'hono'
import type { AppEnv } from '../context'
import { getWorkspaceWithOrg, isOrgMember } from '../database/queries'

/**
 * Authorize access to a workspace: the authenticated user must be a member of
 * the organization that owns the workspace (looked up in Neon). Sets `orgId` to
 * the workspace's org. Must run after withDb + requireAuth.
 */
export const requireWorkspaceMember: MiddlewareHandler<AppEnv> = async (c, next) => {
  const workspaceId = c.req.param('workspaceId')
  if (!workspaceId) return c.json({ error: 'not_found' }, 404)

  const workspace = await getWorkspaceWithOrg(c.var.database, workspaceId)
  if (!workspace) return c.json({ error: 'workspace_not_found' }, 404)

  const member = await isOrgMember(c.var.database, workspace.organizationId, c.var.userId)
  if (!member) return c.json({ error: 'forbidden' }, 403)

  c.set('orgId', workspace.organizationId)
  await next()
}
