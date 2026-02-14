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
