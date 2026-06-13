import { describe, expect, it, vi } from 'vitest'
import { EdgeVault, EdgeVaultAuthError, EdgeVaultError } from '../src/index'

const KEY = 'ek_test'

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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const config = (key: string, content: string, contentType = 'application/json', kind = 'config') =>
  json({ key, content, contentType, kind, version: 1 })

describe('EdgeVault client', () => {
  it('requires an apiKey', () => {
    // @ts-expect-error intentionally missing apiKey
    expect(() => new EdgeVault({})).toThrow(EdgeVaultError)
  })

  it('strips a trailing slash from baseUrl and sends the bearer token', async () => {
    const f = fakeFetch({ '/v1/configs/k': () => config('k', '"v"') })
    const ev = new EdgeVault({ apiKey: KEY, baseUrl: 'https://delivery.example.com/', fetch: f })
    await ev.config('k')
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe('https://delivery.example.com/v1/configs/k')
    expect((init as RequestInit).headers).toMatchObject({ authorization: `Bearer ${KEY}` })
  })

  it('returns a record for a hit and null for a 404', async () => {
    const ev = new EdgeVault({
      apiKey: KEY,
      fetch: fakeFetch({ '/v1/configs/present': () => config('present', '"x"') }),
    })
    expect(await ev.config('present')).toMatchObject({ key: 'present', version: 1 })
    expect(await ev.config('absent')).toBeNull()
  })

  it('throws EdgeVaultAuthError on 401', async () => {
    const ev = new EdgeVault({
      apiKey: KEY,
      fetch: fakeFetch({ '/v1/configs/k': () => json({ error: 'invalid_api_key' }, 401) }),
    })
    await expect(ev.config('k')).rejects.toBeInstanceOf(EdgeVaultAuthError)
  })

  it('parses JSON values and returns raw strings otherwise', async () => {
    const ev = new EdgeVault({
      apiKey: KEY,
      fetch: fakeFetch({
        '/v1/configs/obj': () => config('obj', '{"a":1}', 'application/json'),
        '/v1/configs/str': () => config('str', 'hello', 'text/plain'),
      }),
    })
    expect(await ev.value<{ a: number }>('obj')).toEqual({ a: 1 })
    expect(await ev.value('str')).toBe('hello')
  })

  it('coerces flag values to booleans with a fallback', async () => {
    const routes: Record<string, () => Response> = {
      '/v1/flags/on': () => config('on', 'true', 'application/json', 'flag'),
      '/v1/flags/off': () => config('off', '0', 'text/plain', 'flag'),
      '/v1/flags/enabled': () => config('enabled', '{"enabled":true}', 'application/json', 'flag'),
      '/v1/flags/weird': () => config('weird', 'maybe', 'text/plain', 'flag'),
    }
    const ev = new EdgeVault({ apiKey: KEY, fetch: fakeFetch(routes) })
    expect(await ev.flag('on')).toBe(true)
    expect(await ev.flag('off')).toBe(false)
    expect(await ev.flag('enabled')).toBe(true)
    expect(await ev.flag('weird', true)).toBe(true) // unrecognised → fallback
    expect(await ev.flag('missing', true)).toBe(true) // 404 → fallback
    expect(await ev.flag('missing')).toBe(false)
  })

  it('batches keys and attaches the key, null for misses', async () => {
    const ev = new EdgeVault({
      apiKey: KEY,
      fetch: fakeFetch({
        '/v1/batch': () =>
          json({
            configs: {
              a: { content: '1', contentType: 'application/json', kind: 'config', version: 2 },
              b: null,
            },
          }),
      }),
    })
    const out = await ev.batch(['a', 'b'])
    expect(out.a).toMatchObject({ key: 'a', version: 2 })
    expect(out.b).toBeNull()
    expect(await ev.batch([])).toEqual({})
  })

  it('caches reads within the TTL and clearCache resets', async () => {
    const f = fakeFetch({ '/v1/configs/k': () => config('k', '"v"') })
    const ev = new EdgeVault({ apiKey: KEY, fetch: f })
    await ev.config('k')
    await ev.config('k')
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
    ev.clearCache()
    await ev.config('k')
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2)
  })

  it('does not cache when cacheTtlMs is 0', async () => {
    const f = fakeFetch({ '/v1/configs/k': () => config('k', '"v"') })
    const ev = new EdgeVault({ apiKey: KEY, cacheTtlMs: 0, fetch: f })
    await ev.config('k')
    await ev.config('k')
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2)
  })

  it('maps a timeout to an EdgeVaultError', async () => {
    const f = vi.fn(async (_input: unknown, init?: RequestInit) => {
      // Reject as the platform does when the AbortController fires.
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const e = new Error('aborted')
          e.name = 'AbortError'
          reject(e)
        })
      })
    }) as unknown as typeof fetch
    const ev = new EdgeVault({ apiKey: KEY, timeoutMs: 5, fetch: f })
    await expect(ev.config('k')).rejects.toMatchObject({ code: 'timeout' })
  })
})
