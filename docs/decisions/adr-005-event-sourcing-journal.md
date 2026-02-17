# ADR-005: Event-Sourcing via Append-Only Change Journal

**Status:** Accepted
**Date:** 2026-02-13

## Context

The system needs auditability for multiple reasons: GDPR/CCPA deletion proof,
commitment compliance verification, sync debugging, and the future "temporal
versioning" differentiator. A simple CRUD model loses history.

## Decision

All mutations to the canonical event store produce an append-only journal entry
in `event_journal` with `actor`, `change_type`, `patch_json`, and `reason`.

## Consequences

- (+) GDPR/CCPA: can prove what was deleted and when.
- (+) Commitment compliance: verifiable time digests for proof export.
- (+) Debugging: full history of "why did this event change?"
- (+) Foundation for "temporal versioning" (Phase 5 differentiator).
- (-) Storage grows monotonically. Requires periodic archival to R2.
- (-) Journal queries may be slow for users with very long histories.
  Mitigation: index on `canonical_event_id` and `ts`.
