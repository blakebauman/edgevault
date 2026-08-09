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

/** A JWT-shaped token whose `exp` is `secondsFromNow` away. Unsigned — the
 * console checks shape and expiry, not the signature (the api verifies that). */
function jwt(secondsFromNow: number): string {
  const payload = btoa(
    JSON.stringify({ sub: 'u1', exp: Math.floor(Date.now() / 1000) + secondsFromNow }),
  )
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  return `header.${payload}.signature`
}

describe('getToken', () => {
  it('uses the cookied access token without calling auth', async () => {
    const { env, fetch } = authEnv(Response.json({ accessToken: 'minted' }))
    const live = jwt(600)

    const token = await getToken(req(`ev_console=${live}`), env)

    expect(token).toBe(live)
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

  /**
   * The console used to treat *cookie present* as *authenticated*, so a junk or
   * stale `ev_console` sailed past every `if (!token) throw redirect('/login')`
   * and rendered a page that could not work (observed live: a garbage cookie
   * got 200 on /share). Such a token must now fall through to the re-mint.
   */
  it.each([
    ['garbage that is not a JWT', 'garbage'],
    ['a JWT-shaped token with no exp claim', `header.${btoa('{"sub":"u1"}')}.sig`],
    ['a JWT with an undecodable payload', 'header.!!!not-base64!!!.sig'],
    ['an expired token', jwt(-60)],
    ['a token expiring within the skew window', jwt(5)],
  ])('does not trust %s — re-mints instead', async (_label, bad) => {
    const { env, fetch } = authEnv(Response.json({ accessToken: 'freshly-minted' }))

    const token = await getToken(req(`ev_console=${bad}; ev_sess=ev_session%3Dabc`), env)

    expect(token).toBe('freshly-minted')
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('redirects rather than renders when a bad token has no session behind it', async () => {
    const { env } = authEnv(Response.json({ accessToken: 'unused' }))

    // No ev_sess: nothing to re-mint from, so the caller's redirect must fire.
    expect(await getToken(req('ev_console=garbage'), env)).toBeNull()
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
