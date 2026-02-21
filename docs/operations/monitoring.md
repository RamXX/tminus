# Monitoring

## Sync Health Model

Sync health is the primary operational concern. The system makes it trivially
easy to answer: "Is everything working?"

### Per-Account Health States

```
  HEALTHY ---------> DEGRADED ---------> UNHEALTHY
     ^                  |                    |
     |                  v                    v
     +--- auto-heal   STALE              ERROR
           (resync)     |                    |
                        v                    v
                     auto-reconcile     requires
                     via cron           manual
                                        intervention
```

| State | Definition | Trigger |
|-------|-----------|---------|
| `healthy` | Last successful sync < 1 hour ago. Channel active. No error mirrors. | Normal operation |
| `degraded` | Last successful sync 1-6 hours ago. Or 1+ mirrors in ERROR state. | Transient Google API errors, quota throttling |
| `stale` | Last successful sync 6-24 hours ago. | Channel stopped delivering, persistent API errors |
| `unhealthy` | Last successful sync > 24 hours ago. | Requires investigation |
| `error` | OAuth tokens revoked, or persistent unrecoverable error. | User revoked access, account suspended |

### Health Computation

Health is computed by the api-worker when `/v1/sync/status` is called:

1. Read `last_success_ts` from AccountDO
2. Read `channel_status` and `channel_expiry_ts` from AccountDO
3. Count mirrors in `ERROR` state from UserGraphDO
4. Apply thresholds above

The `overall` field on the aggregate endpoint is the worst status among all
accounts. This gives operators a single field to monitor.

### Per-Scope Health

Account-level health gives a coarse signal. Per-scope health drills into
individual calendars so operators can pinpoint exactly which scope is
degraded.

#### `ScopedSyncHealth` Shape

Each calendar scope produces a `ScopedSyncHealth` record:

| Field | Type | Meaning |
|-------|------|---------|
| `providerCalendarId` | `string` | The provider-specific calendar identifier (e.g. `user@example.com` for a Google calendar). |
| `lastSyncTs` | `string \| null` | ISO 8601 timestamp of the last sync attempt (success or failure) for this scope. Null if the scope has never been synced. |
| `lastSuccessTs` | `string \| null` | ISO 8601 timestamp of the last *successful* sync for this scope. Null if no sync has succeeded yet. |
| `errorMessage` | `string \| null` | Non-null when the scope is in a failure state. Contains the error detail from the most recent failed sync attempt. |
| `hasCursor` | `boolean` | Whether a sync token (page token / delta cursor) exists for this scope. `false` means the next sync will be a full bootstrap rather than an incremental delta. |

#### `SyncHealthReport` Aggregation

`getSyncHealthReport(accountId, env)` builds a `SyncHealthReport` by:

1. Looking up the account's provider type.
2. Calling AccountDO's `/getSyncHealth` endpoint for account-level health
   (`lastSyncTs`, `lastSuccessTs`, `errorMessage`).
3. Enumerating all calendar scopes via `listCalendarScopes`.
4. For each scope, calling AccountDO's `/getScopedSyncHealth` endpoint to
   populate a `ScopedSyncHealth` entry.

The resulting report shape:

```
SyncHealthReport
  accountId:    AccountId
  provider:     ProviderType
  accountLevel:
    lastSyncTs:    string | null
    lastSuccessTs: string | null
    errorMessage:  string | null
  scopes:       ScopedSyncHealth[]
```

If AccountDO returns a non-OK status (404/405) or throws, the function
treats it as empty data rather than propagating the failure. This keeps the
health endpoint available even when individual DOs are unreachable.

#### `ReconcileReasonCode` Values

Reconciliation can be triggered for different reasons, captured in the
`ReconcileReasonCode` type:

| Code | Meaning |
|------|---------|
| `scheduled` | Periodic reconciliation fired by cron. This is the normal background consistency check. |
| `manual` | An operator or API caller explicitly requested reconciliation for an account or scope. |
| `drift_detected` | The system detected a discrepancy between the canonical store and a mirror, and auto-triggered reconciliation to correct it. |

These codes appear in `ReconcileAccountMessage` payloads on the
reconcile-queue and can be used for filtering in logs and alerting.

#### Alerting Guidance

Scope-level metrics enable more precise alerting:

- **`hasCursor = false` after onboarding completes**: The scope lost its
  sync token and needs a full bootstrap. This can happen after a Google 410
  (sync token invalidated) or if the scope was never fully onboarded. Flag
  for investigation if it persists beyond the next sync cycle.
- **`errorMessage` is non-null**: The scope is in a failure state. The
  error string contains the root cause. Alert and investigate -- persistent
  scope errors often indicate revoked permissions or provider-side issues
  for that specific calendar.
- **`lastSuccessTs` growing stale for a single scope**: If one scope's
  `lastSuccessTs` is hours behind while others are current, that scope has
  a localized problem. Apply the same staleness thresholds as account-level
  health (1h degraded, 6h stale, 24h unhealthy) at the scope level.
- **Reconcile reason `drift_detected`**: If this fires frequently for a
  scope, there may be an external actor modifying mirrors or a bug in delta
  application. Investigate the event journal for that scope.

### Alerting Integration Points

The sync status model is designed for external alerting:

- `GET /v1/sync/status` returns machine-readable health
- Each account includes `last_success_ts` for threshold-based alerts
- Each account includes `error_mirrors` count for anomaly detection
- The event journal can be queried for error patterns

### Viewing Worker Logs

Tail real-time logs from a deployed worker:

```bash
# Tail production logs
npx wrangler tail tminus-api-production

# Tail staging logs
npx wrangler tail tminus-api-staging

# Filter by status (errors only)
npx wrangler tail tminus-api-production --status error
```

### Queue Inspection

Queue consumers (sync-consumer, write-consumer) process messages from Cloudflare Queues. If messages are not being processed:

1. Check the worker is deployed: `npx wrangler deployments list --name tminus-sync-consumer --env production`
2. Check queue consumer configuration in the worker's `wrangler.toml`
3. Tail the consumer logs: `npx wrangler tail tminus-sync-consumer-production`
