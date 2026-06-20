import { getToken } from '../lib/session.server'
import type { Route } from './+types/assistant.history'

/**
 * BFF resource route: the caller's persisted assistant history for a workspace
 * (no UI). Attaches the httpOnly token server-side and proxies the api's
 * user-scoped `/assistant/history`. Consumed by `useAgentChat` on first open.
 */
export async function loader({ request, params, context }: Route.LoaderArgs) {
  const token = getToken(request)
  if (!token) return Response.json({ history: [] }, { status: 401 })

  const res = await context.cloudflare.env.API_SERVICE.fetch(
    `https://api/api/v1/workspaces/${params.workspaceId}/assistant/history`,
    { headers: { authorization: `Bearer ${token}` } },
  )
  return new Response(await res.text(), {
    status: res.status,
    headers: { 'content-type': 'application/json' },
  })
}
