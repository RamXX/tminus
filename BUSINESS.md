# T-Minus: Business Requirements Document

**Document Owner:** Business Analyst
**Last Updated:** 2026-02-13
**Status:** Validated from source material (PLAN.md, dialog.txt)

---

## 1. Problem Statement

### The Problem

Professionals who operate across multiple organizations -- contractors, consultants, advisors, board members, venture capitalists -- maintain separate Google Calendar accounts per organization. These calendars are mutually unaware. The result is chronic double-booking, manual copy-paste of busy blocks, missed commitments, and zero cross-calendar intelligence.

Beyond scheduling conflicts, these professionals lose track of relationships: where contacts live, when they last met someone, whether they are fulfilling time commitments to clients, and whether a trip abroad overlaps with a friend's city. No existing tool solves this because the problem spans calendar federation, time governance, and relational coordination.

### Why Existing Tools Fail

- **Google Calendar:** No native cross-account awareness. Each Workspace tenant is isolated.
- **Calendly / scheduling links:** Solve booking availability for external parties but do not federate the user's own calendars or provide time governance.
- **CRMs (Salesforce, HubSpot):** Optimize revenue pipelines. They do not model social health, scheduling fairness, or temporal coordination.
- **Manual workarounds (copy-paste busy blocks):** Error-prone, do not scale beyond 2 accounts, provide no intelligence layer.

### The Opportunity

Build a Cloudflare-native temporal and relational intelligence engine that federates multiple Google Calendar accounts into a single canonical event store, projects events outward via configurable policies, and layers scheduling intelligence, relationship awareness, and time governance on top.

---

## 2. Target Users and Personas

### Primary Persona: The Multi-Org Operator

**Who:** Contractors, consultants, advisors, board members, VC partners.
**Profile:** Works across 2-10 organizations simultaneously. Holds separate Google Workspace accounts per organization. Manages 15-50 meetings per week across these accounts.
**Pain:**
- Double-booked constantly because calendars do not know about each other.
- Spends 30+ minutes daily manually coordinating busy blocks across accounts.
- Cannot prove time commitments to clients (e.g., "1 day per week average").
- Loses track of relationships and lets important connections drift.

**Success looks like:** Connect accounts once. Never manually copy-paste a busy block again. See a unified view. Get intelligent scheduling that respects constraints, commitments, and relationships.

### Secondary Persona: The Relationship-Rich Professional

**Who:** Founders, executives, globally networked professionals (the "25 years in startups on 4 continents" archetype).
**Profile:** Hundreds of meaningful relationships across categories (family, investors, friends, clients, board members). Travels frequently. Cannot keep track of where contacts live, let alone coordinate meetups.
**Pain:**
- Misses important life events (graduations, birthdays) because of scheduling noise.
- Cannot identify when a trip overlaps with a contact's city for reconnection.
- No visibility into relationship drift (when did I last see this person?).
- Wants memory augmentation, not automation. Does not want an agent messaging people on their behalf.

**Success looks like:** The system surfaces "You are overdue to see Alex. You will be in Berlin next week and Alex lives there. 45-minute window available Tuesday." The user decides whether to act on it.

### Tertiary Persona (Future): The AI-Native Power User

**Who:** Professionals using AI assistants (Claude, GPT, etc.) for daily workflow.
**Pain:** Cannot control their calendar through their AI assistant. Calendar operations require switching to a separate UI.
**Success looks like:** Issue natural language commands via MCP: "Block all my calendars for the Berlin trip. Protect 6 hours of deep work next week unless it is an ARR-critical meeting. Move all low-priority 1:1s if an investor call comes in."

---

## 3. Business Outcomes and Success Metrics

### Outcome 1: Eliminate Cross-Calendar Blindness (Phase 1)

**Metric:** Zero double-bookings caused by cross-account unawareness after all accounts are connected.
**Measurement:** Compare user-reported double-booking frequency before and after onboarding.
**Target:** 100% of events from connected accounts reflected as busy blocks in all other connected accounts within 5 minutes of creation.

### Outcome 2: Frictionless Onboarding (Phase 1)

