/**
 * Shared contract between the api worker (writer) and the delivery worker
 * (reader) for the edge cache (KV). Keeping the key formats and value shapes in
 * one place prevents the two workers from drifting.
 */

export type ConfigCacheKind = 'config' | 'flag'

/** Pre-resolved config/flag value served from the edge (`CONFIGS_CACHE`). */
export interface ResolvedConfig {
  content: string
  contentType: string
  kind: ConfigCacheKind
  version: number
}

/** Environment an API key maps to (`ENVIRONMENT_API_KEYS`). */
export interface ApiKeyRecord {
  workspaceId: string
  environmentId: string
  scopes: string[]
}

/** `config:{workspaceId}:{environmentId}:{key}` */
export function configCacheKey(workspaceId: string, environmentId: string, key: string): string {
  return `config:${workspaceId}:${environmentId}:${key}`
}

/** `apikey:{sha256hex}` */
export function apiKeyCacheKey(keyHash: string): string {
  return `apikey:${keyHash}`
}
