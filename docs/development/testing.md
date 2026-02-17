# Testing Guide

Testing is organized into three tiers:

---

## Unit Tests

**Purpose:** Test pure functions (policy compiler, stable hashing, event classification, normalization).
**Runtime:** No Cloudflare runtime needed. Run with Vitest.
**Mocks:** Acceptable at this level.

```bash
make test-unit
```

---

## Integration Tests (Cloudflare)

**Purpose:** Test DO logic, queue flows, and Worker handlers.
**Runtime:** `@cloudflare/vitest-pool-workers` provides a local Cloudflare runtime with real DO SQLite, real queues, and real D1.
**Mocks:** NO mocks. These are real tests against real Cloudflare primitives.

```bash
make test-integration
```

---

## Integration Tests (Google API)

**Purpose:** Test against real Google Calendar API using a dedicated service account with test calendars.
**Runtime:** Real HTTP calls to Google.
**Mocks:** NO mocks.

```bash
make test-integration-real
```

This is the hardest tier. Google does not offer a Calendar API sandbox. Tests use a dedicated Google Workspace test account with test calendars.

---

## E2E Tests

E2E tests exercise full user journeys. They are organized by milestone phase:

```bash
make test-e2e              # Core E2E
make test-e2e-phase2a      # API E2E (localhost)
make test-e2e-phase2b      # MCP E2E (localhost)
make test-e2e-phase3a      # Scheduling E2E
make test-e2e-phase4b      # Geo-aware intelligence E2E
make test-e2e-phase4c      # Context/communication E2E
make test-e2e-phase4d      # Advanced scheduling E2E
make test-e2e-phase5a      # Platform extensions E2E
make test-e2e-phase5b      # Advanced intelligence E2E
make test-e2e-phase6a      # Multi-provider onboarding E2E
make test-e2e-phase6b      # Marketplace lifecycle E2E
make test-e2e-phase6c      # Progressive onboarding E2E
```

---

## Live Tests

Tests against a deployed stack (staging or production):

```bash
make test-live             # Against production
make test-live-staging     # Against staging
```

### Environment Variables by Provider

Live tests are credential-gated: suites skip with clear messages when required env vars are absent. Set these in `.env` (never committed).

| Provider | Required Env Vars | Test File |
|----------|-------------------|-----------|
| **Core** (health, auth, errors) | `LIVE_BASE_URL` | `health.live.test.ts`, `error-cases.live.test.ts`, `core-pipeline.live.test.ts` |
| **Google** (webhook sync) | `LIVE_BASE_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_TEST_REFRESH_TOKEN_A`, `JWT_SECRET` | `webhook-sync.live.test.ts`, `core-pipeline.live.test.ts` |
| **Microsoft** (Graph API parity) | `LIVE_BASE_URL`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_TEST_REFRESH_TOKEN_B`, `JWT_SECRET` | `microsoft-provider.live.test.ts` |
| **Microsoft E2E** (API -> Graph loop) | `LIVE_BASE_URL`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_TEST_REFRESH_TOKEN_B`, `JWT_SECRET` | `microsoft-e2e.live.test.ts` |
| **CalDAV/ICS** (feed import, export) | `LIVE_BASE_URL`, `LIVE_JWT_TOKEN` | `caldav-ics-provider.live.test.ts` |
| **Authenticated CRUD** | `LIVE_BASE_URL`, `LIVE_JWT_TOKEN` | `core-pipeline.live.test.ts` |

### Provider Credential Setup

**Google:** Create OAuth credentials at https://console.cloud.google.com/apis/credentials. Obtain a refresh token via the OAuth consent flow or the walking skeleton (TM-qt2f).

**Microsoft:** Register an app at https://entra.microsoft.com/ -> App registrations. Required scopes: `Calendars.ReadWrite`, `User.Read`, `offline_access`. Obtain `MS_TEST_REFRESH_TOKEN_B` via the Microsoft OAuth consent flow.

**CalDAV/ICS:** No external provider credentials needed. Only `LIVE_BASE_URL` and `LIVE_JWT_TOKEN` are required to test the feed import/export pipeline.

### Safe Rerun Guidance

- **All live tests are idempotent** -- safe to rerun repeatedly.
- **Test artifacts are cleaned up** by afterAll hooks in each suite.
- **Microsoft provider tests** create and delete events directly in the test user's Outlook calendar via Graph API. If a test is interrupted mid-run, orphaned events will have `[tminus-live-parity]` in their subject and can be manually deleted.
- **Microsoft E2E tests** create events via the T-Minus API and verify propagation to Microsoft Graph. Orphaned events from this suite have `[tminus-ms-e2e]` in their subject. The afterAll hook performs a sweep to clean up both the canonical store and Graph. If interrupted, search Outlook for events with `[tminus-ms-e2e]` and delete manually.
- **CalDAV/ICS tests** import from a public Google Calendar holidays feed. Imported events are harmless (public holiday data) and persist in the user's store.
- **Google webhook tests** create events with `TM-hpq7-E2E-` in the summary and clean them up.
- **Auth tests** create users with `@test.tminus.ink` email addresses that are exempt from registration rate limits.
- **Rate limiting**: If tests fail with 429 status codes, wait for the rate limit window to expire (typically 1 hour for registration, less for other endpoints) and rerun.

### Microsoft E2E Prerequisites (TM-psbd)

The Microsoft E2E suite (`microsoft-e2e.live.test.ts`) validates the full loop: T-Minus API create/update/delete with verification that events propagate to and from Microsoft Graph.

**Prerequisites:**

