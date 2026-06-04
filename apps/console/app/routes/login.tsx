import { Form, redirect } from 'react-router'
import { setTokenCookie } from '../lib/session.server'
import type { Route } from './+types/login'

export function meta(_: Route.MetaArgs) {
  return [{ title: 'Sign in · EdgeVault' }]
}

export async function action({ request, context }: Route.ActionArgs) {
  const form = await request.formData()
  const email = String(form.get('email') ?? '')
  const password = String(form.get('password') ?? '')
  const intent = String(form.get('intent') ?? 'signin')
  const env = context.cloudflare.env

  const path = intent === 'signup' ? '/sign-up/email' : '/sign-in/email'
  const auth = await env.AUTH_SERVICE.fetch(`https://auth${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (!auth.ok) {
    return { error: intent === 'signup' ? 'Could not create account.' : 'Invalid credentials.' }
  }

  // Exchange the session cookie for a short-lived access token (BFF; server-side).
  const cookie = (auth.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
  const tokenRes = await env.AUTH_SERVICE.fetch('https://auth/token', {
    method: 'POST',
    headers: { cookie },
  })
  const token = ((await tokenRes.json()) as { accessToken?: string }).accessToken
  if (!token) return { error: 'Could not obtain an access token.' }

  return redirect('/', { headers: { 'Set-Cookie': setTokenCookie(token, request) } })
}

export default function Login({ actionData }: Route.ComponentProps) {
  return (
    <main className="shell">
      <section className="hero">
        <p className="eyebrow">EdgeVault Console</p>
        <h1>Sign in</h1>
        <Form method="post" className="form">
          <input name="email" type="email" placeholder="you@example.com" required />
          <input name="password" type="password" placeholder="password" required minLength={8} />
          {actionData?.error && <p className="error-text">{actionData.error}</p>}
          <div className="row">
            <button type="submit" name="intent" value="signin">
              Sign in
            </button>
            <button type="submit" name="intent" value="signup" className="secondary">
              Create account
            </button>
          </div>
        </Form>
      </section>
    </main>
  )
}
