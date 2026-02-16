/**
 * State parameter encryption for OAuth2 CSRF protection.
 *
 * Instead of storing state in KV or cookies, we encrypt the entire
 * OAuth context (code_verifier, user_id, redirect_uri) into the state
 * parameter itself using AES-256-GCM with JWT_SECRET as the key.
 *
 * On callback, we decrypt the state to recover all context -- stateless
 * and tamper-proof.
 *
 * Format: base64url(iv + ciphertext + tag)
 * The AES-GCM output includes the 16-byte auth tag appended to ciphertext.
 */

/** Payload encrypted into the state parameter. */
export interface StatePayload {
  /** PKCE code_verifier for token exchange. */
  readonly code_verifier: string;
  /** User linking this account. */
  readonly user_id: string;
  /** Where to redirect after completion. */
  readonly redirect_uri: string;
  /** Unix timestamp (seconds) when this state expires. */
  readonly exp: number;
}

/** State TTL: 5 minutes. */
const STATE_TTL_SECONDS = 5 * 60;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error("Invalid hex string: odd length");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    const byte = parseInt(hex.slice(i, i + 2), 16);
    if (isNaN(byte)) {
      throw new Error(`Invalid hex character at position ${i}`);
    }
    bytes[i / 2] = byte;
  }
  return bytes;
}

function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(str: string): Uint8Array {
  // Restore standard base64 padding and chars
  let b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4 !== 0) {
    b64 += "=";
  }
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Detect whether a string is a valid hex string of given length.
 */
function isHexString(str: string, expectedLength: number): boolean {
  return str.length === expectedLength && /^[0-9a-fA-F]+$/.test(str);
}

/**
 * Import a secret as an AES-256-GCM key.
 *
 * Accepts two formats:
 * 1. A 64-character hex string (32 bytes) -- used directly (backward compatible
 *    with existing test fixtures).
 * 2. Any other string (e.g., base64-encoded) -- hashed via SHA-256 to derive
 *    a deterministic 32-byte key. This allows production JWT_SECRET values
 *    that are not hex-encoded to work correctly.
 */
async function importStateKey(secret: string): Promise<CryptoKey> {
  let keyBytes: Uint8Array;

  if (isHexString(secret, 64)) {
    // Legacy path: interpret as 32 raw hex bytes (backward compatible with tests)
    keyBytes = hexToBytes(secret);
  } else {
    // Derive a 32-byte key via SHA-256 of the raw secret string.
    // This handles base64-encoded secrets, arbitrary strings, etc.
    const encoded = new TextEncoder().encode(secret);
    keyBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoded));
  }

  return crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Encrypt OAuth context into a state parameter string.
 *
 * @param secret - Symmetric key (JWT_SECRET). Accepts 64-char hex or any string
 *                 (non-hex values are hashed via SHA-256 to derive a 32-byte key).
 * @param codeVerifier - PKCE code_verifier
 * @param userId - The user linking an account
 * @param redirectUri - Post-completion redirect URI
 * @returns URL-safe encrypted state string
 */
export async function encryptState(
  secret: string,
  codeVerifier: string,
  userId: string,
  redirectUri: string,
): Promise<string> {
  const key = await importStateKey(secret);

  const payload: StatePayload = {
    code_verifier: codeVerifier,
    user_id: userId,
    redirect_uri: redirectUri,
    exp: Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS,
  };

  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const iv = crypto.getRandomValues(new Uint8Array(12)); // 96-bit IV for GCM

  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext),
  );

  // Concatenate: iv (12 bytes) + ciphertext+tag
  const combined = new Uint8Array(iv.length + ciphertext.length);
  combined.set(iv, 0);
  combined.set(ciphertext, iv.length);

  return base64urlEncode(combined);
}

/**
 * Decrypt and validate a state parameter string.
 *
 * @param secret - Symmetric key (JWT_SECRET). Accepts 64-char hex or any string
 *                 (non-hex values are hashed via SHA-256 to derive a 32-byte key).
 * @param stateString - The encrypted state parameter from the callback
 * @returns Decrypted payload, or null if decryption fails or state is expired
 */
export async function decryptState(
  secret: string,
  stateString: string,
): Promise<StatePayload | null> {
  try {
    const key = await importStateKey(secret);
    const combined = base64urlDecode(stateString);

    if (combined.length < 13) {
      // Minimum: 12 bytes IV + 1 byte ciphertext (unrealistic but safe guard)
      return null;
    }

    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);

    const plaintext = new Uint8Array(
      await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext),
    );

    const payload: StatePayload = JSON.parse(
      new TextDecoder().decode(plaintext),
    );

    // Check expiry
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp < now) {
      return null;
    }

    return payload;
  } catch {
    // Decryption failure, tampered state, or malformed input
    return null;
  }
}
