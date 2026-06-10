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

/**
 * Valid config/flag/secret key: the character set `${...}` references can name
 * (packages/refs) and that composes safely into the `config:{ws}:{env}:{key}`
 * cache key below. Enforced at every write surface (HTTP, MCP).
 */
export const CONFIG_KEY_PATTERN = /^[a-zA-Z0-9._-]+$/
export const MAX_CONFIG_KEY_LENGTH = 256

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
  /** config | flag | secret | environment | edge_read */
  resourceType: string
  key?: string
  userId: string
  /**
   * For `secret.revealed`: whether the reveal was backed by a fresh step-up
   * (passkey/TOTP), versus session auth alone. Lets the warehouse tell apart
   * step-up-verified reveals from ones an org's policy didn't require.
   */
  stepUp?: boolean
  /**
   * How many billable occurrences this record represents. Defaults to 1 for a
   * normal per-change audit event. High-volume signals that are pre-aggregated
   * at the edge (e.g. `edge_read` counts from the delivery worker) set this so
   * one record can stand in for many reads without one event per read.
   */
  count?: number
  /**
   * Extra structured context for the warehouse — names/identifiers only,
   * never secret values (e.g. which secret keys a machine export decrypted).
   */
  detail?: Record<string, string>
}

/**
 * Notification fan-out contract between the api worker (producer) and the
 * notify worker (consumer of NOTIFY_QUEUE). The api resolves channels and
 * decrypts their credentials at dispatch time, so each job is fully
 * materialized — the notify worker never touches Postgres or the KEK.
 */

/** Actions a notification channel can subscribe to. */
export const NOTIFY_ACTIONS = [
  'config.created',
  'config.updated',
  'config.deleted',
  'config.promoted',
  'promotion.awaiting_approval',
  'secret.revealed',
] as const

export type NotifyAction = (typeof NOTIFY_ACTIONS)[number]

/** The event payload delivered to webhooks / formatted for Slack. */
export interface NotificationEvent {
  at: number
  workspaceId: string
  environmentId?: string
  /** A NotifyAction, or 'test' for channel test deliveries. */
  action: string
  resourceType: string
  key?: string
  userId: string
  /** Extra human-facing context, e.g. riskLevel / promotionId / instanceId. */
  detail?: Record<string, string>
}

/** One delivery job on NOTIFY_QUEUE: a single event to a single channel. */
export interface NotifyJob {
  channelId: string
  channelType: 'webhook' | 'slack'
  /** Decrypted destination URL — transits only the internal queue. */
  url: string
  /** HMAC-SHA256 signing secret for generic webhooks (absent for Slack). */
  secret?: string
  event: NotificationEvent
}

/**
 * Transactional org-invitation email, also carried on NOTIFY_QUEUE (same
 * consumer, same retry/DLQ semantics). Fully materialized like NotifyJob —
 * the notify worker never touches Postgres.
 */
export interface InvitationEmailJob {
  kind: 'invitation-email'
  to: string
  organizationName: string
  inviterName: string
  role: string
  /** Console accept link: `${CONSOLE_URL}/invite/{invitationId}`. */
  acceptUrl: string
  /** Epoch ms — the invitation stops working after this. */
  expiresAt: number
}

/** Everything the notify worker consumes. NotifyJob predates `kind`. */
export type NotifyQueueMessage = NotifyJob | InvitationEmailJob

export function isInvitationEmailJob(job: NotifyQueueMessage): job is InvitationEmailJob {
  return 'kind' in job && job.kind === 'invitation-email'
}
