# ADR-001: DO SQLite as Primary Per-User Storage, Not D1

**Status:** Accepted
**Date:** 2026-02-13

## Context

The system needs to store per-user calendar data including canonical events,
mirrors, journal entries, policies, constraints, and relationship data. Two
Cloudflare storage options were evaluated: D1 (shared relational database) and
DO SQLite (per-Durable-Object colocated SQLite).

D1 is backed by a single Durable Object internally, is single-threaded, and
has a 10 GB total database limit that cannot be increased. Placing all users
into one D1 would create a bottleneck and a hard ceiling on total data.

## Decision

Each UserGraphDO stores all per-user data in its colocated SQLite database.
D1 is used ONLY for cross-user lookups (user registry, account routing,
org metadata, billing state, deletion certificates).

## Consequences

- (+) 10 GB per user, not per system. Natural tenant isolation.
- (+) Zero network hop on the hot path -- compute and storage colocated.
- (+) No cross-user contention. Each user's DO processes independently.
- (+) Single-threaded serialization within DO guarantees consistency per user.
- (-) Cross-user queries (e.g., "find all accounts for scheduling session")
  require D1 lookup first, then fan out to individual DOs.
- (-) No single SQL view across all users. Aggregation requires explicit
  fan-out patterns.
- (-) Schema migrations must be handled per-DO (on first access after deploy).

## What Goes Where

**D1 contains only:**
- `users`, `orgs`, `accounts` registry
- Cross-user scheduling session metadata
- Billing/subscription state
- Deletion certificates (GDPR/CCPA proof)

**DO SQLite contains (per user):**
- `canonical_events`, `event_mirrors`, `event_journal`
- `calendars`, `policies`, `policy_edges`, `constraints`
- `time_allocations`, `time_commitments`, `commitment_reports`
- `relationships`, `interaction_ledger`, `milestones`
- `vip_policies`, `excuse_profiles`
- `schedule_sessions`, `schedule_candidates`, `schedule_holds`
