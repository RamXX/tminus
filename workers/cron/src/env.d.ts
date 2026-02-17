/**
 * Worker environment bindings for the cron worker.
 *
 * DB: D1 registry database containing the accounts table.
 * ACCOUNT: Durable Object namespace for AccountDO (per-account token/channel ops).
 * RECONCILE_QUEUE: Queue producer for reconcile-queue (RECONCILE_ACCOUNT messages).
 * SYNC_QUEUE: Queue producer for sync-queue (SYNC_INCREMENTAL messages for liveness fallback).
 * WEBHOOK_URL: Webhook receiver URL for Google Calendar push notifications.
 * DELETION_WORKFLOW: Workflow binding for triggering cascading user deletion.
 */
interface Env {
  DB: D1Database;
  ACCOUNT: DurableObjectNamespace;
  USER_GRAPH: DurableObjectNamespace;
  RECONCILE_QUEUE: Queue;
  SYNC_QUEUE: Queue;
  WRITE_QUEUE: Queue;
  PUSH_QUEUE: Queue;
  WEBHOOK_URL: string;
  DELETION_WORKFLOW?: {
    create(params: { id: string; params: unknown }): Promise<{ id: string }>;
  };
}
