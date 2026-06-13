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
    return secured
  },
} satisfies ExportedHandler<Env>
