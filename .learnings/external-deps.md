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

---

## [Added from Epic TM-9ue retro - 2026-02-15]

### Spell-Check External API Mappings

**Priority:** Important

**Context:** Stripe uses "canceled" (American spelling) but T-Minus DB schema uses "cancelled" (British spelling). This required explicit statusMap mapping in handleSubscriptionUpdated. Easy to miss if not careful.

**Recommendation:**
1. When integrating external APIs (Stripe, Google, etc.), explicitly document spelling differences in code comments
2. Create a mapping layer (like statusMap) rather than storing raw API values directly
3. Add integration tests that verify the mapping (e.g., Stripe "canceled" → DB "cancelled")

**Applies to:** All stories integrating external APIs with enum/status fields

**Source stories:** TM-jfs.3
