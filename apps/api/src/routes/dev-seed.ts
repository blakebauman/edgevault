import { hashToken } from '@edgevault/auth'
import { encryptSecret } from '@edgevault/crypto'
import {
  SEED_ORGS,
  type SeedChannel,
  type SeedItem,
  type SeedOrg,
  type SeedWorkspace,
} from '@edgevault/database'
import { apiKeys, notificationChannels } from '@edgevault/database/schema'
import { customDomainCacheKey } from '@edgevault/edge-protocol'
import { eq } from 'drizzle-orm'
import { Hono, type MiddlewareHandler } from 'hono'
import { publishWithRender } from '../content-render'
import type { AppEnv } from '../context'
import { createApiKey, createNotificationChannel } from '../database/queries'
import type { Environment } from '../durable-objects/types'
import type { VaultDurableObject } from '../durable-objects/vault'
import { publishApiKey, unpublishApiKey } from '../edge-cache'
import { prepareSecretContent } from '../secrets'
import { timingSafeEqual } from '../timing'

/**
 * Local-dev seed — PHASE 2 (Vault Durable Object + KV).
 *
 * Phase 1 (`packages/database/src/seed.ts`) plants the Postgres graph. This
 * endpoint fills the part Postgres can't reach: per-workspace environments and
 * the config/flag/secret/content items (with real revision history + a couple
 * of promotions), plus the KV write-through, the `ENVIRONMENT_API_KEYS` records
 * that make seeded API keys work at the edge, encrypted notification channels,
 * and the custom-domain → org KV pin. It reuses the exact write helpers the real
 * routes use, so encryption, references, and publishing all behave normally.
 *
 * GUARDS (both required):
 *   1. ALLOW_DEV_SEED=1 — present only in apps/api/.dev.vars, never deployed, so
 *      the endpoint is inert in staging/prod even if the token leaks. (Local
 *      `wrangler dev` runs with the production vars block, so ENVIRONMENT can't
 *      be used to detect dev.)
 *   2. x-internal-token === INTERNAL_TOKEN (the same shared secret the console
 *      BFF uses for /internal/shares).
 *
 * Idempotent: workspaces/environments are created only if missing and items
 * upsert, so re-running is safe and refreshes content.
 */

type DevSeedEnv = AppEnv & { Bindings: { ALLOW_DEV_SEED?: string } }

const requireDevSeed: MiddlewareHandler<DevSeedEnv> = async (c, next) => {
  if (c.env.ALLOW_DEV_SEED !== '1') {
    return c.json({ error: 'not_found' }, 404)
  }
  const presented = c.req.header('x-internal-token') ?? ''
  if (!c.env.INTERNAL_TOKEN || !timingSafeEqual(presented, c.env.INTERNAL_TOKEN)) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  await next()
}

function stubFor(env: Env, workspaceId: string): DurableObjectStub<VaultDurableObject> {
  return env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId))
}

/** Default content-type per kind when the fixture doesn't pin one. */
function contentTypeFor(item: SeedItem): string {
  if (item.contentType) return item.contentType
  if (item.kind === 'content') return 'markdown'
  if (item.kind === 'secret') return 'text'
  return 'json'
}

const SEED_USER_ID = '00000000-0000-4000-8000-000000000001' // dev@edgevault.test

/** Write one item version: encrypt secrets, set in the DO, publish to KV. */
async function writeItem(
  env: Env,
  workspaceId: string,
  environmentId: string,
  item: SeedItem,
  content: string,
  summary: string | undefined,
): Promise<void> {
  const kind = item.kind
  const prepared = await prepareSecretContent(env, workspaceId, kind, content)
  const stub = stubFor(env, workspaceId)
  const config = await stub.setConfig({
    environmentId,
    key: item.key,
    kind,
    content: prepared.content,
    contentType: contentTypeFor(item),
    isEncrypted: prepared.isEncrypted,
    summary,
    userId: SEED_USER_ID,
  })
  // Write-through to the edge cache (KV) — the item plus anything referencing it.
  const { targets } = await stub.collectPublishTargets(config.environmentId, config.key)
  await publishWithRender(env, stub, workspaceId, targets)
}

