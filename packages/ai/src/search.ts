import { embedText } from './embeddings'
import type { EmbeddingRunner, VectorizeBinding, VectorizeMatch } from './types'

export interface ConfigVectorRef {
  workspaceId: string
  environmentId: string
  key: string
  kind: string
}

/**
 * Stable vector id per (workspace, env, key) so re-writes update in place.
 * Hashed to a fixed-length base64url string (43 chars) because Vectorize caps ids
 * at 64 bytes and two UUIDs + a key easily exceed that.
 */
export async function configVectorId(ref: {
  workspaceId: string
  environmentId: string
  key: string
}): Promise<string> {
  const data = new Uint8Array(
    new TextEncoder().encode(`${ref.workspaceId}:${ref.environmentId}:${ref.key}`),
  )
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data))
  let bin = ''
  for (const b of digest) bin += String.fromCharCode(b)
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

export async function upsertConfigVector(
  vectorize: VectorizeBinding,
  embedding: number[],
  ref: ConfigVectorRef,
): Promise<void> {
  await vectorize.upsert([
    {
      id: await configVectorId(ref),
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
