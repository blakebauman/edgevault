import {
  type ApiKeyRecord,
  apiKeyCacheKey,
  configCacheKey,
  type ResolvedConfig,
} from '@edgevault/edge-protocol'
import type { ConfigItem } from './durable-objects/types'

/**
 * Write-through to the edge cache (KV) so the delivery worker serves pre-resolved
 * config/flag values without touching the DO on the hot path. Secret plaintext
 * is never written to the edge cache.
 */
export function writeThrough(env: Env, workspaceId: string, item: ConfigItem): Promise<void> {
  if (item.kind === 'secret') return Promise.resolve()
  const value: ResolvedConfig = {
    content: item.content,
    contentType: item.contentType,
    kind: item.kind,
    version: item.version,
  }
  return env.CONFIGS_CACHE.put(
    configCacheKey(workspaceId, item.environmentId, item.key),
    JSON.stringify(value),
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
