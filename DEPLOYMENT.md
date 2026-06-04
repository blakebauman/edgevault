# Deploying EdgeVault (bring your own Cloudflare account)

EdgeVault is Cloudflare-native. Self-hosting means deploying the open-source
core to **your own Cloudflare account** — there is no generic on-prem/Docker
target. You'll need a Cloudflare **Workers Paid** plan (Durable Objects,
Hyperdrive, Queues, R2, Vectorize) and a **Neon** Postgres database.

## 1. Prerequisites

```sh
pnpm install
npx wrangler login
```

Provision a Neon project and copy its **direct** (non-pooled) connection string.

## 2. Create the cloud resources

```sh
# Hyperdrive in front of Neon (used by api + auth)
npx wrangler hyperdrive create edgevault-neon --connection-string="postgres://USER:PASS@HOST.neon.tech/neondb?sslmode=require"

# KV namespaces (api + delivery share these by id)
npx wrangler kv namespace create CONFIGS_CACHE
npx wrangler kv namespace create ENVIRONMENT_API_KEYS

# Vectorize index for semantic search (match the embedding model's dimensions)
npx wrangler vectorize create edgevault-configs --dimensions=768 --metric=cosine

# Queue + R2 for the audit warehouse
npx wrangler queues create edgevault-audit
npx wrangler r2 bucket create edgevault-audit

# (optional) AI Gateway for caching/observability of Workers AI calls
```

Paste the returned ids into the matching `wrangler.jsonc` files (they currently
hold placeholder ids), and set the Hyperdrive id in `apps/api` + `apps/auth`.

## 3. Apply the database schema

```sh
# DATABASE_URL = the Neon direct connection string
echo "DATABASE_URL=postgres://..." > packages/database/.env
pnpm --filter @edgevault/database db:migrate
```

## 4. Secrets

```sh
# auth: EdDSA signing key (JWKS). Generate a JWK and store it.
npx wrangler secret put JWT_PRIVATE_JWK   --name edgevault-auth
# api: master key for envelope-encrypting customer secrets
npx wrangler secret put MASTER_KEK        --name edgevault-api
```

Prefer **Secrets Store** for platform secrets in production. Never put secrets
in `wrangler.jsonc` `vars`.

## 5. Deploy

```sh
pnpm --filter @edgevault/auth      deploy
pnpm --filter @edgevault/api       deploy
pnpm --filter @edgevault/delivery  deploy
pnpm --filter @edgevault/audit     deploy
pnpm --filter @edgevault/console   deploy
# or: pnpm deploy   (all via turbo)
```

Set `AUTH_ISSUER` (in `apps/api` + `apps/auth` vars) to your deployed auth URL,
and `API_WS_BASE` (console) to your public api `wss://` origin.

## Local development

```sh
export CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="postgres://...neon..."
# run each worker (distinct inspector ports), they connect via the dev registry:
(cd apps/auth     && npx wrangler dev --port 8788 --inspector-port 9320)
(cd apps/api      && npx wrangler dev --port 8790 --inspector-port 9321)
(cd apps/delivery && npx wrangler dev --port 8791 --inspector-port 9322)
(cd apps/console  && npx wrangler dev --port 8787 --inspector-port 9323)
```

## Tiers

- **Core** (`apps/*`, `packages/*`) — MIT, deploy freely.
- **Enterprise** (`ee/*`) — requires a commercial license + a signed entitlement
  (`@edgevault/licensing`).
- **Managed Edge** (`edge/*`) — proprietary; operated by us, not part of the OSS
  distribution.
