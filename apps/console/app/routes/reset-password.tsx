import { Button, ErrorNote, Field, Input } from '@edgevault/ui'
import { Form, Link, redirect } from 'react-router'
import { ipHeaders } from '../lib/session.server'
import type { Route } from './+types/reset-password'

export function meta(_: Route.MetaArgs) {
  return [{ title: 'Reset password · EdgeVault' }]
}

export function loader({ request }: Route.LoaderArgs) {
  return { token: new URL(request.url).searchParams.get('token') }
}

export async function action({ request, context }: Route.ActionArgs) {
  const form = await request.formData()
  const token = String(form.get('token') ?? '')
  const newPassword = String(form.get('newPassword') ?? '')
  if (newPassword !== String(form.get('confirmPassword') ?? '')) {
    return { error: "Those passwords don't match." }
  }

  const res = await context.cloudflare.env.AUTH_SERVICE.fetch('https://auth/password/reset', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...ipHeaders(request) },
    body: JSON.stringify({ token, newPassword }),
  })
  if (!res.ok) {
    return { error: 'That reset link is invalid, expired, or already used. Request a new one.' }
  }
  // The reset revoked every session; a fresh sign-in (incl. MFA) is required.
  return redirect('/login?reset=done')
}

export default function ResetPassword({ loaderData, actionData }: Route.ComponentProps) {
  if (!loaderData.token) {
    return (
      <main className="shell shell-center">
        <section className="hero">
          <p className="eyebrow">EdgeVault Console</p>
          <h1>Missing reset link</h1>
          <p className="lede">Open the link from your email, or request a new one.</p>
          <Button asChild className="mt-4 self-start">
            <Link to="/forgot-password">Request a reset link</Link>
          </Button>
        </section>
      </main>
    )
  }

  return (
    <main className="shell shell-center">
      <section className="hero">
        <p className="eyebrow">EdgeVault Console</p>
        <h1>Choose a new password</h1>
        <p className="lede">Setting it signs you out everywhere — sign in fresh afterwards.</p>
        <Form method="post" className="mt-6 flex max-w-sm flex-col gap-3">
          <input type="hidden" name="token" value={loaderData.token} />
          <Field label="New password">
            <Input
              name="newPassword"
              type="password"
              placeholder="••••••••"
              required
              minLength={8}
              autoFocus
            />
          </Field>
          <Field label="Confirm new password">
            <Input
              name="confirmPassword"
              type="password"
              placeholder="••••••••"
              required
              minLength={8}
            />
          </Field>
          {actionData?.error && <ErrorNote>{actionData.error}</ErrorNote>}
          <Button type="submit" className="self-start">
            Set new password
          </Button>
        </Form>
      </section>
    </main>
  )
}
