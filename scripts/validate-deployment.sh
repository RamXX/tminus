#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# validate-deployment.sh -- Verify all T-Minus workers are healthy and reachable.
#
# Curls the /health endpoint of every HTTP-accessible worker and verifies:
#   1. HTTP 200 response
#   2. If JSON response: ok:true and valid status
#   3. If plain text response: just confirms 200 OK
#
# Supports both enriched (new) and legacy (old) health response formats.
#
# Uses --resolve flag for DNS propagation resilience (resolve to Cloudflare).
#
# Usage:
#   ./scripts/validate-deployment.sh [--env production|staging] [--verbose]
#
# Exit codes:
#   0  All workers healthy
#   1  One or more workers failed health check
# ---------------------------------------------------------------------------

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

TIMEOUT_SECS=15
VERBOSE=false
ENV="production"

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)
      ENV="$2"
      shift 2
      ;;
    --verbose|-v)
      VERBOSE=true
      shift
      ;;
    *)
      echo "Unknown argument: $1"
      echo "Usage: $0 [--env production|staging] [--verbose]"
      exit 1
      ;;
  esac
done

# Worker endpoints by environment
if [[ "$ENV" == "staging" ]]; then
  declare -A WORKERS=(
    ["tminus-api"]="https://api-staging.tminus.ink/health"
    ["tminus-oauth"]="https://oauth-staging.tminus.ink/health"
    ["tminus-webhook"]="https://webhooks-staging.tminus.ink/health"
    ["tminus-app-gateway"]="https://app-staging.tminus.ink/health"
    ["tminus-mcp"]="https://mcp-staging.tminus.ink/health"
  )
elif [[ "$ENV" == "production" ]]; then
  declare -A WORKERS=(
    ["tminus-api"]="https://api.tminus.ink/health"
    ["tminus-oauth"]="https://oauth.tminus.ink/health"
    ["tminus-webhook"]="https://webhooks.tminus.ink/health"
    ["tminus-app-gateway"]="https://app.tminus.ink/health"
    ["tminus-mcp"]="https://mcp.tminus.ink/health"
  )
else
  echo "ERROR: Unknown environment '$ENV'. Use 'production' or 'staging'."
  exit 1
fi

# ---------------------------------------------------------------------------
# Cloudflare anycast IP for --resolve fallback
# ---------------------------------------------------------------------------

CF_IP="104.18.0.0"

# ---------------------------------------------------------------------------
# Python helper for JSON parsing (inline to avoid external dependency)
# ---------------------------------------------------------------------------

parse_health_json() {
  python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    # Enriched format: {ok, data:{status, version, environment, worker, bindings}, ...}
    if isinstance(d, dict) and 'data' in d and isinstance(d['data'], dict):
        status = d['data'].get('status', '')
        version = d['data'].get('version', '?')
        env = d['data'].get('environment', '?')
        worker = d['data'].get('worker', '?')
        ok = d.get('ok', False)
        print(f'enriched|{ok}|{status}|{version}|{env}|{worker}')
    # Legacy JSON formats: {ok:true, status:'healthy'} or {status:'ok', timestamp:...}
    elif isinstance(d, dict):
        ok = d.get('ok', d.get('status') == 'ok')
        status = d.get('status', '?')
        print(f'legacy-json|{ok}|{status}|?|?|?')
    else:
        print('unknown|||?|?|?')
except (json.JSONDecodeError, ValueError):
    print('plaintext|true|ok|?|?|?')
" 2>/dev/null || echo "parse-error|false||?|?|?"
}

# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

PASSED=0
FAILED=0
TOTAL=${#WORKERS[@]}
FAILURES=()

echo "[validate] T-Minus Deployment Validation"
echo "[validate] Environment: $ENV"
echo "[validate] Workers to check: $TOTAL"
echo ""

for WORKER_NAME in "${!WORKERS[@]}"; do
  URL="${WORKERS[$WORKER_NAME]}"
  HOST=$(echo "$URL" | sed -E 's|https?://([^/]+).*|\1|')

  echo -n "[validate] $WORKER_NAME ($HOST) ... "

  HTTP_CODE=""
  BODY=""

  # Attempt 1: normal DNS
  if RESPONSE=$(curl -s -w "\n%{http_code}" --max-time "$TIMEOUT_SECS" "$URL" 2>/dev/null); then
    HTTP_CODE=$(echo "$RESPONSE" | tail -1)
    BODY=$(echo "$RESPONSE" | sed '$d')
  fi

  # Attempt 2: --resolve to Cloudflare IP if normal DNS failed
  if [[ -z "$HTTP_CODE" || "$HTTP_CODE" == "000" ]]; then
    if RESPONSE=$(curl -s -w "\n%{http_code}" --max-time "$TIMEOUT_SECS" \
      --resolve "${HOST}:443:${CF_IP}" "$URL" 2>/dev/null); then
      HTTP_CODE=$(echo "$RESPONSE" | tail -1)
      BODY=$(echo "$RESPONSE" | sed '$d')
    fi
  fi

  # Check 1: HTTP 200
  if [[ "$HTTP_CODE" != "200" ]]; then
    echo "FAIL (HTTP $HTTP_CODE)"
    FAILED=$((FAILED + 1))
    FAILURES+=("$WORKER_NAME: HTTP $HTTP_CODE (expected 200)")
    continue
  fi

  # Check 2: Parse response body
  PARSED=$(echo "$BODY" | parse_health_json)
  IFS='|' read -r FORMAT OK STATUS VERSION DEPLOY_ENV WORKER_TAG <<< "$PARSED"

  # For enriched format, validate ok:true and status
  if [[ "$FORMAT" == "enriched" ]]; then
    if [[ "$OK" != "True" ]]; then
      echo "FAIL (ok != true)"
      FAILED=$((FAILED + 1))
      FAILURES+=("$WORKER_NAME: ok field is not true")
      if [[ "$VERBOSE" == "true" ]]; then
        echo "  Body: $BODY"
      fi
      continue
    fi
    if [[ "$STATUS" != "healthy" && "$STATUS" != "degraded" ]]; then
      echo "FAIL (status=$STATUS)"
      FAILED=$((FAILED + 1))
      FAILURES+=("$WORKER_NAME: unexpected status '$STATUS'")
      if [[ "$VERBOSE" == "true" ]]; then
        echo "  Body: $BODY"
      fi
      continue
    fi
  fi

  # HTTP 200 received -- worker is alive
  if [[ "$VERBOSE" == "true" ]]; then
    if [[ "$FORMAT" == "enriched" ]]; then
      echo "PASS (status=$STATUS, version=$VERSION, env=$DEPLOY_ENV, format=enriched)"
    elif [[ "$FORMAT" == "legacy-json" ]]; then
      echo "PASS (format=legacy-json, status=$STATUS)"
    else
      echo "PASS (format=plaintext)"
    fi
  else
    echo "PASS"
  fi
  PASSED=$((PASSED + 1))
done

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo ""
echo "[validate] Results: $PASSED/$TOTAL passed, $FAILED failed"

if [[ $FAILED -gt 0 ]]; then
  echo "[validate] Failures:"
  for F in "${FAILURES[@]}"; do
    echo "  - $F"
  done
  exit 1
fi

echo "[validate] All workers healthy."
exit 0
