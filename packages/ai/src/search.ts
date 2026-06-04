import { embedText } from './embeddings'
import type { EmbeddingRunner, VectorizeBinding, VectorizeMatch } from './types'

export interface ConfigVectorRef {
  workspaceId: string
  environmentId: string
  key: string
  kind: string
}

/** Stable vector id per (workspace, env, key) so re-writes update in place. */
export function configVectorId(ref: {
  workspaceId: string
  environmentId: string
  key: string
}): string {
  return `${ref.workspaceId}:${ref.environmentId}:${ref.key}`
}

export async function upsertConfigVector(
  vectorize: VectorizeBinding,
  embedding: number[],
  ref: ConfigVectorRef,
): Promise<void> {
  await vectorize.upsert([
    {
      id: configVectorId(ref),
      values: embedding,
      namespace: ref.workspaceId,
      metadata: {
        workspaceId: ref.workspaceId,
        environmentId: ref.environmentId,
        key: ref.key,
        kind: ref.kind,
      },
    },
  ])
}

export interface SearchHit {
  key: string
  environmentId: string
  kind: string
  score: number
}

export async function searchConfigs(
  deps: { ai: EmbeddingRunner; vectorize: VectorizeBinding; embeddingModel: string },
  input: { workspaceId: string; query: string; topK?: number; environmentId?: string },
): Promise<SearchHit[]> {
  const vector = await embedText(deps.ai, deps.embeddingModel, input.query)
  const filter: Record<string, unknown> = { workspaceId: input.workspaceId }
  if (input.environmentId) filter.environmentId = input.environmentId

  const { matches } = await deps.vectorize.query(vector, {
    topK: input.topK ?? 10,
    namespace: input.workspaceId,
    returnMetadata: 'all',
    filter,
  })
  return matches.map(toHit).filter((hit): hit is SearchHit => hit !== null)
}

function toHit(match: VectorizeMatch): SearchHit | null {
  const metadata = match.metadata
  if (!metadata || typeof metadata.key !== 'string') return null
  return {
    key: metadata.key,
    environmentId: String(metadata.environmentId ?? ''),
    kind: String(metadata.kind ?? 'config'),
    score: match.score,
  }
}
