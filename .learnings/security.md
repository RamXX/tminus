# Security Learnings

## [Added from Epic TM-as6 retro - 2026-02-14]

### CORS wildcard (*) is inappropriate with Bearer tokens

**Priority:** Critical

**Context:** Security middleware (TM-as6.2) migrated from CORS wildcard (*) to explicit origin allowlist. Browsers require explicit origin matching for credentialed requests (Bearer tokens, cookies).

**Recommendation:** For all authenticated endpoints:
- NEVER use Access-Control-Allow-Origin: * with Bearer auth
- Use explicit origin allowlist (read from env var or config)
- For local dev: allow http://localhost:* and http://127.0.0.1:*
- For production: allow only known frontends (e.g., https://app.tminus.ink)
- SR. PM should include "CORS allowlist, not wildcard" in all authenticated endpoint stories

**Applies to:** Phase 2C (Web UI), all future authenticated endpoints

**Source stories:** TM-as6.2
