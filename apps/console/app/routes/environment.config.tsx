import { ItemSection } from '../components/items'
import { handleItemAction, loadSection } from '../lib/items.server'
import type { Route } from './+types/environment.config'

export function meta() {
  return [{ title: 'Config · EdgeVault' }]
}

export function loader({ request, params, context }: Route.LoaderArgs) {
  return loadSection({
    request,
    env: context.cloudflare.env,
    workspaceId: params.workspaceId,
    envId: params.envId,
    kind: 'config',
  })
}

export function action({ request, params, context }: Route.ActionArgs) {
  return handleItemAction(request, context.cloudflare.env, params.workspaceId, params.envId)
}

export default function ConfigSection({ loaderData, actionData }: Route.ComponentProps) {
  return <ItemSection kind="config" loaderData={loaderData} actionData={actionData} />
}
