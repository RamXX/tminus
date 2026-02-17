# Google Calendar Integration

Google Calendar is the primary provider integration for T-Minus (Phase 1).

---

## OAuth Flow

T-Minus uses Google OAuth 2.0 with PKCE (S256) for account linking.

**Scopes requested:**
- `https://www.googleapis.com/auth/calendar` -- Full calendar access
- `https://www.googleapis.com/auth/calendar.events` -- Event CRUD
- `openid email profile` -- User identification (provider_subject)

**Redirect URIs:**
- Production: `https://oauth.tminus.ink/callback/google`
- Staging: `https://oauth-staging.tminus.ink/callback/google`

For the detailed flow diagram and error states, see [Authentication](../api/authentication.md).

---

## Sync Mechanism

### Incremental Sync (Primary)

Google Calendar push notifications trigger incremental sync:

1. **Watch channel** registered per account during onboarding
2. Google sends push notifications to `webhooks.tminus.ink` when events change
3. webhook-worker validates headers and enqueues `SYNC_INCREMENTAL`
4. sync-consumer fetches changes via `events.list(syncToken=...)`
5. Each event is classified (origin vs managed) and processed

### Full Sync (Fallback)

Full sync is used for:
- **Onboarding:** Initial ingestion of all events
- **Reconciliation:** Daily drift repair (see [ADR-006](../decisions/adr-006-daily-reconciliation.md))
- **410 Gone:** When a sync token becomes stale

Full sync uses paginated `events.list` without a syncToken.

---

## Webhook Handling

### Request Validation

1. `X-Goog-Channel-ID` must match a known channel_id in D1
2. `X-Goog-Resource-State` must be one of: `sync`, `exists`, `not_exists`
3. `X-Goog-Channel-Token` must match the stored token for that channel
4. Per source IP rate limiting
5. Always returns 200 (Google requires this; non-200 triggers backoff from Google)

### Notification Types

- **`sync`**: Sent immediately when watch channel is created. Acknowledged but not processed (no real change).
- **`exists`** and **`not_exists`**: Both trigger `SYNC_INCREMENTAL` enqueueing. The sync-consumer uses the syncToken to fetch actual deltas.

### Deduplication

Google may send duplicate notifications. The sync-consumer handles this naturally:
- If the syncToken has not advanced, `events.list` returns empty
- If the canonical event is already up-to-date, no mirror writes occur
- The projection hash comparison prevents redundant PATCH calls

---

## Watch Channel Lifecycle

- Channels typically expire after 7 days
- Cron worker renews channels expiring within 24 hours or with no sync in 12 hours
- Renewal process:
  1. Stop old channel with Google (best-effort)
  2. Register new channel via `events.watch` API
  3. Store new channel in AccountDO
  4. Update D1 with new channel_id, token, expiry, resource_id

---

## Event Classification

Every event from Google Calendar is classified using extended properties:

```json
{
  "extendedProperties": {
    "private": {
      "tminus": "true",
      "managed": "true",
      "canonical_event_id": "evt_...",
      "origin_account_id": "acc_..."
    }
  }
}
```

- If `tminus == "true"` AND `managed == "true"`: **managed mirror** -- check for drift only
- All other events: **origin event** -- normalize and ingest

See [Correctness Invariants](../architecture/correctness-invariants.md) for the non-negotiable rules around classification.

---

## API Quota Considerations

Google Calendar API quotas are per-user-project:
- Typical limit: ~10,000 writes/day
- Busy overlay reduces writes by ~60-70% vs true mirroring ([ADR-004](../decisions/adr-004-busy-overlay-default.md))
- Projection hash comparison skips unnecessary writes
- Per-account rate limiting in AccountDO matches Google's quota model

---

## Recurring Events

Google Calendar API returns recurring events as both a "master" event (with RRULE) and individual instances (expanded). T-Minus stores the RRULE on the canonical event for reference but mirrors individual instances, because Google's sync token mechanism reports changes at the instance level. The projection hash comparison prevents unnecessary writes for unchanged instances.
