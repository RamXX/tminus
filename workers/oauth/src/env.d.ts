/**
 * Worker environment bindings for tminus-oauth.
 *
 * These match the bindings declared in wrangler.toml.
 */
interface Env {
  /** D1 registry database for cross-user lookups. */
  DB: D1Database;

  /** Durable Object namespace for UserGraphDO (hosted on tminus-api). */
  USER_GRAPH: DurableObjectNamespace;

  /** Durable Object namespace for AccountDO (hosted on tminus-api). */
  ACCOUNT: DurableObjectNamespace;

  /** Workflow binding for OnboardingWorkflow. */
  ONBOARDING_WORKFLOW: {
    create(options: { id?: string; params: Record<string, unknown> }): Promise<{ id: string }>;
  };

  /** Google OAuth2 client ID. */
  GOOGLE_CLIENT_ID: string;

  /** Google OAuth2 client secret. */
  GOOGLE_CLIENT_SECRET: string;

  /** Microsoft Entra ID (Azure AD) client ID. */
  MS_CLIENT_ID: string;

  /** Microsoft Entra ID (Azure AD) client secret. */
  MS_CLIENT_SECRET: string;

  /** Symmetric key for encrypting state parameter (hex-encoded 32 bytes). */
  JWT_SECRET: string;

  /** Queue for write operations (used by OnboardingWorkflow). */
  WRITE_QUEUE: Queue;

  /** Google Calendar webhook URL for watch channel registration. */
  WEBHOOK_URL: string;

  /** Deployment environment: "production", "staging", or "development" (default). */
  ENVIRONMENT?: string;
}
