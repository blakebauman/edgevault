import { Button } from '@edgevault/ui'
import { Link } from 'react-router'
import { ipHeaders } from '../lib/session.server'
import type { Route } from './+types/verify-email'

export function meta(_: Route.MetaArgs) {
  return [{ title: 'Verify email · EdgeVault' }]
}

/**
 * Email-verification landing page. The token arrives as a query param from the
 * emailed link; the loader consumes it server-side (single-use, so a refresh
 * after success shows the invalid state — that's correct, it's been spent).
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const token = new URL(request.url).searchParams.get('token')
  if (!token) return { verified: false as const }

  const res = await context.cloudflare.env.AUTH_SERVICE.fetch('https://auth/verify-email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...ipHeaders(request) },
    body: JSON.stringify({ token }),
  })
  return { verified: res.ok }
}

export default function VerifyEmail({ loaderData }: Route.ComponentProps) {
  return (
    <main className="shell shell-center">
      <section className="hero">
        <p className="eyebrow">EdgeVault Console</p>
        {loaderData.verified ? (
          <>
            <h1>Email verified</h1>
            <p className="lede">
              You're all set — you can now create organizations and accept invitations.
            </p>
            <Button asChild className="mt-4 self-start">
              <Link to="/">Continue →</Link>
            </Button>
          </>
        ) : (
          <>
            <h1>This link didn't work</h1>
            <p className="lede">
              The verification link is invalid, expired, or already used. Sign in and request a
              fresh one from the workspaces page.
            </p>
            <Button asChild className="mt-4 self-start">
              <Link to="/login">Sign in</Link>
            </Button>
          </>
        )}
      </section>
    </main>
  )
}
