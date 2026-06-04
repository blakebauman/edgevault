/** Console session: stores the EdgeVault access token in an httpOnly cookie. */

const COOKIE = 'ev_console'

export function setTokenCookie(token: string): string {
  // Token TTL is ~15m; the cookie matches so the UI re-auths when it expires.
  return `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=900`
}

export function clearTokenCookie(): string {
  return `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`
}

export function getToken(request: Request): string | null {
  const match = (request.headers.get('Cookie') ?? '').match(/(?:^|;\s*)ev_console=([^;]+)/)
  return match?.[1] ? decodeURIComponent(match[1]) : null
}
