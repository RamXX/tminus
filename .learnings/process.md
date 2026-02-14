# Process Learnings

## AC Verification Tables (from TM-cd1)
**Priority:** Important
**Source:** TM-cd1 retro

Standard delivery evidence format for all stories:

| AC # | Requirement | Code Location | Test Location | Status |
|------|-------------|---------------|---------------|--------|
| 1 | Description | file:line | test_file:test_name | PASS |

Benefits: Clear traceability, faster acceptance reviews, builds confidence.

## Security Concerns Must Be Explicit (from TM-cd1)
**Priority:** Important
**Source:** TM-cd1 retro

Security concerns (key rotation, rate limiting) should be explicit ACs or tracked as dedicated stories. Do not defer to OBSERVATIONS without a tracking mechanism.

Current gaps identified:
- JWT_SECRET has no rotation mechanism (Phase 2)
- No rate limiting on API endpoints (Phase 2)
- No distributed tracing (Phase 2)

---

## [Added from Epic TM-852 retro - 2026-02-14]

### All workers must implement /health endpoint

**Priority:** Important

**Context:** TM-3i0 discovered OAuth worker had no /health endpoint, unlike webhook/cron/api workers. This creates inconsistency and breaks test harness health polling.

**Recommendation:** Every worker MUST implement /health endpoint that:
1. Returns 200 status with JSON: `{ status: "healthy" }`
2. Is used by startWranglerDev() health polling
3. Is used by production monitoring/load balancers
4. Add this as embedded context in Sr. PM's worker story templates

**Applies to:** All workers, all future worker stories

**Source stories:** TM-3i0
