import { cloudflareContext } from '../lib/cloudflare'
import { loadAcrossEnvironments } from '../lib/items.server'
import { getToken } from '../lib/session.server'
import type { Route } from './+types/across'

/**
 * Resource route (no component): the item-detail panel's "across environments"
 * matrix fetches this with useFetcher on selection, so the value across every
 * environment loads on demand without a full navigation.
 */
export async function loader({ request, params, context }: Route.LoaderArgs) {
  const token = await getToken(request, context.get(cloudflareContext).env)
  if (!token) return { key: params.key, environments: [] }
  return loadAcrossEnvironments(
    context.get(cloudflareContext).env,
    token,
    params.workspaceId,
    params.key,
  )
}
