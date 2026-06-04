import {
  clearWebauthnCookie,
  getToken,
  getWebauthnChallenge,
  setTokenCookie,
  setWebauthnCookie,
} from '../lib/session.server'
import type { Route } from './+types/api.passkey'

/**
 * BFF resource route for WebAuthn/passkey ceremonies. Derives the rpID/origin
 * from this request, round-trips the challenge in an httpOnly cookie, and proxies
 * to the auth worker. Registration is access-token gated; authentication is
 * public and ends by exchanging the new session for an access-token cookie.
 */
export async function action({ request, context }: Route.ActionArgs) {
  const env = context.cloudflare.env
  const url = new URL(request.url)
  const rpID = url.hostname
  const origin = url.origin
  const body = (await request.json().catch(() => ({}))) as { intent?: string; response?: unknown }

  const json = (data: unknown, init?: ResponseInit) =>
    Response.json(data, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    })

  switch (body.intent) {
    case 'register-options': {
      const token = getToken(request)
      if (!token) return json({ error: 'unauthorized' }, { status: 401 })
      const res = await env.AUTH_SERVICE.fetch('https://auth/webauthn/register/options', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ rpID }),
      })
      if (!res.ok) return json({ error: 'options_failed' }, { status: 400 })
      const options = (await res.json()) as { challenge: string }
      return json(options, {
        headers: { 'Set-Cookie': setWebauthnCookie(options.challenge, request) },
      })
    }

    case 'register-verify': {
      const token = getToken(request)
      if (!token) return json({ error: 'unauthorized' }, { status: 401 })
      const expectedChallenge = getWebauthnChallenge(request)
      if (!expectedChallenge) return json({ error: 'no_challenge' }, { status: 400 })
      const res = await env.AUTH_SERVICE.fetch('https://auth/webauthn/register/verify', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          response: body.response,
          expectedChallenge,
          expectedOrigin: origin,
          expectedRPID: rpID,
        }),
      })
      const data = await res.json()
      return json(data, {
        status: res.status,
        headers: { 'Set-Cookie': clearWebauthnCookie(request) },
      })
    }

    case 'auth-options': {
      const res = await env.AUTH_SERVICE.fetch('https://auth/webauthn/auth/options', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rpID }),
      })
      if (!res.ok) return json({ error: 'options_failed' }, { status: 400 })
      const options = (await res.json()) as { challenge: string }
      return json(options, {
        headers: { 'Set-Cookie': setWebauthnCookie(options.challenge, request) },
      })
    }

    case 'auth-verify': {
      const expectedChallenge = getWebauthnChallenge(request)
      if (!expectedChallenge) return json({ error: 'no_challenge' }, { status: 400 })
      const res = await env.AUTH_SERVICE.fetch('https://auth/webauthn/auth/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          response: body.response,
          expectedChallenge,
          expectedOrigin: origin,
          expectedRPID: rpID,
        }),
      })
      if (!res.ok) {
        return json(
          { error: 'verification_failed' },
          { status: 401, headers: { 'Set-Cookie': clearWebauthnCookie(request) } },
        )
      }
      // Exchange the new session cookie for an access token, like password sign-in.
      const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
      const tokenRes = await env.AUTH_SERVICE.fetch('https://auth/token', {
        method: 'POST',
        headers: { cookie },
      })
      const token = ((await tokenRes.json()) as { accessToken?: string }).accessToken
      if (!token) return json({ error: 'token_failed' }, { status: 500 })
      const headers = new Headers({ 'content-type': 'application/json' })
      headers.append('Set-Cookie', setTokenCookie(token, request))
      headers.append('Set-Cookie', clearWebauthnCookie(request))
      return new Response(JSON.stringify({ ok: true }), { headers })
    }

    default:
      return json({ error: 'unknown_intent' }, { status: 400 })
  }
}
