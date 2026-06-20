import { ItemSection } from '../components/items'
import { handleItemAction, loadSection } from '../lib/items.server'
import type { Route } from './+types/environment.flags'

export function meta() {
  return [{ title: 'Feature Flags · EdgeVault' }]
}

export function loader({ request, params, context }: Route.LoaderArgs) {
  return loadSection({
    request,
    env: context.cloudflare.env,
    workspaceId: params.workspaceId,
    envId: params.envId,
    kind: 'flag',
  })
}

export function action({ request, params, context }: Route.ActionArgs) {
  return handleItemAction(request, context.cloudflare.env, params.workspaceId, params.envId)
}

export default function FlagsSection({ loaderData, actionData }: Route.ComponentProps) {
  return (
    <ItemSection
      kind="flag"
      loaderData={loaderData}
      actionData={actionData}
      emptyHint="No flags yet. Add one below — an enabled toggle and a rollout percentage are all the SDK's flag() needs."
    />
  )
}
