# Code Quality Learnings

## [Added from Epic TM-as6 retro - 2026-02-14]

### Monolithic index.ts (1300+ lines) needs Hono router migration

**Priority:** Important

**Context:** Multiple stories (TM-as6.3, TM-as6.4, TM-sk7) noted that workers/api/src/index.ts grew to 1300+ lines with a massive if/else chain. The routeAuthenticatedRequest extraction helped slightly, but a proper Hono router migration would significantly improve readability.

**Recommendation:** For Phase 2B or Phase 3:
- Create a dedicated story to refactor api worker to full Hono routing
- Replace matchRoute pattern with Hono route groups:
  - /v1/auth/* → auth.routes.ts
  - /v1/api-keys/* → api-keys.routes.ts
  - /v1/events/* → events.routes.ts (DO proxy)
  - /v1/trips/* → trips.routes.ts (Phase 2D)
  - /health → health.routes.ts
- Move route handlers to separate files (keep index.ts < 200 lines)
- Maintain 100% test coverage during refactor

**Applies to:** Phase 2B (before MCP server), Phase 3 (before scheduler)

**Source stories:** TM-as6.3, TM-as6.4, TM-sk7
