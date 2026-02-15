# Retrospective: Epic TM-9ue - Phase 3C: Billing

**Date:** 2026-02-15
**Stories completed:** 5
**Total tests added:** 298 (62 + 74 + 62 + 81 + 19)

## Summary

Phase 3C introduced full Stripe-based billing infrastructure including subscription lifecycle management, tier-based feature gating, checkout flows, and billing UI. This was a complex epic spanning backend APIs, payment processing, database schema changes, middleware, and React components. The epic achieved complete E2E billing integration with comprehensive test coverage.

## Stories Delivered

1. **TM-jfs.1: Walking Skeleton: Stripe Checkout E2E** (62 tests)
   - Stripe webhook handler, checkout session creation, D1 subscriptions table

2. **TM-jfs.2: Tier-Based Feature Gating** (74 tests)
   - Middleware for tier enforcement, account limits, usage tracking

3. **TM-jfs.3: Subscription Lifecycle Management** (62 tests)
   - Subscription state transitions, grace periods, cancellation flows

4. **TM-jfs.4: Billing UI** (81 tests)
   - React Billing page, tier display, upgrade/cancel flows

5. **TM-jfs.5: Phase 3C E2E Validation** (19 tests)
   - End-to-end validation of complete billing pipeline

## Raw Learnings Extracted

### From TM-jfs.2: Tier-Based Feature Gating

**Test Infrastructure:**
- The vitest workspace config (vitest.workspace.ts) excludes `*.integration.test.ts` - must use `--config vitest.integration.config.ts` for integration tests
- D1 test setup requires MIGRATION_0013_SUBSCRIPTION_LIFECYCLE for upsertSubscription (grace_period_end column added by concurrent TM-jfs.3 story)

**API Response Design:**
- accountLimitResponse includes `usage.accounts` and `usage.limit` for client-side display of "2/2 accounts used"

**Pre-existing Issues Observed:**
- workers/api/src/routes/billing.integration.test.ts: Missing MIGRATION_0013_SUBSCRIPTION_LIFECYCLE in beforeEach setup caused 28 test failures (pre-existing from TM-jfs.3 delivery)
- src/web/src/components/UnifiedCalendar.test.tsx: 4 pre-existing test failures (React rendering/date issues)

**Verification Failures:** 3 rejections (integration test issues)

### From TM-jfs.3: Subscription Lifecycle Management

**Test Maintenance Burden:**
- When adding feature-gate middleware that queries a new table, ALL existing test files with authenticated routes need their DB mocks updated to include that table. This caused 28 pre-existing test failures that were NOT from my code changes but from missing subscriptions table in mocks.

**Data Mapping:**
- Stripe uses "canceled" (American spelling) but our DB uses "cancelled" (British spelling). The statusMap in handleSubscriptionUpdated handles this mapping.

**Test Infrastructure Fragility:**
- workers/api/src/index.test.ts: The createMinimalEnv() was using an empty object as D1Database (`{} as D1Database`). This worked before the feature gate was added but is fragile. Any authenticated route test will fail if new middleware queries D1.

**Operational Concern:**
- The grace period expiration is not enforced by any cron job yet. A cron story should be created to periodically check expired grace periods and downgrade users.

**Verification Failures:** 3 rejections (integration test issues)

## Patterns Identified

### 1. **Cross-Story Test Dependencies** (seen in 2 stories)
When stories are developed in parallel and introduce schema changes (migrations), integration tests in Story A can fail when Story B's migration is merged. TM-jfs.2 and TM-jfs.3 both had issues with missing migrations in test setup.

### 2. **Middleware Ripple Effects** (seen in 2 stories)
Adding middleware that queries D1 (like feature-gate) breaks ALL existing authenticated route tests if they use minimal mocks. The fragility of `{} as D1Database` became apparent when feature gates were added.

### 3. **Integration Test Config Complexity** (seen in 2 stories)
The vitest workspace excludes integration tests, requiring explicit `--config vitest.integration.config.ts`. This caused confusion and multiple verification failures until properly understood.

### 4. **Verification Iteration Pattern**
Both stories with learnings had 3 verification failures each before acceptance. The pattern was:
- Failure 1: Integration tests not running (config issue)
- Failure 2: Integration tests running but failing (missing migrations)
- Failure 3: Test setup issues resolved
- Acceptance: Tests passing

### 5. **Missing Operational Stories**
The grace period enforcement observation highlights a gap: billing lifecycle features need corresponding cron/operational stories to enforce state transitions. This was not explicitly in the epic.

## Actionable Insights

### Critical Insights

#### [TESTING] Integration Test Migrations Must Mirror Production Schema

**Priority:** Critical

**Context:** When multiple stories in an epic add database migrations concurrently, integration test setups in Story A fail when Story B's migration is merged. TM-jfs.2 tests failed because TM-jfs.3 added MIGRATION_0013_SUBSCRIPTION_LIFECYCLE. This caused 28 test failures that were not from the story's code changes.

**Recommendation:**
1. Before delivering any story, run `git pull` and re-run ALL integration tests to catch merged migrations
2. Integration test setup helpers MUST apply ALL migrations from the migrations directory, not a hardcoded subset
3. Consider adding a CI step that fails if integration tests reference hardcoded migration lists

**Applies to:** All stories that add database migrations or introduce middleware that queries D1

**Source stories:** TM-jfs.2, TM-jfs.3

---

#### [TESTING] Middleware Changes Require Mock Audit Across Test Suite

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

#### [TESTING] Integration Test Config Must Be Explicit in Story ACs

**Priority:** Critical

