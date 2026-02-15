/**
 * @tminus/shared -- DO SQLite schema definitions and auto-migration runner.
 *
 * Defines the complete SQLite schema for UserGraphDO and AccountDO Durable
 * Objects. All tables (Phase 1 through Phase 4) are created upfront per
 * ADR decision: empty tables cost nothing and prevent disruptive migrations
 * later.
 *
 * The migration runner tracks schema_version in a _schema_meta table and
 * applies pending migrations sequentially. It is designed to work with
 * Cloudflare DO SqlStorage's synchronous exec() interface.
 */

// ---------------------------------------------------------------------------
// SqlStorage compatibility types
// ---------------------------------------------------------------------------

/**
 * Minimal interface matching Cloudflare DO SqlStorage.exec().
 *
 * We define our own interface here so that:
 * 1. Production code uses the real SqlStorage from Cloudflare
 * 2. Tests can provide a compatible adapter over better-sqlite3
 * 3. No dependency on @cloudflare/workers-types in the shared package
 */
export interface SqlStorageLike {
  exec<T extends Record<string, unknown>>(
    query: string,
    ...bindings: unknown[]
  ): SqlStorageCursorLike<T>;
}

export interface SqlStorageCursorLike<T> {
  toArray(): T[];
  one(): T;
}

// ---------------------------------------------------------------------------
// Migration types
// ---------------------------------------------------------------------------

/** A single schema migration step. */
export interface Migration {
  /** Monotonically increasing version number starting at 1. */
  readonly version: number;
  /** The SQL to execute for this migration. */
  readonly sql: string;
  /** Human-readable description of what this migration does. */
  readonly description: string;
}

// ---------------------------------------------------------------------------
// UserGraphDO schema -- ALL tables from architecture (Phase 1-4)
// ---------------------------------------------------------------------------

/**
 * UserGraphDO migration v1: Creates the complete per-user schema.
 *
 * Phase 1 active tables:
 *   calendars, canonical_events, event_mirrors, event_journal,
 *   policies, policy_edges, constraints
 *
 * Phase 2+ tables (created empty for forward stability):
 *   time_allocations, time_commitments, commitment_reports,
 *   vip_policies, relationships, interaction_ledger, milestones,
 *   schedule_sessions, schedule_candidates, schedule_holds
 */
