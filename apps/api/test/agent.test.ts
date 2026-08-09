import { env } from 'cloudflare:test'
import { isAssistantProposal } from '@edgevault/edge-protocol'
import { describe, expect, it } from 'vitest'
import {
  assistantProposalSchema,
  configChangeProposalSchema,
  configChangeToolInput,
  promotionToolInput,
  toConfigChangeProposal,
  toPromotionProposal,
} from '../src/agent/proposals'
import { activeProvider, supportsStructuredTools } from '../src/agent/providers'
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

describe('tool input schemas', () => {
  // llama-4-scout failed proposeChange five times running on staging because
  // the tool asked it for `kind` — a constant the tool name already implies —
  // and hard-required a rationale. Lenient about phrasing, strict about
  // invariants.
  const modelArgs = {
    environmentId: 'env_1',
    key: 'checkout-timeout-ms',
    itemKind: 'config' as const,
    content: '{"ms":3000}',
  }

  it('accepts model input that omits kind and rationale', () => {
    expect(configChangeToolInput.safeParse(modelArgs).success).toBe(true)
  })

  it('rebuilds the full wire proposal, defaulting the rationale', () => {
    const proposal = toConfigChangeProposal(configChangeToolInput.parse(modelArgs))
    expect(proposal.kind).toBe('config-change')
    expect(proposal.rationale.length).toBeGreaterThan(0)
    // Must satisfy the guard the console applies before it will render or apply.
    expect(isAssistantProposal(proposal)).toBe(true)
  })

  it('keeps the model-supplied rationale when there is one', () => {
    const proposal = toConfigChangeProposal(
      configChangeToolInput.parse({ ...modelArgs, rationale: 'Upstream times out sooner.' }),
    )
    expect(proposal.rationale).toBe('Upstream times out sooner.')
  })

  it('accepts structured content and serializes it, so the model never escapes JSON', () => {
    // The staging failure: asked for a string, llama-4-scout produced
    // `"{\"\s\":3000}"` and truncated. Letting it send the object sidesteps it.
    const parsed = configChangeToolInput.safeParse({ ...modelArgs, content: { ms: 3000 } })
    expect(parsed.success).toBe(true)
    const proposal = toConfigChangeProposal(parsed.data as never)
    expect(typeof proposal.kind === 'string' && proposal.kind).toBe('config-change')
    const content = (proposal as { content: string }).content
    expect(JSON.parse(content)).toEqual({ ms: 3000 })
    expect(isAssistantProposal(proposal)).toBe(true)
  })

  it('still passes a plain string through untouched', () => {
    const proposal = toConfigChangeProposal(
      configChangeToolInput.parse({ ...modelArgs, content: 'plain-text-value' }),
    )
    expect((proposal as { content: string }).content).toBe('plain-text-value')
  })

  it('still refuses a secret and a bad key', () => {
    expect(configChangeToolInput.safeParse({ ...modelArgs, itemKind: 'secret' }).success).toBe(
      false,
    )
    expect(configChangeToolInput.safeParse({ ...modelArgs, key: 'not a key!' }).success).toBe(false)
  })

  it('does the same for promotions', () => {
    const input = promotionToolInput.parse({
      sourceEnvironmentId: 'env_a',
      targetEnvironmentId: 'env_b',
      key: 'checkout-timeout-ms',
    })
    const proposal = toPromotionProposal(input)
    expect(proposal.kind).toBe('promotion')
    expect(isAssistantProposal(proposal)).toBe(true)
  })
})

describe('provider selection', () => {
  // Built from the ambient env with the key removed rather than read from it: a
  // developer who sets ANTHROPIC_API_KEY in .dev.vars must not flip the meaning
  // of these assertions. Deleted rather than set to undefined, because
  // `wrangler types` types it as a required string once it is in .dev.vars.
  const { ANTHROPIC_API_KEY: _ignored, ...rest } = env as Env & { ANTHROPIC_API_KEY?: string }
  const withoutKey = rest as Env
  const withKey = { ...rest, ANTHROPIC_API_KEY: 'sk-ant-test' } as Env

  it('defaults to Workers AI when no third-party key is set', () => {
    // The MIT core must run on a Cloudflare account alone; reaching for a paid
    // provider has to be a deliberate act.
    expect(activeProvider(withoutKey)).toBe('workers-ai')
  })

  it('switches to Anthropic only when a key is present', () => {
    expect(activeProvider(withKey)).toBe('anthropic')
  })

  it('offers the proposal tools only where the model can produce them', () => {
    // Measured on staging: llama-4-scout failed proposeChange on every attempt
    // across three schema revisions, while the single-argument read tools were
    // reliable. Advertising a capability that always fails is worse than not
    // having it, so Workers AI gets a read-only assistant.
    expect(supportsStructuredTools(withoutKey)).toBe(false)
    expect(supportsStructuredTools(withKey)).toBe(true)
  })
})
