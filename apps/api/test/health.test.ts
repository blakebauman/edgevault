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
