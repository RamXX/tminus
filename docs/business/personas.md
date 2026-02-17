# Target Users and Personas

---

## Primary Persona: The Multi-Org Operator

**Who:** Contractors, consultants, advisors, board members, VC partners.

**Profile:** Works across 2-10 organizations simultaneously. Holds separate
Google Workspace accounts per organization. Manages 15-50 meetings per week
across these accounts.

**Pain:**
- Double-booked constantly because calendars do not know about each other.
- Spends 30+ minutes daily manually coordinating busy blocks across accounts.
- Cannot prove time commitments to clients (e.g., "1 day per week average").
- Loses track of relationships and lets important connections drift.

**Success looks like:** Connect accounts once. Never manually copy-paste a busy
block again. See a unified view. Get intelligent scheduling that respects
constraints, commitments, and relationships.

**Phase 1 touchpoints:**
- OAuth redirect flow to link Google accounts
- REST API for policy configuration and sync status
- Busy overlay calendars appearing in their Google Calendar

---

## Secondary Persona: The Relationship-Rich Professional

**Who:** Founders, executives, globally networked professionals (the "25 years
in startups on 4 continents" archetype).

**Profile:** Hundreds of meaningful relationships across categories (family,
investors, friends, clients, board members). Travels frequently. Cannot keep
track of where contacts live, let alone coordinate meetups.

**Pain:**
- Misses important life events (graduations, birthdays) because of scheduling noise.
- Cannot identify when a trip overlaps with a contact's city for reconnection.
- No visibility into relationship drift (when did I last see this person?).
- Wants memory augmentation, not automation. Does not want an agent messaging
  people on their behalf.

**Success looks like:** The system surfaces "You are overdue to see Alex. You
will be in Berlin next week and Alex lives there. 45-minute window available
Tuesday." The user decides whether to act on it.

---

## Tertiary Persona (Future): The AI-Native Power User

**Who:** Professionals using AI assistants (Claude, GPT, etc.) for daily workflow.

**Pain:** Cannot control their calendar through their AI assistant. Calendar
operations require switching to a separate UI.

**Success looks like:** Issue natural language commands via MCP: "Block all my
calendars for the Berlin trip. Protect 6 hours of deep work next week unless it
is an ARR-critical meeting. Move all low-priority 1:1s if an investor call
comes in."

---

## API Consumer Persona

**Who:** Internal or future external developer building on the T-Minus REST API.
In Phase 2, this includes the MCP server and the calendar UI frontend.

**Core need:** Predictable, well-documented endpoints with clear error
responses and idempotent behavior.

**Phase 1 touchpoints:**
- REST API (accounts, events, policies, sync status)
- Queue message contracts (for building new consumers)
- DO RPC interfaces (for service-to-service calls)

---

## Operator Persona

**Who:** The engineer monitoring sync health, debugging failures, and ensuring
the system operates correctly.

**Core need:** Know whether sync is healthy. When it is not, know exactly
which account, which event, and what went wrong.

**Phase 1 touchpoints:**
- Sync status endpoints (per-account health)
- Event journal (audit trail for every mutation)
- Queue dead-letter visibility
- Cron job health (channel renewal, token refresh, reconciliation)

---

## Non-Functional Requirements

### Privacy and Compliance

| ID | Requirement |
|----|-------------|
| NFR-1 | GDPR/CCPA/CPRA compliant by design |
| NFR-2 | Full deletion capability with cryptographic proof |
| NFR-3 | No soft deletes. Tombstone structural references only |
| NFR-4 | Participant identifiers hashed (SHA-256 + per-org salt) |
| NFR-5 | Event content optionally encrypted at rest |
| NFR-6 | Minimal data collection: only what is needed for sync + policy |
| NFR-7 | Social reputation data is private by default |
| NFR-8 | Relationship data is never auto-scraped |

### Performance

| ID | Requirement |
|----|-------------|
| NFR-14 | Event propagation: under 5 minutes (target: under 2 minutes) |
| NFR-15 | Onboarding full sync: within 5 minutes for 500-2000 events |
| NFR-16 | Availability queries: under 500ms |
| NFR-17 | Daily reconciliation: within 1 hour for all accounts |

### Reliability

| ID | Requirement |
|----|-------------|
| NFR-18 | All queue operations idempotent and retry-safe |
| NFR-19 | No data loss on Worker/DO restart |
| NFR-20 | Graceful degradation: one account failure does not affect others |
| NFR-21 | Event journal provides full audit trail |

### Scalability

| ID | Requirement |
|----|-------------|
| NFR-22 | Per-user DO architecture: natural tenant isolation |
| NFR-23 | 2-10 connected accounts per user in Phase 1 |
| NFR-24 | Queue throughput sufficient for foreseeable scale |

---

## Glossary

| Term | Definition |
|------|-----------|
| **Canonical event** | The single source of truth representation of a calendar event, stored in UserGraphDO. |
| **Mirror** | A projected copy of a canonical event created in a target account's calendar. |
| **Busy overlay** | A dedicated "External Busy" calendar created in each connected account. |
| **Policy edge** | A directional rule: from Account A to Account B, project with detail level X. |
| **Projection** | The process of computing a mirror event payload from a canonical event + policy edge. |
| **Sync token** | Google Calendar API mechanism for incremental change detection. |
| **Drift** | Discrepancy between canonical event state and actual provider event state. |
| **Origin event** | An event authored by the user in a provider calendar, not managed by T-Minus. |
| **Managed event** | An event created by T-Minus (marked with extended properties). |
| **UserGraphDO** | Per-user Durable Object. Stores canonical events, mirrors, journal, policies. |
| **AccountDO** | Per-external-account Durable Object. Manages OAuth tokens, sync cursors, watch channels. |
| **Event journal** | Append-only log of all mutations to canonical events. |
