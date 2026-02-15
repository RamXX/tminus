/**
 * Worker environment bindings for tminus-api.
 *
 * These match the bindings defined in wrangler.toml:
 * - DB: D1 database (tminus-registry)
 * - USER_GRAPH: DurableObject namespace for UserGraphDO
 * - ACCOUNT: DurableObject namespace for AccountDO
 * - SYNC_QUEUE: Queue producer for sync messages
 * - WRITE_QUEUE: Queue producer for write messages
 * - SESSIONS: KV namespace for refresh token sessions
 * - RATE_LIMITS: KV namespace for rate limit counters
 * - JWT_SECRET: Secret for API auth JWT signing
 * - STRIPE_SECRET_KEY: Stripe API secret key for billing operations
 * - STRIPE_WEBHOOK_SECRET: Stripe webhook signing secret for HMAC verification
 */
interface Env {
  DB: D1Database;
  USER_GRAPH: DurableObjectNamespace;
  ACCOUNT: DurableObjectNamespace;
  SYNC_QUEUE: Queue;
  WRITE_QUEUE: Queue;
  SESSIONS: KVNamespace;
  RATE_LIMITS: KVNamespace;
  JWT_SECRET: string;
  /** MASTER_KEY secret for signing deletion certificates (HMAC-SHA-256). */
  MASTER_KEY?: string;
  /** Deployment environment: "production", "staging", or "development" (default). */
  ENVIRONMENT?: string;
  /** Stripe API secret key (sk_test_... or sk_live_...). */
  STRIPE_SECRET_KEY?: string;
  /** Stripe webhook endpoint signing secret (whsec_...). */
  STRIPE_WEBHOOK_SECRET?: string;
}