**Context:** Both TM-jfs.2 and TM-jfs.3 had multiple verification failures because integration tests require `--config vitest.integration.config.ts` but the workspace config excludes `*.integration.test.ts`. This caused tests to silently not run, passing verification incorrectly.

**Recommendation:**
1. All stories with integration tests MUST include in ACs: "Run integration tests with: `vitest --config vitest.integration.config.ts`"
2. Consider adding a CI job that explicitly runs integration tests separately from unit tests
3. Developers should verify integration tests ran by checking test count (e.g., "62 tests" not "40 tests")

**Applies to:** All stories with integration tests in Workers/API

**Source stories:** TM-jfs.2, TM-jfs.3

---

### Important Insights

#### [ARCHITECTURE] Feature Lifecycle Needs Operational Enforcement Stories

**Priority:** Important

**Context:** TM-jfs.3 implemented grace_period_end column and state transitions, but there's no cron job to actually enforce grace period expiration. Users in grace period will stay there indefinitely until manual intervention.

**Recommendation:**
1. When designing features with time-based state transitions (grace periods, trials, expiration), ALWAYS include a corresponding cron/operational story in the epic
2. Sr. PM should validate that lifecycle features have enforcement mechanisms during D&F
3. For this specific case, create a follow-up story: "Cron job to enforce grace period expiration and downgrade users"

**Applies to:** All features with time-based state machines (trials, grace periods, scheduled actions)

**Source stories:** TM-jfs.3

---

#### [DATA] Spell-Check External API Mappings

**Priority:** Important

**Context:** Stripe uses "canceled" (American spelling) but T-Minus DB schema uses "cancelled" (British spelling). This required explicit statusMap mapping in handleSubscriptionUpdated. Easy to miss if not careful.

**Recommendation:**
1. When integrating external APIs (Stripe, Google, etc.), explicitly document spelling differences in code comments
2. Create a mapping layer (like statusMap) rather than storing raw API values directly
3. Add integration tests that verify the mapping (e.g., Stripe "canceled" → DB "cancelled")

**Applies to:** All stories integrating external APIs with enum/status fields

**Source stories:** TM-jfs.3

---

#### [TESTING] API Responses Should Include Client Display Fields

**Priority:** Important

**Context:** accountLimitResponse includes both `usage.accounts` (current count) and `usage.limit` (tier limit) so clients can display "2/2 accounts used" without duplicating tier limit logic.

**Recommendation:**
1. When designing API responses for quota/limit features, include BOTH current usage AND limit in the response
2. This prevents clients from duplicating business logic about tier limits
3. Makes the API self-documenting and easier to consume

**Applies to:** All API endpoints that return quota/limit/usage information

**Source stories:** TM-jfs.2

---

### Nice-to-Have Insights

#### [PROCESS] Pre-Existing Test Failures Should Be Tracked Separately

**Priority:** Nice-to-have

**Context:** Both TM-jfs.2 and TM-jfs.3 observed pre-existing test failures (UnifiedCalendar.test.tsx had 4 failing tests, billing.integration.test.ts had issues). These were noted in OBSERVATIONS but not blocking.

**Recommendation:**
1. When discovering pre-existing test failures, log them as separate bug stories (not blocking the current story)
2. Include the observation in LEARNINGS so PM/Sr. PM can decide whether to fix immediately or defer
3. Consider a "test debt" label for tracking these

**Applies to:** All stories where developers observe pre-existing issues

**Source stories:** TM-jfs.2, TM-jfs.3

---

## Recommendations for Backlog

### Immediate Action Required

1. **Create Operational Story:** "Cron job to enforce grace period expiration" (blocker for Phase 3C to be production-ready)

### Process Improvements

2. **Update Story Template:** Add explicit integration test run command to all API story templates
3. **Update D&F Checklist:** Validate that time-based state machines have corresponding enforcement/cron stories

### Technical Debt

4. **Refactor Test Mocks:** Replace `{} as D1Database` with realistic test env helper that includes all tables
5. **Fix Pre-existing Test Failures:** UnifiedCalendar.test.tsx (4 failures) and billing.integration.test.ts setup issues

## Metrics

- **Stories accepted first try:** 3/5 (60%) - TM-jfs.1, TM-jfs.4, TM-jfs.5
- **Stories rejected at least once:** 2/5 (40%) - TM-jfs.2 (3x), TM-jfs.3 (3x)
- **Most common rejection reason:** Integration tests not running or failing due to config/migration issues
- **Test gap learnings captured:** 5 (all testing-related)
- **Total tests added:** 298 tests across 5 stories
- **Average tests per story:** 59.6 tests

## Success Highlights

1. **Comprehensive test coverage:** 298 tests total across the epic, demonstrating strong TDD commitment
2. **Clean E2E validation:** TM-jfs.5 provided end-to-end confidence in the billing pipeline
3. **First-try acceptances:** 3 stories (TM-jfs.1, TM-jfs.4, TM-jfs.5) were accepted without rejections
4. **Strong observability:** Developers documented pre-existing issues separately, showing good discipline

## Challenges Overcome

1. **Parallel development coordination:** Stories TM-jfs.2 and TM-jfs.3 worked on overlapping areas (feature gates, subscriptions) and required careful migration/mock coordination
2. **Integration test configuration:** Team learned the vitest workspace quirk and can now apply consistently
3. **Cross-cutting middleware:** Feature-gate middleware affects all authenticated routes, requiring broad test updates

---

**Epic Status:** Complete (all 5 stories closed)
**Production Ready:** Not yet (requires grace period enforcement cron job)
**Knowledge Captured:** 6 actionable insights across Testing, Architecture, Data, Process
