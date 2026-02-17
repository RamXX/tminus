# Queue Message Contracts

All message types are defined in `packages/shared/src/types.ts`. All queue
messages share a common envelope:

```typescript
type QueueMessage = {
  type: string;            // Discriminator
  trace_id: string;        // For distributed tracing (ULID)
  enqueued_at: string;     // ISO 8601
  attempt: number;         // Retry count (0-based)
};
```

---

## sync-queue Messages

### SYNC_INCREMENTAL

Triggered by webhook-worker when Google push notification arrives.
Consumer: sync-consumer.

```typescript
type SyncIncrementalMessage = QueueMessage & {
  type: 'SYNC_INCREMENTAL';
  account_id: string;      // acc_01H... (ULID of the external account)
  channel_id: string;      // UUID from Google
  resource_id: string;     // Google resource identifier
};
```

### SYNC_FULL

Triggered by cron-worker (reconciliation) or sync-consumer (on 410 Gone).
Consumer: sync-consumer.

```typescript
type SyncFullMessage = QueueMessage & {
  type: 'SYNC_FULL';
  account_id: string;
  reason: 'onboarding' | 'reconcile' | 'token_410';
};
```

Size budget: These are small (~200 bytes). Well within 128 KB limit.

---

## write-queue Messages

### UPSERT_MIRROR

Create or update a mirror event in the target account.
Consumer: write-consumer.

```typescript
type UpsertMirrorMessage = QueueMessage & {
  type: 'UPSERT_MIRROR';
  canonical_event_id: string;
  target_account_id: string;
  target_calendar_id: string;
  projected_payload: ProjectedEvent;
  idempotency_key: string;  // hash(canonical_event_id + target_account + projected_hash)
};
```

### DELETE_MIRROR

Delete a mirror event from the target account.
Consumer: write-consumer.

```typescript
type DeleteMirrorMessage = QueueMessage & {
  type: 'DELETE_MIRROR';
  canonical_event_id: string;
  target_account_id: string;
  provider_event_id: string;  // The Google event ID to delete
  idempotency_key: string;
};
```

### ProjectedEvent Shape

The projected payload after policy compilation. Contains only the fields
appropriate for the detail_level.

```typescript
type ProjectedEvent = {
  summary: string;          // "Busy" for BUSY level, real title for TITLE/FULL
  description?: string;     // Only for FULL level
  location?: string;        // Only for FULL level
  start: EventDateTime;
  end: EventDateTime;
  transparency: 'opaque' | 'transparent';
  visibility: 'default' | 'private';
  extendedProperties: {
    private: {
      tminus: 'true';
      managed: 'true';
      canonical_event_id: string;
      origin_account_id: string;
    };
  };
};

type EventDateTime = {
  dateTime?: string;        // ISO 8601 for timed events
  date?: string;            // YYYY-MM-DD for all-day events
  timeZone?: string;
};
```

Size budget: A BUSY projection is ~100 bytes. A FULL projection (title +
description + location) could be ~2-4 KB. Well within 128 KB.

---

## reconcile-queue Messages

### RECONCILE_ACCOUNT

Dispatched by cron-worker for daily drift reconciliation.
Consumer: ReconcileWorkflow.

```typescript
type ReconcileAccountMessage = {
  type: 'RECONCILE_ACCOUNT';
  account_id: string;
  user_id: string;
  triggered_at: string;       // ISO 8601
};
```

---

## Message Size Budget

All messages must stay under the 128 KB queue message limit. The projected
payload is the largest component. For BUSY-level projections, messages are
typically under 1 KB. For FULL-level projections with long descriptions,
messages could approach 10-20 KB. No message should ever approach the limit
under normal operation.

If a message would exceed the limit (e.g., extremely long event description),
truncate the description and log a warning. The canonical store retains the
full data.
