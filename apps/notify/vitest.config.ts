import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Test config omits the send_email binding (no local emulation) — see
  // wrangler.test.jsonc; email tests inject a fake EmailSender.
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.test.jsonc' } })],
})
