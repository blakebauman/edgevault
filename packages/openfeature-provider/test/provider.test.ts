import type { Logger } from '@openfeature/server-sdk'
import { ErrorCode, StandardResolutionReasons } from '@openfeature/server-sdk'
import { describe, expect, it, vi } from 'vitest'
import { EdgeVaultProvider } from '../src/index'

const KEY = 'ek_test'
const ctx = {}
const logger: Logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }

/** Build a fake fetch from a route → Response factory map. */
function fakeFetch(routes: Record<string, () => Response>) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString()
    const path = new URL(url).pathname
    const make = routes[path]
    if (!make) return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 })
    return make()
  }) as unknown as typeof fetch
}

function record(
  key: string,
  content: string,
  contentType: string,
  kind: 'flag' | 'config',
): Response {
  return new Response(JSON.stringify({ key, content, contentType, kind, version: 3 }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

const provider = (routes: Record<string, () => Response>) =>
  new EdgeVaultProvider({ apiKey: KEY, fetch: fakeFetch(routes), cacheTtlMs: 0 })

describe('EdgeVaultProvider — booleans (flags route)', () => {
  it('resolves a truthy flag as STATIC with version metadata', async () => {
    const p = provider({ '/v1/flags/f': () => record('f', 'true', 'text/plain', 'flag') })
    const res = await p.resolveBooleanEvaluation('f', false, ctx, logger)
    expect(res).toMatchObject({
      value: true,
      reason: StandardResolutionReasons.STATIC,
      flagMetadata: { version: 3, edgevaultKind: 'flag' },
    })
  })

  it('recognises {"enabled":true} object flags', async () => {
    const p = provider({
      '/v1/flags/f': () => record('f', '{"enabled":true}', 'application/json', 'flag'),
    })
    expect((await p.resolveBooleanEvaluation('f', false, ctx, logger)).value).toBe(true)
  })

  it('returns the default with FLAG_NOT_FOUND when absent', async () => {
    const p = provider({})
    const res = await p.resolveBooleanEvaluation('missing', true, ctx, logger)
    expect(res).toMatchObject({
      value: true,
      reason: StandardResolutionReasons.ERROR,
      errorCode: ErrorCode.FLAG_NOT_FOUND,
    })
  })

  it('returns TYPE_MISMATCH for unrecognised boolean content', async () => {
    const p = provider({ '/v1/flags/f': () => record('f', 'maybe', 'text/plain', 'flag') })
    const res = await p.resolveBooleanEvaluation('f', false, ctx, logger)
    expect(res).toMatchObject({ value: false, errorCode: ErrorCode.TYPE_MISMATCH })
  })

  it('reads booleans from the flags route, not configs', async () => {
    const f = fakeFetch({ '/v1/flags/f': () => record('f', 'on', 'text/plain', 'flag') })
    const p = new EdgeVaultProvider({ apiKey: KEY, fetch: f, cacheTtlMs: 0 })
    await p.resolveBooleanEvaluation('f', false, ctx, logger)
    const [url] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(new URL(url as string).pathname).toBe('/v1/flags/f')
  })
})

describe('EdgeVaultProvider — strings & numbers (configs route)', () => {
  it('returns a raw string and unwraps a JSON string', async () => {
    const p = provider({
      '/v1/configs/raw': () => record('raw', 'hello', 'text/plain', 'config'),
      '/v1/configs/json': () => record('json', '"hi"', 'application/json', 'config'),
    })
    expect((await p.resolveStringEvaluation('raw', '', ctx, logger)).value).toBe('hello')
    expect((await p.resolveStringEvaluation('json', '', ctx, logger)).value).toBe('hi')
  })

  it('parses numbers from plain and JSON content', async () => {
    const p = provider({
      '/v1/configs/plain': () => record('plain', '42', 'text/plain', 'config'),
      '/v1/configs/json': () => record('json', '7.5', 'application/json', 'config'),
    })
    expect((await p.resolveNumberEvaluation('plain', 0, ctx, logger)).value).toBe(42)
    expect((await p.resolveNumberEvaluation('json', 0, ctx, logger)).value).toBe(7.5)
  })

  it('returns TYPE_MISMATCH for a non-numeric value', async () => {
    const p = provider({ '/v1/configs/n': () => record('n', 'nope', 'text/plain', 'config') })
    const res = await p.resolveNumberEvaluation('n', -1, ctx, logger)
    expect(res).toMatchObject({ value: -1, errorCode: ErrorCode.TYPE_MISMATCH })
  })
})

describe('EdgeVaultProvider — objects (configs route)', () => {
  it('parses JSON objects and arrays', async () => {
    const p = provider({
      '/v1/configs/obj': () => record('obj', '{"a":1}', 'application/json', 'config'),
    })
    const res = await p.resolveObjectEvaluation('obj', {}, ctx, logger)
    expect(res).toMatchObject({ value: { a: 1 }, reason: StandardResolutionReasons.STATIC })
  })

  it('returns TYPE_MISMATCH for malformed JSON', async () => {
    const p = provider({
      '/v1/configs/obj': () => record('obj', '{not json', 'application/json', 'config'),
    })
    const res = await p.resolveObjectEvaluation('obj', { fallback: true }, ctx, logger)
    expect(res).toMatchObject({ value: { fallback: true }, errorCode: ErrorCode.TYPE_MISMATCH })
  })
})

describe('EdgeVaultProvider — transport errors', () => {
  it('maps a 401 to GENERAL and returns the default', async () => {
    const f = fakeFetch({ '/v1/flags/f': () => new Response('{}', { status: 401 }) })
    const p = new EdgeVaultProvider({ apiKey: KEY, fetch: f, cacheTtlMs: 0 })
    const res = await p.resolveBooleanEvaluation('f', false, ctx, logger)
    expect(res).toMatchObject({
      value: false,
      reason: StandardResolutionReasons.ERROR,
      errorCode: ErrorCode.GENERAL,
    })
    expect(logger.error).toHaveBeenCalled()
  })

  it('exposes its metadata and server paradigm', () => {
    const p = provider({})
    expect(p.metadata.name).toBe('edgevault-provider')
    expect(p.runsOn).toBe('server')
  })
})
