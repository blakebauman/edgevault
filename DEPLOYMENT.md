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
- `VECTORIZE` (`edgevault-configs`), `AUDIT_QUEUE`/`AUDIT_BUCKET` are bound by name.

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
| `INTERNAL_TOKEN` | auth, console, enterprise | trusted-mesh shared secret (SSO/SAML + MFA provisioning) |
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

## Local development

```sh
export CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="postgres://...neon..."
# .dev.vars per worker: apps/auth (JWT_PRIVATE_JWK, MASTER_KEK, INTERNAL_TOKEN),
# apps/api (MASTER_KEK), apps/console (INTERNAL_TOKEN),
# ee/enterprise (MASTER_KEK, INTERNAL_TOKEN)
(cd apps/auth     && npx wrangler dev --port 8788 --inspector-port 9320)
(cd apps/api      && npx wrangler dev --port 8790 --inspector-port 9321)
(cd apps/delivery && npx wrangler dev --port 8791 --inspector-port 9322)
(cd apps/console  && npx wrangler dev --port 8787 --inspector-port 9323)
```

The dev registry auto-connects the service bindings (`AUTH_SERVICE`,
`API_SERVICE`, `ENTERPRISE_SERVICE`). WebAuthn binds to the origin, so passkeys
only work against a stable host (e.g. `localhost`).

## Tiers

- **Core** (`apps/*`, `packages/*`) — MIT, deploy freely.
- **Enterprise** (`ee/*`) — requires a commercial license + a signed entitlement
  (`@edgevault/licensing`).
- **Managed Edge** (`edge/*`) — proprietary; operated by us, not part of the OSS
  distribution.
