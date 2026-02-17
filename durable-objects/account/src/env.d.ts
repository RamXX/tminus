/**
 * Worker environment bindings for AccountDO.
 *
 * MASTER_KEY: Hex-encoded 32-byte AES-256 key used as the root of
 * the envelope encryption hierarchy (NFR-9). Stored as a Cloudflare
 * Secret binding.
 *
 * OAuth client credentials are required for token refresh requests.
 * Both Google and Microsoft require client_id and client_secret
 * for web application type OAuth clients.
 */
interface Env {
  /** Hex-encoded 256-bit master key for token envelope encryption. */
  MASTER_KEY: string;
  /** Google OAuth2 client ID for token refresh requests. */
  GOOGLE_CLIENT_ID: string;
  /** Google OAuth2 client secret for token refresh requests. */
  GOOGLE_CLIENT_SECRET: string;
  /** Microsoft Entra ID client ID for token refresh requests. */
  MS_CLIENT_ID: string;
  /** Microsoft Entra ID client secret for token refresh requests. */
  MS_CLIENT_SECRET: string;
}
