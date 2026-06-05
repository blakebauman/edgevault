---
title: Getting started
description: From zero to an edge read in five minutes — create a workspace, mint an environment key, and read your first value.
order: 1
---

EdgeVault serves configuration, secrets, and feature flags from the edge. This guide takes you
from nothing to a working read.

## 1. Create a workspace

Sign in at [app.edgevault.io](https://app.edgevault.io) and create an organization and a
workspace. Every workspace gets its own Durable Object — the strongly-consistent system of record
for everything you store in it.

Workspaces contain **environments** (e.g. `development`, `staging`, `production`). Values are
scoped to an environment, and promotions move them between environments through an approval-gated
workflow.

## 2. Mint an environment API key

API keys are **environment-scoped**: a key for `production` can only read `production`'s resolved
values. The key is shown once at creation — store it like the secret it is.

## 3. Read from the edge

```sh
npm install @edgevault/sdk
```

```ts
import { EdgeVault } from '@edgevault/sdk'

const edgevault = new EdgeVault({ apiKey: process.env.EDGE_KEY })

const timeout = await edgevault.value<number>('timeout-ms')
const checkout = await edgevault.flag('checkout-v2', false)
```

Reads go to the delivery plane (`cdn.edgevault.io`) — an in-memory L1 over KV in 300+ cities,
typically under 10 ms. The client also keeps a small in-process cache (15 s by default) so hot
keys never leave your worker.

Two behaviors worth knowing on day one:

- `flag(key, fallback)` **never throws**. A missing flag — or a delivery outage — returns your
  fallback. Feature-flag failures should degrade, not crash.
- `value<T>(key)` parses JSON content as `T` and returns anything else as a raw string. `null`
  means the key doesn't exist.

## 4. Change something and watch it propagate

Flip a value in the console. The write lands in your workspace's Durable Object (one ordered
revision history), the resolved value is written through to KV, and the edge serves the new value
— end to end, typically within seconds, with the change attributed in the activity log.

## Next

- [The SDK reference](/docs/sdk) — every method, option, and error
- [Realtime events](/docs/realtime) — subscribe instead of polling
- [Architecture](/docs/architecture) — where your data actually lives
