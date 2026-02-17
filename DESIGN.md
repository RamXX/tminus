# T-Minus Design Document

## Purpose

This document defines the user experience, developer experience, data flow
contracts, and extension points for T-Minus Phase 1 (Foundation). Phase 1 has
no graphical UI. Every "user" is a system component, an API consumer, or an
operator inspecting health. The design decisions here establish the interaction
patterns that Phase 2+ features (UI, MCP, trip system) will build on.

---

## 1. User Personas

### Persona A: The Multi-Org Professional (End User)

A contractor, consultant, advisor, or board member who operates across 2-5
Google Workspace accounts. They are double-booked constantly because their
calendars do not know about each other. In Phase 1 they interact only through
the REST API and OAuth flow. In Phase 2+ they gain a calendar UI, MCP
interface, and mobile app.

**Core need:** "My calendars should be aware of each other without me manually
copying events."

**Phase 1 touchpoints:**
- OAuth redirect flow to link Google accounts
- REST API for policy configuration and sync status
- Busy overlay calendars appearing in their Google Calendar

### Persona B: The API Consumer (Developer)

An internal or future external developer building on the T-Minus REST API.
In Phase 2, this includes the MCP server and the calendar UI frontend.

**Core need:** Predictable, well-documented endpoints with clear error
responses and idempotent behavior.

**Phase 1 touchpoints:**
- REST API (accounts, events, policies, sync status)
- Queue message contracts (for building new consumers)
- DO RPC interfaces (for service-to-service calls)

### Persona C: The Operator (Maintainer)

The engineer monitoring sync health, debugging failures, and ensuring the
system is operating correctly.

**Core need:** Know whether sync is healthy. When it is not, know exactly
which account, which event, and what went wrong.

**Phase 1 touchpoints:**
- Sync status endpoints (per-account health)
- Event journal (audit trail for every mutation)
- Queue dead-letter visibility
- Cron job health (channel renewal, token refresh, reconciliation)

---

## 2. Design Principles

### P1: Canonical-first

The canonical event store is the source of truth. Provider calendars receive
projections of canonical state. The system never treats a provider as
authoritative over the canonical store -- it ingests, normalizes, and then
projects outward deterministically.

### P2: Eventual consistency with visible status

Sync is asynchronous by design. The system must never pretend otherwise.
Every account has a visible sync status. Every mirror has a projection state.
Users and operators always know "is this up to date?"

### P3: Fail loud, recover quiet

Errors are surfaced immediately and specifically. Recovery (retries,
reconciliation, drift repair) happens automatically in the background.
The operator sees "Account X had a 410 Gone at 14:32, full resync completed
at 14:34" -- not a silent retry that might or might not have worked.

### P4: Idempotent everywhere

Every external write, every queue message, every DO RPC call is safe to
retry. The projection hash is the unit of idempotency for provider writes.
If the hash has not changed, no write occurs.

### P5: Design for Phase 2+

Every API response shape, every queue message contract, and every DO RPC
method is designed knowing that a UI, MCP server, and trip system will
consume them. We do not build throwaway interfaces.

### P6: Privacy by default

Participant identifiers are hashed. Event content stays in per-user
isolated storage (DO SQLite). Tokens never leave AccountDO. No data
crosses user boundaries except through the D1 registry, which holds
only structural references.

---

## 3. REST API Surface (Phase 1)

### Base URL

```
https://api.tminus.dev/v1
```

### Authentication

Phase 1 uses bearer tokens. The exact mechanism (session tokens, JWT,
or Cloudflare Access) is an open question from PLAN.md. The API design
is auth-scheme-agnostic: every request carries `Authorization: Bearer <token>`
and the api-worker resolves it to a `user_id`.

### Endpoint Summary

```
Accounts
  POST   /v1/accounts/link          Start OAuth flow for a new account
  GET    /v1/accounts               List linked accounts
  GET    /v1/accounts/:id           Get account details + sync status
  DELETE /v1/accounts/:id           Unlink account (revoke + cleanup)

Events
  GET    /v1/events                 List canonical events (unified view)
  GET    /v1/events/:id             Get single canonical event + mirrors
  POST   /v1/events                 Create canonical event (source=api)
  PATCH  /v1/events/:id             Update canonical event
  DELETE /v1/events/:id             Delete canonical event + mirrors

Policies
  GET    /v1/policies               List policies
  GET    /v1/policies/:id           Get policy with edges
  POST   /v1/policies               Create policy
  PUT    /v1/policies/:id/edges     Set policy edges (replaces all edges)

Sync Status
  GET    /v1/sync/status            Aggregate sync health (all accounts)
  GET    /v1/sync/status/:accountId Per-account sync health
  GET    /v1/sync/journal           Query event journal (audit trail)
```

