import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { getAgentByName } from 'agents'
import type { AppEnv } from './context'
import { getMemberRole, getWorkspaceWithOrg } from './database/queries'
import { mcpRoutes } from './mcp'
import { requireAuth } from './middleware/auth'
import { withDatabase } from './middleware/database'
import { requireWorkspaceMember } from './middleware/workspace'
import { customDomainRoutes } from './routes/custom-domains'
import { devSeedRoutes } from './routes/dev-seed'
import { invitationRoutes } from './routes/invitations'
import { machineRoutes } from './routes/machine'
import { organizationRoutes } from './routes/organizations'
import { scimRoutes } from './routes/scim'
import { internalShareRoutes, shareRoutes } from './routes/shares'
import { workspaceRoutes } from './routes/workspaces'
import { securityHeaders } from './security-headers'

export { EdgeVaultAgent } from './agent/agent'
export { ShareDurableObject } from './durable-objects/share'
export { VaultDurableObject } from './durable-objects/vault'
export { DomainVerificationWorkflow } from './workflows/domain-verification'
export { PromotionWorkflow } from './workflows/promotion'

/**
 * EdgeVault control-plane API.
 *
 * Phase 0: a typed OpenAPI Hono app with a health route + OpenAPI document.
 * Bindings (Hyperdrive/Neon, the WORKSPACE/AGENT Durable Objects, AI, Vectorize,
 * Queues, Secrets Store, KV) and the config/flag/secret modules are added in
 * later phases per the architecture plan.
 */

/** The agent instance name from `/agents/<party>/<name>` — `<wsId>[:<userId>]`. */
const agentInstanceName = (req: Request): string =>
  decodeURIComponent(new URL(req.url).pathname.split('/')[3] ?? '')

const app = new OpenAPIHono<AppEnv>()

app.use('*', securityHeaders)

const HealthResponse = z
  .object({
    status: z.literal('ok'),
    service: z.string().openapi({ example: 'edgevault-api' }),
    environment: z.string().openapi({ example: 'development' }),
    time: z.string().datetime().openapi({ example: '2026-06-03T00:00:00.000Z' }),
  })
  .openapi('HealthResponse')

const healthRoute = createRoute({
  method: 'get',
  path: '/health',
  summary: 'Liveness/health check',
  tags: ['system'],
  responses: {
    200: {
      description: 'Service is healthy',
      content: { 'application/json': { schema: HealthResponse } },
    },
  },
})

app.openapi(healthRoute, (c) =>
  c.json({
    status: 'ok' as const,
    service: c.env.SERVICE_NAME ?? 'edgevault-api',
    environment: c.env.ENVIRONMENT ?? 'unknown',
    time: new Date().toISOString(),
  }),
)

// OpenAPI 3.1 document
app.doc31('/openapi.json', {
  openapi: '3.1.0',
  info: {
    version: '0.0.0',
    title: 'EdgeVault API',
    description: 'Edge-native configuration, secrets, and feature-flag platform.',
  },
})

app.get('/', (c) => c.json({ name: 'EdgeVault API', docs: '/openapi.json' }))

// Authenticated API surface (Neon via Hyperdrive + JWT verified against auth's JWKS).
app.use('/api/v1/*', withDatabase, requireAuth)
// Workspace config routes additionally require org membership.
app.use('/api/v1/workspaces/:workspaceId/*', requireWorkspaceMember)

app.route('/api/v1/organizations', organizationRoutes)
app.route('/api/v1/organizations', customDomainRoutes)
app.route('/api/v1/workspaces', workspaceRoutes)
// Invitation accept surface — authenticated but pre-membership by definition.
app.route('/api/v1/invitations', invitationRoutes)
// Zero-knowledge share links: authenticated create…
app.route('/api/v1/shares', shareRoutes)
// …and recipient consume, reachable only by the console BFF (INTERNAL_TOKEN).
app.route('/internal/shares', internalShareRoutes)
// Local-dev seed (DO + KV). Inert unless ALLOW_DEV_SEED=1 (set only in
// .dev.vars, never deployed) and the INTERNAL_TOKEN matches.
app.use('/internal/seed', withDatabase)
app.route('/internal/seed', devSeedRoutes)
// Machine surface (environment API keys, not JWTs): CLI/CI export incl. secrets.
app.route('/machine', machineRoutes)

// SCIM 2.0 directory surface, called directly by the customer's IdP and
// authenticated by the org's SCIM bearer token (not a user session).
app.use('/scim/*', withDatabase)
app.route('/scim', scimRoutes)

// Remote MCP server (Streamable HTTP), one per workspace, same auth + membership.
app.use('/mcp/:workspaceId', withDatabase, requireAuth, requireWorkspaceMember)
app.route('/mcp', mcpRoutes)

// --- Agent (Agents SDK) WebSocket surface ---
// The browser connects to wss://api/agents/edge-vault-agent/<wsId>[:<userId>]
// with the same minted-token model as the realtime /ws. We route with
// getAgentByName (keeping the AGENT binding), which deliberately skips the SDK's
// onBeforeConnect — so auth + workspace membership are enforced here (mirroring
// requireWorkspaceMember), and a name's `:userId` segment must match the caller
// (per-user threads can't be hijacked).
app.use('/agents/*', withDatabase, requireAuth, async (c, next) => {
  const name = agentInstanceName(c.req.raw)
  const [workspaceId, wantedUser] = name.split(':')
  if (!workspaceId) return c.json({ error: 'not_found' }, 404)
  if (wantedUser && wantedUser !== c.var.userId) return c.json({ error: 'forbidden' }, 403)
  const workspace = await getWorkspaceWithOrg(c.var.database, workspaceId)
  if (!workspace) return c.json({ error: 'workspace_not_found' }, 404)
  const role = await getMemberRole(c.var.database, workspace.organizationId, c.var.userId)
  if (!role) return c.json({ error: 'forbidden' }, 403)
  c.set('orgId', workspace.organizationId)
  c.set('role', role)
  await next()
})
app.all('/agents/*', async (c) => {
  const agent = await getAgentByName(c.env.AGENT, agentInstanceName(c.req.raw))
  return agent.fetch(c.req.raw)
})

// Unhandled errors stay server-side: log the real cause, return a generic body
// (no message/stack passthrough to clients).
app.onError((err, c) => {
  console.error('unhandled error', err)
  return c.json({ error: 'internal_error' }, 500)
})
app.notFound((c) => c.json({ error: 'not_found' }, 404))

export default app
