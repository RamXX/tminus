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
 * Migration 0010: Add status column to mcp_events.
 *
 * Tracks event status ('confirmed', 'tentative', 'cancelled') to support
 * availability computation. Tentative events are shown as tentative slots
 * in calendar.get_availability. Cancelled events are excluded.
 * Default is 'confirmed' for backward compatibility with existing events.
 */
export const MIGRATION_0010_MCP_EVENTS_STATUS = `
ALTER TABLE mcp_events ADD COLUMN status TEXT NOT NULL DEFAULT 'confirmed';
` as const;

/**
 * Migration 0011: MCP policy edges table.
 *
 * Stores directional projection policies between accounts. A policy edge
 * defines how events from one account project to another (e.g., BUSY overlay
 * from work calendar to personal calendar).
 *
 * Business rules:
 * - detail_level: BUSY (time only), TITLE (time + title), FULL (everything)
 * - calendar_kind: BUSY_OVERLAY (default per BR-11), TRUE_MIRROR
 * - UNIQUE on (user_id, from_account, to_account) ensures one policy per direction
 */
export const MIGRATION_0011_MCP_POLICIES = `
-- MCP policy edges table
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
` as const;

/**
 * Migration 0012: Subscriptions table for Stripe billing.
 *
 * Stores subscription state synced from Stripe webhooks.
 * The tier column drives feature gate middleware (free -> premium -> enterprise).
 * Status tracks the Stripe subscription lifecycle.
 *
 * Design notes:
 * - subscription_id is our internal ID (sub_ ULID), NOT the Stripe subscription ID.
 * - stripe_subscription_id is the Stripe-assigned ID (sub_xxx from Stripe).
 * - One active subscription per user enforced by application logic.
 * - current_period_end is ISO 8601 timestamp of when the billing period ends.
 */
export const MIGRATION_0012_SUBSCRIPTIONS = `
-- Stripe billing subscriptions
CREATE TABLE subscriptions (
  subscription_id        TEXT PRIMARY KEY,
  user_id                TEXT NOT NULL REFERENCES users(user_id),
  tier                   TEXT NOT NULL DEFAULT 'free' CHECK(tier IN ('free', 'premium', 'enterprise')),
  stripe_customer_id     TEXT,
  stripe_subscription_id TEXT UNIQUE,
  current_period_end     TEXT,
  status                 TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'past_due', 'cancelled', 'unpaid', 'trialing')),
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_subscriptions_user ON subscriptions(user_id);
CREATE INDEX idx_subscriptions_stripe_customer ON subscriptions(stripe_customer_id);
CREATE INDEX idx_subscriptions_stripe_sub ON subscriptions(stripe_subscription_id);
` as const;

/**
 * Migration 0013: Subscription lifecycle columns and billing events audit log.
 *
 * Extends the subscriptions table with columns for lifecycle management:
 * - grace_period_end: ISO 8601 timestamp. Set on payment failure. After this
 *   date, user is downgraded if payment is not recovered.
 * - cancel_at_period_end: boolean flag. When true, the subscription will
 *   revert to free at current_period_end (used for downgrades and cancellations).
 * - previous_tier: stores the tier before a downgrade/cancellation so we can
 *   audit what the user had. NULL means no previous tier change.
 *
 * Creates billing_events table for AC#6 (all events logged):
 * - Every webhook event, state transition, and lifecycle change is recorded.
 * - Immutable audit trail -- no UPDATE or DELETE on this table.
 */
export const MIGRATION_0013_SUBSCRIPTION_LIFECYCLE = `
-- Subscription lifecycle columns
ALTER TABLE subscriptions ADD COLUMN grace_period_end TEXT;
ALTER TABLE subscriptions ADD COLUMN cancel_at_period_end INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN previous_tier TEXT;

-- Billing events audit log (immutable)
CREATE TABLE billing_events (
  event_id       TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  subscription_id TEXT,
  event_type     TEXT NOT NULL,
  stripe_event_id TEXT,
  old_tier       TEXT,
  new_tier       TEXT,
  old_status     TEXT,
  new_status     TEXT,
  metadata       TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_billing_events_user ON billing_events(user_id);
CREATE INDEX idx_billing_events_sub ON billing_events(subscription_id);
CREATE INDEX idx_billing_events_type ON billing_events(event_type);
CREATE INDEX idx_billing_events_created ON billing_events(created_at);
` as const;

/**
 * Migration 0014: Group scheduling sessions table (Phase 4D).
 *
 * Cross-user session registry for multi-user scheduling coordination.
 * Each row represents a group scheduling session with its participants.
 * The actual session data (candidates, holds) lives in each participant's
 * UserGraphDO -- this table is for cross-user discovery only.
 */
