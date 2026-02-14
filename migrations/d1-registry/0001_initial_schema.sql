-- Migration 0001: Initial D1 registry schema
-- D1 is the cross-user lookup database: routing, identity, and compliance.
-- It is NOT on the hot sync path.

-- Organization registry
CREATE TABLE orgs (
  org_id       TEXT PRIMARY KEY,  -- ULID
  name         TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- User registry
CREATE TABLE users (
  user_id      TEXT PRIMARY KEY,  -- ULID
  org_id       TEXT NOT NULL REFERENCES orgs(org_id),
  email        TEXT NOT NULL UNIQUE,
  display_name TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- External account registry (webhook routing + OAuth callback)
CREATE TABLE accounts (
  account_id           TEXT PRIMARY KEY,  -- ULID
  user_id              TEXT NOT NULL REFERENCES users(user_id),
  provider             TEXT NOT NULL DEFAULT 'google',
  provider_subject     TEXT NOT NULL,  -- Google sub claim
  email                TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'active',  -- active | revoked | error
  channel_id           TEXT,           -- current watch channel UUID
  channel_token        TEXT,           -- secret token for webhook validation (X-Goog-Channel-Token)
  channel_expiry_ts    TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(provider, provider_subject)
);

CREATE INDEX idx_accounts_user ON accounts(user_id);
CREATE INDEX idx_accounts_channel ON accounts(channel_id);

-- Deletion certificates (GDPR/CCPA proof)
CREATE TABLE deletion_certificates (
  cert_id       TEXT PRIMARY KEY,
  entity_type   TEXT NOT NULL,  -- 'user' | 'account' | 'event'
  entity_id     TEXT NOT NULL,
  deleted_at    TEXT NOT NULL DEFAULT (datetime('now')),
  proof_hash    TEXT NOT NULL,  -- SHA-256 of deleted data summary
  signature     TEXT NOT NULL   -- system signature
);
