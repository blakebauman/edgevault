---
title: SDK reference
description: "@edgevault/sdk — the typed consumer client for the edge read plane: every constructor option, method, hook, and error."
order: 4
---

`@edgevault/sdk` is the typed client for the delivery plane. It is read-only by design — writes go
through the API (or the console, or MCP), never through an edge key.

```sh
npm install @edgevault/sdk
```

## Constructor

```ts
import { EdgeVault } from '@edgevault/sdk'

const edgevault = new EdgeVault({
  apiKey: process.env.EDGE_KEY, // required — environment-scoped, shown once at creation
  baseUrl: 'https://cdn.edgevault.io', // default
  cacheTtlMs: 15_000, // in-process cache (hits AND misses); 0 disables
  timeoutMs: 5_000, // per-request timeout
  fetch: globalThis.fetch, // injectable for tests
})
```

## Methods

| Method | Returns | Behavior |
| --- | --- | --- |
| `value<T>(key)` | `T \| null` | The config's value. JSON content parses as `T`; anything else returns the raw string. `null` = not found. |
| `flag(key, fallback?)` | `boolean` | Evaluates a flag. Recognises `true/false`, `1/0`, `on/off`, `yes/no`, JSON booleans, and `{ enabled: boolean }`. Anything unrecognised — including a missing flag — returns `fallback` (default `false`). **Never throws.** |
| `config(key)` | `ConfigRecord \| null` | The full config record (key, content, contentType, version, …). |
| `flagRecord(key)` | `ConfigRecord \| null` | The full flag record. |
| `batch(keys)` | `Record<string, ConfigRecord \| null>` | Many keys in one request; populates the per-key cache. |
| `clearCache()` | `void` | Drop the in-process cache (e.g. after a known change). |

## Errors

Everything except `flag()` throws on non-success responses:

- `EdgeVaultError` — any non-success delivery response; carries `status` and a `kind`.
- `EdgeVaultAuthError` — the 401/403 subtype: bad or wrong-environment key.

`404` is not an error — missing keys resolve to `null`.

## React bindings

```ts
import { useConfig, useFlag, useValue } from '@edgevault/sdk/react'

const { enabled, loading, error } = useFlag(edgevault, 'checkout-v2')
const { data, loading, error } = useValue<number>(edgevault, 'timeout-ms')
const { data, loading, error } = useConfig(edgevault, 'timeout-ms')
```

Every hook takes the client as its **first argument** and returns
`{ data, loading, error }` (`useFlag` names it `enabled`). Hooks never tear down your component
over a delivery hiccup — errors land in the `error` field, and `useFlag` keeps returning your
fallback.

## Caching

The client caches per key for `cacheTtlMs` (default 15 s), including misses — a hammered missing
key won't hammer the edge. The delivery plane itself adds an in-memory L1 over KV, so a cold
client in a warm city is still fast.
