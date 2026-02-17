/**
 * Envelope encryption for OAuth tokens using AES-256-GCM.
 *
 * Architecture (NFR-9):
 *   Master Key (MASTER_KEY env binding, hex-encoded)
 *     |
 *     v
 *   Per-Account DEK (generated at account creation via crypto.subtle)
 *     |  DEK encrypted with master key, stored in AccountDO SQLite
 *     v
 *   OAuth Tokens (encrypted with DEK using AES-256-GCM)
 *     stored in auth table as encrypted_tokens JSON
 *
 * The encrypted_tokens column stores JSON with the shape:
 *   { iv: string, ciphertext: string, encryptedDek: string, dekIv: string }
 *
 * All binary data is base64-encoded for JSON storage.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Shape stored in the auth table's encrypted_tokens column. */
export interface EncryptedEnvelope {
  /** Base64 IV used to encrypt the plaintext tokens with the DEK. */
  readonly iv: string;
  /** Base64 ciphertext of the token JSON, encrypted with DEK. */
  readonly ciphertext: string;
  /** Base64 DEK encrypted with the master key. */
  readonly encryptedDek: string;
  /** Base64 IV used to encrypt the DEK with the master key. */
  readonly dekIv: string;
}

/** Plaintext token payload that gets encrypted/decrypted. */
export interface TokenPayload {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly expiry: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a hex string to a Uint8Array. */
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

/** Convert a Uint8Array to a base64 string. */
function toBase64(bytes: Uint8Array): string {
  // Works in both Node.js and Cloudflare Workers
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/** Convert a base64 string to a Uint8Array. */
function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Import a raw AES-256-GCM key from bytes. */
async function importKey(keyBytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect whether a string is a valid hex string of given length.
 */
function isHexString(str: string, expectedLength: number): boolean {
  return str.length === expectedLength && /^[0-9a-fA-F]+$/.test(str);
}

/**
 * Import the master key from a secret string.
 *
 * Accepts two formats:
 * 1. A 64-character hex string (32 bytes) -- used directly (backward compatible
 *    with existing test fixtures).
 * 2. Any other string (e.g., base64-encoded) -- hashed via SHA-256 to derive
 *    a deterministic 32-byte key. This allows production MASTER_KEY values
 *    that are not hex-encoded to work correctly.
 */
export async function importMasterKey(
  masterKeyHex: string,
): Promise<CryptoKey> {
  let keyBytes: Uint8Array;

  if (isHexString(masterKeyHex, 64)) {
    // Legacy path: interpret as 32 raw hex bytes (backward compatible with tests)
    keyBytes = hexToBytes(masterKeyHex);
  } else {
    // Derive a 32-byte key via SHA-256 of the raw secret string.
    const encoded = new TextEncoder().encode(masterKeyHex);
    keyBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoded));
  }

  return importKey(keyBytes);
}

/**
 * Encrypt a token payload using envelope encryption.
 *
 * 1. Generate a random 256-bit DEK
 * 2. Encrypt the token JSON with the DEK using AES-256-GCM
 * 3. Encrypt the DEK with the master key using AES-256-GCM
 * 4. Return the envelope containing all encrypted material
 */
export async function encryptTokens(
  masterKey: CryptoKey,
  tokens: TokenPayload,
): Promise<EncryptedEnvelope> {
  // Generate a random DEK (32 bytes = 256 bits)
  const dekBytes = crypto.getRandomValues(new Uint8Array(32));
  const dek = await importKey(dekBytes);

  // Encrypt the token payload with the DEK
  const tokenIv = crypto.getRandomValues(new Uint8Array(12)); // 96-bit IV for GCM
  const tokenPlaintext = new TextEncoder().encode(JSON.stringify(tokens));
  const tokenCiphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: tokenIv },
      dek,
      tokenPlaintext,
    ),
  );

  // Encrypt the DEK with the master key
  const dekIv = crypto.getRandomValues(new Uint8Array(12));
  const encryptedDek = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: dekIv },
      masterKey,
      dekBytes,
    ),
  );

  return {
    iv: toBase64(tokenIv),
    ciphertext: toBase64(tokenCiphertext),
    encryptedDek: toBase64(encryptedDek),
    dekIv: toBase64(dekIv),
  };
}

