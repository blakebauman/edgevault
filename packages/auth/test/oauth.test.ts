import { describe, expect, it } from 'vitest'
import {
  buildOAuthUrl,
  exchangeOAuthCode,
  fetchOAuthIdentity,
  generatePkce,
  isOAuthProvider,
  providerUsesPkce,
} from '../src/oauth'

describe('provider helpers', () => {
  it('recognizes supported providers', () => {
    expect(isOAuthProvider('github')).toBe(true)
    expect(isOAuthProvider('google')).toBe(true)
    expect(isOAuthProvider('twitter')).toBe(false)
  })

  it('uses PKCE for Google but not GitHub', () => {
    expect(providerUsesPkce('google')).toBe(true)
    expect(providerUsesPkce('github')).toBe(false)
  })
})

describe('generatePkce', () => {
  it('produces a URL-safe verifier + S256 challenge', async () => {
    const { verifier, challenge } = await generatePkce()
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(challenge).not.toBe(verifier)
  })
})

describe('buildOAuthUrl', () => {
  it('builds a GitHub URL with state and no PKCE', () => {
    const url = new URL(
      buildOAuthUrl('github', {
        clientId: 'gh-client',
        redirectUri: 'https://app.test/oauth/github/callback',
        state: 'st4te',
      }),
    )
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize')
    expect(url.searchParams.get('client_id')).toBe('gh-client')
    expect(url.searchParams.get('scope')).toBe('read:user user:email')
    expect(url.searchParams.get('state')).toBe('st4te')
    expect(url.searchParams.get('code_challenge')).toBeNull()
  })

  it('builds a Google URL with PKCE when a challenge is given', () => {
    const url = new URL(
      buildOAuthUrl('google', {
        clientId: 'g-client',
        redirectUri: 'https://app.test/oauth/google/callback',
        state: 'st4te',
        codeChallenge: 'chal',
      }),
    )
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(url.searchParams.get('code_challenge')).toBe('chal')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('scope')).toBe('openid email profile')
  })
})

describe('exchangeOAuthCode', () => {
  it('posts the code and returns tokens (mocked fetch)', async () => {
    const captured: { url?: string; body?: string } = {}
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      captured.url = String(url)
      captured.body = String(init?.body)
      return new Response(JSON.stringify({ access_token: 'at', scope: 'read:user' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const tokens = await exchangeOAuthCode(
      'github',
      {
        clientId: 'gh',
        clientSecret: 'secret',
        code: 'the-code',
        redirectUri: 'https://app.test/cb',
      },
      fakeFetch,
    )
    expect(tokens.accessToken).toBe('at')
    expect(captured.url).toBe('https://github.com/login/oauth/access_token')
    expect(captured.body).toContain('code=the-code')
    expect(captured.body).toContain('grant_type=authorization_code')
  })
})

describe('fetchOAuthIdentity (github)', () => {
  it('reads the profile and falls back to the primary verified email', async () => {
    const fakeFetch = (async (url: string | URL | Request) => {
      const u = String(url)
      if (u === 'https://api.github.com/user') {
        return Response.json({ id: 42, login: 'ada', name: 'Ada Lovelace' })
      }
      if (u === 'https://api.github.com/user/emails') {
        return Response.json([
          { email: 'secondary@x.test', primary: false, verified: true },
          { email: 'ada@x.test', primary: true, verified: true },
        ])
      }
      throw new Error(`unexpected ${u}`)
    }) as unknown as typeof fetch

    const id = await fetchOAuthIdentity(
      'github',
      { accessToken: 'at' },
      { clientId: 'gh' },
      fakeFetch,
    )
    expect(id).toEqual({ providerAccountId: '42', email: 'ada@x.test', name: 'Ada Lovelace' })
  })
})
