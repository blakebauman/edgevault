import { searchConfigs } from '@edgevault/ai'
import { generateApiKey, generateToken } from '@edgevault/auth'
import { type ConfigFormat, isConfigFormat, validateContent } from '@edgevault/config-formats'
import { encryptSecret } from '@edgevault/crypto'
import {
  CONFIG_KEY_PATTERN,
  isValidCidr,
  MAX_CONFIG_KEY_LENGTH,
  NOTIFY_ACTIONS,
} from '@edgevault/edge-protocol'
import { hasRefs } from '@edgevault/refs'
import { zValidator } from '@hono/zod-validator'
import { type Context, Hono } from 'hono'
import { z } from 'zod'
import { aiRunner, embeddingModel, indexConfig, unindexConfig, vectorize } from '../ai'
import { configChangeEvent, emitAudit, promoteEvent, revealEvent } from '../audit'
import { queryAuditHistory } from '../audit-query'
import { deletePageThrough, publishWithRender } from '../content-render'
import type { AppEnv } from '../context'
import {
  createApiKey,
  createNotificationChannel,
  deleteNotificationChannel,
  getNotificationChannel,
  getOrgRequiresStepUpForReveal,
  getUserDisplayNames,
  getWorkspaceWithOrg,
  isAiIndexingEnabled,
  listApiKeys,
  listNotificationChannels,
  revokeApiKey,
  setAiIndexingEnabled,
} from '../database/queries'
import type { ConfigItem } from '../durable-objects/types'
import type { VaultDurableObject } from '../durable-objects/vault'
import { deleteThrough, publishApiKey, unpublishApiKey } from '../edge-cache'
import { verifyRevealToken } from '../middleware/auth'
import { buildNotifyJob, dispatchNotifications, invalidateChannelCache } from '../notify'
import { enforceRateLimit } from '../rate-limit'
import { prepareSecretContent, revealSecret } from '../secrets'

/**
 * Workspace config/flag/secret routes. Each request resolves the per-workspace
 * Durable Object (the system of record) and calls it over RPC. These routes run
 * behind requireAuth + requireWorkspaceMember, so `c.var.userId` is the verified
 * caller and org membership has already been checked.
 */

function stubFor(c: Context<AppEnv>, workspaceId: string): DurableObjectStub<VaultDurableObject> {
  return c.env.WORKSPACE.get(c.env.WORKSPACE.idFromName(workspaceId))
}

/** Never return secret plaintext over the API (envelope decryption is gated, Phase 9). */
function redact(item: ConfigItem): ConfigItem {
  return item.kind === 'secret' ? { ...item, content: '' } : item
}

const kindSchema = z.enum(['config', 'flag', 'secret', 'content'])

// Keys compose into KV cache keys and ${...} references — constrain at write time.
const keySchema = z
  .string()
  .min(1)
  .max(MAX_CONFIG_KEY_LENGTH)
  .regex(CONFIG_KEY_PATTERN, 'key may only contain letters, digits, ".", "_" and "-"')

const setConfigSchema = z.object({
  key: keySchema,
  content: z.string(),
  kind: kindSchema.optional(),
  contentType: z.string().optional(),
  isEncrypted: z.boolean().optional(),
  /** Optional "why" recorded on the revision — attribution beyond who + when. */
  summary: z.string().max(500).optional(),
})

const revertSchema = z.object({
  summary: z.string().max(500).optional(),
})

const promoteSchema = z.object({
  sourceEnvironmentId: z.string().min(1),
  targetEnvironmentId: z.string().min(1),
  key: keySchema,
})

/**
 * SSRF guard for notification destinations: public https hosts only. Workers
 * have no privileged network position, so this stays a lightweight hostname
 * check (no DNS resolution) — it rejects the obviously-internal shapes.
 */
export function isPublicWebhookUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'https:') return false
  const host = url.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost')) return false
  if (host.endsWith('.local') || host.endsWith('.internal')) return false
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false // IPv4 literal
  if (host.includes(':') || host.startsWith('[')) return false // IPv6 literal
  if (!host.includes('.')) return false // bare/intranet hostname
  return true
}