1. **Azure AD app registration** with `Calendars.ReadWrite`, `User.Read`, `offline_access` scopes. See `docs/development/ms-bootstrap-checklist.md` for full setup.
2. **Microsoft account onboarded in T-Minus** -- the test user (`ramiro@cibertrend.com`) must have completed the T-Minus OAuth onboarding flow so that a policy edge exists linking API-created events to the Microsoft calendar.
3. **Environment variables** in `.env`:
   - `MS_CLIENT_ID` -- Azure AD Application (client) ID
   - `MS_CLIENT_SECRET` -- Azure AD client secret
   - `MS_TEST_REFRESH_TOKEN_B` -- OAuth refresh token for the test user
   - `JWT_SECRET` -- T-Minus API JWT signing secret (used to generate test JWTs)

**Running:**

```bash
# Full live suite (includes Microsoft E2E when creds present)
make test-live

# Targeted Microsoft E2E only
source .env && LIVE_BASE_URL=https://api.tminus.ink \
  npx vitest run tests/live/microsoft-e2e.live.test.ts \
  --config vitest.live.config.ts
```

**Propagation behavior:**

Events created via `POST /v1/events` are stored in the canonical store and then propagated to Microsoft Graph asynchronously via the write-consumer queue pipeline. The E2E tests poll Microsoft Graph with a 120-second timeout to verify propagation. If propagation does not complete within this window, the test logs a diagnostic message but does not hard-fail for the propagation check (the API surface tests still pass).

**Manual-assist fallback procedure:**

If Microsoft E2E tests consistently fail at the propagation step:

1. **Verify the Microsoft account is onboarded**: Check that `ramiro@cibertrend.com` has completed the T-Minus OAuth flow and has an active account linkage. Run `scripts/ms-bootstrap-verify.mjs` to confirm.
2. **Check write-consumer health**: The write-consumer queue processes mirror writes. If the queue is backed up or the worker is unhealthy, propagation will be delayed.
3. **Verify policy edges exist**: The user's Durable Object must have a policy edge that routes API-created events to the Microsoft account. This is established during OAuth onboarding.
4. **Manual verification**: Create an event via the T-Minus API manually (`curl -X POST https://api.tminus.ink/v1/events -H "Authorization: Bearer <jwt>" -H "Content-Type: application/json" -d '{"title":"Manual test","start":{"dateTime":"...","timeZone":"UTC"},"end":{"dateTime":"...","timeZone":"UTC"}}'`), then check if it appears in the test user's Outlook calendar within 2 minutes.
5. **Refresh token rotation**: Microsoft refresh tokens expire after 90 days of inactivity. If token exchange fails, re-run the OAuth consent flow (see `ms-bootstrap-checklist.md`).

---

## Smoke Tests

Quick health verification after deployment:

```bash
make smoke-test            # Production
make smoke-test-staging    # Staging
```

---

## Unified E2E Gate: Module Resolution

The unified E2E config (`vitest.e2e.config.ts`) runs ALL E2E suites under a single
`make test-e2e` command. Because these tests import from workspace packages that are
not published to npm, Vitest needs explicit `resolve.alias` entries to map package
names to source directories.

### Root cause of past breakage (TM-zf91.2, 2026-02-17)

Individual phase configs (e.g. `vitest.e2e.phase3a.config.ts`) each declared the
aliases they needed, but the unified config only had `@tminus/shared` and
`@tminus/d1-registry`. When all E2E suites were aggregated under one config, suites
that depended on additional workspace packages failed at import time:

1. **`@tminus/do-user-graph` resolution failure** -- 7 test files import
   `UserGraphDO` from this workspace package. The unified config lacked the alias
   pointing to `durable-objects/user-graph/src`.

2. **`cloudflare:workers` resolution failure** -- The `walking-skeleton-oauth` and
   `phase-6b` suites transitively import `workers/oauth/src/index.ts`, which
   re-exports `OnboardingWorkflow` from `./workflow-wrapper.ts`. That module imports
   `WorkflowEntrypoint` from the `cloudflare:workers` built-in, which only exists
   in the Cloudflare Workers runtime and is unavailable in Node/vitest.

### How the fix works

The unified `vitest.e2e.config.ts` now declares the **superset** of all aliases used
by any individual phase config:

| Alias | Resolves to |
|-------|-------------|
| `@tminus/shared` | `packages/shared/src` |
| `@tminus/d1-registry` | `packages/d1-registry/src` |
| `@tminus/do-user-graph` | `durable-objects/user-graph/src` |
| `@tminus/do-group-schedule` | `durable-objects/group-schedule/src` |
| `@tminus/workflow-scheduling` | `workflows/scheduling/src` |
| `cloudflare:workers` | `workers/oauth/src/__stubs__/cloudflare-workers.ts` |

The `cloudflare:workers` stub provides minimal `WorkflowEntrypoint` and
`DurableObject` classes -- just enough for the import to resolve. Production code
runs against the real Cloudflare module; only tests use this stub.

### Maintenance rule

When adding a new workspace package that E2E tests import, add the alias to
**both** the individual phase config AND `vitest.e2e.config.ts`. If the unified
gate breaks, this table is the first place to check.

---

## Testing Philosophy

- **Hard TDD:** Red/green/refactor cycle.
- **Unit test coverage:** Target 80%+.
- **Integration tests are mandatory:** A story without integration tests (where technically feasible) is not complete.
- **No mocks in integration or E2E tests.**
- **Test pyramid:** Unit > Integration > E2E (most unit tests, fewest E2E tests).
