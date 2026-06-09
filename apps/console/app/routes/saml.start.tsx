import { redirect } from 'react-router'
import { setSamlCookie } from '../lib/session.server'
import type { Route } from './+types/saml.start'

/**
 * Begin SP-initiated SAML SSO: ask the auth worker for the AuthnRequest + IdP
 * redirect URL, remember the request id (for InResponseTo) in the SAML
 * transaction cookie, and redirect the browser to the IdP. The IdP later POSTs
 * its response to the ACS route.
 */
export async function loader({ request, params, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env
  const orgId = params.orgId

  const res = await env.AUTH_SERVICE.fetch(`https://auth/orgs/${orgId}/saml/start`, {
    method: 'POST',
    headers: { 'x-internal-token': env.INTERNAL_TOKEN, 'content-type': 'application/json' },
    body: '{}',
  })
  if (!res.ok) throw redirect('/login?sso=error')

  const {
    authnId,
    redirectUrl,
    orgId: resolvedOrgId,
  } = (await res.json()) as { authnId: string; redirectUrl: string; orgId?: string }
  // The user may have typed the org slug; the cookie must carry the real id.
  return redirect(redirectUrl, {
    headers: { 'Set-Cookie': setSamlCookie(resolvedOrgId ?? orgId, authnId, request) },
  })
}
