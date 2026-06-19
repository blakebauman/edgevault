# @edgevault/openfeature-provider

An [OpenFeature](https://openfeature.dev/) provider backed by the EdgeVault
delivery (edge read) plane. Keep your vendor-neutral OpenFeature evaluation code
and choose EdgeVault as the provider — or run EdgeVault alongside other
Cloudflare-native flag primitives without rewriting call sites.

It's a thin adapter over [`@edgevault/sdk`](../sdk): the SDK fetches pre-resolved
values from `delivery.edgevault.io`, and this package maps them onto the
OpenFeature `Provider` contract.

## Install

```sh
pnpm add @edgevault/openfeature-provider @openfeature/server-sdk
```

`@openfeature/server-sdk` is a peer dependency — the host application owns the
OpenFeature API surface and version.

## Usage

```ts
import { OpenFeature } from '@openfeature/server-sdk'
import { EdgeVaultProvider } from '@edgevault/openfeature-provider'

await OpenFeature.setProviderAndWait(
  new EdgeVaultProvider({ apiKey: process.env.EDGEVAULT_API_KEY! }),
)

const client = OpenFeature.getClient()

const searchOn = await client.getBooleanValue('feature.search.enabled', false)
const theme = await client.getStringValue('feature.checkout.theme', 'classic')
const limits = await client.getObjectValue('feature.ratelimit', { rps: 10 })
```

To reuse an existing client (e.g. one you already use for config reads), pass it
instead of options:

```ts
import { EdgeVault } from '@edgevault/sdk'

const ev = new EdgeVault({ apiKey: process.env.EDGEVAULT_API_KEY! })
const provider = new EdgeVaultProvider({ client: ev })
```

`EdgeVaultProvider` accepts the same options as `EdgeVault`
(`baseUrl`, `cacheTtlMs`, `timeoutMs`, `fetch`).

## How resolution maps to EdgeVault

The delivery plane is split by kind, so the OpenFeature value type selects the
route:

| OpenFeature call | EdgeVault route | Notes |
|---|---|---|
| `getBooleanValue` | `/v1/flags/{key}` | Recognises `true/false`, `1/0`, `on/off`, `yes/no`, a JSON boolean, or `{ "enabled": boolean }`. |
| `getStringValue` | `/v1/configs/{key}` | Raw content; a JSON-encoded string is unwrapped. |
| `getNumberValue` | `/v1/configs/{key}` | Parses plain or JSON numeric content. |
| `getObjectValue` | `/v1/configs/{key}` | `JSON.parse` of the content (object, array, or any JSON value). |

So author **feature flags as flags** and **typed values as configs**. An
object-valued *flag* read via `getObjectValue` would look on the configs route
and miss.

### Resolution reasons & errors

- A resolved value reports reason `STATIC` — the edge serves a value with
  targeting/rollout already applied server-side, so from the provider's vantage
  point it is static for the environment. `flagMetadata` carries `version` and
  `edgevaultKind`.
- A missing key returns the default with `errorCode: FLAG_NOT_FOUND`.
- A value that can't be coerced to the requested type returns the default with
  `errorCode: TYPE_MISMATCH`.
- A transport failure (network, timeout, 401) returns the default with
  `errorCode: GENERAL` and logs via the OpenFeature `logger`.

### Evaluation context

EdgeVault resolves targeting and percentage rollouts **server-side at write
time** and distributes the pre-resolved value to the edge. The provider does not
forward the OpenFeature evaluation context — per-request targeting is not
performed at read time. This is a `server` provider with a per-environment view
scoped by the API key.
