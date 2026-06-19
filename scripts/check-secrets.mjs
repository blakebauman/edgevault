#!/usr/bin/env node
// Deploy-time secret-parity check. The trusted-mesh secrets are verified
// INDEPENDENTLY by each worker (constant-time compare), so a secret that is
// missing on one worker fails silently at request time — e.g. INTERNAL_TOKEN
// absent on the api worker turns every share-link consume into a 401, which the
// console surfaces as "This link has expired…". wrangler never exposes secret
// VALUES, so this can only confirm PRESENCE, not value-equality — but presence
// is what drifts when a `wrangler secret put` is missed on one worker.
//
// Usage: node scripts/check-secrets.mjs [production|staging|all]   (default all)
import { execFileSync } from 'node:child_process'

// Which secrets each prod worker must carry. Staging appends `-staging`.
// Keep in sync with scripts/gen-secrets.mjs and the DEPLOYMENT.md secret matrix.
const MATRIX = {
  'edgevault-auth': { required: ['INTERNAL_TOKEN', 'MASTER_KEK', 'JWT_PRIVATE_JWK'] },
  'edgevault-api': { required: ['INTERNAL_TOKEN', 'MASTER_KEK'] },
  'edgevault-console': { required: ['INTERNAL_TOKEN'] },
  // Billing is optional (Stripe may be unactivated); only flag a missing token
  // when the worker is actually deployed.
  'edgevault-control-plane': { required: ['INTERNAL_TOKEN'], optionalWorker: true },
}

const env = (process.argv[2] ?? 'all').toLowerCase()
const ENVS = env === 'all' ? ['production', 'staging'] : [env]
if (!['production', 'staging', 'all'].includes(env)) {
  console.error(`Unknown environment "${env}" — use production | staging | all`)
  process.exit(2)
}

// Returns { secrets: string[] } | { missingWorker: true } | { error: string }
function listSecrets(worker) {
  try {
    const out = execFileSync('npx', ['wrangler', 'secret', 'list', '--name', worker], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    // wrangler prints a JSON array (possibly after a banner line); slice from `[`.
    const start = out.indexOf('[')
    if (start === -1) return { error: 'unparseable wrangler output' }
    const parsed = JSON.parse(out.slice(start))
    return { secrets: parsed.map((s) => s.name) }
  } catch (err) {
    const text = `${err.stdout ?? ''}${err.stderr ?? ''}${err.message ?? ''}`
    if (/not found|does not exist|workers\.api\.error\.script_not_found|\[code: 10007\]/i.test(text))
      return { missingWorker: true }
    return { error: text.split('\n').find((l) => l.trim()) ?? 'wrangler failed' }
  }
}

const problems = []
const skipped = []

for (const targetEnv of ENVS) {
  const suffix = targetEnv === 'staging' ? '-staging' : ''
  for (const [prodName, spec] of Object.entries(MATRIX)) {
    const worker = `${prodName}${suffix}`
    const result = listSecrets(worker)

    if (result.missingWorker) {
      if (spec.optionalWorker) {
        skipped.push(`${worker} (not deployed — optional)`)
      } else {
        problems.push(`${worker}: worker not deployed (expected to exist)`)
      }
      continue
    }
    if (result.error) {
      problems.push(`${worker}: could not verify secrets — ${result.error}`)
      continue
    }

    const present = new Set(result.secrets)
    const missing = spec.required.filter((s) => !present.has(s))
    if (missing.length > 0) {
      problems.push(`${worker}: missing ${missing.join(', ')}`)
    } else {
      console.log(`✓ ${worker}: ${spec.required.join(', ')} present`)
    }
  }
}

for (const s of skipped) console.log(`• skipped ${s}`)

if (problems.length > 0) {
  console.error('\n✖ Secret-parity check failed:')
  for (const p of problems) console.error(`  - ${p}`)
  console.error(
    '\nSet the missing secret(s) on each worker to the SAME value used elsewhere in the mesh:\n' +
      '  echo -n "$INTERNAL_TOKEN" | npx wrangler secret put INTERNAL_TOKEN --name <worker>\n' +
      'See DEPLOYMENT.md (INTERNAL_TOKEN rotation runbook) and scripts/gen-secrets.mjs.',
  )
  process.exit(1)
}

console.log('\n✓ Secret parity intact across the trusted mesh.')
