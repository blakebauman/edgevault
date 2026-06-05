# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

EdgeVault — edge-native configuration, secrets, and feature-flag platform on the Cloudflare Developer Platform. pnpm workspace + Turborepo monorepo, Node 22+, pnpm 10+.

## Commands

```sh
pnpm install            # also installs git hooks (lefthook)
pnpm dev                # all apps via turbo (wrangler dev / react-router dev)
pnpm build              # turbo build (workers build = `wrangler deploy --dry-run`)
pnpm typecheck          # tsc per package (depends on build + cf-typegen)
pnpm test               # vitest across packages
pnpm lint               # biome lint
pnpm check              # biome check --write (auto-fix; run before pushing)
pnpm boundary           # open-core boundary check (see below)
pnpm cf-typegen         # regenerate worker-configuration.d.ts per app
```

Single package / single test:

```sh
pnpm --filter @edgevault/api test                          # one package's tests
pnpm --filter @edgevault/api exec vitest run test/mcp.test.ts   # one file
```

Local database (ephemeral Neon Local branch in Docker):

```sh
pnpm db:up               # docker compose up neon-local (postgres://neon:npg@localhost:5432/neondb)
pnpm db:migrate:local    # drizzle migrations against it
pnpm db:down
```

Drizzle schema work lives in `packages/database` (`db:generate`, `db:migrate`, `db:push`, `db:studio`; reads `DATABASE_URL` from `packages/database/.env`).

Deploys (`pnpm deploy` / `turbo run deploy`) push to the real Cloudflare account — never deploy without explicit user direction. See DEPLOYMENT.md for resource provisioning and ACTIVATION.md for optional providers (OAuth, etc.).

## Open-core boundary (enforced)

- `apps/*`, `packages/*` — MIT core. **Must never import from `ee/` or `edge/`** — `scripts/check-boundary.mjs` fails CI on any such import. (`@edgevault/edge-protocol` is a core package and is fine.)
- `ee/*` — commercial Enterprise Edition (SSO OIDC/SAML, SCIM), gated by `@edgevault/licensing` signed entitlements.
- `edge/*` — proprietary Managed Edge control plane (Stripe billing/metering), excluded from OSS.
- No telemetry that phones home; any analytics must be opt-in.
- Commits require DCO sign-off: `git commit -s`.

## Architecture

Five core Workers plus two Durable Object classes. The browser only talks to the console; it proxies to the other workers over service bindings (no CORS, no cross-site cookies).

| Worker | Role |
|---|---|
| `apps/api` (api.edgevault.io) | Control plane: Hono + zod-openapi. Authz, Neon metadata via Hyperdrive, all config/secret writes through the Workspace DO, AI (search/risk/assistant), promotion Workflows, MCP server. |
| `apps/delivery` (cdn.edgevault.io) | <10ms data plane: serves pre-resolved configs/flags from KV behind an in-memory L1, environment-scoped API keys. No business logic; cannot decrypt secrets. |
| `apps/auth` (auth.edgevault.io) | Custom auth, no framework: Argon2id passwords, opaque sessions, EdDSA JWT/JWKS, MFA/passkeys, social OAuth. Built on `jose`, `@noble/hashes`, `@oslojs/*`. |
| `apps/console` (app.edgevault.io) | React Router 7 UI + BFF on Workers (via `@cloudflare/vite-plugin`). |
| `apps/audit` | Queue consumer → R2 NDJSON audit warehouse. |
| `apps/www` (edgevault.io) | Marketing site: static Astro build (0 KB client JS) served by an assets-only worker. Design source of record is the `stardust/` pipeline (brand profile, briefings own the copy, prototypes); this app is the implementation. |
| `ee/enterprise`, `edge/control-plane` | EE SSO/SCIM and proprietary billing — internal, reached via service bindings. |

Durable Objects (in `apps/api`):
- **WorkspaceDurableObject** — one SQLite DO per workspace, the config **system of record**: environments, config/flag/secret items, versioned revisions, promotions, activity log, hibernatable WebSocket/SSE broadcast. Strong consistency per workspace.
- **EdgeVaultAgent** — AI chat state, "what changed & why", the stateful MCP server.

Where data lives:
- **Neon Postgres via Hyperdrive** — users, orgs, sessions, API-key hashes, workspace metadata, entitlements (Drizzle, `packages/database`).
- **Workspace DO SQLite** — config content, revisions, secret *ciphertext*.
- **KV** — pre-resolved edge values `config:{ws}:{env}:{key}`, write-through on every change (eventual consistency).
- **Secrets Store** — signing keys, `MASTER_KEK`.

Core write flow: client/MCP → `api` (authz + Zod) → Workspace DO RPC (revision + activity log + broadcast + audit queue) → `api` recomputes resolved value → KV write-through + `waitUntil` Vectorize upsert. Edge read: SDK → `delivery` → L1 → KV → (cold miss) repopulate.

Secrets use envelope encryption (`packages/crypto`): per-secret AES-GCM-256 DEK wrapped by an HKDF-derived per-workspace KEK from `MASTER_KEK`. Plaintext exists only transiently inside the `api`/DO boundary.

Shared packages of note: `@edgevault/edge-protocol` (types shared across the wire), `@edgevault/sdk` (typed consumer client + React bindings for the delivery plane), `@edgevault/realtime` (WebSocket events + `useWorkspaceEvents`), `@edgevault/auth` (token verification helpers).

## Testing

Worker tests run in the real Workers runtime via `@cloudflare/vitest-pool-workers`. Apps have a separate `wrangler.test.jsonc` that omits remote-only bindings (AI, Vectorize) so the pool runs fully local; cross-worker service bindings are stubbed in `vitest.config.ts` (see `apps/api/vitest.config.ts` for the pattern, e.g. a fake `AUTH_SERVICE` and a deterministic `MASTER_KEK`).

## Style

Biome (not ESLint/Prettier): single quotes, semicolons as-needed, trailing commas, 2-space indent, 100-col lines, organized imports. Pre-commit hook auto-fixes staged files; pre-push runs `pnpm typecheck`.
