# T-Minus: Temporal & Relational Intelligence Engine

## Project Summary

T-Minus is a Cloudflare-native platform that federates multiple Google Calendar
accounts into a single canonical event store, projects events outward via
configurable policies, and layers scheduling intelligence, relationship
awareness, and time governance on top.

The target user is anyone who operates across multiple organizations --
contractors, consultants, advisors, board members, VCs -- and needs their
calendars to be aware of each other without manual copy-paste.

The long-term vision extends beyond sync into temporal intelligence:
constraint-based scheduling, relationship drift detection, commitment
compliance, and an MCP interface for AI-native calendar control.

---

## Strategic Context

### Two complementary use cases drive the product

**Use Case A (founder's itch):** "I work across N companies. My calendars
don't know about each other. I get double-booked constantly."

This requires: calendar federation, canonical event store, policy-driven
mirroring, loop prevention, busy overlay projection.

**Use Case B (power user's itch):** "I can't keep track of where my friends
live, let alone sort out when we can grab coffee. Missing my niece's graduation
because I dropped a thread on travel dates is not the future we were promised."

This requires: relationship graph, social drift detection, geo-aware
reconnection suggestions, life event memory, travel-aware scheduling.

### The dependency relationship

Use Case B cannot exist without Use Case A. Relationship-aware temporal
coordination requires canonical multi-calendar state, trip/constraint
awareness, and a unified event history. The calendar federation layer IS the
infrastructure that makes relationship features possible.

**Strategy: build A first. B emerges as a feature layer on top of A.**

---

## Architecture Decisions (validated against Cloudflare platform limits)

### AD-1: DO SQLite as primary per-user storage, NOT D1

**Decision:** Each `UserGraphDO` stores all per-user data in its colocated
SQLite database. D1 is used only for cross-user lookups.

**Rationale:**
- D1 is single-threaded (backed by one DO internally), 10 GB max, cannot be
  increased. Putting all users in one D1 creates a bottleneck.
- DO SQLite gives 10 GB per user, zero network hop on the hot path, natural
  tenant isolation, no cross-user contention.
- Compute and storage are colocated in the DO -- sync processing reads/writes
  without leaving the object.

**D1 handles only:**
- `users`, `orgs`, `accounts` registry (lookup by email, OAuth routing)
- Cross-user scheduling session metadata
- Billing/subscription state

**DO SQLite handles (per user):**
- `canonical_events`, `event_mirrors`, `event_journal`
- `policies`, `policy_edges`, `constraints`
- `time_allocations`, `time_commitments`, `commitment_reports`
- `relationships`, `interaction_ledger`, `milestones`
- `vip_policies`, `excuse_profiles`
- `schedule_sessions`, `schedule_candidates`, `schedule_holds`

### AD-2: AccountDO is mandatory

**Decision:** Each connected external account (e.g., a Google Calendar account)
gets its own `AccountDO` instance.

**Rationale:**
- Token refresh must be serialized to prevent races between queue consumers.
- Sync cursor (`syncToken`) management must be serialized -- two concurrent
  `events.list(syncToken=...)` calls produce undefined behavior.
- Google Calendar API quotas are per-user-project. Per-account rate limiting
  is required.
- Watch channel lifecycle (create, renew, expire) is per-account state.

**AccountDO responsibilities:**
- Store and refresh OAuth tokens (encrypted)
- Manage sync cursor
- Manage watch channel lifecycle
- Provide `getAccessToken()` RPC for queue consumers
- Rate-limit outbound API calls per account

### AD-3: No Z3 in MVP -- greedy scheduler first

**Decision:** MVP uses a greedy interval scheduler. Z3/constraint solver is
deferred to Phase 4+.

**Rationale:**
- Workers have 128 MB memory limit. Z3 WASM is ~20-30 MB binary alone.
- No threading support in Workers (Z3 uses parallel solving).
- For 2-5 accounts, the constraint space is small enough for enumeration +
  scoring.
- When Z3 is needed, run it as an external service called from a Workflow step.

### AD-4: Busy overlay calendars by default

**Decision:** Mirror events into a dedicated "External Busy" calendar per
account rather than inserting into the primary calendar.

**Rationale:**
- ~60-70% fewer API writes vs true mirroring
- No attendee confusion
- Cleaner UX -- users see their real events + busy blocks, clearly separated
- True mirroring available as an opt-in policy upgrade

### AD-5: Event-sourcing via change journal

**Decision:** All mutations to the canonical event store produce an append-only
journal entry with actor, change_type, patch, and reason.

**Rationale:**
- Required for GDPR/CCPA deletion proof (you can prove what was deleted)
- Required for commitment compliance proof (verifiable time digests)
- Required for debugging sync issues ("why did this event change?")
- Required for the "temporal versioning" differentiator later

### AD-6: Webhook daily reconciliation, not weekly

**Decision:** Drift reconciliation runs daily, not weekly as originally proposed.

**Rationale:**
- Google Calendar push notifications are best-effort, not guaranteed
- Channels can silently stop delivering
- Sync tokens can go stale (410 Gone)
- Duplicate/out-of-order notifications are common
- A "last successful sync" timestamp per account with alerting is required

---

## Correctness Invariants (non-negotiable)

These must hold at all times. Violating any of them produces sync loops,
data corruption, or privacy breaches.

### Invariant A: Every provider event is classified

When processing a provider event E, it is exactly one of:
- **origin**: user-authored in that provider, not managed by us
- **managed mirror**: created by us (has `extendedProperties.private.tminus_managed = "true"`)
- **foreign managed**: created by another system; treat as origin

Classification uses `extendedProperties.private`:
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

### Invariant B: Canonical event ID is stable

We generate `canonical_event_id` (ULID) at creation time. It never changes.
All mirrors reference it. The mapping is: one canonical -> N mirrors.

### Invariant C: Projections are deterministic

Given: canonical event + policy profile (A->B) + target calendar kind,
the projected payload is always the same. We use stable hashing to determine
"do we need to PATCH?" -- if the projected hash matches `last_projected_hash`
in the mirror mapping, skip the write.

### Invariant D: Idempotency everywhere

Every external write job includes:
- `idempotency_key`: hash(canonical_event_id + target_account + projected_hash)
- Expected state checks before mutation

Retries must not duplicate or thrash.

### Invariant E: Managed events are never treated as origin

If a webhook fires for an event with `tminus_managed = "true"`, we do NOT
propagate it as a new origin change. We only check if it drifted from our
expected state and correct if needed.

---

## Cloudflare Platform Limits Reference

| Resource | Limit | Notes |
|----------|-------|-------|
| DO SQLite storage | 10 GB per object | Primary per-user store |
| DO CPU | 30s default, 5 min configurable | `limits.cpu_ms = 300000` |
| DO throughput | ~1,000 req/s per instance | Soft limit, sufficient |
| DO classes/account | 500 (paid) | We need ~4 classes |
| Queue message size | 128 KB | Keep projected payloads compact |
| Queue throughput | 5,000 msg/s per queue | More than sufficient |
| Queue consumers | Auto-scale up to 250 concurrent | Configurable |
| Queues/account | 10,000 | Plenty |
| D1 database size | 10 GB (cannot increase) | Registry only |
| D1 databases/account | 50,000 (paid) | One is sufficient for registry |
| D1 throughput | Single-threaded, ~1000 qps for 1ms queries | Not on hot path |
| Worker memory | 128 MB | Z3 WASM is too large |
| Worker CPU | 30s default, 5 min configurable | |
| Workflow instances | 1,000 concurrent (paid) | For scheduling sessions |
| Workflow steps | 1,000 per instance | Sufficient |
| Workflow step timeout | Configurable, default 10 min | |
| R2 object size | 5 GB (multipart) | Audit logs, proof exports |

---

## Service Layout

```
tminus/
  packages/
    shared/              # Shared types, schemas, constants
      src/
        types.ts         # Canonical event types, policy types, message shapes
        schema.ts        # DO SQLite schema definitions
        constants.ts     # Service name, extended property keys
        policy.ts        # Policy compiler (detail_level -> projected payload)
        hash.ts          # Stable hashing for projection comparison

  workers/
    api/                 # Public API (unified calendar, availability, policies)
      src/
        index.ts
        routes/
          events.ts      # CRUD canonical events
          availability.ts
          policies.ts
          accounts.ts
          scheduling.ts

    oauth/               # OAuth flow handler
      src/
        index.ts         # /oauth/google/start, /oauth/google/callback

    webhook/             # Google Calendar push notification receiver
      src/
        index.ts         # Validate headers, enqueue SYNC_INCREMENTAL

    sync-consumer/       # Queue consumer: provider -> canonical
      src/
        index.ts         # Pull incremental updates, call UserGraphDO

    write-consumer/      # Queue consumer: canonical -> provider
      src/
        index.ts         # Execute Calendar API writes with idempotency

    mcp/                 # MCP server endpoint (Phase 2)
      src/
        index.ts

    cron/                # Scheduled maintenance
      src/
        index.ts         # Channel renewal, token refresh, drift reconciliation

  durable-objects/
    user-graph/          # UserGraphDO: per-user canonical state + coordination
      src/
        index.ts
        schema.sql       # DO SQLite schema
        sync.ts          # applyProviderDelta()
        projection.ts    # recomputeProjections()
        availability.ts  # computeAvailability()

    account/             # AccountDO: per-external-account token + sync state
      src/
        index.ts
        token.ts         # Token encryption/refresh
        channel.ts       # Watch channel lifecycle

    group-schedule/      # GroupScheduleDO: multi-user scheduling (Phase 3+)
      src/
        index.ts

  workflows/
    scheduling/          # SchedulingWorkflow (Phase 3+)
      src/
        index.ts

    reconcile/           # ReconcileWorkflow: drift repair
      src/
        index.ts

    onboarding/          # OnboardingWorkflow: initial full sync
      src/
        index.ts
```

### Wrangler bindings overview

```
Workers:
  api-worker        -> binds to: UserGraphDO, AccountDO, D1, sync-queue, write-queue
  oauth-worker      -> binds to: UserGraphDO, AccountDO, D1
  webhook-worker    -> binds to: sync-queue, D1 (account lookup)
  sync-consumer     -> binds to: UserGraphDO, AccountDO, write-queue
  write-consumer    -> binds to: AccountDO, D1 (mirror mapping updates via DO)
  mcp-worker        -> binds to: UserGraphDO, AccountDO, SchedulingWorkflow
  cron-worker       -> binds to: AccountDO, D1, reconcile-queue

Queues:
  sync-queue        -> consumed by: sync-consumer
  write-queue       -> consumed by: write-consumer
  reconcile-queue   -> consumed by: reconcile workflow trigger

Durable Objects:
  UserGraphDO       -> SQLite storage, class: UserGraph
  AccountDO         -> SQLite storage, class: Account
  GroupScheduleDO   -> SQLite storage, class: GroupSchedule (Phase 3+)
```

---

## Data Model

### D1 Registry Schema (cross-user lookups only)

```sql
-- Organization registry
CREATE TABLE orgs (
  org_id       TEXT PRIMARY KEY,  -- ulid
  name         TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- User registry
CREATE TABLE users (
  user_id      TEXT PRIMARY KEY,  -- ulid
  org_id       TEXT NOT NULL REFERENCES orgs(org_id),
  email        TEXT NOT NULL UNIQUE,
  display_name TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- External account registry (for webhook routing + OAuth callback)
CREATE TABLE accounts (
  account_id           TEXT PRIMARY KEY,  -- ulid
  user_id              TEXT NOT NULL REFERENCES users(user_id),
  provider             TEXT NOT NULL DEFAULT 'google',
  provider_subject     TEXT NOT NULL,  -- Google sub claim
  email                TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'active',  -- active, revoked, error
  channel_id           TEXT,  -- current watch channel UUID
  channel_expiry_ts    TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(provider, provider_subject)
);

CREATE INDEX idx_accounts_user ON accounts(user_id);
CREATE INDEX idx_accounts_channel ON accounts(channel_id);

-- Deletion certificates (GDPR/CCPA proof)
CREATE TABLE deletion_certificates (
  cert_id       TEXT PRIMARY KEY,
  entity_type   TEXT NOT NULL,  -- 'user', 'account', 'event'
  entity_id     TEXT NOT NULL,
  deleted_at    TEXT NOT NULL DEFAULT (datetime('now')),
  proof_hash    TEXT NOT NULL,  -- SHA-256 of deleted data summary
  signature     TEXT NOT NULL   -- system signature
);
```

### DO SQLite Schema (per-user, inside UserGraphDO)

```sql
-- Calendars linked to this user's accounts
CREATE TABLE calendars (
  calendar_id          TEXT PRIMARY KEY,
  account_id           TEXT NOT NULL,
  provider_calendar_id TEXT NOT NULL,
  role                 TEXT NOT NULL DEFAULT 'primary',
  kind                 TEXT NOT NULL DEFAULT 'PRIMARY',
    -- PRIMARY, BUSY_OVERLAY, PROJECTED, READONLY
  display_name         TEXT,
  UNIQUE(account_id, provider_calendar_id)
);

-- Canonical events (the single source of truth)
CREATE TABLE canonical_events (
  canonical_event_id   TEXT PRIMARY KEY,  -- ulid
  origin_account_id    TEXT NOT NULL,
  origin_event_id      TEXT NOT NULL,     -- provider event ID
  title                TEXT,
  description          TEXT,
  location             TEXT,
  start_ts             TEXT NOT NULL,     -- ISO 8601
  end_ts               TEXT NOT NULL,
  timezone             TEXT,
  all_day              INTEGER NOT NULL DEFAULT 0,
  status               TEXT NOT NULL DEFAULT 'confirmed',
    -- confirmed, tentative, cancelled
  visibility           TEXT NOT NULL DEFAULT 'default',
  transparency         TEXT NOT NULL DEFAULT 'opaque',
  recurrence_rule      TEXT,              -- RRULE string
  source               TEXT NOT NULL,     -- 'provider', 'ui', 'mcp', 'system'
  version              INTEGER NOT NULL DEFAULT 1,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(origin_account_id, origin_event_id)
);

CREATE INDEX idx_events_time ON canonical_events(start_ts, end_ts);
CREATE INDEX idx_events_origin ON canonical_events(origin_account_id);

-- Mirror mapping: canonical -> provider mirrors
CREATE TABLE event_mirrors (
  canonical_event_id    TEXT NOT NULL REFERENCES canonical_events(canonical_event_id),
  target_account_id     TEXT NOT NULL,
  target_calendar_id    TEXT NOT NULL,
  provider_event_id     TEXT,            -- null until created
  last_projected_hash   TEXT,
  last_write_ts         TEXT,
  state                 TEXT NOT NULL DEFAULT 'PENDING',
    -- PENDING, ACTIVE, DELETED, TOMBSTONED, ERROR
  error_message         TEXT,
  PRIMARY KEY (canonical_event_id, target_account_id)
);

-- Append-only change journal
CREATE TABLE event_journal (
  journal_id           TEXT PRIMARY KEY,  -- ulid
  canonical_event_id   TEXT NOT NULL,
  ts                   TEXT NOT NULL DEFAULT (datetime('now')),
  actor                TEXT NOT NULL,     -- 'provider:acc_xxx', 'ui', 'mcp', 'system'
  change_type          TEXT NOT NULL,     -- 'created', 'updated', 'deleted', 'mirrored'
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
    -- BUSY, TITLE, FULL
  calendar_kind    TEXT NOT NULL DEFAULT 'BUSY_OVERLAY',
    -- BUSY_OVERLAY, TRUE_MIRROR
  PRIMARY KEY (policy_id, from_account_id, to_account_id)
);

-- Constraints: trips, working hours, overrides
CREATE TABLE constraints (
  constraint_id    TEXT PRIMARY KEY,
  kind             TEXT NOT NULL,
    -- 'trip', 'working_hours', 'no_meetings_after', 'override'
  config_json      TEXT NOT NULL,        -- kind-specific JSON
  active_from      TEXT,
  active_to        TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Time accounting
CREATE TABLE time_allocations (
  allocation_id       TEXT PRIMARY KEY,
  canonical_event_id  TEXT NOT NULL REFERENCES canonical_events(canonical_event_id),
  client_id           TEXT,
  billing_category    TEXT NOT NULL DEFAULT 'NON_BILLABLE',
    -- BILLABLE, NON_BILLABLE, STRATEGIC, INVESTOR, INTERNAL
  rate                REAL,
  confidence          TEXT NOT NULL DEFAULT 'manual',
    -- manual, inferred
  locked              INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Commitment tracking
CREATE TABLE time_commitments (
  commitment_id        TEXT PRIMARY KEY,
  client_id            TEXT NOT NULL,
  client_name          TEXT,
  window_type          TEXT NOT NULL DEFAULT 'WEEKLY',
    -- WEEKLY, MONTHLY
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
  status           TEXT NOT NULL,  -- compliant, under, over
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

-- Relationship graph
CREATE TABLE relationships (
  relationship_id              TEXT PRIMARY KEY,
  participant_hash             TEXT NOT NULL UNIQUE,
  display_name                 TEXT,
  category                     TEXT NOT NULL DEFAULT 'OTHER',
    -- FAMILY, INVESTOR, FRIEND, CLIENT, BOARD, COLLEAGUE, OTHER
  closeness_weight             REAL NOT NULL DEFAULT 0.5,
  last_interaction_ts          TEXT,
  city                         TEXT,
  timezone                     TEXT,
  interaction_frequency_target INTEGER,  -- days between interactions
  created_at                   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Interaction ledger (for reputation + reciprocity)
CREATE TABLE interaction_ledger (
  ledger_id          TEXT PRIMARY KEY,
  participant_hash   TEXT NOT NULL,
  canonical_event_id TEXT,
  outcome            TEXT NOT NULL,
    -- ATTENDED, CANCELED_BY_ME, CANCELED_BY_THEM,
    -- NO_SHOW_THEM, NO_SHOW_ME,
    -- MOVED_LAST_MINUTE_THEM, MOVED_LAST_MINUTE_ME
  weight             REAL NOT NULL DEFAULT 1.0,
  note               TEXT,
  ts                 TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_ledger_participant ON interaction_ledger(participant_hash);

-- Life event milestones
CREATE TABLE milestones (
  milestone_id      TEXT PRIMARY KEY,
  participant_hash  TEXT,           -- null if personal
  kind              TEXT NOT NULL,  -- birthday, anniversary, graduation, funding, relocation
  date              TEXT NOT NULL,
  recurs_annually   INTEGER NOT NULL DEFAULT 0,
  note              TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Scheduling sessions (Phase 3+)
CREATE TABLE schedule_sessions (
  session_id       TEXT PRIMARY KEY,
  status           TEXT NOT NULL DEFAULT 'open',
    -- open, candidates_ready, confirmed, cancelled, expired
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
    -- held, committed, released, expired
);
```

### DO SQLite Schema (per-account, inside AccountDO)

```sql
-- Token storage (encrypted)
CREATE TABLE auth (
  account_id       TEXT PRIMARY KEY,
  encrypted_tokens TEXT NOT NULL,  -- AES-GCM encrypted JSON {access, refresh, expiry}
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
  status           TEXT NOT NULL DEFAULT 'active',  -- active, expired, error
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
```

---

## Queue Message Shapes

```typescript
// sync-queue messages
type SyncIncrementalMessage = {
  type: 'SYNC_INCREMENTAL';
  account_id: string;
  channel_id: string;
  resource_id: string;
  ping_ts: string;
};

type SyncFullMessage = {
  type: 'SYNC_FULL';
  account_id: string;
  reason: 'onboarding' | 'reconcile' | 'token_410';
};

// write-queue messages
type UpsertMirrorMessage = {
  type: 'UPSERT_MIRROR';
  canonical_event_id: string;
  target_account_id: string;
  target_calendar_id: string;
  projected_payload: ProjectedEvent;
  idempotency_key: string;
};

type DeleteMirrorMessage = {
  type: 'DELETE_MIRROR';
  canonical_event_id: string;
  target_account_id: string;
  provider_event_id: string;
  idempotency_key: string;
};
```

---

## Key Flows

### Flow A: Google webhook fires (event created in account A)

```
1. Google -> webhook-worker
     Validate X-Goog-Channel-Token against D1 accounts table
     Enqueue SYNC_INCREMENTAL { account_id, channel_id, resource_id }

2. sync-consumer pulls message
     Call AccountDO.getAccessToken(account_id)
     Call AccountDO.getSyncToken(account_id)
     Fetch events.list(syncToken=...)
       If 410 Gone -> enqueue SYNC_FULL
     For each event:
       Classify: origin vs managed (check extendedProperties)
       If managed -> check for drift, correct if needed, stop
       If origin -> normalize to ProviderDelta shape

3. sync-consumer calls UserGraphDO.applyProviderDelta(account_id, deltas[])

4. UserGraphDO (single-threaded):
     For each delta:
       Upsert canonical_events (INSERT or UPDATE)
       Write event_journal entry
       For each policy_edge where from_account == origin account:
         Compute projected payload
         Hash it
         Compare to event_mirrors.last_projected_hash
         If different -> enqueue UPSERT_MIRROR to write-queue
     Update AccountDO sync cursor

5. write-consumer pulls UPSERT_MIRROR
     Call AccountDO.getAccessToken(target_account_id)
     Check event_mirrors for existing provider_event_id
       If exists -> PATCH (with If-Match if available)
       If not -> INSERT into busy overlay calendar
     Update event_mirrors with provider_event_id + last_projected_hash
```

### Flow B: User creates event in UI/MCP (targeting all accounts)

```
1. UI/MCP -> api-worker POST /v1/events
     Authenticate user
     Call UserGraphDO.upsertCanonicalEvent(event, source='ui')

2. UserGraphDO:
     INSERT canonical_events with origin_account = 'internal'
     Write event_journal (actor='ui')
     For each policy_edge from 'internal' to each account:
       Compute projection
       Enqueue UPSERT_MIRROR

3. write-consumer processes mirrors (same as Flow A step 5)
```

### Flow C: Onboarding (new account connected)

```
1. oauth-worker completes OAuth flow
     Store account in D1 registry
     Create AccountDO with encrypted tokens
     Start OnboardingWorkflow(account_id)

2. OnboardingWorkflow:
     Step 1: Fetch calendar list, identify primary + create busy overlay
     Step 2: Paginated events.list (no syncToken = full list)
       For each page:
         Classify events
         Call UserGraphDO.applyProviderDelta(batch)
     Step 3: Register watch channel
     Step 4: Store initial syncToken in AccountDO
     Step 5: Mark account as 'active' in D1
```

### Flow D: Daily drift reconciliation

```
1. cron-worker runs daily
     For each account in D1 where status = 'active':
       Enqueue SYNC_FULL { reason: 'reconcile' }

2. sync-consumer processes full sync
     Same as incremental but without syncToken
     Cross-check event_mirrors against actual provider state
     Fix: missing mirrors, orphaned mirrors, hash mismatches
     Log discrepancies to event_journal
```

---

## Phase Plan

### Phase 1: Foundation (calendar federation core)

**Goal:** Two+ Google accounts synced bidirectionally with busy overlay.

**Deliverables:**
- [ ] Project scaffolding (monorepo, wrangler configs, shared package)
- [ ] D1 registry schema + migrations
- [ ] OAuth worker (Google PKCE flow)
- [ ] AccountDO (token storage, refresh, sync cursor, watch channels)
- [ ] UserGraphDO (canonical events, event_mirrors, event_journal, policies)
- [ ] Webhook worker (validation, enqueue)
- [ ] Sync consumer (incremental + full sync, classification, normalization)
- [ ] Write consumer (create/patch/delete mirrors, idempotency)
- [ ] Policy compiler (BUSY, TITLE, FULL projection)
- [ ] Busy overlay calendar auto-creation
- [ ] Cron worker (channel renewal, token refresh, daily reconciliation)
- [ ] OnboardingWorkflow (full initial sync)
- [ ] Loop prevention (extended properties tagging + classification)
- [ ] Integration tests against Google Calendar API sandbox

**Key risk:** Google Calendar API sandbox/test environment is limited. Need
real accounts for integration testing from the start.

### Phase 2: Usability (the product becomes usable)

**Goal:** A human can use this daily, not just as infrastructure.

**Deliverables:**
- [ ] Web calendar UI (Workers + Assets, read-only unified view first)
- [ ] Event creation from unified UI (write path)
- [ ] MCP server (list_accounts, create_event, add_trip, get_availability)
- [ ] Trip/constraint system (block time across all accounts)
- [ ] Policy management UI (configure detail levels per direction)
- [ ] Sync status dashboard (green/yellow/red per account)
- [ ] Error recovery UI (DLQ visibility, manual retry)

### Phase 3: Intelligence (time governance)

**Goal:** The system makes decisions, not just mirrors data.

**Deliverables:**
- [ ] Greedy interval scheduler (propose meeting times with constraints)
- [ ] VIP policy engine (priority overrides with conditions)
- [ ] Billable/non-billable time tagging
- [ ] Commitment tracking (rolling window compliance + proof export)
- [ ] Working hours constraints
- [ ] Basic availability API (unified free/busy across all accounts)

### Phase 4: Differentiators (the moat)

**Goal:** Features that cannot be bolted onto Calendly or Google Calendar.

**Deliverables:**
- [ ] Relationship graph + social drift detection
- [ ] Geo-aware reconnection suggestions (trip + relationship intersection)
- [ ] Life event memory (milestones, birthdays, graduations)
- [ ] Interaction ledger + reputation scoring (reliability, reciprocity)
- [ ] Context briefings before meetings (last interaction, topics, mutual connections)
- [ ] Excuse generator (policy-based, tone-aware, context-sensitive)
- [ ] Commitment compliance proof export (signed digests, PDF/CSV)
- [ ] External constraint solver integration (for multi-party optimization)
- [ ] Multi-user scheduling (GroupScheduleDO, holds, atomic commit)

### Phase 5: Scale & Polish (product-market fit)

**Deliverables:**
- [ ] iOS app (native, calls API directly)
- [ ] Microsoft Calendar support (second provider)
- [ ] Read-only CalDAV feed
- [ ] "What-if" simulation engine
- [ ] Cognitive load modeling (mode clustering, context-switch cost)
- [ ] Temporal risk scoring (burnout detection)
- [ ] Probabilistic availability modeling
- [ ] Multi-tenant B2B (org-wide policies, shared constraints)
- [ ] Temporal Graph API (for third-party integrations)

---

## Security Design

### Token encryption

- Master key stored in Cloudflare Secret (per environment)
- Per-account DEK (Data Encryption Key) generated at account creation
- DEK encrypted with master key, stored in AccountDO
- Tokens encrypted with DEK using AES-256-GCM
- Access tokens minted JIT by AccountDO.getAccessToken()
- Refresh tokens never leave AccountDO

### Webhook validation

- Verify `X-Goog-Channel-Token` matches stored channel token
- Verify `X-Goog-Resource-State` is a known value
- Reject unknown channel_id / resource_id combinations
- Rate-limit webhook endpoint per source IP

### Privacy (GDPR/CCPA/CPRA)

- Participant identifiers stored as SHA-256(email + per-org salt)
- Event content optionally encrypted at rest (user-controlled)
- Full deletion via Workflow: D1 rows + DO storage + R2 audit objects
- Deletion certificates with signed proof hash
- No soft deletes -- tombstone structural references only
- Minimal data collection: only what's needed for sync + policy

---

## MCP Tool Surface (Phase 2+)

```typescript
// Account management
calendar.list_accounts()
calendar.get_sync_status()

// Event management
calendar.list_events(start, end, account?)
calendar.create_event(event)
calendar.update_event(event_id, patch)
calendar.delete_event(event_id)

// Constraints & trips
calendar.add_trip(name, start, end, timezone, block_policy)
calendar.add_constraint(kind, config)
calendar.list_constraints()

// Availability
calendar.get_availability(start, end, accounts?)

// Scheduling (Phase 3+)
calendar.propose_times(participants, window, duration, constraints, objective?)
calendar.commit_candidate(session_id, candidate_id)

// VIP & policies
calendar.set_vip(participant, priority, conditions)
calendar.set_policy_edge(from_account, to_account, detail_level)

// Time accounting
calendar.tag_billable(event_id, client, category, rate?)
calendar.get_commitment_status(client?)
calendar.export_commitment_proof(client, window)

// Relationships (Phase 4+)
calendar.add_relationship(participant, category, city?, frequency_target?)
calendar.mark_outcome(event_id, outcome, note?)
calendar.get_drift_report()
calendar.get_reconnection_suggestions(trip_id?)

// Overrides
calendar.override(event_id, allow_outside_hours?, reason?)

// Excuse generator (Phase 4+)
calendar.generate_excuse(event_id, tone, truth_level)
```

---

## What We Deliberately Do NOT Build (First 12 Months)

1. **CalDAV server** -- Too much scope for the value. iOS app talks to our API.
2. **Email/message scraping** -- Privacy nightmare. All data is user-controlled.
3. **Auto-messaging** -- We suggest and draft. We never send without confirmation.
4. **Z3 WASM in Workers** -- External solver when needed.
5. **Microsoft Calendar** -- Google first. MSFT after product-market fit.
6. **Multi-org global optimization** -- Requires critical mass of users.
7. **Temporal versioning (git for time)** -- Journal gives us the data; UI deferred.
8. **Contact database import** -- We're not a CRM. Relationships are manually curated.

---

## Open Questions (to resolve during Phase 1)

1. **Monorepo tooling:** Turborepo? Nx? Plain workspaces?
2. **Testing strategy:** How to test against Google Calendar API? Service account
   with test calendars? Mock layer?
3. **Deployment pipeline:** Wrangler deploy per-worker, or unified?
4. **Auth for our own API:** Session tokens? JWT? Cloudflare Access?
5. **UI framework:** React? Solid? What calendar component library?
6. **Recurring events:** How deep do we handle RRULE expansion? Do we mirror
   individual instances or the recurrence pattern?