async function seedWorkspace(
  env: Env,
  database: AppEnv['Variables']['database'],
  org: SeedOrg,
  ws: SeedWorkspace,
): Promise<{ items: number; promotions: number; apiKeys: number; channels: number }> {
  const stub = stubFor(env, ws.id)
  await stub.ensureWorkspace({ id: ws.id, name: ws.name, organizationId: org.id })

  // Environments: create the missing ones, then map slug → id.
  const existing = await stub.listEnvironments()
  const bySlug = new Map<string, Environment>(existing.map((e) => [e.slug, e]))
  for (const envDef of ws.environments) {
    if (!bySlug.has(envDef.slug)) {
      const created = await stub.createEnvironment({
        name: envDef.name,
        slug: envDef.slug,
        userId: SEED_USER_ID,
      })
      bySlug.set(created.slug, created)
    }
  }

  // Items: write revision history (development only) then the per-env values.
  let itemCount = 0
  for (const item of ws.items) {
    const devEnv = bySlug.get('development')
    if (devEnv) {
      for (const rev of item.history ?? []) {
        await writeItem(env, ws.id, devEnv.id, item, rev.content, rev.summary)
      }
    }
    for (const [slug, value] of Object.entries(item.values)) {
      if (value === undefined) continue
      const target = bySlug.get(slug)
      if (!target) continue
      await writeItem(env, ws.id, target.id, item, value, item.summary)
      itemCount++
    }
  }

  // Promotions (completed): copies source→target and records the promotion.
  let promotionCount = 0
  for (const promo of ws.promotions ?? []) {
    const from = bySlug.get(promo.from)
    const to = bySlug.get(promo.to)
    if (!from || !to) continue
    await stub.promote({
      sourceEnvironmentId: from.id,
      targetEnvironmentId: to.id,
      key: promo.key,
      userId: SEED_USER_ID,
    })
    const target = await stub.getConfig(to.id, promo.key)
    if (target) {
      const { targets } = await stub.collectPublishTargets(target.environmentId, target.key)
      await publishWithRender(env, stub, ws.id, targets)
    }
    promotionCount++
  }

  // Idempotency: API keys and channels are plain inserts (unique key_hash), so
  // clear this workspace's existing ones — and their KV records — before
  // recreating, letting the endpoint be re-run safely.
  const staleKeys = await database
    .delete(apiKeys)
    .where(eq(apiKeys.workspaceId, ws.id))
    .returning({ keyHash: apiKeys.keyHash })
  await Promise.all(staleKeys.map((k) => unpublishApiKey(env, k.keyHash)))
  await database.delete(notificationChannels).where(eq(notificationChannels.workspaceId, ws.id))

  // API keys: PG row + the KV record delivery/machine validate against.
  let apiKeyCount = 0
  for (const key of ws.apiKeys ?? []) {
    const target = bySlug.get(key.environment)
    if (!target) continue
    const keyHash = hashToken(key.rawKey)
    await createApiKey(database, {
      workspaceId: ws.id,
      environmentId: target.id,
      name: key.name,
      prefix: key.rawKey.slice(0, 16),
      keyHash,
      createdByUserId: SEED_USER_ID,
      scopes: key.scopes,
    })
    await publishApiKey(env, keyHash, {
      workspaceId: ws.id,
      environmentId: target.id,
      organizationId: org.id,
      scopes: key.scopes,
    })
    apiKeyCount++
  }

  // Notification channels: destination URL + signing secret envelope-encrypted.
  let channelCount = 0
  for (const ch of ws.channels ?? []) {
    await seedChannel(env, database, ws.id, ch)
    channelCount++
  }

  return {
    items: itemCount,
    promotions: promotionCount,
    apiKeys: apiKeyCount,
    channels: channelCount,
  }
}

async function seedChannel(
  env: Env,
  database: AppEnv['Variables']['database'],
  workspaceId: string,
  ch: SeedChannel,
): Promise<void> {
  const signingSecret = ch.type === 'webhook' ? `evw_devseed_${workspaceId.slice(0, 8)}` : undefined
  const envelope = await encryptSecret(
    env.MASTER_KEK,
    workspaceId,
    JSON.stringify({ url: ch.url, secret: signingSecret }),
  )
  await createNotificationChannel(database, {
    workspaceId,
    type: ch.type,
    name: ch.name,
    encryptedCredentials: JSON.stringify(envelope),
    events: ch.events,
    createdByUserId: SEED_USER_ID,
  })
}

export const devSeedRoutes = new Hono<DevSeedEnv>()
  .use('*', requireDevSeed)
  .post('/', async (c) => {
    const summary: Array<Record<string, unknown>> = []
    for (const org of SEED_ORGS) {
      // Custom-domain → org pin (delivery rejects keys from other orgs on it).
      for (const domain of org.customDomains ?? []) {
        if (domain.status === 'active') {
          await c.env.ENVIRONMENT_API_KEYS.put(customDomainCacheKey(domain.hostname), org.id)
        }
      }
      for (const ws of org.workspaces) {
        const counts = await seedWorkspace(c.env, c.var.database, org, ws)
        summary.push({ org: org.slug, workspace: ws.slug, ...counts })
      }
    }
    return c.json({ ok: true, seeded: summary })
  })
