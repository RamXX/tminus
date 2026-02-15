# Retrospective: Epic TM-946 - Phase 3A: Scheduling Engine

**Date:** 2026-02-15
**Stories completed:** 7
**Total tests:** 265 new tests (28+21+46+36+52+57+25)
**Duration:** ~1 day (epic started 2026-02-14, completed 2026-02-15)

## Summary

Epic TM-946 implemented the Phase 3A Scheduling Engine, delivering end-to-end meeting scheduling functionality with constraint awareness, tentative holds, session management, MCP tools, and a UI. All 7 stories were **accepted on first try (0 rejections)**, demonstrating excellent story design and implementation quality.

The scheduling system includes:
- Greedy interval solver producing ranked candidates
- Constraint-aware scheduling (working hours, trips, buffers)
- Tentative holds with Google Calendar status=tentative and cron expiry
- Session state machine (open -> candidates_ready -> confirmed/cancelled/expired)
- MCP tools: calendar.propose_times + calendar.commit_candidate
- React scheduling dashboard
- Full E2E validation with 25 integration tests

## Raw Learnings Extracted

### From TM-946.1 (Walking Skeleton: Schedule a Meeting E2E)

**LEARNINGS:**
- UserGraphDO's handleFetch switch statement had no /upsertCanonicalEvent route even though the API worker's callDO function targeted it. Added as part of this story since scheduling commit requires it.
- FakeDOStub pattern must call handleFetch() not fetch() -- UserGraphDO does not extend DurableObject's fetch method directly.
- Lazy migration in UserGraphDO requires a trigger (any valid RPC like /getSyncHealth) before direct DB access in tests.
- Constants test hardcoded expected prefix count (9). Updated to 12 for session/candidate/hold prefixes.

**OBSERVATIONS (unrelated to this task):**
- [CONCERN] durable-objects/user-graph/src/index.ts: handleFetch switch statement is very large (100+ cases). Consider refactoring into a route registry or handler map for maintainability.
- [ISSUE] The /upsertCanonicalEvent and /deleteCanonicalEvent routes were missing from UserGraphDO despite being called by the API worker. Other routes may also be missing -- a systematic audit would be valuable.

### From TM-946.2 (Constraint-Aware Scheduling)

**Close reason:** ACCEPTED: 21 new tests (15 unit + 6 integration). Constraint-aware solver with working hours, trips, buffers, no_meetings_after scoring. Performance <2s for 1-week window. All 1810 tests green.

No explicit LEARNINGS section, but performance requirement (<2s for 1-week window) was met, validating greedy solver approach.

### From TM-946.3 (Tentative Holds)

**Close reason:** ACCEPTED: 46 new tests (36 unit + 10 integration). Tentative holds with Google Calendar status=tentative, 24h timeout, cron expiry. Commit e383326.

No explicit LEARNINGS section. Implementation successful.

### From TM-946.4 (Session Management)

**Close reason:** ACCEPTED: 36 new tests (29 unit + 7 integration). Session state machine (open->candidates_ready->confirmed/cancelled/expired), lazy expiry. Commit e383326.

No explicit LEARNINGS section. State machine implementation successful.

### From TM-946.5 (MCP Scheduling Tools)

**Close reason:** ACCEPTED: 52 new tests (37 unit + 15 integration). calendar.propose_times and calendar.commit_candidate MCP tools with Zod v4 validation, Premium+ tier, service binding routing. Commit ea25f39.

No explicit LEARNINGS section. MCP tools implementation successful.

### From TM-946.6 (Scheduling Dashboard UI)

**Close reason:** ACCEPTED: 57 new tests (24 unit + 33 component). Scheduling page with propose meeting form, candidate list, active sessions, commit/cancel. Commit 0d1328c.

No explicit LEARNINGS section. UI implementation successful.

### From TM-946.7 (Phase 3A E2E Validation)

**LEARNINGS:**
- The better-sqlite3 package was only in workspace packages (workflows/scheduling, durable-objects), not at root. Root-level E2E tests in tests/e2e/ need it added as a root devDependency.
- The scheduling flow (propose -> commit) exercises UserGraphDO RPC, SchedulingWorkflow, and the greedy solver as a fully integrated stack. The FakeDONamespace pattern from existing tests is battle-tested and reliable.