export const USER_GRAPH_DO_MIGRATION_V1 = `
-- Calendars linked to this user's accounts
CREATE TABLE calendars (
  calendar_id          TEXT PRIMARY KEY,
  account_id           TEXT NOT NULL,
  provider_calendar_id TEXT NOT NULL,
  role                 TEXT NOT NULL DEFAULT 'primary',
  kind                 TEXT NOT NULL DEFAULT 'PRIMARY',
  display_name         TEXT,
  UNIQUE(account_id, provider_calendar_id)
);

-- Canonical events (the single source of truth)
CREATE TABLE canonical_events (
  canonical_event_id   TEXT PRIMARY KEY,
  origin_account_id    TEXT NOT NULL,
  origin_event_id      TEXT NOT NULL,
  title                TEXT,
  description          TEXT,
  location             TEXT,
  start_ts             TEXT NOT NULL,
  end_ts               TEXT NOT NULL,
  timezone             TEXT,
  all_day              INTEGER NOT NULL DEFAULT 0,
  status               TEXT NOT NULL DEFAULT 'confirmed',
  visibility           TEXT NOT NULL DEFAULT 'default',
  transparency         TEXT NOT NULL DEFAULT 'opaque',
  recurrence_rule      TEXT,
  source               TEXT NOT NULL,
  version              INTEGER NOT NULL DEFAULT 1,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(origin_account_id, origin_event_id)
);

CREATE INDEX idx_events_time ON canonical_events(start_ts, end_ts);
CREATE INDEX idx_events_origin ON canonical_events(origin_account_id);

-- Mirror mapping
CREATE TABLE event_mirrors (
  canonical_event_id    TEXT NOT NULL REFERENCES canonical_events(canonical_event_id),
  target_account_id     TEXT NOT NULL,
  target_calendar_id    TEXT NOT NULL,
  provider_event_id     TEXT,
  last_projected_hash   TEXT,
  last_write_ts         TEXT,
  state                 TEXT NOT NULL DEFAULT 'PENDING',
  error_message         TEXT,
  PRIMARY KEY (canonical_event_id, target_account_id)
);

-- Append-only change journal (event-sourcing per ADR-5)
CREATE TABLE event_journal (
  journal_id           TEXT PRIMARY KEY,
  canonical_event_id   TEXT NOT NULL,
  ts                   TEXT NOT NULL DEFAULT (datetime('now')),
  actor                TEXT NOT NULL,
  change_type          TEXT NOT NULL,
  patch_json           TEXT,
  reason               TEXT
);

CREATE INDEX idx_journal_event ON event_journal(canonical_event_id);
CREATE INDEX idx_journal_ts ON event_journal(ts);

-- Policy graph
CREATE TABLE policies (
  policy_id       TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  is_default      INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE policy_edges (
  policy_id        TEXT NOT NULL REFERENCES policies(policy_id),
  from_account_id  TEXT NOT NULL,
  to_account_id    TEXT NOT NULL,
  detail_level     TEXT NOT NULL DEFAULT 'BUSY',
  calendar_kind    TEXT NOT NULL DEFAULT 'BUSY_OVERLAY',
  PRIMARY KEY (policy_id, from_account_id, to_account_id)
);

-- Constraints
CREATE TABLE constraints (
  constraint_id    TEXT PRIMARY KEY,
  kind             TEXT NOT NULL,
  config_json      TEXT NOT NULL,
  active_from      TEXT,
  active_to        TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Time accounting (Phase 3)
CREATE TABLE time_allocations (
  allocation_id       TEXT PRIMARY KEY,
  canonical_event_id  TEXT NOT NULL REFERENCES canonical_events(canonical_event_id),
  client_id           TEXT,
  billing_category    TEXT NOT NULL DEFAULT 'NON_BILLABLE',
  rate                REAL,
  confidence          TEXT NOT NULL DEFAULT 'manual',
  locked              INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Commitment tracking (Phase 3)
CREATE TABLE time_commitments (
  commitment_id        TEXT PRIMARY KEY,
  client_id            TEXT NOT NULL,
  client_name          TEXT,
  window_type          TEXT NOT NULL DEFAULT 'WEEKLY',
  target_hours         REAL NOT NULL,
  rolling_window_weeks INTEGER NOT NULL DEFAULT 4,
  hard_minimum         INTEGER NOT NULL DEFAULT 0,
  proof_required       INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE commitment_reports (
  report_id        TEXT PRIMARY KEY,
  commitment_id    TEXT NOT NULL REFERENCES time_commitments(commitment_id),
  window_start     TEXT NOT NULL,
  window_end       TEXT NOT NULL,
  actual_hours     REAL NOT NULL,
  expected_hours   REAL NOT NULL,
  status           TEXT NOT NULL,
  proof_hash       TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- VIP policies (Phase 3)
CREATE TABLE vip_policies (
  vip_id              TEXT PRIMARY KEY,
  participant_hash    TEXT NOT NULL,
  display_name        TEXT,
  priority_weight     REAL NOT NULL DEFAULT 1.0,
  conditions_json     TEXT NOT NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Relationship graph (Phase 4)
CREATE TABLE relationships (
  relationship_id              TEXT PRIMARY KEY,
  participant_hash             TEXT NOT NULL UNIQUE,
  display_name                 TEXT,
  category                     TEXT NOT NULL DEFAULT 'OTHER',
  closeness_weight             REAL NOT NULL DEFAULT 0.5,
  last_interaction_ts          TEXT,
  city                         TEXT,
  timezone                     TEXT,
  interaction_frequency_target INTEGER,
  created_at                   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Interaction ledger (Phase 4)
CREATE TABLE interaction_ledger (
  ledger_id          TEXT PRIMARY KEY,
  participant_hash   TEXT NOT NULL,
  canonical_event_id TEXT,
  outcome            TEXT NOT NULL,
  weight             REAL NOT NULL DEFAULT 1.0,
  note               TEXT,
  ts                 TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_ledger_participant ON interaction_ledger(participant_hash);

-- Life event milestones (Phase 4)
CREATE TABLE milestones (
  milestone_id      TEXT PRIMARY KEY,
  participant_hash  TEXT,
  kind              TEXT NOT NULL,
  date              TEXT NOT NULL,
  recurs_annually   INTEGER NOT NULL DEFAULT 0,
  note              TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Scheduling sessions (Phase 3+)
CREATE TABLE schedule_sessions (
  session_id       TEXT PRIMARY KEY,
  status           TEXT NOT NULL DEFAULT 'open',
  objective_json   TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE schedule_candidates (
  candidate_id     TEXT PRIMARY KEY,
  session_id       TEXT NOT NULL REFERENCES schedule_sessions(session_id),
  start_ts         TEXT NOT NULL,
  end_ts           TEXT NOT NULL,
  score            REAL,
  explanation      TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE schedule_holds (
  hold_id          TEXT PRIMARY KEY,
  session_id       TEXT NOT NULL REFERENCES schedule_sessions(session_id),
  account_id       TEXT NOT NULL,
  provider_event_id TEXT,
  expires_at       TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'held'
);
` as const;

