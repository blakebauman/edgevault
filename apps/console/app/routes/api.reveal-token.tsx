import {
  clearWebauthnCookie,
  getToken,
  getWebauthnChallenge,
  setRevealCookie,
  setWebauthnCookie,
} from '../lib/session.server'
import type { Route } from './+types/api.reveal-token'

/**
 * BFF resource route for step-up before a secret reveal. Proves a fresh second
 * factor (passkey assertion or TOTP code) to the auth worker's /reauth, which
 * mints a short-lived reveal token. We stash that token in an httpOnly cookie
 * (ev_reveal) so the reveal call can forward it server-side as x-reveal-token —
 * it never reaches client JS. Mirrors the passkey BFF route's challenge
 * round-trip; everything here is token-gated (a signed-in user stepping up).
 */
export async function action({ request, context }: Route.ActionArgs) {
  const env = context.cloudflare.env
  const url = new URL(request.url)
  const rpID = url.hostname
  const origin = url.origin
  const token = getToken(request)
  if (!token) return Response.json({ error: 'unauthorized' }, { status: 401 })

  const body = (await request.json().catch(() => ({}))) as {
    intent?: string
    response?: unknown
    code?: string
  }
  const json = (data: unknown, init?: ResponseInit) => Response.json(data, init)

  switch (body.intent) {
    // Passkey leg 1: get assertion options, round-trip the challenge in a cookie.
    case 'passkey-options': {
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

    // Passkey leg 2: verify the assertion and mint the reveal token.
    case 'passkey-verify': {
      const expectedChallenge = getWebauthnChallenge(request)
      if (!expectedChallenge) return json({ error: 'no_challenge' }, { status: 400 })
      const res = await env.AUTH_SERVICE.fetch('https://auth/reauth', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          method: 'passkey',
          response: body.response,
          expectedChallenge,
          expectedOrigin: origin,
          expectedRPID: rpID,
        }),
      })
      if (!res.ok) {
        return json(
          { error: 'reauth_failed' },
          { status: 401, headers: { 'Set-Cookie': clearWebauthnCookie(request) } },
        )
      }
      const { revealToken } = (await res.json()) as { revealToken: string }
      const headers = new Headers({ 'content-type': 'application/json' })
      headers.append('Set-Cookie', setRevealCookie(revealToken, request))
      headers.append('Set-Cookie', clearWebauthnCookie(request))
      return new Response(JSON.stringify({ ok: true }), { headers })
    }

    // TOTP: one shot, no challenge round-trip.
    case 'totp': {
      const code = String(body.code ?? '').trim()
      if (!code) return json({ error: 'missing_code' }, { status: 400 })
      const res = await env.AUTH_SERVICE.fetch('https://auth/reauth', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'totp', code }),
      })
      if (!res.ok) return json({ error: 'reauth_failed' }, { status: 401 })
      const { revealToken } = (await res.json()) as { revealToken: string }
      return new Response(JSON.stringify({ ok: true }), {
        headers: {
          'content-type': 'application/json',
          'Set-Cookie': setRevealCookie(revealToken, request),
        },
      })
    }

    default:
      return json({ error: 'unknown_intent' }, { status: 400 })
  }
}
