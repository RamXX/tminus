# T-Minus Architecture

**Status:** Phase 1 (Foundation) -- Active Design
**Last Updated:** 2026-02-13
**Owner:** Architect

This is the single source of truth for all technical decisions in T-Minus.
All architecture documents are linked from this file.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Architecture Decision Records](#2-architecture-decision-records)
3. [Service Layout](#3-service-layout)
4. [Data Model](#4-data-model)
5. [Correctness Invariants](#5-correctness-invariants)
6. [Queue Message Contracts](#6-queue-message-contracts)
7. [Key Flows](#7-key-flows)
8. [Security Design](#8-security-design)
9. [Platform Limits](#9-platform-limits)
10. [Technology Choices](#10-technology-choices)
11. [Phase 1 Scope Boundary](#11-phase-1-scope-boundary)
12. [Open Questions](#12-open-questions)

---

## 1. System Overview

T-Minus is a Cloudflare-native platform that federates multiple Google Calendar
accounts into a single canonical event store, projects events outward via
configurable policies, and layers scheduling intelligence, relationship
awareness, and time governance on top.

The target user is anyone who operates across multiple organizations --
contractors, consultants, advisors, board members, VCs -- and needs their
calendars to be aware of each other without manual copy-paste.

### Core Product Model

T-Minus is a stateful calendar graph per user:

1. **Ingest** changes from external providers (Google Calendar first; Microsoft later).
2. **Maintain** a canonical "Unified Calendar" (source of truth).
3. **Project** canonical state out to multiple provider calendars using a policy compiler (busy/title/full, per direction).
4. **Support** planning features not native to Google Calendar: trips that block time across all accounts, override/exception events, constraint-based scheduling, multi-party coordination.
5. **Provide** an MCP server so AI assistants can do all of the above programmatically.

### Architectural Principle

Canonical-first, eventual projection. All mutations flow through the canonical
event store first, produce a journal entry, then project outward via queues.
The UI can show "projection status per account" (green/yellow/red).

### System Topology

```
                    +------------------+
                    |   Google APIs    |
                    | (Calendar, OAuth)|
                    +--------+---------+
                             |
              webhook push   |   OAuth + API calls
              (notifications)|   (sync, write, watch)
                             |
    +------------------------+------------------------+
    |                        |                        |
    v                        v                        v
+-----------+        +-----------+            +-----------+
| webhook   |        | oauth     |            | cron      |
| worker    |        | worker    |            | worker    |
+-----------+        +-----------+            +-----------+
    |                    |                        |
    | enqueue            | create account         | channel renewal
    | SYNC_INCREMENTAL   | + start onboarding     | token refresh
    v                    v                        | reconciliation
+-----------+     +-------------+                 v
| sync-queue|     | D1 Registry |         +--------------+
+-----------+     +-------------+         |reconcile-queue|
    |                                     +--------------+
    v
+-----------+
| sync      |-------> +----------------+
| consumer  |         | AccountDO      | (per external account)
+-----------+         | - tokens       |
    |                 | - sync cursor  |
    | applyDelta      | - watch channel|
    v                 +----------------+
+----------------+
| UserGraphDO    | (per user)
| - canonical    |
|   events       |
| - event mirrors|
| - event journal|
| - policies     |
+-------+--------+
        |
        | enqueue UPSERT_MIRROR / DELETE_MIRROR
        v
+------------+
| write-queue|
+------------+
        |
        v
+-----------+
| write     |-------> Google Calendar API
| consumer  |         (create/patch/delete mirrors)
+-----------+

+-----------+                    +-----------+
| api       |<--- UI / MCP ---->| mcp       |
| worker    |                   | worker    |
+-----------+                   +-----------+
    |                               |
    +----------- both call ---------+
                    |
                    v
             +----------------+
             | UserGraphDO    |
             +----------------+
```

### Cloudflare Building Blocks

| Building Block    | Role in T-Minus                                                  |
|-------------------|------------------------------------------------------------------|
| Workers           | Stateless edge APIs: auth, webhook, API, MCP, cron, consumers    |
| Durable Objects   | Stateful coordinators: UserGraphDO, AccountDO, GroupScheduleDO   |
| DO SQLite         | Per-user and per-account persistent storage (colocated compute)  |
| D1                | Cross-user registry (users, accounts, orgs, deletion certs)      |
| Queues            | Async pipelines: sync-queue, write-queue, reconcile-queue        |
| Workflows         | Long-running orchestration: onboarding, reconciliation, scheduling |
| R2                | Audit logs, commitment proof exports, debug traces               |

---

## 2. Architecture Decision Records

### ADR-1: DO SQLite as Primary Per-User Storage, Not D1

**Status:** Accepted
**Date:** 2026-02-13

**Context:**
The system needs to store per-user calendar data including canonical events,
mirrors, journal entries, policies, constraints, and relationship data. Two
Cloudflare storage options were evaluated: D1 (shared relational database) and
DO SQLite (per-Durable-Object colocated SQLite).

D1 is backed by a single Durable Object internally, is single-threaded, and
has a 10 GB total database limit that cannot be increased. Placing all users
into one D1 would create a bottleneck and a hard ceiling on total data.

**Decision:**
Each UserGraphDO stores all per-user data in its colocated SQLite database.
D1 is used ONLY for cross-user lookups (user registry, account routing,
org metadata, billing state, deletion certificates).

**Consequences:**
- (+) 10 GB per user, not per system. Natural tenant isolation.
- (+) Zero network hop on the hot path -- compute and storage colocated.
- (+) No cross-user contention. Each user's DO processes independently.
- (+) Single-threaded serialization within DO guarantees consistency per user.
- (-) Cross-user queries (e.g., "find all accounts for scheduling session")
  require D1 lookup first, then fan out to individual DOs.
- (-) No single SQL view across all users. Aggregation requires explicit
  fan-out patterns.
- (-) Schema migrations must be handled per-DO (on first access after deploy).

**D1 contains only:**
- `users`, `orgs`, `accounts` registry
- Cross-user scheduling session metadata
- Billing/subscription state
- Deletion certificates (GDPR/CCPA proof)

**DO SQLite contains (per user):**
- `canonical_events`, `event_mirrors`, `event_journal`
- `calendars`, `policies`, `policy_edges`, `constraints`
- `time_allocations`, `time_commitments`, `commitment_reports`
- `relationships`, `interaction_ledger`, `milestones`
- `vip_policies`, `excuse_profiles`
- `schedule_sessions`, `schedule_candidates`, `schedule_holds`

---

### ADR-2: AccountDO is Mandatory (Not Optional)

**Status:** Accepted
**Date:** 2026-02-13

**Context:**
Each connected external account (e.g., a Google Calendar account) needs token
management, sync cursor tracking, watch channel lifecycle, and rate limiting.
These operations require serialization -- concurrent token refreshes produce
races, concurrent `events.list(syncToken=...)` calls produce undefined behavior,
and Google Calendar API quotas are per-user-project.

The original dialog.txt marked AccountDO as "optional." PLAN.md elevated it to
mandatory after analysis.

**Decision:**
Each connected external account gets its own AccountDO instance.

**Consequences:**
- (+) Token refresh is serialized -- no race conditions between queue consumers.
- (+) Sync cursor management is serialized -- no undefined behavior from
  concurrent `events.list(syncToken=...)` calls.
- (+) Rate limiting is per-account, matching Google's quota model.
- (+) Watch channel lifecycle (create, renew, expire) is cleanly isolated.
- (+) Queue consumers call `AccountDO.getAccessToken()` JIT -- tokens never
  leave the DO boundary unnecessarily.
- (-) Additional DO class adds to operational surface area.
- (-) Cross-account operations require fan-out to multiple AccountDOs.

**AccountDO responsibilities:**
- Store and refresh OAuth tokens (encrypted via envelope encryption)
- Manage sync cursor (syncToken)
- Manage watch channel lifecycle (create, renew, expire)
- Provide `getAccessToken()` RPC for queue consumers
- Rate-limit outbound API calls per account

---

### ADR-3: No Z3 in MVP -- Greedy Scheduler First

**Status:** Accepted
**Date:** 2026-02-13

**Context:**
The product vision includes constraint-based scheduling using Z3 or similar
solver. However, Workers have a 128 MB memory limit and no threading support.
Z3 compiled to WASM is approximately 20-30 MB binary alone and uses parallel
solving internally.

**Decision:**
MVP uses a greedy interval scheduler. Z3/constraint solver is deferred to
Phase 4+. When needed, run it as an external service called from a Workflow step.

**Consequences:**
- (+) Stays within Workers memory and CPU constraints.
- (+) Greedy enumeration + scoring is sufficient for 2-5 accounts.
- (+) Simpler to implement, test, and debug.
- (-) Cannot solve complex multi-party optimization problems in Phase 1-3.
- (-) When Z3 is eventually needed, requires external service infrastructure
  (Cloudflare Containers, or external compute).

**Migration path:**
The SchedulingWorkflow abstraction (Phase 3) will call a "solve" step. In MVP,
that step runs greedy enumeration. When Z3 is needed, the step calls an external
solver service. The Workflow interface does not change.

---

### ADR-4: Busy Overlay Calendars by Default

**Status:** Accepted
**Date:** 2026-02-13

**Context:**
Two models exist for projecting events across accounts: true mirroring
(duplicate the full event) and busy overlay (create a "Busy" block in a
dedicated calendar). True mirroring requires more API writes, creates attendee
confusion, and mixes real events with projected ones.

**Decision:**
Mirror events into a dedicated "External Busy" calendar per account rather than
inserting into the primary calendar. True mirroring is available as an opt-in
policy upgrade via the `calendar_kind` field on `policy_edges`.

**Consequences:**
- (+) ~60-70% fewer API writes vs true mirroring, reducing quota consumption.
- (+) No attendee confusion -- projected events live in a separate calendar.
- (+) Cleaner UX -- users see real events + busy blocks, clearly separated.
- (+) Google Calendar natively respects busy blocks for free/busy queries.
- (-) Users cannot see event titles from other accounts by default (requires
  policy upgrade to TITLE or FULL detail level).
- (-) Requires creating and managing an extra calendar per account.

---

### ADR-5: Event-Sourcing via Append-Only Change Journal

**Status:** Accepted
**Date:** 2026-02-13

**Context:**
The system needs auditability for multiple reasons: GDPR/CCPA deletion proof,
commitment compliance verification, sync debugging, and the future "temporal
versioning" differentiator. A simple CRUD model loses history.

**Decision:**
All mutations to the canonical event store produce an append-only journal entry
in `event_journal` with `actor`, `change_type`, `patch_json`, and `reason`.

**Consequences:**
- (+) GDPR/CCPA: can prove what was deleted and when.
- (+) Commitment compliance: verifiable time digests for proof export.
- (+) Debugging: full history of "why did this event change?"
- (+) Foundation for "temporal versioning" (Phase 5 differentiator).
- (-) Storage grows monotonically. Requires periodic archival to R2.
- (-) Journal queries may be slow for users with very long histories.
  Mitigation: index on `canonical_event_id` and `ts`.

---

### ADR-6: Daily Drift Reconciliation, Not Weekly

**Status:** Accepted
**Date:** 2026-02-13

**Context:**
The original dialog proposed weekly reconciliation. Analysis of Google Calendar
push notification reliability revealed several failure modes:
- Channels can silently stop delivering notifications.
- Sync tokens can go stale (410 Gone).
- Duplicate and out-of-order notifications are common.
- There is no delivery guarantee from Google.

A "last successful sync" timestamp per account with alerting is required.

**Decision:**
Drift reconciliation runs daily via cron, not weekly.

**Consequences:**
- (+) Catches silent webhook failures within 24 hours instead of 7 days.
- (+) Catches stale sync tokens before user notices drift.
- (+) More frequent reconciliation reduces the blast radius of missed events.
- (-) More API quota consumption (one full sync per account per day).
  Mitigation: full sync uses `updatedMin` parameter to limit scope.
- (-) More queue traffic. Mitigation: reconcile-queue is separate from
  sync-queue to avoid contention.

---

## 3. Service Layout

### Monorepo Structure

```
tminus/
  packages/
    shared/                  # Shared types, schemas, constants
      src/
        types.ts             # Canonical event types, policy types, message shapes
        schema.ts            # DO SQLite schema definitions
        constants.ts         # Service name, extended property keys
        policy.ts            # Policy compiler (detail_level -> projected payload)
        hash.ts              # Stable hashing for projection comparison

  workers/
    api/                     # Public API (unified calendar, availability, policies)
      src/
        index.ts
        routes/
          events.ts          # CRUD canonical events
          availability.ts    # Unified free/busy across accounts
          policies.ts        # Policy CRUD
          accounts.ts        # Account management
          scheduling.ts      # Scheduling session management

    oauth/                   # OAuth flow handler
      src/
        index.ts             # /oauth/google/start, /oauth/google/callback

    webhook/                 # Google Calendar push notification receiver
      src/
        index.ts             # Validate headers, enqueue SYNC_INCREMENTAL

    sync-consumer/           # Queue consumer: provider -> canonical
      src/
        index.ts             # Pull incremental updates, call UserGraphDO

    write-consumer/          # Queue consumer: canonical -> provider
      src/
        index.ts             # Execute Calendar API writes with idempotency

    mcp/                     # MCP server endpoint (Phase 2)
      src/
        index.ts

    cron/                    # Scheduled maintenance
      src/
        index.ts             # Channel renewal, token refresh, drift reconciliation

  durable-objects/
    user-graph/              # UserGraphDO: per-user canonical state + coordination
      src/
        index.ts
        schema.sql           # DO SQLite schema
        sync.ts              # applyProviderDelta()
        projection.ts        # recomputeProjections()
        availability.ts      # computeAvailability()

    account/                 # AccountDO: per-external-account token + sync state
      src/
        index.ts
        token.ts             # Token encryption/refresh
        channel.ts           # Watch channel lifecycle

    group-schedule/          # GroupScheduleDO: multi-user scheduling (Phase 3+)
      src/
        index.ts

  workflows/
    onboarding/              # OnboardingWorkflow: initial full sync
      src/
        index.ts

    reconcile/               # ReconcileWorkflow: drift repair
      src/
        index.ts

    scheduling/              # SchedulingWorkflow (Phase 3+)
      src/
        index.ts
```

### Worker Responsibilities and Bindings

```
Worker              Bindings                                         Responsibility
-----------------   ------------------------------------------------ -------------------------------------------
api-worker          UserGraphDO, AccountDO, D1, sync-queue,          Public REST API for UI / external clients
                    write-queue

oauth-worker        UserGraphDO, AccountDO, D1                       OAuth initiation + callback, account linking

webhook-worker      sync-queue, D1                                   Receive Google push notifications, validate,
                                                                     enqueue sync jobs

sync-consumer       UserGraphDO, AccountDO, write-queue              Process sync-queue: fetch provider deltas,
                                                                     apply to UserGraphDO

write-consumer      AccountDO, D1                                    Process write-queue: execute Calendar API
                                                                     writes with idempotency

mcp-worker          UserGraphDO, AccountDO, SchedulingWorkflow       MCP tool server (Phase 2)

cron-worker         AccountDO, D1, reconcile-queue                   Channel renewal, token refresh,
                                                                     daily reconciliation dispatch
```

### Queue Topology

```
Queue               Producer(s)                    Consumer               Purpose
-----------------   ----------------------------   --------------------   ---------------------------
sync-queue          webhook-worker, cron-worker    sync-consumer          Provider -> canonical sync
write-queue         UserGraphDO (via sync/api)     write-consumer         Canonical -> provider writes
reconcile-queue     cron-worker                    ReconcileWorkflow      Daily drift repair
```

### Durable Object Classes

```
Class               Storage    ID Derivation              Responsibilities
-----------------   --------   -------------------------  ------------------------------------------
UserGraphDO         SQLite     idFromName(user_id)        Canonical event store, policy graph,
                                                          projections, journal, availability

AccountDO           SQLite     idFromName(account_id)     Token management, sync cursor, watch
                                                          channel lifecycle, rate limiting

GroupScheduleDO     SQLite     idFromName(session_id)     Multi-user scheduling sessions (Phase 3+)
```

### Workflow Definitions

```
Workflow               Trigger                        Steps
--------------------   ----------------------------   ----------------------------------
OnboardingWorkflow     oauth-worker (account link)    1. Fetch calendar list
                                                      2. Create busy overlay calendar
                                                      3. Paginated full event sync
                                                      4. Register watch channel
                                                      5. Store initial syncToken
                                                      6. Mark account active in D1

ReconcileWorkflow      reconcile-queue message        1. Full sync (no syncToken)
                                                      2. Cross-check mirrors vs provider
                                                      3. Fix missing/orphaned/drifted
                                                      4. Log discrepancies to journal

SchedulingWorkflow     api-worker / mcp-worker        1. Gather constraints
(Phase 3+)            (POST /v1/scheduling/sessions)  2. Gather availability
                                                      3. Run solver (greedy)
                                                      4. Produce candidates
                                                      5. Create tentative holds
                                                      6. On confirmation, commit events
```

---

## 4. Data Model

### 4.1 D1 Registry Schema (Cross-User Lookups Only)

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

### 4.2 DO SQLite Schema: UserGraphDO (Per-User)

All tables below exist inside each UserGraphDO instance. This is the canonical
data store for one user.

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

-- Append-only change journal (event-sourcing per ADR-5)
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

-- Time accounting (Phase 3)
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

-- Commitment tracking (Phase 3)
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

-- VIP policies (Phase 3)
CREATE TABLE vip_policies (
  vip_id              TEXT PRIMARY KEY,
  participant_hash    TEXT NOT NULL,  -- SHA-256(email + salt)
  display_name        TEXT,
  priority_weight     REAL NOT NULL DEFAULT 1.0,
  conditions_json     TEXT NOT NULL,
    -- { allow_after_hours, min_notice_hours, override_deep_work, ... }
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Relationship graph (Phase 4)
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

-- Interaction ledger for reputation + reciprocity (Phase 4)
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

-- Life event milestones (Phase 4)
CREATE TABLE milestones (
  milestone_id      TEXT PRIMARY KEY,
  participant_hash  TEXT,           -- null if personal
  kind              TEXT NOT NULL,  -- birthday | anniversary | graduation | funding | relocation
  date              TEXT NOT NULL,
  recurs_annually   INTEGER NOT NULL DEFAULT 0,
  note              TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Scheduling sessions (Phase 3+)
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

### 4.3 DO SQLite Schema: AccountDO (Per-Account)

```sql
-- Token storage (encrypted via envelope encryption per ADR-2)
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

## 5. Correctness Invariants

These five invariants are non-negotiable. Violating any of them produces sync
loops, data corruption, or privacy breaches. Every code review must verify
these hold.

### Invariant A: Every Provider Event is Classified

When processing a provider event E, it is exactly one of:

- **origin**: user-authored in that provider, not managed by us
- **managed mirror**: created by us (tagged with extended properties)
- **foreign managed**: created by another system; treat as origin

Classification uses Google Calendar `extendedProperties.private`:

```json
{
  "extendedProperties": {
    "private": {
      "tminus": "true",
      "managed": "true",
      "canonical_event_id": "evt_...",
      "origin_account_id": "acc_..."
    }
  }
}
```

If `tminus == "true"` AND `managed == "true"`, the event is a managed mirror.
All other events are treated as origin events.

### Invariant B: Canonical Event ID is Stable

We generate `canonical_event_id` (ULID) at creation time. It never changes.
All mirrors reference it. The mapping is: one canonical -> N mirrors.

The ULID is generated once, stored in `canonical_events.canonical_event_id`,
and propagated to mirrors via `extendedProperties.private.canonical_event_id`.
No operation may change a canonical event's ID after initial creation.

### Invariant C: Projections are Deterministic

Given a canonical event + policy profile (A -> B) + target calendar kind,
the projected payload is always the same. We use stable hashing to determine
"do we need to PATCH?"

```
projected_hash = SHA-256(
  canonical_event_id +
  detail_level +
  calendar_kind +
  sorted(relevant_fields_by_detail_level)
)
```

If `projected_hash == event_mirrors.last_projected_hash`, skip the write.
This is the primary lever for both correctness and API quota conservation.

### Invariant D: Idempotency Everywhere

Every external write job includes:

- `idempotency_key`: `hash(canonical_event_id + target_account_id + projected_hash)`
- Expected state checks before mutation (existing `provider_event_id`, etc.)

Retries must not duplicate or thrash. The write-consumer checks current mirror
state before executing any Calendar API call.

### Invariant E: Managed Events are Never Treated as Origin

If a webhook fires for an event with `tminus_managed = "true"`, we do NOT
propagate it as a new origin change. We only check if it drifted from our
expected state and correct if needed.

This invariant prevents sync loops. Without it, a mirror update in Account B
would trigger a webhook, which would be treated as a new origin event, which
would project back to Account A, creating an infinite cycle.

---

## 6. Queue Message Contracts

All message types are defined in `packages/shared/src/types.ts`.

### 6.1 sync-queue Messages

```typescript
/**
 * Triggered by webhook-worker when Google push notification arrives.
 * Consumer: sync-consumer
 */
type SyncIncrementalMessage = {
  type: 'SYNC_INCREMENTAL';
  account_id: string;       // ULID of the external account
  channel_id: string;       // Watch channel UUID
  resource_id: string;      // Google resource ID
  ping_ts: string;          // ISO 8601 timestamp of notification
};

/**
 * Triggered by cron-worker (reconciliation) or sync-consumer (on 410 Gone).
 * Consumer: sync-consumer
 */
type SyncFullMessage = {
  type: 'SYNC_FULL';
  account_id: string;       // ULID of the external account
  reason: 'onboarding' | 'reconcile' | 'token_410';
};

type SyncQueueMessage = SyncIncrementalMessage | SyncFullMessage;
```

### 6.2 write-queue Messages

```typescript
/**
 * Projected event payload after policy compilation.
 * Contains only the fields appropriate for the detail_level.
 */
type ProjectedEvent = {
  summary: string;          // "Busy" for BUSY level, actual title for TITLE/FULL
  description?: string;     // Only for FULL level
  location?: string;        // Only for FULL level
  start: { dateTime: string; timeZone?: string } | { date: string };
  end: { dateTime: string; timeZone?: string } | { date: string };
  transparency: 'opaque' | 'transparent';
  extendedProperties: {
    private: {
      tminus: 'true';
      managed: 'true';
      canonical_event_id: string;
      origin_account_id: string;
    };
  };
};

/**
 * Create or update a mirror event in the target account.
 * Consumer: write-consumer
 */
type UpsertMirrorMessage = {
  type: 'UPSERT_MIRROR';
  canonical_event_id: string;
  target_account_id: string;
  target_calendar_id: string;
  projected_payload: ProjectedEvent;
  idempotency_key: string;   // hash(canonical_event_id + target + projected_hash)
};

/**
 * Delete a mirror event from the target account.
 * Consumer: write-consumer
 */
type DeleteMirrorMessage = {
  type: 'DELETE_MIRROR';
  canonical_event_id: string;
  target_account_id: string;
  provider_event_id: string;  // The Google event ID to delete
  idempotency_key: string;
};

type WriteQueueMessage = UpsertMirrorMessage | DeleteMirrorMessage;
```

### 6.3 reconcile-queue Messages

```typescript
/**
 * Dispatched by cron-worker for daily drift reconciliation.
 * Consumer: ReconcileWorkflow
 */
type ReconcileAccountMessage = {
  type: 'RECONCILE_ACCOUNT';
  account_id: string;
  user_id: string;
  triggered_at: string;       // ISO 8601
};
```

### Message Size Budget

All messages must stay under the 128 KB queue message limit. The projected
payload is the largest component. For BUSY-level projections, messages are
typically under 1 KB. For FULL-level projections with long descriptions,
messages could approach 10-20 KB. No message should ever approach the limit
under normal operation.

If a message would exceed the limit (e.g., extremely long event description),
truncate the description and log a warning. The canonical store retains the
full data.

---

## 7. Key Flows

### 7.1 Flow A: Webhook Sync (Event Created in Google Account A)

```
Step  Actor              Action
----  -----------------  --------------------------------------------------
1     Google             Sends push notification to webhook-worker

2     webhook-worker     Validates X-Goog-Channel-Token against D1
                         accounts.channel_id
                         Validates X-Goog-Resource-State is known value
                         Enqueues: SYNC_INCREMENTAL {
                           account_id, channel_id, resource_id, ping_ts
                         }
                         Returns 200 immediately (webhook must respond fast)

3     sync-consumer      Pulls message from sync-queue
                         Calls AccountDO.getAccessToken(account_id)
                         Calls AccountDO.getSyncToken(account_id)
                         Fetches events.list(syncToken=...)
                         On 410 Gone: enqueues SYNC_FULL, stops
                         For each returned event:
                           Classifies: origin vs managed
                             (check extendedProperties.private.tminus)
                           If managed: check for drift from expected state,
                             correct if needed (Invariant E), stop
                           If origin: normalize to ProviderDelta shape

4     sync-consumer      Calls UserGraphDO.applyProviderDelta(
                           account_id, deltas[]
                         )

5     UserGraphDO        For each delta (single-threaded, serialized):
      (serialized)         Upserts canonical_events (INSERT or UPDATE)
                           Bumps version if UPDATE
                           Writes event_journal entry {
                             actor: 'provider:acc_xxx',
                             change_type: 'created' | 'updated' | 'deleted'
                           }
                           For each policy_edge where
                             from_account == origin account:
                             Computes projected payload via policy compiler
                             Hashes projected payload (Invariant C)
                             Compares to event_mirrors.last_projected_hash
                             If different: enqueues UPSERT_MIRROR to
                               write-queue
                         Updates AccountDO sync cursor with new syncToken

6     write-consumer     Pulls UPSERT_MIRROR from write-queue
                         Calls AccountDO.getAccessToken(target_account_id)
                         Checks event_mirrors for existing provider_event_id:
                           If exists: PATCH event (with If-Match if available)
                           If not: INSERT into busy overlay calendar
                         Updates event_mirrors with:
                           provider_event_id, last_projected_hash,
                           last_write_ts, state='ACTIVE'
```

### 7.2 Flow B: User Creates Event in UI/MCP

```
Step  Actor              Action
----  -----------------  --------------------------------------------------
1     UI or MCP client   POST /v1/events to api-worker
                         Includes: title, start, end, accounts, etc.

2     api-worker         Authenticates user
                         Calls UserGraphDO.upsertCanonicalEvent(
                           event, source='ui' | 'mcp'
                         )

3     UserGraphDO        INSERTs canonical_events with
      (serialized)         origin_account_id = 'internal'
                           origin_event_id = new ULID
                         Writes event_journal {
                           actor: 'ui' | 'mcp', change_type: 'created'
                         }
                         For each policy_edge from 'internal' to each account:
                           Computes projection
                           Enqueues UPSERT_MIRROR to write-queue

4     write-consumer     Same as Flow A step 6
```

### 7.3 Flow C: Onboarding (New Account Connected)

```
Step  Actor              Action
----  -----------------  --------------------------------------------------
1     User               Initiates OAuth in UI
                         oauth-worker redirects to Google

2     Google             User authorizes, redirects back with auth code

3     oauth-worker       Exchanges code for tokens
                         Creates account row in D1 registry
                         Creates AccountDO with encrypted tokens
                         Starts OnboardingWorkflow(account_id, user_id)

4     OnboardingWorkflow Step 1: Fetch calendar list from Google
                                 Identify primary calendar
                                 Create "External Busy" overlay calendar

                         Step 2: Paginated events.list (no syncToken)
                                 For each page:
                                   Classify events
                                   Call UserGraphDO.applyProviderDelta(batch)

                         Step 3: Register watch channel with Google
                                 Store channel_id + expiry in AccountDO
                                 Store channel_id in D1 accounts row

                         Step 4: Store initial syncToken in AccountDO

                         Step 5: Mark account status='active' in D1

5     UserGraphDO        Processes deltas from step 2 same as Flow A
                         Enqueues initial mirror writes for all existing
                         canonical events -> new account per policy
```

### 7.4 Flow D: Daily Drift Reconciliation

```
Step  Actor              Action
----  -----------------  --------------------------------------------------
1     cron-worker        Runs on daily schedule
                         Queries D1: all accounts where status='active'
                         For each account:
                           Enqueues RECONCILE_ACCOUNT {
                             account_id, user_id, triggered_at
                           } to reconcile-queue

2     ReconcileWorkflow  Step 1: Full sync (no syncToken)
                                 Fetch all events from provider
                                 Same classification as incremental

                         Step 2: Cross-check:
                           a) For each origin event in provider:
                              Verify canonical_events has matching row
                              Verify mirrors exist per policy_edges
                           b) For each managed mirror in provider:
                              Verify event_mirrors has matching row
                              Verify projected_hash matches expected
                           c) For each event_mirror with state='ACTIVE':
                              Verify provider still has the event

                         Step 3: Fix discrepancies:
                           - Missing canonical: create it
                           - Missing mirror: enqueue UPSERT_MIRROR
                           - Orphaned mirror: enqueue DELETE_MIRROR
                           - Hash mismatch: enqueue UPSERT_MIRROR
                           - Stale mirror (no provider event): tombstone

                         Step 4: Log all discrepancies to event_journal
                                 Update AccountDO.last_success_ts
                                 Store new syncToken
```

---

## 8. Security Design

### 8.1 Token Encryption (Envelope Encryption)

```
Master Key
  |
  | (stored in Cloudflare Secret, per environment)
  |
  v
Per-Account DEK (Data Encryption Key)
  |
  | (generated at account creation, unique per AccountDO)
  | (DEK encrypted with master key, stored in AccountDO SQLite)
  |
  v
OAuth Tokens
  (encrypted with DEK using AES-256-GCM)
  (stored in AccountDO auth table as encrypted_tokens)
```

- Master key: stored as Cloudflare Secret (`MASTER_KEY`), rotatable per env.
- Per-account DEK: generated via `crypto.subtle.generateKey()` at account
  creation. Encrypted with master key. Stored alongside tokens.
- Access tokens: minted JIT by `AccountDO.getAccessToken()`. The DO decrypts
  the DEK with the master key, decrypts tokens with the DEK, checks expiry,
  refreshes if needed, re-encrypts, and returns the access token.
- Refresh tokens: NEVER leave the AccountDO boundary. Queue consumers receive
  only short-lived access tokens.

### 8.2 Webhook Validation

All webhook requests from Google are validated before any processing:

1. Verify `X-Goog-Channel-Token` matches the token stored against the
   `channel_id` in D1 `accounts` table.
2. Verify `X-Goog-Resource-State` is a known value (`sync`, `exists`, `not_exists`).
3. Reject unknown `channel_id` / `resource_id` combinations.
4. Rate-limit webhook endpoint per source IP (Cloudflare Rate Limiting).
5. Return 200 immediately after enqueuing -- never block webhook response on
   downstream processing.

### 8.3 API Authentication

The API worker authenticates requests from the UI and MCP clients. The specific
mechanism is an open question (see Section 12), but the design requires:

- Short-lived session tokens or JWTs tied to user_id
- Token validation on every API request before touching DOs
- Scoped access: a user can only access their own UserGraphDO
- MCP endpoint uses the same auth layer with per-tool authorization

### 8.4 Privacy (GDPR / CCPA / CPRA)

**Data Minimization:**
- Participant identifiers stored as `SHA-256(email + per-org salt)`.
- Event content optionally encrypted at rest (user-controlled setting).
- Only data required for sync + policy is collected. No free-form attendee
  metadata unless explicitly needed.

**Right to Erasure (Full Deletion):**
- Executed via a deletion Workflow that cascades:
  1. Delete canonical events from UserGraphDO SQLite
  2. Delete event mirrors from UserGraphDO SQLite
  3. Delete journal entries from UserGraphDO SQLite
  4. Delete relationship/ledger/milestone data
  5. Delete D1 registry rows (users, accounts)
  6. Delete R2 audit objects
  7. Enqueue provider-side mirror deletions
  8. Generate signed deletion certificate

- No soft deletes. Tombstone structural references only (foreign key stubs
  with all PII removed).

**Deletion Certificates:**
- Stored in D1 `deletion_certificates` table.
- Contain: `entity_type`, `entity_id`, `deleted_at`, `proof_hash` (SHA-256
  of deleted data summary), `signature` (system key).
- Prove what was deleted and when, without retaining the deleted data.

### 8.5 Tenant Isolation

- Durable Object IDs derived deterministically from `user_id` (UserGraphDO)
  or `account_id` (AccountDO). A user cannot address another user's DO.
- D1 queries always filter by `user_id` / `org_id`.
- No shared mutable state between users except through explicit scheduling
  sessions (Phase 3+, mediated by GroupScheduleDO).

---

## 9. Platform Limits

All limits verified against Cloudflare documentation as of 2026-02-13.

### 9.1 Cloudflare Resource Limits

| Resource                        | Limit                             | T-Minus Impact                                     |
|---------------------------------|-----------------------------------|--------------------------------------------------|
| DO SQLite storage per object    | 10 GB (paid plan)                 | Primary per-user store. 10 GB per user is ample.   |
| DO SQLite storage per account   | Unlimited (paid plan)             | No ceiling on total users.                         |
| DO classes per account          | 500 (paid) / 100 (free)          | We need 3 classes (Phase 1-2), 4 max. Well within. |
| DO throughput per instance      | ~1,000 req/s (soft limit)         | Sufficient for single-user operations.             |
| DO CPU per invocation           | 30s default, 5 min configurable   | Configure to 300,000ms for sync operations.        |
| DO SQLite max row/string size   | 2 MB                              | Event data well within. Journal patches could grow. |
| DO SQLite max columns per table | 100                               | Our widest table has ~20 columns.                  |
| Worker memory                   | 128 MB                            | Prevents Z3 WASM in-process (ADR-3).               |
| Worker CPU per request          | 30s default, 5 min configurable   | Configure consumers for longer processing.         |
| Worker size (compressed)        | 10 MB (paid plan)                 | Monitor bundle size with shared package.            |
| Worker subrequests              | 10,000 default, up to 10M         | Sufficient for sync operations.                    |
| Queue message size              | 128 KB                            | Projected payloads must stay compact.              |
| Queue throughput per queue      | 5,000 msg/s                       | More than sufficient for our scale.                |
| Queue max consumer concurrency  | 250                               | Auto-scales. Configurable via max_concurrency.     |
| Queue max batch size            | 100 messages                      | Configure per consumer based on workload.          |
| Queue consumer wall clock       | 15 minutes                        | Sufficient for batch processing.                   |
| Queue max retries               | 100                               | Configure DLQ for persistent failures.             |
| Queues per account              | 10,000                            | We need 3 queues. Plenty of room.                  |
| D1 database size                | 10 GB (cannot increase)           | Registry only. Will not approach this limit.       |
| D1 databases per account        | 50,000                            | One registry DB is sufficient.                     |
| Workflow concurrent instances   | 10,000 (paid, as of Oct 2025)     | Sufficient for onboarding + reconciliation.        |
| Workflow steps per instance     | 1,024 (sleep steps excluded)      | Sufficient for all workflow definitions.           |
| Workflow step timeout           | 30 minutes max recommended        | Use waitForEvent for longer waits.                 |
| Workflow step return size       | 1 MiB                             | Store large results in R2, return reference.       |
| Workflow creation rate          | 100 instances/second              | Sufficient for daily reconciliation dispatch.      |
| R2 object size                  | 5 GB (multipart)                  | Audit logs, proof exports.                         |

### 9.2 How the Architecture Respects These Limits

**DO CPU:** Sync operations that process large batches of events configure
`limits.cpu_ms = 300000` (5 minutes). Normal operations complete in
milliseconds.

**Queue message size:** Projected payloads are kept compact by design (ADR-4:
busy overlay = minimal fields). FULL-level projections truncate descriptions
if approaching the limit.

**Worker memory:** Z3 is excluded from in-process execution (ADR-3). All
Workers stay well under 128 MB.

**D1 size:** Only registry data lives in D1. Per-user data lives in DO SQLite.
Even with 100,000 users, registry data would be a few hundred MB.

**Workflow concurrency:** Daily reconciliation dispatches one workflow per
active account. With 10,000 concurrent instance limit, this supports up to
10,000 accounts reconciling simultaneously.

---

## 10. Technology Choices

### 10.1 Language and Runtime

- **TypeScript** for all Workers, Durable Objects, and Workflows.
- **Cloudflare Workers runtime** (V8 isolates). No Node.js APIs unless
  polyfilled by the runtime.
- Target **ES2022** for modern language features.

### 10.2 Monorepo Structure

The project uses a monorepo with shared packages. The specific monorepo tooling
is an open question (Section 12.1), but the structure supports:

- Shared types and schemas in `packages/shared/`
- Independent Worker deployments from `workers/*/`
- Durable Object classes in `durable-objects/*/`
- Workflow definitions in `workflows/*/`

### 10.3 ID Generation

- **ULID** (Universally Unique Lexicographically Sortable Identifier) for all
  primary keys: `canonical_event_id`, `journal_id`, `policy_id`, etc.
- ULIDs are time-ordered, which benefits index performance and provides
  implicit creation timestamps.
- UUIDs (v4) for watch channel IDs (Google convention).

### 10.4 Schema Migrations

DO SQLite schemas are applied on first access after deployment. Each DO
maintains a `schema_version` value and runs migrations forward on wake-up.
This is necessary because DOs cannot be migrated in bulk -- they wake lazily.

D1 migrations use standard SQL migration files applied via `wrangler d1
migrations apply`.

### 10.5 Deployment

- **Wrangler** for all deployments: Workers, DOs, D1, Queues, Workflows.
- Each Worker has its own `wrangler.toml` (or `wrangler.jsonc`) with bindings.
- The specific deployment pipeline (per-worker vs unified) is an open question
  (Section 12.3).

### 10.6 Testing Strategy

Testing is organized into three tiers:

1. **Unit tests:** Pure functions (policy compiler, stable hashing, event
   classification, normalization). No Cloudflare runtime needed. Run with
   Vitest.

2. **Integration tests (Cloudflare):** Test DO logic, queue flows, and Worker
   handlers using `@cloudflare/vitest-pool-workers`. This provides a local
   Cloudflare runtime with real DO SQLite, real queues, and real D1. Workflows
   can be tested using the `introspectWorkflowInstance` API.

3. **Integration tests (Google API):** Test against real Google Calendar API
   using a dedicated service account with test calendars. This is the hardest
   tier and carries the highest risk (see Section 12.2).

All tests follow hard TDD: red/green/refactor cycle. 100% coverage for unit
tests. Integration tests cover all flows described in Section 7.

### 10.7 Error Handling

- **Dead Letter Queues (DLQ):** Both sync-queue and write-queue configure a
  DLQ. Messages that fail after max_retries are moved to the DLQ for manual
  inspection.
- **Error states in mirrors:** `event_mirrors.state = 'ERROR'` with
  `error_message` captures persistent write failures.
- **Sync state tracking:** `AccountDO.sync_state.last_success_ts` enables
  alerting on stale accounts (see ADR-6).

---

## 11. Phase 1 Scope Boundary

### 11.1 What Phase 1 Builds

Phase 1 goal: Two+ Google accounts synced bidirectionally with busy overlay.

| Component                | Deliverable                                               |
|--------------------------|-----------------------------------------------------------|
| Project scaffolding      | Monorepo, wrangler configs, shared package                |
| D1 registry              | Schema + migrations for orgs, users, accounts, deletion_certs |
| oauth-worker             | Google PKCE flow, token exchange, account creation        |
| AccountDO                | Token storage, refresh, sync cursor, watch channels       |
| UserGraphDO              | canonical_events, event_mirrors, event_journal, policies, policy_edges, calendars, constraints |
| webhook-worker           | Header validation, channel token check, enqueue           |
| sync-consumer            | Incremental + full sync, event classification, normalization |
| write-consumer           | Create/patch/delete mirrors, idempotency checks           |
| Policy compiler          | BUSY, TITLE, FULL projection logic + stable hashing       |
| Busy overlay             | Auto-creation of "External Busy" calendar per account     |
| cron-worker              | Channel renewal, token refresh, daily reconciliation dispatch |
| OnboardingWorkflow       | Full initial sync (paginated), watch registration         |
| ReconcileWorkflow        | Daily drift repair                                        |
| Loop prevention          | Extended properties tagging + classification (Invariant A, E) |
| Integration tests        | Against Google Calendar API sandbox (real test accounts)   |

### 11.2 What Phase 1 Does NOT Build

| Deferred Component       | Phase | Interface Point for Later                        |
|--------------------------|-------|--------------------------------------------------|
| Web calendar UI          | 2     | api-worker REST endpoints ready for UI consumption |
| MCP server               | 2     | UserGraphDO RPC surface matches MCP tool surface  |
| Trip/constraint system   | 2     | `constraints` table schema in place, no UI/MCP    |
| Policy management UI     | 2     | `policies` + `policy_edges` CRUD via api-worker   |
| Sync status dashboard    | 2     | AccountDO exposes sync health via RPC             |
| Error recovery UI        | 2     | DLQ exists, manual retry via wrangler CLI         |
| Greedy scheduler         | 3     | SchedulingWorkflow interface defined, not implemented |
| VIP policy engine        | 3     | `vip_policies` table schema in place              |
| Billable time tagging    | 3     | `time_allocations` table schema in place          |
| Commitment tracking      | 3     | `time_commitments` + `commitment_reports` schemas in place |
| Relationship graph       | 4     | `relationships`, `interaction_ledger`, `milestones` schemas in place |
| Social drift detection   | 4     | Data model ready, compute logic deferred          |
| Excuse generator         | 4     | No schema needed, pure function over existing data |
| GroupScheduleDO          | 3+    | DO class declared, not implemented                |
| Z3 constraint solver     | 4+    | SchedulingWorkflow step is pluggable              |
| Microsoft Calendar       | 5     | Provider abstraction in sync-consumer allows adding providers |
| iOS app                  | 5     | api-worker serves as backend                      |

### 11.3 Phase 1 Schema Strategy

All DO SQLite tables from Section 4.2 are created in Phase 1, even those not
populated until later phases. This ensures:

1. Schema is stable from day one -- no disruptive migrations later.
2. Phase 2+ features can be built incrementally without schema changes.
3. Tables that are not yet populated cost essentially nothing (empty table
   overhead is a few KB).

The exception is tables for Phase 3+ features (schedule_sessions,
schedule_candidates, schedule_holds) which may evolve. These can be created
in Phase 3 since no Phase 1-2 code depends on them.

### 11.4 Phase 1 Key Risk

Google Calendar API sandbox/test environment is limited. There is no true
"sandbox mode" for Google Calendar. Integration testing requires real accounts
with real calendars. This must be set up early in Phase 1 to avoid late
surprises.

---

## 12. Open Questions

These must be resolved during Phase 1 implementation. Each has a recommended
direction and the factors that should drive the final decision.

### 12.1 Monorepo Tooling

**Question:** Turborepo? Nx? Plain npm/pnpm workspaces?

**Factors:**
- We need: shared package builds, per-worker deploy commands, fast iteration.
- We do NOT need: complex caching, distributed execution, or monorepo-scale
  tooling for 10+ packages.
- Wrangler handles actual deployment; we only need the build orchestration.

**Recommendation:** Start with plain pnpm workspaces. Add Turborepo only if
build times become painful. Avoid Nx (too heavy for this project size).

### 12.2 Testing Against Google Calendar API

**Question:** How to test against Google Calendar API? Service account with
test calendars? Mock layer?

**Factors:**
- Google does not offer a Calendar API sandbox.
- Service accounts can own calendars but cannot simulate OAuth user flows.
- Mocking the Google API risks divergence from real behavior.
- Real accounts are needed for end-to-end webhook + sync testing.

**Recommendation:** Use a dedicated Google Workspace test account (or personal
account) with test calendars. Build a thin abstraction layer over the Google
API client so unit tests can use an in-memory mock, while integration tests
hit the real API. Accept that integration tests are slow and flaky; run them
separately from unit tests.

### 12.3 Deployment Pipeline

**Question:** Wrangler deploy per-worker, or unified deploy script?

**Factors:**
- Workers share DO bindings -- deploying one without the other can break
  routing if DO class definitions change.
- D1 migrations must run before Workers that depend on new schema.
- Queue consumer registration must happen alongside queue creation.

**Recommendation:** Unified deploy script (Makefile target) that runs in
order: D1 migrations -> DO classes -> Workers -> Queue consumers. Per-worker
deploy for development iteration.

### 12.4 API Authentication

**Question:** Session tokens? JWT? Cloudflare Access?

**Factors:**
- Cloudflare Access provides zero-trust auth but adds dependency and cost.
- JWTs are stateless but require a signing key and revocation strategy.
- Session tokens stored in KV provide simple revocation but add a lookup per
  request.
- MCP endpoint needs the same auth mechanism.

**Recommendation:** Start with JWT (signed with a Cloudflare Secret) for
stateless auth. Add refresh token rotation for session management. Evaluate
Cloudflare Access if the product goes multi-tenant (Phase 5).

### 12.5 UI Framework (Phase 2)

**Question:** React? Solid? What calendar component library?

**Factors:**
- Calendar UI needs rich interaction: drag, resize, multi-day views.
- Component library maturity matters -- calendar UIs are hard to build from
  scratch.
- Workers Static Assets serves the frontend. Bundle size matters.

**Recommendation:** Defer decision to Phase 2. Phase 1 has no UI. When Phase
2 starts, evaluate based on calendar component library availability. React has
the largest ecosystem (FullCalendar, react-big-calendar). Solid has better
performance but fewer calendar components.

### 12.6 Recurring Events

**Question:** How deep do we handle RRULE expansion? Mirror individual
instances or the recurrence pattern?

**Factors:**
- Google Calendar API returns recurring events as both a "master" event (with
  RRULE) and individual instances (expanded).
- Mirroring the RRULE pattern is simpler but loses per-instance modifications.
- Mirroring individual instances is correct but generates many more mirror
  events and API writes.
- Sync tokens return changed instances, not the master event.

**Recommendation:** Store the RRULE on the canonical event for reference.
Mirror individual instances (not the pattern) because Google's sync token
mechanism reports changes at the instance level. Accept the higher write
volume. The projection hash comparison (Invariant C) prevents unnecessary
writes for unchanged instances.

---

## Related Documents

| Document               | Path                          | Description                       |
|------------------------|-------------------------------|-----------------------------------|
| Full Design Plan       | `/PLAN.md`                    | Original architecture + phase plan |
| Design Dialog          | `/dialog.txt`                 | Design conversation (ChatGPT)     |

---

## Revision History

| Date       | Change                                  | Author    |
|------------|-----------------------------------------|-----------|
| 2026-02-13 | Initial creation from PLAN.md + dialog  | Architect |