// ---------------------------------------------------------------------------
// AccountDO schema
// ---------------------------------------------------------------------------

/**
 * AccountDO migration v1: Creates per-account auth, sync, and watch tables.
 *
 * Tables:
 *   auth - encrypted OAuth tokens (AES-256-GCM envelope encryption)
 *   sync_state - sync cursor and state tracking
 *   watch_channels - Google Calendar push notification channels
 */
export const ACCOUNT_DO_MIGRATION_V1 = `
CREATE TABLE auth (
  account_id       TEXT PRIMARY KEY,
  encrypted_tokens TEXT NOT NULL,
  scopes           TEXT NOT NULL,
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sync_state (
  account_id       TEXT PRIMARY KEY,
  sync_token       TEXT,
  last_sync_ts     TEXT,
  last_success_ts  TEXT,
  full_sync_needed INTEGER NOT NULL DEFAULT 1,
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE watch_channels (
  channel_id       TEXT PRIMARY KEY,
  account_id       TEXT NOT NULL,
  resource_id      TEXT,
  expiry_ts        TEXT NOT NULL,
  calendar_id      TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'active',
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
` as const;

// ---------------------------------------------------------------------------
// Migration lists
// ---------------------------------------------------------------------------

/**
 * UserGraphDO migration v2: Add constraint_id to canonical_events.
 *
 * Links derived canonical events (e.g., trip busy blocks) back to their
 * source constraint. Nullable because most events are provider-sourced
 * and have no associated constraint.
 */
export const USER_GRAPH_DO_MIGRATION_V2 = `
ALTER TABLE canonical_events ADD COLUMN constraint_id TEXT REFERENCES constraints(constraint_id);
CREATE INDEX idx_events_constraint ON canonical_events(constraint_id);
` as const;

/**
 * UserGraphDO migration v3: Add drift_alerts table.
 *
 * Stores snapshots of drift alerts computed by the daily cron job.
 * Each run replaces the previous alerts (DELETE + INSERT pattern).
 * Allows retrieval of the most recent drift alert set independently
 * from the live drift report.
 */
export const USER_GRAPH_DO_MIGRATION_V3 = `
CREATE TABLE drift_alerts (
  alert_id        TEXT PRIMARY KEY,
  relationship_id TEXT NOT NULL REFERENCES relationships(relationship_id) ON DELETE CASCADE,
  display_name    TEXT,
  category        TEXT NOT NULL,
  drift_ratio     REAL NOT NULL,
  days_overdue    INTEGER NOT NULL,
  urgency         REAL NOT NULL,
  computed_at     TEXT NOT NULL
);

CREATE INDEX idx_drift_alerts_computed ON drift_alerts(computed_at);
CREATE INDEX idx_drift_alerts_urgency ON drift_alerts(urgency DESC);
` as const;

