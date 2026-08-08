import { useCallback, useEffect, useRef, useState } from 'react'
import {
  type AssistantServerMessage,
  type AssistantSource,
  parseAssistantMessage,
} from './assistant'
import type { ConnectionStatus } from './client'

export type AssistantTurn = {
  id: string
  role: 'user' | 'assistant'
  text: string
  sources?: AssistantSource[]
  /** Set when the turn failed; `text` then holds nothing useful. */
  error?: string
  /** True while the server is still streaming this turn. */
  pending?: boolean
}

export type UseAssistant = {
  turns: AssistantTurn[]
  status: ConnectionStatus
  /** True from send until the matching `done`/`error`. */
  busy: boolean
  ask: (text: string) => void
}

/**
 * The assistant's client half: one WebSocket, one append-only turn list.
 *
 * Accumulation is deliberately explicit — a delta is appended to exactly the
 * turn its id names, and only to a turn already in the list. The previous
 * third-party hook duplicated every token (`"HelloHello!!"`) because two
 * sources of the same turn both fed one message; here a late or repeated frame
 * for an unknown turn is dropped rather than merged.
 *
 * Pass `null` for the url to stay disconnected (before auth is ready).
 */
export function useAssistant(url: string | null): UseAssistant {
  const [turns, setTurns] = useState<AssistantTurn[]>([])
  const [status, setStatus] = useState<ConnectionStatus>('closed')
  const [busy, setBusy] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    if (!url) {
      setStatus('closed')
      return
    }
    let closed = false
    let ping: ReturnType<typeof setInterval> | null = null
    setStatus('connecting')

    const ws = new WebSocket(url)
    wsRef.current = ws

    ws.addEventListener('open', () => {
      if (closed) return
      setStatus('open')
      // Client-driven keepalive so the DO can hibernate between turns rather
      // than being held awake by a server timer (same as workspace events).
      ping = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }))
      }, 30_000)
    })

    ws.addEventListener('message', (event) => {
      const msg = parseAssistantMessage(typeof event.data === 'string' ? event.data : '')
      if (!msg) return
      applyServerMessage(msg, setTurns, setBusy)
    })

    ws.addEventListener('close', () => {
      if (ping) clearInterval(ping)
      if (!closed) {
        setStatus('closed')
        // A socket that drops mid-turn will never deliver `done`.
        setBusy(false)
      }
    })

    return () => {
      closed = true
      if (ping) clearInterval(ping)
      ws.close()
      wsRef.current = null
    }
  }, [url])

  const ask = useCallback((text: string) => {
    const ws = wsRef.current
    const body = text.trim()
    if (!body || ws?.readyState !== WebSocket.OPEN) return
    const turn = crypto.randomUUID()
    setTurns((prev) => [
      ...prev,
      { id: `${turn}:user`, role: 'user', text: body },
      { id: turn, role: 'assistant', text: '', pending: true },
    ])
    setBusy(true)
    ws.send(JSON.stringify({ type: 'ask', turn, text: body }))
  }, [])

  return { turns, status, busy, ask }
}

function applyServerMessage(
  msg: AssistantServerMessage,
  setTurns: React.Dispatch<React.SetStateAction<AssistantTurn[]>>,
  setBusy: React.Dispatch<React.SetStateAction<boolean>>,
): void {
  if (msg.type === 'pong') return

  setTurns((prev) => {
    const i = prev.findIndex((t) => t.id === msg.turn)
    // Unknown turn: a stale frame from a previous connection, or a duplicate.
    // Dropping it is what keeps text from being appended twice.
    if (i === -1) return prev
    const next = [...prev]
    const turn = next[i]
    if (!turn) return prev

    if (msg.type === 'delta') next[i] = { ...turn, text: turn.text + msg.text }
    else if (msg.type === 'sources') next[i] = { ...turn, sources: msg.sources }
    else if (msg.type === 'done') next[i] = { ...turn, pending: false }
    else if (msg.type === 'error') next[i] = { ...turn, pending: false, error: msg.message }
    return next
  })

  if (msg.type === 'done' || msg.type === 'error') setBusy(false)
}
