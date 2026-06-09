import {
  type AccessTokenClaims,
  createJwkSet,
  type JWK,
  type JwkSet,
  REVEAL_TOKEN_AUDIENCE,
  verifyWithJwkSet,
} from '@edgevault/auth'
import type { MiddlewareHandler } from 'hono'
import type { AppEnv } from '../context'

/**
 * Verify a Bearer access token against the auth worker's JWKS (fetched via the
 * AUTH_SERVICE binding and cached per isolate). Sets `userId`/`orgId`.
 */

const JWKS_TTL_MS = 5 * 60 * 1000
let cached: { set: JwkSet; at: number } | null = null

async function getJwkSet(env: Env, forceRefresh: boolean): Promise<JwkSet> {
  if (!forceRefresh && cached && Date.now() - cached.at < JWKS_TTL_MS) return cached.set
  const res = await env.AUTH_SERVICE.fetch('https://auth.internal/.well-known/jwks.json')
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`)
  const jwks = (await res.json()) as { keys: JWK[] }
  const set = createJwkSet(jwks)
  cached = { set, at: Date.now() }
  return set
}

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  // Prefer the Authorization header. The ?token= fallback exists only for
  // WebSocket upgrades, where browsers cannot set request headers — restrict it
  // to those so access tokens never land in plain request URLs (and thus logs,
  // analytics, and Referer) on ordinary REST calls.
  const header = c.req.header('authorization')
  const isWebSocketUpgrade = c.req.header('upgrade')?.toLowerCase() === 'websocket'
  const token = header?.toLowerCase().startsWith('bearer ')
    ? header.slice(7)
    : isWebSocketUpgrade
      ? c.req.query('token')
      : undefined
  if (!token) return c.json({ error: 'unauthorized' }, 401)

  const opts = { issuer: c.env.AUTH_ISSUER }
  try {
    let claims: AccessTokenClaims
    try {
      claims = await verifyWithJwkSet(token, await getJwkSet(c.env, false), opts)
    } catch {
      // Key may have rotated — refresh the JWKS once and retry.
      claims = await verifyWithJwkSet(token, await getJwkSet(c.env, true), opts)
    }
    c.set('userId', claims.sub)
    c.set('orgId', claims.org ?? null)
  } catch {
    return c.json({ error: 'invalid_token' }, 401)
  }
  await next()
}

/**
 * Verify a step-up reveal token (minted by `auth`'s /reauth after a fresh second
 * factor) against the same JWKS, by its `secret-reveal` audience. Returns the
 * user id it was minted for, or null if missing/invalid/expired. The caller must
 * still check that id matches the authenticated user.
 */
export async function verifyRevealToken(
  env: Env,
  token: string,
): Promise<AccessTokenClaims | null> {
  const opts = { issuer: env.AUTH_ISSUER, audience: REVEAL_TOKEN_AUDIENCE }
  try {
    try {
      return await verifyWithJwkSet(token, await getJwkSet(env, false), opts)
    } catch {
      // Key may have rotated — refresh the JWKS once and retry.
      return await verifyWithJwkSet(token, await getJwkSet(env, true), opts)
    }
  } catch {
    return null
  }
}
