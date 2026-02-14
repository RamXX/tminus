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

---

## [Added from Epic TM-852 retro - 2026-02-14]

### Standardize DO testing pattern with wrapper classes

**Priority:** Critical

**Context:** TM-a9h created the do-test-worker.ts wrapper pattern to bridge pure logic DOs with wrangler dev. This pattern is now validated and should be reused for all DO testing.

**Recommendation:** For all Durable Objects that use handleFetch() pattern (not extending DurableObject):
1. Create wrapper class extending DurableObject
2. Adapt ctx.storage.sql to SqlStorageLike interface
3. Delegate fetch() to logic.handleFetch()
4. Export wrapper from do-test-worker.ts for test reuse

**Applies to:** All DO integration tests, any new DOs added to the system

**Source stories:** TM-a9h

### Integration tests must be excluded from fast test suites

**Priority:** Critical

**Context:** scripts/vitest.config.mjs glob "**/*.test.ts" picked up *.integration.test.ts files, causing wrangler dev servers to spawn during fast test runs.

**Recommendation:** All vitest configs that define fast test suites MUST:
1. Set explicit `root` to scope glob patterns correctly
2. Add exclude pattern: `exclude: ["**/*.integration.test.ts", "**/*.real.integration.test.ts"]`
3. Document why integration tests are excluded (startup cost, credential requirements)

**Applies to:** All workspace packages with vitest configs, root-level test configs

**Source stories:** TM-a9h, TM-fjn

### Cross-worker integration requires programmatic simulation in local mode

**Priority:** Critical

**Context:** Local wrangler dev cannot run script_name DO bindings or cross-worker queue consumers. Attempting to test cross-worker flows in isolated wrangler dev fails silently or logs errors.

**Recommendation:** For integration tests that span multiple workers:
1. Use single do-test-worker hosting all DOs (do NOT start multiple wrangler dev instances)
2. Drive queue consumer logic programmatically (import and call handlers directly)
3. Document architectural decision in test file explaining why programmatic vs real queues
4. Reserve multi-worker wrangler dev for manual testing/debugging only

**Applies to:** All E2E tests, any test crossing worker boundaries

**Source stories:** TM-2vq, TM-3i0

### Real integration tests catch bugs unit tests miss

**Priority:** Important

**Context:** TM-a9h found missing /unlinkAccount route in UserGraphDO handleFetch via real DO tests. Unit tests didn't catch this because they mocked routing.

**Recommendation:** For critical paths (API endpoints, DO routes, queue handlers):
1. Unit tests prove logic correctness
2. Real integration tests prove routing/wiring correctness
3. Both are necessary; neither is sufficient alone
4. Document which bugs were caught by integration tests to justify their cost

**Applies to:** All critical user-facing features, all DO/Worker routing

**Source stories:** TM-a9h

### Credential-gated tests should skip gracefully with it.skipIf

**Priority:** Important

**Context:** TM-2vq used it.skipIf(!canRun) pattern. All 6 E2E tests skip gracefully when GOOGLE_TEST_REFRESH_TOKEN_A/B not set. Test reports show "6 skipped" clearly.

**Recommendation:** All integration tests requiring external credentials SHOULD:
1. Use `it.skipIf(!hasCredentials)` pattern (not it.skip or test.skip)
2. Log clear warning: "WARNING: <CREDENTIAL> not set. Skipping <test type> tests."
3. Document required credentials in test file header comment
4. Ensure skipped tests count in vitest reports (confirms test file was discovered)

**Applies to:** All tests requiring Google/Microsoft/external API credentials

**Source stories:** TM-2vq, TM-fjn

### Schema migration tests must assert content not counts

**Priority:** Important

**Context:** TM-swj added ACCOUNT_DO_MIGRATION_V2, breaking tests that asserted `migrations.length === 1`. Hard-coded counts are fragile.

**Recommendation:** Schema tests that verify migrations SHOULD:
1. Assert specific migration content (e.g., `migrations.find(m => m.version === 2).sql.includes('ALTER TABLE')`)
2. Avoid asserting exact migration counts unless testing migration ordering
3. If asserting count, use constant: `expect(migrations).toHaveLength(ACCOUNT_DO_MIGRATIONS.length)`

**Applies to:** All schema/migration tests, any code that iterates migrations

**Source stories:** TM-swj
