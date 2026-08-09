import { getToolInput, getToolOutput, getToolPartState } from '@cloudflare/ai-chat/react'
import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { toolNameFromPartType } from './tool'
import { ToolPart } from './tool-cards'

const Response = lazy(() => import('./response').then((m) => ({ default: m.Response })))

/**
 * One message in the assistant thread.
 *
 * Dispatches over the part types a turn can contain rather than filtering to
 * `text`: a tool call the model made is part of its answer, and dropping it
 * left the user unable to tell a grounded reply from a guess.
 */

/**
 * A part, read defensively.
 *
 * The v6 part union is wide and version-dependent, and `@cloudflare/ai-chat`'s
 * accessors take the SDK's own `UIMessage` part type. Narrowing to what we read
 * keeps this file from tracking the union across SDK bumps — the accessors do
 * that for us.
 */
type AnyPart = { type: string; text?: string; errorText?: string }

/** Tool parts are `tool-<name>`; dynamic tools carry their name in the payload. */
function isToolPart(part: AnyPart): boolean {
  return part.type.startsWith('tool-') || part.type === 'dynamic-tool'
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1600)
    return () => clearTimeout(timer)
  }, [copied])

  const copy = useCallback(() => {
    navigator.clipboard.writeText(text).then(
      () => setCopied(true),
      () => setCopied(false),
    )
  }, [text])

  return (
    <button type="button" className="msg-act" onClick={copy} aria-label="Copy message">
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

export function MessageView({
  role,
  parts,
  workspaceId,
  onRetry,
}: {
  role: string
  parts: AnyPart[]
  workspaceId: string
  /** Present only on the last assistant message, where a retry is meaningful. */
  onRetry?: () => void
}) {
  const text = parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text ?? '')
    .join('')

  if (role === 'user') {
    return <div className="msg user">{text}</div>
  }

  const toolParts = parts.filter(isToolPart)

  return (
    <div className="msg ai">
      {toolParts.map((part, i) => (
        <ToolPart
          // Parts are positionally stable within a message and a single tool can
          // legitimately be called twice with the same name in one turn, so the
          // index is the identity here.
          key={`${part.type}:${i}`}
          name={toolNameFromPartType(part.type)}
          state={getToolPartState(part as never)}
          input={getToolInput(part as never)}
          output={getToolOutput(part as never)}
          errorText={part.errorText}
          workspaceId={workspaceId}
        />
      ))}

      {text && (
        <Suspense fallback={<div className="ev-response">{text}</div>}>
          <Response>{text}</Response>
        </Suspense>
      )}

      {text && (
        <div className="msg-acts">
          <CopyButton text={text} />
          {onRetry && (
            <button type="button" className="msg-act" onClick={onRetry}>
              Retry
            </button>
          )}
        </div>
      )}
    </div>
  )
}
