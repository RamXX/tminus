#!/usr/bin/env bash
#
# E2E MCP Setup -- Prepare local wrangler dev environment for Phase 2B E2E tests.
#
# This script:
#   1. Ensures .dev.vars exists with required secrets
#   2. Starts wrangler dev with the MCP worker
#   3. Applies D1 migrations to the local MCP database
#   4. Seeds test data (accounts) for the test user
#   5. Waits for health check to pass
#
# Usage:
#   ./scripts/e2e-mcp-setup.sh          # Start wrangler dev in background
#   ./scripts/e2e-mcp-setup.sh --stop   # Stop any running wrangler dev for MCP
#
# After starting, run: make test-e2e-phase2b

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKER_DIR="$ROOT_DIR/workers/mcp"
PORT=8976
BASE_URL="http://localhost:$PORT"

# -- Stop mode --
if [[ "${1:-}" == "--stop" ]]; then
  echo "Stopping MCP wrangler dev..."
  pkill -f "wrangler dev.*tminus-mcp" 2>/dev/null || true
  echo "Done."
  exit 0
fi

# -- Ensure .dev.vars exists --
if [[ ! -f "$WORKER_DIR/.dev.vars" ]]; then
  echo "Creating .dev.vars with development secrets..."
  cat > "$WORKER_DIR/.dev.vars" <<'DEVVARS'
JWT_SECRET=e2e-test-jwt-secret-minimum-32-characters-for-hs256
DEVVARS
  echo "Created $WORKER_DIR/.dev.vars"
else
  echo ".dev.vars already exists."
fi

# -- Kill existing MCP wrangler dev --
pkill -f "wrangler dev.*tminus-mcp" 2>/dev/null || true
sleep 1

# -- Clear state for clean run --
echo "Clearing local wrangler state for clean E2E run..."
rm -rf "$WORKER_DIR/.wrangler/state"

# -- Start wrangler dev in background --
echo "Starting MCP wrangler dev on port $PORT..."
cd "$WORKER_DIR"
npx wrangler dev --port "$PORT" --local --compatibility-flags=nodejs_compat > /tmp/wrangler-mcp-e2e.log 2>&1 &
WRANGLER_PID=$!
echo "Wrangler PID: $WRANGLER_PID"

# -- Wait for server to be ready --
echo "Waiting for MCP server..."
for i in $(seq 1 30); do
  if curl -sf "$BASE_URL/health" > /dev/null 2>&1; then
    echo "MCP server ready at $BASE_URL"
    break
  fi
  if ! kill -0 $WRANGLER_PID 2>/dev/null; then
    echo "ERROR: wrangler dev exited. Check /tmp/wrangler-mcp-e2e.log"
    cat /tmp/wrangler-mcp-e2e.log
    exit 1
  fi
  sleep 1
done

# Verify health
if ! curl -sf "$BASE_URL/health" > /dev/null 2>&1; then
  echo "ERROR: MCP server failed to start within 30 seconds."
  cat /tmp/wrangler-mcp-e2e.log
  kill $WRANGLER_PID 2>/dev/null
  exit 1
fi

# -- Apply D1 schema for MCP worker --
echo "Applying D1 schema to local MCP database..."
cd "$ROOT_DIR"

# The MCP worker uses the same D1 registry database. Apply the full schema.
npx wrangler d1 execute tminus-registry --local --config workers/mcp/wrangler.toml --command "
-- Base tables (from migration 0001)
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
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
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

-- MCP events table (from migration 0009 + 0010)
CREATE TABLE IF NOT EXISTS mcp_events (
  event_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id),
  account_id TEXT REFERENCES accounts(account_id),
  title TEXT NOT NULL,
  start_ts TEXT NOT NULL,
  end_ts TEXT NOT NULL,
  timezone TEXT DEFAULT 'UTC',
  description TEXT,
  location TEXT,
  status TEXT NOT NULL DEFAULT 'confirmed',
  source TEXT NOT NULL DEFAULT 'mcp',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_mcp_events_user ON mcp_events(user_id);
CREATE INDEX IF NOT EXISTS idx_mcp_events_user_time ON mcp_events(user_id, start_ts, end_ts);

-- MCP policies table (from migration 0011)
CREATE TABLE IF NOT EXISTS mcp_policies (
  policy_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id),
  from_account TEXT NOT NULL REFERENCES accounts(account_id),
  to_account TEXT NOT NULL REFERENCES accounts(account_id),
  detail_level TEXT NOT NULL CHECK(detail_level IN ('BUSY', 'TITLE', 'FULL')),
  calendar_kind TEXT NOT NULL DEFAULT 'BUSY_OVERLAY' CHECK(calendar_kind IN ('BUSY_OVERLAY', 'TRUE_MIRROR')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, from_account, to_account)
);

CREATE INDEX IF NOT EXISTS idx_mcp_policies_user ON mcp_policies(user_id);
CREATE INDEX IF NOT EXISTS idx_mcp_policies_from ON mcp_policies(from_account);
CREATE INDEX IF NOT EXISTS idx_mcp_policies_to ON mcp_policies(to_account);
" 2>&1

# -- Seed test data --
echo "Seeding test data..."
npx wrangler d1 execute tminus-registry --local --config workers/mcp/wrangler.toml --command "
-- Test org
INSERT OR IGNORE INTO orgs (org_id, name) VALUES ('org_e2e_mcp_test_01', 'E2E MCP Test Org');

-- Premium test user (for write tool access)
INSERT OR IGNORE INTO users (user_id, org_id, email) VALUES ('usr_e2e_mcp_premium_01', 'org_e2e_mcp_test_01', 'premium-e2e@test.tminus.ink');

-- Free test user (for tier restriction tests)
INSERT OR IGNORE INTO users (user_id, org_id, email) VALUES ('usr_e2e_mcp_free_01', 'org_e2e_mcp_test_01', 'free-e2e@test.tminus.ink');

-- Accounts for the premium user
INSERT OR IGNORE INTO accounts (account_id, user_id, provider, provider_subject, email, status)
  VALUES ('acc_e2e_mcp_google_01', 'usr_e2e_mcp_premium_01', 'google', 'google-e2e-premium-01', 'premium@gmail.com', 'active');

INSERT OR IGNORE INTO accounts (account_id, user_id, provider, provider_subject, email, status)
  VALUES ('acc_e2e_mcp_outlook_01', 'usr_e2e_mcp_premium_01', 'microsoft', 'ms-e2e-premium-01', 'premium@outlook.com', 'active');
" 2>&1

echo ""
echo "============================================"
echo "Local MCP E2E environment ready!"
echo "MCP server at: $BASE_URL"
echo "Wrangler PID: $WRANGLER_PID"
echo ""
echo "Run tests with: make test-e2e-phase2b"
echo "Stop server with: ./scripts/e2e-mcp-setup.sh --stop"
echo "============================================"
