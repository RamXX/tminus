-- Migration 0014: Group scheduling sessions table (Phase 4D)
-- Cross-user session registry for multi-user scheduling coordination.

CREATE TABLE group_scheduling_sessions (
  session_id           TEXT PRIMARY KEY,
  creator_user_id      TEXT NOT NULL,
  participant_ids_json TEXT NOT NULL,
  title                TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'gathering',
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_group_sessions_creator ON group_scheduling_sessions(creator_user_id);
CREATE INDEX idx_group_sessions_status ON group_scheduling_sessions(status);
