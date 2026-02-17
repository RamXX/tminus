# Roadmap

---

## Phase 1: Foundation (Calendar Federation Core)

**Status:** Active Development
**Goal:** Two+ Google accounts synced bidirectionally with busy overlay.

### Deliverables

- Project scaffolding (monorepo, wrangler configs, shared package)
- D1 registry schema + migrations
- OAuth worker (Google PKCE flow)
- AccountDO (token storage, refresh, sync cursor, watch channels)
- UserGraphDO (canonical events, event_mirrors, event_journal, policies)
- Webhook worker (validation, enqueue)
- Sync consumer (incremental + full sync, classification, normalization)
- Write consumer (create/patch/delete mirrors, idempotency)
- Policy compiler (BUSY, TITLE, FULL projection)
- Busy overlay calendar auto-creation
- Cron worker (channel renewal, token refresh, daily reconciliation)
- OnboardingWorkflow (full initial sync)
- Loop prevention (extended properties tagging + classification)
- Integration tests against Google Calendar API

### Exit Criteria

1. A user can connect 2+ Google Calendar accounts.
2. Events created in any connected account appear as busy blocks in all other connected accounts within 5 minutes.
3. Event updates and deletions propagate correctly.
4. No sync loops occur under any sequence of creates, updates, and deletes.
5. Daily reconciliation detects and corrects drift.
6. All operations are idempotent and retry-safe.
7. Token refresh and channel renewal operate without manual intervention.
8. All data is encrypted at rest. Refresh tokens never leave AccountDO.

---

## Phase 2: Usability

**Status:** Planned
**Goal:** A human can use this daily, not just as infrastructure.

### Deliverables

- Web calendar UI (read-only unified view first, then write path)
- MCP server (list_accounts, create_event, add_trip, get_availability)
- Trip/constraint system (block time across all accounts)
- Policy management UI (configure detail levels per direction)
- Sync status dashboard (green/yellow/red per account)
- Error recovery UI (DLQ visibility, manual retry)

---

## Phase 3: Intelligence (Time Governance)

**Status:** Planned
**Goal:** The system makes decisions, not just mirrors data.

### Deliverables

- Greedy interval scheduler (propose meeting times with constraints)
- VIP policy engine (priority overrides with conditions)
- Billable/non-billable time tagging
- Commitment tracking (rolling window compliance + proof export)
- Working hours constraints
- Unified availability API (free/busy across all accounts)

---

## Phase 4: Differentiators (The Moat)

**Status:** Planned
**Goal:** Features that cannot be bolted onto Calendly or Google Calendar.

### Deliverables

- Relationship graph + social drift detection
- Geo-aware reconnection suggestions (trip + relationship intersection)
- Life event memory (milestones, birthdays, graduations)
- Interaction ledger + reputation scoring (reliability, reciprocity)
- Context briefings before meetings
- Excuse generator (policy-based, tone-aware, context-sensitive)
- Commitment compliance proof export (signed digests, PDF/CSV)
- External constraint solver integration
- Multi-user scheduling (GroupScheduleDO, holds, atomic commit)

---

## Phase 5: Scale and Polish

**Status:** Planned
**Goal:** Product-market fit and multi-provider support.

### Deliverables

- iOS native app
- Microsoft Calendar support (second provider)
- Read-only CalDAV feed
- "What-if" simulation engine
- Cognitive load modeling (mode clustering, context-switch cost)
- Temporal risk scoring (burnout detection)
- Probabilistic availability modeling
- Multi-tenant B2B (org-wide policies, shared constraints)
- Temporal Graph API (for third-party integrations)

---

## Weekly Review Cadence & Decision Rubric

**Cadence:** Every Monday at 10:00 AM (local time of the product lead).

### Purpose

Close the loop between product behavior and buyer outcomes. The review uses
funnel instrumentation data (see `scripts/funnel-report.mjs`) to make
evidence-based prioritization decisions rather than relying on intuition.

### Review Inputs

1. **Weekly Funnel Report** -- Generated via `node scripts/funnel-report.mjs --sample`
   (or `--d1` when connected to production). Shows:
   - Unique users per funnel stage (landing CTA click -> first insight viewed)
   - Stage-to-stage conversion rates
   - Week-over-week trends
   - Overall funnel efficiency

2. **Operational Metrics** -- From production monitoring:
   - Sync latency (p50, p95, p99)
   - Sync reliability (success rate)
   - Error rates by worker
   - API response times

3. **Qualitative Signals** -- User feedback, support requests, feature requests.

### Decision Rubric: What Triggers Prioritization Changes

| Signal | Threshold | Action |
|--------|-----------|--------|
| CTA -> Signup conversion drops below 40% | 2 consecutive weeks | Prioritize landing page copy/UX improvements |
| Signup -> Provider Connect drops below 30% | 2 consecutive weeks | Prioritize onboarding flow simplification |
| Provider Connect -> Sync Complete drops below 50% | 1 week | Investigate sync reliability; may be a bug |
| Sync Complete -> Insight Viewed drops below 30% | 2 consecutive weeks | Prioritize insight visibility and value demonstration |
| Overall funnel efficiency drops below 5% | 1 week | Emergency review: identify and fix the largest drop-off |
| Sync latency p95 exceeds 30 seconds | 1 week | Prioritize performance optimization |
| Sync reliability drops below 98% | 1 week | Prioritize reliability fix (P0) |
| New qualitative signal from 3+ users | As received | Add to next review agenda |

### Review Outputs

After each review, the product lead produces:

1. **Prioritization adjustment** -- Which backlog stories move up or down.
2. **New stories** (if needed) -- Filed with clear acceptance criteria.
3. **Metric targets** for the coming week -- What "good" looks like.
4. **Risk flags** -- Anything that needs engineering or architecture attention.

### Tooling

- **Report generation:** `node scripts/funnel-report.mjs --sample` (dry-run) or
  `make funnel-report` when Makefile target is available.
- **Funnel events library:** `packages/shared/src/funnel-events.ts`
- **Operational proof (public site):** `site/index.html` section `#proof`
- **D1 SQL reference:** Included in the report script output.

### First Review Checklist

For the inaugural review:

- [ ] Generate first weekly report (even with sample data)
- [ ] Confirm instrumentation is enabled in staging
- [ ] Verify operational metrics are accessible
- [ ] Establish baseline conversion rates (even if from sample data)
- [ ] Identify top-of-funnel acquisition channel (organic, referral, direct)
