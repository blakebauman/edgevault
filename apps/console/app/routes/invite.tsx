import { Button, Chip, ErrorNote, StatusNote } from '@edgevault/ui'
import { Form, Link, redirect } from 'react-router'
import { LocalTime } from '../components/local-time'
import { getToken } from '../lib/session.server'
import type { Route } from './+types/invite'

/**
 * Invitation accept page — the destination of the emailed link. The api binds
 * every read and the accept to the signed-in account's email, so a link that
 * reaches the wrong inbox shows nothing and redeems nothing.
 */

interface Invitation {
  organizationName: string
  email: string
  role: string
  inviterName: string | null
  status: 'pending' | 'accepted' | 'revoked' | 'expired'
  expiresAt: string
}

export function meta(_: Route.MetaArgs) {
  return [{ title: 'Invitation · EdgeVault' }]
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const token = getToken(request)
  // Sign in (or sign up) first, then come straight back here.
  if (!token) throw redirect(`/login?next=${encodeURIComponent(`/invite/${params.id}`)}`)

  const res = await context.cloudflare.env.API_SERVICE.fetch(
    `https://api/api/v1/invitations/${params.id}`,
    { headers: { authorization: `Bearer ${token}` } },
  )
  if (res.status === 401) {
    throw redirect(`/login?next=${encodeURIComponent(`/invite/${params.id}`)}`)
  }
  if (!res.ok) return { invitation: null }
  const { invitation } = (await res.json()) as { invitation: Invitation }
  return { invitation }
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const token = getToken(request)
  if (!token) throw redirect(`/login?next=${encodeURIComponent(`/invite/${params.id}`)}`)

  const res = await context.cloudflare.env.API_SERVICE.fetch(
    `https://api/api/v1/invitations/${params.id}/accept`,
    { method: 'POST', headers: { authorization: `Bearer ${token}` } },
  )
  if (res.ok) {
    // Land on home with a one-shot welcome; home resolves the id to a name.
    const body = (await res.json().catch(() => null)) as { organizationId?: string } | null
    return redirect(
      body?.organizationId ? `/?joined=${encodeURIComponent(body.organizationId)}` : '/',
    )
  }
  const body = (await res.json().catch(() => null)) as { error?: string } | null
  const error =
    body?.error === 'expired'
      ? 'This invitation has expired — ask your admin to send a fresh one.'
      : body?.error === 'revoked'
        ? 'This invitation was revoked.'
        : body?.error === 'already_accepted'
          ? 'This invitation was already accepted.'
          : 'This invitation could not be accepted.'
  return { error }
}

export default function Invite({ loaderData, actionData }: Route.ComponentProps) {
  const { invitation } = loaderData

  if (!invitation) {
    return (
      <main className="shell shell-center">
        <section className="hero">
          <p className="eyebrow">Invitation</p>
          <h1>Nothing here for this account</h1>
          <p className="lede mt-4 max-w-prose">
            This invitation doesn't exist, was revoked, or was sent to a different email address.
            Invitations only work for the address they were sent to — if it arrived in another
            inbox, sign out and sign back in with that account.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Button variant="secondary" asChild>
              <Link to="/logout">Sign out</Link>
            </Button>
            <Button variant="linklike" asChild>
              <Link to="/">Go to your workspaces</Link>
            </Button>
          </div>
        </section>
      </main>
    )
  }

  const dead = invitation.status !== 'pending'
  return (
    <main className="shell shell-center">
      <section className="hero">
        <p className="eyebrow">Invitation</p>
        <h1>Join {invitation.organizationName}</h1>
        <p className="lede mt-4 max-w-prose">
          {invitation.inviterName ?? 'A teammate'} invited <strong>{invitation.email}</strong> to
          join <strong>{invitation.organizationName}</strong> as{' '}
          <Chip variant="neutral">{invitation.role}</Chip>.
        </p>
        {invitation.status === 'pending' && (
          <p className="mt-2 text-sm text-muted-foreground">
            Works until <LocalTime epoch={Date.parse(invitation.expiresAt)} />.
          </p>
        )}

        {invitation.status === 'expired' && (
          <StatusNote>This invitation has expired — ask your admin to send a fresh one.</StatusNote>
        )}
        {invitation.status === 'revoked' && <StatusNote>This invitation was revoked.</StatusNote>}
        {invitation.status === 'accepted' && (
          <StatusNote>
            Already accepted — <Link to="/">your workspaces are this way</Link>.
          </StatusNote>
        )}
        {actionData?.error && <ErrorNote>{actionData.error}</ErrorNote>}

        {!dead && (
          <Form method="post" className="mt-6">
            <Button type="submit">Accept invitation</Button>
          </Form>
        )}
      </section>
    </main>
  )
}