### Request/Response Conventions

**Envelope:** All responses use a consistent envelope.

```json
{
  "ok": true,
  "data": { ... },
  "meta": {
    "request_id": "req_01HXYZ...",
    "timestamp": "2026-02-13T10:00:00Z"
  }
}
```

**Error envelope:**

```json
{
  "ok": false,
  "error": {
    "code": "ACCOUNT_SYNC_STALE",
    "message": "Account acc_01H... has not synced successfully in 26 hours.",
    "detail": {
      "account_id": "acc_01H...",
      "last_success_ts": "2026-02-12T08:14:00Z"
    }
  },
  "meta": {
    "request_id": "req_01HXYZ...",
    "timestamp": "2026-02-13T10:14:00Z"
  }
}
```

**Pagination:** Cursor-based. Responses include `meta.next_cursor` when more
results exist. Clients pass `?cursor=<value>`.

**Timestamps:** ISO 8601, always UTC in wire format. Timezone context carried
as a separate field where relevant (e.g., `event.timezone`).

**IDs:** ULIDs throughout. Prefixed by entity type for human readability:
`usr_`, `acc_`, `evt_`, `pol_`, `cal_`, `jrn_`.

### Key Endpoint Details

#### GET /v1/events

Returns the unified canonical event list. This is the "single pane of glass"
that Phase 2 UI will render as a calendar view.

Query parameters:
- `start` (required): ISO 8601 datetime, inclusive
- `end` (required): ISO 8601 datetime, exclusive
- `account_id` (optional): Filter to events originating from one account
- `status` (optional): `confirmed`, `tentative`, `cancelled`
- `cursor` (optional): Pagination cursor
- `limit` (optional): Default 100, max 500

Response shape (data field):

```json
{
  "events": [
    {
      "canonical_event_id": "evt_01H...",
      "origin_account_id": "acc_01H...",
      "title": "Board Meeting",
      "start_ts": "2026-02-14T09:00:00Z",
      "end_ts": "2026-02-14T10:00:00Z",
      "timezone": "America/Los_Angeles",
      "all_day": false,
      "status": "confirmed",
      "visibility": "default",
      "transparency": "opaque",
      "source": "provider",
      "version": 3,
      "mirrors": [
        {
          "target_account_id": "acc_02H...",
          "state": "ACTIVE",
          "last_write_ts": "2026-02-13T08:30:00Z"
        }
      ]
    }
  ],
  "next_cursor": "cur_01H..."
}
```

#### GET /v1/sync/status

Aggregate sync health for all linked accounts.

```json
{
  "overall": "healthy",
  "accounts": [
    {
      "account_id": "acc_01H...",
      "email": "me@company-a.com",
      "provider": "google",
      "status": "healthy",
      "last_sync_ts": "2026-02-13T10:02:00Z",
      "last_success_ts": "2026-02-13T10:02:00Z",
      "channel_status": "active",
      "channel_expiry_ts": "2026-02-20T10:00:00Z",
      "pending_writes": 0,
      "error_mirrors": 0
    }
  ]
}
```

### Error Code Taxonomy

Errors use structured codes, not HTTP status codes alone.

| Code | HTTP | Meaning |
|------|------|---------|
| `VALIDATION_ERROR` | 400 | Malformed request body or params |
| `AUTH_REQUIRED` | 401 | Missing or invalid bearer token |
| `FORBIDDEN` | 403 | Valid auth but insufficient permissions |
| `NOT_FOUND` | 404 | Entity does not exist |
| `CONFLICT` | 409 | Optimistic concurrency conflict (stale version) |
| `ACCOUNT_REVOKED` | 422 | Account OAuth tokens revoked by user |
| `ACCOUNT_SYNC_STALE` | 422 | Account has not synced in >24 hours |
| `PROVIDER_ERROR` | 502 | Google Calendar API returned an error |
| `PROVIDER_QUOTA` | 429 | Google Calendar API quota exceeded |
| `INTERNAL_ERROR` | 500 | Unexpected system error |

Errors always include `request_id` for correlation. Provider errors include
the upstream error detail when safe to expose.

---

## 4. OAuth Flow Design

### Flow Overview

