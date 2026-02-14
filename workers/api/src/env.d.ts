/**
 * Worker environment bindings for tminus-api.
 *
 * These match the bindings defined in wrangler.toml:
 * - DB: D1 database (tminus-registry)
 * - USER_GRAPH: DurableObject namespace for UserGraphDO
 * - ACCOUNT: DurableObject namespace for AccountDO
 * - SYNC_QUEUE: Queue producer for sync messages
 * - WRITE_QUEUE: Queue producer for write messages
 * - JWT_SECRET: Secret for API auth JWT signing
 */
interface Env {
  DB: D1Database;
  USER_GRAPH: DurableObjectNamespace;
  ACCOUNT: DurableObjectNamespace;
  SYNC_QUEUE: Queue;
  WRITE_QUEUE: Queue;
  JWT_SECRET: string;
}
