# EdgeVault

Edge-native **configuration**, **secrets**, and **feature-flag** management built on
the 2026 Cloudflare Developer Platform. Sub-10ms reads at the edge, strong
per-workspace consistency, real-time updates, AI-native authoring, and a remote
MCP server — open-core, self-hostable on your own Cloudflare account.

> Status: **early greenfield rebuild** (Phase 0). See
> `~/.claude/plans/analyze-users-blake-sites-cloudflare-edg-delegated-cascade.md`
> for the full architecture blueprint and phased roadmap.

## Architecture at a glance

| Worker | Role |
| --- | --- |
| `apps/api` | Control plane (OpenAPI Hono): authz, config R/W via the workspace Durable Object, AI, MCP, Workflows. |
| `apps/delivery` | <10ms edge data plane: pre-resolved configs/flags from KV + memory. |
| `apps/console` | React Router 7 admin UI on Workers Static Assets. |
| `apps/auth` | Custom, zero-telemetry auth: sessions, JWT/JWKS, API keys, SSO/SCIM, MCP OAuth provider. |

**Storage:** Neon Postgres (via Hyperdrive) for global metadata; per-workspace
SQLite Durable Objects as the config system of record; KV for hot edge reads;
R2 + Vectorize + Queues/Pipelines for assets, search, and audit.

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
