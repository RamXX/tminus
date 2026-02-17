# Vision and Strategy

---

## Problem Statement

Professionals who operate across multiple organizations -- contractors, consultants,
advisors, board members, venture capitalists -- maintain separate Google Calendar
accounts per organization. These calendars are mutually unaware. The result is
chronic double-booking, manual copy-paste of busy blocks, missed commitments,
and zero cross-calendar intelligence.

Beyond scheduling conflicts, these professionals lose track of relationships:
where contacts live, when they last met someone, whether they are fulfilling time
commitments to clients, and whether a trip abroad overlaps with a friend's city.
No existing tool solves this because the problem spans calendar federation, time
governance, and relational coordination.

---

## Why Existing Tools Fail

- **Google Calendar:** No native cross-account awareness. Each Workspace tenant is isolated.
- **Calendly / scheduling links:** Solve booking availability for external parties but do not federate the user's own calendars or provide time governance.
- **CRMs (Salesforce, HubSpot):** Optimize revenue pipelines. They do not model social health, scheduling fairness, or temporal coordination.
- **Manual workarounds (copy-paste busy blocks):** Error-prone, do not scale beyond 2 accounts, provide no intelligence layer.

---

## The Opportunity

Build a Cloudflare-native temporal and relational intelligence engine that
federates multiple Google Calendar accounts into a single canonical event store,
projects events outward via configurable policies, and layers scheduling
intelligence, relationship awareness, and time governance on top.

---

## Strategic Positioning

### Two Complementary Use Cases

**Use Case A (founder's itch):** "I work across N companies. My calendars do not
know about each other. I get double-booked constantly."

Requires: calendar federation, canonical event store, policy-driven mirroring,
loop prevention, busy overlay projection.

**Use Case B (power user's itch):** "I cannot keep track of where my friends
live, let alone sort out when we can grab coffee."

Requires: relationship graph, social drift detection, geo-aware reconnection
suggestions, life event memory, travel-aware scheduling.

### The Dependency

Use Case B cannot exist without Use Case A. Relationship-aware temporal
coordination requires canonical multi-calendar state, trip/constraint awareness,
and a unified event history.

**Strategy:** Build A first. B emerges as a feature layer on top of A. Do not
pivot. Sequence.

### The Moat

Calendar mirroring is not the moat. Any sufficiently motivated team can build sync.

The moat is:
1. Multi-party constraint solving with fairness
2. Temporal intent typing + policy compilation
3. Commitment rolling-window compliance modeling
4. Reputation scoring with decay + reciprocity
5. Cross-tenant global optimization without privacy leaks

These features are structurally impossible to bolt onto Calendly or Google Calendar.

---

## What We Deliberately Do NOT Build (First 12 Months)

1. **CalDAV server** -- Too much scope for the value. iOS app talks to our API.
2. **Email/message scraping** -- Privacy nightmare. All data is user-controlled.
3. **Auto-messaging** -- We suggest and draft. We never send without confirmation.
4. **Z3 WASM in Workers** -- External solver when needed (Workers have 128 MB memory limit).
5. **Microsoft Calendar** -- Google first. MSFT after product-market fit.
6. **Multi-org global optimization** -- Requires critical mass of users.
7. **Temporal versioning UI (git for time)** -- Journal gives us the data; UI deferred.
8. **Contact database import** -- We are not a CRM. Relationships are manually curated.

---

## Business Outcomes and Success Metrics

### Outcome 1: Eliminate Cross-Calendar Blindness (Phase 1)

**Metric:** Zero double-bookings caused by cross-account unawareness after all accounts are connected.
**Target:** 100% of events from connected accounts reflected as busy blocks in all other connected accounts within 5 minutes of creation.

### Outcome 2: Frictionless Onboarding (Phase 1)

**Metric:** Time from "start OAuth flow" to "all accounts synced and projecting" is under 10 minutes for 2-3 accounts.

### Outcome 3: Daily Usability (Phase 2)

**Metric:** User can manage all calendars from a single interface (web UI or MCP) without opening individual Google Calendar accounts.

### Outcome 4: Commitment Compliance (Phase 3)

**Metric:** Users can generate verifiable proof of hours worked per client within a rolling window.

### Outcome 5: Relationship Health (Phase 4)

**Metric:** Reduction in relationship drift. Increase in proactive reconnections during travel.

---

## Key Risks and Mitigations

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|-----------|--------|------------|
| R1 | Sync loops | Medium | Critical | Extended properties tagging. Classification check. Invariant E. Integration tests. |
| R2 | Google API quotas | Medium | High | Projection hash comparison. Per-account rate limiting. Busy overlay. |
| R3 | Webhook reliability | High | High | Daily reconciliation. Last sync timestamp alerting. Full sync fallback. |
| R4 | Token compromise | Low | Critical | Envelope encryption. Refresh tokens never leave DO. Access tokens JIT. |
| R5 | Google API testing | High | Medium | Service account with test calendars. Mock layer for unit tests. |
| R6 | DO SQLite 10 GB limit | Low | Medium | Monitor storage. Event archival to R2. |
| R7 | Recurring event complexity | Medium | Medium | Instance-level mirroring. Store RRULE for reference. |
| R8 | Scope creep | High | High | Strict phasing. Phase 1 exit criteria before Phase 2. |

---

## Business Rules

### Sync Correctness (Non-Negotiable)

- BR-1: Every provider event classified as exactly one of: origin, managed mirror, or foreign managed.
- BR-2: Canonical event IDs (ULID) generated at creation, never change.
- BR-3: Projections deterministic. Stable hashing for write skipping.
- BR-4: Every external write carries an idempotency key.
- BR-5: Managed events never treated as origin events.

### Data Privacy (Non-Negotiable)

- BR-6: Participant identifiers stored as SHA-256(email + per-org salt).
- BR-7: No soft deletes. Deletion certificates with signed proof hashes.
- BR-8: Refresh tokens never leave AccountDO.
- BR-9: Minimal data collection principle.

### Projection Defaults

- BR-10: Default projection mode is BUSY (time only).
- BR-11: Default calendar kind is BUSY_OVERLAY.
- BR-12: True mirroring is opt-in per policy edge.

### User Experience

- BR-17: System suggests and drafts but never sends messages without user confirmation.
- BR-18: Relationship data is never auto-scraped. User-controlled input only.
