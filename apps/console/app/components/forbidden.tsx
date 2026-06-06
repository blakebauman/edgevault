import { Button } from '@edgevault/ui'
import { Link } from 'react-router'

/** A 403 that helps instead of stonewalls: says who can act, and offers the
 * way back. Rendered by org-admin pages when the viewer is a member. */
export function Forbidden({ subject, backTo = '/' }: { subject: string; backTo?: string }) {
  return (
    <div className="mt-2 max-w-prose">
      <p className="m-0 text-sm text-destructive" role="alert">
        Only organization owners or admins can {subject}.
      </p>
      <p className="mt-2 text-sm text-muted-foreground">
        Ask an owner to make this change, or to grant you the admin role if this is part of your
        job.
      </p>
      <Button variant="secondary" asChild className="mt-3">
        <Link to={backTo}>← Back to workspaces</Link>
      </Button>
    </div>
  )
}
