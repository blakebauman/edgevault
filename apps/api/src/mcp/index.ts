import { Hono } from 'hono'
import type { AppEnv } from '../context'
import { getOrgRequiresStepUpForReveal, isAiIndexingEnabled } from '../database/queries'
import { handleMcpMessage } from './server'
import { edgevaultTools } from './tools'

/**
 * MCP Streamable HTTP endpoint, one server per workspace (`/mcp/:workspaceId`).
 * Mounted behind requireAuth + requireWorkspaceMember, so the caller's identity
 * (c.var.userId) and org membership are already verified.
 */
export const mcpRoutes = new Hono<AppEnv>()
  .get('/:workspaceId', (c) =>
    c.json({
      name: 'edgevault',
      transport: 'streamable-http',
      workspaceId: c.req.param('workspaceId'),
      tools: edgevaultTools.map((t) => t.name),
    }),
  )
  .post('/:workspaceId', async (c) => {
    const payload = await c.req.json().catch(() => null)
    if (payload === null || typeof payload !== 'object') {
      return c.json(
        { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
        400,
      )
    }
    // Resolve the org's step-up policy here, where the DB handle lives, so the
    // reveal tool just checks a boolean (an agent can't do a second factor).
    const requireStepUp = c.var.orgId
      ? await getOrgRequiresStepUpForReveal(c.var.database, c.var.orgId)
      : false
    const workspaceId = c.req.param('workspaceId')
    // Same reason, same place: the workspace's AI opt-out. Without it the tools
    // silently diverged from the HTTP routes — set_config indexed into Vectorize
    // for workspaces that had opted out, and search_configs queried an index the
    // REST surface reports as disabled.
    const aiIndexingEnabled = await isAiIndexingEnabled(c.var.database, workspaceId)
    const ctx = {
      env: c.env,
      workspaceId,
      userId: c.var.userId,
      role: c.var.role,
      requireStepUp,
      aiIndexingEnabled,
    }

    // Batched JSON-RPC.
    if (Array.isArray(payload)) {
      const responses: unknown[] = []
      for (const message of payload) {
        const result = await handleMcpMessage(message, edgevaultTools, ctx)
        if (result.body !== undefined) responses.push(result.body)
      }
      return responses.length > 0 ? c.json(responses) : new Response(null, { status: 202 })
    }

    const result = await handleMcpMessage(payload, edgevaultTools, ctx)
    if (result.body === undefined) return new Response(null, { status: result.status })
    return c.json(result.body)
  })