const channelSchema = z.object({
  type: z.enum(['webhook', 'slack']),
  name: z.string().min(1).max(120),
  url: z
    .string()
    .url()
    .max(2048)
    .refine(isPublicWebhookUrl, 'webhook URL must be a public https host'),
  events: z.array(z.enum(NOTIFY_ACTIONS)).max(NOTIFY_ACTIONS.length).optional(),
})

function isAdmin(c: Context<AppEnv>): boolean {
  return c.var.role === 'owner' || c.var.role === 'admin'
}

/** DO reference-validation failures (`Reference error: …`) become client errors. */
function isRefError(error: unknown): error is Error {
  return error instanceof Error && error.message.startsWith('Reference error:')
}

/**
 * Republish an item AND everything that references it (transitively) to the
 * edge cache, with ${...} references expanded. Runs in waitUntil after writes.
 */
/**
 * Off-path anomaly evaluation: feed the signal to the workspace DO's
 * sliding-window counters and fan any crossed thresholds out as alert
 * notifications + audit events. Runs in waitUntil; never blocks the reveal.
 */
async function raiseAnomalyAlerts(
  c: Context<AppEnv>,
  workspaceId: string,
  action: 'secret.reveal' | 'environment.export',
  actor: string,
  count?: number,
): Promise<void> {
  const alerts = await stubFor(c, workspaceId).recordAnomalySignal({ action, actor, count })
  for (const alert of alerts) {
    const event = {
      workspaceId,
      action: `alert.${alert}`,
      resourceType: 'workspace',
      userId: actor,
      ...(count !== undefined ? { count } : {}),
    }
    await emitAudit(c.env, event)
    await dispatchNotifications(c.env, event)
  }
}

async function publishWithDependents(
  c: Context<AppEnv>,
  workspaceId: string,
  item: ConfigItem,
): Promise<void> {
  const stub = stubFor(c, workspaceId)
  const { targets, truncated } = await stub.collectPublishTargets(item.environmentId, item.key)
  if (truncated) {
    console.warn(
      `publish fan-out truncated at 100 for ${workspaceId}/${item.environmentId}/${item.key}`,
    )
  }
  await publishWithRender(c.env, stub, workspaceId, targets)
}

