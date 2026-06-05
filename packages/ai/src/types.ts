/**
 * Narrow, binding-agnostic interfaces covering exactly the Workers AI /
 * Vectorize surface this package uses. Keeping them structural (rather than
 * depending on @cloudflare/workers-types) makes the helpers trivially mockable
 * in tests; the real `env.AI` / `env.VECTORIZE` bindings satisfy them.
 */

export interface EmbeddingRunner {
  run(model: string, inputs: { text: string[] }): Promise<{ data: number[][] }>
}

export interface TextRunner {
  run(
    model: string,
    inputs: { messages: Array<{ role: string; content: string }> },
  ): Promise<{ response?: string }>
}

export interface VectorizeVector {
  id: string
  values: number[]
  namespace?: string
  metadata?: Record<string, string | number | boolean>
}

export interface VectorizeMatch {
  id: string
  score: number
  metadata?: Record<string, unknown>
}

export interface VectorizeBinding {
  upsert(vectors: VectorizeVector[]): Promise<unknown>
  deleteByIds(ids: string[]): Promise<unknown>
  query(
    vector: number[],
    options: {
      topK?: number
      namespace?: string
      filter?: Record<string, unknown>
      returnMetadata?: 'all' | 'indexed' | 'none'
    },
  ): Promise<{ matches: VectorizeMatch[] }>
}

// Defaults are swappable via api vars (EMBEDDING_MODEL / TEXT_MODEL). bge-base is
// 768-dim and long-stable; swap to embeddinggemma/qwen3 per the 2026 lineup.
export const DEFAULT_EMBEDDING_MODEL = '@cf/baai/bge-base-en-v1.5'
export const EMBEDDING_DIMENSIONS = 768
export const DEFAULT_TEXT_MODEL = '@cf/meta/llama-3.1-8b-instruct'