export const MIGRATION_0014_GROUP_SCHEDULING_SESSIONS = `
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
` as const;

/**
 * Migration 0015: Multi-tenant organizations table.
 *
 * Organizations provide multi-tenant grouping for enterprise users.
 * Each organization has a settings_json column for tenant-specific config.
 */
export const MIGRATION_0015_ORGANIZATIONS = `
CREATE TABLE organizations (
  org_id        TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  settings_json TEXT DEFAULT '{}'
);
` as const;

/**
 * Migration 0016: Organization members table.
 *
 * Maps users to organizations with role-based access (admin/member).
 * Admins can manage members; members have read-only org access.
 */
export const MIGRATION_0016_ORG_MEMBERS = `
CREATE TABLE org_members (
  org_id    TEXT NOT NULL,
  user_id   TEXT NOT NULL,
  role      TEXT NOT NULL CHECK(role IN ('admin','member')),
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(org_id, user_id)
);
` as const;

/**
 * Migration 0017: Organization-level policies.
 *
 * Stores org-level policies that apply to all members as a floor.
 * Users can be stricter than org policy but not more lenient.
 * Policy types: mandatory_working_hours, minimum_vip_priority,
 * required_projection_detail, max_account_count.
 * Unique constraint on (org_id, policy_type) ensures one policy per type per org.
 */
export const MIGRATION_0017_ORG_POLICIES = `
CREATE TABLE org_policies (
  policy_id   TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL,
  policy_type TEXT NOT NULL CHECK(policy_type IN (
    'mandatory_working_hours',
    'minimum_vip_priority',
    'required_projection_detail',
    'max_account_count'
  )),
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  created_by  TEXT NOT NULL
);

CREATE INDEX idx_org_policies_org ON org_policies(org_id);
CREATE UNIQUE INDEX idx_org_policies_org_type ON org_policies(org_id, policy_type);
` as const;

/**
 * Migration 0018: Add seat billing columns to organizations.
 *
 * Extends the organizations table with per-seat billing support:
 * - seat_limit: maximum members allowed (default 5 = enterprise base includes)
 * - stripe_subscription_id: links org to its Stripe subscription for
 *   seat quantity management
 */
export const MIGRATION_0018_ORG_SEAT_BILLING = `
ALTER TABLE organizations ADD COLUMN seat_limit INTEGER NOT NULL DEFAULT 5;
ALTER TABLE organizations ADD COLUMN stripe_subscription_id TEXT;
` as const;

/**
 * Migration 0019: Device tokens table for push notifications.
 *
 * Stores APNs/FCM device tokens keyed by user_id. Lives in D1
 * (not UserGraphDO SQLite) because the push worker needs cross-user
 * lookup to find all device tokens for a given user.
 *
 * Constraints:
 * - UNIQUE(user_id, device_token) prevents duplicate registrations
 * - platform CHECK constraint restricts to 'ios', 'android', 'web'
 * - Indexed by user_id for fast lookup and device_token for dedup
 */
export const MIGRATION_0019_DEVICE_TOKENS = `
-- Device tokens for push notifications
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
` as const;

/**
 * Migration 0020: ICS feed refresh metadata (TM-d17.3).
 *
 * Stores per-feed refresh tracking state for ICS feed polling:
 * - feed_etag: ETag from last successful response (BR-2 conditional requests)
 * - feed_last_modified: Last-Modified header from last response
 * - feed_content_hash: djb2 hash of last response body for change detection
 * - feed_last_refresh_at: ISO timestamp of last successful refresh
 * - feed_last_fetch_at: ISO timestamp of last fetch attempt (success or failure)
 * - feed_consecutive_failures: backoff counter for error handling
 * - feed_refresh_interval_ms: user-configurable interval (default: 15 min, 0 = manual)
 * - feed_event_sequences_json: JSON map of event UID -> SEQUENCE for per-event diff
 *
 * Only applicable to accounts with provider = 'ics_feed'. For other providers
 * these columns remain NULL.
 *
 * Per story learning from TM-lfy retro: optional fields use NULL (key omission
 * pattern), not sentinel values like false/0.
 */
export const MIGRATION_0020_FEED_REFRESH = `
ALTER TABLE accounts ADD COLUMN feed_etag TEXT;
ALTER TABLE accounts ADD COLUMN feed_last_modified TEXT;
ALTER TABLE accounts ADD COLUMN feed_content_hash TEXT;
ALTER TABLE accounts ADD COLUMN feed_last_refresh_at TEXT;
ALTER TABLE accounts ADD COLUMN feed_last_fetch_at TEXT;
ALTER TABLE accounts ADD COLUMN feed_consecutive_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN feed_refresh_interval_ms INTEGER;
ALTER TABLE accounts ADD COLUMN feed_event_sequences_json TEXT;
` as const;

