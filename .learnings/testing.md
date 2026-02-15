# Testing Learnings

Insights related to test coverage, test types, and testing methodology.

## Critical Insights

---

## [Added from Epic TM-9ue retro - 2026-02-15]

### Integration Test Migrations Must Mirror Production Schema

**Priority:** Critical

**Context:** When multiple stories in an epic add database migrations concurrently, integration test setups in Story A fail when Story B's migration is merged. TM-jfs.2 tests failed because TM-jfs.3 added MIGRATION_0013_SUBSCRIPTION_LIFECYCLE. This caused 28 test failures that were not from the story's code changes.

**Recommendation:**
1. Before delivering any story, run `git pull` and re-run ALL integration tests to catch merged migrations
2. Integration test setup helpers MUST apply ALL migrations from the migrations directory, not a hardcoded subset
3. Consider adding a CI step that fails if integration tests reference hardcoded migration lists

**Applies to:** All stories that add database migrations or introduce middleware that queries D1

**Source stories:** TM-jfs.2, TM-jfs.3

---

### Middleware Changes Require Mock Audit Across Test Suite

**Priority:** Critical

**Context:** Adding feature-gate middleware that queries the subscriptions table caused 28 pre-existing test failures in files unrelated to TM-jfs.3. The failures were caused by minimal mocks using `{} as D1Database`, which worked before middleware started querying D1 in every authenticated request.

**Recommendation:**
1. When adding middleware that queries D1/KV/DO, grep the test suite for `createMinimalEnv` or similar mock factories
2. Update ALL mock factories to include the new tables/bindings BEFORE delivering the story
3. Run the FULL test suite (not just the story's new tests) before delivery to catch ripple effects
4. Consider creating a "realistic test env" helper that includes all tables, deprecating `{}` type assertions

**Applies to:** All stories that add middleware or modify request handling pipeline

**Source stories:** TM-jfs.3

---

### Integration Test Config Must Be Explicit in Story ACs

**Priority:** Critical

**Context:** Both TM-jfs.2 and TM-jfs.3 had multiple verification failures because integration tests require `--config vitest.integration.config.ts` but the workspace config excludes `*.integration.test.ts`. This caused tests to silently not run, passing verification incorrectly.

**Recommendation:**
1. All stories with integration tests MUST include in ACs: "Run integration tests with: `vitest --config vitest.integration.config.ts`"
2. Consider adding a CI job that explicitly runs integration tests separately from unit tests
3. Developers should verify integration tests ran by checking test count (e.g., "62 tests" not "40 tests")

**Applies to:** All stories with integration tests in Workers/API

**Source stories:** TM-jfs.2, TM-jfs.3

## Important Insights

---

## [Added from Epic TM-gj5 retro - 2026-02-14]

### Date/time test assertions must normalize ISO string formats

**Priority:** Important

**Context:** ISO string format differences between Date.toISOString() (always includes .000 milliseconds) and user input (may omit milliseconds) caused test assertion brittleness. Tests comparing ISO strings from different sources would fail despite semantic equivalence.

**Recommendation:**
1. Create a canonical ISO string normalization utility for test assertions: `normalizeISOString(str)` that ensures consistent millisecond handling (either always include .000 or always strip it)
2. Use this utility in all test assertions that compare ISO 8601 date strings
3. Consider using it in production code that compares dates from different sources (API input vs database vs Date objects)
4. Document this pattern in the testing guidelines

**Applies to:** All date/time handling tests, particularly in availability computation, constraint evaluation, and API input validation

**Source stories:** TM-gj5.2

### Schema migration tests must use dynamic version expectations

**Priority:** Important

**Context:** Schema integration tests used hardcoded version numbers (e.g., `expect(version).toBe(1)`), which break when new migrations are added. This creates unnecessary test churn and false failures when migrations are added to the schema.

**Recommendation:**
1. All schema version assertions should use `MIGRATIONS[MIGRATIONS.length - 1].version` or similar dynamic reference to the latest migration
2. Update existing schema tests to follow this pattern
3. Add this to the testing guidelines for D1/SQLite schema work
4. Consider a test helper: `expectLatestSchemaVersion(actualVersion)` that encapsulates this pattern

**Applies to:** All schema migration tests, both D1 and DO SQLite schema integration tests

**Source stories:** TM-gj5.1

---

## [Added from Epic TM-9ue retro - 2026-02-15]

### API Responses Should Include Client Display Fields

**Priority:** Important

**Context:** accountLimitResponse includes both `usage.accounts` (current count) and `usage.limit` (tier limit) so clients can display "2/2 accounts used" without duplicating tier limit logic.

**Recommendation:**
1. When designing API responses for quota/limit features, include BOTH current usage AND limit in the response
2. This prevents clients from duplicating business logic about tier limits
3. Makes the API self-documenting and easier to consume

**Applies to:** All API endpoints that return quota/limit/usage information

**Source stories:** TM-jfs.2

## Nice-to-have Insights

---

## [Added from Epic TM-gj5 retro - 2026-02-14]

### ULID test helper needs character set documentation

**Priority:** Nice-to-have

**Context:** Crockford Base32 ULID validation is strict - it only accepts [0-9A-HJKMNP-TV-Z] (excludes I, L, O, U to avoid confusion with 1, 1, 0, V). Test IDs must be exactly 26 characters after the prefix. This isn't well-documented in the testing utilities, so developers discover it through test failures rather than upfront guidance.

**Recommendation:**
1. Add JSDoc comment to ULID test helper functions documenting the Crockford Base32 character set restriction
2. Consider adding a validation helper that returns a clear error message when invalid characters are used: `validateTestULID(id)` with message like "Invalid character 'I' in ULID - Crockford Base32 excludes I, L, O, U"
3. Include example valid test IDs in the testing guide (e.g., "TM-gj5.1" is valid, "TM-gj5.I" would fail)

**Applies to:** All tests that create or validate ULIDs (constraints, events, accounts, any entity with ULID primary keys)

**Source stories:** TM-gj5.1

---

## [Added from Epic TM-9ue retro - 2026-02-15]

### Pre-Existing Test Failures Should Be Tracked Separately

**Priority:** Nice-to-have

**Context:** Both TM-jfs.2 and TM-jfs.3 observed pre-existing test failures (UnifiedCalendar.test.tsx had 4 failing tests, billing.integration.test.ts had issues). These were noted in OBSERVATIONS but not blocking.

**Recommendation:**
1. When discovering pre-existing test failures, log them as separate bug stories (not blocking the current story)
2. Include the observation in LEARNINGS so PM/Sr. PM can decide whether to fix immediately or defer
3. Consider a "test debt" label for tracking these

**Applies to:** All stories where developers observe pre-existing issues

**Source stories:** TM-jfs.2, TM-jfs.3
