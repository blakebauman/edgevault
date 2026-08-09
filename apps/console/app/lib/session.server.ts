/**
 * Console session. Two httpOnly cookies, and the split matters:
 *
 *  - `ev_console` — the short-lived (~15m) access token the api/delivery verify
 *    statelessly against the JWKS. Cheap to hold, cheap to lose.
 *  - `ev_sess`    — the auth worker's own session cookie, the durable
 *    credential. Auth sessions live 30 days (`SESSION_TTL_MS`) and `POST /token`
 *    is designed to be called against one repeatedly.
 *
 * The console used to keep only the first, so when the access token expired the
 * user was hard signed out after 15 minutes with nothing to re-auth from — the
 * "the UI re-auths when it expires" note below was aspirational; nothing did.
 * Holding the session cookie lets `getToken` mint a fresh access token on
 * demand, which is what auth's `/token` exists for.
 *
 * Both are httpOnly + SameSite=Lax + Secure-on-https, and `ev_sess` is only
 * ever sent server-side to the auth service binding — it never reaches the api,
 * the browser's JS, or any cross-site request. Sign-out clears both, and the
 * underlying session stays revocable server-side.
 */

import { redirect } from 'react-router'

const COOKIE = 'ev_console'
const SESSION_COOKIE = 'ev_sess'

/** Matches auth's SESSION_TTL_MS (30 days) so the cookie dies with the session. */
const SESSION_MAX_AGE = 30 * 24 * 60 * 60

// Mark the cookie Secure whenever we're served over https (production); omit it
// on plain-http dev so the cookie still sets locally. Mirrors apps/auth/cookies.
function secureAttr(request: Request): string {
  return new URL(request.url).protocol === 'https:' ? '; Secure' : ''
}

export function setTokenCookie(token: string, request: Request): string {
  // Matches the token's own ~15m TTL. Expiry is no longer a sign-out: when this
  // is gone, `getToken` mints a fresh one from `ev_sess`.
  return `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=900${secureAttr(request)}`
}

/**
 * Persist the auth worker's session cookie (the `name=value` pair off its
 * Set-Cookie) so the console can re-mint access tokens for the life of the
 * session. Every sign-in path must set this alongside `setTokenCookie`.
 */
export function setAuthSessionCookie(sessionCookie: string, request: Request): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(sessionCookie)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}${secureAttr(request)}`
}

export function getAuthSessionCookie(request: Request): string | null {
  const match = (request.headers.get('Cookie') ?? '').match(/(?:^|;\s*)ev_sess=([^;]+)/)
  return match?.[1] ? decodeURIComponent(match[1]) : null
}

/** Sign-out must drop both — clearing only the access token would leave a live
 * session cookie that silently mints a new token on the next request. */
export function clearTokenCookie(request: Request): string[] {
  const attrs = `HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secureAttr(request)}`
  return [`${COOKIE}=; ${attrs}`, `${SESSION_COOKIE}=; ${attrs}`]
}

function readAccessCookie(request: Request): string | null {
  const match = (request.headers.get('Cookie') ?? '').match(/(?:^|;\s*)ev_console=([^;]+)/)
  return match?.[1] ? decodeURIComponent(match[1]) : null
}

/**
 * Is this access token structurally a JWT that hasn't expired?
 *
 * Deliberately *not* a signature check. Authorization is enforced at the api,
 * which verifies every token against auth's JWKS — the console is a BFF whose
 * only decision here is "render, or send them to sign in", and a forged token
 * buys nothing but an empty page shell that 401s on its first api call. Pulling
 * `jose` + JWKS fetching into the console to re-litigate that would be cost
 * without a threat.
 *
 * What it does buy: the console stops treating *cookie present* as *usable*.
 * Before this, a junk or stale `ev_console` sailed past every
 * `if (!token) throw redirect('/login')` and rendered a page that could not
 * work. Now such a token falls through to the re-mint path, which either
 * produces a real one from `ev_sess` or reports no session at all.
 *
 * The 30s skew allowance keeps a token that is about to lapse from being
 * discarded mid-request.
 */
function looksUsable(token: string): boolean {
  const payload = token.split('.')[1]
  if (!payload) return false
  try {
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
    const { exp } = JSON.parse(json) as { exp?: unknown }
    if (typeof exp !== 'number') return false
    return exp * 1000 > Date.now() + 30_000
  } catch {
    return false
  }
}

/**
 * The console's access token for this request.
 *
 * Returns the cookied token when it's still usable, and otherwise mints a fresh
 * one from the stored auth session — so a 15-minute token expiry is invisible
 * rather than a sign-out. The re-mint is a service-binding call to auth (same
 * colo, and auth caches session validation), and the result is deliberately not
 * written back to a cookie: loaders can't set headers without every call site
 * threading them, and re-minting once per request after the token lapses is
 * cheaper than that plumbing.
 *
 * "Usable" is checked, not assumed — see `looksUsable`. A junk or stale
 * `ev_console` used to satisfy every `if (!token) throw redirect('/login')` and
 * render a page that could not work; it now falls through to the re-mint, which
 * is also what rescues a token that outlived its cookie (clock skew, or a client
 * that kept the cookie past Max-Age).
 *
 * Returns null only when there is genuinely no session — the callers' existing
 * `if (!token) throw redirect('/login')` then means what it says.
 */
export async function getToken(request: Request, env: Env): Promise<string | null> {
  const cookied = readAccessCookie(request)
  if (cookied && looksUsable(cookied)) return cookied

  const session = getAuthSessionCookie(request)
  if (!session) return null

  try {
    const res = await env.AUTH_SERVICE.fetch('https://auth/token', {
      method: 'POST',
      headers: { cookie: session, ...ipHeaders(request) },
    })
    if (!res.ok) return null
    const body = (await res.json()) as { accessToken?: string }
    return body.accessToken ?? null
  } catch {
    // Auth unreachable — treat as unauthenticated for this request rather than
    // throwing; callers already degrade or redirect on a null token.
    return null
  }
}

/**
 * Validate a post-login redirect target: same-origin relative paths only
 * (`/...` but not `//host`), so `?next=` can never become an open redirect.
 */
export function safeRelativePath(value: string | null | undefined): string | null {
  return value && /^\/(?!\/)/.test(value) ? value : null
}

/**
 * Send an unauthenticated caller to sign in, remembering where they were.
 *
 * Every route did `throw redirect('/login')`, which drops you on the workspace
 * list afterwards. For an admin four levels into settings — or an SSO-only org
 * whose IdP round-trip happens mid-task — that is a small tax paid often. The
 * destination goes through `safeRelativePath`, so this can't be turned into an
 * open redirect by a crafted URL.
 *
 * Only for GET navigations: bouncing a POST back to itself after sign-in would
 * silently replay a mutation, so actions keep the bare redirect.
 */
export function loginRedirect(request: Request): Response {
  if (request.method !== 'GET') return redirect('/login')
  const url = new URL(request.url)
  const next = safeRelativePath(`${url.pathname}${url.search}`)
  return redirect(next && next !== '/' ? `/login?next=${encodeURIComponent(next)}` : '/login')
}

/**
 * Forward the real client IP on service-binding calls to auth. Bindings don't
 * carry cf-connecting-ip, so without this every console user shares one
 * rate-limit bucket ('unknown') and session rows record no IP.
 */
export function ipHeaders(request: Request): Record<string, string> {
  const ip = request.headers.get('cf-connecting-ip')
  return ip ? { 'cf-connecting-ip': ip } : {}
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
