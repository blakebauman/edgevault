import {
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_TEXT_MODEL,
  type EmbeddingRunner,
  type TextRunner,
  type VectorizeBinding,
} from '@edgevault/ai'

/**
 * Wrap `env.AI` so all inference routes through AI Gateway (caching, rate
 * limiting, observability) when AI_GATEWAY_ID is set. Returns an object that
 * satisfies both the embedding and text runner shapes used by @edgevault/ai.
 */
export function aiRunner(env: Env): EmbeddingRunner & TextRunner {
  const options = env.AI_GATEWAY_ID ? { gateway: { id: env.AI_GATEWAY_ID } } : undefined
  const ai = env.AI as unknown as {
    run: (model: string, inputs: unknown, options?: unknown) => Promise<unknown>
  }
  return {
    run: (model: string, inputs: unknown) => ai.run(model, inputs, options),
  } as EmbeddingRunner & TextRunner
}

export function embeddingModel(env: Env): string {
  return env.EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL
}

export function textModel(env: Env): string {
  return env.TEXT_MODEL || DEFAULT_TEXT_MODEL
}

/**
 * Adapt the `VectorizeIndex` binding to the structural `VectorizeBinding` used
 * by @edgevault/ai. The runtime shapes match; the binding's metadata-filter type
 * is just stricter than our generic `Record<string, unknown>`.
 */
export function vectorize(env: Env): VectorizeBinding {
  return env.VECTORIZE as unknown as VectorizeBinding
}
