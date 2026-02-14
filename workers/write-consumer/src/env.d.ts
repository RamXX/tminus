/**
 * Worker environment bindings for the write-consumer.
 *
 * Bindings match wrangler.toml:
 * - ACCOUNT: AccountDO durable object namespace (for getAccessToken)
 * - USER_GRAPH: UserGraphDO durable object namespace (for mirror state)
 * - DB: D1 registry database
 */
interface Env {
  ACCOUNT: DurableObjectNamespace;
  USER_GRAPH: DurableObjectNamespace;
  DB: D1Database;
}
