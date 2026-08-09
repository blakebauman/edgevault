import type { getToolPartState } from '@cloudflare/ai-chat/react'
import { Loader } from './loader'

/**
 * Generic renderer for a tool call in the assistant thread.
 *
 * The fallback half of the two-tier scheme in `tool-cards.tsx`: tools worth
 * reading get a purpose-built card, everything else lands here so a new tool is
 * never invisible. Collapsed by default — the arguments and raw result are for
 * when someone is debugging a wrong answer, not for every turn.
 *
 * Built on native <details>/<summary> rather than a disclosure library: it is
 * keyboard- and screen-reader-correct for free, and the console has no Radix
 * collapsible to reuse.
 */

/**
 * Tool-part lifecycle, in `@cloudflare/ai-chat`'s vocabulary.
 *
 * This is the return type of its `getToolPartState`, used verbatim rather than
 * remapped: the SDK already collapses the raw AI SDK part states into these
 * seven, and a translation layer here would just be a second thing to keep in
 * step with the wire format.
 *
 * The approval states are only reachable once a tool opts into human-in-the-loop;
 * the read-only tools never enter them.
 */
export type ToolState = ReturnType<typeof getToolPartState>

type Tone = 'muted' | 'active' | 'ok' | 'warn' | 'error'

const STATUS: Record<ToolState, { label: string; tone: Tone; spin?: boolean }> = {
  streaming: { label: 'Pending', tone: 'muted' },
  loading: { label: 'Running', tone: 'active', spin: true },
  complete: { label: 'Done', tone: 'ok' },
  error: { label: 'Failed', tone: 'error' },
  'waiting-approval': { label: 'Needs approval', tone: 'warn' },
  approved: { label: 'Approved', tone: 'active' },
  denied: { label: 'Declined', tone: 'muted' },
}

/** `tool-searchConfigs` → `searchConfigs`. Dynamic tools arrive already bare. */
export function toolNameFromPartType(type: string): string {
  return type.startsWith('tool-') ? type.slice('tool-'.length) : type
}

/** Pretty-print a tool payload, tolerating values that don't serialize. */
function format(value: unknown): string {
  if (value === undefined) return ''
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export function ToolStatus({ state }: { state: ToolState }) {
  const status = STATUS[state] ?? STATUS.streaming
  return (
    <span className="tool-status" data-tone={status.tone}>
      {status.spin ? <Loader size={11} /> : <span className="tool-dot" aria-hidden="true" />}
      {status.label}
    </span>
  )
}

export function Tool({
  name,
  state,
  input,
  output,
  errorText,
}: {
  name: string
  state: ToolState
  input?: unknown
  output?: unknown
  errorText?: string
}) {
  const failed = state === 'error' || Boolean(errorText)
  const body = failed ? (errorText ?? format(output)) : format(output)

  return (
    <details className="tool-card">
      <summary>
        <code className="tool-name">{name}</code>
        <ToolStatus state={state} />
        <svg
          className="tool-chev"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </summary>
      <div className="tool-body">
        {input !== undefined && (
          <>
            <p className="tool-cap">Parameters</p>
            <pre>{format(input)}</pre>
          </>
        )}
        {body && (
          <>
            <p className="tool-cap">{failed ? 'Error' : 'Result'}</p>
            <pre data-tone={failed ? 'error' : undefined}>{body}</pre>
          </>
        )}
      </div>
    </details>
  )
}
