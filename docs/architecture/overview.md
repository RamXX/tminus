# Architecture Overview

**Status:** Active Development (Phases 1-5)
**Last Updated:** 2026-02-18

T-Minus is a Cloudflare-native platform that federates multiple external
calendar providers (Google, Microsoft, CalDAV) into a canonical coordination
layer, projects policy-shaped updates outward, and layers scheduling
intelligence, relationship awareness, and time governance on top.

---

## Core Product Model

T-Minus is a stateful calendar graph per user:

1. **Ingest** changes from connected external providers.
2. **Maintain** a canonical "Unified Calendar" (source of truth).
3. **Project** canonical state out to multiple provider calendars using a policy compiler (busy/title/full, per direction).
4. **Support** planning features not native to Google Calendar: trips that block time across all accounts, override/exception events, constraint-based scheduling, multi-party coordination.
5. **Provide** an MCP server so AI assistants can do all of the above programmatically.

## Federated Coordination Model

T-Minus is the **System of Coordination**:

- Canonical event graph, policy graph, and journal live in T-Minus.
- External providers remain systems of execution and user-facing surfaces.
- Sync is peer-to-peer through canonical state, not "Google as primary."
- Authority is policy-based (busy/title/full; directional edges), not implied by provider.

Current implementation note:

- The current onboarding/sync path is still effectively single-calendar per
  account (`primary` calendar in provider APIs).
- Target architecture is selected multi-calendar scopes per account with
  per-calendar cursors and per-calendar webhook/subscription routing.

## Architectural Principle

Canonical-first, eventual projection. All mutations flow through the canonical
event store first, produce a journal entry, then project outward via queues.
The UI can show "projection status per account" (green/yellow/red).

## System Topology

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
+-----------+    +-----------+            +-----------+
| webhook   |    | oauth     |            | cron      |
| worker    |    | worker    |            | worker    |
+-----------+    +-----------+            +-----------+
    |                |                        |
    | enqueue        | create account         | channel renewal
    | SYNC_INCR.     | + start onboarding     | token refresh
    v                v                        | reconciliation
+-----------+  +-------------+                v
| sync-queue|  | D1 Registry |        +--------------+
+-----------+  +-------------+        |reconcile-queue|
    |                                 +--------------+
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

## Cloudflare Building Blocks

| Building Block | Role in T-Minus |
|----------------|-----------------|
| Workers | Stateless edge APIs: auth, webhook, API, MCP, cron, consumers |
| Durable Objects | Stateful coordinators: UserGraphDO, AccountDO, GroupScheduleDO |
| DO SQLite | Per-user and per-account persistent storage (colocated compute) |
| D1 | Cross-user registry (users, accounts, orgs, deletion certs) |
| Queues | Async pipelines: sync-queue, write-queue, reconcile-queue |
| Workflows | Long-running orchestration: onboarding, reconciliation, scheduling |
| R2 | Audit logs, commitment proof exports, debug traces |

## Service Layout

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

AccountDO           SQLite     idFromName(account_id)     Token management, sync cursor(s), watch
                                                          channel/subscription lifecycle, rate limiting

GroupScheduleDO     SQLite     idFromName(session_id)     Multi-user scheduling sessions (Phase 3+)
```

### Workflow Definitions

```
Workflow               Trigger                        Steps
--------------------   ----------------------------   ----------------------------------
OnboardingWorkflow     oauth-worker (account link)    1. Fetch calendar list
                                                      2. Select sync scope (target: 1+ calendars)
                                                      3. Create busy overlay calendar
                                                      4. Paginated full event sync across scoped calendars
                                                      5. Register watch channel/subscription per scoped calendar
                                                      6. Store initial sync cursor(s)
                                                      7. Mark account active in D1

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

## Technology Choices

### Language and Runtime

- **TypeScript** for all Workers, Durable Objects, and Workflows.
- **Cloudflare Workers runtime** (V8 isolates). No Node.js APIs unless polyfilled by the runtime.
- Target **ES2022** for modern language features.

### ID Generation

- **ULID** (Universally Unique Lexicographically Sortable Identifier) for all primary keys.
- ULIDs are time-ordered, benefiting index performance and providing implicit creation timestamps.
- UUIDs (v4) for watch channel IDs (Google convention).

### Schema Migrations

- DO SQLite schemas are applied on first access after deployment. Each DO maintains a `schema_version` value and runs migrations forward on wake-up.
- D1 migrations use standard SQL migration files applied via `wrangler d1 migrations apply`.

### Error Handling

- **Dead Letter Queues (DLQ):** Both sync-queue and write-queue configure a DLQ. Messages that fail after max_retries are moved to the DLQ for manual inspection.
- **Error states in mirrors:** `event_mirrors.state = 'ERROR'` with `error_message` captures persistent write failures.
- **Sync state tracking:** `AccountDO.sync_state.last_success_ts` enables alerting on stale accounts.

## Related Documentation

- [Data Model](data-model.md) -- D1 and DO SQLite schemas
- [Data Flows](data-flows.md) -- Key flows in detail
- [Queue Contracts](queue-contracts.md) -- Queue message types
- [Correctness Invariants](correctness-invariants.md) -- Non-negotiable invariants
- [Platform Limits](platform-limits.md) -- Cloudflare resource limits
- [Architecture Decision Records](../decisions/) -- ADR-001 through ADR-008
