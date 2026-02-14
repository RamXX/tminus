/**
 * @tminus/d1-registry -- D1 registry schema definitions.
 *
 * The canonical migration SQL lives in migrations/d1-registry/0001_initial_schema.sql
 * and is applied via `wrangler d1 migrations apply`. This module re-exports the
 * SQL as a constant so tests can apply it to an in-process SQLite database and
 * validate correctness without depending on wrangler.
 */

/**
 * Migration 0001: Initial D1 registry schema.
 *
 * Creates four tables:
 * - orgs: Organization registry
 * - users: User registry (belongs to org)
 * - accounts: External calendar account registry (webhook routing, OAuth)
 * - deletion_certificates: GDPR/CCPA proof of deletion
 *
 * Plus indexes for accounts lookup by user_id and channel_id.
 */
export const MIGRATION_0001_INITIAL_SCHEMA = `
-- Organization registry
CREATE TABLE orgs (
  org_id       TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- User registry
CREATE TABLE users (
  user_id      TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES orgs(org_id),
  email        TEXT NOT NULL UNIQUE,
  display_name TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- External account registry (webhook routing + OAuth callback)
CREATE TABLE accounts (
  account_id           TEXT PRIMARY KEY,
  user_id              TEXT NOT NULL REFERENCES users(user_id),
  provider             TEXT NOT NULL DEFAULT 'google',
  provider_subject     TEXT NOT NULL,
  email                TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'active',
  channel_id           TEXT,
  channel_token        TEXT,
  channel_expiry_ts    TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(provider, provider_subject)
);

CREATE INDEX idx_accounts_user ON accounts(user_id);
CREATE INDEX idx_accounts_channel ON accounts(channel_id);

-- Deletion certificates (GDPR/CCPA proof)
CREATE TABLE deletion_certificates (
  cert_id       TEXT PRIMARY KEY,
  entity_type   TEXT NOT NULL,
  entity_id     TEXT NOT NULL,
  deleted_at    TEXT NOT NULL DEFAULT (datetime('now')),
  proof_hash    TEXT NOT NULL,
  signature     TEXT NOT NULL
);
` as const;

/**
 * All migration SQL strings in order. Apply them sequentially to bring
 * a fresh D1 database to the current schema version.
 */
export const ALL_MIGRATIONS = [MIGRATION_0001_INITIAL_SCHEMA] as const;
