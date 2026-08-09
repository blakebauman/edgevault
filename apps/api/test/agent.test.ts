import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { assistantProposalSchema, configChangeProposalSchema } from '../src/agent/proposals'
import { activeProvider } from '../src/agent/providers'
import { RATE_LIMITED_MESSAGE, refusalResponse } from '../src/agent/refusal'
import { checkRateLimit } from '../src/rate-limit'

/**
 * Covers the assistant paths that don't call a model — the refusal stream, the
 * proposal contract, and provider selection. The vitest pool's
 * wrangler.test.jsonc omits the AI and Vectorize bindings, so an actual chat
 * turn can't run here; `assistant-stream.test.ts` covers the streaming layer
 * against captured fixtures instead.
 */

/** Parse the SSE body back into the frames the chat client would see. */
async function readFrames(res: Response): Promise<Array<Record<string, unknown>>> {
  const text = await res.text()
  return text
    .split('\n\n')
    .filter((block) => block.startsWith('data: '))
    .map((block) => JSON.parse(block.slice('data: '.length)))
}

describe('refusalResponse', () => {
  it('is tagged as a UI message stream so the client renders it as a turn', async () => {
    const res = refusalResponse('nope')
    expect(res.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1')
    expect(res.headers.get('content-type')).toContain('text/event-stream')
  })

  it('emits a complete, well-ordered single-text-part turn', async () => {
    const frames = await readFrames(refusalResponse('slow down'))
    expect(frames.map((f) => f.type)).toEqual([
      'start',
      'start-step',
      'text-start',
      'text-delta',
      'text-end',
      'finish-step',
      'finish',
    ])
    // A turn the client can't attribute or assemble is worse than no turn:
    // the id must be present and consistent across the text part's frames.
    expect(frames[0]?.messageId).toBeTruthy()
    const partIds = frames.filter((f) => 'id' in f).map((f) => f.id)
    expect(new Set(partIds).size).toBe(1)
  })

  it('carries the message as the delta text', async () => {
    const frames = await readFrames(refusalResponse(RATE_LIMITED_MESSAGE))
    const delta = frames.find((f) => f.type === 'text-delta')
    expect(delta?.delta).toBe(RATE_LIMITED_MESSAGE)
  })

  it('gives each refusal a distinct message id', async () => {
    const [a, b] = await Promise.all([
      readFrames(refusalResponse('one')),
      readFrames(refusalResponse('two')),
    ])
    expect(a[0]?.messageId).not.toBe(b[0]?.messageId)
  })
})

describe('checkRateLimit', () => {
  it('fails open when the binding is absent', async () => {
    // The vitest pool omits ratelimits entirely. Abuse mitigation must never
    // become an outage for a workspace whose limiter isn't configured.
    await expect(checkRateLimit(undefined, 'ai:someone')).resolves.toBe(true)
  })

  it('reports the limiter verdict when one is bound', async () => {
    const allow = { limit: async () => ({ success: true }) } as unknown as RateLimit
    const deny = { limit: async () => ({ success: false }) } as unknown as RateLimit
    await expect(checkRateLimit(allow, 'k')).resolves.toBe(true)
    await expect(checkRateLimit(deny, 'k')).resolves.toBe(false)
  })

  it('keys the limit per user so one heavy user cannot starve another', async () => {
    const seen: string[] = []
    const limiter = {
      limit: async ({ key }: { key: string }) => {
        seen.push(key)
        return { success: true }
      },
    } as unknown as RateLimit
    await checkRateLimit(limiter, 'ai:user-a')
    await checkRateLimit(limiter, 'ai:user-b')
    expect(seen).toEqual(['ai:user-a', 'ai:user-b'])
  })
})

describe('proposal contract', () => {
  const valid = {
    kind: 'config-change' as const,
    environmentId: 'env_1',
    key: 'checkout.timeout',
    itemKind: 'config' as const,
    content: '{"ms":3000}',
    rationale: 'The current value times out before the upstream does.',
  }

  it('accepts a well-formed config change', () => {
    expect(configChangeProposalSchema.safeParse(valid).success).toBe(true)
  })

  it('refuses to carry a secret', () => {
    // A proposal is persisted in the agent's message history and rendered in
    // the thread, so a secret value here would sit in plaintext outside the
    // vault — the thing envelope encryption exists to prevent.
    const result = configChangeProposalSchema.safeParse({ ...valid, itemKind: 'secret' })
    expect(result.success).toBe(false)
  })

  it('rejects keys the write route would reject anyway', () => {
    const result = configChangeProposalSchema.safeParse({ ...valid, key: 'not a valid key!' })
    expect(result.success).toBe(false)
  })

  it('requires a rationale — the card is unreadable without one', () => {
    const { rationale: _drop, ...withoutRationale } = valid
    expect(configChangeProposalSchema.safeParse(withoutRationale).success).toBe(false)
  })

  it('discriminates promotion from config-change', () => {
    const promotion = {
      kind: 'promotion' as const,
      sourceEnvironmentId: 'env_staging',
      targetEnvironmentId: 'env_prod',
      key: 'checkout.timeout',
      rationale: 'Staging has been stable for a week.',
    }
    const parsed = assistantProposalSchema.safeParse(promotion)
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.kind).toBe('promotion')
  })
})

describe('provider selection', () => {
  it('defaults to Workers AI when no third-party key is set', () => {
    // The MIT core must run on a Cloudflare account alone; reaching for a paid
    // provider has to be a deliberate act.
    expect(activeProvider(env)).toBe('workers-ai')
  })

  it('switches to Anthropic only when a key is present', () => {
    expect(activeProvider({ ...env, ANTHROPIC_API_KEY: 'sk-ant-test' } as Env)).toBe('anthropic')
  })
})
