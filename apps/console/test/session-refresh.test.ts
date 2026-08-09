import { describe, expect, it, vi } from 'vitest'
import {
  clearTokenCookie,
  getAuthSessionCookie,
  getToken,
  setAuthSessionCookie,
} from '../app/lib/session.server'

/**
 * The console used to hold only the ~15m access token, so when it expired the
 * user was signed out with nothing to re-auth from — a hard sign-out every 15
 * minutes. It now also holds the auth worker's session cookie (30-day TTL) and
 * re-mints the access token from it on demand, which is what auth's `/token`
 * endpoint exists for.
 */

/**
 * `Cookie` is a forbidden header name, so a real `Request` silently drops it in
 * a browser-like env — hence a minimal stand-in that just answers header reads.
 */
function req(cookie?: string): Request {
  return {
    url: 'https://console.test/dashboard',
    headers: {
      get: (name: string) => (name.toLowerCase() === 'cookie' ? (cookie ?? null) : null),
    },
  } as unknown as Request
}

/** Stub AUTH_SERVICE binding; records calls so we can assert we didn't re-mint. */
function authEnv(response: Response | Error) {
  const fetch = vi.fn(async () => {
    if (response instanceof Error) throw response
    return response.clone()
  })
  return { env: { AUTH_SERVICE: { fetch } } as unknown as Env, fetch }
}

describe('getToken', () => {
  it('uses the cookied access token without calling auth', async () => {
    const { env, fetch } = authEnv(Response.json({ accessToken: 'minted' }))

    const token = await getToken(req('ev_console=cookied'), env)

    expect(token).toBe('cookied')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('re-mints from the session cookie when the access token has expired', async () => {
    const { env, fetch } = authEnv(Response.json({ accessToken: 'freshly-minted' }))

    const token = await getToken(req('ev_sess=ev_session%3Dabc123'), env)

    expect(token).toBe('freshly-minted')
    expect(fetch).toHaveBeenCalledOnce()
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://auth/token')
    expect(init.method).toBe('POST')
    // The stored auth session cookie is what authenticates the re-mint.
    expect((init.headers as Record<string, string>).cookie).toBe('ev_session=abc123')
  })

  it('returns null when there is no session at all', async () => {
    const { env, fetch } = authEnv(Response.json({ accessToken: 'nope' }))

    expect(await getToken(req(), env)).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('returns null when the session is no longer valid', async () => {
    const { env } = authEnv(Response.json({ error: 'no_session' }, { status: 401 }))

    expect(await getToken(req('ev_sess=ev_session%3Dstale'), env)).toBeNull()
  })

  it('treats an unreachable auth service as unauthenticated rather than throwing', async () => {
    const { env } = authEnv(new Error('service binding down'))

    await expect(getToken(req('ev_sess=ev_session%3Dabc'), env)).resolves.toBeNull()
  })
})

describe('session cookies', () => {
  it('round-trips the auth session cookie', () => {
    const header = setAuthSessionCookie('ev_session=abc123', req())
    const value = header.split(';')[0]?.split('=').slice(1).join('=') ?? ''

    expect(getAuthSessionCookie(req(`ev_sess=${value}`))).toBe('ev_session=abc123')
  })

  it('marks the session cookie httpOnly and long-lived', () => {
    const header = setAuthSessionCookie('ev_session=abc123', req())

    expect(header).toContain('HttpOnly')
    expect(header).toContain('SameSite=Lax')
    expect(header).toContain('Secure') // request is https
    expect(header).toContain(`Max-Age=${30 * 24 * 60 * 60}`)
  })

  it('clears BOTH cookies on sign-out', () => {
    const headers = clearTokenCookie(req())

    // Clearing only the access token would leave a live session cookie that
    // silently mints a new token on the very next request.
    expect(headers).toHaveLength(2)
    expect(headers.some((h) => h.startsWith('ev_console=;'))).toBe(true)
    expect(headers.some((h) => h.startsWith('ev_sess=;'))).toBe(true)
    for (const h of headers) expect(h).toContain('Max-Age=0')
  })
})