/**
 * Migration 0021: Organization-level Marketplace installations.
 *
 * Stores org-level installation state when a Google Workspace admin
 * installs T-Minus for their entire organization from the admin console.
 * Tracks the installing admin, granted scopes, and active/inactive status.
 * Users in the org can then activate without individual OAuth consent.
 *
 * Business rules (from TM-ga8.4):
 * - BR-1: Org install does NOT auto-sync all user calendars (opt-in via visit)
 * - BR-2: Admin deactivation disconnects all org users and removes credentials
 * - BR-3: Individual users can still disconnect their own account
 */
export const MIGRATION_0021_ORG_INSTALLATIONS = `
CREATE TABLE org_installations (
  install_id         TEXT PRIMARY KEY,
  google_customer_id TEXT NOT NULL UNIQUE,
  org_id             TEXT,
  admin_email        TEXT NOT NULL,
  admin_google_sub   TEXT NOT NULL,
  scopes_granted     TEXT,
  status             TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'inactive')),
  installed_at       TEXT NOT NULL DEFAULT (datetime('now')),
  deactivated_at     TEXT
);

CREATE INDEX idx_org_installations_org ON org_installations(org_id);
CREATE INDEX idx_org_installations_status ON org_installations(status);
` as const;

/**
 * Migration 0022: Domain-wide delegation for Workspace orgs (TM-9iu.1).
 *
 * Stores domain-wide delegation configuration per Workspace domain.
 * Service account credentials encrypted with AES-256-GCM (AD-2).
 * delegation_status: 'pending' | 'active' | 'revoked'.
 */
export const MIGRATION_0022_ORG_DELEGATIONS = `
CREATE TABLE org_delegations (
  delegation_id       TEXT PRIMARY KEY,
  domain              TEXT NOT NULL UNIQUE,
  admin_email         TEXT NOT NULL,
  delegation_status   TEXT NOT NULL DEFAULT 'pending' CHECK(delegation_status IN ('pending', 'active', 'revoked')),
  encrypted_sa_key    TEXT NOT NULL,
  sa_client_email     TEXT NOT NULL,
  sa_client_id        TEXT NOT NULL,
  validated_at        TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_org_delegations_domain ON org_delegations(domain);
CREATE INDEX idx_org_delegations_status ON org_delegations(delegation_status);
` as const;

/**
 * Migration 0023: Service account credential rotation and impersonation token
 * cache (TM-9iu.2).
 *
 * Extends org_delegations with:
 * - active_users_count: tracked per-org user count
 * - registration_date: explicit registration timestamp (vs created_at)
 * - sa_key_created_at: when the current SA key was uploaded
 * - sa_key_last_used_at: last time the SA key was used for impersonation
 * - sa_key_rotation_due_at: 90-day reminder for key rotation
 * - previous_encrypted_sa_key: old key kept during zero-downtime rotation
 * - previous_sa_key_id: private_key_id of the old key
 * - last_health_check_at: last delegation health check timestamp
 * - health_check_status: result of last health check
 *
 * Creates impersonation_token_cache for per-user token caching (BR-4).
 *
 * Creates delegation_audit_log for tracking impersonation token issuance.
 */
export const MIGRATION_0023_DELEGATION_INFRASTRUCTURE = `
ALTER TABLE org_delegations ADD COLUMN active_users_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE org_delegations ADD COLUMN registration_date TEXT;
ALTER TABLE org_delegations ADD COLUMN sa_key_created_at TEXT;
ALTER TABLE org_delegations ADD COLUMN sa_key_last_used_at TEXT;
ALTER TABLE org_delegations ADD COLUMN sa_key_rotation_due_at TEXT;
ALTER TABLE org_delegations ADD COLUMN previous_encrypted_sa_key TEXT;
ALTER TABLE org_delegations ADD COLUMN previous_sa_key_id TEXT;
ALTER TABLE org_delegations ADD COLUMN last_health_check_at TEXT;
ALTER TABLE org_delegations ADD COLUMN health_check_status TEXT DEFAULT 'unknown' CHECK(health_check_status IN ('healthy', 'degraded', 'revoked', 'unknown'));
` as const;

