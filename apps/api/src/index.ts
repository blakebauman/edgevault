import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import type { AppEnv } from './context'
import { mcpRoutes } from './mcp'
import { requireAuth } from './middleware/auth'
import { withDatabase } from './middleware/database'
import { requireWorkspaceMember } from './middleware/workspace'
import { invitationRoutes } from './routes/invitations'
import { machineRoutes } from './routes/machine'
import { organizationRoutes } from './routes/organizations'
import { internalShareRoutes, shareRoutes } from './routes/shares'
import { workspaceRoutes } from './routes/workspaces'

export { EdgeVaultAgent } from './agent/agent'
export { ShareDurableObject } from './durable-objects/share'
export { VaultDurableObject } from './durable-objects/vault'
export { PromotionWorkflow } from './workflows/promotion'

/**
 * EdgeVault control-plane API.
 *
 * Phase 0: a typed OpenAPI Hono app with a health route + OpenAPI document.
 * Bindings (Hyperdrive/Neon, the WORKSPACE/AGENT Durable Objects, AI, Vectorize,
 * Queues, Secrets Store, KV) and the config/flag/secret modules are added in
 * later phases per the architecture plan.
 */

const app = new OpenAPIHono<AppEnv>()

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
app.route('/api/v1/workspaces', workspaceRoutes)
// Invitation accept surface — authenticated but pre-membership by definition.
app.route('/api/v1/invitations', invitationRoutes)
// Zero-knowledge share links: authenticated create…
app.route('/api/v1/shares', shareRoutes)
// …and recipient consume, reachable only by the console BFF (INTERNAL_TOKEN).
app.route('/internal/shares', internalShareRoutes)
// Machine surface (environment API keys, not JWTs): CLI/CI export incl. secrets.
app.route('/machine', machineRoutes)

// Remote MCP server (Streamable HTTP), one per workspace, same auth + membership.
app.use('/mcp/:workspaceId', withDatabase, requireAuth, requireWorkspaceMember)
app.route('/mcp', mcpRoutes)

// Unhandled errors stay server-side: log the real cause, return a generic body
// (no message/stack passthrough to clients).
app.onError((err, c) => {
  console.error('unhandled error', err)
  return c.json({ error: 'internal_error' }, 500)
})
app.notFound((c) => c.json({ error: 'not_found' }, 404))

export default app
