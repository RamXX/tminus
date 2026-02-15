-- MCP-created events table
-- Stores events created via the MCP server tools (calendar.create_event).
-- These are canonical events with source='mcp'. In a later phase, they
-- will integrate into UserGraphDO's event-sourcing journal.
CREATE TABLE mcp_events (
  event_id     TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(user_id),
  account_id   TEXT REFERENCES accounts(account_id),
  title        TEXT NOT NULL,
  start_ts     TEXT NOT NULL,
  end_ts       TEXT NOT NULL,
  timezone     TEXT DEFAULT 'UTC',
  description  TEXT,
  location     TEXT,
  source       TEXT NOT NULL DEFAULT 'mcp',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_mcp_events_user ON mcp_events(user_id);
CREATE INDEX idx_mcp_events_user_time ON mcp_events(user_id, start_ts, end_ts);
