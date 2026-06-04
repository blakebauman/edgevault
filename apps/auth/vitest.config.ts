import { defineConfig } from 'vitest/config'

/**
 * The auth worker depends on `pg` (a CommonJS Node library), which the Workers
 * Vitest pool cannot bundle cleanly. `pg` runs natively under Node, so we unit
 * test the route logic here in a Node environment with a mocked `Env` (DB-less
 * routes execute no query). The full pg + Hyperdrive + Neon path is verified
 * end-to-end by the `wrangler dev` smoke test (Phase 1 verification).
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
})
