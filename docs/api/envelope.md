# Response Envelope

All API responses use a consistent envelope format.

## Success Envelope

```json
{
  "ok": true,
  "data": { ... },
  "meta": {
    "request_id": "req_01HXYZ...",
    "timestamp": "2026-02-13T10:00:00Z"
  }
}
```

## Error Envelope

```json
{
  "ok": false,
  "error": {
    "code": "ACCOUNT_SYNC_STALE",
    "message": "Account acc_01H... has not synced successfully in 26 hours.",
    "detail": {
      "account_id": "acc_01H...",
      "last_success_ts": "2026-02-12T08:14:00Z"
    }
  },
  "meta": {
    "request_id": "req_01HXYZ...",
    "timestamp": "2026-02-13T10:14:00Z"
  }
}
```

## Why Envelope All Responses?

The `{ok, data, error, meta}` envelope means:

- Clients check `ok` before processing (no ambiguous 2xx-with-error patterns)
- `meta.request_id` enables support conversations ("my request_id was req_01H...")
- Error structure is always the same, regardless of HTTP status code
- Adding fields to `meta` (rate limit info, deprecation warnings) is backward-compatible

## Pagination

Cursor-based pagination. Responses include `meta.next_cursor` when more results exist.
Clients pass `?cursor=<value>` on subsequent requests.

Cursor-based pagination is preferred over offset-based because offset pagination
breaks when data changes between pages (events created or deleted during pagination).
The cursor is an opaque token encoding the last-seen ULID.
