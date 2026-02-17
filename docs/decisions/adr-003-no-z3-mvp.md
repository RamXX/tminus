# ADR-003: No Z3 in MVP -- Greedy Scheduler First

**Status:** Accepted
**Date:** 2026-02-13

## Context

The product vision includes constraint-based scheduling using Z3 or similar
solver. However, Workers have a 128 MB memory limit and no threading support.
Z3 compiled to WASM is approximately 20-30 MB binary alone and uses parallel
solving internally.

## Decision

MVP uses a greedy interval scheduler. Z3/constraint solver is deferred to
Phase 4+. When needed, run it as an external service called from a Workflow step.

## Consequences

- (+) Stays within Workers memory and CPU constraints.
- (+) Greedy enumeration + scoring is sufficient for 2-5 accounts.
- (+) Simpler to implement, test, and debug.
- (-) Cannot solve complex multi-party optimization problems in Phase 1-3.
- (-) When Z3 is eventually needed, requires external service infrastructure
  (Cloudflare Containers, or external compute).

## Migration Path

The SchedulingWorkflow abstraction (Phase 3) will call a "solve" step. In MVP,
that step runs greedy enumeration. When Z3 is needed, the step calls an external
solver service. The Workflow interface does not change.
