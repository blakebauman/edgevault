#!/usr/bin/env bash
# Post-deploy health smoke for an EdgeVault environment. Read-only — no data writes.
# Usage: bash scripts/smoke.sh [staging|production]   (default: staging)
set -uo pipefail

ENVNAME="${1:-staging}"
case "$ENVNAME" in
  production) S="" ;;            # app.edgevault.io
  staging)    S="-staging" ;;    # app-staging.edgevault.io
  *) echo "usage: smoke.sh [staging|production]"; exit 2 ;;
esac

APP="https://app${S}.edgevault.io"
AUTH="https://auth${S}.edgevault.io"
API="https://api${S}.edgevault.io"
CDN="https://cdn${S}.edgevault.io"
# Commercial EE worker is internal (no custom domain) — reach it on workers.dev.
# Self-hosters override the account subdomain via WORKERS_SUBDOMAIN.
ENT="https://edgevault-enterprise${S}.${WORKERS_SUBDOMAIN:-bauman}.workers.dev"
# Proprietary Managed-Edge control plane (workers.dev only). Optional for
# self-hosters — skip with SKIP_CONTROL_PLANE=1.
CTL="https://edgevault-control-plane${S}.${WORKERS_SUBDOMAIN:-bauman}.workers.dev"

fail=0
code() { curl -s -o /dev/null -w "%{http_code}" --max-time 15 "$1" 2>/dev/null; }
check() { # name url expected
  local got; got=$(code "$2")
  if [ "$got" = "$3" ]; then echo "  ok   $1 ($got)";
  else echo "  FAIL $1 (got $got, want $3)"; fail=1; fi
}

echo "EdgeVault smoke: $ENVNAME"
check "auth /health"   "$AUTH/health" 200
check "api /health"    "$API/health" 200
check "console /login" "$APP/login" 200
# The delivery worker gates /v1/* behind API-key auth, so an unauthenticated
# request returns 401. This both proves the worker is up AND that *EdgeVault's*
# delivery worker (not some other worker) owns the cdn hostname.
check "cdn (delivery /v1 auth)" "$CDN/v1/configs/_smoke" 401
check "enterprise /health"      "$ENT/health" 200
[ "${SKIP_CONTROL_PLANE:-0}" = 1 ] || check "control-plane /health" "$CTL/health" 200

# JWKS must publish at least one verification key (proves the signing secret loaded).
if curl -s --max-time 15 "$AUTH/.well-known/jwks.json" | grep -q '"keys":\[{'; then
  echo "  ok   auth JWKS (key published)"
else
  echo "  FAIL auth JWKS (no key)"; fail=1
fi

[ "$fail" = 0 ] && echo "PASS" || { echo "SMOKE FAILED"; exit 1; }
