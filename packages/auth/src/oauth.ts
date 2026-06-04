import * as jose from 'jose'

/**
 * Social OAuth (GitHub + Google) — the authorization-code flow built directly on
 * `fetch` + `jose`, no third-party OAuth SDK. GitHub is plain OAuth2 (we read the
 * REST userinfo); Google is OIDC (we verify the id_token with `jose`). PKCE is
 * used wherever the provider supports it.
 */

export type OAuthProvider = 'github' | 'google'

export function isOAuthProvider(value: string): value is OAuthProvider {
  return value === 'github' || value === 'google'
}

interface ProviderConfig {
  authorizeUrl: string
  tokenUrl: string
  defaultScopes: string[]
  usePkce: boolean
}

const PROVIDERS: Record<OAuthProvider, ProviderConfig> = {
  github: {
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    defaultScopes: ['read:user', 'user:email'],
    usePkce: false,
  },
  google: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    defaultScopes: ['openid', 'email', 'profile'],
    usePkce: true,
  },
}

export function providerUsesPkce(provider: OAuthProvider): boolean {
  return PROVIDERS[provider].usePkce
}

// --- PKCE + state -----------------------------------------------------------

function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

export function randomState(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)))
}

export interface Pkce {
  verifier: string
  challenge: string
}

export async function generatePkce(): Promise<Pkce> {
  const verifier = randomState(32)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return { verifier, challenge: base64url(new Uint8Array(digest)) }
}

// --- authorization URL ------------------------------------------------------

export interface AuthUrlInput {
  clientId: string
  redirectUri: string
  state: string
  scopes?: string[]
  codeChallenge?: string
}

export function buildOAuthUrl(provider: OAuthProvider, input: AuthUrlInput): string {
  const cfg = PROVIDERS[provider]
  const url = new URL(cfg.authorizeUrl)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', input.clientId)
  url.searchParams.set('redirect_uri', input.redirectUri)
  url.searchParams.set('scope', (input.scopes ?? cfg.defaultScopes).join(' '))
  url.searchParams.set('state', input.state)
  if (cfg.usePkce && input.codeChallenge) {
    url.searchParams.set('code_challenge', input.codeChallenge)
    url.searchParams.set('code_challenge_method', 'S256')
  }
  return url.toString()
}

// --- token exchange ---------------------------------------------------------

export interface OAuthTokens {
  accessToken?: string
  idToken?: string
  scope?: string
}

export interface ExchangeInput {
  clientId: string
  clientSecret: string
  code: string
  redirectUri: string
  codeVerifier?: string
}

export async function exchangeOAuthCode(
  provider: OAuthProvider,
  input: ExchangeInput,
  fetchImpl: typeof fetch = fetch,
): Promise<OAuthTokens> {
  const cfg = PROVIDERS[provider]
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    client_secret: input.clientSecret,
  })
  if (cfg.usePkce && input.codeVerifier) body.set('code_verifier', input.codeVerifier)

  const res = await fetchImpl(cfg.tokenUrl, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!res.ok) throw new Error(`OAuth token exchange failed: ${res.status}`)
  const json = (await res.json()) as {
    access_token?: string
    id_token?: string
    scope?: string
  }
  return { accessToken: json.access_token, idToken: json.id_token, scope: json.scope }
}

// --- userinfo ---------------------------------------------------------------

export interface OAuthIdentity {
  providerAccountId: string
  email: string | null
  name: string | null
}

const GOOGLE_JWKS = jose.createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'))

export async function fetchOAuthIdentity(
  provider: OAuthProvider,
  tokens: OAuthTokens,
  opts: { clientId: string },
  fetchImpl: typeof fetch = fetch,
): Promise<OAuthIdentity> {
  if (provider === 'google') {
    if (!tokens.idToken) throw new Error('Google did not return an id_token')
    const { payload } = await jose.jwtVerify(tokens.idToken, GOOGLE_JWKS, {
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      audience: opts.clientId,
    })
    const email = typeof payload.email === 'string' ? payload.email : null
    const verified = payload.email_verified === true || payload.email_verified === 'true'
    return {
      providerAccountId: String(payload.sub),
      email: verified ? email : null,
      name: typeof payload.name === 'string' ? payload.name : null,
    }
  }

  // GitHub: read the REST userinfo with the access token.
  if (!tokens.accessToken) throw new Error('GitHub did not return an access_token')
  const headers = {
    authorization: `Bearer ${tokens.accessToken}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'EdgeVault',
  }
  const userRes = await fetchImpl('https://api.github.com/user', { headers })
  if (!userRes.ok) throw new Error(`GitHub userinfo failed: ${userRes.status}`)
  const user = (await userRes.json()) as {
    id: number
    name?: string
    login: string
    email?: string
  }

  let email = user.email ?? null
  if (!email) {
    const emailRes = await fetchImpl('https://api.github.com/user/emails', { headers })
    if (emailRes.ok) {
      const emails = (await emailRes.json()) as Array<{
        email: string
        primary: boolean
        verified: boolean
      }>
      email = emails.find((e) => e.primary && e.verified)?.email ?? null
    }
  }
  return { providerAccountId: String(user.id), email, name: user.name ?? user.login }
}
