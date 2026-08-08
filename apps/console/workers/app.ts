import { createRequestHandler } from 'react-router'

declare module 'react-router' {
  export interface AppLoadContext {
    cloudflare: {
      env: Env
      ctx: ExecutionContext
    }
  }
}

const requestHandler = createRequestHandler(
  () => import('virtual:react-router/server-build'),
  import.meta.env.MODE,
)

// Applied to every response (documents, data requests, resource routes).
// The document CSP is set in entry.server.tsx where the per-request nonce lives.
const SECURITY_HEADERS: ReadonlyArray<[string, string]> = [
  ['Strict-Transport-Security', 'max-age=31536000; includeSubDomains'],
  ['X-Content-Type-Options', 'nosniff'],
  ['X-Frame-Options', 'DENY'],
  ['Referrer-Policy', 'strict-origin-when-cross-origin'],
  ['Permissions-Policy', 'camera=(), microphone=(), geolocation=()'],
]

export default {
  async fetch(request, env, ctx) {
    const response = await requestHandler(request, {
      cloudflare: { env, ctx },
    })
    const secured = new Response(response.body, response)
    for (const [k, v] of SECURITY_HEADERS) secured.headers.set(k, v)
    // Everything this worker renders is per-session: the SSR document, the
    // React Router `.data` requests behind it, and the resource routes. None of
    // it carried a Cache-Control at all, which leaves the response eligible for
    // heuristic caching — a shared machine's back button, or any intermediary,
    // could surface one member's workspace to the next. Set, not overwritten,
    // so a route that wants to be cacheable can say so itself. Hashed assets
    // never reach here (the asset server answers those first) and keep the
    // immutable Cache-Control from public/_headers.
    if (!secured.headers.has('Cache-Control')) {
      secured.headers.set('Cache-Control', 'no-store')
    }
    return secured
  },
} satisfies ExportedHandler<Env>
