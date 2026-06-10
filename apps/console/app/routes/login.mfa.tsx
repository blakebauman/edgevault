import { Button, ErrorNote, Input } from '@edgevault/ui'
import { Form, redirect } from 'react-router'
import {
  clearMfaCookie,
  getMfaToken,
  ipHeaders,
  safeRelativePath,
  setTokenCookie,
} from '../lib/session.server'
import type { Route } from './+types/login.mfa'

export function meta(_: Route.MetaArgs) {
  return [{ title: 'Two-factor authentication · EdgeVault' }]
}

export function loader({ request }: Route.LoaderArgs) {
  // No challenge in flight → back to sign-in.
  if (!getMfaToken(request)) throw redirect('/login')
  // Post-sign-in destination, carried through from the password leg.
  return { next: safeRelativePath(new URL(request.url).searchParams.get('next')) }
}

export async function action({ request, context }: Route.ActionArgs) {
  const mfaToken = getMfaToken(request)
  if (!mfaToken) throw redirect('/login')
  const env = context.cloudflare.env
  const form = await request.formData()
  const code = String(form.get('code') ?? '').trim()
  const useRecovery = String(form.get('method') ?? '') === 'recovery'
  const next = safeRelativePath(String(form.get('next') ?? '')) ?? '/'
  if (!code) {
    return {
      error: useRecovery
        ? 'Enter one of your recovery codes.'
        : 'Enter the 6-digit code from your authenticator.',
    }
  }

  const path = useRecovery ? '/mfa/recovery/authenticate' : '/mfa/totp/authenticate'
  const res = await env.AUTH_SERVICE.fetch(`https://auth${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...ipHeaders(request) },
    body: JSON.stringify({ mfaToken, code }),
  })
  if (!res.ok) return { error: 'That code was not valid. Try again.' }

  // Exchange the new session cookie for an access token, like password sign-in.
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
  const tokenRes = await env.AUTH_SERVICE.fetch('https://auth/token', {
    method: 'POST',
    headers: { cookie, ...ipHeaders(request) },
  })
  const token = ((await tokenRes.json()) as { accessToken?: string }).accessToken
  if (!token) return { error: 'Could not complete sign-in. Please try again.' }

  const headers = new Headers()
  headers.append('Set-Cookie', setTokenCookie(token, request))
  headers.append('Set-Cookie', clearMfaCookie(request))
  return redirect(next, { headers })
}

export default function LoginMfa({ actionData, loaderData }: Route.ComponentProps) {
  return (
    <main className="shell">
      <section className="hero">
        <p className="eyebrow">EdgeVault Console</p>
        <h1>Two-factor authentication</h1>
        <p className="lede">Enter the 6-digit code from your authenticator app.</p>
        <Form method="post" className="mt-6 flex max-w-sm flex-col gap-3">
          {loaderData.next && <input type="hidden" name="next" value={loaderData.next} />}
          <Input
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="123456"
            aria-label="Authentication code"
            required
          />
          {actionData?.error && <ErrorNote>{actionData.error}</ErrorNote>}
          <Button type="submit" className="self-start">
            Verify
          </Button>
        </Form>

        <details className="more-auth">
          <summary>Lost your authenticator? Use a recovery code</summary>
          <Form method="post" className="mt-4 flex max-w-sm flex-col gap-3">
            {loaderData.next && <input type="hidden" name="next" value={loaderData.next} />}
            <input type="hidden" name="method" value="recovery" />
            <Input
              name="code"
              autoComplete="off"
              placeholder="xxxxx-xxxxx"
              aria-label="Recovery code"
              required
            />
            <p className="m-0 text-xs text-muted-foreground">
              Each recovery code works once. Signing in this way signs out every other session.
            </p>
            <Button type="submit" variant="secondary" className="self-start">
              Use recovery code
            </Button>
          </Form>
        </details>
      </section>
    </main>
  )
}
