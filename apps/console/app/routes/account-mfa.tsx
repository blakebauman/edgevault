import { Button, ErrorNote, Field, Input, StatusNote, TokenBox, TokenValue } from '@edgevault/ui'
import { useState } from 'react'
import { Form, Link, redirect } from 'react-router'
import { CopyButton } from '../components/copy-button'
import { getToken, ipHeaders } from '../lib/session.server'
import type { Route } from './+types/account-mfa'

/**
 * Account security: TOTP management (with one-time recovery codes), passkeys,
 * and the active-session (device) list. Authenticated by the console access
 * token, which the BFF forwards as a Bearer to the auth worker.
 */

export function meta(_: Route.MetaArgs) {
  return [{ title: 'Account security · EdgeVault' }]
}

async function authFetch(env: Env, request: Request, token: string, path: string, body?: unknown) {
  return env.AUTH_SERVICE.fetch(`https://auth${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...ipHeaders(request),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

interface SessionRow {
  id: string
  ipAddress: string | null
  userAgent: string | null
  createdAt: string
  expiresAt: string
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const token = getToken(request)
  if (!token) throw redirect('/login')
  const env = context.cloudflare.env
  const [statusRes, sessionsRes] = await Promise.all([
    authFetch(env, request, token, '/mfa/status'),
    authFetch(env, request, token, '/sessions'),
  ])
  const status = statusRes.ok
    ? ((await statusRes.json()) as {
        enabled: boolean
        pending: boolean
        recoveryCodesRemaining: number
      })
    : { enabled: false, pending: false, recoveryCodesRemaining: 0 }
  const sessions = sessionsRes.ok
    ? ((await sessionsRes.json()) as { sessions: SessionRow[] }).sessions
    : []
  return { status, sessions }
}

export async function action({ request, context }: Route.ActionArgs) {
  const token = getToken(request)
  if (!token) throw redirect('/login')
  const env = context.cloudflare.env
  const form = await request.formData()
  const intent = String(form.get('intent') ?? '')

  if (intent === 'setup') {
    const res = await authFetch(env, request, token, '/mfa/totp/setup', {})
    if (!res.ok) return { error: 'Could not start setup.' }
    const { secret, otpauthUri } = (await res.json()) as { secret: string; otpauthUri: string }
    // Render the provisioning QR server-side (zero client JS).
    const { encodeQR } = await import('@paulmillr/qr')
    const qrSvg = encodeQR(otpauthUri, 'svg')
    return { secret, otpauthUri, qrSvg }
  }
  if (intent === 'confirm') {
    const res = await authFetch(env, request, token, '/mfa/totp/confirm', {
      code: String(form.get('code') ?? '').trim(),
    })
    if (!res.ok) return { error: 'That code was not valid.' }
    const { recoveryCodes } = (await res.json()) as { recoveryCodes?: string[] }
    return { confirmed: true as const, recoveryCodes: recoveryCodes ?? [] }
  }
  if (intent === 'disable') {
    const res = await authFetch(env, request, token, '/mfa/totp/disable', {
      code: String(form.get('code') ?? '').trim(),
    })
    return res.ok ? { disabled: true as const } : { error: 'Enter a valid code to disable MFA.' }
  }
  if (intent === 'regenerate-codes') {
    const res = await authFetch(env, request, token, '/mfa/recovery/regenerate', {
      code: String(form.get('code') ?? '').trim(),
    })
    if (!res.ok) return { error: 'Enter a valid code to regenerate recovery codes.' }
    const { recoveryCodes } = (await res.json()) as { recoveryCodes: string[] }
    return { regenerated: true as const, recoveryCodes }
  }
  if (intent === 'revoke-session') {
    const id = String(form.get('sessionId') ?? '')
    const res = await authFetch(env, request, token, `/sessions/${id}/revoke`, {})
    return res.ok ? { revoked: true as const } : { error: 'Could not revoke that session.' }
  }
  if (intent === 'revoke-all-sessions') {
    const res = await authFetch(env, request, token, '/sessions/revoke-all', {})
    return res.ok ? { revoked: true as const } : { error: 'Could not revoke sessions.' }
  }
  return { error: 'Unknown action.' }
}

export default function AccountMfa({ loaderData, actionData }: Route.ComponentProps) {
  const { status, sessions } = loaderData
  const secret = actionData && 'secret' in actionData ? actionData.secret : null
  const otpauthUri = actionData && 'otpauthUri' in actionData ? actionData.otpauthUri : null
  const qrSvg = actionData && 'qrSvg' in actionData ? actionData.qrSvg : null
  const error = actionData && 'error' in actionData ? actionData.error : null
  const confirmed = actionData && 'confirmed' in actionData ? actionData.confirmed : false
  const disabled = actionData && 'disabled' in actionData ? actionData.disabled : false
  const recoveryCodes =
    actionData && 'recoveryCodes' in actionData ? (actionData.recoveryCodes ?? []) : []
  const enabled = (status.enabled || confirmed) && !disabled

  return (
    <main className="shell">
      <section className="panel">
        <header className="panel-head">
          <div>
            <p className="eyebrow">Account security</p>
            <h1>Two-factor authentication</h1>
          </div>
          <Button variant="secondary" asChild>
            <Link to="/">← All workspaces</Link>
          </Button>
        </header>

        {error && <ErrorNote>{error}</ErrorNote>}
        {confirmed && <StatusNote>Two-factor authentication is now enabled.</StatusNote>}
        {disabled && <StatusNote>Two-factor authentication has been disabled.</StatusNote>}

        {recoveryCodes.length > 0 && <RecoveryCodes codes={recoveryCodes} />}

        {enabled ? (
          <>
            <p className="lede">Two-factor authentication is active on your account.</p>
            {status.recoveryCodesRemaining > 0 && recoveryCodes.length === 0 && (
              <p className="text-sm text-muted-foreground">
                {status.recoveryCodesRemaining} recovery code
                {status.recoveryCodesRemaining === 1 ? '' : 's'} remaining.
              </p>
            )}
            <div className="mt-6 flex flex-wrap gap-8">
              <Form method="post" className="flex max-w-sm flex-col gap-3">
                <Field label="Enter a current code to disable">
                  <Input name="code" inputMode="numeric" placeholder="123456" required />
                </Field>
                <Button
                  type="submit"
                  name="intent"
                  value="disable"
                  variant="secondary"
                  className="self-start"
                >
                  Disable 2FA
                </Button>
              </Form>
              <Form method="post" className="flex max-w-sm flex-col gap-3">
                <Field label="Enter a current code for fresh recovery codes">
                  <Input name="code" inputMode="numeric" placeholder="123456" required />
                </Field>
                <Button
                  type="submit"
                  name="intent"
                  value="regenerate-codes"
                  variant="secondary"
                  className="self-start"
                >
                  Regenerate recovery codes
                </Button>
              </Form>
            </div>
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
            <TokenBox note="Secret (or use the otpauth URI):">
              <TokenValue>{secret}</TokenValue>
              <CopyButton value={secret} label="Copy secret" />
            </TokenBox>
            {otpauthUri && (
              <TokenBox note="Full otpauth URI (contains the secret):">
                <TokenValue>{otpauthUri}</TokenValue>
                <CopyButton value={otpauthUri} label="Copy URI" />
              </TokenBox>
            )}
            <Form method="post" className="mt-6 flex max-w-sm flex-col gap-3">
              <Field label="Confirmation code">
                <Input
                  name="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="123456"
                  required
                />
              </Field>
              <Button type="submit" name="intent" value="confirm" className="self-start">
                Confirm &amp; enable
              </Button>
            </Form>
          </>
        ) : (
          <>
            <p className="lede">
              Protect your account with a time-based one-time password from an authenticator app.
            </p>
            <Form method="post">
              <Button type="submit" name="intent" value="setup">
                Set up 2FA
              </Button>
            </Form>
          </>
        )}

        <PasskeySection />
        <SessionsSection sessions={sessions} />
      </section>
    </main>
  )
}

/** Shown exactly once after enable/regenerate — the server keeps only hashes. */
function RecoveryCodes({ codes }: { codes: string[] }) {
  return (
    <div className="assistant">
      <h2>Recovery codes</h2>
      <p className="text-muted-foreground">
        Store these somewhere safe (a password manager, a printout). Each works once if you lose
        your authenticator. This is the only time they're shown.
      </p>
      <TokenBox note="One use each:">
        <TokenValue>
          <span className="grid grid-cols-2 gap-x-8 gap-y-1 font-mono">
            {codes.map((code) => (
              <span key={code}>{code}</span>
            ))}
          </span>
        </TokenValue>
        <CopyButton value={codes.join('\n')} label="Copy all" />
      </TokenBox>
    </div>
  )
}

function SessionsSection({
  sessions,
}: {
  sessions: Array<{
    id: string
    ipAddress: string | null
    userAgent: string | null
    createdAt: string
  }>
}) {
  return (
    <div className="assistant">
      <h2>Active sessions</h2>
      <p className="text-muted-foreground">
        Sign-ins that can still mint access tokens. Revoke anything you don't recognize.
      </p>
      {sessions.length === 0 && (
        <p className="text-sm text-muted-foreground">No active sessions.</p>
      )}
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {sessions.map((s) => (
          <li
            key={s.id}
            className="flex flex-wrap items-baseline justify-between gap-3 rounded-sm border border-border bg-card p-3"
          >
            <span className="flex flex-col">
              <span className="text-sm">{describeUserAgent(s.userAgent)}</span>
              <span className="font-mono text-xs text-muted-foreground">
                {s.ipAddress ?? 'unknown IP'} · since {new Date(s.createdAt).toLocaleDateString()}
              </span>
            </span>
            <Form method="post">
              <input type="hidden" name="intent" value="revoke-session" />
              <input type="hidden" name="sessionId" value={s.id} />
              <Button type="submit" variant="secondary" size="compact">
                Revoke
              </Button>
            </Form>
          </li>
        ))}
      </ul>
      {sessions.length > 0 && (
        <Form method="post">
          <input type="hidden" name="intent" value="revoke-all-sessions" />
          <Button type="submit" variant="secondary">
            Sign out everywhere
          </Button>
        </Form>
      )}
    </div>
  )
}

function describeUserAgent(userAgent: string | null): string {
  if (!userAgent) return 'Unknown device'
  const browser = userAgent.match(/(Firefox|Edg|Chrome|Safari)\/[\d.]+/)?.[1] ?? 'Browser'
  const os = userAgent.match(/\((Macintosh|Windows|Linux|iPhone|iPad|Android)/)?.[1] ?? ''
  return [browser === 'Edg' ? 'Edge' : browser, os && `on ${os}`].filter(Boolean).join(' ')
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
      <p className="text-muted-foreground">
        Add a passkey (Touch ID, Windows Hello, a security key) for phishing-resistant sign-in.
      </p>
      {status.kind === 'ok' && <StatusNote>{status.message}</StatusNote>}
      {status.kind === 'error' && <ErrorNote>{status.message}</ErrorNote>}
      <Button type="button" onClick={onAdd} disabled={busy}>
        {busy ? 'Waiting for passkey…' : 'Add a passkey'}
      </Button>
    </div>
  )
}