/**
 * UserGraphDO migration v4: Add event_participants table.
 *
 * Persistently links canonical events to their participant hashes.
 * Populated during applyProviderDelta when participant_hashes are
 * provided in the delta. Used by the pre-meeting briefing engine
 * to match event attendees against tracked relationships.
 */
export const USER_GRAPH_DO_MIGRATION_V4 = `
CREATE TABLE event_participants (
  canonical_event_id TEXT NOT NULL REFERENCES canonical_events(canonical_event_id) ON DELETE CASCADE,
  participant_hash   TEXT NOT NULL,
  PRIMARY KEY (canonical_event_id, participant_hash)
);

CREATE INDEX idx_event_participants_hash ON event_participants(participant_hash);
` as const;

/**
 * UserGraphDO migration v5: Add scheduling_history table.
 *
 * Tracks per-participant scheduling outcomes for fairness scoring (TM-82s.3).
 * Each row records whether a participant got their preferred time in a given
 * scheduling session. The aggregate (sessions_participated, sessions_preferred)
 * is computed at query time to drive fairness adjustments.
 */
export const USER_GRAPH_DO_MIGRATION_V5 = `
CREATE TABLE scheduling_history (
  id                 TEXT PRIMARY KEY,
  session_id         TEXT NOT NULL,
  participant_hash   TEXT NOT NULL,
  got_preferred      INTEGER NOT NULL DEFAULT 0,
  scheduled_ts       TEXT NOT NULL,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_sched_hist_participant ON scheduling_history(participant_hash);
CREATE INDEX idx_sched_hist_session ON scheduling_history(session_id);
` as const;

/** Ordered migrations for UserGraphDO. Apply sequentially. */
export const USER_GRAPH_DO_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: USER_GRAPH_DO_MIGRATION_V1,
    description: "Initial UserGraphDO schema: all tables Phase 1-4",
  },
  {
    version: 2,
    sql: USER_GRAPH_DO_MIGRATION_V2,
    description: "Add constraint_id column to canonical_events for trip/constraint linking",
  },
  {
    version: 3,
    sql: USER_GRAPH_DO_MIGRATION_V3,
    description: "Add drift_alerts table for persisted drift alert snapshots",
  },
  {
    version: 4,
    sql: USER_GRAPH_DO_MIGRATION_V4,
    description: "Add event_participants table for briefing participant matching",
  },
  {
    version: 5,
    sql: USER_GRAPH_DO_MIGRATION_V5,
    description: "Add scheduling_history table for fairness scoring",
  },
] as const;

/**
 * AccountDO migration v2: Add provider column to auth table.
 *
 * Supports multi-provider accounts (Google, Microsoft, CalDAV).
 * Defaults to 'google' for existing rows.
 */
export const ACCOUNT_DO_MIGRATION_V2 = `
ALTER TABLE auth ADD COLUMN provider TEXT NOT NULL DEFAULT 'google';
` as const;

/**
 * AccountDO migration v3: Microsoft subscription lifecycle table.
 *
 * Stores Microsoft Graph change notification subscriptions in the
 * per-account DO SQLite. Used for clientState validation and
 * subscription renewal/deletion.
 */
export const ACCOUNT_DO_MIGRATION_V3 = `
CREATE TABLE ms_subscriptions (
  subscription_id TEXT PRIMARY KEY,
  resource        TEXT NOT NULL,
  client_state    TEXT NOT NULL,
  expiration      TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
` as const;

/**
 * AccountDO migration v4: Encryption failure monitoring table.
 *
 * Tracks encryption/decryption failures for operational monitoring.
 * Any failure count > 0 is critical and indicates key corruption,
 * rotation issues, or data integrity problems.
 */
