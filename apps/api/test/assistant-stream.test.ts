import { stepCountIs, streamText, tool } from 'ai'
import { describe, expect, it } from 'vitest'
import { createWorkersAI } from 'workers-ai-provider'
import { z } from 'zod'

/**
 * Regression guard for the assistant's two duplication bugs, which share one
 * root cause: a Workers AI stream chunk carries the same payload TWICE, once in
 * the native top-level fields and once in the OpenAI-shaped `choices[0].delta`.
 * `workers-ai-provider` has a separate emit branch for each and guards neither.
 *
 *   text:       `response`   + `delta.content`   → "HelloHello!!"
 *   tool calls: `tool_calls` + `delta.tool_calls` → args concatenated into
 *                                                   invalid JSON, so every
 *                                                   tool call errors out
 *
 * Fixed by `patches/workers-ai-provider@3.2.0.patch` (upstream is still
 * unguarded as of 4.0.0). If that patch stops applying, these tests fail.
 *
 * The fixtures below are trimmed copies of real chunks captured from
 * `@cf/meta/llama-4-scout-17b-16e-instruct` over `wrangler dev --remote`.
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

describe('workers-ai-provider tool-call streaming', () => {
  /**
   * A tool-call chunk as Workers AI really sends it: the same call in the
   * native top-level `tool_calls` (object args, no id) AND the OpenAI-shaped
   * `delta.tool_calls` (string args, real id + index).
   */
  const toolCallChunk = JSON.stringify({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              function: { arguments: '{"limit": 25}', name: 'recentActivity' },
              id: 'chatcmpl-tool-8238b28f7eea859c',
              index: 0,
              type: 'function',
            },
          ],
        },
        finish_reason: null,
        index: 0,
      },
    ],
    tool_calls: [{ arguments: { limit: 25 }, name: 'recentActivity' }],
  })

  const finishChunk = JSON.stringify({
    choices: [{ delta: { content: '' }, finish_reason: 'tool_calls', index: 0 }],
    response: '',
    tool_calls: [],
  })

  it('parses tool input once instead of concatenating both shapes into invalid JSON', async () => {
    const calls: Array<{ limit?: number }> = []
    const workersai = createWorkersAI({ binding: bindingReturning([toolCallChunk, finishChunk]) })

    const result = streamText({
      model: workersai('@cf/meta/llama-4-scout-17b-16e-instruct'),
      prompt: 'What changed recently?',
      tools: {
        recentActivity: tool({
          description: 'List recent configuration changes.',
          inputSchema: z.object({ limit: z.number().int().optional() }),
          execute: async (input) => {
            calls.push(input)
            return []
          },
        }),
      },
      stopWhen: stepCountIs(1),
    })
    await result.consumeStream()

    // Unpatched this is `{"limit": 25}{"limit":25}` → tool-input-error, the
    // tool never runs, and the user gets "An error occurred."
    expect(calls).toEqual([{ limit: 25 }])
  })

  it('keeps the model-supplied tool call id rather than a synthesized one', async () => {
    const workersai = createWorkersAI({ binding: bindingReturning([toolCallChunk, finishChunk]) })

    const result = streamText({
      model: workersai('@cf/meta/llama-4-scout-17b-16e-instruct'),
      prompt: 'What changed recently?',
      tools: {
        recentActivity: tool({
          description: 'List recent configuration changes.',
          inputSchema: z.object({ limit: z.number().int().optional() }),
          execute: async () => [],
        }),
      },
      stopWhen: stepCountIs(1),
    })
    await result.consumeStream()

    const toolCalls = await result.toolCalls
    expect(toolCalls).toHaveLength(1)
    // The native shape carries no id, so the unguarded branch invented one.
    expect(toolCalls[0]?.toolCallId).toContain('chatcmpl-tool-8238b28f7eea859c')
  })

  it('still emits tool calls from chunks that only carry the native shape', async () => {
    const calls: Array<{ limit?: number }> = []
    const nativeOnly = JSON.stringify({
      tool_calls: [{ arguments: { limit: 5 }, name: 'recentActivity' }],
    })
    const workersai = createWorkersAI({ binding: bindingReturning([nativeOnly, finishChunk]) })

    const result = streamText({
      model: workersai('@cf/meta/llama-4-scout-17b-16e-instruct'),
      prompt: 'What changed recently?',
      tools: {
        recentActivity: tool({
          description: 'List recent configuration changes.',
          inputSchema: z.object({ limit: z.number().int().optional() }),
          execute: async (input) => {
            calls.push(input)
            return []
          },
        }),
      },
      stopWhen: stepCountIs(1),
    })
    await result.consumeStream()

    expect(calls).toEqual([{ limit: 5 }])
  })
})