```
                                 T-Minus System
  User Browser                   (oauth-worker)                Google
  +-----------+                 +--------------+            +----------+
  |           |  1. GET /oauth  |              |            |          |
  |           | /google/start   |              |            |          |
  |           +---------------->| Generate     |            |          |
  |           |                 | PKCE pair    |            |          |
  |           |  2. 302         | Store state  |            |          |
  |           |<----------------+ in cookie    |            |          |
  |           |                 |              |            |          |
  |           |  3. Redirect    |              |            |          |
  |           +-------------------------------------------->|          |
  |           |                 |              |  4. User   |          |
  |           |                 |              |  consents  |          |
  |           |  5. Redirect    |              |            |          |
  |           |  with code      |              |            |          |
  |           +---------------->| 6. Exchange  |            |          |
  |           |                 |    code for  +----------->|          |
  |           |                 |    tokens    |<-----------+          |
  |           |                 |              |            |          |
  |           |                 | 7. Create    |            |          |
  |           |                 |    AccountDO |            |          |
  |           |                 |    + D1 row  |            |          |
  |           |                 |              |            |          |
  |           |                 | 8. Start     |            |          |
  |           |                 |    Onboarding|            |          |
  |           |                 |    Workflow   |            |          |
  |           |                 |              |            |          |
  |           |  9. Redirect    |              |            |          |
  |           |  to success URL |              |            |          |
  |           |<----------------+              |            |          |
  +-----------+                 +--------------+            +----------+
```

### Endpoints

**GET /oauth/google/start**

Query params:
- `user_id` (required): The authenticated user linking a new account
- `redirect_uri` (optional): Where to send the user after completion.
  Defaults to a configured success page.

Behavior:
1. Generate PKCE code_verifier and code_challenge
2. Generate cryptographic `state` parameter
3. Store `{state, code_verifier, user_id, redirect_uri}` in a short-lived
   signed cookie (5 min TTL) or KV entry
4. Redirect to Google OAuth consent screen with scopes:
   - `https://www.googleapis.com/auth/calendar`
   - `https://www.googleapis.com/auth/calendar.events`
   - `openid email profile` (for provider_subject identification)

**GET /oauth/google/callback**

Query params (from Google):
- `code`: Authorization code
- `state`: Must match stored state

Behavior:
1. Validate `state` against stored value. If mismatch, return error page.
2. Exchange `code` for tokens using PKCE code_verifier
3. Fetch Google userinfo to get `sub` (provider_subject) and `email`
4. Check D1: does an account with this `(provider, provider_subject)` exist?
   - If yes and same user: re-activate, update tokens
   - If yes and different user: reject with `ACCOUNT_ALREADY_LINKED` error
   - If no: create new account
5. Create/update AccountDO with encrypted tokens
6. Insert/update D1 accounts registry row
7. Start OnboardingWorkflow for initial sync
8. Redirect user to success URL with `?account_id=acc_01H...`

### Error States

| Scenario | User Sees | System Action |
|----------|-----------|---------------|
| State mismatch | "Link failed. Please try again." | Log warning, no account created |
| Google consent denied | "You declined access. No account linked." | Clean redirect, no retry |
| Token exchange fails | "Something went wrong. Please try again." | Log error with request_id |
| Account already linked to another user | "This Google account is already linked to a different T-Minus account." | 409 Conflict, no change |
| Duplicate link (same user) | Silent success, tokens refreshed | Re-activate existing account |
| Google scopes insufficient | "We need calendar access to sync. Please re-authorize." | Redirect back to consent |

### Security Considerations

- PKCE is mandatory (no client_secret in browser flow)
- State parameter prevents CSRF
- Tokens are encrypted immediately upon receipt (never stored in plaintext)
- Refresh tokens never leave AccountDO
- OAuth client_secret stored as Cloudflare Secret, not in code

---

## 5. Data Flow Diagrams

### Flow A: Webhook-Triggered Incremental Sync

This is the primary hot path. A user creates or modifies an event in Google
Calendar Account A. The system detects it, ingests it, and projects busy
blocks to Account B and Account C.

