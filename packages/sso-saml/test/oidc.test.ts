import { describe, expect, it } from 'vitest'
import {
  buildAuthorizationUrl,
  exchangeCode,
  fetchDiscovery,
  generatePkce,
  type OidcConnection,
  type OidcDiscovery,
} from '../src/index'

const connection: OidcConnection = {
  organizationId: 'org-1',
  issuer: 'https://idp.example.com',
  clientId: 'client-123',
  clientSecret: 'secret',
  redirectUri: 'https://app.test/sso/callback',
}

const discovery: OidcDiscovery = {
  issuer: 'https://idp.example.com',
  authorization_endpoint: 'https://idp.example.com/authorize',
  token_endpoint: 'https://idp.example.com/token',
  jwks_uri: 'https://idp.example.com/jwks',
}

describe('OIDC', () => {
  it('generates a PKCE verifier + S256 challenge', async () => {
    const pkce = await generatePkce()
    expect(pkce.verifier).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(pkce.challenge).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(pkce.challenge).not.toBe(pkce.verifier)
  })

  it('builds an authorization URL with PKCE + state + nonce', () => {
    const url = new URL(
      buildAuthorizationUrl(connection, discovery, {
        state: 'st',
        nonce: 'no',
        codeChallenge: 'cc',
      }),
    )
    expect(url.origin + url.pathname).toBe('https://idp.example.com/authorize')
    expect(url.searchParams.get('client_id')).toBe('client-123')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('state')).toBe('st')
  })

  it('exchanges a code via the token endpoint (injected fetch)', async () => {
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://idp.example.com/token')
      const body = new URLSearchParams(init?.body as string)
      expect(body.get('grant_type')).toBe('authorization_code')
      expect(body.get('code_verifier')).toBe('verifier')
      return new Response(JSON.stringify({ id_token: 'jwt', access_token: 'at' }), {
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch
    const tokens = await exchangeCode(
      connection,
      discovery,
      { code: 'code', codeVerifier: 'verifier' },
      fetchImpl,
    )
    expect(tokens.id_token).toBe('jwt')
  })

  it('accepts a discovery document whose issuer matches (trailing slash tolerated)', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ ...discovery, issuer: 'https://idp.example.com/' }), {
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch
    const doc = await fetchDiscovery('https://idp.example.com', fetchImpl)
    expect(doc.authorization_endpoint).toBe('https://idp.example.com/authorize')
  })

  it('rejects a discovery document asserting a different issuer (pinning)', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ ...discovery, issuer: 'https://evil.example.com' }), {
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch
    await expect(fetchDiscovery('https://idp.example.com', fetchImpl)).rejects.toThrow(
      /issuer mismatch/,
    )
  })
})
