# Cloudflare Platform Limits

All limits verified against Cloudflare documentation as of 2026-02-13.

---

## Resource Limits

| Resource | Limit | T-Minus Impact |
|----------|-------|----------------|
| DO SQLite storage per object | 10 GB (paid plan) | Primary per-user store. 10 GB per user is ample. |
| DO SQLite storage per account | Unlimited (paid plan) | No ceiling on total users. |
| DO classes per account | 500 (paid) / 100 (free) | We need 3 classes (Phase 1-2), 4 max. Well within. |
| DO throughput per instance | ~1,000 req/s (soft limit) | Sufficient for single-user operations. |
| DO CPU per invocation | 30s default, 5 min configurable | Configure to 300,000ms for sync operations. |
| DO SQLite max row/string size | 2 MB | Event data well within. Journal patches could grow. |
| DO SQLite max columns per table | 100 | Our widest table has ~20 columns. |
| Worker memory | 128 MB | Prevents Z3 WASM in-process ([ADR-003](../decisions/adr-003-no-z3-mvp.md)). |
| Worker CPU per request | 30s default, 5 min configurable | Configure consumers for longer processing. |
| Worker size (compressed) | 10 MB (paid plan) | Monitor bundle size with shared package. |
| Worker subrequests | 10,000 default, up to 10M | Sufficient for sync operations. |
| Queue message size | 128 KB | Projected payloads must stay compact. |
| Queue throughput per queue | 5,000 msg/s | More than sufficient for our scale. |
| Queue max consumer concurrency | 250 | Auto-scales. Configurable via max_concurrency. |
| Queue max batch size | 100 messages | Configure per consumer based on workload. |
| Queue consumer wall clock | 15 minutes | Sufficient for batch processing. |
| Queue max retries | 100 | Configure DLQ for persistent failures. |
| Queues per account | 10,000 | We need 3 queues. Plenty of room. |
| D1 database size | 10 GB (cannot increase) | Registry only. Will not approach this limit. |
| D1 databases per account | 50,000 | One registry DB is sufficient. |
| Workflow concurrent instances | 10,000 (paid, as of Oct 2025) | Sufficient for onboarding + reconciliation. |
| Workflow steps per instance | 1,024 (sleep steps excluded) | Sufficient for all workflow definitions. |
| Workflow step timeout | 30 minutes max recommended | Use waitForEvent for longer waits. |
| Workflow step return size | 1 MiB | Store large results in R2, return reference. |
| Workflow creation rate | 100 instances/second | Sufficient for daily reconciliation dispatch. |
| R2 object size | 5 GB (multipart) | Audit logs, proof exports. |

---

## How the Architecture Respects These Limits

**DO CPU:** Sync operations that process large batches of events configure
`limits.cpu_ms = 300000` (5 minutes). Normal operations complete in
milliseconds.

**Queue message size:** Projected payloads are kept compact by design
([ADR-004](../decisions/adr-004-busy-overlay-default.md): busy overlay = minimal fields).
FULL-level projections truncate descriptions if approaching the limit.

**Worker memory:** Z3 is excluded from in-process execution
([ADR-003](../decisions/adr-003-no-z3-mvp.md)). All Workers stay well under 128 MB.

**D1 size:** Only registry data lives in D1. Per-user data lives in DO SQLite.
Even with 100,000 users, registry data would be a few hundred MB.

**Workflow concurrency:** Daily reconciliation dispatches one workflow per
active account. With 10,000 concurrent instance limit, this supports up to
10,000 accounts reconciling simultaneously.
