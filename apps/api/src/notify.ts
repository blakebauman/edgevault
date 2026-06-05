import { decryptSecret, isSecretEnvelope } from '@edgevault/crypto'
import type { NotificationEvent, NotifyJob } from '@edgevault/edge-protocol'
import { listNotificationChannels, type NotificationChannelRow } from './database/queries'

/**
 * Notification fan-out (producer side). On every notable event the api worker
 * resolves the workspace's channels, decrypts their credentials, and enqueues
 * one fully-materialized NotifyJob per matching channel — the notify worker
 * just delivers. Runs in waitUntil, so it must never throw into the write path
 * and cannot use the request-scoped withDatabase handle (closed after the
 * response): on cache miss it opens its own short-lived connection.
 */

const CACHE_TTL_MS = 30_000
const channelCache = new Map<string, { channels: NotificationChannelRow[]; expires: number }>()

/** Seed the per-isolate cache (channel CRUD routes + tests). */
export function primeChannelCache(workspaceId: string, channels: NotificationChannelRow[]): void {
  channelCache.set(workspaceId, { channels, expires: Date.now() + CACHE_TTL_MS })
}

/** Drop a workspace's cached channels after a CRUD write (other isolates lag ≤30s). */
export function invalidateChannelCache(workspaceId: string): void {
  channelCache.delete(workspaceId)
}

async function loadChannels(env: Env, workspaceId: string): Promise<NotificationChannelRow[]> {
  const cached = channelCache.get(workspaceId)
  if (cached && cached.expires > Date.now()) return cached.channels
  // Dynamic import keeps `pg` (CommonJS) out of the static module graph — same
  // reasoning as the withDatabase middleware (vitest-pool-workers can't
  // transform it). Connection is opened and closed within this call because
  // dispatch outlives the request.
  const { createDatabase } = await import('@edgevault/database')
  const conn = createDatabase(env.HYPERDRIVE.connectionString)
  try {
    const channels = await listNotificationChannels(conn.database, workspaceId)
    primeChannelCache(workspaceId, channels)
    return channels
  } finally {
    await conn.close()
  }
}

export interface ChannelCredentials {
  url: string
  secret?: string
}

export async function decryptChannelCredentials(
  env: Env,
  workspaceId: string,
  channel: Pick<NotificationChannelRow, 'encryptedCredentials'>,
): Promise<ChannelCredentials | null> {
  let envelope: unknown
  try {
    envelope = JSON.parse(channel.encryptedCredentials)
  } catch {
    return null
  }
  if (!isSecretEnvelope(envelope)) return null
  try {
    const plaintext = await decryptSecret(env.MASTER_KEK, workspaceId, envelope)
    const parsed = JSON.parse(plaintext) as ChannelCredentials
    return typeof parsed.url === 'string' ? parsed : null
  } catch {
    return null
  }
}

function channelMatches(channel: NotificationChannelRow, action: string): boolean {
  if (!channel.enabled) return false
  if (!channel.events || channel.events.length === 0) return true
  return channel.events.includes(action)
}

/** Build the delivery job for one channel (exported for the channel-test route). */
export async function buildNotifyJob(
  env: Env,
  channel: NotificationChannelRow,
  event: NotificationEvent,
): Promise<NotifyJob | null> {
  const credentials = await decryptChannelCredentials(env, event.workspaceId, channel)
  if (!credentials) return null
  return {
    channelId: channel.id,
    channelType: channel.type,
    url: credentials.url,
    secret: channel.type === 'webhook' ? credentials.secret : undefined,
    event,
  }
}

/**
 * Fan an event out to every matching channel. Fire-and-forget: failures are
 * logged, never surfaced — notifications must not break config writes.
 */
export async function dispatchNotifications(
  env: Env,
  event: Omit<NotificationEvent, 'at'> & { at?: number },
): Promise<void> {
  try {
    const channels = await loadChannels(env, event.workspaceId)
    const matching = channels.filter((channel) => channelMatches(channel, event.action))
    if (matching.length === 0) return
    const full: NotificationEvent = { ...event, at: event.at ?? Date.now() }
    const jobs = (
      await Promise.all(matching.map((channel) => buildNotifyJob(env, channel, full)))
    ).filter((job): job is NotifyJob => job !== null)
    if (jobs.length > 0) {
      await env.NOTIFY_QUEUE.sendBatch(jobs.map((job) => ({ body: job })))
    }
  } catch (error) {
    console.error('notification dispatch failed', error)
  }
}
