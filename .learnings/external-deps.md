# External Dependencies Learnings

This file captures insights about third-party libraries, APIs, and platform constraints that affect development.

---

## [Added from Epic TM-4qw retro - 2026-02-14]

### D1 Does Not Support Parameterized Array Bindings

**Priority:** Important

**Context:** TM-4qw.4 discovered D1 doesn't support parameterized array bindings for IN clauses (e.g., `WHERE account_id IN (?)`). This is a Cloudflare D1 platform limitation.

**Recommendation:** For all D1 queries that need to filter by multiple IDs:
1. Use the primary filter (user_id, time range) in SQL
2. Filter by ID list in JavaScript using `results.filter(row => ids.includes(row.id))`
3. Document this pattern in code comments

For the typical case (2-5 accounts, <100 events), this is negligible overhead. DO NOT try to build dynamic SQL strings with comma-separated values (SQL injection risk).

**Applies to:** All D1 queries with multi-ID filters (account_id, event_id, policy_id)

**Source stories:** TM-4qw.4