```
  Google Calendar                T-Minus System
  +------------+     +---------------------------------------------+
  |            |     |                                             |
  | Account A  |     |  webhook     sync-queue    sync-consumer    |
  | event      |     |  worker                                    |
  | changed    +---->|  +------+    +--------+    +------------+  |
  |            |     |  |verify|    |        |    |            |  |
  +------------+     |  |header+--->|enqueue +--->|pull msg    |  |
                     |  |route |    |SYNC_   |    |            |  |
                     |  +------+    |INCR.   |    +-----+------+  |
                     |              +--------+          |         |
                     |                                  v         |
                     |  AccountDO                                 |
                     |  +------------+    +-----------+           |
                     |  |getToken()  |<---|get token  |           |
                     |  |getSyncTkn()|    |get cursor |           |
                     |  +------------+    +-----+-----+           |
                     |                          |                 |
                     |                          v                 |
                     |                   events.list(syncToken)   |
                     |                          |                 |
                     |                          v                 |
                     |                   classify each event      |
                     |                   origin vs managed        |
                     |                          |                 |
                     |              +-----------+-----------+     |
                     |              |                       |     |
                     |              v                       v     |
                     |         [origin]              [managed]    |
                     |         normalize              check       |
                     |         to delta               drift       |
                     |              |                   |         |
                     |              v                   v         |
                     |  UserGraphDO                  correct      |
                     |  +------------------+         if needed    |
                     |  |applyProviderDelta|                      |
                     |  |                  |                      |
                     |  | upsert canonical |                      |
                     |  | write journal    |                      |
                     |  | for each policy  |                      |
                     |  |   edge:          |                      |
                     |  |   compute proj.  |                      |
                     |  |   compare hash   |                      |
                     |  |   if changed:    |                      |
                     |  |     enqueue      |                      |
                     |  |     UPSERT_MIRROR|                      |
                     |  +--------+---------+                      |
                     |           |                                |
                     |           v                                |
                     |  write-queue     write-consumer            |
                     |  +--------+     +---------------+          |
                     |  |UPSERT_ |     |               |          |
                     |  |MIRROR  +---->|get token (DO) |          |
                     |  |        |     |check mirror   |          |
                     |  +--------+     |INSERT or PATCH|          |
                     |                 |update mirror  |          |
                     |                 |  mapping      |          |
                     |                 +-------+-------+          |
                     |                         |                  |
                     +---------------------------------------------+
                                               |
                                               v
                                    Google Calendar
                                    Account B & C
                                    (busy overlay)
```

### Flow B: Onboarding (New Account Linked)

```
  oauth-worker completes flow
         |
         v
  +------+-------+
  |Create account |
  |in D1 registry |
  |Create AccountDO|
  |with enc tokens |
  +------+--------+
         |
         v
  OnboardingWorkflow
  +-------------------------------------------+
  |                                           |
  |  Step 1: Fetch calendar list              |
  |          Create "External Busy" calendar  |
  |          Store calendar IDs in DO         |
  |                                           |
  |  Step 2: Paginated events.list            |
  |          (no syncToken = full list)       |
  |          For each page:                   |
  |            classify events                |
  |            call UserGraphDO               |
  |              .applyProviderDelta(batch)   |
  |                                           |
  |  Step 3: Register watch channel           |
  |          POST events/watch                |
  |          Store channel_id in AccountDO    |
  |          Store channel_id in D1 accounts  |
  |                                           |
  |  Step 4: Store syncToken in AccountDO     |
  |                                           |
  |  Step 5: Mark account status = 'active'   |
  |          in D1                            |
  |                                           |
  +-------------------------------------------+
```

### Flow C: Daily Drift Reconciliation

```
  cron-worker (scheduled trigger)
         |
         v
  Query D1: all accounts where status = 'active'
         |
         v
  For each account:
    Enqueue SYNC_FULL { reason: 'reconcile' }
         |
         v
  sync-consumer pulls SYNC_FULL
         |
         v
  Full events.list (no syncToken)
         |
         v
  Cross-check:
    - canonical_events vs provider events (missing origins?)
    - event_mirrors vs provider mirrors (orphaned? drifted?)
    - projection hashes (stale mirrors?)
         |
         v
  Fix discrepancies:
    - Enqueue UPSERT_MIRROR for stale mirrors
    - Enqueue DELETE_MIRROR for orphaned mirrors
    - Log all discrepancies to event_journal
         |
         v
  Update AccountDO:
    - New syncToken
    - last_sync_ts
    - last_success_ts
```

### Flow D: Cron Maintenance Cycle