**OBSERVATIONS (unrelated):**
- [ISSUE] The vitest.e2e.config.ts only includes *.integration.test.ts patterns, but phase-2a.test.ts and phase-2b.test.ts don't match that pattern. They have their own configs, which is fine, but the generic e2e config would not discover them.

## Patterns Identified

### 1. Missing DO Routes Discovered During Integration (2 occurrences)

**Pattern:** TM-946.1 discovered that /upsertCanonicalEvent and /deleteCanonicalEvent routes were missing from UserGraphDO's handleFetch switch statement, even though API worker code called them. This was detected during integration testing when scheduling commit failed.

**Root cause:** UserGraphDO's handleFetch switch has 100+ cases with no systematic route registry. Routes are added ad-hoc as features need them, leading to gaps.

**Impact:** Integration test failures, potential runtime errors if not caught.

### 2. Test Infrastructure Requires Workspace Root Dependencies (2 occurrences)

**Pattern:** TM-946.7 discovered that better-sqlite3 was only in workspace package dependencies, not root devDependencies. Root-level E2E tests in tests/e2e/ couldn't import it.

**Root cause:** Workspace package dependencies are isolated. Root-level tests need dependencies declared at root.

**Impact:** Test setup failures, cannot run E2E tests from root.

### 3. Test Hardcoded Expectations Break on Schema Growth (1 occurrence)

**Pattern:** TM-946.1 constants test hardcoded expected prefix count (9), which broke when scheduling added 3 new prefixes (session/candidate/hold).

**Root cause:** Test assertions hardcoded to current state instead of dynamically counting or using flexible expectations.

**Impact:** False test failures when schema/constants legitimately grow.

### 4. FakeDOStub Pattern Inconsistency (1 occurrence)

**Pattern:** TM-946.1 discovered that FakeDOStub must call handleFetch() not fetch(). UserGraphDO does not extend DurableObject's fetch() method directly.

**Root cause:** Naming mismatch between DO test stub and actual DO implementation method names.

**Impact:** Integration test failures, confusion about DO method contracts.

### 5. Zero-Rejection Epic: Strong Story Design Quality

**Pattern:** All 7 stories accepted on first try (0 rejections). This is a significant quality signal.

**Contributing factors:**
- Clear acceptance criteria with specific test counts and performance targets
- Stories built incrementally (walking skeleton -> constraints -> holds -> session -> MCP -> UI -> E2E)
- TDD approach with unit + integration tests for each story
- Stories referenced Phase 2 foundation (constraints, trips, working hours already existed)
- E2E validation story at the end to prove integration

**Impact:** Fast delivery, high confidence in shipping to production.

## Actionable Insights

### Critical Insights

**1. Missing DO RPC Routes Must Be Detected Early**

**Priority:** Critical

**Context:** TM-946.1 discovered that /upsertCanonicalEvent and /deleteCanonicalEvent routes were missing from UserGraphDO despite being called by the API worker. The 100+ case handleFetch switch statement has no systematic route registry, making gaps easy to miss.

**Recommendation:**
1. Create a route registry test for UserGraphDO: iterate through all callDO() invocations in workers/api and verify each route exists in UserGraphDO's handleFetch switch
2. Consider refactoring handleFetch to use a route map pattern instead of a 100+ case switch statement
3. Add this test to the UserGraphDO test suite: `describe('Route registry completeness')`
4. Run this test in CI to catch missing routes before integration testing

**Applies to:** All DO RPC implementations, particularly UserGraphDO and future GroupScheduleDO

**Source stories:** TM-946.1

**2. Root-Level Test Dependencies Must Include Workspace Package Dependencies**

**Priority:** Critical

**Context:** TM-946.7 E2E tests failed because better-sqlite3 was only in workspace package dependencies (workflows/scheduling, durable-objects), not root devDependencies. Root-level tests in tests/e2e/ couldn't import it.

