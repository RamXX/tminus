# Retrospective: Epic TM-gj5 - Phase 2D Trip & Constraint System

**Date:** 2026-02-14
**Stories completed:** 7
**Duration:** 1 day (all stories completed same day)

## Summary

Phase 2D delivered a complete constraint system for T-Minus, implementing the foundation for trip-based busy blocking and sophisticated availability computation. The epic introduced 5 constraint types (trip, working_hours, buffer, no_meetings_after, override), a 6-step constraint evaluation pipeline, and comprehensive API/MCP tooling.

**Key Deliverables:**
- Trip CRUD with derived busy block generation
- Working hours constraints with timezone awareness
- Buffer time constraints (travel/prep/recovery)
- No-meetings-after and override constraint types
- 6-step constraint pipeline in computeAvailability()
- Full API CRUD for constraints with kind-specific validation
- 3 new MCP tools (add_trip, add_constraint, list_constraints)
- 822+ integration tests, 244 MCP tests, 63 E2E validation tests

**Test Coverage:**
- Started with 666 integration tests
- Ended with 822+ integration tests (156+ new tests)
- Walking skeleton: 31 new tests
- Working hours: 39 new tests
- Buffer constraints: 35 new tests
- Constraint API: 26 new tests
- MCP tools: 244 tests
- E2E validation: 63 tests

## Raw Learnings Extracted

### From TM-gj5.1 - Walking Skeleton: Trip Creates Busy Blocks

**Developer Learnings:**
- Crockford Base32 ULID validation is strict: test IDs must only use [0-9A-HJKMNP-TV-Z], 26 chars after prefix. Letters I, L, O, U are excluded.
- Schema integration tests should use dynamic version expectations (e.g., MIGRATIONS[length-1].version) rather than hardcoded version numbers, since adding migrations breaks those assertions.
- The existing schema.unit.test.ts already anticipated the v2 migration -- the previous developer had pre-committed those test expectations.

**Observations (unrelated):**
- workers/mcp/src/index.integration.test.ts and index.test.ts showed as modified in git status but were not part of this story -- they appear to be from a prior uncommitted change.

### From TM-gj5.2 - Working Hours Constraint

**Developer Learnings:**
- Intl.DateTimeFormat is available in Node.js 22 runtime (used for timezone validation and day-of-week calculation) -- no polyfills needed
- new Date(...).toISOString() always includes .000 milliseconds while ISO strings from user input may not -- tests need to account for this format difference
- Working hours expansion uses a scan window 1 day before/after the query range to handle timezone offsets (e.g., Pacific time 9am could be UTC previous day)

### From TM-gj5.3 through TM-gj5.7

No LEARNINGS sections captured. These stories were straightforward implementations that followed established patterns without surprises or gotchas.

## Patterns Identified

### 1. **Test Data Validation Strictness** (seen in 1 story)
Test infrastructure has strict validation rules that aren't always obvious from documentation. Developers encounter these through test failures rather than upfront guidance.

### 2. **Dynamic Test Assertions for Evolving Schemas** (seen in 1 story)
Hardcoded version numbers in schema tests break when migrations are added. Tests need to dynamically reference the current schema state.

### 3. **Runtime API Availability** (seen in 1 story)
Node.js 22 runtime provides modern APIs like Intl.DateTimeFormat without polyfills, but this isn't always documented clearly in the context of Cloudflare Workers.

### 4. **ISO String Format Variations** (seen in 1 story)
Different sources of ISO 8601 strings have varying millisecond precision (.000 vs omitted), requiring normalization in tests and potentially in production code.

### 5. **Timezone Offset Edge Cases** (seen in 1 story)
Timezone-aware date calculations require scan windows that extend beyond the requested range to handle UTC offset scenarios.

### 6. **Silent Success Pattern** (seen in 5 stories)
When implementations follow established patterns correctly, no learnings are captured. This is a sign of good architectural consistency and clear prior art.

## Actionable Insights

### CRITICAL: None identified

No critical issues emerged. All stories were completed successfully with comprehensive test coverage and no production incidents or architectural rework.

### IMPORTANT: Testing data format normalization

**Priority:** Important

**Context:** ISO string format differences between Date.toISOString() (always includes .000) and user input (may omit milliseconds) caused test assertion brittleness. Timezone calculations needed scan windows beyond query ranges.

