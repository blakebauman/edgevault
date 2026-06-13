import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import app from '../src/index'

describe('GET /health', () => {
  it('returns ok with service + environment', async () => {
    const ctx = createExecutionContext()
    const res = await app.fetch(new Request('https://api.test/health'), env, ctx)
    await waitOnExecutionContext(ctx)

    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string; service: string }
    expect(body.status).toBe('ok')
    expect(body.service).toBe('edgevault-api')
  })

  it('sets baseline security headers on every response', async () => {
    const ctx = createExecutionContext()
    const res = await app.fetch(new Request('https://api.test/health'), env, ctx)
    await waitOnExecutionContext(ctx)

    expect(res.headers.get('Content-Security-Policy')).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    )
    expect(res.headers.get('Strict-Transport-Security')).toBe('max-age=31536000; includeSubDomains')
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(res.headers.get('X-Frame-Options')).toBe('DENY')
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer')
  })
})

describe('GET /openapi.json', () => {
  it('serves an OpenAPI 3.1 document', async () => {
    const ctx = createExecutionContext()
    const res = await app.fetch(new Request('https://api.test/openapi.json'), env, ctx)
    await waitOnExecutionContext(ctx)

    expect(res.status).toBe(200)
    const doc = (await res.json()) as { openapi: string }
    expect(doc.openapi).toBe('3.1.0')
  })
})
