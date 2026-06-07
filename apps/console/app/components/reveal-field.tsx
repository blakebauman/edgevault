import { Button, TokenBox, TokenValue } from '@edgevault/ui'
import { useEffect, useState } from 'react'
import { CopyButton } from './copy-button'

/** Wipe a copied secret from the clipboard 30s after a copy. */
const CLIPBOARD_CLEAR_MS = 30_000
/** A fixed-width mask — never sized to the value, so it doesn't leak length. */
const MASK = '••••••••••••••••'

/**
 * A revealed secret, handled with care: masked by default, shown only on an
 * explicit toggle, re-masked the moment the window loses focus (alt-tab, screen
 * share, lock), and copied with an auto-clearing clipboard. The plaintext lives
 * only in this component's props for as long as it's mounted — the parent drops
 * it on a timer and on navigate; nothing here persists it.
 */
export function RevealField({
  secretKey,
  value,
  onDismiss,
}: {
  secretKey: string
  value: string
  onDismiss: () => void
}) {
  const [shown, setShown] = useState(false)

  // Re-mask on blur: if you're not looking at the tab, the secret shouldn't be
  // on screen for a shoulder-surfer or a screen recording.
  useEffect(() => {
    if (!shown) return
    const remask = () => setShown(false)
    window.addEventListener('blur', remask)
    return () => window.removeEventListener('blur', remask)
  }, [shown])

  return (
    <TokenBox
      className="mt-6"
      note={
        <>
          Secret "{secretKey}" — this reveal was logged to the audit trail. Masked by default;
          auto-hides shortly and clears the clipboard after copy.
        </>
      }
    >
      <TokenValue aria-label={shown ? `value of ${secretKey}` : `${secretKey} (hidden)`}>
        {shown ? value : MASK}
      </TokenValue>
      <Button
        type="button"
        variant="secondary"
        size="compact"
        onClick={() => setShown((s) => !s)}
        aria-pressed={shown}
      >
        {shown ? 'Hide' : 'Show'}
      </Button>
      <CopyButton value={value} label="Copy value" clearAfterMs={CLIPBOARD_CLEAR_MS} />
      <Button type="button" variant="secondary" size="compact" onClick={onDismiss}>
        Dismiss
      </Button>
    </TokenBox>
  )
}
