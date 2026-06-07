import { Button } from '@edgevault/ui'
import { useEffect, useRef, useState } from 'react'

/** Copy-to-clipboard with visible + screen-reader-announced confirmation.
 * Falls back gracefully when the clipboard API is unavailable (non-secure
 * contexts): the button hides itself rather than lying.
 *
 * When `clearAfterMs` is set (for secret material), the clipboard is wiped
 * after the delay — but only if it still holds the value we wrote, so we never
 * clobber something the user copied in the meantime. The check needs read
 * permission; where the browser denies it we leave the clipboard alone and say
 * so rather than claiming a clear that didn't happen. */
export function CopyButton({
  value,
  label = 'Copy',
  clearAfterMs,
}: {
  value: string
  label?: string
  clearAfterMs?: number
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'cleared'>('idle')
  const [supported, setSupported] = useState(false)
  const labelTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    setSupported(typeof navigator !== 'undefined' && Boolean(navigator.clipboard))
    return () => {
      if (labelTimer.current) clearTimeout(labelTimer.current)
      if (clearTimer.current) clearTimeout(clearTimer.current)
    }
  }, [])

  if (!supported) return null

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(value)
      setState('copied')
      if (labelTimer.current) clearTimeout(labelTimer.current)
      labelTimer.current = setTimeout(() => setState('idle'), 2000)

      if (clearAfterMs) {
        if (clearTimer.current) clearTimeout(clearTimer.current)
        clearTimer.current = setTimeout(async () => {
          try {
            const current = await navigator.clipboard.readText()
            if (current !== value) return // user copied something else — leave it
            await navigator.clipboard.writeText('')
            setState('cleared')
          } catch {
            // read denied: we can't safely confirm or clear — say nothing false
          }
        }, clearAfterMs)
      }
    } catch {
      // leave the button in its default state; the user can still hand-select
    }
  }

  const text = state === 'copied' ? 'Copied ✓' : state === 'cleared' ? 'Clipboard cleared' : label
  const title = clearAfterMs
    ? `Clipboard clears automatically after ${Math.round(clearAfterMs / 1000)}s`
    : undefined

  return (
    <Button
      type="button"
      variant="secondary"
      size="compact"
      className="self-start border-input font-mono text-muted-foreground hover:border-accent hover:bg-transparent hover:text-accent"
      onClick={onCopy}
      title={title}
      aria-live="polite"
    >
      {text}
    </Button>
  )
}
