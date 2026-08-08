/**
 * Assistant wire contract — browser ↔ EdgeVaultAgent.
 *
 * Lives beside the workspace-event contract because it is the same concern: a
 * WebSocket protocol shared by a Durable Object and the console, versioned by
 * us. The assistant previously spoke a third-party protocol (`agents` +
 * `@cloudflare/ai-chat`), where a single dependency bump moved both ends at
 * once and no build-time check could catch the mismatch. Owning the messages
 * makes that class of break impossible.
 */

/** A tool result worth surfacing under an answer (config search hits). */
export type AssistantSource = {
  key: string
  environmentId: string
  kind?: string
}

/** Server → client. Every frame carries the turn id it belongs to. */
export type AssistantServerMessage =
  /** A chunk of the answer. Clients append; the server never resends. */
  | { type: 'delta'; turn: string; text: string }
  /** Tool output for the current turn, sent before the text that cites it. */
  | { type: 'sources'; turn: string; sources: AssistantSource[] }
  /** The turn finished cleanly. */
  | { type: 'done'; turn: string }
  /** The turn failed; `message` is safe to show. */
  | { type: 'error'; turn: string; message: string }
  | { type: 'pong'; at: number }

/** Client → server. */
export type AssistantClientMessage = { type: 'ask'; turn: string; text: string } | { type: 'ping' }

export function parseAssistantMessage(data: string): AssistantServerMessage | null {
  try {
    const value = JSON.parse(data) as { type?: unknown; turn?: unknown }
    if (typeof value.type !== 'string') return null
    // Every frame except pong is turn-scoped; a frame without one is unusable.
    if (value.type !== 'pong' && typeof value.turn !== 'string') return null
    return value as AssistantServerMessage
  } catch {
    return null
  }
}