```
  cron-worker (runs on schedule)
         |
         +---> Channel Renewal
         |     Query D1: channels expiring within 24h
         |       OR channels with no sync in 12h
         |     For each: call reRegisterChannel() in cron worker
         |       1. Stop old channel with Google (best-effort)
         |       2. Register new channel via Google watchEvents API
         |       3. Store new channel in AccountDO via storeWatchChannel()
         |       4. Update D1 with new channel_id, token, expiry, resource_id
         |
         +---> Token Health Check
         |     Query D1: all active accounts
         |     For each: call AccountDO.checkTokenHealth()
         |     If refresh fails: mark account status = 'error'
         |     Surface in sync status endpoint
         |
         +---> Drift Reconciliation (see Flow C)
               Enqueue SYNC_FULL for all active accounts
```

---

## 6. Sync Status Model

Sync health is the primary operational concern in Phase 1. The system must
make it trivially easy to answer: "Is everything working?"

### Per-Account Health States

```
  HEALTHY ---------> DEGRADED ---------> UNHEALTHY
     ^                  |                    |
     |                  v                    v
     +--- auto-heal   STALE              ERROR
           (resync)     |                    |
                        v                    v
                     auto-reconcile     requires
                     via cron           manual
                                        intervention
```

| State | Definition | Trigger |
|-------|-----------|---------|
| `healthy` | Last successful sync < 1 hour ago. Channel active. No error mirrors. | Normal operation |
| `degraded` | Last successful sync 1-6 hours ago. Or 1+ mirrors in ERROR state. | Transient Google API errors, quota throttling |
| `stale` | Last successful sync 6-24 hours ago. | Channel stopped delivering, persistent API errors |
| `unhealthy` | Last successful sync > 24 hours ago. | Requires investigation |
| `error` | OAuth tokens revoked, or persistent unrecoverable error. | User revoked access, account suspended |

### Health Computation

Health is computed by the api-worker when `/v1/sync/status` is called:

1. Read `last_success_ts` from AccountDO
2. Read `channel_status` and `channel_expiry_ts` from AccountDO
3. Count mirrors in `ERROR` state from UserGraphDO
4. Apply thresholds above

The `overall` field on the aggregate endpoint is the worst status among all
accounts. This gives operators a single field to monitor.

### Alerting Integration Points

Phase 1 does not build alerting, but the sync status model is designed for it:
- `GET /v1/sync/status` returns machine-readable health
- Each account includes `last_success_ts` for threshold-based alerts
- Each account includes `error_mirrors` count for anomaly detection
- The event journal can be queried for error patterns

Phase 2 adds a sync status dashboard (green/yellow/red per account).

---

## 7. Message Contracts

### Queue Messages

All queue messages share a common envelope:

```typescript
type QueueMessage = {
  type: string;            // Discriminator
  trace_id: string;        // For distributed tracing (ULID)
  enqueued_at: string;     // ISO 8601
  attempt: number;         // Retry count (0-based)
};
```

#### sync-queue Messages

```typescript
type SyncIncrementalMessage = QueueMessage & {
  type: 'SYNC_INCREMENTAL';
  account_id: string;      // acc_01H...
  channel_id: string;      // UUID from Google
  resource_id: string;     // Google resource identifier
};

type SyncFullMessage = QueueMessage & {
  type: 'SYNC_FULL';
  account_id: string;
  reason: 'onboarding' | 'reconcile' | 'token_410';
};
```

Size budget: These are small (~200 bytes). Well within 128 KB limit.

#### write-queue Messages

```typescript
type UpsertMirrorMessage = QueueMessage & {
  type: 'UPSERT_MIRROR';
  canonical_event_id: string;
  target_account_id: string;
  target_calendar_id: string;
  projected_payload: ProjectedEvent;
  idempotency_key: string;  // hash(canonical_event_id + target_account + projected_hash)
};

type DeleteMirrorMessage = QueueMessage & {
  type: 'DELETE_MIRROR';
  canonical_event_id: string;
  target_account_id: string;
  provider_event_id: string;
  idempotency_key: string;
};
```

Size budget: `projected_payload` is the largest field. A BUSY projection is
~100 bytes. A FULL projection (title + description + location + attendees)
could be ~2-4 KB. Well within 128 KB.

#### ProjectedEvent Shape

```typescript
type ProjectedEvent = {
  summary: string;          // "Busy" for BUSY level, real title for TITLE/FULL
  description?: string;     // Only for FULL level
  location?: string;        // Only for FULL level
  start: EventDateTime;
  end: EventDateTime;
  transparency: 'opaque' | 'transparent';
  visibility: 'default' | 'private';
  extendedProperties: {
    private: {
      tminus: 'true';
      managed: 'true';
      canonical_event_id: string;
      origin_account_id: string;
    };
  };
};

type EventDateTime = {
  dateTime?: string;        // ISO 8601 for timed events
  date?: string;            // YYYY-MM-DD for all-day events
  timeZone?: string;
};
```

