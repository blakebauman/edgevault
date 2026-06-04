#!/usr/bin/env node
// Open-core boundary check: the MIT core (apps/*, packages/*) must never depend
// on or import from the commercial `ee/*` or proprietary `edge/*` code. Run in CI.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const CORE_DIRS = ['apps', 'packages']
// Forbidden import specifiers in core. Note: `@edgevault/edge-protocol` is a CORE
// (MIT) package and is intentionally allowed; only the proprietary control plane is not.
const FORBIDDEN = [/@edgevault\/ee-/, /@edgevault\/edge-control/, /from ['"][./]+(ee|edge)\//]

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'build' || entry === '.wrangler')
      continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, files)
    else if (/\.(ts|tsx|js|jsx|json)$/.test(entry)) files.push(full)
  }
  return files
}

const violations = []
for (const base of CORE_DIRS) {
  for (const file of walk(join(ROOT, base))) {
    const text = readFileSync(file, 'utf8')
    for (const pattern of FORBIDDEN) {
      if (pattern.test(text)) {
        violations.push(`${file.replace(ROOT, '')} matches ${pattern}`)
      }
    }
  }
}

if (violations.length > 0) {
  console.error('✖ Open-core boundary violations (MIT core must not use ee/ or edge/):')
  for (const v of violations) console.error(`  - ${v}`)
  process.exit(1)
}
console.log('✓ Open-core boundary intact: no ee/ or edge/ imports in the MIT core.')
