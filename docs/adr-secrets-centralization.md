# ADR: Secrets Centralized in API Worker, Accessed via DO RPC

**Status**: Accepted
**Date**: 2026-02-16
**Story**: TM-pd65
**Category**: Security Architecture

## Context

T-Minus uses a multi-worker architecture on Cloudflare Workers. Sensitive credentials
(OAuth client secrets, encryption master keys, JWT signing secrets) must be available
to various operations (token refresh, encryption, auth validation). The question is
whether each worker should have its own copy of these secrets, or whether they should
be centralized.

## Decision

**Secrets are centralized in the tminus-api worker. Other workers access credential
operations exclusively via Durable Object RPC.**

The tminus-api worker hosts both `AccountDO` and `UserGraphDO` class definitions.
`AccountDO` encapsulates all credential-sensitive operations:

- Token decryption/encryption (uses `MASTER_KEY`)
- OAuth token refresh (AccountDO calls Google/Microsoft token endpoints internally)
- Access token minting (decrypts stored tokens, returns only the access_token)

Workers that need credentials (sync-consumer, cron, write-consumer) call AccountDO
methods via DO stubs (`env.ACCOUNT.get(doId).fetch(...)`). The DO stub routes the
request to the tminus-api worker where AccountDO runs with access to `MASTER_KEY`
and other secrets.

## Workers and Their Secret Requirements

| Worker | Secrets Needed Directly | Secrets via DO RPC | Notes |
|--------|------------------------|--------------------|-------|
| tminus-api | MASTER_KEY, JWT_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, MS_CLIENT_ID, MS_CLIENT_SECRET | N/A (hosts the DOs) | Central secret holder |
| tminus-oauth | GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, MS_CLIENT_ID, MS_CLIENT_SECRET, MASTER_KEY, JWT_SECRET | N/A | Handles OAuth flow directly |
| tminus-sync-consumer | None | getAccessToken, getSyncToken, setSyncToken, markSync* | All via AccountDO RPC |
| tminus-webhook | MS_WEBHOOK_CLIENT_STATE (future) | None | Google: validates via D1 channel_token. Microsoft: needs clientState secret when live |
| tminus-write-consumer | None (likely via DO RPC) | Via AccountDO RPC | Same pattern as sync-consumer |
| tminus-cron | None (likely via DO RPC) | Via AccountDO RPC | Same pattern |
| tminus-push | APNS_KEY_ID, APNS_TEAM_ID, APNS_PRIVATE_KEY | None | Push notification credentials are worker-specific |
| tminus-mcp | JWT_SECRET | None | Auth validation |
| tminus-app-gateway | None | None | Static SPA serving + proxy |

## Rationale

1. **Security (BR-8)**: Refresh tokens never leave the AccountDO boundary. Only
   access tokens are returned via RPC. This is an explicit security invariant.

2. **Reduced secret sprawl**: Only 2 workers need OAuth credentials (api, oauth).
   Queue consumers and cron workers do not.

3. **Single point of token refresh**: AccountDO serializes token refresh per account,
   preventing duplicate refresh requests that could invalidate tokens.

4. **Operational simplicity**: Fewer `wrangler secret put` operations to manage.
   Secret rotation only needs to update the API worker's secrets.

## Consequences

- Workers are coupled to tminus-api availability for credential operations (acceptable
  since DO stubs are the standard Cloudflare pattern for cross-worker communication).
- If a worker ever needs direct secret access (e.g., for a new integration that
  bypasses AccountDO), that worker's wrangler.toml and Cloudflare dashboard must be
  updated.

## Action Items from Audit (TM-pd65)

1. [DONE] Removed stale secret type declarations from sync-consumer env.d.ts
   (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, MASTER_KEY were declared but never used)
2. [DONE] Updated sync-consumer wrangler.toml comments to document that no secrets
   are needed
3. [DONE] Updated webhook wrangler.toml comments to list MS_WEBHOOK_CLIENT_STATE
   (the one secret it actually needs) and remove MASTER_KEY/JWT_SECRET (not used)
4. [NOTE] MS_WEBHOOK_CLIENT_STATE needs `wrangler secret put` when Microsoft
   provider support goes live
