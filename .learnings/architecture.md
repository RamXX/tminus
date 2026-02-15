# Architecture Learnings

## Web Crypto API for Workers Crypto (from TM-cd1)
**Priority:** Useful
**Source:** TM-cd1 retro

Use Web Crypto API (crypto.subtle) for all cryptographic operations in Workers:
- JWT HS256 signing/verification
- SHA-256 hashing (for projected_hash, idempotency keys)
- No external libraries needed (no jose, no jsonwebtoken)

Benefits: Smaller bundle, no supply chain risk, native runtime support.

## Envelope-First API Design (from TM-cd1)
**Priority:** Useful
**Source:** TM-cd1 retro

All API responses use consistent envelope:
```json
{
  "ok": true/false,
  "data": { ... },
  "error": { "code": "NOT_FOUND", "message": "..." },
  "meta": { "request_id": "...", "timestamp": "..." }
}
```

Error taxonomy: AUTH_REQUIRED, FORBIDDEN, NOT_FOUND, CONFLICT, VALIDATION_ERROR.

Benefits: Simplifies client SDK generation, consistent error handling.

## DO Communication Pattern (from TM-cd1)
**Priority:** Useful
**Source:** TM-cd1 retro

Durable Object interaction via stub.fetch() with JSON body:
```typescript
const stub = env.USER_GRAPH_DO.get(doId);
const response = await stub.fetch('http://do/rpc', {
  method: 'POST',
  body: JSON.stringify({ action: 'applyProviderDelta', payload: { ... } })
});
```

DO routes internally based on action field. Clean, testable, consistent.

---

## [Added from Epic TM-852 retro - 2026-02-14]

### Design for extension from the start

**Priority:** Important

**Context:** TM-swj added Microsoft provider support smoothly because CalendarProvider interface and D1 provider column already existed. No refactoring required.

**Recommendation:** When designing interfaces for external integrations (APIs, providers, services):
1. Define provider-agnostic interface even if only one implementation exists
2. Include provider type field in persistence layer
3. Create dispatch/factory pattern early (provider.ts pattern)
4. Document extension points in architecture docs
5. This aligns with UNIX principle #6: "Design with extension in mind"

**Applies to:** All external API integrations, multi-tenant features, pluggable components

**Source stories:** TM-swj

### Error responses at integration boundaries must handle non-JSON gracefully

**Priority:** Important

**Context:** DO returns plain text "Unknown action: /path" for 404s. rpcCall helper crashed when expecting JSON.

**Recommendation:** All RPC/HTTP client helpers that parse responses MUST:
1. Try JSON parse, catch SyntaxError
2. If non-JSON, return error object with raw text: `{ error: "Non-JSON response", body: rawText }`
3. Log warning if non-JSON received from expected JSON endpoint
4. Add test cases for 404, 500, plain text responses

**Applies to:** All HTTP clients, all RPC helpers, DO routing code

**Source stories:** TM-a9h

---

## [Added from Epic TM-as6 retro - 2026-02-14]

### Envelope encryption is O(1) rotation by design

**Priority:** Important

**Context:** DEK encryption production hardening (TM-1pc) revealed that AES-256-GCM key rotation only needs to re-encrypt the DEK wrapper, not the underlying token ciphertext. Token data is encrypted with the DEK, not the master key.

**Recommendation:** When implementing any envelope encryption pattern in future work (not just tokens), structure the system so:
1. Data is encrypted with a Data Encryption Key (DEK)
2. DEK is encrypted with a Master Key
3. Master key rotation = re-encrypt DEK wrapper only (O(1))
4. Backups need encrypted DEK + IV, not data ciphertext

This makes key rotation practical at scale.

**Applies to:** All encryption-at-rest stories, Phase 3+ sensitive data handling

**Source stories:** TM-1pc

### KV write rate limits require timestamp-in-key design for counters

**Priority:** Critical

