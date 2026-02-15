-- MCP policy edges table
-- Stores directional projection policies between accounts
-- A policy edge defines how events from one account project to another
CREATE TABLE mcp_policies (
  policy_id      TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(user_id),
  from_account   TEXT NOT NULL REFERENCES accounts(account_id),
  to_account     TEXT NOT NULL REFERENCES accounts(account_id),
  detail_level   TEXT NOT NULL CHECK(detail_level IN ('BUSY', 'TITLE', 'FULL')),
  calendar_kind  TEXT NOT NULL DEFAULT 'BUSY_OVERLAY' CHECK(calendar_kind IN ('BUSY_OVERLAY', 'TRUE_MIRROR')),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, from_account, to_account)
);

CREATE INDEX idx_mcp_policies_user ON mcp_policies(user_id);
CREATE INDEX idx_mcp_policies_from ON mcp_policies(from_account);
CREATE INDEX idx_mcp_policies_to ON mcp_policies(to_account);
