import { redirect } from 'react-router'
import { clearOAuthCookie, getOAuthTransaction, setTokenCookie } from '../lib/session.server'
import type { Route } from './+types/oauth.callback'

/**
 * Social OAuth callback: verify the returned state against the transaction
 * cookie, have the auth worker exchange the code + provision the user + mint a
 * session, then exchange that for an access token and land in the console.
 */
export async function loader({ request, params, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env
  const provider = params.provider
  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const tx = getOAuthTransaction(request)

  const fail = (reason: string) =>
    redirect(`/login?sso=${reason}`, { headers: { 'Set-Cookie': clearOAuthCookie(request) } })

  // CSRF: state must match the value we stored for this provider.
  if (!code || !state || !tx || tx.provider !== provider || tx.state !== state) {
    return fail('error')
  }

  const res = await env.AUTH_SERVICE.fetch(`https://auth/oauth/${provider}/callback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code,
      redirectUri: `${url.origin}/oauth/${provider}/callback`,
      codeVerifier: tx.codeVerifier,
    }),
  })
  if (!res.ok) return fail('denied')

  // Exchange the new session cookie for an access token (BFF pattern).
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
  const tokenRes = await env.AUTH_SERVICE.fetch('https://auth/token', {
    method: 'POST',
    headers: { cookie },
  })
  const token = ((await tokenRes.json()) as { accessToken?: string }).accessToken
  if (!token) return fail('error')

  const headers = new Headers()
  headers.append('Set-Cookie', setTokenCookie(token, request))
  headers.append('Set-Cookie', clearOAuthCookie(request))
  return redirect(tx.next ?? '/', { headers })
}