**Metric:** Time from "start OAuth flow" to "all accounts synced and projecting" is under 10 minutes for 2-3 accounts.
**Measurement:** Onboarding workflow duration telemetry.

### Outcome 3: Daily Usability (Phase 2)

**Metric:** User can manage all calendars from a single interface (web UI or MCP) without opening individual Google Calendar accounts.
**Measurement:** Adoption of unified calendar UI as primary calendar interface.

### Outcome 4: Commitment Compliance (Phase 3)

**Metric:** Users can generate verifiable proof of hours worked per client within a rolling window.
**Measurement:** Commitment compliance reports generated, proof exports downloaded.

### Outcome 5: Relationship Health (Phase 4)

**Metric:** Reduction in relationship drift. Increase in proactive reconnections during travel.
**Measurement:** Drift report scores over time, reconnection suggestions acted upon.

---

## 4. Core Use Cases (Prioritized by Phase)

### Phase 1 -- Foundation (Calendar Federation Core)

| ID | Use Case | Description | Acceptance Criteria |
|----|----------|-------------|---------------------|
| UC-1.1 | Connect Google Account | User authenticates a Google Workspace account via OAuth PKCE flow. | Account tokens stored encrypted. Watch channel registered. Initial full sync completed. Account marked active. |
| UC-1.2 | Automatic Busy Overlay | When an event is created in Account A, a "Busy" block appears in all other connected accounts within their "External Busy" overlay calendar. | Busy block created with correct time, no title/description leakage (default BUSY policy). No sync loop. |
| UC-1.3 | Policy-Driven Projection | User configures how events project between accounts: BUSY (time only), TITLE (time + title), or FULL (everything minus attendees/conference links). | Policy edges stored per direction. Projections recompute on policy change. |
| UC-1.4 | Bidirectional Sync | Changes in any connected account (create, update, delete) propagate correctly to all other accounts per policy. | Updates reflected within 5 minutes. Deletes cascade to mirrors. Moves (time change) update mirrors. |
| UC-1.5 | Loop Prevention | Managed mirror events are never treated as origin events. No infinite replication. | Extended properties tagging present on all managed events. Classification logic verified. |
| UC-1.6 | Drift Reconciliation | Daily cron detects and corrects discrepancies between canonical state and provider state. | Missing mirrors recreated. Orphaned mirrors deleted. Hash mismatches corrected. Journal entries logged. |
| UC-1.7 | Onboarding Full Sync | On connecting a new account, all existing events are ingested and projections created for all other connected accounts. | Paginated full sync completes without timeout. Existing events in other accounts get busy overlays. |
| UC-1.8 | Channel Renewal | Watch channels are renewed before expiration. Token refresh occurs before access token expiry. | No gaps in webhook delivery. No expired token errors during sync. |

### Phase 2 -- Usability

| ID | Use Case | Description |
|----|----------|-------------|
| UC-2.1 | Unified Calendar View | Web UI showing all events across all accounts in a single calendar. Read-only first. |
| UC-2.2 | Event Creation from UI | Create events from the unified UI that project to the correct provider accounts. |
| UC-2.3 | MCP Interface | AI assistant controls calendar via MCP tools: list events, create events, add trips, check availability. |
| UC-2.4 | Trip/Constraint System | Block time across all accounts for travel. System auto-projects busy blocks for trip duration. |
| UC-2.5 | Policy Management UI | Configure detail levels (BUSY/TITLE/FULL) per account direction via UI. |
| UC-2.6 | Sync Status Dashboard | Green/yellow/red health indicators per connected account. |
| UC-2.7 | Error Recovery | Visibility into failed sync/write operations. Manual retry capability. |

### Phase 3 -- Intelligence (Time Governance)

| ID | Use Case | Description |
|----|----------|-------------|
| UC-3.1 | Greedy Interval Scheduler | Propose meeting times respecting constraints across all accounts. |
| UC-3.2 | VIP Policy Engine | Priority overrides with configurable conditions (e.g., "investor meetings allowed after hours with 24h notice"). |
| UC-3.3 | Billable Time Tagging | Tag events as billable/non-billable with client attribution. |
| UC-3.4 | Commitment Tracking | Rolling window compliance monitoring. "I committed 1 day/week to Client X -- am I on track?" |
| UC-3.5 | Working Hours Constraints | Define per-account working hours. Scheduler respects them unless VIP override applies. |
| UC-3.6 | Unified Availability API | Single endpoint returning free/busy across all connected accounts. |

