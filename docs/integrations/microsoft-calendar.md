# Microsoft Calendar Integration

**Status:** Planned for Phase 5

Microsoft Calendar (Outlook/Microsoft 365) is the second provider integration for T-Minus. The architecture is designed to support multiple providers via a provider abstraction in the sync-consumer.

---

## Current State

- OAuth credentials (MS_CLIENT_ID, MS_CLIENT_SECRET) are already part of the [secrets registry](../operations/secrets.md)
- Provider field in D1 accounts table supports `'google'` and `'microsoft'`
- AccountDO and sync-consumer have extension points for additional providers

## Planned Integration

When implemented, Microsoft Calendar will follow the same patterns as Google Calendar:

1. **OAuth flow:** Microsoft Entra ID (Azure AD) OAuth2 with PKCE
2. **Sync:** Microsoft Graph API `delta` query (equivalent to Google's syncToken)
3. **Webhooks:** Microsoft Graph subscriptions (equivalent to Google's watch channels)
4. **Token management:** Same envelope encryption via AccountDO

## Extension Points

- `workers/oauth/src/index.ts` -- Add Microsoft OAuth callback handler
- `workers/sync-consumer/src/index.ts` -- Add Microsoft delta sync logic
- `workers/webhook/src/index.ts` -- Add Microsoft Graph subscription validation
- `durable-objects/account/src/token.ts` -- Add Microsoft token refresh logic

---

## Webhook Routing (Per-Scope)

Microsoft Graph change notifications arrive at `POST /webhook/microsoft`. The webhook worker resolves each notification's `subscriptionId` to an `account_id` and a scoped `calendar_id` using a two-path lookup strategy.

### Direct Accounts Lookup (Preferred)

The preferred path queries the `accounts` table directly, matching `subscriptionId` against the `channel_id` column for active (non-revoked) Microsoft accounts. This also fetches `channel_calendar_id` for scoped routing:

```sql
SELECT account_id, channel_token, channel_calendar_id
FROM accounts
WHERE provider = 'microsoft'
  AND status != 'revoked'
  AND channel_id = ?1
```

When found, `channel_calendar_id` is passed through as the `calendar_id` in the enqueued `SYNC_INCREMENTAL` message.

### Legacy `ms_subscriptions` Fallback

If the direct lookup returns no rows, the worker falls back to the `ms_subscriptions` table. This handles subscriptions created before per-scope routing was added:

```sql
SELECT a.account_id, a.channel_token, ms.calendar_id
FROM ms_subscriptions ms
JOIN accounts a ON a.account_id = ms.account_id
WHERE ms.subscription_id = ?1
  AND a.status != 'revoked'
```

**Legacy subscription behavior:** Subscriptions created before per-scope routing have `calendar_id = NULL` in `ms_subscriptions`. The webhook worker enqueues the message with `calendar_id: null` and emits telemetry. The sync-consumer handles this by syncing all scopes for the account, maintaining backward compatibility.

**Schema change:** MIGRATION_0027 added the `calendar_id` column to the `ms_subscriptions` table. It is nullable so existing rows default to NULL.

### `clientState` Validation

Microsoft Graph uses `clientState` for webhook authentication. The webhook worker validates `clientState` with a two-tier strategy:

1. **Per-account `channel_token`** (preferred): If the account has a `channel_token` set (populated during subscription creation), the notification's `clientState` must match it exactly.
2. **Environment-level `MS_WEBHOOK_CLIENT_STATE` fallback**: If `channel_token` is NULL (older subscriptions created before per-account secrets), the worker falls back to the `MS_WEBHOOK_CLIENT_STATE` environment variable.

A `clientState` mismatch skips the individual notification but does not fail the entire batch -- other notifications in the same payload continue processing. This prevents a single tampered notification from blocking legitimate ones.

### Response Contract

Microsoft expects `202 Accepted` for successful notification processing. The worker always returns 202 regardless of individual notification failures to prevent Microsoft from retrying the entire batch.
