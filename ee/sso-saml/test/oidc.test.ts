import { freeLicense } from '@edgevault/licensing'
import { describe, expect, it } from 'vitest'
import {
  assertSsoEntitled,
  buildAuthorizationUrl,
  exchangeCode,
  generatePkce,
  type OidcConnection,
  type OidcDiscovery,
} from '../src/index'

const connection: OidcConnection = {
  organizationId: 'org-1',
  issuer: 'https://idp.example.com',
  clientId: 'client-123',
  clientSecret: 'secret',
  redirectUri: 'https://app.edgevault.dev/sso/callback',
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
})

describe('entitlement gate', () => {
  it('blocks SSO without the entitlement', () => {
    expect(() => assertSsoEntitled(freeLicense('org-1'))).toThrow()
  })
})
