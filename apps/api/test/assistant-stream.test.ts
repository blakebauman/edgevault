import { streamText } from 'ai'
import { describe, expect, it } from 'vitest'
import { createWorkersAI } from 'workers-ai-provider'

/**
 * Regression guard for the assistant streaming every token twice
 * ("HelloHello!!" instead of "Hello!").
 *
 * Workers AI puts the same token in BOTH `response` and
 * `choices[0].delta.content` on a single stream chunk. `workers-ai-provider`
 * has two independent branches that each enqueue a text-delta from those
 * fields, so every token is emitted twice under the same text id. Only the
 * deltas double — `text-start`/`text-end` are guarded by `if (!textId)` —
 * which is what made this look like a console render bug for so long.
 *
 * Fixed by `patches/workers-ai-provider@3.2.0.patch` (upstream is still
 * unguarded as of 4.0.0). If that patch stops applying, this test fails.
 */

/** An SSE body shaped like a real Workers AI stream chunk. */
function workersAiStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(`data: ${c}\n\n`))
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  })
}

/** Minimal AI binding stub: streaming `run()` returns the raw SSE stream. */
function bindingReturning(chunks: string[]) {
  return { run: async () => workersAiStream(chunks) } as unknown as Ai
}

async function collect(binding: Ai): Promise<string> {
  const workersai = createWorkersAI({ binding })
  const result = streamText({
    model: workersai('@cf/meta/llama-4-scout-17b-16e-instruct'),
    prompt: 'irrelevant — the binding is stubbed',
  })
  let text = ''
  for await (const delta of result.textStream) text += delta
  return text
}

describe('workers-ai-provider text streaming', () => {
  it('emits each token once when a chunk carries both response and delta.content', async () => {
    const text = await collect(
      bindingReturning([
        JSON.stringify({ response: 'ABC', choices: [{ delta: { content: 'ABC' } }] }),
        JSON.stringify({ response: 'DE', choices: [{ delta: { content: 'DE' } }] }),
      ]),
    )

    expect(text).toBe('ABCDE')
    expect(text).not.toBe('ABCABCDEDE')
  })

  it('still emits text from chunks that only carry the native response field', async () => {
    const text = await collect(
      bindingReturning([JSON.stringify({ response: 'ABC' }), JSON.stringify({ response: 'DE' })]),
    )

    expect(text).toBe('ABCDE')
  })

  it('still emits text from chunks that only carry the OpenAI-shaped delta', async () => {
    const text = await collect(
      bindingReturning([
        JSON.stringify({ choices: [{ delta: { content: 'ABC' } }] }),
        JSON.stringify({ choices: [{ delta: { content: 'DE' } }] }),
      ]),
    )

    expect(text).toBe('ABCDE')
  })

  it('preserves genuinely repeated tokens (a dedupe-based fix would eat these)', async () => {
    const text = await collect(
      bindingReturning([
        JSON.stringify({ response: 'very ', choices: [{ delta: { content: 'very ' } }] }),
        JSON.stringify({ response: 'very ', choices: [{ delta: { content: 'very ' } }] }),
        JSON.stringify({ response: 'fast', choices: [{ delta: { content: 'fast' } }] }),
      ]),
    )

    expect(text).toBe('very very fast')
  })
})
