import { redirect } from 'react-router'
import { safeRelativePath, setSsoCookie } from '../lib/session.server'
import type { Route } from './+types/sso.start'

/**
 * Begin enterprise SSO: ask the ee/enterprise worker (via service binding) for
 * the IdP authorize URL + PKCE/state/nonce, stash those server-side in the SSO
 * transaction cookie, and redirect the browser to the IdP. The browser never
 * leaves the console origin except to visit the IdP.
 */
export async function loader({ request, params, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env
  const orgId = params.orgId
  const next = safeRelativePath(new URL(request.url).searchParams.get('next')) ?? undefined
  const enterprise = env.ENTERPRISE_SERVICE
  if (!enterprise) throw redirect('/login?sso=unavailable')

  const res = await enterprise.fetch(`https://enterprise/orgs/${orgId}/sso/start`, {
    method: 'POST',
    headers: { 'x-internal-token': env.INTERNAL_TOKEN, 'content-type': 'application/json' },
    body: '{}',
  })
  if (!res.ok) throw redirect('/login?sso=error')

  const {
    authorizeUrl,
    state,
    nonce,
    codeVerifier,
    orgId: resolvedOrgId,
  } = (await res.json()) as {
    authorizeUrl: string
    state: string
    nonce: string
    codeVerifier: string
    orgId?: string
  }

  // The user may have typed the org slug; the cookie must carry the real id —
  // the callback provisions membership against it.
  return redirect(authorizeUrl, {
    headers: {
      'Set-Cookie': setSsoCookie(
        { orgId: resolvedOrgId ?? orgId, state, nonce, codeVerifier, next },
        request,
      ),
    },
  })
}
