import { describe, expect, it, vi } from 'vitest'
import {
  configEmbeddingText,
  configVectorId,
  embedText,
  heuristicRisk,
  scoreConfigRisk,
  searchConfigs,
  upsertConfigVector,
} from '../src/index'
import type { EmbeddingRunner, TextRunner, VectorizeBinding } from '../src/types'

const fakeEmbedder = (vec = [0.1, 0.2, 0.3]): EmbeddingRunner => ({
  run: vi.fn(async (_model: string, inputs: { text: string[] }) => ({
    data: inputs.text.map(() => vec),
  })),
})

describe('embeddings', () => {
  it('embeds text and returns the first vector', async () => {
    expect(await embedText(fakeEmbedder([1, 2]), 'm', 'hello')).toEqual([1, 2])
  })

  it('builds embedding text from a config item', () => {
    const text = configEmbeddingText({
      key: 'a.b',
      kind: 'flag',
      content: '{"on":true}',
      contentType: 'json',
    })
    expect(text).toContain('flag a.b (json)')
    expect(text).toContain('{"on":true}')
  })
})

describe('search', () => {
  it('hashes a stable, Vectorize-safe (≤64 byte) vector id per (workspace, env, key)', async () => {
    const ref = { workspaceId: 'w', environmentId: 'e', key: 'k' }
    const id = await configVectorId(ref)
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/) // base64url SHA-256, well under 64 bytes
    expect(await configVectorId(ref)).toBe(id) // deterministic
    // Distinct inputs (even with long UUIDs) yield distinct, still-short ids.
    const other = await configVectorId({
      workspaceId: '11111111-1111-1111-1111-111111111111',
      environmentId: '22222222-2222-2222-2222-222222222222',
      key: 'some.very.long.config.key.name',
    })
    expect(other).not.toBe(id)
    expect(other.length).toBeLessThanOrEqual(64)
  })

  it('upserts with workspace namespace + metadata', async () => {
    const vectorize = {
      upsert: vi.fn(async () => ({})),
      query: vi.fn(),
    } as unknown as VectorizeBinding
    await upsertConfigVector(vectorize, [0.1], {
      workspaceId: 'w',
      environmentId: 'e',
      key: 'k',
      kind: 'flag',
    })
    expect(vectorize.upsert).toHaveBeenCalledWith([
      expect.objectContaining({
        id: await configVectorId({ workspaceId: 'w', environmentId: 'e', key: 'k' }),
        namespace: 'w',
        metadata: expect.objectContaining({ key: 'k', kind: 'flag' }),
      }),
    ])
  })

  it('embeds the query and maps Vectorize matches to hits', async () => {
    const vectorize: VectorizeBinding = {
      upsert: vi.fn(),
      query: vi.fn(async () => ({
        matches: [
          {
            id: 'w:e:checkout',
            score: 0.92,
            metadata: { key: 'checkout', environmentId: 'e', kind: 'flag' },
          },
          { id: 'bad', score: 0.1, metadata: {} }, // dropped (no key)
        ],
      })),
    }
    const hits = await searchConfigs(
      { ai: fakeEmbedder(), vectorize, embeddingModel: 'm' },
      { workspaceId: 'w', query: 'checkout flag' },
    )
    expect(hits).toEqual([{ key: 'checkout', environmentId: 'e', kind: 'flag', score: 0.92 }])
  })
})

describe('risk scoring', () => {
  it('heuristic: prod target is high risk + needs approval', () => {
    const r = heuristicRisk({
      key: 'k',
      kind: 'flag',
      targetEnvironmentSlug: 'prod',
      oldContent: null,
      newContent: '{}',
    })
    expect(r.level).toBe('high')
    expect(r.requiresApproval).toBe(true)
  })

  it('heuristic: detects a large rollout jump', () => {
    const r = heuristicRisk({
      key: 'k',
      kind: 'flag',
      targetEnvironmentSlug: 'dev',
      oldContent: '{"rollout":10}',
      newContent: '{"rollout":100}',
    })
    expect(r.reasons.some((x) => x.includes('rollout'))).toBe(true)
  })

  it('AI can raise risk above the heuristic floor', async () => {
    const ai: TextRunner = {
      run: vi.fn(async () => ({ response: '{"level":"high","reasons":["touches billing"]}' })),
    }
    const r = await scoreConfigRisk(ai, 'm', {
      key: 'billing.rate',
      kind: 'config',
      targetEnvironmentSlug: 'dev',
      oldContent: '1',
      newContent: '2',
    })
    expect(r.level).toBe('high')
    expect(r.source).toBe('ai')
    expect(r.reasons).toContain('touches billing')
  })

  it('AI cannot lower risk below the heuristic floor', async () => {
    const ai: TextRunner = {
      run: vi.fn(async () => ({ response: '{"level":"low","reasons":[]}' })),
    }
    const r = await scoreConfigRisk(ai, 'm', {
      key: 'k',
      kind: 'flag',
      targetEnvironmentSlug: 'production',
      oldContent: null,
      newContent: '{}',
    })
    expect(r.level).toBe('high') // prod floor wins
    expect(r.requiresApproval).toBe(true)
  })

  it('falls back to the heuristic when the model errors', async () => {
    const ai: TextRunner = {
      run: vi.fn(async () => {
        throw new Error('AI unavailable')
      }),
    }
    const r = await scoreConfigRisk(ai, 'm', {
      key: 'k',
      kind: 'config',
      targetEnvironmentSlug: 'dev',
      oldContent: null,
      newContent: '{}',
    })
    expect(r.source).toBe('heuristic')
    expect(r.level).toBe('low')
  })
})