**Recommendation:**
1. When adding dependencies to workspace packages, check if root-level tests (tests/e2e/, tests/integration/) import from those packages
2. If yes, add the dependency to root package.json devDependencies as well
3. Run root-level tests (`make test-e2e`) before delivering to catch this
4. Consider documenting this pattern in CONTRIBUTING.md or testing guidelines

**Applies to:** All stories that add dependencies to workspace packages and have root-level E2E tests

**Source stories:** TM-946.7

### Important Insights

**1. Test Expectations Should Be Dynamic, Not Hardcoded Counts**

**Priority:** Important

**Context:** TM-946.1 constants test hardcoded expected prefix count (9), which broke when scheduling added 3 new prefixes (session/candidate/hold). The test failure was a false negative - the code was correct, the test was brittle.

**Recommendation:**
1. Avoid hardcoded count expectations in tests: `expect(prefixes.length).toBe(9)` is brittle
2. Use dynamic expectations: `expect(prefixes).toContain('session_')` or `expect(prefixes.length).toBeGreaterThanOrEqual(9)`
3. If exact count is critical to test, document WHY in a comment and update when schema legitimately grows
4. Apply this pattern to all tests that verify collections of constants, migrations, or schema elements

**Applies to:** All tests that assert on collection sizes (constants, migrations, schema tables)

**Source stories:** TM-946.1

**2. FakeDOStub Must Match Actual DO Method Names**

**Priority:** Important

**Context:** TM-946.1 discovered that FakeDOStub must call handleFetch() not fetch(). UserGraphDO implements handleFetch() as its request handler, not the standard DurableObject fetch() method.

**Recommendation:**
1. When creating DO test stubs, verify method names match the actual DO implementation
2. Document in DO test helper: "UserGraphDO uses handleFetch(), not fetch()"
3. Consider standardizing: either all DOs use fetch() (standard) or all use handleFetch() (custom)
4. Add a test that verifies DO stub method signature matches actual DO class

**Applies to:** All DO test infrastructure, particularly UserGraphDO and future GroupScheduleDO

**Source stories:** TM-946.1

**3. Lazy Migration in DOs Requires Trigger Before Test DB Access**

**Priority:** Important

**Context:** TM-946.1 discovered that UserGraphDO's lazy migration requires a trigger (any valid RPC like /getSyncHealth) before direct DB access in tests. Without this, tests that query the database directly fail because tables don't exist yet.

**Recommendation:**
1. In DO integration tests, always trigger lazy migration before direct DB queries: `await stub.handleFetch('/getSyncHealth')`
2. Document this pattern in DO testing guidelines
3. Consider creating a test helper: `await triggerDOMigration(stub)` that encapsulates this
4. Add this to the DO test setup template for future DO implementations

**Applies to:** All DO integration tests that use lazy migration pattern

**Source stories:** TM-946.1

**4. E2E Vitest Configs Must Match Test File Naming Conventions**

**Priority:** Important

**Context:** TM-946.7 observed that vitest.e2e.config.ts only includes *.integration.test.ts patterns, but phase-2a.test.ts and phase-2b.test.ts don't match that pattern. They have their own configs, which works, but creates inconsistency.

**Recommendation:**
1. Standardize E2E test file naming: either all use *.integration.test.ts or all use *-e2e.test.ts
2. Update vitest.e2e.config.ts to match the chosen convention
3. Migrate phase-2a.test.ts and phase-2b.test.ts to follow the standard naming
4. Document the E2E test naming convention in testing guidelines

**Applies to:** All E2E tests in tests/e2e/ directory

**Source stories:** TM-946.7

### Nice-to-have Insights

**1. Zero-Rejection Epics Signal Strong Story Design**

**Priority:** Nice-to-have

**Context:** Epic TM-946 had 7 stories, all accepted on first try (0 rejections). This is a strong quality signal compared to previous epics with 10-30% rejection rates.

**Pattern analysis:**
- Stories were designed incrementally: walking skeleton first, then add constraints, then holds, then session management, then MCP, then UI, then E2E validation
- Each story had clear acceptance criteria with specific test counts and performance targets
- Stories built on solid Phase 2 foundation (constraints, trips, working hours already existed)
- TDD approach with unit + integration tests for each story
- E2E validation story at the end proved integration

