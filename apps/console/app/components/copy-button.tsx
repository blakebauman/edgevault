import { Button } from '@edgevault/ui'
import { useEffect, useRef, useState } from 'react'

/** Copy-to-clipboard with visible + screen-reader-announced confirmation.
 * Falls back gracefully when the clipboard API is unavailable (non-secure
 * contexts): the button hides itself rather than lying. */
export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  const [supported, setSupported] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    setSupported(typeof navigator !== 'undefined' && Boolean(navigator.clipboard))
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  if (!supported) return null

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 2000)
    } catch {
      // leave the button in its default state; the user can still hand-select
    }
  }

  return (
    <Button
      type="button"
      variant="secondary"
      size="compact"
      className="self-start border-input font-mono text-muted-foreground hover:border-accent hover:bg-transparent hover:text-accent"
      onClick={onCopy}
      aria-live="polite"
    >
      {copied ? 'Copied ✓' : label}
    </Button>
  )
}
