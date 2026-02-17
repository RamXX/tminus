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
| **CalDAV/ICS** (feed import, export) | `LIVE_BASE_URL`, `LIVE_JWT_TOKEN` | `caldav-ics-provider.live.test.ts` |
| **Authenticated CRUD** | `LIVE_BASE_URL`, `LIVE_JWT_TOKEN` | `core-pipeline.live.test.ts` |

### Provider Credential Setup

**Google:** Create OAuth credentials at https://console.cloud.google.com/apis/credentials. Obtain a refresh token via the OAuth consent flow or the walking skeleton (TM-qt2f).

**Microsoft:** Register an app at https://entra.microsoft.com/ -> App registrations. Required scopes: `Calendars.ReadWrite`, `User.Read`, `offline_access`. Obtain `MS_TEST_REFRESH_TOKEN_B` via the Microsoft OAuth consent flow.

**CalDAV/ICS:** No external provider credentials needed. Only `LIVE_BASE_URL` and `LIVE_JWT_TOKEN` are required to test the feed import/export pipeline.

### Safe Rerun Guidance

- **All live tests are idempotent** -- safe to rerun repeatedly.
- **Test artifacts are cleaned up** by afterAll hooks in each suite.
- **Microsoft tests** create and delete events in the test user's Outlook calendar. If a test is interrupted mid-run, orphaned events will have `[tminus-live-parity]` in their subject and can be manually deleted.
- **CalDAV/ICS tests** import from a public Google Calendar holidays feed. Imported events are harmless (public holiday data) and persist in the user's store.
- **Google webhook tests** create events with `TM-hpq7-E2E-` in the summary and clean them up.
- **Auth tests** create users with `@test.tminus.ink` email addresses that are exempt from registration rate limits.
- **Rate limiting**: If tests fail with 429 status codes, wait for the rate limit window to expire (typically 1 hour for registration, less for other endpoints) and rerun.

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