### Phase 4 -- Differentiators (The Moat)

| ID | Use Case | Description |
|----|----------|-------------|
| UC-4.1 | Relationship Graph | Track relationships by category (family, investor, friend, client, board), city, timezone, interaction frequency target. |
| UC-4.2 | Social Drift Detection | Alert when time since last interaction exceeds target frequency for a relationship. |
| UC-4.3 | Geo-Aware Reconnection | When a trip is added, suggest reconnections with contacts in that city who are overdue for interaction. |
| UC-4.4 | Life Event Memory | Store milestones (birthdays, graduations, funding events, relocations). Avoid scheduling over them. |
| UC-4.5 | Interaction Ledger | Track meeting outcomes (attended, cancelled by whom, no-show). Compute reliability/reputation scores. |
| UC-4.6 | Context Briefings | Before a meeting, surface: last interaction date, topics, mutual connections, location history. |
| UC-4.7 | Excuse Generator | Policy-based, tone-aware message drafting for cancellations/rescheduling. Never auto-sends. |
| UC-4.8 | Commitment Proof Export | Signed digests proving hours worked per client. Exportable as PDF/CSV. Cryptographically verifiable. |
| UC-4.9 | Multi-User Scheduling | When multiple T-Minus users need to meet, solve globally optimal times with shared constraints. |

### Phase 5 -- Scale and Polish

| ID | Use Case | Description |
|----|----------|-------------|
| UC-5.1 | iOS Native App | Native app calling the T-Minus API directly. |
| UC-5.2 | Microsoft Calendar Support | Second provider integration. |
| UC-5.3 | Read-Only CalDAV Feed | Allow native calendar apps to subscribe to the unified view. |
| UC-5.4 | What-If Simulation | "What if I accept this board seat?" -- simulate calendar impact. |
| UC-5.5 | Cognitive Load Modeling | Mode clustering, context-switch cost, deep-work window optimization. |
| UC-5.6 | Temporal Risk Scoring | Burnout detection, travel overload scoring, strategic drift alerts. |
| UC-5.7 | Multi-Tenant B2B | Org-wide policies, shared constraints, enterprise features. |

---

## 5. Business Rules and Constraints

### Sync Correctness (Non-Negotiable)

- **BR-1:** Every provider event MUST be classified as exactly one of: origin, managed mirror, or foreign managed. Misclassification causes sync loops or data loss.
- **BR-2:** Canonical event IDs (ULID) are generated at creation time and never change. All mirrors reference the canonical ID.
- **BR-3:** Projections are deterministic. Given the same canonical event + policy + target calendar kind, the projected payload is always identical. Stable hashing determines whether a write is needed.
- **BR-4:** Every external write carries an idempotency key. Retries never duplicate or thrash events.
- **BR-5:** Managed events (created by T-Minus) are never treated as origin events. If a webhook fires for a managed event, the system only checks for drift and corrects if needed.

### Data Privacy (Non-Negotiable)

- **BR-6:** Participant identifiers are stored as SHA-256(email + per-org salt). Raw email addresses of non-user participants are never stored in the event store.
- **BR-7:** No soft deletes. Deletion is permanent with tombstone structural references only. Deletion certificates with signed proof hashes are generated.
- **BR-8:** Refresh tokens never leave AccountDO. Access tokens are minted just-in-time.
- **BR-9:** Minimal data collection principle: only data needed for sync + policy + the features the user has enabled.

### Projection Defaults

- **BR-10:** Default projection mode is BUSY (time only, no title, no description).
- **BR-11:** Default calendar kind is BUSY_OVERLAY (dedicated "External Busy" calendar per account), not true mirroring into the primary calendar.
- **BR-12:** True mirroring is opt-in per policy edge.

### Operational

