import { useState } from 'react'
import { Form, Link, redirect } from 'react-router'
import { getToken } from '../lib/session.server'
import type { Route } from './+types/account-mfa'

/**
 * User MFA (TOTP) management. Authenticated by the console access token, which
 * the BFF forwards as a Bearer to the auth worker's MFA endpoints. The secret is
 * shown once at setup (for the authenticator app) and confirmed with a code.
 */

export function meta(_: Route.MetaArgs) {
  return [{ title: 'Two-factor authentication · EdgeVault' }]
}

async function authFetch(env: Env, token: string, path: string, body?: unknown) {
  return env.AUTH_SERVICE.fetch(`https://auth${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const token = getToken(request)
  if (!token) throw redirect('/login')
  const res = await authFetch(context.cloudflare.env, token, '/mfa/status')
  const status = res.ok
    ? ((await res.json()) as { enabled: boolean; pending: boolean })
    : { enabled: false, pending: false }
  return { status }
}

export async function action({ request, context }: Route.ActionArgs) {
  const token = getToken(request)
  if (!token) throw redirect('/login')
  const env = context.cloudflare.env
  const form = await request.formData()
  const intent = String(form.get('intent') ?? '')

  if (intent === 'setup') {
    const res = await authFetch(env, token, '/mfa/totp/setup', {})
    if (!res.ok) return { error: 'Could not start setup.' }
    const { secret, otpauthUri } = (await res.json()) as { secret: string; otpauthUri: string }
    // Render the provisioning QR server-side (zero client JS).
    const { encodeQR } = await import('@paulmillr/qr')
    const qrSvg = encodeQR(otpauthUri, 'svg')
    return { secret, otpauthUri, qrSvg }
  }
  if (intent === 'confirm') {
    const res = await authFetch(env, token, '/mfa/totp/confirm', {
      code: String(form.get('code') ?? '').trim(),
    })
    return res.ok ? { confirmed: true as const } : { error: 'That code was not valid.' }
  }
  if (intent === 'disable') {
    const res = await authFetch(env, token, '/mfa/totp/disable', {
      code: String(form.get('code') ?? '').trim(),
    })
    return res.ok ? { disabled: true as const } : { error: 'Enter a valid code to disable MFA.' }
  }
  return { error: 'Unknown action.' }
}

export default function AccountMfa({ loaderData, actionData }: Route.ComponentProps) {
  const { status } = loaderData
  const secret = actionData && 'secret' in actionData ? actionData.secret : null
  const otpauthUri = actionData && 'otpauthUri' in actionData ? actionData.otpauthUri : null
  const qrSvg = actionData && 'qrSvg' in actionData ? actionData.qrSvg : null
  const error = actionData && 'error' in actionData ? actionData.error : null
  const confirmed = actionData && 'confirmed' in actionData ? actionData.confirmed : false
  const disabled = actionData && 'disabled' in actionData ? actionData.disabled : false
  const enabled = (status.enabled || confirmed) && !disabled

  return (
    <main className="shell">
      <section className="panel">
        <header className="panel-head">
          <div>
            <p className="eyebrow">Account security</p>
            <h1>Two-factor authentication</h1>
          </div>
          <Link to="/" className="secondary button">
            ← All workspaces
          </Link>
        </header>

        {error && <p className="error-text">{error}</p>}
        {confirmed && <p className="muted">Two-factor authentication is now enabled.</p>}
        {disabled && <p className="muted">Two-factor authentication has been disabled.</p>}

        {enabled ? (
          <>
            <p className="lede">Two-factor authentication is active on your account.</p>
            <Form method="post" className="form">
              <label>
                Enter a current code to disable
                <input name="code" inputMode="numeric" placeholder="123456" required />
              </label>
              <button type="submit" name="intent" value="disable" className="secondary">
                Disable 2FA
              </button>
            </Form>
          </>
        ) : secret ? (
          <>
            <p className="lede">
              Scan this QR with your authenticator app (or enter the secret manually), then enter a
              code to confirm.
            </p>
            {qrSvg && (
              <div
                className="qr"
                // The SVG is generated server-side from the otpauth URI (@paulmillr/qr).
                // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted, self-generated SVG
                dangerouslySetInnerHTML={{ __html: qrSvg }}
              />
            )}
            <div className="token-box">
              <p className="token-note">Secret (or use the otpauth URI):</p>
              <code className="token-value">{secret}</code>
            </div>
            {otpauthUri && (
              <div className="token-box">
                <code className="token-value">{otpauthUri}</code>
              </div>
            )}
            <Form method="post" className="form" style={{ marginTop: '1rem' }}>
              <label>
                Confirmation code
                <input
                  name="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="123456"
                  required
                />
              </label>
              <button type="submit" name="intent" value="confirm">
                Confirm &amp; enable
              </button>
            </Form>
          </>
        ) : (
          <>
            <p className="lede">
              Protect your account with a time-based one-time password from an authenticator app.
            </p>
            <Form method="post">
              <button type="submit" name="intent" value="setup">
                Set up 2FA
              </button>
            </Form>
          </>
        )}

        <PasskeySection />
      </section>
    </main>
  )
}

function PasskeySection() {
  const [status, setStatus] = useState<{ kind: 'idle' | 'ok' | 'error'; message?: string }>({
    kind: 'idle',
  })
  const [busy, setBusy] = useState(false)

  async function onAdd() {
    setBusy(true)
    setStatus({ kind: 'idle' })
    const { registerPasskey } = await import('../lib/passkey')
    const result = await registerPasskey()
    setStatus(
      result.ok
        ? { kind: 'ok', message: 'Passkey added. You can now sign in with it.' }
        : { kind: 'error', message: result.error ?? 'Could not add passkey.' },
    )
    setBusy(false)
  }

  return (
    <div className="assistant">
      <h2>Passkeys</h2>
      <p className="muted">
        Add a passkey (Touch ID, Windows Hello, a security key) for phishing-resistant sign-in.
      </p>
      {status.kind === 'ok' && <p className="muted">{status.message}</p>}
      {status.kind === 'error' && <p className="error-text">{status.message}</p>}
      <button type="button" onClick={onAdd} disabled={busy}>
        {busy ? 'Waiting for passkey…' : 'Add a passkey'}
      </button>
    </div>
  )
}
