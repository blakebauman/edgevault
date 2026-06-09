#!/usr/bin/env bash
# Provision the shared Cloudflare resources EdgeVault needs. Requires
# `wrangler login` first. Each command prints an id — paste it into the matching
# binding in the worker wrangler.jsonc files (they currently hold placeholders).
#
# Idempotent-ish: re-creating an existing KV/R2/Queue is a no-op error you can
# ignore. This does NOT set secrets — run `node scripts/gen-secrets.mjs` for those.
set -euo pipefail

w() { echo "+ wrangler $*"; npx wrangler "$@"; }

echo "== Hyperdrive (Neon) =="
echo "Provide your Neon DIRECT connection string as NEON_URL, then:"
echo "  npx wrangler hyperdrive create edgevault-neon --connection-string=\"\$NEON_URL\""
echo "  → paste the id into apps/api + apps/auth (+ edge/control-plane) HYPERDRIVE"
echo

echo "== KV namespaces =="
w kv namespace create CONFIGS_CACHE         # apps/api + apps/delivery (shared id)
w kv namespace create ENVIRONMENT_API_KEYS  # apps/api + apps/delivery (shared id)
w kv namespace create AUTH_CACHE            # apps/auth (session cache)

echo "== Vectorize (match the embedding model dimensions) =="
w vectorize create edgevault-configs --dimensions=768 --metric=cosine
# Metadata indexes are REQUIRED for the workspace/environment-scoped search
# filters — without them, filtered queries silently return no matches.
w vectorize create-metadata-index edgevault-configs --property-name workspaceId --type string
w vectorize create-metadata-index edgevault-configs --property-name environmentId --type string

echo "== Queue + R2 (audit warehouse) =="
w queues create edgevault-audit
w r2 bucket create edgevault-audit   # bound by name in apps/audit (write) + apps/api (read)

echo "== Queues (notification fan-out) =="
w queues create edgevault-notify       # apps/api (producer) → apps/notify (consumer)
w queues create edgevault-notify-dlq   # dead letters after 3 failed deliveries

cat <<'NEXT'

Next:
  1. Paste the printed ids into the worker wrangler.jsonc bindings.
  2. Rate-limit namespaces (AUTH_IP_LIMITER/AUTH_ACCOUNT_LIMITER) are config-only
     — no resource to create; keep the namespace_ids in apps/auth/wrangler.jsonc.
  3. node scripts/gen-secrets.mjs   # then set secrets per its output
  4. pnpm --filter @edgevault/database db:migrate
  5. pnpm deploy
NEXT
