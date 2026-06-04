# @edgevault/sdk

Typed client for the EdgeVault delivery (edge read) plane. Reads pre-resolved
configs and feature flags with an optional short-lived in-process cache. Runs
anywhere the Fetch API exists — browsers, Node 18+, Cloudflare Workers, Deno, Bun.

## Install

```sh
pnpm add @edgevault/sdk
```

## Usage

```ts
import { EdgeVault } from '@edgevault/sdk'

const ev = new EdgeVault({ apiKey: process.env.EDGEVAULT_API_KEY! })

// A config's value — JSON content is parsed, everything else is a string.
const theme = await ev.value<string>('feature.checkout.theme')

// A feature flag as a boolean (with an optional fallback).
if (await ev.flag('feature.search.enabled', false)) {
  // ...
}

// The full record (content, contentType, kind, version) or null if absent.
const record = await ev.config('feature.checkout.theme')

// Many keys in one round trip.
const many = await ev.batch(['a', 'b', 'c']) // { a: record | null, b: ..., c: ... }
```

### Options

```ts
new EdgeVault({
  apiKey,                          // required — environment-scoped API key
  baseUrl: 'https://cdn.edgevault.io', // default; set to your own delivery host
  cacheTtlMs: 15_000,              // in-process cache for hits + misses; 0 disables
  timeoutMs: 5_000,                // per-request timeout
  fetch,                           // inject a fetch (defaults to global fetch)
})
```

### Errors

- `EdgeVaultAuthError` (extends `EdgeVaultError`) — 401: missing/invalid key.
- `EdgeVaultError` — any other failure; carries `status` and `code`
  (`'timeout'`, `'network'`, or the delivery error code).

A missing key (404) is **not** an error — `config`/`value` return `null` and
`flag` returns the fallback.

### Flag coercion

`flag()` recognises `true/false`, `1/0`, `on/off`, `yes/no` (case-insensitive),
a JSON boolean, or a JSON object with a boolean `enabled` field. Anything
unrecognised — including a missing flag — returns the fallback.

## React

Optional bindings under `@edgevault/sdk/react` (React is a peer dependency; the
core client has no React dependency):

```tsx
import { EdgeVault } from '@edgevault/sdk'
import { useFlag, useValue } from '@edgevault/sdk/react'

const ev = new EdgeVault({ apiKey })

function Banner() {
  const { enabled, loading } = useFlag(ev, 'feature.banner')
  if (loading) return null
  return enabled ? <NewBanner /> : <OldBanner />
}
```

## Notes

- The client cache mirrors the delivery worker's 15s L1 — values are eventually
  consistent. Call `clearCache()` after a known change if you need immediacy.
- Read the server-side resolve time from the `Server-Timing` response header.
