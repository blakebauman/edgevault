import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Console chat hook for the EdgeVault "what changed & why" agent.
 *
 * It mirrors the Agents SDK `useAgentChat` ergonomics (a messages list plus
 * `send`/`isLoading`/`error`), but the transport is the console BFF resource
 * route `dashboard/:id/assistant`, which proxies to the api and the AGENT
 * durable object. We use the BFF rather than `agents/react`'s WebSocket
 * `useAgent` because EdgeVaultAgent is a plain RPC durable object today, and the
 * access token is httpOnly (server-only). Swapping to the WebSocket transport is
 * a drop-in here once EdgeVaultAgent extends the SDK's `Agent`.
 */

/** A config item the assistant surfaced for the question — rendered as a source. */
export interface Citation {
  key: string
  environmentId: string
  kind: string
  score: number
}

export interface AgentMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  /** Assistant turns: whether the answer came from live AI or the deterministic fallback. */
  source?: 'ai' | 'fallback'
  /** Assistant turns: how many activity-log events grounded the answer. */
  groundedOnEvents?: number
  /** Assistant turns: config items the retrieval step surfaced. */
  citations?: Citation[]
}

interface AskResult {
  answer: string
  source: 'ai' | 'fallback'
  groundedOnEvents: number
  citations?: Citation[]
}

/** A persisted turn from the agent's SQLite (user-scoped via the BFF). */
interface ChatTurn {
  id: string
  question: string
  answer: string
  source: string
  userId: string | null
  createdAt: number
}

export interface UseAgentChat {
  messages: AgentMessage[]
  isLoading: boolean
  error: string | null
  send: (question: string) => Promise<void>
  /** Load the caller's persisted thread for this workspace (once per workspace). */
  loadHistory: () => Promise<void>
  clear: () => void
}

function newId(): string {
  return crypto.randomUUID()
}

export function useAgentChat(workspaceId: string): UseAgentChat {
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const send = useCallback(
    async (question: string) => {
      const q = question.trim()
      if (!q || isLoading) return

      setError(null)
      setIsLoading(true)
      setMessages((prev) => [...prev, { id: newId(), role: 'user', content: q }])

      try {
        const res = await fetch(`/dashboard/${encodeURIComponent(workspaceId)}/assistant`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ question: q }),
        })

        if (res.status === 401 || res.status === 403) {
          setError('Your session expired — please sign in again.')
          return
        }
        if (res.status === 429) {
          setError('Too many requests — please wait a moment and try again.')
          return
        }
        if (!res.ok) {
          setError('The assistant is unavailable right now.')
          return
        }

        const result = (await res.json()) as AskResult
        setMessages((prev) => [
          ...prev,
          {
            id: newId(),
            role: 'assistant',
            content: result.answer,
            source: result.source,
            groundedOnEvents: result.groundedOnEvents,
            citations: result.citations ?? [],
          },
        ])
      } catch {
        setError('Network error reaching the assistant.')
      } finally {
        setIsLoading(false)
      }
    },
    [workspaceId, isLoading],
  )

  const clear = useCallback(() => {
    setMessages([])
    setError(null)
  }, [])

  // The agent's thread is per-workspace — drop it and re-arm history when the
  // workspace changes (or clears).
  const loadedFor = useRef<string | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset is keyed on the workspace only
  useEffect(() => {
    setMessages([])
    setError(null)
    loadedFor.current = null
  }, [workspaceId])

  const loadHistory = useCallback(async () => {
    if (!workspaceId || loadedFor.current === workspaceId) return
    loadedFor.current = workspaceId
    try {
      const res = await fetch(`/dashboard/${encodeURIComponent(workspaceId)}/assistant/history`)
      if (!res.ok) return
      const { history } = (await res.json()) as { history: ChatTurn[] }
      // History is newest-first; replay chronologically, each turn → two messages.
      const restored: AgentMessage[] = []
      for (const turn of [...history].reverse()) {
        restored.push({ id: `${turn.id}-q`, role: 'user', content: turn.question })
        restored.push({
          id: `${turn.id}-a`,
          role: 'assistant',
          content: turn.answer,
          source: turn.source === 'ai' ? 'ai' : 'fallback',
        })
      }
      // Don't clobber a thread the user has already started this open.
      setMessages((prev) => (prev.length === 0 ? restored : prev))
    } catch {
      // history unavailable — start empty
    }
  }, [workspaceId])

  return { messages, isLoading, error, send, loadHistory, clear }
}
