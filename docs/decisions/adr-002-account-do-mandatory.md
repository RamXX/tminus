# ADR-002: AccountDO is Mandatory (Not Optional)

**Status:** Accepted
**Date:** 2026-02-13

## Context

Each connected external account (e.g., a Google Calendar account) needs token
management, sync cursor tracking, watch channel lifecycle, and rate limiting.
These operations require serialization -- concurrent token refreshes produce
races, concurrent `events.list(syncToken=...)` calls produce undefined behavior,
and Google Calendar API quotas are per-user-project.

The original design dialog marked AccountDO as "optional." Analysis elevated it
to mandatory.

## Decision

Each connected external account gets its own AccountDO instance.

## Consequences

- (+) Token refresh is serialized -- no race conditions between queue consumers.
- (+) Sync cursor management is serialized -- no undefined behavior from
  concurrent `events.list(syncToken=...)` calls.
- (+) Rate limiting is per-account, matching Google's quota model.
- (+) Watch channel lifecycle (create, renew, expire) is cleanly isolated.
- (+) Queue consumers call `AccountDO.getAccessToken()` JIT -- tokens never
  leave the DO boundary unnecessarily.
- (-) Additional DO class adds to operational surface area.
- (-) Cross-account operations require fan-out to multiple AccountDOs.

## AccountDO Responsibilities

- Store and refresh OAuth tokens (encrypted via envelope encryption)
- Manage sync cursor (syncToken)
- Manage watch channel lifecycle (create, renew, expire)
- Provide `getAccessToken()` RPC for queue consumers
- Rate-limit outbound API calls per account
