/**
 * API key generation, hashing, and validation utilities.
 *
 * Key format: tmk_live_<prefix><random>
 *   - "tmk_live_" is the fixed prefix identifying T-Minus API keys
 *   - <prefix> is 8 hex characters used for DB lookup (stored in plaintext)
 *   - <random> is 32 hex characters of cryptographic randomness
 *
 * Total raw key length: 9 (tmk_live_) + 8 (prefix) + 32 (random) = 49 chars
 *
 * Storage: Only the SHA-256 hash of the full key is stored. The prefix
 * is stored separately for fast DB lookups without comparing hashes.
 *
 * Uses Web Crypto API exclusively (no bcrypt) for Cloudflare Workers compatibility.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Fixed prefix for all T-Minus API keys. */
export const API_KEY_PREFIX = "tmk_live_";

/** Length of the lookup prefix (hex chars after tmk_live_). */
export const LOOKUP_PREFIX_LENGTH = 8;

/** Length of the random portion (hex chars). */
export const RANDOM_PORTION_LENGTH = 32;

// ---------------------------------------------------------------------------
// Key generation
// ---------------------------------------------------------------------------

/**
 * Generate a new API key with cryptographically secure randomness.
 *
 * @returns An object with the raw key (show once), the lookup prefix,
 *          and the SHA-256 hash for storage.
 */
export async function generateApiKey(): Promise<{
  /** Full raw API key -- show to user exactly once, never store. */
  rawKey: string;
  /** 8-char hex prefix for DB lookups. */
  prefix: string;
  /** SHA-256 hex hash of the full raw key for storage. */
  keyHash: string;
}> {
  // Generate 20 random bytes -> 40 hex chars (8 prefix + 32 random)
  const randomBytes = crypto.getRandomValues(new Uint8Array(20));
  const hex = bytesToHex(randomBytes);

  const prefix = hex.slice(0, LOOKUP_PREFIX_LENGTH);
  const random = hex.slice(LOOKUP_PREFIX_LENGTH);
  const rawKey = `${API_KEY_PREFIX}${prefix}${random}`;

  const keyHash = await hashApiKey(rawKey);

  return { rawKey, prefix, keyHash };
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/**
 * Compute SHA-256 hash of an API key using Web Crypto.
 *
 * @param rawKey - The full raw API key string.
 * @returns Lowercase hex-encoded SHA-256 hash.
 */
export async function hashApiKey(rawKey: string): Promise<string> {
  const encoded = new TextEncoder().encode(rawKey);
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
  return bytesToHex(new Uint8Array(hashBuffer));
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Check whether a token string looks like a T-Minus API key.
 *
 * Does NOT verify the key against the database -- only checks format.
 *
 * @param token - The Bearer token string (without "Bearer " prefix).
 * @returns true if the token matches tmk_live_ format.
 */
export function isApiKeyFormat(token: string): boolean {
  if (!token.startsWith(API_KEY_PREFIX)) return false;

  const remainder = token.slice(API_KEY_PREFIX.length);
  // Must be exactly 40 hex chars (8 prefix + 32 random)
  if (remainder.length !== LOOKUP_PREFIX_LENGTH + RANDOM_PORTION_LENGTH) {
    return false;
  }

  // All chars must be valid hex
  return /^[0-9a-f]+$/.test(remainder);
}

/**
 * Extract the lookup prefix from a raw API key.
 *
 * @param rawKey - Full raw API key string.
 * @returns The 8-char hex prefix, or null if format is invalid.
 */
export function extractPrefix(rawKey: string): string | null {
  if (!isApiKeyFormat(rawKey)) return null;
  return rawKey.slice(API_KEY_PREFIX.length, API_KEY_PREFIX.length + LOOKUP_PREFIX_LENGTH);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Convert a Uint8Array to a lowercase hex string. */
function bytesToHex(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (const byte of bytes) {
    parts.push(byte.toString(16).padStart(2, "0"));
  }
  return parts.join("");
}