**Context:** Rate limiting (TM-as6.3) discovered that KV has a 1-write-per-second-per-key limit. Fixed-window counters that embed the window timestamp in the key (rl:<identity>:<window_start>) avoid this limit because each window gets a unique key.

**Recommendation:** For any KV-based counter pattern (rate limiting, usage tracking, metrics):
- Embed the time window in the key itself (e.g., rl:user123:1634567890)
- Each window gets a unique key → no write rate limit conflict
- Use TTL for automatic cleanup (no manual sweeping needed)
- NEVER increment a single long-lived key repeatedly

**Applies to:** All rate limiting, usage tracking, metrics stories; Phase 3+ billing/metering

**Source stories:** TM-as6.3

### Progressive lockout counters accumulate; test isolation requires direct DB manipulation

**Priority:** Important

**Context:** Account lockout testing (TM-as6.4) revealed that progressive lockout counters persist across test runs. Once the first threshold is reached, subsequent failed attempts immediately re-lock after expiry because the counter continues accumulating.

**Recommendation:** For state machines with persistent counters (lockout, reputation, abuse detection):
- Integration tests MUST either:
  1. Set counter state directly in D1/DO storage before test (preferred)
  2. Simulate lock expiry + wait between attempts (slower)
- Do NOT rely on repeated API calls to reach higher thresholds (non-deterministic)
- Document the state transition table in test comments

**Applies to:** All state machine stories with persistent counters; Phase 4 reputation system

**Source stories:** TM-as6.4

---

## [Added from Epic TM-4qw retro - 2026-02-14]

### Schema Gaps Between D1 Registry and DO SQLite Must Be Anticipated

**Priority:** Critical

**Context:** TM-4qw.2 discovered that D1 registry accounts table was missing last_sync_ts and resource_id columns, which existed in AccountDO SQLite. MCP server needs these for sync health computation but can't service-bind to AccountDO (performance constraint). Required migration 0008.

**Recommendation:** When D&F designs a new feature that queries data:
1. Explicitly document which database holds the source of truth for each field
2. If MCP/API needs denormalized data from DOs, include the denormalization strategy in the D&F
3. For Phase 2 and beyond: assume MCP cannot service-bind to DOs for read queries (latency budget)

Future D&F should include a "Data Residency" section listing which fields live where and how they're synchronized.

**Applies to:** All D&F for features that query cross-cutting state (sync status, account metadata, policies)

**Source stories:** TM-4qw.2, TM-4qw.4

### D1 IN Clause Workaround Pattern

**Priority:** Important

**Context:** TM-4qw.4 discovered D1 doesn't support parameterized array bindings for IN clauses (e.g., `WHERE account_id IN (?)`). Workaround: query all rows matching user_id + time range, then filter by account_id in JavaScript.

**Recommendation:** For all D1 queries that need to filter by multiple IDs:
1. Use the primary filter (user_id, time range) in SQL
2. Filter by ID list in JavaScript using `results.filter(row => ids.includes(row.id))`
3. Document this pattern in code comments

For the typical case (2-5 accounts, <100 events), this is negligible overhead. DO NOT try to build dynamic SQL strings with comma-separated values (SQL injection risk).

**Applies to:** All D1 queries with multi-ID filters (account_id, event_id, policy_id)

**Source stories:** TM-4qw.4

---

## [Added from Epic TM-nyj retro - 2026-02-14]

### Hash-Based Router Should Strip Query Params

**Priority:** Nice-to-have

**Context:** The hash-based router in App.tsx does not strip query params before matching routes. OAuth callback handling required manual `route.split("?")[0]` to extract the base path, which is error-prone and should be handled centrally.

**Recommendation:**
- Update the hash router to automatically strip query params before route matching: `const routePath = route.split("?")[0]`
- This should be done in the base router logic, not in individual route handlers
- Preserves query params for use in route handlers while ensuring route matching is deterministic

**Applies to:** Hash-based routing infrastructure

**Source stories:** TM-nyj.9