/**
 * Migration 0024: Impersonation token cache and delegation audit log (TM-9iu.2).
 *
 * impersonation_token_cache: Per-user cached access tokens from service account
 * impersonation. Tokens have 1-hour expiry; we proactively refresh before expiry.
 *
 * delegation_audit_log: Immutable audit trail for every impersonation token
 * issuance. Required for compliance and security monitoring.
 */
export const MIGRATION_0024_DELEGATION_CACHE_AND_AUDIT = `
CREATE TABLE impersonation_token_cache (
  cache_id          TEXT PRIMARY KEY,
  delegation_id     TEXT NOT NULL,
  user_email        TEXT NOT NULL,
  encrypted_token   TEXT NOT NULL,
  token_expires_at  TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(delegation_id, user_email)
);

CREATE INDEX idx_imp_cache_delegation ON impersonation_token_cache(delegation_id);
CREATE INDEX idx_imp_cache_user ON impersonation_token_cache(user_email);
CREATE INDEX idx_imp_cache_expiry ON impersonation_token_cache(token_expires_at);

CREATE TABLE delegation_audit_log (
  audit_id          TEXT PRIMARY KEY,
  delegation_id     TEXT NOT NULL,
  domain            TEXT NOT NULL,
  user_email        TEXT NOT NULL,
  action            TEXT NOT NULL CHECK(action IN ('token_issued', 'token_refreshed', 'token_cached', 'health_check', 'key_rotated', 'delegation_revoked')),
  details           TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_deleg_audit_delegation ON delegation_audit_log(delegation_id);
CREATE INDEX idx_deleg_audit_user ON delegation_audit_log(user_email);
CREATE INDEX idx_deleg_audit_action ON delegation_audit_log(action);
CREATE INDEX idx_deleg_audit_created ON delegation_audit_log(created_at);
` as const;

/**
 * Migration 0025: User discovery and federation tables (TM-9iu.3).
 *
 * org_discovered_users: Tracks users discovered via Google Admin SDK
 * Directory API for domain-wide delegation orgs. Each row represents
 * a user in the org with their lifecycle state (active/suspended/removed).
 *
 * org_discovery_config: Per-org configuration for user discovery behavior.
 * Controls which OUs to include, which users to exclude, and whether
 * background sync is proactive or lazy (on first visit only).
 *
 * Business rules:
 * - BR-1: Discovery respects admin-configured OU filters
 * - BR-2: Suspended users' calendars stop syncing immediately
 * - BR-3: Removed users' data cleaned up per retention policy
 * - BR-4: Directory API calls rate-limited to Google's quotas
 */
export const MIGRATION_0025_ORG_DISCOVERY = `
-- Discovered users from Google Directory API
CREATE TABLE org_discovered_users (
  discovery_id      TEXT PRIMARY KEY,
  delegation_id     TEXT NOT NULL,
  google_user_id    TEXT NOT NULL,
  email             TEXT NOT NULL,
  display_name      TEXT,
  org_unit_path     TEXT,
  status            TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'suspended', 'removed')),
  account_id        TEXT,
  last_synced_at    TEXT,
  discovered_at     TEXT NOT NULL DEFAULT (datetime('now')),
  status_changed_at TEXT NOT NULL DEFAULT (datetime('now')),
  removed_at        TEXT,
  UNIQUE(delegation_id, google_user_id)
);

CREATE INDEX idx_discovered_users_delegation ON org_discovered_users(delegation_id);
CREATE INDEX idx_discovered_users_email ON org_discovered_users(email);
CREATE INDEX idx_discovered_users_status ON org_discovered_users(status);
CREATE INDEX idx_discovered_users_account ON org_discovered_users(account_id);

-- Per-org discovery configuration
CREATE TABLE org_discovery_config (
  config_id         TEXT PRIMARY KEY,
  delegation_id     TEXT NOT NULL UNIQUE,
  ou_filter_json    TEXT,
  excluded_emails   TEXT,
  sync_mode         TEXT NOT NULL DEFAULT 'lazy' CHECK(sync_mode IN ('proactive', 'lazy')),
  retention_days    INTEGER NOT NULL DEFAULT 30,
  last_discovery_at TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_discovery_config_delegation ON org_discovery_config(delegation_id);
` as const;

/**
 * Migration 0026: Compliance audit log, org rate limits, and quota tracking (TM-9iu.5).
 *
 * compliance_audit_log: Tamper-evident audit log with hash chain integrity.
 * Each entry includes SHA-256 hash of the previous entry, forming an
 * append-only chain that detects any modification or deletion.
 *
 * org_rate_limit_config: Per-org rate limit configuration for API, Directory
 * API, and impersonation token buckets.
 *
 * org_quota_config: Per-org quota limits for discovered users, delegations,
 * and daily API calls.
 *
 * org_quota_usage: Counter-based quota usage tracking with period keys
 * for daily reset support.
 *
 * Business rules:
 * - BR-2: compliance_audit_log is append-only (no updates, no deletes)
 * - BR-3: Hash chain integrity verified on read
 */
