# Deploying EdgeVault (bring your own Cloudflare account)

EdgeVault is Cloudflare-native. Self-hosting means deploying the open-source
core to **your own Cloudflare account** — there is no generic on-prem/Docker
target. You need a Cloudflare **Workers Paid** plan (Durable Objects, Hyperdrive,
Queues, R2, Vectorize, KV, Rate Limiting) and a **Neon** Postgres database.

## Workers

| Worker | Package | Tier | Purpose |
|---|---|---|---|
| `edgevault-auth` | `apps/auth` | core (MIT) | identity, sessions, JWT/JWKS, MFA, passkeys, social OAuth |
| `edgevault-api` | `apps/api` | core | control plane, Workspace DO, AI/MCP, workflows, audit query |
| `edgevault-delivery` | `apps/delivery` | core | edge read path (KV + L1) |
| `edgevault-console` | `apps/console` | core | React Router UI / BFF |
| `edgevault-audit` | `apps/audit` | core | Queue → R2 audit warehouse consumer |
| `edgevault-notify` | `apps/notify` | core | Queue → Slack / signed-webhook notification delivery |
| `edgevault-enterprise` | `ee/enterprise` | EE (commercial) | SSO (OIDC/SAML) + SCIM — deploy only with an EE entitlement |
| `edgevault-control-plane` | `edge/control-plane` | Managed Edge (proprietary) | Stripe billing + metering — SaaS only, excluded from OSS |

## 1. Prerequisites

```sh
pnpm install
npx wrangler login
```

Provision a Neon project and copy its **direct** (non-pooled) connection string.

## 2. Create the cloud resources

```sh
bash scripts/provision.sh   # creates KV, Vectorize, Queue, R2; prints ids
# Hyperdrive (run with your Neon URL):
npx wrangler hyperdrive create edgevault-neon \
  --connection-string="postgres://USER:PASS@HOST.neon.tech/neondb?sslmode=require"
```

Paste each returned id into the matching `wrangler.jsonc` binding (they currently
hold placeholder ids):

- `HYPERDRIVE` → `apps/api`, `apps/auth` (and `ee/enterprise`, `edge/control-plane` if deployed)
- `CONFIGS_CACHE`, `ENVIRONMENT_API_KEYS` → `apps/api` **and** `apps/delivery` (same ids → shared)
- `AUTH_CACHE` → `apps/auth`
- `VECTORIZE` (`edgevault-configs`), `AUDIT_QUEUE`/`AUDIT_BUCKET` are bound by name
  (`AUDIT_BUCKET` is written by `apps/audit`, read by `apps/api` for audit queries
  and by `edge/control-plane` as the usage-metering source).

Rate-limit namespaces (`AUTH_IP_LIMITER`, `AUTH_ACCOUNT_LIMITER` in `apps/auth`)
are config-only — no resource to create. Pair them with WAF rate-limiting rules
for a global ceiling (the binding is per-Cloudflare-location).

## 3. Apply the database schema

```sh
echo "DATABASE_URL=postgres://...neon-direct..." > packages/database/.env
pnpm --filter @edgevault/database db:migrate
```

## 4. Secrets

```sh
node scripts/gen-secrets.mjs   # prints JWT_PRIVATE_JWK, MASTER_KEK, INTERNAL_TOKEN + commands
```

| Secret | Workers | Notes |
|---|---|---|
| `JWT_PRIVATE_JWK` | auth | EdDSA signing key (JWKS is derived/published) |
| `MASTER_KEK` | auth, api, **enterprise** | envelope-encryption key — **must be identical** across all three |
| `INTERNAL_TOKEN` | auth, api, console, enterprise, control-plane | trusted-mesh shared secret (SSO/SAML + MFA provisioning + billing + share-link consume) |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | auth | optional — enables GitHub login |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | auth | optional — enables Google login |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | control-plane | Managed Edge only |

Prefer **Secrets Store** for production. Never put secrets in `wrangler.jsonc` `vars`.

## 5. Deploy

```sh
pnpm --filter @edgevault/auth      deploy
pnpm --filter @edgevault/api       deploy
pnpm --filter @edgevault/delivery  deploy
pnpm --filter @edgevault/audit     deploy
pnpm --filter @edgevault/console   deploy
# EE / Managed Edge only:
pnpm --filter @edgevault/ee-enterprise      deploy
pnpm --filter @edgevault/edge-control-plane deploy
```

Then set the cross-worker URLs:

- `AUTH_ISSUER` (vars in `apps/api` + `apps/auth`) → your deployed auth URL
- `API_WS_BASE` (console vars) → your public api `wss://` origin
- OAuth/SAML/OIDC redirect URLs registered at the provider must point at the
  deployed console origin: `/oauth/:provider/callback`, `/saml/:orgId/acs`,
  `/sso/:orgId/callback`.

## Runbook

**Health smoke** (read-only, no data writes):

```sh
bash scripts/smoke.sh staging
bash scripts/smoke.sh production
```

It checks auth/api health, console `/login`, JWKS (proves the signing secret
loaded), and that *EdgeVault's* delivery worker owns the `cdn` host (`/v1/*` →
401). CI runs it automatically after every deploy.

**Rollback** — each `wrangler deploy` creates a version:

