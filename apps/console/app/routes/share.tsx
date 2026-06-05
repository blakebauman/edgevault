import { encryptShareText } from '@edgevault/crypto'
import { useRef, useState } from 'react'
import { Link, redirect, useFetcher } from 'react-router'
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
  if (!res.ok) return { error: `Creating the share failed (${res.status})` }
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
          <Link to="/" className="secondary button">
            ← Home
          </Link>
        </header>

        <p className="muted">
          Encrypted in your browser before upload — the key lives in the link's #fragment, so
          EdgeVault can never read the value. The link burns after the view limit or expiry.
        </p>

        {link ? (
          <div className="token-box">
            <p className="token-note">
              Share this link. It will not be shown again, and the value is unrecoverable without
              it.
            </p>
            <code className="token-value">{link}</code>
          </div>
        ) : (
          <div className="form share-form">
            <label>
              Secret value
              <textarea
                value={value}
                onChange={(e) => setValue(e.target.value)}
                rows={5}
                maxLength={32_768}
                placeholder="Paste the value to share…"
                aria-label="Secret value"
              />
            </label>
            <div className="row">
              <label>
                Expires after
                <select value={ttl} onChange={(e) => setTtl(Number(e.target.value))}>
                  {TTL_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                View limit
                <select value={views} onChange={(e) => setViews(Number(e.target.value))}>
                  {[1, 2, 3, 5, 10].map((n) => (
                    <option key={n} value={n}>
                      {n === 1 ? '1 (burn after reading)' : n}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {fetcher.data && 'error' in fetcher.data && (
              <p className="error-text">{fetcher.data.error}</p>
            )}
            <button
              type="button"
              onClick={onShare}
              disabled={!value.trim() || fetcher.state !== 'idle'}
            >
              {fetcher.state !== 'idle' ? 'Encrypting…' : 'Encrypt & create link'}
            </button>
          </div>
        )}
      </section>
    </main>
  )
}
