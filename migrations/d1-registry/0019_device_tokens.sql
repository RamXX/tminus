-- Migration 0019: Device tokens table for push notifications.
-- Stores APNs/FCM device tokens keyed by user.
-- D1 is used (not UserGraphDO SQLite) because device token lookup
-- is cross-user (push worker needs to find all tokens for a user_id).

CREATE TABLE device_tokens (
  token_id      TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(user_id),
  device_token  TEXT NOT NULL,
  platform      TEXT NOT NULL CHECK(platform IN ('ios', 'android', 'web')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, device_token)
);

CREATE INDEX idx_device_tokens_user ON device_tokens(user_id);
CREATE INDEX idx_device_tokens_token ON device_tokens(device_token);
