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

// --- SSO transaction cookie -------------------------------------------------
// Holds the short-lived OIDC state/nonce/PKCE verifier between the start and
// callback legs. httpOnly + SameSite=Lax (the IdP redirect is a top-level GET),
// 10-minute lifetime, cleared on completion.

const SSO_COOKIE = 'ev_sso'

export interface SsoTransaction {
  orgId: string
  state: string
  nonce: string
  codeVerifier: string
}

export function setSsoCookie(tx: SsoTransaction, request: Request): string {
  const value = encodeURIComponent(JSON.stringify(tx))
  return `${SSO_COOKIE}=${value}; HttpOnly; Path=/; SameSite=Lax; Max-Age=600${secureAttr(request)}`
}

export function getSsoTransaction(request: Request): SsoTransaction | null {
  const match = (request.headers.get('Cookie') ?? '').match(/(?:^|;\s*)ev_sso=([^;]+)/)
  if (!match?.[1]) return null
  try {
    const tx = JSON.parse(decodeURIComponent(match[1])) as Partial<SsoTransaction>
    if (tx.orgId && tx.state && tx.nonce && tx.codeVerifier) return tx as SsoTransaction
  } catch {
    // malformed cookie — treat as no transaction
  }
  return null
}

export function clearSsoCookie(request: Request): string {
  return `${SSO_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secureAttr(request)}`
}
