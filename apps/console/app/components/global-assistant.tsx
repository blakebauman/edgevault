import { useAgentChat } from '@cloudflare/ai-chat/react'
import { ErrorNote } from '@edgevault/ui'
import { useAgent } from 'agents/react'
import { type FormEvent, lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { Link, useMatches, useRouteLoaderData } from 'react-router'
import type { loader as rootLoader } from '../root'
import { Loader } from './ai-elements/loader'

const Response = lazy(() => import('./ai-elements/response').then((m) => ({ default: m.Response })))

const STARTERS = [
  'What changed today?',
  'Find the checkout timeout config',
  'Who changed config most recently?',
]

/** A permissive view of a UIMessage part (the v5 union is wide; we read text +
 * tool output defensively). */
type AnyPart = { type: string; text?: string; output?: unknown }
type ConfigHit = { key: string; environmentId: string; kind?: string }

function isConfigHits(v: unknown): v is ConfigHit[] {
  return Array.isArray(v) && v.every((h) => h && typeof (h as ConfigHit).key === 'string')
}

function Spark({ size = 15 }: { size?: number }) {
  return (
    <svg
      className="spark"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8" />
    </svg>
  )
}

/**
 * The workspace assistant in the top bar — on the Cloudflare Agents SDK.
 * `useAgent` opens an authed WebSocket straight to the api's per-workspace agent
 * (browser→api, like the realtime /ws); `useAgentChat` streams turns with
 * model-chosen tools and SDK-managed history. The chat hooks live in a child
 * that only mounts inside a workspace with the panel open, so the socket
 * connects on demand and history re-syncs on connect.
 */
export function GlobalAssistant() {
  const matches = useMatches()
  const workspaceId = matches
    .map((m) => (m.params as { workspaceId?: string }).workspaceId)
    .find(Boolean)
  const workspaceName = matches
    .map((m) => (m.data as { workspaceName?: string } | undefined)?.workspaceName)
    .find(Boolean)
  const root = useRouteLoaderData<typeof rootLoader>('root')
  const userId = root?.userId
  const apiHost = root?.apiHost

  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  const ready = Boolean(workspaceId && userId && apiHost)

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="asst-trigger"
      >
        <Spark />
        Assistant
      </button>

      {open && (
        <>
          <button
            type="button"
            className="asst-scrim"
            aria-label="Close assistant"
            onClick={() => setOpen(false)}
          />
          <aside aria-label="Workspace assistant" className="ev-assistant ev-drawer-in">
            <div className="asst-head">
              <span className="ttl">
                <Spark size={16} />
                Assistant
              </span>
              {workspaceId && (
                <span className="asst-scope">{workspaceName ?? workspaceId.slice(0, 8)}</span>
              )}
              <span className="grow" />
              <button
                type="button"
                className="asst-close"
                onClick={() => setOpen(false)}
                aria-label="Close assistant"
              >
                ✕
              </button>
            </div>

            {ready && workspaceId && apiHost && userId ? (
              <AgentChat
                workspaceId={workspaceId}
                name={`${workspaceId}:${userId}`}
                host={apiHost}
              />
            ) : (
              <div className="asst-body">
                <p className="asst-intro">
                  Open a workspace to ask about its config and changes — that's where the
                  assistant's tools get their context.
                </p>
                <Link to="/" onClick={() => setOpen(false)} className="sugg self-start">
                  Go to workspaces
                </Link>
              </div>
            )}
          </aside>
        </>
      )}
    </>
  )
}

function AgentChat({
  workspaceId,
  name,
  host,
}: {
  workspaceId: string
  name: string
  host: string
}) {
  const [input, setInput] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  // The access token is httpOnly — fetch a fresh one from the BFF on each
  // (re)connect for the ?token= the api verifies.
  const query = useCallback(async (): Promise<Record<string, string>> => {
    const res = await fetch(`/dashboard/${encodeURIComponent(workspaceId)}/assistant/ws-token`)
    if (!res.ok) return {}
    const { token } = (await res.json()) as { token?: string }
    return token ? { token } : {}
  }, [workspaceId])

  const agent = useAgent({ agent: 'EdgeVaultAgent', name, host, query, queryDeps: [workspaceId] })
  // `getInitialMessages: null` disables the SDK's default HTTP fetch of thread
  // history (`GET /agents/.../get-messages`). That fetch is cross-origin
  // (console→api) and the api intentionally sends no CORS headers — the browser
  // only talks to the api over the CORS-exempt WebSocket. History (and every
  // turn) syncs over that socket instead, so the HTTP call is unnecessary here.
  const { messages, sendMessage, status, error } = useAgentChat({ agent, getInitialMessages: null })
  const busy = status === 'submitted' || status === 'streaming'

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Keep the latest turn in view as it streams.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on every message update
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight })
  }, [messages])

  function submit(text: string) {
    const q = text.trim()
    if (!q || busy) return
    setInput('')
    sendMessage({ text: q })
  }

  return (
    <>
      <div className="asst-body" ref={bodyRef}>
        {messages.length === 0 && (
          <>
            <p className="asst-intro">
              Ask what changed in this workspace, or find a config by meaning.
            </p>
            <div className="asst-sugg">
              {STARTERS.map((s) => (
                <button key={s} type="button" className="sugg" onClick={() => submit(s)}>
                  {s}
                </button>
              ))}
            </div>
          </>
        )}

        {messages.map((m) => (
          <MessageView
            key={m.id}
            role={m.role}
            parts={m.parts as unknown as AnyPart[]}
            ws={workspaceId}
          />
        ))}

        {busy && (
          <div className="msg ai flex items-center gap-2">
            <Loader /> Thinking…
          </div>
        )}
        {error && <ErrorNote>{error.message}</ErrorNote>}
      </div>

      <form
        className="asst-foot"
        onSubmit={(e: FormEvent) => {
          e.preventDefault()
          submit(input)
        }}
      >
        <div className="asst-input">
          <Spark />
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit(input)
              }
            }}
            rows={1}
            placeholder="Ask the assistant…  (Enter to send)"
            aria-label="Ask the assistant"
            disabled={busy}
          />
          <button
            type="submit"
            className="asst-send"
            disabled={busy || !input.trim()}
            aria-label="Send"
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          </button>
        </div>
      </form>
    </>
  )
}

function MessageView({ role, parts, ws }: { role: string; parts: AnyPart[]; ws: string }) {
  const text = parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text ?? '')
    .join('')

  if (role === 'user') {
    return <div className="msg user">{text}</div>
  }

  const sources = parts.flatMap((p) =>
    p.type.startsWith('tool-') && isConfigHits(p.output) ? p.output : [],
  )

  return (
    <div className="msg ai">
      {text && (
        <Suspense fallback={<div className="ev-response">{text}</div>}>
          <Response>{text}</Response>
        </Suspense>
      )}
      {sources.length > 0 && (
        <div className="hits">
          {sources.map((c) => (
            <Link
              key={`${c.environmentId}:${c.key}`}
              to={`/dashboard/${ws}/env/${c.environmentId}`}
              className="hit"
            >
              <svg
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
                <path d="M12 2 3 7v10l9 5 9-5V7z" />
              </svg>
              {c.key}
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
