import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest({
      // Test config omits the remote-only ai/vectorize bindings so the pool runs
      // fully local (no remote proxy / login) — see wrangler.test.jsonc.
      wrangler: { configPath: './wrangler.test.jsonc' },
      // The real auth worker isn't present in the test runtime; stub the service
      // binding so miniflare can start. The DO/health tests don't call it.
      miniflare: {
        serviceBindings: {
          AUTH_SERVICE: () =>
            new Response('{"keys":[]}', { headers: { 'content-type': 'application/json' } }),
        },
        // Deterministic master key for envelope-encryption tests.
        bindings: { MASTER_KEK: Buffer.alloc(32, 7).toString('base64') },
      },
    }),
  ],
})
