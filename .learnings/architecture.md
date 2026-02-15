# Architecture Learnings

Insights related to system design, patterns, and technical decisions.

## Critical Insights

(None yet)

## Important Insights

---

## [Added from Epic TM-gj5 retro - 2026-02-14]

### Timezone-aware date calculations require scan windows beyond query range

**Priority:** Important

**Context:** When implementing working hours constraints with timezone awareness, we discovered that timezone calculations need scan windows that extend beyond the requested date range. For example, Pacific time 9am on one day could be UTC time on the previous day due to UTC offset. If you only scan the exact query range, you'll miss relevant time windows.

**Recommendation:**
1. When implementing timezone-aware date range calculations, always use a scan window that extends 1 day before and 1 day after the requested range
2. Document this pattern in PLAN.md as "Timezone Calculation Pattern" for future reference
3. Apply this pattern to all constraint types that involve timezone-aware time windows (working hours, no-meetings-after, etc.)
4. In computeAvailability() and similar functions, clearly comment why the scan window extends beyond the query range

**Applies to:** All timezone-aware date range calculations, particularly in availability computation, constraint evaluation, and any feature that deals with working hours or time-of-day restrictions

**Source stories:** TM-gj5.2

---

## [Added from Epic TM-9ue retro - 2026-02-15]

### Feature Lifecycle Needs Operational Enforcement Stories

**Priority:** Important

**Context:** TM-jfs.3 implemented grace_period_end column and state transitions, but there's no cron job to actually enforce grace period expiration. Users in grace period will stay there indefinitely until manual intervention.

**Recommendation:**
1. When designing features with time-based state transitions (grace periods, trials, expiration), ALWAYS include a corresponding cron/operational story in the epic
2. Sr. PM should validate that lifecycle features have enforcement mechanisms during D&F
3. For this specific case, create a follow-up story: "Cron job to enforce grace period expiration and downgrade users"

**Applies to:** All features with time-based state machines (trials, grace periods, scheduled actions)

**Source stories:** TM-jfs.3

## Nice-to-have Insights

---

## [Added from Epic TM-gj5 retro - 2026-02-14]

### Document runtime API availability for implementation confidence

**Priority:** Nice-to-have

**Context:** During working hours implementation, there was uncertainty about whether Intl.DateTimeFormat was available in the Node.js 22 runtime used by Cloudflare Workers. It turned out to be available without polyfills, but this wasn't documented in project context, leading to implementation uncertainty and potential time spent researching.

**Recommendation:**
1. Create a "Runtime APIs Available" section in PLAN.md or a new RUNTIME.md document
2. Document known-available Node.js 22 APIs: Intl.DateTimeFormat, crypto, fetch, URL, etc.
3. Update this list as new APIs are discovered/used during development
4. Include notes about what is NOT available (e.g., file system APIs, process APIs)
5. Link to official Cloudflare Workers runtime compatibility documentation

**Applies to:** All feature implementations that might use Node.js built-in APIs, particularly for date/time, crypto, URL parsing, and international formatting

**Source stories:** TM-gj5.2

---

## [Added from Epic TM-946 retro - 2026-02-15]

### Missing DO RPC Routes Must Be Detected Early

**Priority:** Critical

**Context:** TM-946.1 discovered that /upsertCanonicalEvent and /deleteCanonicalEvent routes were missing from UserGraphDO despite being called by the API worker. The 100+ case handleFetch switch statement has no systematic route registry, making gaps easy to miss.

**Recommendation:**
1. Create a route registry test for UserGraphDO: iterate through all callDO() invocations in workers/api and verify each route exists in UserGraphDO's handleFetch switch
2. Consider refactoring handleFetch to use a route map pattern instead of a 100+ case switch statement
3. Add this test to the UserGraphDO test suite: `describe('Route registry completeness')`
4. Run this test in CI to catch missing routes before integration testing

**Applies to:** All DO RPC implementations, particularly UserGraphDO and future GroupScheduleDO

**Source stories:** TM-946.1

---

## [Added from Epic TM-lfy retro - 2026-02-15]

### Types used in offline queues must be Codable (not just Encodable)

**Priority:** Critical

**Context:** OfflineQueue and WatchConnectivity both serialize types to Data for persistence/transmission and deserialize them on drain/receive. Types marked Encodable-only fail at decode time with runtime errors.

**Recommendation:** For any request/response type that will be:
- Queued for offline retry (OfflineQueue)
- Sent via WatchConnectivity (WCSession)
- Cached locally with round-trip serialization

Mark as `Codable` (not just `Encodable`), even if the API client only encodes them. Add unit tests for round-trip encode/decode to catch this early.

**Applies to:** All API request types used in offline scenarios or cross-device sync

**Source stories:** TM-lfy.4, TM-lfy.5

---

### Optional constraints should use nil (not false) in JSON payloads

**Priority:** Nice-to-have

**Context:** SchedulingConstraints has optional Boolean fields. Using false for unset constraints creates ambiguity (is it "explicitly false" or "unset"?) and bloats payloads.

**Recommendation:** For API request types with optional Boolean constraints:
- Use `var field: Bool?` (not `var field: Bool = false`)
- Encode nil as omitted keys (JSON's natural representation of absence)
- Backend should treat missing keys as "constraint not specified"
- Document this pattern in API design guidelines

**Applies to:** All API request types with optional constraint fields

**Source stories:** TM-lfy.5
