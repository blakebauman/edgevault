import { redirect } from 'react-router'
import { safeRelativePath, setOAuthCookie } from '../lib/session.server'
import type { Route } from './+types/oauth.start'

/**
 * Begin social OAuth: ask the auth worker for the provider authorize URL +
 * state/PKCE, stash those in the transaction cookie, and redirect the browser to
 * the provider. The provider returns to /oauth/:provider/callback.
 */
export async function loader({ request, params, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env
  const provider = params.provider
  const url = new URL(request.url)
  const redirectUri = `${url.origin}/oauth/${provider}/callback`
  const next = safeRelativePath(url.searchParams.get('next')) ?? undefined

  const res = await env.AUTH_SERVICE.fetch(`https://auth/oauth/${provider}/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirectUri }),
  })
  if (!res.ok) throw redirect('/login?sso=unavailable')

  const { authorizeUrl, state, codeVerifier } = (await res.json()) as {
    authorizeUrl: string
    state: string
    codeVerifier: string | null
  }
  return redirect(authorizeUrl, {
    headers: {
      'Set-Cookie': setOAuthCookie(
        { provider, state, codeVerifier: codeVerifier ?? undefined, next },
        request,
      ),
    },
  })
}
