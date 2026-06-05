import {
  configEmbeddingText,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_TEXT_MODEL,
  deleteConfigVector,
  type EmbeddingRunner,
  embedText,
  type TextRunner,
  upsertConfigVector,
  type VectorizeBinding,
} from '@edgevault/ai'
import type { ConfigItem } from './durable-objects/types'

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

/** Embed a config item and upsert it to Vectorize. Skips secrets; never throws. */
export async function indexConfig(env: Env, workspaceId: string, item: ConfigItem): Promise<void> {
  if (item.kind === 'secret') return
  try {
    const vector = await embedText(aiRunner(env), embeddingModel(env), configEmbeddingText(item))
    await upsertConfigVector(vectorize(env), vector, {
      workspaceId,
      environmentId: item.environmentId,
      key: item.key,
      kind: item.kind,
    })
  } catch (err) {
    // Best-effort indexing — never blocks a write, but log so failures are visible.
    console.error('indexConfig failed', err)
  }
}

/** Remove a deleted config's vector so it stops surfacing in search. Never throws. */
export async function unindexConfig(
  env: Env,
  workspaceId: string,
  environmentId: string,
  key: string,
): Promise<void> {
  try {
    // No kind check: secrets are never indexed, and deleting an absent id is a no-op.
    await deleteConfigVector(vectorize(env), { workspaceId, environmentId, key })
  } catch (err) {
    console.error('unindexConfig failed', err)
  }
}
