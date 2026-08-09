import { cloudflareContext } from '../lib/cloudflare'
import { getToken, loginRedirect } from '../lib/session.server'
import type { Route } from './+types/dashboard.audit.export'

/**
 * Resource route: stream the audit warehouse export to the browser.
 *
 * The api already does the interesting work — it is admin-gated, returns the
 * raw NDJSON with an `x-content-sha256` of the body, and records an
 * `audit.exported` event of its own. This proxies it, preserving the filters
 * from the query string so the download matches the query the reviewer was
 * looking at, and passing the verification headers through so the digest shown
 * in the UI is the one the file actually hashes to.
 *
 * The body is piped, not buffered: an export can be every event a workspace
 * ever recorded, and holding that in the isolate to hand it straight back
 * would be a needless memory ceiling.
 */
export async function loader({ request, params, context }: Route.LoaderArgs) {
  const env = context.get(cloudflareContext).env
  const token = await getToken(request, env)
  if (!token) throw loginRedirect(request)

  const incoming = new URL(request.url)
  const query = new URLSearchParams()
  for (const key of ['from', 'to', 'env', 'action', 'resourceType', 'actor']) {
    const value = incoming.searchParams.get(key)
    if (value) query.set(key, value)
  }

  const res = await env.API_SERVICE.fetch(
    `https://api/api/v1/workspaces/${params.workspaceId}/audit/export?${query}`,
    { headers: { authorization: `Bearer ${token}` } },
  )

  if (res.status === 401) throw loginRedirect(request)
  if (!res.ok) {
    // Surface the api's own reason (403 "audit export requires admin") rather
    // than a generic failure — the caller can act on it.
    const detail =
      ((await res.json().catch(() => null)) as { detail?: string } | null)?.detail ??
      'The export could not be generated.'
    return new Response(detail, { status: res.status, headers: { 'content-type': 'text/plain' } })
  }

  const headers = new Headers({
    'content-type': 'application/x-ndjson',
    'content-disposition':
      res.headers.get('content-disposition') ??
      `attachment; filename="edgevault-audit-${params.workspaceId}.ndjson"`,
    // Nothing about an audit export should sit in a shared cache.
    'cache-control': 'no-store',
  })
  for (const key of ['x-content-sha256', 'x-audit-event-count']) {
    const value = res.headers.get(key)
    if (value) headers.set(key, value)
  }
  return new Response(res.body, { headers })
}
