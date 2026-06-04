import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Argon2id at OWASP params (19 MiB, t=2) is intentionally CPU-heavy; a single
    // hash+verify can exceed the 5s default on constrained CI runners.
    testTimeout: 30_000,
  },
})
