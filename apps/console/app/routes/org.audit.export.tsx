import { cloudflareContext } from '../lib/cloudflare'
import { getToken, loginRedirect } from '../lib/session.server'
import type { Route } from './+types/org.audit.export'

/**
 * Resource route: stream the organization trail's export to the browser.
 *
 * Mirrors the workspace export proxy — same header pass-through, same piped
 * body — against the org-scoped endpoint. The api owns the admin check and the
 * digest; this preserves the filters so the file matches the query on screen.
 */
export async function loader({ request, params, context }: Route.LoaderArgs) {
  const env = context.get(cloudflareContext).env
  const token = await getToken(request, env)
  if (!token) throw loginRedirect(request)

  const incoming = new URL(request.url)
  const query = new URLSearchParams()
  for (const key of ['from', 'to', 'action', 'resourceType', 'actor']) {
    const value = incoming.searchParams.get(key)
    if (value) query.set(key, value)
  }

  const res = await env.API_SERVICE.fetch(
    `https://api/api/v1/organizations/${params.orgId}/audit/export?${query}`,
    { headers: { authorization: `Bearer ${token}` } },
  )

  if (res.status === 401) throw loginRedirect(request)
  if (!res.ok) {
    const detail =
      ((await res.json().catch(() => null)) as { detail?: string } | null)?.detail ??
      'The export could not be generated.'
    return new Response(detail, { status: res.status, headers: { 'content-type': 'text/plain' } })
  }

  const headers = new Headers({
    'content-type': 'application/x-ndjson',
    'content-disposition':
      res.headers.get('content-disposition') ??
      `attachment; filename="edgevault-org-audit-${params.orgId}.ndjson"`,
    // Nothing about an audit export should sit in a shared cache.
    'cache-control': 'no-store',
  })
  for (const key of ['x-content-sha256', 'x-audit-event-count']) {
    const value = res.headers.get(key)
    if (value) headers.set(key, value)
  }
  return new Response(res.body, { headers })
}
