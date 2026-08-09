/**
 * Server-side refusals rendered as ordinary assistant turns.
 *
 * When the agent declines a turn — rate limited, read-only role — the client
 * should see a normal message in the thread, not a socket error or a silent
 * dead end. `streamText().toUIMessageStreamResponse()` is the only thing that
 * normally produces that shape, and calling it would mean paying for an
 * inference request just to say no.
 *
 * So hand-roll the minimal frame sequence instead. This is the documented AI
 * SDK v6 UI-message-stream wire format rather than an internal API, which is
 * why it's spelled out literally here: it's a protocol we're speaking, not a
 * type we're importing. `@cloudflare/ai-chat` tunnels the response over the
 * agent WebSocket unchanged.
 */

/** The AI SDK v6 UI-message-stream protocol marker `useAgentChat` dispatches on. */
const UI_MESSAGE_STREAM_HEADER = 'x-vercel-ai-ui-message-stream'

/**
 * A complete one-message assistant turn carrying `message`, with no model call.
 *
 * The frames mirror what a real streamed turn emits — start, one step, one text
 * part, finish — so the client's normal `status` transitions and persistence
 * run exactly as they would for a model reply.
 */
export function refusalResponse(message: string): Response {
  const encoder = new TextEncoder()
  const messageId = `msg_${crypto.randomUUID()}`
  const partId = 'txt_0'
  const frames = [
    { type: 'start', messageId },
    { type: 'start-step' },
    { type: 'text-start', id: partId },
    { type: 'text-delta', id: partId, delta: message },
    { type: 'text-end', id: partId },
    { type: 'finish-step' },
    { type: 'finish' },
  ]
  const stream = new ReadableStream({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`))
      }
      controller.close()
    },
  })
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      [UI_MESSAGE_STREAM_HEADER]: 'v1',
    },
  })
}

/** Shown when a user exceeds AI_USER_LIMITER (20 turns / 60s, per location). */
export const RATE_LIMITED_MESSAGE =
  "You've sent a lot of messages in a short window, so I've paused to keep things responsive. Try again in a minute."
