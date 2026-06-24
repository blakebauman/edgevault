import { Button } from '@edgevault/ui'
import { Link } from 'react-router'
import { AuthLayout } from '../components/auth-layout'
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
    <AuthLayout
      title={loaderData.verified ? 'Email verified' : "This link didn't work"}
      subtitle={
        loaderData.verified
          ? "You're all set — you can now create organizations and accept invitations."
          : 'The verification link is invalid, expired, or already used. Sign in and request a fresh one from the workspaces page.'
      }
    >
      <Button asChild className="mt-6 self-start">
        <Link to={loaderData.verified ? '/' : '/login'}>
          {loaderData.verified ? 'Continue →' : 'Sign in'}
        </Link>
      </Button>
    </AuthLayout>
  )
}
