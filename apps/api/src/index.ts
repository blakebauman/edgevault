import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { workspaceRoutes } from './routes/workspaces'

export { WorkspaceDurableObject } from './durable-objects/workspace'

/**
 * EdgeVault control-plane API.
 *
 * Phase 0: a typed OpenAPI Hono app with a health route + OpenAPI document.
 * Bindings (Hyperdrive/Neon, the WORKSPACE/AGENT Durable Objects, AI, Vectorize,
 * Queues, Secrets Store, KV) and the config/flag/secret modules are added in
 * later phases per the architecture plan.
 */

const app = new OpenAPIHono<{ Bindings: Env }>()

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

// Workspace config/flag/secret operations, backed by the per-workspace DO.
app.route('/api/v1/workspaces', workspaceRoutes)

export default app
