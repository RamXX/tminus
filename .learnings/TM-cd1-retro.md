# TM-cd1 Retro: API Worker & REST Surface

Date: 2026-02-14
Epic: TM-cd1 (API Worker & REST Surface)
Stories: 1 (TM-cns)
Outcome: Accepted first try, 62 tests (35 unit + 27 integration), 513 monorepo total

## Critical Insights

### SECURITY: JWT_SECRET Rotation
**Priority:** Critical (Phase 2)
Single static secret with no rotation mechanism. Need key versioning before production.
Action: Track as Phase 2 story. Document as known gap in E2E validation.

### SECURITY: No Rate Limiting
**Priority:** Critical (Phase 2)
API endpoints lack per-user rate limiting. Easy DOS vector. AccountDO could enforce per-account quotas.
Action: Track as Phase 2 story. Document as known gap in E2E validation.

## Important Insights

### TESTING: createRealD1() Pattern
**Priority:** Important
better-sqlite3 backed D1 helper catches SQL errors, constraint violations, and schema issues that mocks hide. Currently duplicated in 3 test files (webhook, cron, api).
Action: Next integration test author should extract to packages/shared/src/testing-utils.ts.

### PROCESS: ID Format Strictness (ULID)
**Priority:** Important
ULID format: exactly 26 Crockford Base32 chars after 4-char prefix (e.g., evt_ + 26 chars = 30 total). Malformed IDs in test fixtures caused cascading test failures.
Action: Establish ID generation helpers (ulid(), prefixedId()) in shared package early. All test fixtures must use valid format.

### PROCESS: AC Verification Tables
**Priority:** Important
Format: AC # | Requirement | Code Location | Test Location | Status.
Builds confidence, speeds acceptance reviews.
Action: Standard delivery evidence for all stories.

## Useful Patterns

### Web Crypto API for Workers
No external JWT/crypto libraries needed. crypto.subtle works for HS256, SHA-256 hashing, etc. Keeps bundle small, reduces supply chain risk.

### Envelope-First API Design
Consistent {ok, data, error, meta} with request_id and timestamp. Error taxonomy: AUTH_REQUIRED, FORBIDDEN, NOT_FOUND, CONFLICT, VALIDATION_ERROR. Simplifies client SDK generation.

### DO Communication Pattern
stub.fetch() with JSON body containing action field + DO internal routing. Clean and testable.

### Route Param Extraction
Simple path splitting, no regex. Testable and predictable.
