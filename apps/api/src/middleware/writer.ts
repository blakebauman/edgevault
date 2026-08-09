import type { MiddlewareHandler } from 'hono'
import type { AppEnv } from '../context'

/**
 * Read-only enforcement for the `viewer` role.
 *
 * Deliberately a method check in one place rather than a guard repeated in
 * every handler. An inventory of the workspace routes found six writes with no
 * role gate at all — create environment, write config, delete config, revert,
 * and direct promote were open to any member — which is exactly what happens
 * when the rule lives in fourteen places instead of one. Gating on the method
 * means a route added tomorrow is covered without anyone remembering to.
 *
 * Safe here because every mutating route under `/api/v1/workspaces/:id/*` is a
 * genuine write; there is no POST-shaped read (search and compare are GETs).
 * That is NOT true of the MCP mount, where Streamable HTTP posts reads as well
 * as writes, so this is applied to the REST subtree only and the MCP tools
 * carry their own check.
 */
export function isWriterRole(role: string | null): boolean {
  return role === 'owner' || role === 'admin' || role === 'member'
}

export const requireWriteRole: MiddlewareHandler<AppEnv> = async (c, next) => {
  const method = c.req.method.toUpperCase()
  const reads = method === 'GET' || method === 'HEAD' || method === 'OPTIONS'
  if (!reads && !isWriterRole(c.var.role)) {
    return c.json(
      {
        error: 'read_only_role',
        detail: 'Your role in this organization is read-only. Ask an admin for write access.',
      },
      403,
    )
  }
  await next()
}
