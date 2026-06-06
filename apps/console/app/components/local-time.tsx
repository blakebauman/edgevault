import { formatTime } from '../lib/format'

/** Locale-formatted timestamp that won't fail hydration: the worker renders in
 * UTC, the browser in the user's locale/zone — suppressHydrationWarning lets
 * React adopt the client's text instead of erroring (#418). The machine-
 * readable instant rides along in dateTime. */
export function LocalTime({ epoch }: { epoch: number }) {
  const ms = epoch < 1e12 ? epoch * 1000 : epoch
  return (
    <time dateTime={new Date(ms).toISOString()} suppressHydrationWarning>
      {formatTime(epoch)}
    </time>
  )
}
