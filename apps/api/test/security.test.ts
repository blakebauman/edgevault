import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { hashToken } from '@edgevault/auth'
import { apiKeyCacheKey, CONFIG_KEY_PATTERN } from '@edgevault/edge-protocol'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { configChangeEvent, promoteEvent, revealEvent } from '../src/audit'
import app from '../src/index'
import { enforceRateLimit, rateLimitByIp } from '../src/rate-limit'
import { isPublicWebhookUrl } from '../src/routes/workspaces'

/** Hardening units: SSRF guard, key pattern, audit builders, rate limits, onError. */

function limiter(success: boolean): RateLimit {
  return { limit: async () => ({ success }) } as unknown as RateLimit
}

async function appCall(path: string, init: RequestInit = {}, bindings: object = env) {
  const ctx = createExecutionContext()
  const res = await app.fetch(new Request(`https://api.test${path}`, init), bindings, ctx)
  await waitOnExecutionContext(ctx)
  return res
}

describe('webhook URL SSRF guard', () => {
  it.each([
    'https://hooks.slack.com/services/T0/B0/x',
    'https://example.com/webhook',
  ])('accepts public https URL %s', (url) => {
    expect(isPublicWebhookUrl(url)).toBe(true)
  })

  it.each([
    'http://example.com/webhook', // not https
    'https://localhost/x',
    'https://sub.localhost/x',
    'https://127.0.0.1/x',
    'https://10.0.0.1/x',
    'https://[::1]/x',
    'https://metadata.internal/x',
    'https://printer.local/x',
    'https://intranet/x', // dotless host
    'not a url',
  ])('rejects %s', (url) => {
    expect(isPublicWebhookUrl(url)).toBe(false)
  })
})

describe('config key pattern', () => {
  it('accepts ref-safe keys and rejects cache-key-unsafe ones', () => {
    for (const key of ['DB_PASSWORD', 'feature.flag-1', 'a_b.c']) {
      expect(CONFIG_KEY_PATTERN.test(key)).toBe(true)
    }
    for (const key of ['db:pw', 'a b', 'a/b', '${X}', 'k*', '']) {
      expect(CONFIG_KEY_PATTERN.test(key)).toBe(false)
    }
  })
})

describe('audit event builders', () => {
  it('configChangeEvent keys created/updated on first revision', () => {
    const base = { workspaceId: 'w', environmentId: 'e', kind: 'flag', key: 'k', userId: 'u' }
    expect(configChangeEvent({ ...base, version: 1 }).action).toBe('config.created')
    expect(configChangeEvent({ ...base, version: 2 }).action).toBe('config.updated')
    expect(configChangeEvent({ ...base, version: 1 }).resourceType).toBe('flag')
  })

  it('promoteEvent defaults resourceType and targets the destination env', () => {
    const event = promoteEvent({
      workspaceId: 'w',
      targetEnvironmentId: 't',
      key: 'k',
      userId: 'u',
    })
    expect(event).toMatchObject({
      action: 'config.promoted',
      environmentId: 't',
      resourceType: 'config',
    })
  })

  it('revealEvent records who decrypted what, where', () => {
    expect(
      revealEvent({ workspaceId: 'w', environmentId: 'e', kind: 'secret', key: 'k', userId: 'u' }),
    ).toMatchObject({ action: 'secret.revealed', resourceType: 'secret', userId: 'u' })
  })

  it('revealEvent records whether a fresh step-up backed the reveal', () => {
    expect(
      revealEvent({
        workspaceId: 'w',
        environmentId: 'e',
        kind: 'secret',
        key: 'k',
        userId: 'u',
        stepUp: true,
      }),
    ).toMatchObject({ action: 'secret.revealed', stepUp: true })
  })
})

describe('rate limiting', () => {
  function miniApp(picked: RateLimit | undefined) {
    return new Hono<{ Bindings: Env }>()
      .use(
        '*',
        rateLimitByIp(() => picked, 'test'),
      )
      .get('/', (c) => c.json({ ok: true }))
  }

  it('returns 429 with Retry-After when the limiter blocks', async () => {
    const res = await miniApp(limiter(false)).request('/', {}, env)
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('60')
    expect(((await res.json()) as { error: string }).error).toBe('rate_limited')
  })

  it('passes when the limiter allows, and fails open when absent', async () => {
    expect((await miniApp(limiter(true)).request('/', {}, env)).status).toBe(200)
    expect((await miniApp(undefined).request('/', {}, env)).status).toBe(200)
  })

  it('enforceRateLimit returns null when allowed, 429 Response when blocked', async () => {
    const blockedApp = new Hono<{ Bindings: Env }>().get('/', async (c) => {
      const blocked = await enforceRateLimit(c, limiter(false), 'ai:u1')
      return blocked ?? c.json({ ok: true })
    })
    expect((await blockedApp.request('/', {}, env)).status).toBe(429)
  })

  it('caps the machine surface before the API-key lookup', async () => {
    const res = await appCall(
      '/machine/v1/export',
      {},
      { ...env, MACHINE_IP_LIMITER: limiter(false) },
    )
    expect(res.status).toBe(429)
  })
})

describe('app error hygiene', () => {
  it('unknown routes return structured JSON not_found', async () => {
    const res = await appCall('/definitely/not/a/route')
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: string }).error).toBe('not_found')
  })

  it('unhandled errors return a generic body with no internals', async () => {
    // A corrupted KV api-key record makes the machine auth middleware throw.
    const key = 'evk_live_corrupt'
    await env.ENVIRONMENT_API_KEYS.put(apiKeyCacheKey(hashToken(key)), 'not-json{')
    const res = await appCall('/machine/v1/export', { headers: { authorization: `Bearer ${key}` } })
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: string }
    expect(body).toEqual({ error: 'internal_error' })
  })
})
