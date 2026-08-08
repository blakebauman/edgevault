import type { Config } from '@react-router/dev/config'

export default {
  // Server-side render by default; the Worker streams HTML from the edge.
  ssr: true,
  future: {
    // Required for compatibility with the @cloudflare/vite-plugin (aligns the
    // build with Vite's Environment API).
    v8_viteEnvironmentApi: true,
    // `context` in loaders/actions is a RouterContextProvider, not a plain
    // object — bindings come from `context.get(cloudflareContext)`, which
    // `workers/app.ts` populates. See app/lib/cloudflare.ts.
    v8_middleware: true,
    // Client route exports (clientLoader et al) ship as their own chunks.
    v8_splitRouteModules: true,
    // Loaders/actions get the raw Request. `request.url` on a data request now
    // carries the `.data` suffix, so read routing decisions off the `url` arg
    // instead — nothing here reads `pathname` off `request.url`, only origin,
    // protocol and searchParams, which the suffix doesn't touch.
    v8_passThroughRequests: true,
    // Data requests keep trailing-slash semantics (`/a/b/_.data`).
    v8_trailingSlashAwareDataRequests: true,
  },
} satisfies Config
