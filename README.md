# EdgeVault

Edge-native **configuration**, **secrets**, and **feature-flag** management built on
the Cloudflare Developer Platform. Sub-10ms reads at the edge, strong
per-workspace consistency, real-time updates, AI-native authoring, and a remote
MCP server — open-core, self-hostable on your own Cloudflare account.

## Workers

| Worker               | Role                                                                                                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api`           | Control plane (OpenAPI Hono): authz, config R/W via the workspace Durable Object, real-time WebSockets, AI search + risk + assistant, promotion Workflows, MCP server. |
| `apps/delivery`      | <10ms edge data plane: pre-resolved configs/flags from KV + an in-memory L1, API-key authenticated.                                                                    |
| `apps/auth`          | Custom, zero-telemetry auth: Argon2id passwords, opaque sessions, EdDSA JWT/JWKS.                                                                                      |
| `apps/console`       | React Router 7 admin UI on Workers (BFF): login + a live workspace dashboard.                                                                                          |
| `apps/audit`         | Queue consumer: archives audit events to R2 (NDJSON) — the cold warehouse.                                                                                             |
| `edge/control-plane` | _(proprietary)_ Stripe billing + usage metering for Managed Edge.                                                                                                      |

**Storage:** Neon Postgres (via Hyperdrive) for orgs/workspaces/members + API
keys; per-workspace SQLite **Durable Objects** as the config system of record;
KV for hot edge reads; R2 + Vectorize + Queues for audit, search, and warehouse.

## What's built

- **Auth** — email/password (Argon2id) + sessions + EdDSA JWT/JWKS; api verifies
  tokens against the JWKS and enforces Neon org membership.
- **Config system of record** — per-workspace SQLite DO with versioned revisions,
  content-hash diffs, environment promotion, and an activity log; unified
  config / flag / **secret** items.
- **Real-time** — WebSocket Hibernation in the DO broadcasts changes to the
  console (`@edgevault/realtime` + `useWorkspaceEvents`).
- **Edge delivery** — write-through to KV on every change; the delivery worker
  serves pre-resolved values behind an L1 cache.
- **Promotion Workflows** — durable dev→prod promotion with an AI/heuristic risk
  scan and a `waitForEvent` approval gate.
- **AI** — embeddings-on-write + Vectorize semantic search, config-risk scoring
  (LLM floored by heuristics), and a grounded "what changed & why" agent.
- **MCP server** — Streamable HTTP, per-workspace, exposing config tools to
  agents/IDEs.
- **Secrets vault** — envelope encryption (per-secret DEK wrapped by a
  per-workspace KEK; `@edgevault/crypto`).
- **Audit warehouse** — Queue → R2 NDJSON (Pipelines/R2 SQL on top).
- **Open-core** — `@edgevault/licensing` signed entitlements; `ee/` SSO (OIDC) +
  SCIM; `edge/` Stripe billing + metering.

See [DEPLOYMENT.md](./DEPLOYMENT.md) to run it on your own Cloudflare account.

## Open-core layout

- `apps/*`, `packages/*` — **MIT** open-source core (incl. AI + MCP).
- `ee/*` — **EdgeVault Enterprise Edition** (commercial license): SSO/SAML, SCIM,
  advanced RBAC, audit retention. Gated by signed license-key entitlements.
- `edge/*` — **proprietary** Managed Edge control plane (Stripe billing, metering,
  provisioning). Not part of the OSS distribution.

## Develop

```sh
pnpm install
pnpm dev        # run all apps via turbo
pnpm typecheck
pnpm test
```

Requires Node 22+, pnpm 10+, and a Cloudflare account (Workers Paid for Durable
Objects, Hyperdrive, Vectorize, Queues, R2). Self-host = bring your own
Cloudflare account.

## License

MIT for the core (see [LICENSE](./LICENSE)). Enterprise and Managed Edge code is
licensed separately. Security policy: [SECURITY.md](./SECURITY.md).
