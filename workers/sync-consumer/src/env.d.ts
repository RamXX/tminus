/**
 * Worker environment bindings for sync-consumer.
 *
 * Bindings match wrangler.toml:
 * - USER_GRAPH: UserGraphDO namespace (hosted on tminus-api via script_name)
 * - ACCOUNT: AccountDO namespace (hosted on tminus-api via script_name)
 * - DB: D1 registry database (for account -> user_id and provider lookup)
 * - WRITE_QUEUE: Queue producer for mirror writes (passed through to UserGraphDO)
 * - SYNC_QUEUE: Queue producer for re-enqueuing SYNC_FULL on 410
 *
 * NOTE: This worker does NOT need direct access to GOOGLE_CLIENT_ID,
 * GOOGLE_CLIENT_SECRET, or MASTER_KEY. All credential operations are
 * delegated to AccountDO via DO RPC (getAccessToken, getSyncToken, etc.).
 * AccountDO runs on tminus-api where these secrets are configured.
 * See TM-pd65 for the architectural audit confirming this design.
 */
interface Env {
  USER_GRAPH: DurableObjectNamespace;
  ACCOUNT: DurableObjectNamespace;
  DB: D1Database;
  WRITE_QUEUE: Queue;
  SYNC_QUEUE: Queue;
}
