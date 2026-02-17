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

Requires `LIVE_BASE_URL` and optionally `LIVE_JWT_TOKEN` in `.env`.

---

## Smoke Tests

Quick health verification after deployment:

```bash
make smoke-test            # Production
make smoke-test-staging    # Staging
```

---

## Testing Philosophy

- **Hard TDD:** Red/green/refactor cycle.
- **Unit test coverage:** Target 80%+.
- **Integration tests are mandatory:** A story without integration tests (where technically feasible) is not complete.
- **No mocks in integration or E2E tests.**
- **Test pyramid:** Unit > Integration > E2E (most unit tests, fewest E2E tests).
