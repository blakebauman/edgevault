import { Button, ErrorNote, Field, Input, TokenBox } from '@edgevault/ui'
import { useState } from 'react'
import { stepUpWithPasskey, stepUpWithTotp } from '../lib/passkey'

/**
 * Step-up gate shown when an org requires a fresh second factor before a secret
 * reveal. On success the BFF has set the (httpOnly) reveal-token cookie, so we
 * just tell the caller to retry the reveal. Offers a passkey first (one tap) and
 * an authenticator code as the universal fallback.
 */
export function StepUpPrompt({
  secretKey,
  workspaceId,
  onSuccess,
  onCancel,
}: {
  secretKey: string
  workspaceId: string
  onSuccess: () => void
  onCancel: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [showTotp, setShowTotp] = useState(false)
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function run(action: () => Promise<{ ok: boolean; error?: string }>) {
    setBusy(true)
    setError(null)
    const res = await action()
    setBusy(false)
    if (res.ok) onSuccess()
    else setError(res.error ?? 'Verification failed.')
  }

  return (
    <TokenBox
      className="mt-6"
      note={
        <>
          Revealing "{secretKey}" needs a fresh check — confirm it's you. Being signed in isn't
          enough for a secret.
        </>
      }
    >
      <div className="flex flex-1 flex-col gap-3">
        {error && <ErrorNote>{error}</ErrorNote>}
        {showTotp ? (
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              if (!busy) run(() => stepUpWithTotp(code.trim(), workspaceId))
            }}
          >
            <Field label="Authenticator code" className="flex-1">
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123456"
                autoFocus
              />
            </Field>
            <Button type="submit" variant="default" size="compact" disabled={busy || !code.trim()}>
              {busy ? 'Checking…' : 'Confirm'}
            </Button>
          </form>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="default"
              size="compact"
              disabled={busy}
              onClick={() => run(() => stepUpWithPasskey(workspaceId))}
            >
              {busy ? 'Waiting for passkey…' : 'Verify with passkey'}
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="compact"
              disabled={busy}
              onClick={() => {
                setError(null)
                setShowTotp(true)
              }}
            >
              Use authenticator code
            </Button>
          </div>
        )}
        <button
          type="button"
          className="self-start text-sm text-muted-foreground hover:text-foreground"
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </TokenBox>
  )
}