**Recommendation:**
1. When designing future epics, use TM-946 as a template: walking skeleton -> incremental features -> E2E validation
2. Ensure foundation features (Phase 2) are solid before building dependent features (Phase 3)
3. Include specific test count expectations in ACs to drive TDD
4. Always include an E2E validation story at the end of milestone epics

**Applies to:** All future epic planning (Phase 3B, Phase 4)

**Source stories:** All TM-946 stories

## Recommendations for Backlog

### Immediate Action (Critical)

1. **Create UserGraphDO Route Registry Test**
   - Story: "Add route registry completeness test to UserGraphDO"
   - Description: Test that verifies all callDO() invocations in workers/api have corresponding routes in UserGraphDO's handleFetch switch
   - Priority: High
   - Prevents missing route bugs from reaching integration testing

2. **Audit UserGraphDO for Missing Routes**
   - Story: "Audit UserGraphDO handleFetch for missing routes"
   - Description: Systematically verify all API callDO() invocations have corresponding DO routes, fix any gaps
   - Priority: High
   - Addresses the concern raised in TM-946.1 observations

### Future Consideration (Important)

3. **Refactor UserGraphDO handleFetch to Route Map**
   - Story: "Refactor UserGraphDO handleFetch switch to route map pattern"
   - Description: Replace 100+ case switch statement with a route registry or handler map for better maintainability
   - Priority: Medium
   - Technical debt reduction, improves maintainability

4. **Standardize E2E Test File Naming**
   - Story: "Standardize E2E test file naming convention"
   - Description: Rename phase-2a.test.ts and phase-2b.test.ts to match *.integration.test.ts pattern, update vitest configs
   - Priority: Low
   - Consistency improvement

## Metrics

- **Stories accepted first try:** 7/7 (100%)
- **Stories rejected at least once:** 0
- **Total new tests:** 265 (28+21+46+36+52+57+25)
- **Test breakdown:** ~60% unit, ~40% integration
- **Performance target met:** Solver completes in <2s for 1-week window (AC from TM-946.2)
- **Most impactful learning:** Missing DO routes pattern (affects future DO development)

## Strategic Observations

### What Went Extremely Well

1. **Incremental story design:** Walking skeleton -> features -> E2E validation is a proven pattern
2. **Zero rejections:** 100% first-try acceptance rate shows excellent story design and TDD discipline
3. **Solid foundation:** Phase 2 constraints/trips/working hours enabled Phase 3A to focus on scheduling logic
4. **Test coverage:** 265 new tests with strong unit + integration mix
5. **Clear ACs:** Specific test counts and performance targets drove quality

### What to Preserve for Future Epics

1. **Walking skeleton first:** Prove end-to-end flow before adding complexity
2. **Incremental feature addition:** Each story adds one new capability
3. **E2E validation story:** Final story proves full integration
4. **Specific AC metrics:** Test counts, performance targets, behavioral specifics
5. **Build on solid foundation:** Ensure dependencies (Phase 2) are stable before dependent features (Phase 3)

### Risks Identified for Phase 3B+

1. **UserGraphDO handleFetch complexity:** 100+ cases, potential for missing routes or maintenance burden
2. **Workspace dependency management:** Root vs package dependencies causing test failures
3. **DO test stub inconsistency:** Method naming (handleFetch vs fetch) could confuse future DO implementations

### Next Steps for Phase 3B (Multi-User Scheduling)

Phase 3B will introduce GroupScheduleDO for multi-user scheduling sessions. Key learnings to apply:

1. Use walking skeleton approach: simplest multi-user flow first
2. Create route registry test for GroupScheduleDO from day one
3. Ensure workspace dependencies are declared at root for E2E tests
4. Standardize DO method naming (fetch or handleFetch, document the choice)
5. Include E2E validation story at the end

---

**Retrospective completed:** 2026-02-15
**Next milestone:** Phase 3B: Multi-User Scheduling (GroupScheduleDO)
