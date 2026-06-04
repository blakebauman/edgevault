import { searchConfigs } from '@edgevault/ai'
import { generateApiKey } from '@edgevault/auth'
import { type ConfigFormat, isConfigFormat, validateContent } from '@edgevault/config-formats'
import { zValidator } from '@hono/zod-validator'
import { type Context, Hono } from 'hono'
import { z } from 'zod'
import { aiRunner, embeddingModel, indexConfig, vectorize } from '../ai'
import { emitAudit } from '../audit'
import { queryAuditHistory } from '../audit-query'
import type { AppEnv } from '../context'
import { createApiKey } from '../database/queries'
import type { ConfigItem } from '../durable-objects/types'
import type { WorkspaceDurableObject } from '../durable-objects/workspace'
import { deleteThrough, publishApiKey, writeThrough } from '../edge-cache'
import { prepareSecretContent, revealSecret } from '../secrets'

/**
 * Workspace config/flag/secret routes. Each request resolves the per-workspace
 * Durable Object (the system of record) and calls it over RPC. These routes run
 * behind requireAuth + requireWorkspaceMember, so `c.var.userId` is the verified
 * caller and org membership has already been checked.
 */

function stubFor(
  c: Context<AppEnv>,
  workspaceId: string,
): DurableObjectStub<WorkspaceDurableObject> {
  return c.env.WORKSPACE.get(c.env.WORKSPACE.idFromName(workspaceId))
}

/** Never return secret plaintext over the API (envelope decryption is gated, Phase 9). */
function redact(item: ConfigItem): ConfigItem {
  return item.kind === 'secret' ? { ...item, content: '' } : item
}

const kindSchema = z.enum(['config', 'flag', 'secret'])

const setConfigSchema = z.object({
  key: z.string().min(1),
  content: z.string(),
  kind: kindSchema.optional(),
  contentType: z.string().optional(),
  isEncrypted: z.boolean().optional(),
})

const promoteSchema = z.object({
  sourceEnvironmentId: z.string().min(1),
  targetEnvironmentId: z.string().min(1),
  key: z.string().min(1),
})

