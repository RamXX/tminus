# ADR-008: Federated Coordination SoR (No Provider-Primary)

- Date: 2026-02-18
- Status: Accepted
- Deciders: Product + Architecture

## Context

T-Minus originally evolved from a practical pattern where one provider account
looked like a "primary" account and others mirrored around it. The product
direction has since shifted: T-Minus owns coordination logic, while external
calendars remain execution surfaces.

The current implementation still contains a single-calendar assumption in key
paths (onboarding/sync/watch use provider `primary` calendar), which can be
misread as provider-primary architecture.

## Decision

T-Minus is the **System of Coordination**.

1. Canonical events, policy edges, and journal are authoritative in T-Minus.
2. No connected provider account is the global primary source by definition.
3. Each account exposes a selected calendar scope (target: one or more
   calendars), and sync operates over that scope.
4. Sync cursoring and webhook/subscription routing are modeled per scoped
   calendar (or equivalent provider resource), not implicitly one per account.
5. Field-level authority is policy-driven (BUSY/TITLE/FULL and direction),
   not derived from provider brand.

## Consequences

Positive:

- Removes hidden dependency on a specific provider account.
- Matches multi-provider intent (Google + Microsoft + CalDAV) symmetrically.
- Makes conflict handling and propagation rules explicit and testable.

Costs / tradeoffs:

- Requires schema/runtime changes for per-calendar cursor/watch handling.
- Increases onboarding complexity (calendar-scope selection UX/API).
- Requires stronger integration tests for multi-calendar topologies.

## Implementation Constraints

- Do not regress existing single-calendar behavior while introducing scope.
- Preserve invariant: all mutations flow through canonical state before writes.
- Keep provider-specific tokens in AccountDO only.
- Add E2E proof for at least one multi-calendar Google account and one
  Microsoft account in the same user topology.

## Non-goals

- Cross-tenant global optimization.
- Replacing provider-native calendars as the user's only UI.
