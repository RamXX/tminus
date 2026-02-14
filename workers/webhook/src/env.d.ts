/**
 * Worker environment bindings for the webhook worker.
 *
 * DB: D1 registry database containing the accounts table and ms_subscriptions table.
 * SYNC_QUEUE: Queue producer for sync-queue (SYNC_INCREMENTAL messages).
 * MS_WEBHOOK_CLIENT_STATE: Shared secret for validating Microsoft change notifications.
 */
interface Env {
  DB: D1Database;
  SYNC_QUEUE: Queue;
  MS_WEBHOOK_CLIENT_STATE: string;
}