- **BR-13:** Drift reconciliation runs daily (not weekly). Google Calendar push notifications are best-effort and can silently stop delivering.
- **BR-14:** Watch channels must be renewed before expiration (typically 7 days).
- **BR-15:** When a sync token returns 410 Gone, the system falls back to full sync automatically.
- **BR-16:** Event journaling is append-only. Every mutation to the canonical event store produces a journal entry with actor, change type, patch, and reason.

### User Experience

- **BR-17:** The system suggests and drafts but never sends messages or takes actions without explicit user confirmation. (Applies to excuse generator, reconnection suggestions, scheduling proposals.)
- **BR-18:** Relationship data is never auto-scraped from messages or contacts. All relationship information is user-controlled, entered manually or via MCP.

---

## 6. MVP Scope (Phase 1) -- Detailed

### In Scope

1. **OAuth flow:** Google Calendar PKCE flow for connecting Workspace accounts. One Google Cloud project credential used across all connected accounts.
2. **Account management:** Connect 2+ Google accounts. Store encrypted tokens in AccountDO. Token refresh. Account status tracking (active, revoked, error).
3. **Webhook infrastructure:** Receive Google Calendar push notifications. Validate channel tokens. Enqueue sync jobs.
4. **Incremental sync pipeline:** Pull events via syncToken. Classify events (origin vs. managed). Normalize to canonical format. Persist to UserGraphDO.
5. **Full sync pipeline:** Paginated events.list for onboarding and reconciliation. Same classification and normalization.
6. **Canonical event store:** Single source of truth per user in DO SQLite. ULID-based canonical event IDs.
7. **Event journal:** Append-only change log for every canonical event mutation.
8. **Policy engine:** Policy graph with edges (from_account -> to_account, detail_level, calendar_kind). Default BUSY overlay policy.
9. **Projection compiler:** Deterministic projection from canonical event + policy -> projected payload. Stable hashing for write skipping.
10. **Write pipeline:** Create/patch/delete mirror events in target accounts. Idempotency keys. Busy overlay calendar auto-creation.
11. **Loop prevention:** Extended properties tagging on all managed events. Classification check on every webhook event.
12. **Cron maintenance:** Watch channel renewal. Token refresh. Daily drift reconciliation.
13. **D1 registry:** Users, orgs, accounts tables for cross-user lookups and webhook routing.
14. **Onboarding workflow:** End-to-end flow from OAuth callback to fully synced account.

### Out of Scope for Phase 1

- Web UI or any frontend
- MCP server
- Trip/constraint system
- VIP policies
- Billable time tagging
- Commitment tracking
- Relationship graph
- Scheduling/solver
- Microsoft Calendar or any non-Google provider
- Multi-user scheduling
- iOS app
- CalDAV feed

### Phase 1 Exit Criteria

1. A user can connect 2+ Google Calendar accounts.
2. Events created in any connected account appear as busy blocks in all other connected accounts within 5 minutes.
3. Event updates and deletions propagate correctly.
4. No sync loops occur under any sequence of creates, updates, and deletes.
5. Daily reconciliation detects and corrects drift.
6. All operations are idempotent and retry-safe.
7. Token refresh and channel renewal operate without manual intervention.
8. All data is encrypted at rest. Refresh tokens never leave AccountDO.

---

## 7. Strategic Positioning and Dependency Map

### The Core Strategic Insight

There are two complementary use cases that drive the product:

