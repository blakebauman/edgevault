import {
  type AccessTokenClaims,
  createJwkSet,
  type JWK,
  type JwkSet,
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
  // Prefer the Authorization header; fall back to ?token= for WebSocket
  // upgrades, where browsers cannot set request headers.
  const header = c.req.header('authorization')
  const token = header?.toLowerCase().startsWith('bearer ') ? header.slice(7) : c.req.query('token')
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
