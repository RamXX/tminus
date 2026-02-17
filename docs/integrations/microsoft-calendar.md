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
