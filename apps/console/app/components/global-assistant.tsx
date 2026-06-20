import { Button, cn, ErrorNote } from '@edgevault/ui'
import { type FormEvent, lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Link, useMatches } from 'react-router'
import { useAgentChat } from '../lib/use-agent-chat'
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from './ai-elements/conversation'
import { Loader } from './ai-elements/loader'
import { Suggestion, Suggestions } from './ai-elements/suggestion'

// streamdown is heavy (markdown + highlighting) — keep it in its own chunk,
// loaded only when an assistant message actually renders on the client.
const Response = lazy(() => import('./ai-elements/response').then((m) => ({ default: m.Response })))

const STARTERS = [
  'What changed today?',
  'What were the last 5 changes, and why?',
  'Who changed config most recently?',
]

/**
 * The workspace assistant, available from the top bar on every page. It's a
 * non-modal docked panel (the page stays interactive), so its workspace context
 * tracks wherever you navigate: tools that need a workspace (MCP, config lookup)
 * light up inside a workspace and explain themselves outside one.
 *
 * Workspace context comes from the active route — its `:workspaceId` param and,
 * when the matched loader exposes it, the human name — so no extra fetch.
 *
 * Chat surface uses AI Elements (ai-sdk.dev), themed to the vault palette.
 */
export function GlobalAssistant() {
  const matches = useMatches()
  const workspaceId = matches
    .map((m) => (m.params as { workspaceId?: string }).workspaceId)
    .find(Boolean)
  const workspaceName = matches
    .map((m) => (m.data as { workspaceName?: string } | undefined)?.workspaceName)
    .find(Boolean)

  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [input, setInput] = useState('')
  const { messages, isLoading, error, send, loadHistory } = useAgentChat(workspaceId ?? '')

  // Load the persisted thread the first time the panel opens for a workspace
  // (the hook resets and re-arms history when the workspace changes).
  useEffect(() => {
    if (open && workspaceId) loadHistory()
  }, [open, workspaceId, loadHistory])

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

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

  function ask(question: string) {
    if (!workspaceId) return
    send(question)
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    const q = input.trim()
    if (!q) return
    setInput('')
    ask(q)
  }

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

          {workspaceId ? (
            <Conversation>
              <ConversationContent>
                {messages.length === 0 && (
                  <div className="flex flex-col gap-3">
                    <p className="m-0 text-sm text-muted-foreground">
                      Ask what changed in this workspace, and why.
                    </p>
                    <Suggestions>
                      {STARTERS.map((s) => (
                        <Suggestion key={s} suggestion={s} onClick={ask} />
                      ))}
                    </Suggestions>
                  </div>
                )}

                {messages.map((m) =>
                  m.role === 'user' ? (
                    <div key={m.id} className="flex flex-col items-end gap-1">
                      <span className="font-mono text-xs text-muted-foreground">You</span>
                      <div className="max-w-[85%] rounded-sm bg-muted px-3 py-2 text-sm">
                        {m.content}
                      </div>
                    </div>
                  ) : (
                    <div key={m.id} className="flex flex-col gap-1">
                      <span className="font-mono text-xs text-muted-foreground">
                        Agent
                        {m.source === 'fallback' && ' · offline summary'}
                      </span>
                      <Suspense fallback={<div className="ev-response">{m.content}</div>}>
                        <Response>{m.content}</Response>
                      </Suspense>
                      {m.citations && m.citations.length > 0 && (
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                          <span className="font-mono text-xs text-muted-foreground">Sources:</span>
                          {m.citations.map((c) => (
                            <Link
                              key={`${c.environmentId}:${c.key}`}
                              to={`/dashboard/${workspaceId}/env/${c.environmentId}`}
                              className="rounded-sm bg-muted px-2 py-0.5 font-mono text-xs text-muted-foreground no-underline transition-colors hover:text-accent"
                            >
                              {c.key}
                            </Link>
                          ))}
                        </div>
                      )}
                    </div>
                  ),
                )}

                {isLoading && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader /> Thinking…
                  </div>
                )}
                {error && <ErrorNote>{error}</ErrorNote>}
              </ConversationContent>
              <ConversationScrollButton />
            </Conversation>
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

          <form onSubmit={onSubmit} className="border-t border-border p-3">
            <div className="flex items-end gap-2">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    onSubmit(e)
                  }
                }}
                rows={2}
                placeholder={
                  workspaceId ? 'Ask the assistant…  (Enter to send)' : 'Select a workspace first'
                }
                aria-label="Ask the assistant"
                disabled={!workspaceId || isLoading}
                className={cn(
                  'max-h-32 flex-1 resize-none rounded-sm border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground',
                  'focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 disabled:opacity-55',
                )}
              />
              <Button type="submit" loading={isLoading} disabled={!workspaceId || !input.trim()}>
                Ask
              </Button>
            </div>
          </form>
        </aside>
      )}
    </>
  )
}
