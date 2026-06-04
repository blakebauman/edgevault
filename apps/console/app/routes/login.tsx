import { type FormEvent, useState } from 'react'
import { Form, redirect } from 'react-router'
import { setMfaCookie, setTokenCookie } from '../lib/session.server'
import type { Route } from './+types/login'

export function meta(_: Route.MetaArgs) {
  return [{ title: 'Sign in · EdgeVault' }]
}

const SSO_MESSAGES: Record<string, string> = {
  error: 'Single sign-on could not be completed. Please try again.',
  denied: 'Your identity provider denied the sign-in.',
  unavailable: 'Single sign-on is not enabled for this deployment.',
}

export function loader({ request }: Route.LoaderArgs) {
  const reason = new URL(request.url).searchParams.get('sso')
  const ssoError = reason
    ? (SSO_MESSAGES[reason] ?? 'Single sign-on could not be completed. Please try again.')
    : null
  return { ssoError }
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

  // MFA-enabled accounts get a challenge instead of a session — stash it and
  // send the user to the second-factor prompt.
  const result = (await auth.clone().json()) as { mfaRequired?: boolean; mfaToken?: string }
  if (result.mfaRequired && result.mfaToken) {
    return redirect('/login/mfa', {
      headers: { 'Set-Cookie': setMfaCookie(result.mfaToken, request) },
    })
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

export default function Login({ actionData, loaderData }: Route.ComponentProps) {
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

        <PasskeyButton />
        <SsoForm error={loaderData.ssoError} />
      </section>
    </main>
  )
}

function PasskeyButton() {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onClick() {
    setError(null)
    setBusy(true)
    const { loginWithPasskey } = await import('../lib/passkey')
    const result = await loginWithPasskey()
    if (result.ok) {
      window.location.href = '/'
    } else {
      setError(result.error ?? 'Passkey sign-in failed.')
      setBusy(false)
    }
  }

  return (
    <div className="form">
      <button type="button" className="secondary" onClick={onClick} disabled={busy}>
        {busy ? 'Waiting for passkey…' : 'Sign in with a passkey'}
      </button>
      {error && <p className="error-text">{error}</p>}
    </div>
  )
}

function SsoForm({ error }: { error: string | null }) {
  const [org, setOrg] = useState('')

  function go(protocol: 'sso' | 'saml') {
    const id = org.trim()
    // Full-page navigation so the browser follows the loader's redirect out to
    // the identity provider.
    if (id) window.location.href = `/${protocol}/${encodeURIComponent(id)}/start`
  }

  return (
    <form className="form sso" onSubmit={(e: FormEvent) => e.preventDefault()}>
      <p className="muted">Enterprise SSO</p>
      <input
        value={org}
        onChange={(e) => setOrg(e.target.value)}
        placeholder="organization id"
        aria-label="Organization ID"
      />
      {error && <p className="error-text">{error}</p>}
      <div className="row">
        <button
          type="button"
          className="secondary"
          disabled={!org.trim()}
          onClick={() => go('sso')}
        >
          Sign in with OIDC
        </button>
        <button
          type="button"
          className="secondary"
          disabled={!org.trim()}
          onClick={() => go('saml')}
        >
          Sign in with SAML
        </button>
      </div>
    </form>
  )
}
