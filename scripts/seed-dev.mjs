#!/usr/bin/env node
/**
 * Local-dev seed — PHASE 2 driver.
 *
 * Phase 1 (`pnpm db:seed:local`) seeds Postgres. This hits the api worker's
 * dev-only `/internal/seed` endpoint, which fills the Vault Durable Object + KV
 * (environments, config/flag/secret/content items, revisions, promotions, API
 * keys, channels). The api worker must be running (`pnpm dev`).
 *
 * The INTERNAL_TOKEN is read from apps/api/.dev.vars (override with env vars
 * INTERNAL_TOKEN and/or API_URL).
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const API_URL = process.env.API_URL ?? 'http://localhost:8801'

function readDevVar(name) {
  if (process.env[name]) return process.env[name]
  try {
    const text = readFileSync(resolve(root, 'apps/api/.dev.vars'), 'utf8')
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
      if (m && m[1] === name) return m[2].replace(/^['"]|['"]$/g, '')
    }
  } catch {
    // fall through to the error below
  }
  return undefined
}

const token = readDevVar('INTERNAL_TOKEN')
if (!token) {
  console.error('INTERNAL_TOKEN not found. Set it in apps/api/.dev.vars or pass it as an env var.')
  process.exit(1)
}

const url = `${API_URL}/internal/seed`
let res
try {
  res = await fetch(url, { method: 'POST', headers: { 'x-internal-token': token } })
} catch (err) {
  console.error(`Could not reach ${url}. Is \`pnpm dev\` running?`)
  console.error(String(err))
  process.exit(1)
}

const body = await res.json().catch(() => ({}))
if (!res.ok) {
  console.error(`Seed endpoint returned ${res.status}:`, JSON.stringify(body))
  if (res.status === 404) {
    console.error('Tip: set ALLOW_DEV_SEED=1 in apps/api/.dev.vars and restart `pnpm dev`.')
  }
  process.exit(1)
}

console.log('Phase 2 (Vault DO + KV) seeded:')
for (const row of body.seeded ?? []) {
  console.log(
    `  ${row.org}/${row.workspace}: ${row.items} items, ${row.promotions} promotions, ` +
      `${row.apiKeys} API keys, ${row.channels} channels`,
  )
}
console.log('\nSign in to the console as dev@edgevault.test / devpassword123! and switch orgs.')
