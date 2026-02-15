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

---

## [Added from Epic TM-as6 retro - 2026-02-14]

### E2E tests must register users upfront to avoid rate limit quota conflicts

**Priority:** Critical

**Context:** E2E validation (TM-as6.10) discovered that /register endpoint has 5/hr/IP rate limit. E2E tests that register users during individual test cases quickly exhaust the quota, causing cascading failures.

**Recommendation:** For E2E tests against rate-limited endpoints:
- Register all needed users in beforeAll (shared test fixture)
- Store credentials in test context for reuse across test cases
- Rate limit testing MUST happen AFTER user registration
- Document rate limit quotas in E2E test setup comments

**Applies to:** All E2E test stories for Phase 2B (MCP), 2C (Web UI), 2D (Trips)

**Source stories:** TM-as6.10

### JWT iat second precision causes identical tokens; tests need >1s delay

**Priority:** Important

**Context:** E2E validation (TM-as6.10) discovered that JWT iat timestamp uses second precision. Two JWTs generated within the same second for the same user are byte-identical, breaking tests that compare old vs new tokens.

**Recommendation:** For tests that generate multiple JWTs for the same user:
- Include `await new Promise(r => setTimeout(r, 1100))` between generations
- OR use explicit iat parameter in test JWT creation (if supported)
- Document this timing requirement in test comments
- Consider using millisecond-precision iat in production (requires JWT library support)

**Applies to:** All auth-related tests; Phase 2B MCP auth tests

**Source stories:** TM-as6.10

### wrangler dev D1 migrations must be applied manually

**Priority:** Important

**Context:** E2E validation (TM-as6.10) and multi-environment config (TM-as6.5) revealed that wrangler dev creates a fresh local D1 database on each restart. The api worker's wrangler.toml does not have migrations_dir set, so migrations must be applied separately via `wrangler d1 execute`.

**Recommendation:** For local development:
- Add `migrations_dir = "../../packages/shared/migrations"` to api worker wrangler.toml (consider pros/cons)
- OR document the manual migration step in README: `pnpm run migrate-local`
- E2E test setup MUST apply migrations before running tests
- Consider a make dev target that applies migrations + starts wrangler dev

**Applies to:** All Phase 2B, 2C, 2D stories with D1 schema changes

**Source stories:** TM-as6.10, TM-as6.5

### vitest.workspace.ts auto-merges; E2E tests need explicit test.projects override

**Priority:** Important

**Context:** E2E validation (TM-as6.10) discovered that vitest.workspace.ts is auto-detected and merged into any config. E2E tests were unintentionally running workspace unit tests.

**Recommendation:** For isolated test suites (E2E, performance, smoke):
- Use `test.projects` in vitest.config.ts to override workspace projects
- Explicitly define the test directory and exclude patterns
- Verify isolation with `pnpm run test:e2e -- --reporter=verbose`

**Applies to:** All E2E test stories; Phase 2B MCP E2E tests, Phase 2C UI E2E tests

**Source stories:** TM-as6.10

---

## [Added from Epic TM-4qw retro - 2026-02-14]

### Cross-Cutting Features Require Test Fixture Updates

**Priority:** Critical

**Context:** TM-4qw.6 (tier enforcement) broke pre-existing integration tests because they used free-tier JWTs. All write-tool tests needed premium-tier tokens. This caused a verification failure.

**Recommendation:** When implementing cross-cutting features (authentication, authorization, rate limiting, logging), the developer agent MUST:
1. Identify all existing tests that touch affected code paths
2. Update test fixtures to comply with new constraints
3. Verify zero regressions in the full integration suite

Do NOT assume existing tests will continue to pass unchanged. Cross-cutting features are special.

**Applies to:** All stories implementing auth, tier checks, rate limits, or other horizontal concerns

**Source stories:** TM-4qw.6

### Hardcoded Test Assertions Are Fragile

**Priority:** Important

**Context:** packages/d1-registry/src/schema.unit.test.ts:270 hardcoded ALL_MIGRATIONS.length. Noted by 3 separate developer agents (TM-4qw.2, TM-4qw.4, TM-4qw.6) but never fixed. Breaks every migration.

**Recommendation:** Avoid assertions that hardcode counts or lengths of dynamic arrays. Instead:
- Use `toBeGreaterThanOrEqual(expectedMinimum)` for growing arrays
- Or remove redundant tests (if another test already validates the structure)

Specific fix: replace `expect(ALL_MIGRATIONS).toHaveLength(N)` with a test that verifies the most recent migration exists in the array.

**Applies to:** All unit tests, especially schema/registry tests

**Source stories:** TM-4qw.2, TM-4qw.4, TM-4qw.6

### E2E Tests Should Be Self-Contained

**Priority:** Important

