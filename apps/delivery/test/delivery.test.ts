import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { hashToken } from '@edgevault/auth'
import { apiKeyCacheKey, configCacheKey } from '@edgevault/edge-protocol'
import { beforeAll, describe, expect, it } from 'vitest'
import app from '../src/index'

const API_KEY = 'evk_live_unit-test-key'
const WS = 'ws-1'
const ENV = 'env-1'

beforeAll(async () => {
  await env.ENVIRONMENT_API_KEYS.put(
    apiKeyCacheKey(hashToken(API_KEY)),
    JSON.stringify({ workspaceId: WS, environmentId: ENV, scopes: ['read'] }),
  )
  await env.CONFIGS_CACHE.put(
    configCacheKey(WS, ENV, 'feature.x'),
    JSON.stringify({ content: '{"on":true}', contentType: 'json', kind: 'flag', version: 3 }),
  )
})

async function call(path: string, headers: Record<string, string> = {}) {
  const ctx = createExecutionContext()
  const res = await app.fetch(new Request(`https://edge.test${path}`, { headers }), env, ctx)
  await waitOnExecutionContext(ctx)
  return res
}

const auth = { authorization: `Bearer ${API_KEY}` }

describe('delivery auth', () => {
  it('401s without an API key', async () => {
    expect((await call('/v1/configs/feature.x')).status).toBe(401)
  })

  it('sets baseline security headers on every response', async () => {
    const res = await call('/health')
    expect(res.headers.get('Content-Security-Policy')).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    )
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(res.headers.get('Strict-Transport-Security')).toBe('max-age=31536000; includeSubDomains')
  })
  it('401s with an unknown API key', async () => {
    expect((await call('/v1/configs/feature.x', { authorization: 'Bearer nope' })).status).toBe(401)
  })
})

describe('delivery reads', () => {
  it('serves a cached config for a valid key', async () => {
    const res = await call('/v1/configs/feature.x', auth)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ key: 'feature.x', content: '{"on":true}', version: 3 })
  })

  it('serves it again from the L1 cache', async () => {
    const res = await call('/v1/configs/feature.x', auth)
    expect(res.headers.get('x-cache')).toBe('l1')
  })

  it('reports the resolve time via Server-Timing (the <10ms target metric)', async () => {
    const res = await call('/v1/configs/feature.x', auth)
    expect(res.headers.get('server-timing')).toMatch(/^resolve;dur=\d+;desc="(l1|kv)"$/)
  })

  it('serves flags via the flag route', async () => {
    const res = await call('/v1/flags/feature.x', auth)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ kind: 'flag' })
  })

  it('404s for an unknown key', async () => {
    expect((await call('/v1/configs/missing', auth)).status).toBe(404)
  })
})

describe('delivery export', () => {
  it('returns every config in the key environment, scoped to that environment', async () => {
    await env.CONFIGS_CACHE.put(
      configCacheKey(WS, ENV, 'app.url'),
      JSON.stringify({ content: 'https://x', contentType: 'text', kind: 'config', version: 1 }),
    )
    // A different environment must never leak into the export.
    await env.CONFIGS_CACHE.put(
      configCacheKey(WS, 'env-other', 'other.key'),
      JSON.stringify({ content: 'nope', contentType: 'text', kind: 'config', version: 1 }),
    )

    const res = await call('/v1/export', auth)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      environmentId: string
      configs: Record<string, { content: string }>
    }
    expect(body.environmentId).toBe(ENV)
    expect(Object.keys(body.configs).sort()).toEqual(['app.url', 'feature.x'])
    expect(body.configs['app.url']?.content).toBe('https://x')
  })

  it('requires an API key', async () => {
    expect((await call('/v1/export')).status).toBe(401)
  })
})
