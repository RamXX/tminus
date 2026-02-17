# Data Model

This document defines the complete data model for T-Minus, split across D1 (cross-user registry) and DO SQLite (per-user and per-account storage).

---

## D1 Registry Schema (Cross-User Lookups Only)

This is the shared database. It handles routing, identity, and compliance --
nothing on the hot sync path.

```sql
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
```

---

## DO SQLite Schema: UserGraphDO (Per-User)

All tables below exist inside each UserGraphDO instance. This is the canonical
data store for one user.

### Core Tables (Phase 1)

```sql
-- Calendars linked to this user's accounts
CREATE TABLE calendars (
  calendar_id          TEXT PRIMARY KEY,
  account_id           TEXT NOT NULL,
  provider_calendar_id TEXT NOT NULL,
  role                 TEXT NOT NULL DEFAULT 'primary',
  kind                 TEXT NOT NULL DEFAULT 'PRIMARY',
    -- PRIMARY | BUSY_OVERLAY | PROJECTED | READONLY
  display_name         TEXT,
  UNIQUE(account_id, provider_calendar_id)
);

-- Canonical events (the single source of truth)
CREATE TABLE canonical_events (
  canonical_event_id   TEXT PRIMARY KEY,  -- ULID
  origin_account_id    TEXT NOT NULL,     -- account_id or 'internal'
  origin_event_id      TEXT NOT NULL,     -- provider event ID or ULID for internal
  title                TEXT,
  description          TEXT,
  location             TEXT,
  start_ts             TEXT NOT NULL,     -- ISO 8601
  end_ts               TEXT NOT NULL,
  timezone             TEXT,
  all_day              INTEGER NOT NULL DEFAULT 0,
  status               TEXT NOT NULL DEFAULT 'confirmed',
    -- confirmed | tentative | cancelled
  visibility           TEXT NOT NULL DEFAULT 'default',
  transparency         TEXT NOT NULL DEFAULT 'opaque',
  recurrence_rule      TEXT,              -- RRULE string
  source               TEXT NOT NULL,     -- 'provider' | 'ui' | 'mcp' | 'system'
  version              INTEGER NOT NULL DEFAULT 1,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(origin_account_id, origin_event_id)
);

CREATE INDEX idx_events_time ON canonical_events(start_ts, end_ts);
CREATE INDEX idx_events_origin ON canonical_events(origin_account_id);

-- Mirror mapping: canonical -> provider mirrors
CREATE TABLE event_mirrors (
  canonical_event_id    TEXT NOT NULL
    REFERENCES canonical_events(canonical_event_id),
  target_account_id     TEXT NOT NULL,
  target_calendar_id    TEXT NOT NULL,
  provider_event_id     TEXT,            -- null until created
  last_projected_hash   TEXT,
  last_write_ts         TEXT,
  state                 TEXT NOT NULL DEFAULT 'PENDING',
    -- PENDING | ACTIVE | DELETED | TOMBSTONED | ERROR
  error_message         TEXT,
  PRIMARY KEY (canonical_event_id, target_account_id)
);

-- Append-only change journal (event-sourcing per ADR-005)
CREATE TABLE event_journal (
  journal_id           TEXT PRIMARY KEY,  -- ULID
  canonical_event_id   TEXT NOT NULL,
  ts                   TEXT NOT NULL DEFAULT (datetime('now')),
  actor                TEXT NOT NULL,
    -- 'provider:acc_xxx' | 'ui' | 'mcp' | 'system'
  change_type          TEXT NOT NULL,
    -- 'created' | 'updated' | 'deleted' | 'mirrored'
  patch_json           TEXT,              -- JSON patch of what changed
  reason               TEXT               -- human-readable reason
);

CREATE INDEX idx_journal_event ON event_journal(canonical_event_id);
CREATE INDEX idx_journal_ts ON event_journal(ts);

-- Policy graph: how events project between accounts
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
    -- BUSY | TITLE | FULL
  calendar_kind    TEXT NOT NULL DEFAULT 'BUSY_OVERLAY',
    -- BUSY_OVERLAY | TRUE_MIRROR
  PRIMARY KEY (policy_id, from_account_id, to_account_id)
);

-- Constraints: trips, working hours, overrides
CREATE TABLE constraints (
  constraint_id    TEXT PRIMARY KEY,
  kind             TEXT NOT NULL,
    -- 'trip' | 'working_hours' | 'no_meetings_after' | 'override'
  config_json      TEXT NOT NULL,        -- kind-specific JSON
  active_from      TEXT,
  active_to        TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### Time Governance Tables (Phase 3)

```sql
-- Time accounting
CREATE TABLE time_allocations (
  allocation_id       TEXT PRIMARY KEY,
  canonical_event_id  TEXT NOT NULL
    REFERENCES canonical_events(canonical_event_id),
  client_id           TEXT,
  billing_category    TEXT NOT NULL DEFAULT 'NON_BILLABLE',
    -- BILLABLE | NON_BILLABLE | STRATEGIC | INVESTOR | INTERNAL
  rate                REAL,
  confidence          TEXT NOT NULL DEFAULT 'manual',
    -- manual | inferred
  locked              INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Commitment tracking
CREATE TABLE time_commitments (
  commitment_id        TEXT PRIMARY KEY,
  client_id            TEXT NOT NULL,
  client_name          TEXT,
  window_type          TEXT NOT NULL DEFAULT 'WEEKLY',
    -- WEEKLY | MONTHLY
  target_hours         REAL NOT NULL,
  rolling_window_weeks INTEGER NOT NULL DEFAULT 4,
  hard_minimum         INTEGER NOT NULL DEFAULT 0,
  proof_required       INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE commitment_reports (
  report_id        TEXT PRIMARY KEY,
  commitment_id    TEXT NOT NULL
    REFERENCES time_commitments(commitment_id),
  window_start     TEXT NOT NULL,
  window_end       TEXT NOT NULL,
  actual_hours     REAL NOT NULL,
  expected_hours   REAL NOT NULL,
  status           TEXT NOT NULL,  -- compliant | under | over
  proof_hash       TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- VIP policies
CREATE TABLE vip_policies (
  vip_id              TEXT PRIMARY KEY,
  participant_hash    TEXT NOT NULL,  -- SHA-256(email + salt)
  display_name        TEXT,
  priority_weight     REAL NOT NULL DEFAULT 1.0,
  conditions_json     TEXT NOT NULL,
    -- { allow_after_hours, min_notice_hours, override_deep_work, ... }
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### Relationship Tables (Phase 4)

```sql
-- Relationship graph
CREATE TABLE relationships (
  relationship_id              TEXT PRIMARY KEY,
  participant_hash             TEXT NOT NULL UNIQUE,
  display_name                 TEXT,
  category                     TEXT NOT NULL DEFAULT 'OTHER',
    -- FAMILY | INVESTOR | FRIEND | CLIENT | BOARD | COLLEAGUE | OTHER
  closeness_weight             REAL NOT NULL DEFAULT 0.5,
  last_interaction_ts          TEXT,
  city                         TEXT,
  timezone                     TEXT,
  interaction_frequency_target INTEGER,  -- days between interactions
  created_at                   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Interaction ledger for reputation + reciprocity
CREATE TABLE interaction_ledger (
  ledger_id          TEXT PRIMARY KEY,
  participant_hash   TEXT NOT NULL,
  canonical_event_id TEXT,
  outcome            TEXT NOT NULL,
    -- ATTENDED | CANCELED_BY_ME | CANCELED_BY_THEM
    -- NO_SHOW_THEM | NO_SHOW_ME
    -- MOVED_LAST_MINUTE_THEM | MOVED_LAST_MINUTE_ME
  weight             REAL NOT NULL DEFAULT 1.0,
  note               TEXT,
  ts                 TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_ledger_participant ON interaction_ledger(participant_hash);

-- Life event milestones
CREATE TABLE milestones (
  milestone_id      TEXT PRIMARY KEY,
  participant_hash  TEXT,           -- null if personal
  kind              TEXT NOT NULL,  -- birthday | anniversary | graduation | funding | relocation
  date              TEXT NOT NULL,
  recurs_annually   INTEGER NOT NULL DEFAULT 0,
  note              TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### Scheduling Tables (Phase 3+)

```sql
-- Scheduling sessions
CREATE TABLE schedule_sessions (
  session_id       TEXT PRIMARY KEY,
  status           TEXT NOT NULL DEFAULT 'open',
    -- open | candidates_ready | confirmed | cancelled | expired
  objective_json   TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE schedule_candidates (
  candidate_id     TEXT PRIMARY KEY,
  session_id       TEXT NOT NULL
    REFERENCES schedule_sessions(session_id),
  start_ts         TEXT NOT NULL,
  end_ts           TEXT NOT NULL,
  score            REAL,
  explanation      TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE schedule_holds (
  hold_id          TEXT PRIMARY KEY,
  session_id       TEXT NOT NULL
    REFERENCES schedule_sessions(session_id),
  account_id       TEXT NOT NULL,
  provider_event_id TEXT,
  expires_at       TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'held'
    -- held | committed | released | expired
);
```

---

## DO SQLite Schema: AccountDO (Per-Account)

```sql
-- Token storage (encrypted via envelope encryption per ADR-002)
CREATE TABLE auth (
  account_id       TEXT PRIMARY KEY,
  encrypted_tokens TEXT NOT NULL,
    -- AES-256-GCM encrypted JSON { access, refresh, expiry }
  scopes           TEXT NOT NULL,
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Sync state
CREATE TABLE sync_state (
  account_id       TEXT PRIMARY KEY,
  sync_token       TEXT,           -- Google incremental sync token
  last_sync_ts     TEXT,
  last_success_ts  TEXT,
  full_sync_needed INTEGER NOT NULL DEFAULT 1,
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Watch channel state
CREATE TABLE watch_channels (
  channel_id       TEXT PRIMARY KEY,
  account_id       TEXT NOT NULL,
  resource_id      TEXT,
  expiry_ts        TEXT NOT NULL,
  calendar_id      TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'active',  -- active | expired | error
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
```

---

## Schema Strategy

All DO SQLite tables are created in Phase 1, even those not populated until
later phases. This ensures:

1. Schema is stable from day one -- no disruptive migrations later.
2. Phase 2+ features can be built incrementally without schema changes.
3. Tables that are not yet populated cost essentially nothing (empty table overhead is a few KB).