export const ACCOUNT_DO_MIGRATION_V4 = `
CREATE TABLE encryption_monitor (
  account_id         TEXT PRIMARY KEY,
  failure_count      INTEGER NOT NULL DEFAULT 0,
  last_failure_ts    TEXT,
  last_failure_error TEXT,
  last_success_ts    TEXT
);
` as const;

/** Ordered migrations for AccountDO. Apply sequentially. */
export const ACCOUNT_DO_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: ACCOUNT_DO_MIGRATION_V1,
    description: "Initial AccountDO schema: auth, sync_state, watch_channels",
  },
  {
    version: 2,
    sql: ACCOUNT_DO_MIGRATION_V2,
    description: "Add provider column to auth table for multi-provider support",
  },
  {
    version: 3,
    sql: ACCOUNT_DO_MIGRATION_V3,
    description: "Microsoft subscription lifecycle table for change notifications",
  },
  {
    version: 4,
    sql: ACCOUNT_DO_MIGRATION_V4,
    description: "Encryption failure monitoring table for operational alerting",
  },
] as const;

// ---------------------------------------------------------------------------
// Migration runner
// ---------------------------------------------------------------------------

/**
 * Apply pending migrations to a DO SqlStorage instance.
 *
 * On each DO wake-up, call this to ensure the schema is current:
 *
 * 1. Creates _schema_meta table if it doesn't exist
 * 2. Reads current schema version (0 if fresh)
 * 3. Applies all migrations with version > current, sequentially
 * 4. Updates the stored version after each successful migration
 *
 * The schemaName parameter allows different DOs to track their versions
 * independently (e.g. "user_graph" vs "account").
 *
 * IMPORTANT: Cloudflare DO SqlStorage exec() is synchronous and runs
 * within a single colocated SQLite instance. Each DO instance has its
 * own database, so there are no concurrency concerns between DOs.
 * Within a single DO, requests are serialized by the Durable Object
 * runtime, so concurrent migration attempts cannot happen.
 */
export function applyMigrations(
  sql: SqlStorageLike,
  migrations: readonly Migration[],
  schemaName: string,
): void {
  // Step 1: Ensure meta table exists
  sql.exec(
    "CREATE TABLE IF NOT EXISTS _schema_meta (key TEXT PRIMARY KEY, value TEXT)",
  );

  // Step 2: Read current version
  const metaKey = `${schemaName}_version`;
  const rows = sql
    .exec<{ value: string | null }>(
      "SELECT value FROM _schema_meta WHERE key = ?",
      metaKey,
    )
    .toArray();

  let currentVersion = 0;
  if (rows.length > 0 && rows[0].value !== null) {
    currentVersion = parseInt(rows[0].value, 10);
  }

  // Step 3: Apply pending migrations sequentially
  for (const migration of migrations) {
    if (migration.version <= currentVersion) {
      continue;
    }

    // Execute the migration SQL
    sql.exec(migration.sql);

    // Step 4: Update version after each successful migration.
    // Uses INSERT OR REPLACE (upsert) to handle both initial insert and
    // subsequent updates in a single statement.
    sql.exec(
      "INSERT OR REPLACE INTO _schema_meta (key, value) VALUES (?, ?)",
      metaKey,
      String(migration.version),
    );

    currentVersion = migration.version;
  }
}

/**
 * Read the current schema version for a given schema name.
 *
 * Returns 0 if the _schema_meta table doesn't exist or the version
 * hasn't been set. Useful for diagnostics and testing.
 */
export function getSchemaVersion(
  sql: SqlStorageLike,
  schemaName: string,
): number {
  try {
    const metaKey = `${schemaName}_version`;
    const rows = sql
      .exec<{ value: string | null }>(
        "SELECT value FROM _schema_meta WHERE key = ?",
        metaKey,
      )
      .toArray();

    if (rows.length > 0 && rows[0].value !== null) {
      return parseInt(rows[0].value, 10);
    }
    return 0;
  } catch {
    // _schema_meta table doesn't exist yet
    return 0;
  }
}
