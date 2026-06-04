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

/**
 * Audit event emitted to AUDIT_QUEUE by the api worker on every change, consumed
 * by the audit worker and archived to R2 (the cold, queryable warehouse — vs the
 * DO's hot recent activity log).
 */
export interface AuditEvent {
  at: number
  workspaceId: string
  environmentId?: string
  /** e.g. config.created, config.updated, config.deleted, config.promoted */
  action: string
  /** config | flag | secret | environment */
  resourceType: string
  key?: string
  userId: string
}
