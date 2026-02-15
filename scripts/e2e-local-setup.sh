#!/usr/bin/env bash
#
# E2E Local Setup -- Prepare local wrangler dev environment for Phase 2A E2E tests.
#
# This script:
#   1. Ensures .dev.vars exists with required secrets
#   2. Applies D1 migrations to the local database
#   3. Starts wrangler dev with the API worker
#   4. Waits for health check to pass
#
# Usage:
#   ./scripts/e2e-local-setup.sh          # Start wrangler dev in background
#   ./scripts/e2e-local-setup.sh --stop   # Stop any running wrangler dev
#
# After starting, run: make test-e2e-phase2a

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKER_DIR="$ROOT_DIR/workers/api"
PORT=8787
BASE_URL="http://localhost:$PORT"

# -- Stop mode --
if [[ "${1:-}" == "--stop" ]]; then
  echo "Stopping wrangler dev..."
  pkill -f "wrangler dev" 2>/dev/null || true
  echo "Done."
  exit 0
fi

# -- Ensure .dev.vars exists --
if [[ ! -f "$WORKER_DIR/.dev.vars" ]]; then
  echo "Creating .dev.vars with development secrets..."
  cat > "$WORKER_DIR/.dev.vars" <<'DEVVARS'
JWT_SECRET=e2e-test-jwt-secret-minimum-32-characters-for-hs256
MASTER_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
DEVVARS
  echo "Created $WORKER_DIR/.dev.vars"
else
  echo ".dev.vars already exists."
fi

# -- Kill existing wrangler dev --
pkill -f "wrangler dev" 2>/dev/null || true
sleep 1

# -- Clear state for clean run (optional, comment out to preserve state) --
echo "Clearing local wrangler state for clean E2E run..."
rm -rf "$WORKER_DIR/.wrangler/state"

# -- Start wrangler dev in background --
echo "Starting wrangler dev on port $PORT..."
cd "$WORKER_DIR"
npx wrangler dev src/dev-entry.ts --port "$PORT" --local --compatibility-flags=nodejs_compat > /tmp/wrangler-e2e.log 2>&1 &
WRANGLER_PID=$!
echo "Wrangler PID: $WRANGLER_PID"

# -- Wait for server to be ready --
echo "Waiting for server..."
for i in $(seq 1 30); do
  if curl -sf "$BASE_URL/health" > /dev/null 2>&1; then
    echo "Server ready at $BASE_URL"
    break
  fi
  if ! kill -0 $WRANGLER_PID 2>/dev/null; then
    echo "ERROR: wrangler dev exited. Check /tmp/wrangler-e2e.log"
    cat /tmp/wrangler-e2e.log
    exit 1
  fi
  sleep 1
done

# Verify health
if ! curl -sf "$BASE_URL/health" > /dev/null 2>&1; then
  echo "ERROR: Server failed to start within 30 seconds."
  cat /tmp/wrangler-e2e.log
  kill $WRANGLER_PID 2>/dev/null
  exit 1
fi

# -- Apply D1 migrations --
echo "Applying D1 migrations to local database..."
cd "$ROOT_DIR"

npx wrangler d1 execute tminus-registry --local --config workers/api/wrangler.toml --command "
CREATE TABLE IF NOT EXISTS orgs (
  org_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(org_id),
  email TEXT NOT NULL UNIQUE,
  display_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  password_hash TEXT,
  password_version INTEGER NOT NULL DEFAULT 1,
  failed_login_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT
);
CREATE TABLE IF NOT EXISTS accounts (
  account_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id),
  provider TEXT NOT NULL DEFAULT 'google',
  provider_subject TEXT NOT NULL,
  email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  channel_id TEXT,
  channel_token TEXT,
  channel_expiry_ts TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(provider, provider_subject)
);
CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_accounts_channel ON accounts(channel_id);
CREATE TABLE IF NOT EXISTS deletion_certificates (
  cert_id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  deleted_at TEXT NOT NULL DEFAULT (datetime('now')),
  proof_hash TEXT NOT NULL,
  signature TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS api_keys (
  key_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id),
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  last_used_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(prefix);
" 2>&1

echo ""
echo "============================================"
echo "Local E2E environment ready!"
echo "API running at: $BASE_URL"
echo "Wrangler PID: $WRANGLER_PID"
echo ""
echo "Run tests with: make test-e2e-phase2a"
echo "Stop server with: ./scripts/e2e-local-setup.sh --stop"
echo "============================================"
