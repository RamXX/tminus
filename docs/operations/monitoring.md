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
