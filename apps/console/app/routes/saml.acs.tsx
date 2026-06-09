import { redirect } from 'react-router'
import { clearSamlCookie, getSamlTransaction, setTokenCookie } from '../lib/session.server'
import type { Route } from './+types/saml.acs'

/**
 * SAML Assertion Consumer Service — the IdP POSTs its SAMLResponse here. The
 * auth worker verifies the signature + conditions and returns identity claims,
 * then turns them into a session; we exchange that for an access token and land
 * the user in the console. No SAML/session logic here.
 */
export async function action({ request, params, context }: Route.ActionArgs) {
  const env = context.cloudflare.env
  const orgId = params.orgId
  const fail = (reason: string) =>
    redirect(`/login?sso=${reason}`, { headers: { 'Set-Cookie': clearSamlCookie(request) } })

  const form = await request.formData()
  const samlResponse = String(form.get('SAMLResponse') ?? '')
  if (!samlResponse) return fail('error')

  // The transaction cookie may be absent on a cross-site POST (SameSite) — then
  // InResponseTo simply isn't checked; the assertion is still fully verified.
  const tx = getSamlTransaction(request)
  const expectedInResponseTo = tx && tx.orgId === orgId ? tx.authnId : undefined

  // 1) Verify the SAMLResponse in the auth worker → identity claims.
  const acsRes = await env.AUTH_SERVICE.fetch(`https://auth/orgs/${orgId}/saml/acs`, {
    method: 'POST',
    headers: { 'x-internal-token': env.INTERNAL_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ samlResponse, expectedInResponseTo }),
  })
  if (!acsRes.ok) return fail('denied')
  const claims = (await acsRes.json()) as { email: string; name: string | null }

  // 2) JIT-provision the user + session in the auth worker (internal endpoint).
  const provRes = await env.AUTH_SERVICE.fetch('https://auth/internal/sso/provision', {
    method: 'POST',
    headers: { 'x-internal-token': env.INTERNAL_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ email: claims.email, name: claims.name, organizationId: orgId }),
  })
  if (!provRes.ok) return fail('error')

  // 3) Exchange the session cookie for a short-lived access token.
  const cookie = (provRes.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
  const tokenRes = await env.AUTH_SERVICE.fetch('https://auth/token', {
    method: 'POST',
    headers: { cookie },
  })
  const token = ((await tokenRes.json()) as { accessToken?: string }).accessToken
  if (!token) return fail('error')

  const headers = new Headers()
  headers.append('Set-Cookie', setTokenCookie(token, request))
  headers.append('Set-Cookie', clearSamlCookie(request))
  return redirect('/', { headers })
}
