---
title: Self-hosting
description: Run the MIT core on your own Cloudflare account — same workers, same Durable Objects, your bill, no telemetry.
order: 6
---

The EdgeVault core is MIT and runs on your own Cloudflare account. It's the same code path the
managed edge runs — not a community edition.

## Local development

```sh
git clone https://github.com/blakebauman/edgevault
cd edgevault
pnpm install   # installs git hooks too
pnpm dev       # all workers via turbo + wrangler dev
pnpm test      # vitest in the real Workers runtime
```

A local Postgres comes up in Docker as an ephemeral Neon Local branch:

```sh
pnpm db:up
pnpm db:migrate:local
```

## Deploying to your account

The full walkthrough lives in the repo's `DEPLOYMENT.md` and follows this shape:

1. **Prerequisites** — a Cloudflare account (Workers paid plan for Durable Objects), a Neon
   database, Node 22+, pnpm 10+.
2. **Create the cloud resources** — KV namespaces, R2 bucket, the audit queue, Hyperdrive (with
   your Neon URL), Vectorize. A provisioning script does the heavy lifting.
3. **Apply the database schema** — Drizzle migrations from `packages/database`.
4. **Secrets** — a generator script mints the signing keys and `MASTER_KEK`; `wrangler secret put`
   sets them per worker.
5. **Deploy** — `pnpm deploy` (turbo runs `wrangler deploy` across the workers, in order).

`DEPLOYMENT.md` also covers the runbook, observability and alerting, and CI/CD (staging deploys
automatically; production is gated).

## What's not in the core

SSO (OIDC/SAML), SCIM, and advanced RBAC are commercial (`ee/`, entitlement-gated); the
Stripe billing control plane (`edge/`) is proprietary and only relevant to the managed service.
Everything else — including envelope encryption, promotions, realtime, the AI layer, and the MCP
server — is in the MIT core. CI fails any build that adds telemetry to it.
