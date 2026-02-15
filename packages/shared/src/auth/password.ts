/**
 * @tminus/shared -- Password hashing using Web Crypto PBKDF2.
 *
 * Workers runtime does not support bcrypt. We use PBKDF2 with:
 * - Algorithm: SHA-256
 * - Iterations: 100,000
 * - Random salt: 16 bytes (hex-encoded in stored format)
 * - Key length: 32 bytes (256 bits)
 *
 * Stored format: "<hex-salt>:<hex-derived-key>"
 * The salt and derived key are separated by a colon for easy parsing.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Number of PBKDF2 iterations. 100k per OWASP recommendation. */
const PBKDF2_ITERATIONS = 100_000;

/** Salt length in bytes. */
const SALT_LENGTH = 16;

/** Derived key length in bytes. */
const KEY_LENGTH = 32;

/** Hash algorithm for PBKDF2. */
const HASH_ALGORITHM = "SHA-256";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a Uint8Array to a lowercase hex string. */
function toHex(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (const byte of bytes) {
    parts.push(byte.toString(16).padStart(2, "0"));
  }
  return parts.join("");
}

/** Convert a hex string to a Uint8Array. */
function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Derive a key from a password and salt using PBKDF2.
 */
async function deriveKey(
  password: string,
  salt: Uint8Array,
): Promise<ArrayBuffer> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );

  return crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: HASH_ALGORITHM,
    },
    keyMaterial,
    KEY_LENGTH * 8, // bits
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Hash a password using PBKDF2 with a random salt.
 *
 * @param password - The plaintext password to hash.
 * @returns A string in the format "<hex-salt>:<hex-derived-key>".
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const derivedBits = await deriveKey(password, salt);
  const derivedKey = new Uint8Array(derivedBits);

  return `${toHex(salt)}:${toHex(derivedKey)}`;
}

/**
 * Verify a password against a stored hash.
 *
 * @param password - The plaintext password to verify.
 * @param storedHash - The stored hash in "<hex-salt>:<hex-derived-key>" format.
 * @returns True if the password matches, false otherwise.
 */
export async function verifyPassword(
  password: string,
  storedHash: string,
): Promise<boolean> {
  const colonIndex = storedHash.indexOf(":");
  if (colonIndex === -1) return false;

  const saltHex = storedHash.slice(0, colonIndex);
  const expectedKeyHex = storedHash.slice(colonIndex + 1);

  // Validate salt and key lengths
  if (saltHex.length !== SALT_LENGTH * 2) return false;
  if (expectedKeyHex.length !== KEY_LENGTH * 2) return false;

  const salt = fromHex(saltHex);
  const derivedBits = await deriveKey(password, salt);
  const derivedKey = new Uint8Array(derivedBits);
  const actualKeyHex = toHex(derivedKey);

  // Constant-time comparison to prevent timing attacks.
  // We compare hex strings character by character, accumulating differences.
  if (actualKeyHex.length !== expectedKeyHex.length) return false;
  let diff = 0;
  for (let i = 0; i < actualKeyHex.length; i++) {
    diff |= actualKeyHex.charCodeAt(i) ^ expectedKeyHex.charCodeAt(i);
  }
  return diff === 0;
}
