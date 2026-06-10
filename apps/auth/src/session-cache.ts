import { hashToken } from '@edgevault/auth'
import type { Context } from 'hono'
import type { AppEnv } from './context'
import {
  invalidateSession,
  type PublicUser,
  type ValidatedSession,
  validateSessionToken,
} from './services'

/**
 * Read-through cache for session validation over AUTH_CACHE (KV). The first
 * validate after sign-in reads Neon and populates KV; subsequent validates are
 * sub-ms edge reads. TTL is short (KV minimum, 60s) so revocation lag is bounded,
 * and sign-out purges the key for immediate revocation. Falls through to Neon
 * when the binding is absent (dev/tests).
 */

const TTL_SECONDS = 60

interface CachedSession {
  user: PublicUser
  activeOrganizationId: string | null
  authMethod: string | null
  expiresAt: string
}

function keyFor(token: string): string {
  return `session:${hashToken(token)}`
}

export async function validateSessionCached(
  c: Context<AppEnv>,
  token: string,
): Promise<ValidatedSession | null> {
  const cache = c.env.AUTH_CACHE
  const key = keyFor(token)

  if (cache) {
    const hit = (await cache.get(key, 'json')) as CachedSession | null
    if (hit) {
      const expiresAt = new Date(hit.expiresAt)
      if (expiresAt.getTime() > Date.now()) {
        return {
          user: hit.user,
          activeOrganizationId: hit.activeOrganizationId,
          authMethod: hit.authMethod ?? null,
          expiresAt,
        }
      }
    }
  }

  const session = await validateSessionToken(c.var.database, token)
  if (session && cache) {
    const payload: CachedSession = {
      user: session.user,
      activeOrganizationId: session.activeOrganizationId,
      authMethod: session.authMethod,
      expiresAt: session.expiresAt.toISOString(),
    }
    c.executionCtx.waitUntil(
      cache.put(key, JSON.stringify(payload), { expirationTtl: TTL_SECONDS }),
    )
  }
  return session
}

export async function invalidateSessionCached(c: Context<AppEnv>, token: string): Promise<void> {
  await invalidateSession(c.var.database, token)
  if (c.env.AUTH_CACHE) c.executionCtx.waitUntil(c.env.AUTH_CACHE.delete(keyFor(token)))
}

/**
 * Purge cached entries for already-deleted sessions by their stored token
 * hashes (what `deleteSessionsForUser` returns). Without this, a revoked
 * session stays valid at the edge for up to the cache TTL.
 */
export function purgeSessionHashes(c: Context<AppEnv>, tokenHashes: string[]): void {
  const cache = c.env.AUTH_CACHE
  if (!cache || tokenHashes.length === 0) return
  c.executionCtx.waitUntil(Promise.all(tokenHashes.map((hash) => cache.delete(`session:${hash}`))))
}
