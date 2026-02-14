# Testing Learnings

## createRealD1() Pattern (from TM-cd1)
**Priority:** Important
**Source:** TM-cd1 retro

Use better-sqlite3 to create a real D1-compatible database for integration tests. The helper normalizes D1 positional params (?1 -> ?) for better-sqlite3 compatibility.

**Current state:** Duplicated in 3 files:
- workers/api/src/index.integration.test.ts
- workers/cron/src/cron.integration.test.ts
- workers/webhook/src/webhook.integration.test.ts

**Action:** Next developer writing integration tests should extract to packages/shared/src/testing-utils.ts.

**Why it matters:** Catches SQL errors, constraint violations, and schema issues that mocks would hide. Validated through 27 integration tests in TM-cd1.

## ID Format in Test Fixtures (from TM-cd1)
**Priority:** Important
**Source:** TM-cd1 retro

All T-Minus IDs are ULID format: 4-char prefix + 26 Crockford Base32 characters = 30 total.
Example: evt_01ARZ3NDEKTSV4RRFFQ69G5FAV

Do NOT use:
- 'test-account-1' (wrong format)
- 'acc_abc123' (too short)
- Any string that is not exactly 30 characters with valid Crockford Base32

**Why it matters:** Malformed IDs caused cascading test failures in TM-cd1.
