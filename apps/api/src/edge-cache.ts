import {
  type ApiKeyRecord,
  apiKeyCacheKey,
  configCacheKey,
  type ResolvedConfig,
} from '@edgevault/edge-protocol'
import type { ConfigItem, PublishTarget } from './durable-objects/types'

/**
 * Write-through to the edge cache (KV) so the delivery worker serves pre-resolved
 * config/flag values without touching the DO on the hot path. Secret plaintext
 * is never written to the edge cache.
 *
 * `resolvedContent` is the item's content with ${...} references expanded (from
 * the DO's collectPublishTargets); without it the raw content is published.
 */
export function writeThrough(
  env: Env,
  workspaceId: string,
  item: ConfigItem,
  resolvedContent?: string,
): Promise<void> {
  if (item.kind === 'secret') return Promise.resolve()
  const value: ResolvedConfig = {
    content: resolvedContent ?? item.content,
    contentType: item.contentType,
    kind: item.kind,
    version: item.version,
  }
  return env.CONFIGS_CACHE.put(
    configCacheKey(workspaceId, item.environmentId, item.key),
    JSON.stringify(value),
  )
}

/** Publish a changed item plus its resolved dependents in one go. */
export async function publishTargets(
  env: Env,
  workspaceId: string,
  targets: PublishTarget[],
): Promise<void> {
  await Promise.all(
    targets.map((target) => writeThrough(env, workspaceId, target.item, target.resolvedContent)),
  )
}

export function deleteThrough(
  env: Env,
  workspaceId: string,
  environmentId: string,
  key: string,
): Promise<void> {
  return env.CONFIGS_CACHE.delete(configCacheKey(workspaceId, environmentId, key))
}

/** Publish an API key -> environment mapping for the delivery worker to validate. */
export function publishApiKey(env: Env, keyHash: string, record: ApiKeyRecord): Promise<void> {
  return env.ENVIRONMENT_API_KEYS.put(apiKeyCacheKey(keyHash), JSON.stringify(record))
}
