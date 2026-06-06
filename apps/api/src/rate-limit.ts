import type { Context, MiddlewareHandler } from 'hono'

/**
 * Abuse controls for the api's non-console surfaces, backed by Workers Rate
 * Limiting bindings (same pattern as apps/auth):
 *
 *  - per-IP on /machine/* — environment API keys are bearer credentials looked
 *    up by hash, so unauthenticated guessing must be capped before the lookup;
 *  - per-IP on /internal/shares consume — share ids are capabilities; cap
 *    online guessing even behind the INTERNAL_TOKEN;
 *  - per-user on the AI endpoints (search / assistant) — metered upstream work.
 *
 * Bindings are per-Cloudflare-location and intentionally permissive; pair with
 * WAF rate-limiting rules for a global ceiling.
 *
 * Fails OPEN when a binding is absent (local dev / the vitest pool, whose
 * wrangler.test.jsonc omits ratelimits) — this is abuse mitigation, not
 * authorization, so an unconfigured limiter must never block legitimate traffic.
 */

type BoundEnv = { Bindings: Env }

const RETRY_AFTER_SECONDS = 60

function tooManyRequests<E extends BoundEnv>(c: Context<E>): Response {
  c.header('Retry-After', String(RETRY_AFTER_SECONDS))
  return c.json(
    { error: 'rate_limited', detail: 'Too many requests. Please try again shortly.' },
    429,
  )
}

/** Caller IP for rate-limit keys; Cloudflare sets cf-connecting-ip at the edge. */
function clientIp<E extends BoundEnv>(c: Context<E>): string {
  return c.req.header('cf-connecting-ip') ?? 'unknown'
}

/** Per-IP rate-limit middleware. `scope` namespaces the key per endpoint. */
export function rateLimitByIp<E extends BoundEnv>(
  pick: (env: Env) => RateLimit | undefined,
  scope: string,
): MiddlewareHandler<E> {
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
 * Imperative limit check for keys only known inside a handler (e.g. the
 * authenticated user id). Returns a 429 Response when blocked, else null.
 */
export async function enforceRateLimit<E extends BoundEnv>(
  c: Context<E>,
  limiter: RateLimit | undefined,
  key: string,
): Promise<Response | null> {
  if (!limiter) return null
  const { success } = await limiter.limit({ key })
  return success ? null : tooManyRequests(c)
}
