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
  /** Epoch ms; absent = never expires. KV TTL mirrors it, this is the check. */
  expiresAt?: number
  /** Optional source-IP restriction (CIDRs). Absent/empty = any IP. */
  allowedCidrs?: string[]
}

// --- CIDR matching (shared by delivery + machine auth; no dependencies) -----

function parseIpv4(ip: string): bigint | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let value = 0n
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const n = Number(part)
    if (n > 255) return null
    value = (value << 8n) | BigInt(n)
  }
  return value
}

function parseIpv6(ip: string): bigint | null {
  const dc = ip.indexOf('::')
  if (dc !== ip.lastIndexOf('::')) return null
  const head = dc === -1 ? ip : ip.slice(0, dc)
  const tail = dc === -1 ? '' : ip.slice(dc + 2)

  const expand = (s: string): bigint[] | null => {
    if (s === '') return []
    const out: bigint[] = []
    const parts = s.split(':')
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i] ?? ''
      if (part.includes('.')) {
        // Embedded IPv4 (e.g. ::ffff:192.0.2.1) — only valid as the last group.
        if (i !== parts.length - 1) return null
        const v4 = parseIpv4(part)
        if (v4 === null) return null
        out.push((v4 >> 16n) & 0xffffn, v4 & 0xffffn)
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null
        out.push(BigInt(Number.parseInt(part, 16)))
      }
    }
    return out
  }

  const h = expand(head)
  const t = expand(tail)
  if (!h || !t) return null
  // With '::' at least one group is elided; without it, exactly 8 are present.
  const missing = 8 - h.length - t.length
  if (dc !== -1 && missing < 1) return null
  const groups = dc === -1 ? h : [...h, ...Array<bigint>(missing).fill(0n), ...t]
  if (groups.length !== 8 || (dc === -1 && t.length > 0)) return null
  let value = 0n
  for (const g of groups) value = (value << 16n) | g
  return value
}

function parseIp(ip: string): { value: bigint; bits: 32 | 128 } | null {
  if (ip.includes(':')) {
    const value = parseIpv6(ip)
    return value === null ? null : { value, bits: 128 }
  }
  const value = parseIpv4(ip)
  return value === null ? null : { value, bits: 32 }
}

/** Is `cidr` a valid IPv4/IPv6 CIDR (or bare address)? Used at mint time. */
export function isValidCidr(cidr: string): boolean {
  const [base, prefix, extra] = cidr.split('/')
  if (extra !== undefined || !base) return false
  const addr = parseIp(base)
  if (!addr) return false
  if (prefix === undefined) return true
  if (!/^\d{1,3}$/.test(prefix)) return false
  return Number(prefix) <= addr.bits
}

/**
 * Does `ip` fall inside any of `cidrs`? Unparseable entries are skipped;
 * an unparseable ip never matches (fail closed for the allowlist check).
 */
export function ipMatchesCidrs(ip: string, cidrs: string[]): boolean {
  const addr = parseIp(ip)
  if (!addr) return false
  for (const cidr of cidrs) {
    const [base, prefixStr] = cidr.split('/')
    if (!base) continue
    const baseAddr = parseIp(base)
    if (!baseAddr || baseAddr.bits !== addr.bits) continue
    const prefix = prefixStr === undefined ? baseAddr.bits : Number(prefixStr)
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > baseAddr.bits) continue
    const shift = BigInt(baseAddr.bits - prefix)
    if (addr.value >> shift === baseAddr.value >> shift) return true
  }
  return false
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

/** Email-verification link for a fresh password signup. */
export interface VerificationEmailJob {
  kind: 'verification-email'
  to: string
  /** Console verify link: `${CONSOLE_URL}/verify-email?token=…`. */
  verifyUrl: string
  /** Epoch ms — the token stops working after this. */
  expiresAt: number
}

/** Password-reset link (only ever sent to accounts that have a password). */
export interface PasswordResetEmailJob {
  kind: 'password-reset-email'
  to: string
  /** Console reset link: `${CONSOLE_URL}/reset-password?token=…`. */
  resetUrl: string
  /** Epoch ms — the token stops working after this. */
  expiresAt: number
}

/**
 * Sent when a signup hits an already-registered email. The HTTP response is
 * identical to a successful signup (no account enumeration); the owner of the
 * address learns what happened here instead.
 */
export interface SignupExistsEmailJob {
  kind: 'signup-exists-email'
  to: string
  signInUrl: string
  resetUrl: string
}

/** Every transactional email the notify worker can send. */
export type EmailJob =
  | InvitationEmailJob
  | VerificationEmailJob
  | PasswordResetEmailJob
  | SignupExistsEmailJob

/** Everything the notify worker consumes. NotifyJob predates `kind`. */
export type NotifyQueueMessage = NotifyJob | EmailJob

export function isEmailJob(job: NotifyQueueMessage): job is EmailJob {
  return 'kind' in job
}

export function isInvitationEmailJob(job: NotifyQueueMessage): job is InvitationEmailJob {
  return 'kind' in job && job.kind === 'invitation-email'
}
