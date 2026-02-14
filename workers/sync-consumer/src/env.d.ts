/**
 * Worker environment bindings for sync-consumer.
 *
 * Bindings match wrangler.toml:
 * - USER_GRAPH: UserGraphDO namespace (hosted on tminus-api)
 * - ACCOUNT: AccountDO namespace (hosted on tminus-api)
 * - DB: D1 registry database (for account -> user_id lookup)
 * - WRITE_QUEUE: Queue producer for mirror writes (passed through to UserGraphDO)
 * - SYNC_QUEUE: Queue producer for re-enqueuing SYNC_FULL on 410
 */
interface Env {
  USER_GRAPH: DurableObjectNamespace;
  ACCOUNT: DurableObjectNamespace;
  DB: D1Database;
  WRITE_QUEUE: Queue;
  SYNC_QUEUE: Queue;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  MASTER_KEY: string;
}
