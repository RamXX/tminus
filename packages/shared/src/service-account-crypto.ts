/**
 * Service account credential encryption using AES-256-GCM.
 *
 * Follows the same envelope encryption pattern as OAuth token encryption
 * in durable-objects/account/src/crypto.ts (per AD-2):
 *   Master Key -> Per-credential DEK -> Encrypted service account JSON
 *
 * The service account private key is the most sensitive material.
 * It MUST be encrypted at rest in all storage (D1, KV, DO).
 */

import type { ServiceAccountKey } from "./jwt-assertion";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Encrypted envelope for a service account key.
 * Same structure as the OAuth token envelope for consistency.
 */
export interface EncryptedServiceAccountEnvelope {
  /** Base64 IV used to encrypt the service account JSON with the DEK. */
  readonly iv: string;
  /** Base64 ciphertext of the service account JSON, encrypted with DEK. */
  readonly ciphertext: string;
  /** Base64 DEK encrypted with the master key. */
  readonly encryptedDek: string;
  /** Base64 IV used to encrypt the DEK with the master key. */
  readonly dekIv: string;
}

// ---------------------------------------------------------------------------
// Helpers (identical to durable-objects/account/src/crypto.ts)
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
 * Import the master key from a hex-encoded string.
 * Must be exactly 32 bytes (64 hex characters) for AES-256.
 */
export async function importMasterKeyForServiceAccount(
  masterKeyHex: string,
): Promise<CryptoKey> {
  const keyBytes = hexToBytes(masterKeyHex);
  if (keyBytes.length !== 32) {
    throw new Error(
      `Master key must be 32 bytes (64 hex chars), got ${keyBytes.length} bytes`,
    );
  }
  return importKey(keyBytes);
}

/**
 * Encrypt a service account key using envelope encryption (AES-256-GCM).
 *
 * 1. Generate a random 256-bit DEK
 * 2. Encrypt the service account JSON with the DEK
 * 3. Encrypt the DEK with the master key
 * 4. Return the envelope
 */
export async function encryptServiceAccountKey(
  masterKey: CryptoKey,
  serviceAccountKey: ServiceAccountKey,
): Promise<EncryptedServiceAccountEnvelope> {
  // Generate random DEK
  const dekBytes = crypto.getRandomValues(new Uint8Array(32));
  const dek = await importKey(dekBytes);

  // Encrypt the service account JSON with the DEK
  const tokenIv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(serviceAccountKey));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: tokenIv },
      dek,
      plaintext,
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
    ciphertext: toBase64(ciphertext),
    encryptedDek: toBase64(encryptedDek),
    dekIv: toBase64(dekIv),
  };
}

/**
 * Decrypt a service account key from an encrypted envelope.
 *
 * 1. Decrypt the DEK using the master key
 * 2. Decrypt the service account ciphertext using the DEK
 * 3. Parse and return the service account key
 */
export async function decryptServiceAccountKey(
  masterKey: CryptoKey,
  envelope: EncryptedServiceAccountEnvelope,
): Promise<ServiceAccountKey> {
  // Decrypt the DEK
  const dekBytes = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(envelope.dekIv) },
      masterKey,
      fromBase64(envelope.encryptedDek),
    ),
  );
  const dek = await importKey(dekBytes);

  // Decrypt the service account payload
  const plaintext = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(envelope.iv) },
      dek,
      fromBase64(envelope.ciphertext),
    ),
  );

  return JSON.parse(new TextDecoder().decode(plaintext)) as ServiceAccountKey;
}
