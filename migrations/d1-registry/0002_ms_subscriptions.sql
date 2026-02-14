-- Migration 0002: Microsoft Graph subscription lookup table.
-- Maps Microsoft subscription IDs to account IDs for incoming webhook routing.
-- When a Microsoft change notification arrives, we look up the subscriptionId
-- to find which account it belongs to and enqueue the sync job.

CREATE TABLE ms_subscriptions (
  subscription_id TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_ms_subscriptions_account ON ms_subscriptions(account_id);
