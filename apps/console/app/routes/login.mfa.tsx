import { Form, redirect } from 'react-router'
import { clearMfaCookie, getMfaToken, setTokenCookie } from '../lib/session.server'
import type { Route } from './+types/login.mfa'

export function meta(_: Route.MetaArgs) {
  return [{ title: 'Two-factor authentication · EdgeVault' }]
}

export function loader({ request }: Route.LoaderArgs) {
  // No challenge in flight → back to sign-in.
  if (!getMfaToken(request)) throw redirect('/login')
  return null
}

export async function action({ request, context }: Route.ActionArgs) {
  const mfaToken = getMfaToken(request)
  if (!mfaToken) throw redirect('/login')
  const env = context.cloudflare.env
  const code = String((await request.formData()).get('code') ?? '').trim()
  if (!code) return { error: 'Enter the 6-digit code from your authenticator.' }

  const res = await env.AUTH_SERVICE.fetch('https://auth/mfa/totp/authenticate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mfaToken, code }),
  })
  if (!res.ok) return { error: 'That code was not valid. Try again.' }

  // Exchange the new session cookie for an access token, like password sign-in.
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
  const tokenRes = await env.AUTH_SERVICE.fetch('https://auth/token', {
    method: 'POST',
    headers: { cookie },
  })
  const token = ((await tokenRes.json()) as { accessToken?: string }).accessToken
  if (!token) return { error: 'Could not complete sign-in. Please try again.' }

  const headers = new Headers()
  headers.append('Set-Cookie', setTokenCookie(token, request))
  headers.append('Set-Cookie', clearMfaCookie(request))
  return redirect('/', { headers })
}

export default function LoginMfa({ actionData }: Route.ComponentProps) {
  return (
    <main className="shell">
      <section className="hero">
        <p className="eyebrow">EdgeVault Console</p>
        <h1>Two-factor authentication</h1>
        <p className="lede">Enter the 6-digit code from your authenticator app.</p>
        <Form method="post" className="form">
          <input
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="123456"
            aria-label="Authentication code"
            required
          />
          {actionData?.error && <p className="error-text">{actionData.error}</p>}
          <button type="submit">Verify</button>
        </Form>
      </section>
    </main>
  )
}
