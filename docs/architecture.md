# Architecture

EdgeVault is four open-source Workers plus two Durable Object classes, with an
optional commercial enterprise Worker and a proprietary Managed-Edge control
plane.

## Workers

| Worker | Role |
|---|---|
| `console` (`console.edgevault.io`) | React Router 7 UI + BFF. The browser only talks here; it proxies to the others over service bindings (no CORS, no cross-site cookies). |
| `auth` (`auth.edgevault.io`) | Custom auth — sessions, JWT/JWKS, API keys, social OAuth, MFA/passkeys, enterprise SSO (OIDC/SAML). Built on audited primitives (`jose`, `@noble/hashes`, `@oslojs/*`), no framework, no telemetry. |
| `api` (`api.edgevault.io`) | Control plane — authz, metadata in Neon (via Hyperdrive), routes all config/secret writes through the Vault DO, hosts AI + MCP, SCIM 2.0 directory surface. |
| `delivery` (`delivery.edgevault.io`) | Data plane — serves **pre-resolved** configs/flags from KV with an in-memory L1, gated by environment-scoped API keys. No business logic; cannot decrypt secrets. |
| `control-plane` (`edge/`, proprietary) | Stripe billing/metering + tenant provisioning. SaaS-only, excluded from OSS. |

## Durable Objects

- **`VaultDurableObject`** — one SQLite DO per workspace (system of record):
  environments, config content, revisions, promotions, flags, activity log, and
  envelope-encrypted secret ciphertext. Hosts hibernatable WebSocket + SSE for
  live updates. Strong consistency per workspace, 10 GB ceiling.
- **`EdgeVaultAgent`** — AI chat state, "what changed & why", anomaly scans, and
  the stateful MCP server.

## Where data lives

| Data | Store | Consistency |
|---|---|---|
| Users, orgs, sessions, API-key hashes, workspace metadata, SSO/SAML/SCIM connections, billing plan + Stripe customer | Neon Postgres via Hyperdrive | global; strong on primary |
| Config content, revisions, promotions, flags, activity log, **secret ciphertext** | Vault DO SQLite | strong per workspace |
| Pre-resolved edge values `config:{ws}:{env}:{key}` | KV (cache-tagged) | eventual (write-through) |
| Platform secrets (signing keys, KEK) | Secrets Store | — |
| Audit warehouse / semantic search / metrics | Queues→R2, Vectorize, Analytics Engine | — |

## Core data flows

- **Write** — client/MCP → `api` (authz + Zod) → Vault DO RPC (revision +
  activity log + broadcast + audit queue) → `api` recomputes the resolved value
  → KV write-through + `waitUntil` Vectorize upsert.
- **Edge read (<10 ms target)** — SDK → `delivery` → L1 → KV → (cold miss) Neon
  replica or DO strong read → repopulate.
- **Secrets** — per-secret DEK (AES-GCM-256) wrapped by an HKDF-derived,
  per-workspace KEK from the `MASTER_KEK`. Plaintext exists only transiently
  inside the `api`/DO boundary; the data store holds ciphertext + wrapped DEKs.

See [SECURITY.md](../SECURITY.md) for the full threat model.
