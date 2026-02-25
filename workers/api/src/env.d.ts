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
 * - AI: Workers AI binding for LLM inference (excuse generator, etc.)
 */
interface Env {
  DB: D1Database;
  USER_GRAPH: DurableObjectNamespace;
  ACCOUNT: DurableObjectNamespace;
  SYNC_QUEUE: Queue;
  WRITE_QUEUE: Queue;
  /** Priority write queue (DELETE_MANAGED_MIRROR fast path). Falls back to WRITE_QUEUE if absent. */
  WRITE_PRIORITY_QUEUE?: Queue;
  SESSIONS: KVNamespace;
  RATE_LIMITS: KVNamespace;
  JWT_SECRET: string;
  /** MASTER_KEY secret for signing deletion certificates (HMAC-SHA-256). */
  MASTER_KEY?: string;
  /** Google OAuth2 client ID (used by AccountDO for token refresh). */
  GOOGLE_CLIENT_ID?: string;
  /** Google OAuth2 client secret (used by AccountDO for token refresh). */
  GOOGLE_CLIENT_SECRET?: string;
  /** Microsoft Entra ID client ID (used by AccountDO for token refresh). */
  MS_CLIENT_ID?: string;
  /** Microsoft Entra ID client secret (used by AccountDO for token refresh). */
  MS_CLIENT_SECRET?: string;
  /** Deployment environment: "production", "staging", or "development" (default). */
  ENVIRONMENT?: string;
  /** Stripe API secret key (sk_test_... or sk_live_...). */
  STRIPE_SECRET_KEY?: string;
  /** Stripe webhook endpoint signing secret (whsec_...). */
  STRIPE_WEBHOOK_SECRET?: string;
  /** R2 bucket for storing commitment proof exports (PDF/CSV). */
  PROOF_BUCKET?: R2Bucket;
  /** Workers AI binding for LLM inference (excuse generator, tone adjustment). */
  AI?: Ai;
  /** Admin key for authenticating internal/admin API endpoints. */
  ADMIN_KEY?: string;
  /** Webhook receiver URL for Google Calendar push notifications (used by channel renewal). */
  WEBHOOK_URL?: string;
}
