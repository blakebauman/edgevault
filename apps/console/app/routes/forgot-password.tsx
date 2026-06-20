import { Button, Field, Input, StatusNote } from '@edgevault/ui'
import { Form, Link, useNavigation } from 'react-router'
import { ipHeaders } from '../lib/session.server'
import type { Route } from './+types/forgot-password'

export function meta(_: Route.MetaArgs) {
  return [{ title: 'Forgot password · EdgeVault' }]
}

export async function action({ request, context }: Route.ActionArgs) {
  const form = await request.formData()
  const email = String(form.get('email') ?? '')
  // Auth always answers 200 with the same body — the response (and this page)
  // never reveals whether the address has an account.
  await context.cloudflare.env.AUTH_SERVICE.fetch('https://auth/password/forgot', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...ipHeaders(request) },
    body: JSON.stringify({ email }),
  })
  return { sent: true }
}

export default function ForgotPassword({ actionData }: Route.ComponentProps) {
  const navigation = useNavigation()
  return (
    <main className="shell shell-center">
      <section className="hero">
        <p className="eyebrow">EdgeVault Console</p>
        <h1>Reset your password</h1>
        <p className="lede">
          Enter your account email. If it has a password, we'll send a reset link.
        </p>
        <Form method="post" className="mt-6 flex max-w-sm flex-col gap-3">
          <Field label="Email">
            <Input name="email" type="email" placeholder="you@example.com" required autoFocus />
          </Field>
          {actionData?.sent && (
            <StatusNote>
              Check your email — if that address has an account with a password, a reset link is on
              its way. It works for 30 minutes.
            </StatusNote>
          )}
          <div className="flex flex-wrap items-baseline gap-3">
            <Button type="submit" loading={navigation.state !== 'idle'}>
              Send reset link
            </Button>
            <Link to="/login" className="text-xs text-muted-foreground hover:text-accent">
              Back to sign in
            </Link>
          </div>
        </Form>
      </section>
    </main>
  )
}
