import type { Context, MiddlewareHandler } from 'hono'
import type { AppEnv } from './context'

/**
 * Rate limiting for the unauthenticated auth surface (sign-in / sign-up /
 * token), backed by Workers Rate Limiting bindings.
 *
 * Two layers:
 *  - per-IP, across all auth POSTs — blunt flood/credential-stuffing control;
 *  - per-account, on sign-in — slows targeted brute force of one email even
 *    when the attacker rotates source IPs.
 *
 * Argon2id already makes each guess expensive, but online guessing and account
 * enumeration still warrant a request cap. These bindings are per-Cloudflare-
 * location and intentionally permissive (see the Rate Limiting docs), so pair
 * them with WAF rate-limiting rules for a global ceiling.
 *
 * Fails OPEN when the binding is absent (local dev / unit tests) — this is abuse
 * mitigation, not authorization, so an unconfigured limiter must never lock out
 * legitimate traffic.
 */

const RETRY_AFTER_SECONDS = 60

function tooManyRequests(c: Context<AppEnv>): Response {
  c.header('Retry-After', String(RETRY_AFTER_SECONDS))
  return c.json(
    { error: 'rate_limited', detail: 'Too many requests. Please try again shortly.' },
    429,
  )
}

/** Caller IP for rate-limit keys; Cloudflare sets cf-connecting-ip at the edge. */
export function clientIp(c: Context<AppEnv>): string {
  return c.req.header('cf-connecting-ip') ?? 'unknown'
}

/** Per-IP rate-limit middleware. `scope` namespaces the key per endpoint. */
export function rateLimitByIp(
  pick: (env: Env) => RateLimit | undefined,
  scope: string,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const limiter = pick(c.env)
    if (limiter) {
      const { success } = await limiter.limit({ key: `${scope}:${clientIp(c)}` })
      if (!success) return tooManyRequests(c)
    }
    await next()
  }
}

/**
 * Imperative limit check for keys only known after body validation (e.g. the
 * account email). Returns a 429 Response when blocked, else null to continue.
 */
export async function enforceRateLimit(
  c: Context<AppEnv>,
  limiter: RateLimit | undefined,
  key: string,
): Promise<Response | null> {
  if (!limiter) return null
  const { success } = await limiter.limit({ key })
  return success ? null : tooManyRequests(c)
}
