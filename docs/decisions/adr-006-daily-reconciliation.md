# ADR-006: Daily Drift Reconciliation, Not Weekly

**Status:** Accepted
**Date:** 2026-02-13

## Context

The original design proposed weekly reconciliation. Analysis of Google Calendar
push notification reliability revealed several failure modes:

- Channels can silently stop delivering notifications.
- Sync tokens can go stale (410 Gone).
- Duplicate and out-of-order notifications are common.
- There is no delivery guarantee from Google.

A "last successful sync" timestamp per account with alerting is required.

## Decision

Drift reconciliation runs daily via cron, not weekly.

## Consequences

- (+) Catches silent webhook failures within 24 hours instead of 7 days.
- (+) Catches stale sync tokens before user notices drift.
- (+) More frequent reconciliation reduces the blast radius of missed events.
- (-) More API quota consumption (one full sync per account per day).
  Mitigation: full sync uses `updatedMin` parameter to limit scope.
- (-) More queue traffic. Mitigation: reconcile-queue is separate from
  sync-queue to avoid contention.
