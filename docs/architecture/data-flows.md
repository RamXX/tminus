# Data Flows

This document details the key data flows in T-Minus. Each flow is described
step-by-step with actor, action, and the data exchanged.

---

## Flow A: Webhook-Triggered Incremental Sync

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

### Step-by-Step

| Step | Actor | Action |
|------|-------|--------|
| 1 | Google | Sends push notification to webhook-worker |
| 2 | webhook-worker | Validates X-Goog-Channel-Token against D1 accounts.channel_id. Validates X-Goog-Resource-State is known value. Enqueues SYNC_INCREMENTAL. Returns 200 immediately. |
| 3 | sync-consumer | Pulls message from sync-queue. Calls AccountDO.getAccessToken() and AccountDO.getSyncToken(). Fetches events.list(syncToken=...). On 410 Gone: enqueues SYNC_FULL, stops. For each returned event: classifies origin vs managed (check extendedProperties). If managed: check for drift, correct if needed (Invariant E). If origin: normalize to ProviderDelta shape. |
| 4 | sync-consumer | Calls UserGraphDO.applyProviderDelta(account_id, deltas[]) |
| 5 | UserGraphDO | For each delta (single-threaded, serialized): Upserts canonical_events. Bumps version if UPDATE. Writes event_journal entry. For each policy_edge where from_account == origin account: computes projected payload via policy compiler, hashes it (Invariant C), compares to event_mirrors.last_projected_hash, if different: enqueues UPSERT_MIRROR. Updates AccountDO sync cursor. |
| 6 | write-consumer | Pulls UPSERT_MIRROR from write-queue. Calls AccountDO.getAccessToken(target). Checks event_mirrors for existing provider_event_id: if exists: PATCH; if not: INSERT into busy overlay calendar. Updates event_mirrors with provider_event_id, last_projected_hash, last_write_ts, state='ACTIVE'. |

---

## Flow B: User Creates Event via UI/MCP

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

---

## Flow C: Onboarding (New Account Connected)

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

### Step-by-Step

| Step | Actor | Action |
|------|-------|--------|
| 1 | User | Initiates OAuth in UI. oauth-worker redirects to Google. |
| 2 | Google | User authorizes, redirects back with auth code. |
| 3 | oauth-worker | Exchanges code for tokens. Creates account in D1 registry. Creates AccountDO with encrypted tokens. Starts OnboardingWorkflow. |
| 4 | OnboardingWorkflow | Steps 1-5: Fetches calendar list, creates busy overlay calendar, paginates events, registers watch channel, stores syncToken, marks account active. |
| 5 | UserGraphDO | Processes deltas from step 4 same as Flow A. Enqueues initial mirror writes for all existing canonical events to the new account per policy. |

---

## Flow D: Daily Drift Reconciliation

```
  cron-worker (scheduled trigger)
         |
         v
  Query D1: all accounts where status = 'active'
         |
         v
  For each account:
    Enqueue RECONCILE_ACCOUNT to reconcile-queue
         |
         v
  ReconcileWorkflow
         |
         v
  Step 1: Full sync (no syncToken)
         |
         v
  Step 2: Cross-check:
    a) For each origin event in provider:
       Verify canonical_events has matching row
       Verify mirrors exist per policy_edges
    b) For each managed mirror in provider:
       Verify event_mirrors has matching row
       Verify projected_hash matches expected
    c) For each event_mirror with state='ACTIVE':
       Verify provider still has the event
         |
         v
  Step 3: Fix discrepancies:
    - Missing canonical: create it
    - Missing mirror: enqueue UPSERT_MIRROR
    - Orphaned mirror: enqueue DELETE_MIRROR
    - Hash mismatch: enqueue UPSERT_MIRROR
    - Stale mirror (no provider event): tombstone
         |
         v
  Step 4: Log all discrepancies to event_journal
          Update AccountDO.last_success_ts
          Store new syncToken
```

---

## Flow E: Cron Maintenance Cycle

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
         +---> Drift Reconciliation (see Flow D)
               Enqueue SYNC_FULL for all active accounts
```