### Durable Object RPC Interfaces

#### UserGraphDO

```typescript
interface UserGraphDO {
  // Sync path: provider changes -> canonical store
  applyProviderDelta(
    account_id: string,
    deltas: ProviderDelta[]
  ): Promise<ApplyResult>;

  // API path: user-initiated canonical event CRUD
  upsertCanonicalEvent(
    event: CanonicalEventInput,
    source: 'api' | 'ui' | 'mcp' | 'system'
  ): Promise<CanonicalEvent>;

  deleteCanonicalEvent(
    canonical_event_id: string,
    source: 'api' | 'ui' | 'mcp' | 'system'
  ): Promise<void>;

  // Query: unified event list
  listCanonicalEvents(
    query: EventQuery
  ): Promise<PaginatedResult<CanonicalEvent>>;

  // Query: single event with mirror status
  getCanonicalEvent(
    canonical_event_id: string
  ): Promise<CanonicalEventWithMirrors | null>;

  // Policy: recompute all projections (after policy change)
  recomputeProjections(
    scope: { canonical_event_id: string } | 'all'
  ): Promise<RecomputeResult>;

  // Availability: unified free/busy
  computeAvailability(
    query: AvailabilityQuery
  ): Promise<AvailabilityResult>;

  // Journal: query audit trail
  queryJournal(
    query: JournalQuery
  ): Promise<PaginatedResult<JournalEntry>>;

  // Health: mirror error count, last sync info
  getSyncHealth(): Promise<SyncHealth>;
}
```

#### AccountDO

```typescript
interface AccountDO {
  // Token management
  getAccessToken(): Promise<string>;
  revokeTokens(): Promise<void>;

  // Sync cursor
  getSyncToken(): Promise<string | null>;
  setSyncToken(token: string): Promise<void>;

  // Watch channel lifecycle
  registerChannel(calendar_id: string): Promise<ChannelInfo>;
  storeWatchChannel(channelId: string, resourceId: string, expiration: string, calendarId: string): Promise<void>;
  getChannelStatus(): Promise<ChannelStatus>;

  // Health
  getHealth(): Promise<AccountHealth>;
  markSyncSuccess(ts: string): Promise<void>;
  markSyncFailure(error: string): Promise<void>;
}
```

#### Key Types

```typescript
type ProviderDelta = {
  provider_event_id: string;
  change_type: 'created' | 'updated' | 'deleted';
  event_data?: GoogleCalendarEvent;  // null for deletes
  is_managed: boolean;               // true if tminus extended props found
};

type ApplyResult = {
  processed: number;
  created: number;
  updated: number;
  deleted: number;
  mirrors_enqueued: number;
  errors: Array<{ provider_event_id: string; error: string }>;
};

type SyncHealth = {
  total_canonical_events: number;
  total_mirrors: number;
  mirrors_by_state: Record<string, number>;
  last_journal_ts: string;
};

type AccountHealth = {
  account_id: string;
  status: 'healthy' | 'degraded' | 'stale' | 'unhealthy' | 'error';
  last_sync_ts: string | null;
  last_success_ts: string | null;
  channel_status: 'active' | 'expired' | 'error' | 'none';
  channel_expiry_ts: string | null;
  last_error: string | null;
};
```

---

## 8. Error Handling Strategy

### Layers of Error Handling

```
  Layer 1: Input Validation (api-worker)
  +-----------------------------------------+
  | Malformed JSON, missing fields, bad IDs |
  | Response: 400 + VALIDATION_ERROR        |
  | No side effects. Fast fail.             |
  +-----------------------------------------+
           |
           v
  Layer 2: Authorization (api-worker)
  +-----------------------------------------+
  | Invalid token, wrong user, no access    |
  | Response: 401/403                       |
  | No side effects. Fast fail.             |
  +-----------------------------------------+
           |
           v
  Layer 3: Business Logic (UserGraphDO)
  +-----------------------------------------+
  | Concurrency conflict (stale version),   |
  | account not found, policy violation     |
  | Response: 409/404/422                   |
  | Side effects: none or rolled back       |
  +-----------------------------------------+
           |
           v
  Layer 4: Provider Errors (write-consumer)
  +-----------------------------------------+
  | Google API 429, 500, 403                |
  | Action: Retry with backoff (queue)      |
  | After max retries: mirror state = ERROR |
  | Surface via sync status endpoint        |
  +-----------------------------------------+
           |
           v
  Layer 5: Infrastructure (all workers)
  +-----------------------------------------+
  | DO unavailable, queue full, D1 down     |
  | Action: 500 + INTERNAL_ERROR            |
  | Retry at transport level                |
  +-----------------------------------------+
```

