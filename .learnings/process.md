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

---

## [Added from Epic TM-as6 retro - 2026-02-14]

### Migration numbering conflicts require upfront check

**Priority:** Important

**Context:** Auth routes (TM-sk7) discovered that migration 0003 was taken by API keys migration (TM-as6.9). Auth fields became 0004. Always check existing migrations before numbering.

**Recommendation:** For all D1 schema change stories:
- Developer MUST check existing migrations before numbering (ls packages/shared/migrations/)
- Use sequential numbering (0001, 0002, 0003, ...)
- If conflict detected, use next available number
- SR. PM should include "check existing migration numbers" in D&F for schema change stories

**Applies to:** All D1 schema change stories in Phase 2B, 2C, 2D, 3, 4

**Source stories:** TM-sk7

### Staged changes must be committed before spawning new agents

**Priority:** Important

**Context:** API key support (TM-as6.9) noted that staged changes included uncommitted work from TM-cep follow-up (auth routes, env.d.ts, wrangler.toml bindings). These were included in this commit since they are prerequisites.

**Recommendation:** For orchestrator workflow:
- After story acceptance, check for unstaged/uncommitted changes
- If found, either:
  1. Commit them immediately (if related to accepted story)
  2. Stash them (if unrelated)
  3. Warn user and ask for guidance
- Do NOT spawn new developer agents with dirty working tree
- Consider adding a git status check to orchestrator before agent spawning

**Applies to:** All future stories; orchestrator improvement

**Source stories:** TM-as6.9

---

## [Added from Epic TM-4qw retro - 2026-02-14]

### One Story, One Commit - No Scope Bundling

**Priority:** Critical

**Context:** TM-4qw.2 bundled event tools (meant for TM-4qw.3), TM-4qw.4 bundled policy tools (meant for TM-4qw.5). This created confusion about test coverage and what was delivered when. Both subsequent stories had rejections due to test confusion.

**Recommendation:** Developer agents MUST commit only code within the current story's scope. If implementing story N discovers that story N+1's code naturally belongs in the same commit, the agent should:
1. Note this in the delivery notes
2. Implement only story N
3. Flag for Sr. PM that story N+1 may be trivial/duplicate

Sr. PM can then decide whether to collapse stories or keep them separate. The key is: don't bundle silently.

**Applies to:** All stories (developer execution discipline)

**Source stories:** TM-4qw.2, TM-4qw.3, TM-4qw.4, TM-4qw.5

---

## [Added from Epic TM-nyj retro - 2026-02-14]

### Walking Skeleton Observations Should Generate Follow-Up Stories

**Priority:** Important

**Context:** TM-nyj.2 noted that JWT is stored only in React state (lost on refresh), and that the walking skeleton mentioned a future story for refresh token persistence, but no such story exists in the backlog. This creates a gap between identified TODOs and backlog planning.

**Recommendation:**
- When walking skeleton stories (*.1) note deferred functionality, Sr. PM should immediately create placeholder stories in the backlog
- These stories should be tagged with `deferred-from-walking-skeleton` label for traceability
- PM-Acceptor should verify during acceptance that all walking skeleton TODOs have corresponding backlog stories

**Applies to:** All epics that start with a walking skeleton story

**Source stories:** TM-nyj.2

