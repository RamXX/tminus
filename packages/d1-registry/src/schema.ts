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
 * Migration 0002: Microsoft Graph subscription lookup table.
 *
 * Maps Microsoft subscription IDs to account IDs for incoming webhook routing.
 * When a Microsoft change notification arrives, we look up the subscriptionId
 * to find which account it belongs to and enqueue the sync job.
 */
export const MIGRATION_0002_MS_SUBSCRIPTIONS = `
-- Microsoft Graph subscription lookup
CREATE TABLE ms_subscriptions (
  subscription_id TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_ms_subscriptions_account ON ms_subscriptions(account_id);
` as const;

/**
 * Migration 0003: API keys table for programmatic access.
 *
 * Stores hashed API keys (SHA-256) for token-based auth as an
 * alternative to JWT Bearer tokens. Keys use the format:
 *   tmk_live_<8-char-prefix><32-char-random>
 *
 * The prefix is stored in plaintext for lookup; the full key is
 * hashed with SHA-256 (via Web Crypto) and stored as key_hash.
 * The raw key is never stored -- only shown once at creation time.
 */
export const MIGRATION_0003_API_KEYS = `
-- API keys for programmatic access
CREATE TABLE api_keys (
  key_id       TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(user_id),
  name         TEXT NOT NULL,
  prefix       TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,
  last_used_at TEXT,
  revoked_at   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_api_keys_user ON api_keys(user_id);
CREATE INDEX idx_api_keys_prefix ON api_keys(prefix);
` as const;

/**
 * Migration 0004: Auth fields on the users table.
 *
 * Adds password-based authentication support:
 * - password_hash: PBKDF2 derived key (nullable for legacy/OAuth-only users)
 * - password_version: enables JWT session invalidation on password change
 * - failed_login_attempts: progressive lockout counter
 * - locked_until: ISO8601 timestamp when lockout expires
 */
export const MIGRATION_0004_AUTH_FIELDS = `
ALTER TABLE users ADD COLUMN password_hash TEXT;
ALTER TABLE users ADD COLUMN password_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN failed_login_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN locked_until TEXT;
` as const;

/**
 * Migration 0005: Deletion requests table (GDPR Article 17).
 *
 * Tracks user account deletion requests with a 72-hour grace period.
 * Status transitions: pending -> processing -> completed, or pending -> cancelled.
 * Only one pending/processing request per user at a time (enforced by application logic).
 */
export const MIGRATION_0005_DELETION_REQUESTS = `
-- GDPR deletion requests
CREATE TABLE deletion_requests (
  request_id    TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(user_id),
  status        TEXT NOT NULL CHECK(status IN ('pending','processing','completed','cancelled')),
  requested_at  TEXT NOT NULL DEFAULT (datetime('now')),
  scheduled_at  TEXT NOT NULL,
  completed_at  TEXT,
  cancelled_at  TEXT
);

CREATE INDEX idx_deletion_requests_user ON deletion_requests(user_id);
CREATE INDEX idx_deletion_requests_status ON deletion_requests(status);
` as const;

/**
 * Migration 0006: Key rotation log table.
 *
 * Tracks master key rotation status per account for idempotent
 * rotation operations. The rotation script uses this to:
 * - Skip accounts already rotated (idempotent re-runs)
 * - Track failed rotations for retry
 * - Audit the rotation history
 */
export const MIGRATION_0006_KEY_ROTATION_LOG = `
-- Key rotation audit log
CREATE TABLE key_rotation_log (
  rotation_id   TEXT NOT NULL,
  account_id    TEXT NOT NULL,
  status        TEXT NOT NULL CHECK(status IN ('started','completed','failed')),
  error_message TEXT,
  started_at    TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at  TEXT,
  PRIMARY KEY (rotation_id, account_id)
);

CREATE INDEX idx_key_rotation_log_rotation ON key_rotation_log(rotation_id);
CREATE INDEX idx_key_rotation_log_status ON key_rotation_log(status);
` as const;

/**
 * Migration 0007: Add deletion_summary column to deletion_certificates.
 *
 * Stores a JSON summary of what was deleted (event counts, mirror counts,
 * journal counts, etc.) as part of the signed deletion certificate.
 * No PII -- only aggregate counts.
 */
export const MIGRATION_0007_DELETION_CERTIFICATE_SUMMARY = `
ALTER TABLE deletion_certificates ADD COLUMN deletion_summary TEXT;
` as const;

/**
 * Migration 0008: Add sync-status columns to the accounts table.
 *
 * Adds fields that the MCP server and API need for computing
 * per-account sync health without reaching into the AccountDO:
 * - last_sync_ts: ISO8601 timestamp of the last sync attempt
 *   (updated by the sync-consumer after each sync job)
 * - resource_id: Google Calendar push notification resource ID
 *   (populated during channel registration in onboarding)
 * - error_count: rolling error count for the account
 *   (incremented on sync failure, reset on success)
 */
export const MIGRATION_0008_SYNC_STATUS_COLUMNS = `
ALTER TABLE accounts ADD COLUMN last_sync_ts TEXT;
ALTER TABLE accounts ADD COLUMN resource_id TEXT;
ALTER TABLE accounts ADD COLUMN error_count INTEGER NOT NULL DEFAULT 0;
` as const;

/**
 * Migration 0009: MCP events table.
 *
 * Stores events created via MCP server tools (calendar.create_event).
 * These are canonical events with source='mcp'. In a later phase, they
 * will integrate into UserGraphDO's event-sourcing journal.
 */
export const MIGRATION_0009_MCP_EVENTS = `
-- MCP-created events table
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
` as const;

/**
 * All migration SQL strings in order. Apply them sequentially to bring
 * a fresh D1 database to the current schema version.
 */
export const ALL_MIGRATIONS = [
  MIGRATION_0001_INITIAL_SCHEMA,
  MIGRATION_0002_MS_SUBSCRIPTIONS,
  MIGRATION_0003_API_KEYS,
  MIGRATION_0004_AUTH_FIELDS,
  MIGRATION_0005_DELETION_REQUESTS,
  MIGRATION_0006_KEY_ROTATION_LOG,
  MIGRATION_0007_DELETION_CERTIFICATE_SUMMARY,
  MIGRATION_0008_SYNC_STATUS_COLUMNS,
  MIGRATION_0009_MCP_EVENTS,
] as const;
