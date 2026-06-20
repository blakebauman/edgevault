import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { hashToken } from '@edgevault/auth'
import {
  apiKeyCacheKey,
  configCacheKey,
  customDomainCacheKey,
  pageCacheKey,
} from '@edgevault/edge-protocol'
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
  await env.CONFIGS_CACHE.put(
    pageCacheKey(WS, ENV, 'doc.home'),
    '<!doctype html><html><body><h1>Home</h1></body></html>',
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

describe('delivery pages', () => {
  it('serves a pre-rendered content page as HTML', async () => {
    const res = await call('/v1/pages/doc.home', auth)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toBe('<!doctype html><html><body><h1>Home</h1></body></html>')
  })

  it('serves the page again from the L1 cache', async () => {
    const res = await call('/v1/pages/doc.home', auth)
    expect(res.headers.get('x-cache')).toBe('l1')
  })

  it('404s an unknown page', async () => {
    expect((await call('/v1/pages/doc.missing', auth)).status).toBe(404)
  })

  it('requires an API key', async () => {
    expect((await call('/v1/pages/doc.home')).status).toBe(401)
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

describe('custom delivery domain pin', () => {
  const PINNED_KEY = 'evk_live_pinned-org-key'
  const OTHER_ORG_KEY = 'evk_live_other-org-key'

  beforeAll(async () => {
    await env.ENVIRONMENT_API_KEYS.put(
      apiKeyCacheKey(hashToken(PINNED_KEY)),
      JSON.stringify({
        workspaceId: WS,
        environmentId: ENV,
        organizationId: 'org-1',
        scopes: ['read'],
      }),
    )
    await env.ENVIRONMENT_API_KEYS.put(
      apiKeyCacheKey(hashToken(OTHER_ORG_KEY)),
      JSON.stringify({
        workspaceId: WS,
        environmentId: ENV,
        organizationId: 'org-2',
        scopes: ['read'],
      }),
    )
    await env.ENVIRONMENT_API_KEYS.put(customDomainCacheKey('config.acme.com'), 'org-1')
  })

  async function callHost(host: string, key: string) {
    const ctx = createExecutionContext()
    const res = await app.fetch(
      new Request(`https://${host}/v1/configs/feature.x`, {
        headers: { authorization: `Bearer ${key}` },
      }),
      env,
      ctx,
    )
    await waitOnExecutionContext(ctx)
    return res
  }

  it('serves the owning org on its custom domain', async () => {
    expect((await callHost('config.acme.com', PINNED_KEY)).status).toBe(200)
  })

  it("refuses another org's key on a pinned domain", async () => {
    const res = await callHost('config.acme.com', OTHER_ORG_KEY)
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: 'wrong_domain' })
  })

  it('fails closed for pre-orgId key records on a pinned domain', async () => {
    expect((await callHost('config.acme.com', API_KEY)).status).toBe(401)
  })

  it('ignores hosts without a pin (canonical/dev traffic)', async () => {
    expect((await callHost('edge.test', PINNED_KEY)).status).toBe(200)
  })
})
