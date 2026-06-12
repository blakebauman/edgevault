#!/usr/bin/env bash
# Post-deploy health smoke for an EdgeVault environment. Read-only — no data writes.
# Usage: bash scripts/smoke.sh [staging|production]   (default: staging)
set -uo pipefail

ENVNAME="${1:-staging}"
case "$ENVNAME" in
  production) S="" ;;            # console.edgevault.io
  staging)    S="-staging" ;;    # console-staging.edgevault.io
  *) echo "usage: smoke.sh [staging|production]"; exit 2 ;;
esac

APP="https://console${S}.edgevault.io"
AUTH="https://auth${S}.edgevault.io"
API="https://api${S}.edgevault.io"
DELIVERY="https://delivery${S}.edgevault.io"
# Proprietary Managed-Edge control plane (public for Stripe webhooks). Optional
# for self-hosters — skip with SKIP_CONTROL_PLANE=1.
CTL="https://billing${S}.edgevault.io"

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
# delivery worker (not some other worker) owns the delivery hostname.
check "delivery /v1 auth" "$DELIVERY/v1/configs/_smoke" 401
[ "${SKIP_CONTROL_PLANE:-0}" = 1 ] || check "control-plane /health" "$CTL/health" 200

# JWKS must publish at least one verification key (proves the signing secret loaded).
if curl -s --max-time 15 "$AUTH/.well-known/jwks.json" | grep -q '"keys":\[{'; then
  echo "  ok   auth JWKS (key published)"
else
  echo "  FAIL auth JWKS (no key)"; fail=1
fi

# Staging only: exercise the authenticated requireUser path end-to-end
# (sign-in → /token → /me). This is the surface the unauthenticated checks
# can't see — a sign-only verification key once broke every requireUser route
# while health/JWKS stayed green. Uses a fixed, idempotent smoke account
# (no org, no data; staging sign-up is public anyway). Prod stays read-only.
if [ "$ENVNAME" = staging ]; then
  SMOKE_EMAIL="smoke-fixed@edgevault.io"
  SMOKE_PASS="edgevault-smoke-fixed-account"
  JAR=$(mktemp)
  # Create on first run (409 email_taken thereafter), then sign in.
  curl -s --max-time 15 -o /dev/null -X POST "$AUTH/sign-up/email" \
    -H 'content-type: application/json' \
    -d "{\"email\":\"$SMOKE_EMAIL\",\"password\":\"$SMOKE_PASS\",\"name\":\"Smoke\"}"
  curl -s --max-time 15 -c "$JAR" -o /dev/null -X POST "$AUTH/sign-in/email" \
    -H 'content-type: application/json' \
    -d "{\"email\":\"$SMOKE_EMAIL\",\"password\":\"$SMOKE_PASS\"}"
  ACCESS=$(curl -s --max-time 15 -b "$JAR" -X POST "$AUTH/token" \
    | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p')
  ME=$(curl -s --max-time 15 -H "authorization: Bearer $ACCESS" "$AUTH/me")
  rm -f "$JAR"
  if printf '%s' "$ME" | grep -q "\"email\":\"$SMOKE_EMAIL\""; then
    echo "  ok   auth /me (requireUser verify path)"
  else
    echo "  FAIL auth /me (requireUser verify path): $ME"; fail=1
  fi
fi

[ "$fail" = 0 ] && echo "PASS" || { echo "SMOKE FAILED"; exit 1; }
