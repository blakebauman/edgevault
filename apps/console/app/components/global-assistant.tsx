import { useAgentChat } from '@cloudflare/ai-chat/react'
import { ErrorNote } from '@edgevault/ui'
import { useAgent } from 'agents/react'
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import { Link, useMatches, useRouteLoaderData } from 'react-router'
import type { loader as rootLoader } from '../root'
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from './ai-elements/conversation'
import { Loader } from './ai-elements/loader'
import { MessageView } from './ai-elements/message'

const STARTERS = [
  'What changed today?',
  'Find the checkout timeout config',
  'Who changed config most recently?',
]

/**
 * Generation marker on the agent DO name (`<wsId>:<userId>:<generation>`).
 *
 * Durable Object state outlives both deploys and dependency downgrades, so when
 * a stored format can no longer be read the only way out is a different DO.
 * Bumping this mints fresh instances and leaves the old ones orphaned and idle
 * — no `deleted_classes` migration, which Cloudflare rejects while a binding
 * still references the class (error 10061), and no two-step deploy with the
 * assistant offline in between.
 *
 * The failure is always the same: the DO accepts the socket (`setName` logs ok)
 * and then silently drops every message. Bump this, redeploy, done.
 *
 * v2: `agents` 0.20.1 briefly ran on staging (2026-08-08) and wrote state the
 *     reverted 0.16.2 could not read.
 * v3: skipped — used only by the 0.17.4 attempt, itself reverted.
 * v4: 0.17.4 was the live class code for *every* EdgeVaultAgent while that
 *     attempt was deployed, not just the v3 names it was minting. The agent
 *     schedules alarms, so v2 DOs woke under 0.17.4 and were migrated out from
 *     under themselves. Generation is per-name; class code is not.
 * v5: switching the model provider. Tool-call ids are minted by the provider
 *     and persisted in the thread, and Anthropic rejects the ones
 *     workers-ai-provider produces:
 *       messages.1.content.0.tool_use.id: String should match pattern
 *       '^[a-zA-Z0-9_-]+$'
 *     Every turn in a thread carrying Workers AI tool calls then fails, with no
 *     way to recover except abandoning the thread. Any future provider change
 *     needs this bump too — that is a property of persisted tool-call ids, not
 *     of Anthropic.
 *
 * Three `agents` version changes in one day each wedged persisted state this
 * way, which is worth weighing before that dependency moves again.
 *
 * The api parses this name with `split(':')` and reads only [0] and [1], so the
 * extra segment passes auth unchanged.
 */
const AGENT_GENERATION = 'v5'

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
    .map((m) => (m.loaderData as { workspaceName?: string } | undefined)?.workspaceName)
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
                name={`${workspaceId}:${userId}:${AGENT_GENERATION}`}
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
  const [connected, setConnected] = useState(true)
  // The very first connect shouldn't render as an outage. Without this the
  // drawer flashes "Reconnecting…" during the opening handshake every time it
  // opens, which reads as a broken assistant rather than a normal connect.
  const seenConnected = useRef(false)

  // The access token is httpOnly — fetch a fresh one from the BFF on each
  // (re)connect for the ?token= the api verifies.
  const query = useCallback(async (): Promise<Record<string, string>> => {
    const res = await fetch(`/dashboard/${encodeURIComponent(workspaceId)}/assistant/ws-token`)
    if (!res.ok) return {}
    const { token } = (await res.json()) as { token?: string }
    return token ? { token } : {}
  }, [workspaceId])

  const agent = useAgent({
    agent: 'EdgeVaultAgent',
    name,
    host,
    query,
    queryDeps: [workspaceId],
    onOpen: () => {
      seenConnected.current = true
      setConnected(true)
    },
    onClose: () => setConnected(false),
  })
  // Load thread history through the BFF rather than the SDK's default fetch.
  // The default goes straight to the api, which is cross-origin and sends no
  // CORS headers, so it was previously disabled with `getInitialMessages: null`
  // on the assumption that history would arrive over the WebSocket instead. It
  // doesn't: the DO keeps the history and still feeds it to the model, but the
  // client rendered an empty thread on every page load. Same-origin proxy, same
  // pattern as the ws-token route.
  const loadHistory = useCallback(async () => {
    const res = await fetch(
      `/dashboard/${encodeURIComponent(workspaceId)}/assistant/messages?name=${encodeURIComponent(name)}`,
    )
    if (!res.ok) return []
    const body = await res.json()
    return Array.isArray(body) ? body : []
  }, [workspaceId, name])

  const { messages, sendMessage, status, error, stop, regenerate, isStreaming, isRecovering } =
    useAgentChat({ agent, getInitialMessages: loadHistory })
  // `isStreaming` also covers server-pushed turns (another tab, a continuation),
  // which plain `status` misses.
  const busy = status === 'submitted' || isStreaming
  const offline = !connected && seenConnected.current

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  function submit(text: string) {
    const q = text.trim()
    if (!q || busy) return
    setInput('')
    sendMessage({ text: q })
  }

  const lastMessage = messages[messages.length - 1]
  // A retry only makes sense on the newest reply, and only once it has settled.
  const retryable = !busy && lastMessage?.role === 'assistant'

  return (
    <>
      <Conversation className="asst-scroll">
        <ConversationContent className="asst-body">
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

          {messages.map((m, i) => {
            const isLast = i === messages.length - 1
            return (
              <div
                key={m.id}
                // Tall spacer under a just-sent question so bottom-anchoring
                // lifts it to the top of the drawer and the reply streams into
                // the space below, instead of both crawling along the bottom
                // edge. Collapses as soon as a reply arrives and this stops
                // being the last message. `svh` (not `vh`) so a mobile browser
                // collapsing its address bar doesn't jump the scroll position.
                className={isLast && m.role === 'user' ? 'min-h-[calc(70svh-8rem)]' : undefined}
              >
                <MessageView
                  role={m.role}
                  parts={m.parts as unknown as { type: string; text?: string }[]}
                  workspaceId={workspaceId}
                  onRetry={isLast && retryable ? () => regenerate() : undefined}
                />
              </div>
            )
          })}

          {busy && (
            <div className="msg ai flex items-center gap-2">
              <Loader /> {isRecovering ? 'Reconnecting to your answer…' : 'Thinking…'}
            </div>
          )}
          {error && <ErrorNote>{error.message}</ErrorNote>}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <form
        className="asst-foot"
        onSubmit={(e: FormEvent) => {
          e.preventDefault()
          submit(input)
        }}
      >
        {offline && (
          <p className="asst-conn" role="status">
            Reconnecting…
          </p>
        )}
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
          />
          {busy ? (
            <button
              type="button"
              className="asst-send"
              onClick={() => stop()}
              aria-label="Stop generating"
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
              >
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
            </button>
          ) : (
            <button type="submit" className="asst-send" disabled={!input.trim()} aria-label="Send">
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
          )}
        </div>
      </form>
    </>
  )
}