### Retry Strategy for Queue Consumers

| Error Type | Strategy | Max Retries | Backoff |
|-----------|----------|-------------|---------|
| Google 429 (quota) | Retry with exponential backoff | 5 | 1s, 2s, 4s, 8s, 16s |
| Google 500/503 | Retry with backoff | 3 | 2s, 4s, 8s |
| Google 401 (token expired) | Refresh token, retry once | 1 | Immediate |
| Google 410 (sync token gone) | Enqueue SYNC_FULL, discard current | 0 | N/A |
| Google 403 (insufficient scope) | Mark account error, do not retry | 0 | N/A |
| DO unavailable | Queue auto-retries | 3 | Queue default backoff |

### Mirror Error States

When a mirror write fails after all retries, the mirror enters `ERROR` state:

```json
{
  "canonical_event_id": "evt_01H...",
  "target_account_id": "acc_02H...",
  "state": "ERROR",
  "error_message": "Google API 403: insufficientPermissions",
  "last_write_ts": "2026-02-13T10:00:00Z"
}
```

Error mirrors are:
1. Visible in `GET /v1/events/:id` (mirror status shows ERROR)
2. Counted in `GET /v1/sync/status` (error_mirrors field)
3. Retried during daily drift reconciliation
4. Surfaced in Phase 2 error recovery UI

---

## 9. Webhook Receiver Design

### Request Validation

The webhook-worker validates inbound Google push notifications:

1. **Header validation:**
   - `X-Goog-Channel-ID` must match a known channel_id in D1
   - `X-Goog-Resource-State` must be one of: `sync`, `exists`, `not_exists`
   - `X-Goog-Channel-Token` must match the stored token for that channel

2. **Rate limiting:** Per source IP, configurable threshold

