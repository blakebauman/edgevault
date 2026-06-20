import { useAgentChat } from '@cloudflare/ai-chat/react'
import { Button, cn, ErrorNote } from '@edgevault/ui'
import { useAgent } from 'agents/react'
import { type FormEvent, lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { Link, useMatches, useRouteLoaderData } from 'react-router'
import type { loader as rootLoader } from '../root'
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from './ai-elements/conversation'
import { Loader } from './ai-elements/loader'
import { Suggestion, Suggestions } from './ai-elements/suggestion'

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

/**
 * The workspace assistant in the top bar — now on the Cloudflare Agents SDK.
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
        className="text-sm text-muted-foreground transition-colors hover:text-accent focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 aria-expanded:text-accent"
      >
        Assistant
      </button>

      {open && (
        <aside
          aria-label="Workspace assistant"
          className="ev-drawer-in fixed right-0 top-0 z-50 flex h-dvh w-[min(28rem,92vw)] flex-col border-l border-border bg-card"
        >
          <header className="flex items-start justify-between gap-2 border-b border-border px-4 py-3">
            <div className="flex flex-col">
              <span className="font-display font-semibold">Assistant</span>
              <span className="truncate font-mono text-xs text-muted-foreground">
                {workspaceId
                  ? `Workspace · ${workspaceName ?? workspaceId.slice(0, 8)}`
                  : 'No workspace in context'}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close assistant"
              className="text-muted-foreground transition-colors hover:text-accent focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
            >
              ✕
            </button>
          </header>

          {ready && workspaceId && apiHost && userId ? (
            <AgentChat workspaceId={workspaceId} name={`${workspaceId}:${userId}`} host={apiHost} />
          ) : (
            <div className="flex flex-1 flex-col gap-3 p-4">
              <p className="m-0 text-sm text-muted-foreground">
                Open a workspace to ask about its config and changes — that's where the assistant's
                tools get their context.
              </p>
              <Button variant="secondary" className="self-start" asChild>
                <Link to="/" onClick={() => setOpen(false)}>
                  Go to workspaces
                </Link>
              </Button>
            </div>
          )}
        </aside>
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

  function submit(text: string) {
    const q = text.trim()
    if (!q || busy) return
    setInput('')
    sendMessage({ text: q })
  }

  return (
    <>
      <Conversation>
        <ConversationContent>
          {messages.length === 0 && (
            <div className="flex flex-col gap-3">
              <p className="m-0 text-sm text-muted-foreground">
                Ask what changed in this workspace, or find a config by meaning.
              </p>
              <Suggestions>
                {STARTERS.map((s) => (
                  <Suggestion key={s} suggestion={s} onClick={submit} />
                ))}
              </Suggestions>
            </div>
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
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader /> Thinking…
            </div>
          )}
          {error && <ErrorNote>{error.message}</ErrorNote>}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault()
          submit(input)
        }}
        className="border-t border-border p-3"
      >
        <div className="flex items-end gap-2">
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
            rows={2}
            placeholder="Ask the assistant…  (Enter to send)"
            aria-label="Ask the assistant"
            disabled={busy}
            className={cn(
              'max-h-32 flex-1 resize-none rounded-sm border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground',
              'focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 disabled:opacity-55',
            )}
          />
          <Button type="submit" loading={busy} disabled={!input.trim()}>
            Ask
          </Button>
        </div>
      </form>
    </>
  )
}

function MessageView({ role, parts, ws }: { role: string; parts: AnyPart[]; ws: string }) {
  if (role === 'user') {
    const text = parts
      .filter((p) => p.type === 'text')
      .map((p) => p.text ?? '')
      .join('')
    return (
      <div className="flex flex-col items-end gap-1">
        <span className="font-mono text-xs text-muted-foreground">You</span>
        <div className="max-w-[85%] rounded-sm bg-muted px-3 py-2 text-sm">{text}</div>
      </div>
    )
  }

  const text = parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text ?? '')
    .join('')
  const sources = parts.flatMap((p) =>
    p.type.startsWith('tool-') && isConfigHits(p.output) ? p.output : [],
  )

  return (
    <div className="flex flex-col gap-1">
      <span className="font-mono text-xs text-muted-foreground">Agent</span>
      {text && (
        <Suspense fallback={<div className="ev-response">{text}</div>}>
          <Response>{text}</Response>
        </Suspense>
      )}
      {sources.length > 0 && (
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-xs text-muted-foreground">Sources:</span>
          {sources.map((c) => (
            <Link
              key={`${c.environmentId}:${c.key}`}
              to={`/dashboard/${ws}/env/${c.environmentId}`}
              className="rounded-sm bg-muted px-2 py-0.5 font-mono text-xs text-muted-foreground no-underline transition-colors hover:text-accent"
            >
              {c.key}
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
