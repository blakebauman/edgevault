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

/**
 * Validate a post-login redirect target: same-origin relative paths only
 * (`/...` but not `//host`), so `?next=` can never become an open redirect.
 */
export function safeRelativePath(value: string | null | undefined): string | null {
  return value && /^\/(?!\/)/.test(value) ? value : null
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
  /** Post-sign-in destination (relative path), carried from ?next=. */
  next?: string
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
    if (tx.orgId && tx.state && tx.nonce && tx.codeVerifier) {
      return { ...tx, next: safeRelativePath(tx.next) ?? undefined } as SsoTransaction
    }
  } catch {
    // malformed cookie — treat as no transaction
  }
  return null
}

export function clearSsoCookie(request: Request): string {
  return `${SSO_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secureAttr(request)}`
}

// --- SAML transaction cookie ------------------------------------------------
// Holds the AuthnRequest id between start and the ACS POST. The IdP POSTs the
// response cross-site, so on https we need SameSite=None; Secure for the cookie
// to be sent; on plain-http dev we fall back to Lax (InResponseTo is then simply
// not checked — the response is still verified by signature + conditions).

const SAML_COOKIE = 'ev_saml'

function samlSameSite(request: Request): string {
  return new URL(request.url).protocol === 'https:' ? '; SameSite=None; Secure' : '; SameSite=Lax'
}

export function setSamlCookie(orgId: string, authnId: string, request: Request): string {
  const value = encodeURIComponent(JSON.stringify({ orgId, authnId }))
  return `${SAML_COOKIE}=${value}; HttpOnly; Path=/; Max-Age=600${samlSameSite(request)}`
}

export function getSamlTransaction(request: Request): { orgId: string; authnId: string } | null {
  const match = (request.headers.get('Cookie') ?? '').match(/(?:^|;\s*)ev_saml=([^;]+)/)
  if (!match?.[1]) return null
  try {
    const tx = JSON.parse(decodeURIComponent(match[1])) as { orgId?: string; authnId?: string }
    if (tx.orgId && tx.authnId) return { orgId: tx.orgId, authnId: tx.authnId }
  } catch {
    // malformed — ignore
  }
  return null
}

export function clearSamlCookie(request: Request): string {
  return `${SAML_COOKIE}=; HttpOnly; Path=/; Max-Age=0${samlSameSite(request)}`
}

// --- MFA challenge cookie ---------------------------------------------------
// Holds the short-lived MFA challenge token between password sign-in and the
// second-factor prompt. httpOnly so client JS can't read it.

const MFA_COOKIE = 'ev_mfa'

export function setMfaCookie(token: string, request: Request): string {
  return `${MFA_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=300${secureAttr(request)}`
}

export function getMfaToken(request: Request): string | null {
  const match = (request.headers.get('Cookie') ?? '').match(/(?:^|;\s*)ev_mfa=([^;]+)/)
  return match?.[1] ? decodeURIComponent(match[1]) : null
}

export function clearMfaCookie(request: Request): string {
  return `${MFA_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secureAttr(request)}`
}

// --- WebAuthn challenge cookie ----------------------------------------------
// Holds the per-ceremony WebAuthn challenge between options-generation and
// verification. httpOnly + short-lived; the whole ceremony is same-origin.

const WEBAUTHN_COOKIE = 'ev_wa'

export function setWebauthnCookie(challenge: string, request: Request): string {
  return `${WEBAUTHN_COOKIE}=${encodeURIComponent(challenge)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=300${secureAttr(request)}`
}

export function getWebauthnChallenge(request: Request): string | null {
  const match = (request.headers.get('Cookie') ?? '').match(/(?:^|;\s*)ev_wa=([^;]+)/)
  return match?.[1] ? decodeURIComponent(match[1]) : null
}

export function clearWebauthnCookie(request: Request): string {
  return `${WEBAUTHN_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secureAttr(request)}`
}

// --- Step-up reveal token cookie --------------------------------------------
// Holds the short-lived reveal token minted by auth's /reauth after a fresh
// second factor. httpOnly so the browser can't read it; forwarded server-side
// as x-reveal-token on the reveal call. 5-minute lifetime matches the token.

const REVEAL_COOKIE = 'ev_reveal'

export function setRevealCookie(token: string, request: Request): string {
  return `${REVEAL_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=300${secureAttr(request)}`
}

export function getRevealToken(request: Request): string | null {
  const match = (request.headers.get('Cookie') ?? '').match(/(?:^|;\s*)ev_reveal=([^;]+)/)
  return match?.[1] ? decodeURIComponent(match[1]) : null
}

// --- Social OAuth transaction cookie ----------------------------------------
// Holds the state + PKCE verifier between the OAuth start and provider callback.

const OAUTH_COOKIE = 'ev_oauth'

export interface OAuthTransaction {
  provider: string
  state: string
  codeVerifier?: string
  /** Post-sign-in destination (relative path), carried from ?next=. */
  next?: string
}

export function setOAuthCookie(tx: OAuthTransaction, request: Request): string {
  const value = encodeURIComponent(JSON.stringify(tx))
  return `${OAUTH_COOKIE}=${value}; HttpOnly; Path=/; SameSite=Lax; Max-Age=600${secureAttr(request)}`
}

export function getOAuthTransaction(request: Request): OAuthTransaction | null {
  const match = (request.headers.get('Cookie') ?? '').match(/(?:^|;\s*)ev_oauth=([^;]+)/)
  if (!match?.[1]) return null
  try {
    const tx = JSON.parse(decodeURIComponent(match[1])) as Partial<OAuthTransaction>
    if (tx.provider && tx.state) {
      return { ...tx, next: safeRelativePath(tx.next) ?? undefined } as OAuthTransaction
    }
  } catch {
    // malformed — ignore
  }
  return null
}

export function clearOAuthCookie(request: Request): string {
  return `${OAUTH_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secureAttr(request)}`
}
