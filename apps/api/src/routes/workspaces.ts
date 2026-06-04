import { type ConfigFormat, isConfigFormat, validateContent } from '@edgevault/config-formats'
import { zValidator } from '@hono/zod-validator'
import { type Context, Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../context'
import type { ConfigItem } from '../durable-objects/types'
import type { WorkspaceDurableObject } from '../durable-objects/workspace'

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
      const config = await stubFor(c, c.req.param('workspaceId')).setConfig({
        environmentId: c.req.param('envId'),
        key: body.key,
        kind: body.kind,
        content: body.content,
        contentType: format,
        isEncrypted: body.isEncrypted,
        userId: c.var.userId,
      })
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
    const ok = await stubFor(c, c.req.param('workspaceId')).deleteConfig(
      c.req.param('envId'),
      c.req.param('key'),
      c.var.userId,
    )
    return ok ? c.json({ ok: true }) : c.json({ error: 'not_found' }, 404)
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
    return c.json({ config: redact(config) })
  })
  .post('/:workspaceId/promotions', zValidator('json', promoteSchema), async (c) => {
    const promotion = await stubFor(c, c.req.param('workspaceId')).promote({
      ...c.req.valid('json'),
      userId: c.var.userId,
    })
    return c.json({ promotion }, 201)
  })
  .get('/:workspaceId/promotions', async (c) => {
    const promotions = await stubFor(c, c.req.param('workspaceId')).listPromotions()
    return c.json({ promotions })
  })
  .get('/:workspaceId/activity', async (c) => {
    const activity = await stubFor(c, c.req.param('workspaceId')).listActivity()
    return c.json({ activity })
  })

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
