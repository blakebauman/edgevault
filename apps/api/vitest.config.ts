import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      // The real auth worker isn't present in the test runtime; stub the service
      // binding so miniflare can start. The DO/health tests don't call it.
      miniflare: {
        serviceBindings: {
          AUTH_SERVICE: () =>
            new Response('{"keys":[]}', { headers: { 'content-type': 'application/json' } }),
        },
      },
    }),
  ],
})
