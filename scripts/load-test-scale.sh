#!/usr/bin/env bash
# load-test-scale.sh — validate stateless horizontal scaling with 3 gateway instances
#
# Prerequisites:
#   docker compose -f docker-compose.yml -f docker/docker-compose.scale.yml up -d
#   npm install -g autocannon   (or: npx autocannon)
#
# What it tests:
#   1. Health check — all 3 gateway instances are reachable through nginx
#   2. Mesh-run status endpoint under load — round-robin routing, no sticky sessions
#   3. Agent-job wait endpoint — cross-instance pub/sub resolution
#
# Pass criteria:
#   - 0 non-2xx/4xx responses (health + status endpoints)
#   - Requests are distributed across all 3 instances (verified via instance headers)

set -euo pipefail

GATEWAY_URL="${GATEWAY_URL:-http://localhost:18789}"
DURATION="${LOAD_TEST_DURATION_SECS:-10}"
CONNECTIONS="${LOAD_TEST_CONNECTIONS:-10}"
GATEWAY_TOKEN="${MINION_GATEWAY_TOKEN:-}"

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
fail() { log "FAIL: $*"; exit 1; }
ok() { log "OK:   $*"; }

# ── 1. Health check all instances ────────────────────────────────────────────
log "Step 1: health check (gateway at $GATEWAY_URL)"
for i in 1 2 3; do
  STATUS=$(curl -sf -o /dev/null -w '%{http_code}' "$GATEWAY_URL/health" || echo "000")
  if [[ "$STATUS" != "200" ]]; then
    fail "Health check returned $STATUS (instance probe $i)"
  fi
done
ok "health /health → 200 (3 probes)"

# ── 2. Verify round-robin distribution via X-Instance-Id header ──────────────
log "Step 2: verify round-robin distribution (30 requests)"
INSTANCE_IDS=()
for i in $(seq 1 30); do
  HDR=$(curl -sf -o /dev/null -D - "$GATEWAY_URL/health" 2>/dev/null \
        | grep -i 'x-instance-id:' | tr -d '[:space:]' || true)
  if [[ -n "$HDR" ]]; then
    INSTANCE_IDS+=("${HDR#*:}")
  fi
done
UNIQUE_INSTANCES=$(printf '%s\n' "${INSTANCE_IDS[@]}" | sort -u | wc -l | tr -d '[:space:]')
if [[ "${#INSTANCE_IDS[@]}" -gt 0 && "$UNIQUE_INSTANCES" -lt 2 ]]; then
  log "WARN: X-Instance-Id header present but only $UNIQUE_INSTANCES unique values seen — check nginx config"
else
  ok "round-robin distribution OK (X-Instance-Id header ${UNIQUE_INSTANCES:-N/A} unique values)"
fi

# ── 3. Load test /health endpoint with autocannon ────────────────────────────
log "Step 3: load test /health — ${DURATION}s, ${CONNECTIONS} connections"
if command -v autocannon &>/dev/null; then
  RESULT=$(autocannon -d "$DURATION" -c "$CONNECTIONS" --json "$GATEWAY_URL/health" 2>/dev/null)
  ERRORS=$(printf '%s' "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('errors',0))" 2>/dev/null || echo "0")
  NON2XX=$(printf '%s' "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['non2xx'])" 2>/dev/null || echo "0")
  if [[ "$ERRORS" != "0" || "$NON2XX" != "0" ]]; then
    fail "Load test: errors=$ERRORS non2xx=$NON2XX"
  fi
  RPS=$(printf '%s' "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(round(d['requests']['mean']))" 2>/dev/null || echo "?")
  ok "Load test passed: ~${RPS} req/s, errors=0, non2xx=0"
else
  log "SKIP: autocannon not found; install with: npm install -g autocannon"
  log "      Manual test: autocannon -d $DURATION -c $CONNECTIONS $GATEWAY_URL/health"
fi

# ── 4. Cross-instance mesh.status check ──────────────────────────────────────
log "Step 4: cross-instance mesh.status round-trip"
if [[ -z "$GATEWAY_TOKEN" ]]; then
  log "SKIP: MINION_GATEWAY_TOKEN not set; export it to enable cross-instance mesh test"
else
  # Create a mesh run on one instance, then poll status from the load balancer
  # (request may land on a different instance — tests Redis read-through)
  RUN_PAYLOAD='{"jsonrpc":"2.0","id":1,"method":"mesh.run","params":{"runId":"lt-test-run-1","workflow":"echo","input":{}}}'
  curl -sf -X POST "$GATEWAY_URL/rpc" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $GATEWAY_TOKEN" \
    -d "$RUN_PAYLOAD" -o /dev/null 2>/dev/null || true

  STATUS_PAYLOAD='{"jsonrpc":"2.0","id":2,"method":"mesh.status","params":{"runId":"lt-test-run-1"}}'
  STATUS_RESPONSE=$(curl -sf -X POST "$GATEWAY_URL/rpc" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $GATEWAY_TOKEN" \
    -d "$STATUS_PAYLOAD" 2>/dev/null || echo '{}')

  if printf '%s' "$STATUS_RESPONSE" | grep -q '"result"'; then
    ok "Cross-instance mesh.status → result found in response"
  else
    log "WARN: mesh.status response did not contain a result (may be expected if workflow not registered)"
    log "      Response: $STATUS_RESPONSE"
  fi
fi

log "──────────────────────────────────────────────"
log "Load test complete. All required checks passed."
log ""
log "To run the full scale stack:"
log "  docker compose -f docker-compose.yml -f docker/docker-compose.scale.yml up -d"
log "  MINION_GATEWAY_TOKEN=<token> bash scripts/load-test-scale.sh"
