#!/usr/bin/env bash
# Latency probe for the EdgeVault delivery (edge read) plane.
#
# Fires N requests at a target endpoint, then reports the latency distribution
# (p50/p90/p95/p99/max) and the HTTP status breakdown. Read-only.
#
# Usage:
#   # True config-hit path (needs a real environment API key + an existing key):
#   EDGEVAULT_API_KEY=ek_... scripts/loadtest-delivery.sh \
#       https://cdn.edgevault.io/v1/configs/<your-key> [N] [CONCURRENCY]
#
#   # No key: probes a URL directly (e.g. /health, 200, no auth) for a clean
#   # worker+edge baseline.
#   scripts/loadtest-delivery.sh https://cdn-staging.edgevault.io/health 200 20
#
# Total latency below is dominated by client->edge network RTT + TLS handshake,
# NOT worker compute. The <10ms target is server-side: read it from the
# `Server-Timing: resolve;dur=<ms>` header the delivery worker emits on
# /v1/configs|flags|batch (shown as "sample" below for a real key). /health and
# the 401 path skip the config read, so they carry no resolve timing.
set -uo pipefail

URL="${1:-https://cdn.edgevault.io/health}"
N="${2:-200}"
CONCURRENCY="${3:-20}"
KEY="${EDGEVAULT_API_KEY:-}"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "EdgeVault delivery probe"
echo "  url=$URL  n=$N  concurrency=$CONCURRENCY  auth=$([ -n "$KEY" ] && echo yes || echo no)"

# Warm the edge (first hit may be a cold isolate / cache miss), and capture
# x-cache + status from a single verbose request.
if [ -n "$KEY" ]; then
  curl -s -o /dev/null -D "$tmp/warm" -H "authorization: Bearer $KEY" "$URL" || true
else
  curl -s -o /dev/null -D "$tmp/warm" "$URL" || true
fi
SAMPLE_STATUS=$(awk 'NR==1{print $2}' "$tmp/warm" | tr -d '\r')
SAMPLE_CACHE=$(grep -i '^x-cache:' "$tmp/warm" | tr -d '\r' | awk '{print $2}' | head -1)
SAMPLE_TIMING=$(grep -i '^server-timing:' "$tmp/warm" | tr -d '\r' | sed 's/^[Ss]erver-[Tt]iming: *//' | head -1)
echo "  sample: status=$SAMPLE_STATUS x-cache=${SAMPLE_CACHE:-none} server-timing=${SAMPLE_TIMING:-none (no resolve on this path)}"

# Fire N requests, CONCURRENCY at a time. Each line: "<time_total_s> <http_code>".
export URL KEY
seq 1 "$N" | xargs -P "$CONCURRENCY" -I{} sh -c '
  if [ -n "$KEY" ]; then
    curl -s -o /dev/null -H "authorization: Bearer $KEY" -w "%{time_total} %{http_code}\n" "$URL"
  else
    curl -s -o /dev/null -w "%{time_total} %{http_code}\n" "$URL"
  fi
' > "$tmp/raw" 2>/dev/null

# Percentiles: sort the latency column numerically, then index into it.
cut -d' ' -f1 "$tmp/raw" | sort -n > "$tmp/sorted"
awk '
  function pct(p,   i){ i = int(p/100*n); if (i < 1) i = 1; return ms[i] }
  { ms[NR] = $1 * 1000; n = NR }
  END {
    if (n == 0) { print "no samples"; exit 1 }
    printf "\nlatency ms over %d samples:\n", n
    printf "  p50=%.2f  p90=%.2f  p95=%.2f  p99=%.2f  max=%.2f\n",
           pct(50), pct(90), pct(95), pct(99), ms[n]
  }
' "$tmp/sorted"

echo "status codes:"
cut -d' ' -f2 "$tmp/raw" | sort | uniq -c | awk '{printf "  %s: %s\n", $2, $1}'