**Recommendation:**
1. Create a canonical ISO string normalization utility for test assertions: `normalizeISOString(str)` that ensures consistent millisecond handling
2. Document the scan window pattern for timezone-aware date range calculations in the architecture guide
3. When implementing timezone-aware features, always consider UTC offset edge cases where local time on one day maps to UTC time on another day

**Applies to:** All date/time handling in availability computation, constraint evaluation, and API input validation

**Source stories:** TM-gj5.2

### IMPORTANT: Schema migration test resilience

**Priority:** Important

**Context:** Schema integration tests used hardcoded version numbers (e.g., `expect(version).toBe(1)`), which break when new migrations are added. This creates unnecessary test churn.

**Recommendation:**
1. All schema version assertions should use `MIGRATIONS[MIGRATIONS.length - 1].version` or similar dynamic reference
2. Update existing schema tests to follow this pattern
3. Add this to the testing guidelines for D1/SQLite schema work

**Applies to:** All schema migration tests, D1 and DO SQLite schema integration tests

**Source stories:** TM-gj5.1

### NICE-TO-HAVE: Test ID validation documentation

**Priority:** Nice-to-have

**Context:** Crockford Base32 ULID validation is strict (excludes I, L, O, U), but this isn't well-documented in the testing utilities. Developers discover it through test failures.

**Recommendation:**
1. Add JSDoc comment to ULID test helper functions documenting the Crockford Base32 character set restriction
2. Consider adding a validation helper that returns a clear error message when invalid characters are used
3. Include example valid test IDs in the testing guide

**Applies to:** All tests that create or validate ULIDs (constraints, events, accounts)

**Source stories:** TM-gj5.1

### NICE-TO-HAVE: Runtime API capability documentation

**Priority:** Nice-to-have

**Context:** Intl.DateTimeFormat availability in Node.js 22 runtime wasn't documented in project context, leading to uncertainty during implementation.

**Recommendation:**
1. Create a "Runtime APIs Available" section in PLAN.md or a new RUNTIME.md
2. Document known-available Node.js 22 APIs: Intl.DateTimeFormat, crypto, fetch, etc.
3. Update this list as new APIs are discovered/used

**Applies to:** All feature implementations that might use Node.js built-in APIs

**Source stories:** TM-gj5.2

## Recommendations for Backlog

**No backlog changes recommended.** The learnings are development process improvements, not feature gaps or technical debt.

However, the following documentation enhancements would be valuable:
- [ ] Add date/time normalization utilities to shared test helpers (consider for next testing epic)
- [ ] Update PLAN.md with timezone calculation patterns (low priority, can be done opportunistically)
- [ ] Add runtime API documentation (nice-to-have, no urgency)

## Metrics

- **Stories accepted first try:** 7/7 (100%)
- **Stories rejected at least once:** 0
- **Test coverage added:** 156+ integration tests, 244 MCP tests, 63 E2E tests
- **Test gap learnings captured:** 4 (data format normalization, schema migration resilience, ULID validation, runtime APIs)
- **Stories with LEARNINGS sections:** 2/7 (29%)
- **Commits:** 7 (one per story)
- **Most common pattern:** Silent success - stories followed established patterns without surprises

## Epic Health Assessment

**Overall: EXCELLENT**

This epic demonstrated:
- ✅ Clear architectural vision (6-step constraint pipeline)
- ✅ Consistent implementation patterns across all stories
- ✅ Comprehensive test coverage (822+ integration, 244 MCP, 63 E2E)
- ✅ 100% first-try acceptance rate
- ✅ No technical debt introduced
- ✅ Walking skeleton pattern worked well for complex feature
- ✅ Strong vertical slicing (each story was demoable)

The low number of LEARNINGS sections (2/7) is a positive indicator - it means most stories were straightforward executions of well-understood patterns. The learnings that did emerge were edge cases and tooling improvements, not architectural issues.

**What went well:**
- Walking skeleton (TM-gj5.1) established clear patterns for remaining stories
- Constraint evaluation pipeline design was sound and needed no rework
- Test-first approach caught edge cases early (timezone offsets, ISO format variations)
- MCP integration was seamless (244 tests, all passing)
- E2E validation suite (TM-gj5.7) provided confidence in the full pipeline

**What could improve:**
- Consider adding LEARNINGS sections even when "nothing went wrong" - capturing what went RIGHT can be valuable for future similar work
- Runtime API documentation could reduce implementation uncertainty
- Test helper documentation could reduce time spent on validation errors

**Recommendation:** Use this epic as a template for future constraint-type additions (e.g., "no_meetings_before", "focus_time", etc.). The pattern is proven and scales well.
