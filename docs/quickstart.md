# Quickstart — read a config from the edge

This walks an app developer from zero to reading a config value at the edge. It
assumes a running EdgeVault (the hosted Managed Edge, or your own deploy — see
[DEPLOYMENT.md](../DEPLOYMENT.md)). Hostnames below use the reference deployment;
swap in your own.

## 1. Create an account and a workspace

Sign in at `https://app.edgevault.io`, create an organization, then a workspace.
A workspace owns one or more **environments** (e.g. `development`, `production`).

## 2. Add a config

In the workspace, create a config key — for example `feature.checkout.theme`
with the value `"midnight"` in `production`. Saving creates a revision and
write-through-publishes the resolved value to the edge cache.

## 3. Mint an environment API key

Create an API key **scoped to the environment** you want to read. The raw key is
shown once — store it as a secret in your app. EdgeVault keeps only its SHA-256
hash.

## 4. Read it at the edge

### With the SDK (recommended)

[`@edgevault/sdk`](../packages/sdk/) is a typed client that runs in browsers,
Node 18+, Workers, Deno, and Bun:

```ts
import { EdgeVault } from '@edgevault/sdk'

const ev = new EdgeVault({ apiKey: process.env.EDGEVAULT_API_KEY! })

const theme = await ev.value<string>('feature.checkout.theme') // "midnight"
if (await ev.flag('feature.search.enabled')) { /* ... */ }
const many = await ev.batch(['feature.checkout.theme', 'feature.search.enabled'])
```

React bindings live under `@edgevault/sdk/react` (`useValue`, `useFlag`).

### With raw HTTP

The delivery plane lives at `cdn.edgevault.io` and authenticates with the API
key (either header form works):

```sh
curl https://cdn.edgevault.io/v1/configs/feature.checkout.theme \
  -H "authorization: Bearer $EDGEVAULT_API_KEY"
# { "key": "feature.checkout.theme", "content": "midnight", ... }
```

A feature flag is read the same way under `/v1/flags/:key`, and you can fetch
many keys in one round trip via `POST /v1/batch` with `{"keys":[...]}`.

Responses include an `x-cache` header (L1 / KV source) and a `Server-Timing:
resolve;dur=<ms>` header with the server-side resolve time. Typical edge reads
are served from KV in single-digit milliseconds.

### Status codes

| Code | Meaning |
|---|---|
| `200` | Value returned |
| `401` | Missing or invalid API key |
| `404` | Key not found in this environment |

## Next steps

- Promote a value from `development` to `production` with an approval gate.
- Drive the same operations from an AI assistant or agent over **MCP**.
- Store **secrets** (envelope-encrypted) alongside plain configs.

See [architecture.md](./architecture.md) for how reads and writes flow through
the system.
