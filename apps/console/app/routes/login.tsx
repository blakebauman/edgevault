import { Button, ErrorNote, Field, Input } from '@edgevault/ui'
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
    <main className="shell shell-center">
      <section className="hero">
        <p className="eyebrow">EdgeVault Console</p>
        <h1>Sign in</h1>
        <Form method="post" className="mt-6 flex max-w-sm flex-col gap-3">
          <Field label="Email">
            <Input name="email" type="email" placeholder="you@example.com" required autoFocus />
          </Field>
          <Field label="Password">
            <Input name="password" type="password" placeholder="••••••••" required minLength={8} />
          </Field>
          {actionData?.error && <ErrorNote>{actionData.error}</ErrorNote>}
          <div className="flex flex-wrap gap-3">
            <Button type="submit" name="intent" value="signin">
              Sign in
            </Button>
            <Button
              type="submit"
              name="intent"
              value="signup"
              variant="linklike"
              className="more-auth-alt"
            >
              New here? Create an account
            </Button>
          </div>
        </Form>

        <details className="more-auth">
          <summary>More sign-in options</summary>
          <div className="mt-4 flex flex-col gap-3">
            <p className="m-0 text-sm text-muted-foreground">Continue with</p>
            <div className="flex flex-wrap gap-3">
              <Button variant="secondary" asChild>
                <a href="/oauth/github/start">GitHub</a>
              </Button>
              <Button variant="secondary" asChild>
                <a href="/oauth/google/start">Google</a>
              </Button>
            </div>
          </div>
          <PasskeyButton />
          <SsoForm error={loaderData.ssoError} />
        </details>
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
    <div className="mt-4 flex flex-col gap-3">
      <Button
        type="button"
        variant="secondary"
        className="self-start"
        onClick={onClick}
        disabled={busy}
      >
        {busy ? 'Waiting for passkey…' : 'Sign in with a passkey'}
      </Button>
      {error && <ErrorNote>{error}</ErrorNote>}
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
    <form
      className="mt-4 flex max-w-sm flex-col gap-3"
      onSubmit={(e: FormEvent) => e.preventDefault()}
    >
      <p className="text-muted-foreground">Enterprise SSO</p>
      <Input
        value={org}
        onChange={(e) => setOrg(e.target.value)}
        placeholder="your-org-slug"
        aria-label="Organization slug"
      />
      <p className="m-0 text-xs text-muted-foreground">
        The short name your org signs in with — your admin can share it from the SSO page.
      </p>
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="flex flex-wrap gap-3">
        <Button type="button" variant="secondary" disabled={!org.trim()} onClick={() => go('sso')}>
          Sign in with OIDC
        </Button>
        <Button type="button" variant="secondary" disabled={!org.trim()} onClick={() => go('saml')}>
          Sign in with SAML
        </Button>
      </div>
    </form>
  )
}
