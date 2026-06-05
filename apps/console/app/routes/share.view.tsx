import { decryptShareText } from '@edgevault/crypto'
import { useState } from 'react'
import { useFetcher } from 'react-router'
import type { Route } from './+types/share.view'

/**
 * Public share viewer (recipients have no account). The reveal is an explicit
 * click — never on page load — so link previews and crawlers can't burn a view.
 * The action proxies the consume to the api worker over the service binding
 * with the shared INTERNAL_TOKEN; decryption happens here in the browser with
 * the key from the URL fragment, which no server ever received.
 */

export function meta(_: Route.MetaArgs) {
  return [{ title: 'Shared secret · EdgeVault' }]
}

export async function action({ params, context }: Route.ActionArgs) {
  const env = context.cloudflare.env
  const res = await env.API_SERVICE.fetch(`https://api/internal/shares/${params.id}/consume`, {
    method: 'POST',
    headers: { 'x-internal-token': env.INTERNAL_TOKEN },
  })
  if (!res.ok) return { gone: true as const }
  const share = (await res.json()) as { ciphertext: string; iv: string; remainingViews: number }
  return { gone: false as const, ...share }
}

export default function ShareViewer(_: Route.ComponentProps) {
  const fetcher = useFetcher<typeof action>()
  const [plaintext, setPlaintext] = useState<string | null>(null)
  const [decryptError, setDecryptError] = useState<string | null>(null)

  async function onData(data: NonNullable<typeof fetcher.data>) {
    if (data.gone) return
    const fragmentKey = window.location.hash.slice(1)
    if (!fragmentKey) {
      setDecryptError('This link is missing its #key fragment — ask the sender to re-copy it.')
      return
    }
    try {
      setPlaintext(await decryptShareText(data.ciphertext, data.iv, fragmentKey))
    } catch {
      setDecryptError('Decryption failed — the link is corrupted or the key fragment is wrong.')
    }
  }

  // Decrypt exactly once when the consume comes back.
  if (fetcher.data && !plaintext && !decryptError && !fetcher.data.gone) {
    void onData(fetcher.data)
  }

  const gone = fetcher.data?.gone === true

  return (
    <main className="shell">
      <section className="panel share-viewer">
        <p className="eyebrow">EdgeVault</p>
        <h1>Someone shared a secret with you</h1>

        {plaintext !== null ? (
          <>
            <p className="muted">
              Copy it now
              {fetcher.data && !fetcher.data.gone && fetcher.data.remainingViews === 0
                ? ' — this link is now burned and cannot be opened again.'
                : '.'}
            </p>
            <pre className="share-plaintext">{plaintext}</pre>
            <button type="button" onClick={() => navigator.clipboard.writeText(plaintext)}>
              Copy to clipboard
            </button>
          </>
        ) : gone ? (
          <p className="error-text">
            This link has expired, reached its view limit, or never existed.
          </p>
        ) : decryptError ? (
          <p className="error-text">{decryptError}</p>
        ) : (
          <>
            <p className="muted">
              Revealing consumes one view — for burn-after-reading links, the secret is shown
              exactly once. It decrypts in your browser; the server only stores ciphertext.
            </p>
            <fetcher.Form method="post">
              <button type="submit" disabled={fetcher.state !== 'idle'}>
                {fetcher.state !== 'idle' ? 'Revealing…' : 'Reveal secret'}
              </button>
            </fetcher.Form>
          </>
        )}
      </section>
    </main>
  )
}