export const workspaceRoutes = new Hono<AppEnv>()
  // --- Environments ---
  .post(
    '/:workspaceId/environments',
    zValidator('json', z.object({ name: z.string().min(1), slug: z.string().min(1) })),
    async (c) => {
      const { name, slug } = c.req.valid('json')
      const environment = await stubFor(c, c.req.param('workspaceId')).createEnvironment({
        name,
        slug,
        userId: c.var.userId,
      })
      return c.json({ environment }, 201)
    },
  )
  .get('/:workspaceId/environments', async (c) => {
    const environments = await stubFor(c, c.req.param('workspaceId')).listEnvironments()
    return c.json({ environments })
  })

  // --- Config items ---
  .post(
    '/:workspaceId/environments/:envId/configs',
    zValidator('json', setConfigSchema),
    async (c) => {
      const body = c.req.valid('json')
      const format: ConfigFormat = isConfigFormat(body.contentType ?? '')
        ? (body.contentType as ConfigFormat)
        : 'json'
      const validation = validateContent(body.content, format)
      if (!validation.valid) {
        return c.json({ error: 'invalid_content', detail: validation.error, format }, 400)
      }
      const workspaceId = c.req.param('workspaceId')
      // Envelope-encrypt secrets before they reach the DO (which stores ciphertext).
      const prepared = await prepareSecretContent(c.env, workspaceId, body.kind, body.content)
      const config = await stubFor(c, workspaceId).setConfig({
        environmentId: c.req.param('envId'),
        key: body.key,
        kind: body.kind,
        content: prepared.content,
        contentType: format,
        isEncrypted: prepared.isEncrypted,
        userId: c.var.userId,
      })
      // Write-through to the edge cache (KV) for the delivery worker.
      c.executionCtx.waitUntil(writeThrough(c.env, workspaceId, config))
      // Index for semantic search (never index secret plaintext).
      if (config.kind !== 'secret') {
        c.executionCtx.waitUntil(indexConfig(c.env, workspaceId, config))
      }
      c.executionCtx.waitUntil(
        emitAudit(c.env, {
          workspaceId,
          environmentId: config.environmentId,
          action: config.version === 1 ? 'config.created' : 'config.updated',
          resourceType: config.kind,
          key: config.key,
          userId: c.var.userId,
        }),
      )
      return c.json({ config: redact(config) }, 201)
    },
  )
  .get('/:workspaceId/environments/:envId/configs', async (c) => {
    const kindParam = c.req.query('kind')
    const kind = kindParam && kindSchema.safeParse(kindParam).success ? kindParam : undefined
    const configs = await stubFor(c, c.req.param('workspaceId')).listConfigs(
      c.req.param('envId'),
      kind as 'config' | 'flag' | 'secret' | undefined,
    )
    return c.json({ configs: configs.map(redact) })
  })
  .get('/:workspaceId/environments/:envId/configs/:key', async (c) => {
    const config = await stubFor(c, c.req.param('workspaceId')).getConfig(
      c.req.param('envId'),
      c.req.param('key'),
    )
    if (!config) return c.json({ error: 'not_found' }, 404)
    return c.json({ config: redact(config) })
  })
  .delete('/:workspaceId/environments/:envId/configs/:key', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const envId = c.req.param('envId')
    const key = c.req.param('key')
    const ok = await stubFor(c, workspaceId).deleteConfig(envId, key, c.var.userId)
    if (ok) {
      c.executionCtx.waitUntil(deleteThrough(c.env, workspaceId, envId, key))
      c.executionCtx.waitUntil(
        emitAudit(c.env, {
          workspaceId,
          environmentId: envId,
          action: 'config.deleted',
          resourceType: 'config',
          key,
          userId: c.var.userId,
        }),
      )
    }
    return ok ? c.json({ ok: true }) : c.json({ error: 'not_found' }, 404)
  })
  // Reveal a decrypted secret value — restricted to org owners/admins.
  .get('/:workspaceId/environments/:envId/configs/:key/reveal', async (c) => {
    if (c.var.role !== 'owner' && c.var.role !== 'admin') {
      return c.json({ error: 'forbidden', detail: 'revealing secrets requires admin' }, 403)
    }
    const item = await stubFor(c, c.req.param('workspaceId')).getConfig(
      c.req.param('envId'),
      c.req.param('key'),
    )
    if (!item) return c.json({ error: 'not_found' }, 404)
    const value = await revealSecret(c.env, c.req.param('workspaceId'), item)
    // Revealing a secret is the single most sensitive action in the product —
    // always leave an audit trail (who, what, where), regardless of outcome.
    c.executionCtx.waitUntil(
      emitAudit(c.env, {
        workspaceId: c.req.param('workspaceId'),
        environmentId: c.req.param('envId'),
        action: 'secret.revealed',
        resourceType: item.kind,
        key: item.key,
        userId: c.var.userId,
      }),
    )
    return c.json({ key: item.key, kind: item.kind, content: value })
  })
  .get('/:workspaceId/environments/:envId/configs/:key/revisions', async (c) => {
    const revisions = await stubFor(c, c.req.param('workspaceId')).listRevisions(
      c.req.param('envId'),
      c.req.param('key'),
    )
    return c.json({ revisions })
  })

  // --- Revisions / promotions / activity ---
  .post('/:workspaceId/revisions/:revisionId/revert', async (c) => {
    const config = await stubFor(c, c.req.param('workspaceId')).revertToRevision(
      c.req.param('revisionId'),
      c.var.userId,
    )
    if (!config) return c.json({ error: 'not_found' }, 404)
    c.executionCtx.waitUntil(writeThrough(c.env, c.req.param('workspaceId'), config))
    return c.json({ config: redact(config) })
  })
  .post('/:workspaceId/promotions', zValidator('json', promoteSchema), async (c) => {
    const body = c.req.valid('json')
    const workspaceId = c.req.param('workspaceId')
    const promotion = await stubFor(c, workspaceId).promote({ ...body, userId: c.var.userId })
    const target = await stubFor(c, workspaceId).getConfig(body.targetEnvironmentId, body.key)
    if (target) c.executionCtx.waitUntil(writeThrough(c.env, workspaceId, target))
    c.executionCtx.waitUntil(
      emitAudit(c.env, {
        workspaceId,
        environmentId: body.targetEnvironmentId,
        action: 'config.promoted',
        resourceType: target?.kind ?? 'config',
        key: body.key,
        userId: c.var.userId,
      }),
    )
    return c.json({ promotion }, 201)
  })
  .get('/:workspaceId/promotions', async (c) => {
    const promotions = await stubFor(c, c.req.param('workspaceId')).listPromotions()
    return c.json({ promotions })
  })

  // --- Durable promotion workflow (with approval gate) ---
  .post('/:workspaceId/promotion-workflows', zValidator('json', promoteSchema), async (c) => {
    const body = c.req.valid('json')
    const instance = await c.env.PROMOTION_WORKFLOW.create({
      params: {
        workspaceId: c.req.param('workspaceId'),
        sourceEnvironmentId: body.sourceEnvironmentId,
        targetEnvironmentId: body.targetEnvironmentId,
        key: body.key,
        requestedBy: c.var.userId,
      },
    })
    return c.json({ instanceId: instance.id, status: await instance.status() }, 201)
  })
  .get('/:workspaceId/promotion-workflows/:instanceId', async (c) => {
    const instance = await c.env.PROMOTION_WORKFLOW.get(c.req.param('instanceId'))
    return c.json({ instanceId: instance.id, status: await instance.status() })
  })
  .post(
    '/:workspaceId/promotion-workflows/:instanceId/approve',
    zValidator('json', z.object({ approved: z.boolean() })),
    async (c) => {
      const instance = await c.env.PROMOTION_WORKFLOW.get(c.req.param('instanceId'))
      await instance.sendEvent({
        type: 'promotion-approval',
        payload: { approved: c.req.valid('json').approved, by: c.var.userId },
      })
      return c.json({ ok: true })
    },
  )
  .get('/:workspaceId/activity', async (c) => {
    const activity = await stubFor(c, c.req.param('workspaceId')).listActivity()
    return c.json({ activity })
  })
  // Cold audit history from the R2 warehouse (infinite retention). ?from&to are
  // YYYY-MM-DD (default last 7 days); ?env restricts to one environment.
  .get('/:workspaceId/audit', async (c) => {
    const events = await queryAuditHistory(c.env.AUDIT_BUCKET, {
      workspaceId: c.req.param('workspaceId'),
      from: c.req.query('from'),
      to: c.req.query('to'),
      environmentId: c.req.query('env'),
      limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
    })
    return c.json({ events })
  })

  // --- AI semantic search over the workspace's configs (Vectorize) ---
  .get('/:workspaceId/search', async (c) => {
    const query = c.req.query('q')
    if (!query) return c.json({ error: 'missing_query' }, 400)
    const hits = await searchConfigs(
      { ai: aiRunner(c.env), vectorize: vectorize(c.env), embeddingModel: embeddingModel(c.env) },
      {
        workspaceId: c.req.param('workspaceId'),
        query,
        environmentId: c.req.query('env') ?? undefined,
        topK: 10,
      },
    )
    return c.json({ query, hits })
  })

  // --- AI assistant ("what changed & why"), grounded in workspace activity ---
  .post(
    '/:workspaceId/assistant',
    zValidator('json', z.object({ question: z.string().min(1).max(1000) })),
    async (c) => {
      const workspaceId = c.req.param('workspaceId')
      const agent = c.env.AGENT.get(c.env.AGENT.idFromName(workspaceId))
      const result = await agent.ask({
        workspaceId,
        question: c.req.valid('json').question,
        userId: c.var.userId,
      })
      return c.json(result)
    },
  )
  .get('/:workspaceId/assistant/history', async (c) => {
    const agent = c.env.AGENT.get(c.env.AGENT.idFromName(c.req.param('workspaceId')))
    return c.json({ history: await agent.getHistory() })
  })

  // --- Environment API keys (for the delivery edge read path) ---
  .post(
    '/:workspaceId/environments/:envId/api-keys',
    zValidator('json', z.object({ name: z.string().min(1).max(120) })),
    async (c) => {
      const generated = generateApiKey('live')
      const key = await createApiKey(c.var.database, {
        workspaceId: c.req.param('workspaceId'),
        environmentId: c.req.param('envId'),
        name: c.req.valid('json').name,
        prefix: generated.prefix,
        keyHash: generated.keyHash,
        createdByUserId: c.var.userId,
      })
      // Publish the key->environment mapping so delivery can validate fast (KV).
      await publishApiKey(c.env, generated.keyHash, {
        workspaceId: c.req.param('workspaceId'),
        environmentId: c.req.param('envId'),
        scopes: ['read'],
      })
      // The plaintext key is shown exactly once.
      return c.json({ apiKey: generated.key, key }, 201)
    },
  )

  // --- Real-time: WebSocket upgrade ---
  // Auth + membership already enforced by the route middleware. We forward the
  // upgrade to the workspace DO with the verified user id and an optional env
  // filter so the DO never has to trust client-supplied identity.
  .get('/:workspaceId/ws', (c) => {
    if (c.req.header('upgrade') !== 'websocket') {
      return c.json({ error: 'expected_websocket' }, 426)
    }
    const url = new URL(c.req.url)
    url.searchParams.set('user', c.var.userId)
    url.searchParams.set('env', c.req.query('env') ?? '*')
    return stubFor(c, c.req.param('workspaceId')).fetch(new Request(url, c.req.raw))
  })