```sh
cd apps/<worker> && npx wrangler deployments list
npx wrangler rollback [VERSION_ID]   # or redeploy a previous git commit
```

**Secret rotation** — `JWT_PRIVATE_JWK`, `INTERNAL_TOKEN` rotate by `wrangler
secret put` (re-set the same key on every worker that holds it). **`MASTER_KEK`
is special**: customer secrets are envelope-encrypted under it, so you cannot
just swap it — rotate by re-wrapping each envelope (`@edgevault/crypto`
`rewrapEnvelope`) under the new key, then deploy. Plan a migration job before
rotating `MASTER_KEK` in production.

**Scaling notes** — `api` uses Smart Placement (near the Neon region) + Hyperdrive
pooling; `delivery` runs at the edge with a KV + 15s in-memory L1 cache. Vectorize
**requires metadata indexes** on `workspaceId`/`environmentId` (see §2) or scoped
search silently returns nothing.

## Observability & alerting

Every worker has Workers Logs enabled (`observability.enabled` in each
`wrangler.jsonc`). Tail a worker live with `wrangler tail --name edgevault-<app>`;
query historical logs/invocations in the Cloudflare dashboard (Workers →
Observability).

**Edge read latency (the <10ms target).** The `delivery` worker emits
`Server-Timing: resolve;dur=<ms>;desc="l1|kv"` on every `/v1/configs|flags|batch`
response — this is the *server-side* resolve time (L1 or KV read), the figure to
compare against the target. External round-trip latency is dominated by client→
edge network RTT and is **not** a valid measurement. Read it from any real
request (`curl -D - … | grep -i server-timing`) or sample it with
`scripts/loadtest-delivery.sh <url> [N] [concurrency]` (set `EDGEVAULT_API_KEY`
to exercise a real config-hit path).

**Recommended Cloudflare Notifications** (dashboard → Notifications):
- Workers **error rate** spike on `edgevault-{auth,api,delivery}` — auth/api
  errors block logins/writes; delivery errors break the read path.
- Workers **CPU / wall-time** alert on `edgevault-delivery` to catch regressions
  against the <10ms target (corroborate with the `Server-Timing` numbers).
- **Hyperdrive** connection errors and **Queue** consumer backlog (audit lag).
- Critical paths already log structured errors (`indexConfig failed`, `SAML
  verification failed`, `OAuth callback failed`) — alert on their log patterns.

## Continuous deployment

`.github/workflows/deploy.yml` deploys **staging automatically on every push to
`main`** (after boundary/typecheck/test/build pass), and **production manually**
via the Actions tab (`workflow_dispatch` → environment `production`). Gate prod
by protecting the `production` GitHub Environment with required reviewers.

One-time setup: add a `CLOUDFLARE_API_TOKEN` repo secret (Workers/KV/R2/Vectorize/
Queues/Hyperdrive edit scope). Worker secrets are set out-of-band
(`scripts/gen-secrets.mjs`); CI never manages them.

## Local development

The local database is [Neon Local](https://neon.com/docs/local/neon-local)
(`docker-compose.yml`): a proxy container that spawns an **ephemeral Neon
branch** (forked from `staging` by default) on start and deletes it on stop.
The Hyperdrive `localConnectionString` in every worker's wrangler.jsonc already
points at it, so `wrangler dev` connects with no env vars.

```sh
cp .env.example .env   # fill in NEON_API_KEY (console.neon.tech → API keys)
pnpm db:up             # start the proxy (ephemeral branch created)
pnpm db:migrate:local  # apply drizzle migrations to the fresh branch

# .dev.vars per worker: apps/auth (JWT_PRIVATE_JWK, MASTER_KEK, INTERNAL_TOKEN),
# apps/api (MASTER_KEK, INTERNAL_TOKEN), apps/console (INTERNAL_TOKEN),
# ee/enterprise (MASTER_KEK, INTERNAL_TOKEN), edge/control-plane (INTERNAL_TOKEN,
# STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET)
(cd apps/auth     && npx wrangler dev --port 8788 --inspector-port 9320)
(cd apps/api      && npx wrangler dev --port 8790 --inspector-port 9321)
(cd apps/delivery && npx wrangler dev --port 8791 --inspector-port 9322)
(cd apps/console  && npx wrangler dev --port 8787 --inspector-port 9323)

pnpm db:down           # stop the proxy (branch deleted)
```

Set `DELETE_BRANCH=false` in `.env` to persist the branch (same data across
sessions); set `NEON_PARENT_BRANCH_ID` to fork from a different parent. To
point `wrangler dev` at a real Neon branch instead, export
`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="postgres://...neon..."`
— it overrides `localConnectionString`.

The dev registry auto-connects the service bindings (`AUTH_SERVICE`,
`API_SERVICE`, `ENTERPRISE_SERVICE`). WebAuthn binds to the origin, so passkeys
only work against a stable host (e.g. `localhost`).

## Tiers

- **Core** (`apps/*`, `packages/*`) — MIT, deploy freely.
- **Enterprise** (`ee/*`) — requires a commercial license + a signed entitlement
  (`@edgevault/licensing`).
- **Managed Edge** (`edge/*`) — proprietary; operated by us, not part of the OSS
  distribution.
