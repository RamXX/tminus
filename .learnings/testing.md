# Testing Learnings

Insights related to test coverage, test types, and testing methodology.

## Critical Insights

(None yet)

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
