import { hashToken } from '@edgevault/auth'
import {
  type ApiKeyRecord,
  apiKeyCacheKey,
  configCacheKey,
  type ResolvedConfig,
} from '@edgevault/edge-protocol'
import { Hono } from 'hono'

/**
 * EdgeVault delivery worker — the <10ms edge read path. Serves pre-resolved
 * config/flag values written by the api worker to KV, fronted by a short-lived
 * in-memory L1 cache. Runs close to the user (no Smart Placement). It never
 * touches Neon or the DO on the hot path; the api write-through keeps KV warm.
 */

type AppEnv = { Bindings: Env; Variables: { apiKey: ApiKeyRecord } }

// Per-isolate L1 cache. KV is the source of truth; the short TTL self-heals.
const L1_TTL_MS = 15_000
const l1 = new Map<string, { value: ResolvedConfig | null; expires: number }>()

function l1Get(key: string): { value: ResolvedConfig | null } | undefined {
  const hit = l1.get(key)
  if (!hit) return undefined
  if (hit.expires < Date.now()) {
    l1.delete(key)
    return undefined
  }
  return hit
}

function l1Set(key: string, value: ResolvedConfig | null): void {
  l1.set(key, { value, expires: Date.now() + L1_TTL_MS })
}

const app = new Hono<AppEnv>()

app.get('/health', (c) =>
  c.json({ status: 'ok', service: c.env.SERVICE_NAME ?? 'edgevault-delivery' }),
)
app.get('/', (c) => c.json({ name: 'EdgeVault Delivery' }))

// API-key authentication: hash the presented key and look it up in KV.
app.use('/v1/*', async (c, next) => {
  const header = c.req.header('authorization')
  const presented = header?.toLowerCase().startsWith('bearer ')
    ? header.slice(7)
    : c.req.header('x-api-key')
  if (!presented) return c.json({ error: 'unauthorized' }, 401)

  const record = await c.env.ENVIRONMENT_API_KEYS.get<ApiKeyRecord>(
    apiKeyCacheKey(hashToken(presented)),
    'json',
  )
  if (!record) return c.json({ error: 'invalid_api_key' }, 401)
  c.set('apiKey', record)
  await next()
})

async function resolve(
  c: { env: Env; var: { apiKey: ApiKeyRecord } },
  key: string,
): Promise<{ value: ResolvedConfig | null; source: 'l1' | 'kv' }> {
  const { workspaceId, environmentId } = c.var.apiKey
  const cacheKey = configCacheKey(workspaceId, environmentId, key)

  const local = l1Get(cacheKey)
  if (local) return { value: local.value, source: 'l1' }

  const fromKv = await c.env.CONFIGS_CACHE.get<ResolvedConfig>(cacheKey, 'json')
  l1Set(cacheKey, fromKv) // cache hits and misses (short negative cache)
  return { value: fromKv, source: 'kv' }
}

app.get('/v1/configs/:key', async (c) => {
  const { value, source } = await resolve(c, c.req.param('key'))
  c.header('x-cache', source)
  if (!value) return c.json({ error: 'not_found' }, 404)
  return c.json({ key: c.req.param('key'), ...value })
})

app.get('/v1/flags/:key', async (c) => {
  const { value, source } = await resolve(c, c.req.param('key'))
  c.header('x-cache', source)
  if (value?.kind !== 'flag') return c.json({ error: 'not_found' }, 404)
  return c.json({ key: c.req.param('key'), ...value })
})

app.post('/v1/batch', async (c) => {
  const body = await c.req.json<{ keys?: string[] }>().catch(() => ({ keys: [] }))
  const keys = Array.isArray(body.keys) ? body.keys.slice(0, 100) : []
  const entries = await Promise.all(
    keys.map(async (key) => [key, (await resolve(c, key)).value] as const),
  )
  return c.json({ configs: Object.fromEntries(entries) })
})

export default app