**Context:** TM-4qw.7 inlined JWT generation rather than importing from @tminus/shared. This made the E2E test file runnable with zero build-step dependencies.

**Recommendation:** E2E tests should minimize external dependencies:
- Inline utility functions (JWT generation, test data builders) if they're small
- Use fetch/http directly, not internal client libraries
- Avoid importing from @tminus/* packages (creates build coupling)

E2E tests are the "outside-in" validation layer. They should be runnable by a QA engineer who doesn't have the full monorepo build working.

**Applies to:** All E2E test files

**Source stories:** TM-4qw.7

---

## [Added from Epic TM-nyj retro - 2026-02-14]

### React Testing Library: Multi-Location Text Disambiguation

**Priority:** Important

**Context:** When building UIs with optimistic updates or multi-panel views (e.g., calendar + detail panel), the same text often appears in multiple DOM locations. Standard `getByText` becomes ambiguous and tests fail with "found multiple elements" errors. This pattern appeared in 4 stories during Phase 2C UI development.

**Recommendation:**
- **Default strategy:** Use `within(container)` scoping to limit queries to specific DOM regions
- **Fallback strategy:** Use `getAllByText` and index into the array, then close views before using `getByText`
- **Prevention strategy:** Use unique `data-testid` attributes for click targets in multi-location scenarios

**Applies to:** All UI stories involving optimistic updates, master/detail views, or multi-panel layouts

**Source stories:** TM-nyj.2, TM-nyj.7, TM-nyj.9, TM-nyj.10

---

### Fake Timers Require Explicit Async Advancement

**Priority:** Critical

**Context:** Components with async state updates (API calls, routing) AND timers (setTimeout, setInterval) require careful test orchestration. Standard `await waitFor()` is insufficient when fake timers are active. Multiple stories in Phase 2C struggled with test timeouts until this pattern was discovered.

**Recommendation:**
- Use `vi.advanceTimersByTimeAsync(0)` after EACH user action or navigation to flush both:
  1. Promise microtasks (API responses)
  2. Timer callbacks (routing, status auto-clear)
- Expect to need TWO separate flushes for complex flows (e.g., login: one for API response, one for route change + data load)
- When using `userEvent.setup()` with fake timers causes timeouts, fall back to synchronous `fireEvent.click()`
- For hash-based routing in jsdom, manually dispatch `HashChangeEvent` after setting `window.location.hash`

**Applies to:** All UI integration tests involving async state + timers

**Source stories:** TM-nyj.9, TM-nyj.10

---

### React 19 + Testing Library Setup Requirements

**Priority:** Important

**Context:** React 19 has stricter behavior around event handling and style mutations compared to React 18. Phase 2C was the first epic using React 19, and several patterns needed adjustment.

**Recommendation:**
- Always call `userEvent.setup()` OUTSIDE test functions (in beforeEach or at module level)
- Use `@vitejs/plugin-react` in vitest.config.ts for proper JSX transformation
- Avoid mixing CSS shorthand properties (border, margin, padding) with specific properties (borderColor, marginTop) in the same style object -- React 19 warns about "Removing style property during rerender"
- Use granular properties: `borderWidth`/`borderStyle`/`borderColor` instead of `border`

**Applies to:** All React 19 component tests using Testing Library

**Source stories:** TM-nyj.2

---

### ISO Datetime Format Consistency in Tests

**Priority:** Important

**Context:** API helpers that normalize datetime strings (stripping `Z` suffix or normalizing to UTC) cause test failures when assertions compare raw ISO strings with normalized strings. This caused form round-trip mismatches in event editing tests.

**Recommendation:**
- Tests must use the SAME datetime format as the API contract (if API returns `2024-01-01T10:00:00Z`, tests must assert with `Z` suffix)
- Helper functions that normalize datetimes (extractDatePart, extractTimePart) should be documented with their exact format behavior
- When building test fixtures, extract datetime strings from the API response format, not from hardcoded assumptions

**Applies to:** All tests involving datetime comparisons (event creation, editing, constraints)

**Source stories:** TM-nyj.7

---

### Comprehensive E2E Validation Resolves Cumulative Test Instability

**Priority:** Important

**Context:** Accounts.test.tsx exhibited timeouts in TM-nyj.7 (17 tests failing), but passed reliably in TM-nyj.10 (47 tests passing). The resolution came from cumulative fixes across multiple stories, not a single targeted fix.

**Recommendation:**
- Always include a comprehensive E2E validation story at the END of UI epics
- E2E stories should exercise full user journeys (login -> view -> create -> edit -> delete -> logout)
- These stories expose integration issues that unit/component tests miss (fake timer interactions, routing edge cases, async flush ordering)
- E2E stories validate that cumulative fixes across multiple stories have resolved test instability

**Applies to:** All UI epics

**Source stories:** TM-nyj.7, TM-nyj.10