/**
 * Decrypt a token payload from an encrypted envelope.
 *
 * 1. Decrypt the DEK using the master key
 * 2. Decrypt the token ciphertext using the DEK
 * 3. Parse and return the token payload
 */
export async function decryptTokens(
  masterKey: CryptoKey,
  envelope: EncryptedEnvelope,
): Promise<TokenPayload> {
  // Decrypt the DEK
  const dekBytes = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(envelope.dekIv) },
      masterKey,
      fromBase64(envelope.encryptedDek),
    ),
  );
  const dek = await importKey(dekBytes);

  // Decrypt the token payload
  const plaintext = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(envelope.iv) },
      dek,
      fromBase64(envelope.ciphertext),
    ),
  );

  return JSON.parse(new TextDecoder().decode(plaintext)) as TokenPayload;
}

/**
 * Re-encrypt the DEK from an existing envelope with a new master key.
 *
 * This is the core operation for master key rotation:
 * 1. Decrypt the DEK using the old master key
 * 2. Re-encrypt the same DEK using the new master key (new IV)
 * 3. Return a new envelope with updated encryptedDek and dekIv
 *
 * The token ciphertext (iv + ciphertext) remains unchanged because
 * it is encrypted with the DEK, not the master key. Only the DEK's
 * encryption wrapper changes.
 */
export async function reEncryptDek(
  oldMasterKey: CryptoKey,
  newMasterKey: CryptoKey,
  envelope: EncryptedEnvelope,
): Promise<EncryptedEnvelope> {
  // Step 1: Decrypt the DEK with the old master key
  const dekBytes = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(envelope.dekIv) },
      oldMasterKey,
      fromBase64(envelope.encryptedDek),
    ),
  );

  // Step 2: Re-encrypt the DEK with the new master key (fresh IV)
  const newDekIv = crypto.getRandomValues(new Uint8Array(12));
  const newEncryptedDek = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: newDekIv },
      newMasterKey,
      dekBytes,
    ),
  );

  // Step 3: Return envelope with updated DEK encryption, token data unchanged
  return {
    iv: envelope.iv,
    ciphertext: envelope.ciphertext,
    encryptedDek: toBase64(newEncryptedDek),
    dekIv: toBase64(newDekIv),
  };
}

/**
 * Serialize an encrypted envelope to a portable backup format.
 *
 * The backup contains only the encrypted DEK material (encryptedDek + dekIv),
 * NOT the token ciphertext. The DEK remains encrypted with the master key.
 *
 * Used by the DEK backup script to export encrypted DEKs to R2.
 */
export interface DekBackupEntry {
  /** Account identifier. */
  readonly accountId: string;
  /** Base64 DEK encrypted with the master key. */
  readonly encryptedDek: string;
  /** Base64 IV used to encrypt the DEK. */
  readonly dekIv: string;
  /** ISO 8601 timestamp of the backup. */
  readonly backedUpAt: string;
}

/**
 * Extract the encrypted DEK material from an envelope for backup.
 */
export function extractDekForBackup(
  accountId: string,
  envelope: EncryptedEnvelope,
): DekBackupEntry {
  return {
    accountId,
    encryptedDek: envelope.encryptedDek,
    dekIv: envelope.dekIv,
    backedUpAt: new Date().toISOString(),
  };
}

/**
 * Restore an encrypted DEK from a backup entry into an existing envelope.
 *
 * The iv and ciphertext fields remain from the existing envelope;
 * only encryptedDek and dekIv are replaced from the backup.
 */
export function restoreDekFromBackup(
  existingEnvelope: EncryptedEnvelope,
  backup: DekBackupEntry,
): EncryptedEnvelope {
  return {
    iv: existingEnvelope.iv,
    ciphertext: existingEnvelope.ciphertext,
    encryptedDek: backup.encryptedDek,
    dekIv: backup.dekIv,
  };
}
