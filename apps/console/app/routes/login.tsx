import { Button, ErrorNote, Field, Input, StatusNote } from '@edgevault/ui'
import { type FormEvent, useState } from 'react'
import { Form, redirect, useNavigation } from 'react-router'
import { ipHeaders, safeRelativePath, setMfaCookie, setTokenCookie } from '../lib/session.server'
import type { Route } from './+types/login'

export function meta(_: Route.MetaArgs) {
  return [{ title: 'Sign in · EdgeVault' }]
}

const SSO_MESSAGES: Record<string, string> = {
  error: 'Single sign-on could not be completed. Please try again.',
  denied: 'Your identity provider denied the sign-in.',
  unavailable: 'Single sign-on is not enabled for this deployment.',
}

/** Append a validated relative ?next= to an auth-start URL, so every sign-in
 * path (not just password) lands the user where they were headed. */
function withNext(path: string, next: string | null): string {
  return next ? `${path}?next=${encodeURIComponent(next)}` : path
}

export function loader({ request }: Route.LoaderArgs) {
  const params = new URL(request.url).searchParams
  const reason = params.get('sso')
  const ssoError = reason
    ? (SSO_MESSAGES[reason] ?? 'Single sign-on could not be completed. Please try again.')
    : null
  const notice =
    params.get('signup') === 'sent'
      ? 'Check your email — we sent you what you need to continue.'
      : params.get('reset') === 'done'
        ? 'Password updated. Sign in with your new password.'
        : null
  // Where to land after sign-in (e.g. an invitation accept page). Relative
  // paths only — validated again in the action.
  return { ssoError, notice, next: safeRelativePath(params.get('next')) }
}

export async function action({ request, context }: Route.ActionArgs) {
  const form = await request.formData()
  const email = String(form.get('email') ?? '')
  const password = String(form.get('password') ?? '')
  const intent = String(form.get('intent') ?? 'signin')
  const next = safeRelativePath(String(form.get('next') ?? '')) ?? '/'
  const env = context.cloudflare.env

  const path = intent === 'signup' ? '/sign-up/email' : '/sign-in/email'
  const auth = await env.AUTH_SERVICE.fetch(`https://auth${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...ipHeaders(request) },
    body: JSON.stringify({ email, password }),
  })
  if (!auth.ok) {
    return { error: intent === 'signup' ? 'Could not create account.' : 'Invalid credentials.' }
  }

  // MFA-enabled accounts get a challenge instead of a session — stash it and
  // send the user to the second-factor prompt.
  const result = (await auth.clone().json()) as { mfaRequired?: boolean; mfaToken?: string }
  if (result.mfaRequired && result.mfaToken) {
    return redirect(`/login/mfa${next !== '/' ? `?next=${encodeURIComponent(next)}` : ''}`, {
      headers: { 'Set-Cookie': setMfaCookie(result.mfaToken, request) },
    })
  }

  // Exchange the session cookie for a short-lived access token (BFF; server-side).
  const cookie = (auth.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
  const tokenRes = await env.AUTH_SERVICE.fetch('https://auth/token', {
    method: 'POST',
    headers: { cookie, ...ipHeaders(request) },
  })
  const tokenBody = (await tokenRes.json()) as { accessToken?: string; error?: string }
  const token = tokenBody.accessToken
  if (!token) {
    // Signup returns a success-shaped response whether or not the account was
    // new (no enumeration); only a genuinely new account carries a session.
    // The other path means "you already have an account" — the email says so.
    if (intent === 'signup') return redirect('/login?signup=sent')
    if (tokenBody.error === 'sso_required_by_org') {
      return {
        error:
          'Your organization requires signing in through its identity provider — use Enterprise SSO below.',
      }
    }
    if (tokenBody.error === 'mfa_required_by_org') {
      return {
        error:
          'Your organization requires two-factor authentication. Add it under Account security, then sign in again.',
      }
    }
    return { error: 'Could not obtain an access token.' }
  }

  return redirect(next, { headers: { 'Set-Cookie': setTokenCookie(token, request) } })
}

export default function Login({ actionData, loaderData }: Route.ComponentProps) {
  const navigation = useNavigation()
  const pendingIntent = navigation.state !== 'idle' ? navigation.formData?.get('intent') : null
  return (
    <main className="shell shell-center">
      <section className="hero">
        <p className="eyebrow">EdgeVault Console</p>
        <h1>Sign in</h1>
        <Form method="post" className="mt-6 flex max-w-sm flex-col gap-3">
          {loaderData.next && <input type="hidden" name="next" value={loaderData.next} />}
          <Field label="Email">
            <Input name="email" type="email" placeholder="you@example.com" required autoFocus />
          </Field>
          <Field label="Password">
            <Input name="password" type="password" placeholder="••••••••" required minLength={8} />
          </Field>
          {actionData?.error && <ErrorNote>{actionData.error}</ErrorNote>}
          {loaderData.notice && <StatusNote>{loaderData.notice}</StatusNote>}
          <div className="flex flex-wrap gap-3">
            <Button type="submit" name="intent" value="signin" loading={pendingIntent === 'signin'}>
              Sign in
            </Button>
            <Button
              type="submit"
              name="intent"
              value="signup"
              variant="linklike"
              className="more-auth-alt"
              loading={pendingIntent === 'signup'}
            >
              New here? Create an account
            </Button>
          </div>
          <a href="/forgot-password" className="text-xs text-muted-foreground hover:text-accent">
            Forgot your password?
          </a>
        </Form>

        <details className="more-auth">
          <summary>More sign-in options</summary>
          <div className="mt-4 flex flex-col gap-3">
            <p className="m-0 text-sm text-muted-foreground">Continue with</p>
            <div className="flex flex-wrap gap-3">
              <Button variant="secondary" asChild>
                <a href={withNext('/oauth/github/start', loaderData.next)}>GitHub</a>
              </Button>
              <Button variant="secondary" asChild>
                <a href={withNext('/oauth/google/start', loaderData.next)}>Google</a>
              </Button>
            </div>
          </div>
          <PasskeyButton next={loaderData.next} />
          <SsoForm error={loaderData.ssoError} next={loaderData.next} />
        </details>
      </section>
    </main>
  )
}

function PasskeyButton({ next }: { next: string | null }) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onClick() {
    setError(null)
    setBusy(true)
    const { loginWithPasskey } = await import('../lib/passkey')
    const result = await loginWithPasskey()
    if (result.ok) {
      window.location.href = next ?? '/'
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
        loading={busy}
      >
        {busy ? 'Waiting for passkey…' : 'Sign in with a passkey'}
      </Button>
      {error && <ErrorNote>{error}</ErrorNote>}
    </div>
  )
}

function SsoForm({ error, next }: { error: string | null; next: string | null }) {
  const [org, setOrg] = useState('')

  function go(protocol: 'sso' | 'saml') {
    const id = org.trim()
    // Full-page navigation so the browser follows the loader's redirect out to
    // the identity provider.
    if (id) window.location.href = withNext(`/${protocol}/${encodeURIComponent(id)}/start`, next)
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