export const MIGRATION_0026_COMPLIANCE_AND_QUOTAS = `
-- Compliance audit log with hash chain (append-only)
CREATE TABLE compliance_audit_log (
  entry_id       TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL,
  timestamp      TEXT NOT NULL,
  actor          TEXT NOT NULL,
  action         TEXT NOT NULL CHECK(action IN (
    'delegation_created', 'delegation_rotated', 'user_discovered',
    'user_suspended', 'user_removed', 'config_updated',
    'token_issued', 'admin_action'
  )),
  target         TEXT NOT NULL,
  result         TEXT NOT NULL CHECK(result IN ('success', 'failure', 'error')),
  ip_address     TEXT NOT NULL,
  user_agent     TEXT NOT NULL,
  details        TEXT,
  previous_hash  TEXT NOT NULL,
  entry_hash     TEXT NOT NULL,
  UNIQUE(org_id, entry_hash)
);

CREATE INDEX idx_compliance_audit_org ON compliance_audit_log(org_id);
CREATE INDEX idx_compliance_audit_timestamp ON compliance_audit_log(org_id, timestamp);
CREATE INDEX idx_compliance_audit_action ON compliance_audit_log(action);
CREATE INDEX idx_compliance_audit_actor ON compliance_audit_log(actor);

-- Per-org rate limit configuration
CREATE TABLE org_rate_limit_config (
  org_id                       TEXT PRIMARY KEY,
  api_max_requests             INTEGER NOT NULL DEFAULT 1000,
  api_window_seconds           INTEGER NOT NULL DEFAULT 60,
  directory_max_requests       INTEGER NOT NULL DEFAULT 100,
  directory_window_seconds     INTEGER NOT NULL DEFAULT 60,
  impersonation_max_requests   INTEGER NOT NULL DEFAULT 60,
  impersonation_window_seconds INTEGER NOT NULL DEFAULT 60,
  created_at                   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Per-org quota configuration
CREATE TABLE org_quota_config (
  org_id               TEXT PRIMARY KEY,
  max_discovered_users INTEGER NOT NULL DEFAULT 500,
  max_delegations      INTEGER NOT NULL DEFAULT 10,
  max_api_calls_daily  INTEGER NOT NULL DEFAULT 10000,
  retention_days       INTEGER NOT NULL DEFAULT 90,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Quota usage tracking (counter-based with period key for daily reset)
CREATE TABLE org_quota_usage (
  org_id      TEXT NOT NULL,
  quota_type  TEXT NOT NULL CHECK(quota_type IN ('discovered_users', 'delegations', 'api_calls_daily')),
  period_key  TEXT NOT NULL,
  usage_count INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(org_id, quota_type, period_key)
);

CREATE INDEX idx_quota_usage_org ON org_quota_usage(org_id);

-- Rate limit counter state (for org-level fixed-window counters)
CREATE TABLE org_rate_limit_counters (
  counter_key TEXT PRIMARY KEY,
  count       INTEGER NOT NULL DEFAULT 0,
  expires_at  TEXT NOT NULL
);

CREATE INDEX idx_rl_counters_expires ON org_rate_limit_counters(expires_at);
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
  MIGRATION_0010_MCP_EVENTS_STATUS,
  MIGRATION_0011_MCP_POLICIES,
  MIGRATION_0012_SUBSCRIPTIONS,
  MIGRATION_0013_SUBSCRIPTION_LIFECYCLE,
  MIGRATION_0014_GROUP_SCHEDULING_SESSIONS,
  MIGRATION_0015_ORGANIZATIONS,
  MIGRATION_0016_ORG_MEMBERS,
  MIGRATION_0017_ORG_POLICIES,
  MIGRATION_0018_ORG_SEAT_BILLING,
  MIGRATION_0019_DEVICE_TOKENS,
  MIGRATION_0020_FEED_REFRESH,
  MIGRATION_0021_ORG_INSTALLATIONS,
  MIGRATION_0022_ORG_DELEGATIONS,
  MIGRATION_0023_DELEGATION_INFRASTRUCTURE,
  MIGRATION_0024_DELEGATION_CACHE_AND_AUDIT,
  MIGRATION_0025_ORG_DISCOVERY,
  MIGRATION_0026_COMPLIANCE_AND_QUOTAS,
] as const;
