/**
 * Worker environment bindings for the webhook worker.
 *
 * DB: D1 registry database containing the accounts table.
 * SYNC_QUEUE: Queue producer for sync-queue (SYNC_INCREMENTAL messages).
 */
interface Env {
  DB: D1Database;
  SYNC_QUEUE: Queue;
}
