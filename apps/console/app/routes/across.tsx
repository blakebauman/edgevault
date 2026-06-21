import { loadAcrossEnvironments } from '../lib/items.server'
import { getToken } from '../lib/session.server'
import type { Route } from './+types/across'

/**
 * Resource route (no component): the item-detail panel's "across environments"
 * matrix fetches this with useFetcher on selection, so the value across every
 * environment loads on demand without a full navigation.
 */
export async function loader({ request, params, context }: Route.LoaderArgs) {
  const token = getToken(request)
  if (!token) return { key: params.key, environments: [] }
  return loadAcrossEnvironments(context.cloudflare.env, token, params.workspaceId, params.key)
}
