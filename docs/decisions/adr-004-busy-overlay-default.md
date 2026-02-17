# ADR-004: Busy Overlay Calendars by Default

**Status:** Accepted
**Date:** 2026-02-13

## Context

Two models exist for projecting events across accounts: true mirroring
(duplicate the full event) and busy overlay (create a "Busy" block in a
dedicated calendar). True mirroring requires more API writes, creates attendee
confusion, and mixes real events with projected ones.

## Decision

Mirror events into a dedicated "External Busy" calendar per account rather than
inserting into the primary calendar. True mirroring is available as an opt-in
policy upgrade via the `calendar_kind` field on `policy_edges`.

## Consequences

- (+) ~60-70% fewer API writes vs true mirroring, reducing quota consumption.
- (+) No attendee confusion -- projected events live in a separate calendar.
- (+) Cleaner UX -- users see real events + busy blocks, clearly separated.
- (+) Google Calendar natively respects busy blocks for free/busy queries.
- (-) Users cannot see event titles from other accounts by default (requires
  policy upgrade to TITLE or FULL detail level).
- (-) Requires creating and managing an extra calendar per account.
