# Error Codes

Errors use structured codes, not HTTP status codes alone. Every error response
includes `request_id` for correlation.

## Error Code Taxonomy

| Code | HTTP | Meaning |
|------|------|---------|
| `VALIDATION_ERROR` | 400 | Malformed request body or params |
| `AUTH_REQUIRED` | 401 | Missing or invalid bearer token |
| `FORBIDDEN` | 403 | Valid auth but insufficient permissions |
| `NOT_FOUND` | 404 | Entity does not exist |
| `CONFLICT` | 409 | Optimistic concurrency conflict (stale version) |
| `ACCOUNT_REVOKED` | 422 | Account OAuth tokens revoked by user |
| `ACCOUNT_SYNC_STALE` | 422 | Account has not synced in >24 hours |
| `PROVIDER_ERROR` | 502 | Google Calendar API returned an error |
| `PROVIDER_QUOTA` | 429 | Google Calendar API quota exceeded |
| `INTERNAL_ERROR` | 500 | Unexpected system error |

Provider errors include the upstream error detail when safe to expose.

## Error Handling Layers

```
  Layer 1: Input Validation (api-worker)
  +-----------------------------------------+
  | Malformed JSON, missing fields, bad IDs |
  | Response: 400 + VALIDATION_ERROR        |
  | No side effects. Fast fail.             |
  +-----------------------------------------+
           |
           v
  Layer 2: Authorization (api-worker)
  +-----------------------------------------+
  | Invalid token, wrong user, no access    |
  | Response: 401/403                       |
  | No side effects. Fast fail.             |
  +-----------------------------------------+
           |
           v
  Layer 3: Business Logic (UserGraphDO)
  +-----------------------------------------+
  | Concurrency conflict (stale version),   |
  | account not found, policy violation     |
  | Response: 409/404/422                   |
  | Side effects: none or rolled back       |
  +-----------------------------------------+
           |
           v
  Layer 4: Provider Errors (write-consumer)
  +-----------------------------------------+
  | Google API 429, 500, 403                |
  | Action: Retry with backoff (queue)      |
  | After max retries: mirror state = ERROR |
  | Surface via sync status endpoint        |
  +-----------------------------------------+
           |
           v
  Layer 5: Infrastructure (all workers)
  +-----------------------------------------+
  | DO unavailable, queue full, D1 down     |
  | Action: 500 + INTERNAL_ERROR            |
  | Retry at transport level                |
  +-----------------------------------------+
```

## Retry Strategy for Queue Consumers

| Error Type | Strategy | Max Retries | Backoff |
|-----------|----------|-------------|---------|
| Google 429 (quota) | Retry with exponential backoff | 5 | 1s, 2s, 4s, 8s, 16s |
| Google 500/503 | Retry with backoff | 3 | 2s, 4s, 8s |
| Google 401 (token expired) | Refresh token, retry once | 1 | Immediate |
| Google 410 (sync token gone) | Enqueue SYNC_FULL, discard current | 0 | N/A |
| Google 403 (insufficient scope) | Mark account error, do not retry | 0 | N/A |
| DO unavailable | Queue auto-retries | 3 | Queue default backoff |

## Mirror Error States

When a mirror write fails after all retries, the mirror enters `ERROR` state:

```json
{
  "canonical_event_id": "evt_01H...",
  "target_account_id": "acc_02H...",
  "state": "ERROR",
  "error_message": "Google API 403: insufficientPermissions",
  "last_write_ts": "2026-02-13T10:00:00Z"
}
```

Error mirrors are:
1. Visible in `GET /v1/events/:id` (mirror status shows ERROR)
2. Counted in `GET /v1/sync/status` (error_mirrors field)
3. Retried during daily drift reconciliation
4. Surfaced in the error recovery UI (Phase 2)
