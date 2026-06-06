import { encryptShareText } from '@edgevault/crypto'
import { Button, ErrorNote, Field, Select, Textarea, TokenBox, TokenValue } from '@edgevault/ui'
import { useRef, useState } from 'react'
import { Link, redirect, useFetcher } from 'react-router'
import { friendlyError } from '../lib/errors'
import { getToken } from '../lib/session.server'
import type { Route } from './+types/share'

/**
 * Zero-knowledge share composer. The value is encrypted IN THE BROWSER with a
 * random AES-GCM key before anything is submitted; the key goes into the URL
 * fragment of the generated link and never reaches any server. The action only
 * ever sees ciphertext.
 */

export function meta(_: Route.MetaArgs) {
  return [{ title: 'Share a secret · EdgeVault' }]
}

export async function loader({ request }: Route.LoaderArgs) {
  const token = getToken(request)
  if (!token) throw redirect('/login')
  return null
}

export async function action({ request, context }: Route.ActionArgs) {
  const token = getToken(request)
  if (!token) throw redirect('/login')
  const form = await request.formData()
  const res = await context.cloudflare.env.API_SERVICE.fetch('https://api/api/v1/shares', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      ciphertext: String(form.get('ciphertext')),
      iv: String(form.get('iv')),
      ttlSeconds: Number(form.get('ttlSeconds')),
      maxViews: Number(form.get('maxViews')),
    }),
  })
  if (!res.ok) return { error: friendlyError(res.status, 'creating the share') }
  const created = (await res.json()) as { id: string; expiresAt: number }
  return { id: created.id, expiresAt: created.expiresAt }
}

const TTL_OPTIONS = [
  { label: '1 hour', value: 3600 },
  { label: '1 day', value: 86400 },
  { label: '7 days', value: 7 * 86400 },
]

export default function ShareComposer(_: Route.ComponentProps) {
  const fetcher = useFetcher<typeof action>()
  const [value, setValue] = useState('')
  const [ttl, setTtl] = useState(86400)
  const [views, setViews] = useState(1)
  // The fragment key exists only in this browser tab, paired to the submission.
  const fragmentKey = useRef<string | null>(null)

  async function onShare() {
    const { ciphertext, iv, fragmentKey: key } = await encryptShareText(value)
    fragmentKey.current = key
    setValue('')
    fetcher.submit(
      { ciphertext, iv, ttlSeconds: String(ttl), maxViews: String(views) },
      { method: 'post' },
    )
  }

  const link =
    fetcher.data && 'id' in fetcher.data && fragmentKey.current
      ? `${window.location.origin}/s/${fetcher.data.id}#${fragmentKey.current}`
      : null

  return (
    <main className="shell">
      <section className="panel">
        <header className="panel-head">
          <div>
            <p className="eyebrow">Share a secret</p>
            <h1>Expiring, zero-knowledge link</h1>
          </div>
          <Button variant="secondary" asChild>
            <Link to="/">← Home</Link>
          </Button>
        </header>

        <p className="text-muted-foreground">
          Encrypted in your browser before upload — the key lives in the link's #fragment, so
          EdgeVault can never read the value. The link burns after the view limit or expiry.
        </p>

        {link ? (
          <TokenBox note="Share this link. It will not be shown again, and the value is unrecoverable without it.">
            <TokenValue>{link}</TokenValue>
          </TokenBox>
        ) : (
          <div className="mt-6 flex max-w-xl flex-col gap-3">
            <Field label="Secret value">
              <Textarea
                value={value}
                onChange={(e) => setValue(e.target.value)}
                rows={5}
                maxLength={32_768}
                placeholder="Paste the value to share…"
                aria-label="Secret value"
              />
            </Field>
            <div className="flex flex-wrap gap-3">
              <Field label="Expires after">
                <Select value={ttl} onChange={(e) => setTtl(Number(e.target.value))}>
                  {TTL_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="View limit">
                <Select value={views} onChange={(e) => setViews(Number(e.target.value))}>
                  {[1, 2, 3, 5, 10].map((n) => (
                    <option key={n} value={n}>
                      {n === 1 ? '1 (burn after reading)' : n}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            {fetcher.data && 'error' in fetcher.data && <ErrorNote>{fetcher.data.error}</ErrorNote>}
            <Button
              type="button"
              onClick={onShare}
              disabled={!value.trim() || fetcher.state !== 'idle'}
              className="self-start"
            >
              {fetcher.state !== 'idle' ? 'Encrypting…' : 'Encrypt & create link'}
            </Button>
          </div>
        )}
      </section>
    </main>
  )
}
