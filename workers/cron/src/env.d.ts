/**
 * Worker environment bindings for the cron worker.
 *
 * DB: D1 registry database containing the accounts table.
 * ACCOUNT: Durable Object namespace for AccountDO (per-account token/channel ops).
 * RECONCILE_QUEUE: Queue producer for reconcile-queue (RECONCILE_ACCOUNT messages).
 * DELETION_WORKFLOW: Workflow binding for triggering cascading user deletion.
 */
interface Env {
  DB: D1Database;
  ACCOUNT: DurableObjectNamespace;
  RECONCILE_QUEUE: Queue;
  DELETION_WORKFLOW?: {
    create(params: { id: string; params: unknown }): Promise<{ id: string }>;
  };
}
