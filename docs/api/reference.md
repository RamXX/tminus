# API Reference

Base URL: `https://api.tminus.ink/v1`

All requests require `Authorization: Bearer <token>` (see [Authentication](authentication.md)).
All responses use the standard [envelope format](envelope.md).

---

## Accounts

### POST /v1/accounts/link

Start the OAuth flow for a new calendar account.

### GET /v1/accounts

List all linked accounts for the authenticated user.

### GET /v1/accounts/:id

Get account details including sync status.

### DELETE /v1/accounts/:id

Unlink account (revoke tokens + cleanup).

---

## Events

### GET /v1/events

Returns the unified canonical event list. This is the "single pane of glass"
that the calendar UI renders.

**Query parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `start` | Yes | ISO 8601 datetime, inclusive |
| `end` | Yes | ISO 8601 datetime, exclusive |
| `account_id` | No | Filter to events originating from one account |
| `status` | No | `confirmed`, `tentative`, `cancelled` |
| `cursor` | No | Pagination cursor |
| `limit` | No | Default 100, max 500 |

**Response (data field):**

```json
{
  "events": [
    {
      "canonical_event_id": "evt_01H...",
      "origin_account_id": "acc_01H...",
      "title": "Board Meeting",
      "start_ts": "2026-02-14T09:00:00Z",
      "end_ts": "2026-02-14T10:00:00Z",
      "timezone": "America/Los_Angeles",
      "all_day": false,
      "status": "confirmed",
      "visibility": "default",
      "transparency": "opaque",
      "source": "provider",
      "version": 3,
      "mirrors": [
        {
          "target_account_id": "acc_02H...",
          "state": "ACTIVE",
          "last_write_ts": "2026-02-13T08:30:00Z"
        }
      ]
    }
  ],
  "next_cursor": "cur_01H..."
}
```

### GET /v1/events/:id

Get a single canonical event with mirror status for all target accounts.

### POST /v1/events

Create a canonical event (source='api'). The event will be projected to
all connected accounts per policy.

### PATCH /v1/events/:id

Update a canonical event. Projections recompute automatically.

### DELETE /v1/events/:id

Delete a canonical event and all its mirrors.

---

## Policies

### GET /v1/policies

List all policies for the authenticated user.

### GET /v1/policies/:id

Get a policy with its edges.

### POST /v1/policies

Create a new policy.

### PUT /v1/policies/:id/edges

Set policy edges (replaces all edges for this policy).

---

## Sync Status

### GET /v1/sync/status

Aggregate sync health for all linked accounts.

```json
{
  "overall": "healthy",
  "accounts": [
    {
      "account_id": "acc_01H...",
      "email": "me@company-a.com",
      "provider": "google",
      "status": "healthy",
      "last_sync_ts": "2026-02-13T10:02:00Z",
      "last_success_ts": "2026-02-13T10:02:00Z",
      "channel_status": "active",
      "channel_expiry_ts": "2026-02-20T10:00:00Z",
      "pending_writes": 0,
      "error_mirrors": 0
    }
  ]
}
```

### GET /v1/sync/status/:accountId

Per-account sync health.

### GET /v1/sync/journal

Query the event journal (audit trail). Useful for debugging sync issues.

---

## Conventions

**Pagination:** Cursor-based. Responses include `meta.next_cursor` when more
results exist. Clients pass `?cursor=<value>`.

**Timestamps:** ISO 8601, always UTC in wire format. Timezone context carried
as a separate field where relevant (e.g., `event.timezone`).

**IDs:** ULIDs throughout. Prefixed by entity type for human readability:
`usr_`, `acc_`, `evt_`, `pol_`, `cal_`, `jrn_`.
