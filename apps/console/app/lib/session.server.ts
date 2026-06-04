/** Console session: stores the EdgeVault access token in an httpOnly cookie. */

const COOKIE = 'ev_console'

// Mark the cookie Secure whenever we're served over https (production); omit it
// on plain-http dev so the cookie still sets locally. Mirrors apps/auth/cookies.
function secureAttr(request: Request): string {
  return new URL(request.url).protocol === 'https:' ? '; Secure' : ''
}

export function setTokenCookie(token: string, request: Request): string {
  // Token TTL is ~15m; the cookie matches so the UI re-auths when it expires.
  return `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=900${secureAttr(request)}`
}

export function clearTokenCookie(request: Request): string {
  return `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secureAttr(request)}`
}

export function getToken(request: Request): string | null {
  const match = (request.headers.get('Cookie') ?? '').match(/(?:^|;\s*)ev_console=([^;]+)/)
  return match?.[1] ? decodeURIComponent(match[1]) : null
}
