import { redirect } from 'react-router'
import { clearSsoCookie, getSsoTransaction, setTokenCookie } from '../lib/session.server'
import type { Route } from './+types/sso.callback'

/**
 * Complete enterprise SSO. The auth worker verifies the IdP code + ID token and
 * returns the identity claims, then turns those into an EdgeVault session
 * (JIT-provisioning the user + org membership); we then exchange that session
 * for an access token — exactly like password sign-in — and land the user in
 * the console. No SSO secret or session logic lives here.
 */
export async function loader({ request, params, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env
  const orgId = params.orgId
  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')

  const tx = getSsoTransaction(request)
  const fail = (reason: string) =>
    redirect(`/login?sso=${reason}`, { headers: { 'Set-Cookie': clearSsoCookie(request) } })

  if (!code || !state || !tx || tx.orgId !== orgId) {
    return fail('error')
  }

  // 1) Verify the OIDC response in the auth worker → identity claims.
  const cbRes = await env.AUTH_SERVICE.fetch(`https://auth/orgs/${orgId}/sso/callback`, {
    method: 'POST',
    headers: { 'x-internal-token': env.INTERNAL_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({
      code,
      state,
      expectedState: tx.state,
      nonce: tx.nonce,
      codeVerifier: tx.codeVerifier,
    }),
  })
  if (!cbRes.ok) return fail('denied')
  const claims = (await cbRes.json()) as { email: string; name: string | null }

  // 2) JIT-provision the user + session in the auth worker (internal endpoint).
  const provRes = await env.AUTH_SERVICE.fetch('https://auth/internal/sso/provision', {
    method: 'POST',
    headers: { 'x-internal-token': env.INTERNAL_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ email: claims.email, name: claims.name, organizationId: orgId }),
  })
  if (!provRes.ok) return fail('error')

  // 3) Exchange the session cookie for a short-lived access token (BFF pattern).
  const cookie = (provRes.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
  const tokenRes = await env.AUTH_SERVICE.fetch('https://auth/token', {
    method: 'POST',
    headers: { cookie },
  })
  const token = ((await tokenRes.json()) as { accessToken?: string }).accessToken
  if (!token) return fail('error')

  const headers = new Headers()
  headers.append('Set-Cookie', setTokenCookie(token, request))
  headers.append('Set-Cookie', clearSsoCookie(request))
  return redirect(tx.next ?? '/', { headers })
}