export const workspaceRoutes = new Hono<AppEnv>()
  // Workspace identity — name/org for console headers. Membership is already
  // verified by requireWorkspaceMember (which fetched the same row to authorize).
  .get('/:workspaceId', async (c) => {
    const workspace = await getWorkspaceWithOrg(c.var.database, c.req.param('workspaceId'))
    if (!workspace) return c.json({ error: 'workspace_not_found' }, 404)
    // The caller's org role rides along so the console can gate admin
    // affordances instead of offering doors that 403.
    return c.json({ workspace: { ...workspace, role: c.var.role } })
  })
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
  // Side-by-side comparison of two environments. Secrets compare by presence
  // only (their ciphertext is non-deterministic) — values are never decrypted.
  .get('/:workspaceId/environments/compare', async (c) => {
    const source = c.req.query('source')
    const target = c.req.query('target')
    if (!source || !target) {
      return c.json(
        {
          error: 'missing_environments',
          detail: '?source= and ?target= environment ids required',
        },
        400,
      )
    }
    if (source === target) {
      return c.json({ error: 'same_environment', detail: 'source and target must differ' }, 400)
    }
    try {
      const comparison = await stubFor(c, c.req.param('workspaceId')).compareEnvironments(
        source,
        target,
      )
      return c.json({ comparison })
    } catch (error) {
      if (error instanceof Error && error.message.includes('Environment not found')) {
        return c.json(
          {
            error: 'not_found',
            detail: 'unknown source or target environment',
          },
          404,
        )
      }
      throw error
    }
  })
  // One key's value across every environment — the "across environments" matrix
  // in the console's item detail. Secrets report presence + version only (their
  // ciphertext is never decrypted or returned).
  .get('/:workspaceId/configs/:key/across-environments', async (c) => {
    const key = c.req.param('key')
    const stub = stubFor(c, c.req.param('workspaceId'))
    const environments = await stub.listEnvironments()
    const rows = await Promise.all(
      environments.map(async (env) => {
        const item = await stub.getConfig(env.id, key)
        return { id: env.id, name: env.name, slug: env.slug, item: item ? redact(item) : null }
      }),
    )
    return c.json({ key, environments: rows })
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
      let config: ConfigItem
      try {
        config = await stubFor(c, workspaceId).setConfig({
          environmentId: c.req.param('envId'),
          key: body.key,
          kind: body.kind,
          content: prepared.content,
          contentType: format,
          isEncrypted: prepared.isEncrypted,
          summary: body.summary?.trim() || undefined,
          userId: c.var.userId,
        })
      } catch (error) {
        if (isRefError(error))
          return c.json({ error: 'invalid_reference', detail: error.message }, 400)
        throw error
      }
      // Write-through to the edge cache (KV) — the item plus anything referencing it.
      c.executionCtx.waitUntil(publishWithDependents(c, workspaceId, config))
      // Index for semantic search (never index secret plaintext; workspaces can
      // opt out of content indexing entirely).
      if (config.kind !== 'secret' && (await isAiIndexingEnabled(c.var.database, workspaceId))) {
        c.executionCtx.waitUntil(indexConfig(c.env, workspaceId, config))
      }
      const changeEvent = configChangeEvent({
        workspaceId,
        environmentId: config.environmentId,
        kind: config.kind,
        key: config.key,
        version: config.version,
        userId: c.var.userId,
      })
      c.executionCtx.waitUntil(emitAudit(c.env, changeEvent))
      c.executionCtx.waitUntil(dispatchNotifications(c.env, changeEvent))
      return c.json({ config: redact(config) }, 201)
    },
  )
  .get('/:workspaceId/environments/:envId/configs', async (c) => {
    const kindParam = c.req.query('kind')
    const kind = kindParam && kindSchema.safeParse(kindParam).success ? kindParam : undefined
    const configs = await stubFor(c, c.req.param('workspaceId')).listConfigs(
      c.req.param('envId'),
      kind as 'config' | 'flag' | 'secret' | 'content' | undefined,
    )
    return c.json({ configs: configs.map(redact) })
  })
  .get('/:workspaceId/environments/:envId/configs/:key', async (c) => {
    const config = await stubFor(c, c.req.param('workspaceId')).getConfig(
      c.req.param('envId'),
      c.req.param('key'),
    )
    if (!config) return c.json({ error: 'not_found' }, 404)
    // Items with ${...} references also report their resolved (published) value.
    let resolvedContent: string | undefined
    if (config.kind !== 'secret' && hasRefs(config.content)) {
      const { targets } = await stubFor(c, c.req.param('workspaceId')).collectPublishTargets(
        config.environmentId,
        config.key,
        1,
      )
      resolvedContent = targets[0]?.resolvedContent
    }
    return c.json({ config: redact(config), resolvedContent })
  })
  .delete('/:workspaceId/environments/:envId/configs/:key', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const envId = c.req.param('envId')
    const key = c.req.param('key')
    let ok: boolean
    try {
      ok = await stubFor(c, workspaceId).deleteConfig(envId, key, c.var.userId)
    } catch (error) {
      // Deleting an item other configs still reference would break them.
      if (isRefError(error)) return c.json({ error: 'referenced', detail: error.message }, 409)
      throw error
    }
    if (ok) {
      c.executionCtx.waitUntil(deleteThrough(c.env, workspaceId, envId, key))
      c.executionCtx.waitUntil(deletePageThrough(c.env, workspaceId, envId, key))
      c.executionCtx.waitUntil(unindexConfig(c.env, workspaceId, envId, key))
      const deleteEvent = {
        workspaceId,
        environmentId: envId,
        action: 'config.deleted',
        resourceType: 'config',
        key,
        userId: c.var.userId,
      }
      c.executionCtx.waitUntil(emitAudit(c.env, deleteEvent))
      c.executionCtx.waitUntil(dispatchNotifications(c.env, deleteEvent))
    }
    return ok ? c.json({ ok: true }) : c.json({ error: 'not_found' }, 404)
  })
  // The restorable set: keys whose revisions survive deletion.
  .get('/:workspaceId/environments/:envId/deleted-configs', async (c) => {
    const deleted = await stubFor(c, c.req.param('workspaceId')).listDeletedConfigs(
      c.req.param('envId'),
    )
    return c.json({ deleted })
  })
  // Undo for deletes: re-create a key from its newest surviving revision (the
  // delete snapshot), with kind/encryption restored faithfully.
  .post('/:workspaceId/environments/:envId/configs/:key/restore', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const envId = c.req.param('envId')
    const key = c.req.param('key')
    let config: ConfigItem
    try {
      config = await stubFor(c, workspaceId).restoreConfig(envId, key, c.var.userId)
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Restore error:')) {
        return c.json({ error: 'unrestorable', detail: error.message.slice(15) }, 422)
      }
      if (isRefError(error))
        return c.json({ error: 'invalid_reference', detail: error.message }, 400)
      throw error
    }
    c.executionCtx.waitUntil(publishWithDependents(c, workspaceId, config))
    if (config.kind !== 'secret' && (await isAiIndexingEnabled(c.var.database, workspaceId))) {
      c.executionCtx.waitUntil(indexConfig(c.env, workspaceId, config))
    }
    c.executionCtx.waitUntil(
      emitAudit(c.env, {
        workspaceId,
        environmentId: envId,
        action: 'config.restored',
        resourceType: config.kind,
        key,
        userId: c.var.userId,
      }),
    )
    return c.json({ config: redact(config) })
  })
  // Reveal a decrypted secret value — restricted to org owners/admins.
  .get('/:workspaceId/environments/:envId/configs/:key/reveal', async (c) => {
    if (c.var.role !== 'owner' && c.var.role !== 'admin') {
      return c.json({ error: 'forbidden', detail: 'revealing secrets requires admin' }, 403)
    }
    // Hard ceiling: a compromised admin token can pull at most N secrets/min,
    // and every one of those still lands in audit + notifications.
    const capped = await enforceRateLimit(c, c.env.REVEAL_LIMITER, `reveal:${c.var.userId}`)
    if (capped) return capped
    // Step-up: when the org requires it, a fresh second factor (proven by a
    // reveal token minted at auth's /reauth) is needed on top of being signed
    // in. The token is verified by its `secret-reveal` audience and must belong
    // to the caller AND be scoped to this workspace's org (so a step-up in one
    // org can't unlock reveals in another). Machine export (API-key auth) is a
    // different route and is intentionally exempt — CI cannot step up.
    let stepUp = false
    const revealToken = c.req.header('x-reveal-token')
    if (revealToken) {
      const claims = await verifyRevealToken(c.env, revealToken)
      stepUp = claims !== null && claims.sub === c.var.userId && claims.org === c.var.orgId
    }
    if (c.var.orgId && !stepUp) {
      const required = await getOrgRequiresStepUpForReveal(c.var.database, c.var.orgId)
      if (required) {
        return c.json(
          {
            error: 'reauth_required',
            detail: 'revealing this secret requires a fresh second factor',
          },
          401,
        )
      }
    }
    const item = await stubFor(c, c.req.param('workspaceId')).getConfig(
      c.req.param('envId'),
      c.req.param('key'),
    )
    if (!item) return c.json({ error: 'not_found' }, 404)
    const value = await revealSecret(c.env, c.req.param('workspaceId'), item)
    // Revealing a secret is the single most sensitive action in the product —
    // always leave an audit trail (who, what, where), regardless of outcome.
    const revealed = revealEvent({
      workspaceId: c.req.param('workspaceId'),
      environmentId: c.req.param('envId'),
      kind: item.kind,
      key: item.key,
      userId: c.var.userId,
      stepUp,
    })
    c.executionCtx.waitUntil(emitAudit(c.env, revealed))
    c.executionCtx.waitUntil(dispatchNotifications(c.env, revealed))
    c.executionCtx.waitUntil(
      raiseAnomalyAlerts(c, c.req.param('workspaceId'), 'secret.reveal', c.var.userId),
    )
    return c.json({ key: item.key, kind: item.kind, content: value })
  })
  .get('/:workspaceId/environments/:envId/configs/:key/revisions', async (c) => {
    const revisions = await stubFor(c, c.req.param('workspaceId')).listRevisions(
      c.req.param('envId'),
      c.req.param('key'),
    )
    // Resolve author ids to names — same batched lookup as /activity.
    const ids = [...new Set(revisions.map((r) => r.createdBy))]
    const actors = await getUserDisplayNames(c.var.database, ids)
    return c.json({
      // Never return secret ciphertext over the API — same rule as redact() on
      // the item routes. History keeps the content hash (so the UI can show a
      // secret changed between revisions) but never the envelope itself.
      revisions: revisions.map((r) => ({
        ...r,
        content: r.kind === 'secret' ? '' : r.content,
        actor: actors.get(r.createdBy) ?? null,
      })),
    })
  })

  // --- Revisions / promotions / activity ---
  .post(
    '/:workspaceId/revisions/:revisionId/revert',
    zValidator('json', revertSchema),
    async (c) => {
      const { summary } = c.req.valid('json')
      let config: ConfigItem | null
      try {
        config = await stubFor(c, c.req.param('workspaceId')).revertToRevision(
          c.req.param('revisionId'),
          c.var.userId,
          summary?.trim() || undefined,
        )
      } catch (error) {
        // The old revision may reference items that no longer exist.
        if (isRefError(error))
          return c.json({ error: 'invalid_reference', detail: error.message }, 400)
        throw error
      }
      if (!config) return c.json({ error: 'not_found' }, 404)
      c.executionCtx.waitUntil(publishWithDependents(c, c.req.param('workspaceId'), config))
      return c.json({ config: redact(config) })
    },
  )
  .post('/:workspaceId/promotions', zValidator('json', promoteSchema), async (c) => {
    const body = c.req.valid('json')
    const workspaceId = c.req.param('workspaceId')
    try {
      const promotion = await stubFor(c, workspaceId).promote({
        ...body,
        userId: c.var.userId,
      })
      const target = await stubFor(c, workspaceId).getConfig(body.targetEnvironmentId, body.key)
      if (target) c.executionCtx.waitUntil(publishWithDependents(c, workspaceId, target))
      const promoted = promoteEvent({
        workspaceId,
        targetEnvironmentId: body.targetEnvironmentId,
        kind: target?.kind,
        key: body.key,
        userId: c.var.userId,
      })
      c.executionCtx.waitUntil(emitAudit(c.env, promoted))
      c.executionCtx.waitUntil(dispatchNotifications(c.env, promoted))
      return c.json({ promotion }, 201)
    } catch (error) {
      // e.g. promoting "${HOST}" into an env that has no HOST yet.
      if (isRefError(error)) {
        return c.json({ error: 'invalid_reference', detail: error.message }, 400)
      }
      throw error
    }
  })
  .get('/:workspaceId/promotions', async (c) => {
    const promotions = await stubFor(c, c.req.param('workspaceId')).listPromotions()
    // Same batched name resolution as /activity — approvals show who asked.
    const ids = [...new Set(promotions.map((p) => p.createdBy))]
    const actors = await getUserDisplayNames(c.var.database, ids)
    return c.json({
      promotions: promotions.map((p) => ({ ...p, actor: actors.get(p.createdBy) ?? null })),
    })
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
      // Resolving a parked promotion mutates a (typically production)
      // environment — same privilege bar as revealing a secret.
      if (c.var.role !== 'owner' && c.var.role !== 'admin') {
        return c.json({ error: 'forbidden', detail: 'resolving a promotion requires admin' }, 403)
      }
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
    // The DO stores actor ids; people read names. Resolve in one batched query,
    // and lift environmentId out of the changes payload for env context.
    const ids = [...new Set(activity.map((a) => a.userId).filter((id): id is string => !!id))]
    const actors = await getUserDisplayNames(c.var.database, ids)
    return c.json({
      activity: activity.map((a) => {
        let environmentId: string | null = null
        if (a.changes) {
          try {
            environmentId =
              (JSON.parse(a.changes) as { environmentId?: string }).environmentId ?? null
          } catch {
            // pre-JSON or malformed changes payload — env context just stays absent
          }
        }
        return { ...a, actor: a.userId ? (actors.get(a.userId) ?? null) : null, environmentId }
      }),
    })
  })
  // Cold audit history from the R2 warehouse (infinite retention). ?from&to are
  // YYYY-MM-DD (default last 7 days); ?env restricts to one environment.
  .get('/:workspaceId/audit', async (c) => {
    const { events, total } = await queryAuditHistory(c.env.AUDIT_BUCKET, {
      workspaceId: c.req.param('workspaceId'),
      from: c.req.query('from'),
      to: c.req.query('to'),
      environmentId: c.req.query('env'),
      limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
    })
    // Same batched name resolution as /activity — audit answers "who".
    const ids = [...new Set(events.map((e) => e.userId).filter(Boolean))]
    const actors = await getUserDisplayNames(c.var.database, ids)
    return c.json({
      events: events.map((e) => ({ ...e, actor: actors.get(e.userId) ?? null })),
      total,
    })
  })
  // Compliance export: the raw warehouse NDJSON for a date range, with a
  // SHA-256 digest header so the file is verifiable after download
  // (`shasum -a 256 export.ndjson`). Exporting the audit trail is itself an
  // auditable act. Tamper-evident hash chaining stays roadmap-tier.
  .get('/:workspaceId/audit/export', async (c) => {
    if (!isAdmin(c)) {
      return c.json({ error: 'forbidden', detail: 'audit export requires admin' }, 403)
    }
    const workspaceId = c.req.param('workspaceId')
    const { events } = await queryAuditHistory(c.env.AUDIT_BUCKET, {
      workspaceId,
      from: c.req.query('from'),
      to: c.req.query('to'),
      environmentId: c.req.query('env'),
      limit: 1000000,
    })
    const ndjson = events.map((e) => JSON.stringify(e)).join('\n')
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ndjson))
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')

    c.executionCtx.waitUntil(
      emitAudit(c.env, {
        workspaceId,
        action: 'audit.exported',
        resourceType: 'audit',
        userId: c.var.userId,
        count: events.length,
      }),
    )
    return new Response(ndjson, {
      headers: {
        'content-type': 'application/x-ndjson',
        'content-disposition': `attachment; filename="edgevault-audit-${workspaceId}.ndjson"`,
        'x-content-sha256': hex,
        'x-audit-event-count': String(events.length),
      },
    })
  })

  // --- Workspace AI settings (content-indexing opt-out) ---
  .get('/:workspaceId/settings', async (c) => {
    return c.json({
      aiIndexingEnabled: await isAiIndexingEnabled(c.var.database, c.req.param('workspaceId')),
    })
  })
  .patch(
    '/:workspaceId/settings',
    zValidator('json', z.object({ aiIndexingEnabled: z.boolean() })),
    async (c) => {
      if (!isAdmin(c)) {
        return c.json({ error: 'forbidden', detail: 'workspace settings require admin' }, 403)
      }
      await setAiIndexingEnabled(
        c.var.database,
        c.req.param('workspaceId'),
        c.req.valid('json').aiIndexingEnabled,
      )
      return c.json({ ok: true })
    },
  )

  // --- AI semantic search over the workspace's configs (Vectorize) ---
  .get('/:workspaceId/search', async (c) => {
    const query = c.req.query('q')
    if (!query) return c.json({ error: 'missing_query' }, 400)
    if (!(await isAiIndexingEnabled(c.var.database, c.req.param('workspaceId')))) {
      return c.json({ hits: [], aiIndexingDisabled: true })
    }
    // Embedding + Vectorize work is metered upstream — cap per user.
    const limited = await enforceRateLimit(c, c.env.AI_USER_LIMITER, `ai:${c.var.userId}`)
    if (limited) return limited
    const hits = await searchConfigs(
      {
        ai: aiRunner(c.env),
        vectorize: vectorize(c.env),
        embeddingModel: embeddingModel(c.env),
      },
      {
        workspaceId: c.req.param('workspaceId'),
        query,
        environmentId: c.req.query('env') ?? undefined,
        topK: 10,
      },
    )
    return c.json({ query, hits })
  })

  // The AI assistant is served over the Agents SDK WebSocket surface
  // (`/agents/*` in index.ts → EdgeVaultAgent.onChatMessage), not an HTTP route.

  // --- Environment API keys (for the delivery edge read path) ---
  .post(
    '/:workspaceId/environments/:envId/api-keys',
    zValidator(
      'json',
      z.object({
        name: z.string().min(1).max(120),
        scopes: z
          .array(z.enum(['read', 'secrets:read']))
          .nonempty()
          .optional(),
        // Optional lifecycle/scope hardening: TTL in days and source-IP CIDRs.
        expiresInDays: z.number().int().min(1).max(365).optional(),
        allowedCidrs: z.array(z.string().max(64)).max(20).optional(),
      }),
    ),
    async (c) => {
      const body = c.req.valid('json')
      const scopes = body.scopes ?? ['read']
      // A secrets:read key can decrypt every secret in its environment (the
      // machine export surface) — minting one is gated like the reveal endpoint.
      if (scopes.includes('secrets:read') && !isAdmin(c)) {
        return c.json({ error: 'forbidden', detail: 'secrets:read keys require admin' }, 403)
      }
      const allowedCidrs = body.allowedCidrs?.filter((c) => c.trim() !== '')
      if (allowedCidrs?.some((cidr) => !isValidCidr(cidr))) {
        return c.json(
          { error: 'invalid_cidr', detail: 'allowedCidrs must be IPv4/IPv6 addresses or CIDRs' },
          400,
        )
      }
      const expiresAt = body.expiresInDays
        ? new Date(Date.now() + body.expiresInDays * 24 * 60 * 60 * 1000)
        : undefined

      const generated = generateApiKey('live')
      const key = await createApiKey(c.var.database, {
        workspaceId: c.req.param('workspaceId'),
        environmentId: c.req.param('envId'),
        name: body.name,
        prefix: generated.prefix,
        keyHash: generated.keyHash,
        createdByUserId: c.var.userId,
        scopes,
        expiresAt,
        allowedCidrs: allowedCidrs?.length ? allowedCidrs : undefined,
      })
      // Publish the key->environment mapping so delivery can validate fast (KV).
      await publishApiKey(c.env, generated.keyHash, {
        workspaceId: c.req.param('workspaceId'),
        environmentId: c.req.param('envId'),
        // Lets delivery pin custom delivery domains to their owning org.
        ...(c.var.orgId ? { organizationId: c.var.orgId } : {}),
        scopes,
        ...(expiresAt ? { expiresAt: +expiresAt } : {}),
        ...(allowedCidrs?.length ? { allowedCidrs } : {}),
      })
      // The plaintext key is shown exactly once.
      return c.json({ apiKey: generated.key, key }, 201)
    },
  )

  // Key inventory (member-visible; hashes never leave the database).
  .get('/:workspaceId/api-keys', async (c) => {
    const keys = await listApiKeys(c.var.database, c.req.param('workspaceId'))
    return c.json({
      keys: keys.map((k) => ({
        id: k.id,
        environmentId: k.environmentId,
        name: k.name,
        prefix: k.prefix,
        scopes: k.scopes,
        createdAt: k.createdAt.toISOString(),
        expiresAt: k.expiresAt?.toISOString() ?? null,
        lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
        revokedAt: k.revokedAt?.toISOString() ?? null,
        allowedCidrs: k.allowedCidrs ?? [],
        mine: k.createdByUserId === c.var.userId,
      })),
    })
  })

  // Revoke: admins may revoke any key, members only keys they minted. The KV
  // delete is what takes the key out of service at the edge (≤60s KV read
  // consistency); revoked_at is the bookkeeping.
  .delete('/:workspaceId/api-keys/:keyId', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const keyHash = await revokeApiKey(c.var.database, workspaceId, c.req.param('keyId'), {
      onlyIfCreatedBy: isAdmin(c) ? undefined : c.var.userId,
    })
    if (!keyHash) return c.json({ error: 'not_found' }, 404)
    await unpublishApiKey(c.env, keyHash)
    c.executionCtx.waitUntil(
      emitAudit(c.env, {
        workspaceId,
        action: 'api_key.revoked',
        resourceType: 'api_key',
        userId: c.var.userId,
      }),
    )
    return c.json({ ok: true })
  })

  // --- Notification channels (Slack / signed webhooks) ---
  // Admin-only: destination URLs are credentials. They're stored envelope-
  // encrypted (keyed by workspace) and the webhook signing secret is shown
  // exactly once at creation.
  .post('/:workspaceId/channels', zValidator('json', channelSchema), async (c) => {
    if (!isAdmin(c)) {
      return c.json({ error: 'forbidden', detail: 'managing channels requires admin' }, 403)
    }
    const body = c.req.valid('json')
    const workspaceId = c.req.param('workspaceId')
    const signingSecret = body.type === 'webhook' ? `evw_${generateToken(32)}` : undefined
    const envelope = await encryptSecret(
      c.env.MASTER_KEK,
      workspaceId,
      JSON.stringify({ url: body.url, secret: signingSecret }),
    )
    const channel = await createNotificationChannel(c.var.database, {
      workspaceId,
      type: body.type,
      name: body.name,
      encryptedCredentials: JSON.stringify(envelope),
      events: body.events,
      createdByUserId: c.var.userId,
    })
    invalidateChannelCache(workspaceId)
    // The signing secret is shown exactly once — receivers verify webhook HMACs with it.
    return c.json({ channel, signingSecret }, 201)
  })
  .get('/:workspaceId/channels', async (c) => {
    if (!isAdmin(c)) {
      return c.json({ error: 'forbidden', detail: 'managing channels requires admin' }, 403)
    }
    const channels = await listNotificationChannels(c.var.database, c.req.param('workspaceId'))
    // Never return credentials — even encrypted.
    return c.json({
      channels: channels.map(({ encryptedCredentials: _credentials, ...safe }) => safe),
    })
  })
  .delete('/:workspaceId/channels/:channelId', async (c) => {
    if (!isAdmin(c)) {
      return c.json({ error: 'forbidden', detail: 'managing channels requires admin' }, 403)
    }
    const workspaceId = c.req.param('workspaceId')
    const ok = await deleteNotificationChannel(
      c.var.database,
      workspaceId,
      c.req.param('channelId'),
    )
    invalidateChannelCache(workspaceId)
    return ok ? c.json({ ok: true }) : c.json({ error: 'not_found' }, 404)
  })
  // Send a test event to one channel (bypasses event filters).
  .post('/:workspaceId/channels/:channelId/test', async (c) => {
    if (!isAdmin(c)) {
      return c.json({ error: 'forbidden', detail: 'managing channels requires admin' }, 403)
    }
    const workspaceId = c.req.param('workspaceId')
    const channel = await getNotificationChannel(
      c.var.database,
      workspaceId,
      c.req.param('channelId'),
    )
    if (!channel) return c.json({ error: 'not_found' }, 404)
    const job = await buildNotifyJob(c.env, channel, {
      at: Date.now(),
      workspaceId,
      action: 'test',
      resourceType: 'channel',
      userId: c.var.userId,
    })
    if (!job) return c.json({ error: 'invalid_credentials' }, 422)
    await c.env.NOTIFY_QUEUE.send(job)
    return c.json({ ok: true })
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
