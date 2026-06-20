import { getToken } from '../lib/session.server'
import type { Route } from './+types/assistant.ws-token'

/**
 * BFF resource route: hands the browser a fresh access token to authenticate the
 * agent WebSocket. The token is httpOnly (server-only), so the SDK's `useAgent`
 * query option fetches it here on each (re)connect — mirroring how the realtime
 * `/ws` embeds the token. The api re-verifies it and checks workspace membership
 * on connect.
 */
export function loader({ request }: Route.LoaderArgs) {
  const token = getToken(request)
  if (!token) return Response.json({ error: 'unauthorized' }, { status: 401 })
  return Response.json({ token })
}
