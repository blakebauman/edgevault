import { cloudflareContext } from '../lib/cloudflare'
import { getToken } from '../lib/session.server'
import type { Route } from './+types/assistant.messages'

/**
 * BFF proxy for the assistant's thread history.
 *
 * `AIChatAgent` persists messages in its Durable Object and serves them from
 * `…/get-messages`, but the browser cannot call that directly: the api sends no
 * CORS headers, which is why `getInitialMessages` was disabled outright. The
 * comment that replaced it claimed history would re-sync over the WebSocket. It
 * does not — the server keeps the history and feeds it to the model, while the
 * client renders an empty thread on every page load. Verified on staging by
 * asking the assistant what had been discussed earlier: it answered correctly,
 * with nothing on screen.
 *
 * Routing it through the console's own origin fixes that with no CORS exposure,
 * the same shape as `assistant.ws-token`.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const env = context.get(cloudflareContext).env
  const token = await getToken(request, env)
  if (!token) return Response.json({ error: 'unauthorized' }, { status: 401 })

  const name = new URL(request.url).searchParams.get('name')
  if (!name) return Response.json({ error: 'missing_name' }, { status: 400 })

  // The agent instance name is passed through rather than rebuilt here: the api
  // re-derives the workspace from its first segment and rejects a `:userId`
  // segment that isn't the caller, so a forged name cannot read another user's
  // thread. Encoded because the name contains `:` separators.
  const res = await env.API_SERVICE.fetch(
    `https://api/agents/EdgeVaultAgent/${encodeURIComponent(name)}/get-messages`,
    { headers: { authorization: `Bearer ${token}` } },
  )
  if (!res.ok) {
    // An empty thread is indistinguishable from a missing one here, and both
    // should render as "no history" rather than breaking the drawer.
    return Response.json([], { status: 200 })
  }
  return Response.json(await res.json(), {
    // History is per-user and changes every turn; never let it sit in a cache.
    headers: { 'cache-control': 'no-store' },
  })
}
