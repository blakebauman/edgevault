import { useCallback, useState } from 'react'

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

export interface UseAgentChat {
  messages: AgentMessage[]
  isLoading: boolean
  error: string | null
  send: (question: string) => Promise<void>
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

  return { messages, isLoading, error, send, clear }
}
