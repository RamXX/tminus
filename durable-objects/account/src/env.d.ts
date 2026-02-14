/**
 * Worker environment bindings for AccountDO.
 *
 * MASTER_KEY: Hex-encoded 32-byte AES-256 key used as the root of
 * the envelope encryption hierarchy (NFR-9). Stored as a Cloudflare
 * Secret binding.
 */
interface Env {
  /** Hex-encoded 256-bit master key for token envelope encryption. */
  MASTER_KEY: string;
}
