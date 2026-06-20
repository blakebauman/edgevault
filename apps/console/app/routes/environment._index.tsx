import { redirect } from 'react-router'
import type { Route } from './+types/environment._index'

/** An environment opens on its Config section. */
export function loader({ params }: Route.LoaderArgs) {
  throw redirect(`/dashboard/${params.workspaceId}/env/${params.envId}/config`)
}