**Use Case A (founder's itch):** "I work across N companies. My calendars do not know about each other."
Requires: calendar federation, canonical event store, policy-driven mirroring, loop prevention, busy overlay projection.

**Use Case B (power user's itch):** "I cannot keep track of where my friends live, let alone sort out when we can grab coffee."
Requires: relationship graph, social drift detection, geo-aware reconnection suggestions, life event memory, travel-aware scheduling.

**The dependency:** Use Case B cannot exist without Use Case A. Relationship-aware temporal coordination requires canonical multi-calendar state, trip/constraint awareness, and a unified event history.

**Strategy:** Build A first. B emerges as a feature layer on top of A. Do not pivot. Sequence.

### The Moat

Calendar mirroring is not the moat. Any sufficiently motivated team can build sync.

The moat is:
1. Multi-party constraint solving with fairness
2. Temporal intent typing + policy compilation
3. Commitment rolling-window compliance modeling
4. Reputation scoring with decay + reciprocity
5. Cross-tenant global optimization without privacy leaks

These features are structurally impossible to bolt onto Calendly or Google Calendar.

### What We Deliberately Do NOT Build (First 12 Months)

1. **CalDAV server** -- Too much scope for the value. iOS app talks to our API.
2. **Email/message scraping** -- Privacy nightmare. All data is user-controlled.
3. **Auto-messaging** -- We suggest and draft. We never send without confirmation.
4. **Z3 WASM in Workers** -- External solver when needed (Workers have 128 MB memory limit).
5. **Microsoft Calendar** -- Google first. MSFT after product-market fit.
6. **Multi-org global optimization** -- Requires critical mass of users.
7. **Temporal versioning UI (git for time)** -- Journal gives us the data; UI deferred.
8. **Contact database import** -- We are not a CRM. Relationships are manually curated.

---

## 8. Key Risks and Mitigations

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|-----------|--------|------------|
| R1 | **Sync loops** -- Managed events incorrectly treated as origin events, causing infinite replication. | Medium | Critical | Extended properties tagging on all managed events. Classification check on every inbound event. Invariant E enforced at the DO level. Integration tests covering all loop scenarios. |
| R2 | **Google Calendar API quotas** -- Per-user-project limits on writes (typically 10k/day). High-frequency sync could exhaust quota. | Medium | High | Projection hash comparison to skip unnecessary writes (estimated 60-70% write reduction). Per-account rate limiting in AccountDO. Busy overlay reduces writes vs. true mirroring. |
| R3 | **Webhook reliability** -- Google push notifications are best-effort. Channels can silently stop delivering. | High | High | Daily drift reconciliation (not weekly). "Last successful sync" timestamp per account with alerting. Automatic full sync fallback on 410 Gone. |
| R4 | **Token/credential compromise** -- Stored OAuth tokens provide access to user calendars. | Low | Critical | Envelope encryption (master key in Cloudflare Secrets, per-account DEK, AES-256-GCM). Refresh tokens never leave AccountDO. Access tokens minted JIT. |
| R5 | **Testing against Google Calendar API** -- No sandbox/test environment. Real accounts required for integration testing. | High | Medium | Service account with dedicated test calendars. Mock layer for unit tests. Integration test suite against real accounts in CI. |
| R6 | **DO SQLite 10 GB limit per user** -- Heavy users with years of history could approach limits. | Low | Medium | Monitor storage usage per DO. Event archival strategy (move old events to R2). 10 GB is generous for calendar data. |
| R7 | **Recurring event complexity** -- RRULE expansion, exception instances, moving single occurrences. | Medium | Medium | Phase 1 open question: decide depth of RRULE handling early. Start with instance-level mirroring. |
| R8 | **Scope creep** -- The vision is large. Risk of building Phase 3-4 features before Phase 1 is solid. | High | High | Strict phasing. Phase 1 exit criteria must be met before any Phase 2 work begins. Phase 1 foundation must be robust because all later phases depend on canonical event state. |

---

## 9. Non-Functional Requirements

### Privacy and Compliance

- **NFR-1:** GDPR/CCPA/CPRA compliant by design.
- **NFR-2:** Full deletion capability with cryptographic proof (deletion certificates with signed hashes).
- **NFR-3:** No soft deletes. Tombstone structural references only.
- **NFR-4:** Participant identifiers hashed (SHA-256 + per-org salt). No raw external email storage in event store.
- **NFR-5:** Event content optionally encrypted at rest (user-controlled).
- **NFR-6:** Minimal data collection: only what is needed for sync + policy.
- **NFR-7:** Social reputation data is private by default. Never shared with other users.
- **NFR-8:** Relationship data is never auto-scraped. User-controlled input only.

### Security

- **NFR-9:** OAuth tokens encrypted with AES-256-GCM using per-account data encryption keys (DEK). DEK encrypted with master key stored in Cloudflare Secrets.
- **NFR-10:** Refresh tokens never leave AccountDO boundary.
- **NFR-11:** Webhook endpoint validates X-Goog-Channel-Token, X-Goog-Resource-State, and rejects unknown channel/resource IDs.
- **NFR-12:** Webhook endpoint rate-limited per source IP.
- **NFR-13:** API authentication required for all endpoints (mechanism TBD: session tokens, JWT, or Cloudflare Access).

### Performance

- **NFR-14:** Event propagation latency: under 5 minutes from provider event creation to mirror creation in target accounts (target: under 2 minutes under normal load).
- **NFR-15:** Onboarding full sync for a typical account (500-2000 events) completes within 5 minutes.
- **NFR-16:** API response time for availability queries: under 500ms (data served from DO SQLite, no provider API calls on hot path).
- **NFR-17:** Daily reconciliation completes within 1 hour for all active accounts.

### Reliability

- **NFR-18:** All queue-based operations are idempotent and retry-safe.
- **NFR-19:** No data loss on Worker/DO restart. All state persisted to DO SQLite or D1.
- **NFR-20:** Graceful degradation: if one account's sync fails, other accounts continue operating normally.
- **NFR-21:** Event journal provides full audit trail for debugging sync issues.

### Scalability

- **NFR-22:** Per-user architecture (DO per user) provides natural tenant isolation. No cross-user contention.
- **NFR-23:** System supports 2-10 connected accounts per user in Phase 1.
- **NFR-24:** Queue throughput capacity (5,000 msg/s per queue) is sufficient for foreseeable scale.

### Observability

- **NFR-25:** Per-account sync health tracking (last successful sync timestamp, error counts).
- **NFR-26:** Journal entries for all state mutations enable post-hoc debugging.
- **NFR-27:** R2 audit logs for solver decisions and compliance proof (Phase 3+).

---

## 10. Open Questions for Phase 1

These were identified during architecture design and must be resolved during Phase 1 implementation.

1. **Monorepo tooling:** Turborepo, Nx, or plain workspaces?
2. **Testing strategy:** How to test against Google Calendar API? Service account with test calendars? Mock layer?
3. **Deployment pipeline:** Per-worker wrangler deploy or unified?
4. **API authentication:** Session tokens, JWT, or Cloudflare Access?
5. **Recurring events:** How deep do we handle RRULE expansion? Mirror individual instances or recurrence pattern?
6. **UI framework (Phase 2):** React? Solid? Calendar component library?

---

## 11. Glossary

| Term | Definition |
|------|-----------|
| **Canonical event** | The single source of truth representation of a calendar event, stored in UserGraphDO. All mirrors derive from it. |
| **Mirror** | A projected copy of a canonical event created in a target account's calendar. Contains only the detail level permitted by the policy edge. |
| **Busy overlay** | A dedicated "External Busy" calendar created in each connected account. Mirror events default to this calendar rather than the primary calendar. |
| **Policy edge** | A directional rule: from Account A to Account B, project with detail level X into calendar kind Y. |
| **Projection** | The process of computing a mirror event payload from a canonical event + policy edge. Deterministic and hashable. |
| **Sync token** | Google Calendar API mechanism for incremental change detection. Returned by events.list and used on subsequent calls to get only changes since last sync. |
| **Drift** | Discrepancy between canonical event state and actual provider event state. Detected by reconciliation, corrected automatically. |
| **Origin event** | An event authored by the user in a provider calendar, not created or managed by T-Minus. |
| **Managed event** | An event created by T-Minus (marked with extended properties). Must never be treated as an origin event. |
| **UserGraphDO** | Per-user Durable Object. Stores canonical events, mirrors, journal, policies. The single linearizable coordinator for a user's calendar graph. |
| **AccountDO** | Per-external-account Durable Object. Manages OAuth tokens, sync cursors, watch channels, rate limiting. |
| **Event journal** | Append-only log of all mutations to canonical events. Provides audit trail, debugging, and compliance proof foundation. |

---

*This document is the single source of truth for T-Minus business requirements. It is derived from PLAN.md (validated architecture) and dialog.txt (original product vision). The Sr. PM should use this document to create the product backlog.*
