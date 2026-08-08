import type { MiddlewareHandler } from 'hono'

// This worker serves JSON only, so the CSP can deny everything; it exists as
// defense-in-depth for any response a browser is tricked into rendering.
const HEADERS: ReadonlyArray<[string, string]> = [
  ['Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'"],
  ['Strict-Transport-Security', 'max-age=31536000; includeSubDomains'],
  ['X-Content-Type-Options', 'nosniff'],
  ['X-Frame-Options', 'DENY'],
  ['Referrer-Policy', 'no-referrer'],
]

// Every response here is scoped to one environment API key, so no shared cache
// may hold it. Responses carried no Cache-Control at all, which leaves them
// eligible for heuristic caching by any intermediary — and would make them
// eligible for a front-of-Worker cache if one were ever enabled on this
// service. Applied only when a route has not set its own.
const DEFAULT_CACHE_CONTROL = 'no-store'

export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next()
  // WebSocket upgrade responses carry immutable headers and never reach a
  // document context — leave them untouched.
  if (c.res.status === 101) return
  try {
    for (const [k, v] of HEADERS) c.res.headers.set(k, v)
    if (!c.res.headers.has('Cache-Control')) {
      c.res.headers.set('Cache-Control', DEFAULT_CACHE_CONTROL)
    }
  } catch {
    // Passthrough responses (DO/service-binding fetch) can be immutable too.
    const res = new Response(c.res.body, c.res)
    for (const [k, v] of HEADERS) res.headers.set(k, v)
    if (!res.headers.has('Cache-Control')) {
      res.headers.set('Cache-Control', DEFAULT_CACHE_CONTROL)
    }
    c.res = res
  }
}