3. **Response:** Always 200 OK (Google requires this; non-200 triggers
   exponential backoff from Google's side)

### Handling `sync` Notifications

Google sends a `sync` notification immediately when a watch channel is
created. This is not a real change. The webhook-worker should acknowledge
it (200) but not enqueue a sync message.

### Handling `exists` and `not_exists`

Both trigger `SYNC_INCREMENTAL` enqueueing. The sync-consumer uses the
syncToken to fetch actual deltas, so the notification type does not affect
processing.

### Deduplication

Google may send duplicate notifications. The sync-consumer handles this
naturally through idempotent processing:
- If the syncToken has not advanced, events.list returns empty
- If the canonical event is already up-to-date, no mirror writes occur
- The projection hash comparison prevents redundant PATCH calls

---

## 10. Extension Points for Phase 2+

The Phase 1 architecture is designed with specific seams where Phase 2+
features attach.

### Extension Point 1: Calendar UI (Phase 2)

**Attachment surface:** REST API (`/v1/events`, `/v1/sync/status`)

The API is designed so the UI is a pure consumer:
- `GET /v1/events` returns the unified view a calendar component renders
- `POST /v1/events` creates events from the UI (source='ui')
- `GET /v1/sync/status` powers the green/yellow/red health indicators
- Event response includes `mirrors[]` so the UI can show per-account
  projection status

**No Phase 1 changes needed.** The API surface is ready.

### Extension Point 2: MCP Server (Phase 2)

**Attachment surface:** UserGraphDO RPC interface

The MCP worker calls the same DO methods the api-worker calls:
- `upsertCanonicalEvent(event, source='mcp')`
- `listCanonicalEvents(query)`
- `computeAvailability(query)`
- `recomputeProjections(scope)`

The `source` field in the event journal distinguishes MCP-originated changes
from API or provider changes. The MCP server adds no new data paths -- it is
an alternative entry point to the same canonical store.

**No Phase 1 changes needed.** DO RPC interface supports MCP from day one.

### Extension Point 3: Trip / Constraint System (Phase 2)

**Attachment surface:** `constraints` table in UserGraphDO + policy compiler

Trips are constraints that generate derived projections:
1. User adds trip via API/MCP: `POST /v1/constraints` with kind='trip'
2. UserGraphDO stores constraint in `constraints` table
3. Policy compiler treats trip as a synthetic canonical event
4. Standard projection + mirror pipeline creates busy blocks across accounts

The `constraints` table exists in the Phase 1 schema but is not populated.
The policy compiler needs a small extension to process constraint-derived
events alongside provider-origin events.

**Phase 1 preparation:** Schema is in place. Policy compiler needs a
`constraint -> canonical event` derivation step added in Phase 2.

### Extension Point 4: Sync Status Dashboard (Phase 2)

**Attachment surface:** `GET /v1/sync/status` + event journal

The dashboard consumes:
- Aggregate and per-account health from sync status endpoint
- Recent journal entries for timeline view of sync activity
- Mirror error counts for problem identification

**No Phase 1 changes needed.** Sync status API is ready.

### Extension Point 5: Scheduling System (Phase 3+)

**Attachment surface:** UserGraphDO.computeAvailability() + SchedulingWorkflow

The scheduler needs:
- Unified availability across all accounts (Phase 1 DO method)
- Constraints table (Phase 1 schema)
- Scheduling session tables (Phase 1 schema, unpopulated)
- GroupScheduleDO for multi-user coordination (Phase 3)

**Phase 1 preparation:** Availability computation and constraints schema
exist. SchedulingWorkflow and GroupScheduleDO are Phase 3 deliverables.

### Extension Point 6: Relationship Graph (Phase 4)

**Attachment surface:** `relationships`, `interaction_ledger`, `milestones`
tables + event journal

The relationship layer reads:
- Canonical events to detect interactions with participants
- Event journal to see historical patterns
- Trip constraints for geo-aware reconnection suggestions

**Phase 1 preparation:** Schema tables exist. Participant hashes are
computed using SHA-256(email + per-org salt) from the start, so the
identifier format is consistent from day one.

---

## 11. Key Design Decisions and Rationale

### Why cursor-based pagination, not offset-based?

Offset pagination breaks when data changes between pages (events created or
deleted during pagination). Cursor-based pagination provides stable iteration.
The cursor is an opaque token encoding the last-seen ULID.

### Why ULIDs, not UUIDs?

ULIDs are time-sortable. This means:
- `canonical_event_id` values sort chronologically by creation time
- Journal entries sort naturally
- Cursor pagination works without a separate sort column
- Human-readable when debugging (first 10 chars encode timestamp)

### Why prefixed IDs (evt_, acc_, pol_)?

When an operator sees `evt_01HXYZ...` in a log or error message, they
immediately know it refers to a canonical event, not an account or policy.
This eliminates ambiguity in debugging, especially in queue messages that
reference multiple entity types.

### Why a separate ProjectedEvent shape?

The projected payload is what actually gets written to Google Calendar API.
It is a pure function of (canonical event, policy edge, target calendar kind).
By making it a distinct type, we enforce that projection is deterministic and
testable -- the policy compiler takes typed input and produces typed output.

### Why mirror state in the event response?

In Phase 2, the UI needs to show "this event is synced to Account B (green)
and pending for Account C (yellow)". Embedding mirror state in the event
response means the UI does not need a separate API call to build this view.

### Why envelope all responses?

The `{ok, data, error, meta}` envelope means:
- Clients check `ok` before processing (no ambiguous 2xx-with-error patterns)
- `meta.request_id` enables support conversations ("my request_id was req_01H...")
- Error structure is always the same, regardless of HTTP status code
- Adding fields to `meta` (rate limit info, deprecation warnings) is
  backward-compatible

---

## 12. Open Design Questions (To Resolve in Phase 1)

1. **API Authentication scheme:** Session tokens, JWT, or Cloudflare Access?
   Decision affects the OAuth flow (step 9 redirect target), API middleware,
   and Phase 2 UI authentication.

2. **Recurring event handling depth:** Do we mirror individual RRULE instances
   or the recurrence pattern? This affects the canonical event schema (single
   row vs expanded instances) and mirror write volume.

3. **Rate limiting strategy for our own API:** Per-user? Per-account? Token
   bucket or fixed window? This shapes the api-worker middleware design.

4. **Conflict resolution for overlapping events:** Phase 1 defaults to "allow
   overlaps, just reflect" (as recommended in dialog.txt). But the API should
   surface overlap information so Phase 2 UI can warn users.

5. **Event journal retention:** How long to keep journal entries? Indefinite
   retention supports Phase 4 relationship analysis but requires storage
   management. Consider a tiered approach: hot journal in DO SQLite,
   cold archive in R2.
