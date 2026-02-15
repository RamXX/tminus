/**
 * Unit tests for service account credential encryption.
 *
 * Tests:
 * - Round-trip encrypt/decrypt preserves the service account key
 * - Encrypted data is NOT plaintext (AD-2 verification)
 * - Master key import validates key length
 * - Different encryptions produce different ciphertexts (random DEK/IV)
 */

import { describe, it, expect } from "vitest";
import {
  importMasterKeyForServiceAccount,
  encryptServiceAccountKey,
  decryptServiceAccountKey,
} from "./service-account-crypto";
import type { ServiceAccountKey } from "./jwt-assertion";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

/** 64 hex chars = 32 bytes = AES-256 key. Test-only, never use in production. */
const TEST_MASTER_KEY_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const TEST_SERVICE_ACCOUNT_KEY: ServiceAccountKey = {
  type: "service_account",
  project_id: "test-project-123",
  private_key_id: "key-id-abc123",
  private_key: "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQ...\n-----END PRIVATE KEY-----",
  client_email: "test-sa@test-project-123.iam.gserviceaccount.com",
  client_id: "123456789012345678901",
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
};

// ---------------------------------------------------------------------------
// importMasterKeyForServiceAccount
// ---------------------------------------------------------------------------

describe("importMasterKeyForServiceAccount", () => {
  it("imports a valid 32-byte hex key", async () => {
    const key = await importMasterKeyForServiceAccount(TEST_MASTER_KEY_HEX);
    expect(key).toBeDefined();
    expect(key.type).toBe("secret");
  });

  it("rejects a key that is too short", async () => {
    await expect(
      importMasterKeyForServiceAccount("0123456789abcdef"),
    ).rejects.toThrow("Master key must be 32 bytes");
  });

  it("rejects a key that is too long", async () => {
    await expect(
      importMasterKeyForServiceAccount(TEST_MASTER_KEY_HEX + "00"),
    ).rejects.toThrow("Master key must be 32 bytes");
  });

  it("rejects invalid hex characters", async () => {
    const invalidHex = "zzzz456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    await expect(
      importMasterKeyForServiceAccount(invalidHex),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Round-trip encrypt/decrypt
// ---------------------------------------------------------------------------

describe("encryptServiceAccountKey / decryptServiceAccountKey", () => {
  it("round-trip preserves the service account key", async () => {
    const masterKey = await importMasterKeyForServiceAccount(TEST_MASTER_KEY_HEX);

    const envelope = await encryptServiceAccountKey(masterKey, TEST_SERVICE_ACCOUNT_KEY);
    const decrypted = await decryptServiceAccountKey(masterKey, envelope);

    expect(decrypted).toEqual(TEST_SERVICE_ACCOUNT_KEY);
  });

  it("encrypted ciphertext does NOT contain plaintext fields (AD-2 proof)", async () => {
    const masterKey = await importMasterKeyForServiceAccount(TEST_MASTER_KEY_HEX);

    const envelope = await encryptServiceAccountKey(masterKey, TEST_SERVICE_ACCOUNT_KEY);

    // The ciphertext should NOT contain any recognizable plaintext
    expect(envelope.ciphertext).not.toContain("service_account");
    expect(envelope.ciphertext).not.toContain("test-project-123");
    expect(envelope.ciphertext).not.toContain("PRIVATE KEY");
    expect(envelope.ciphertext).not.toContain("client_email");
  });

  it("produces all required envelope fields", async () => {
    const masterKey = await importMasterKeyForServiceAccount(TEST_MASTER_KEY_HEX);

    const envelope = await encryptServiceAccountKey(masterKey, TEST_SERVICE_ACCOUNT_KEY);

    expect(envelope.iv).toBeDefined();
    expect(typeof envelope.iv).toBe("string");
    expect(envelope.iv.length).toBeGreaterThan(0);

    expect(envelope.ciphertext).toBeDefined();
    expect(typeof envelope.ciphertext).toBe("string");
    expect(envelope.ciphertext.length).toBeGreaterThan(0);

    expect(envelope.encryptedDek).toBeDefined();
    expect(typeof envelope.encryptedDek).toBe("string");
    expect(envelope.encryptedDek.length).toBeGreaterThan(0);

    expect(envelope.dekIv).toBeDefined();
    expect(typeof envelope.dekIv).toBe("string");
    expect(envelope.dekIv.length).toBeGreaterThan(0);
  });

  it("two encryptions of the same key produce different ciphertexts", async () => {
    const masterKey = await importMasterKeyForServiceAccount(TEST_MASTER_KEY_HEX);

    const envelope1 = await encryptServiceAccountKey(masterKey, TEST_SERVICE_ACCOUNT_KEY);
    const envelope2 = await encryptServiceAccountKey(masterKey, TEST_SERVICE_ACCOUNT_KEY);

    // Different random DEK + IV means different ciphertext
    expect(envelope1.ciphertext).not.toBe(envelope2.ciphertext);
    expect(envelope1.iv).not.toBe(envelope2.iv);
    expect(envelope1.encryptedDek).not.toBe(envelope2.encryptedDek);
  });

  it("decryption fails with wrong master key", async () => {
    const masterKey = await importMasterKeyForServiceAccount(TEST_MASTER_KEY_HEX);
    const wrongKey = await importMasterKeyForServiceAccount(
      "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
    );

    const envelope = await encryptServiceAccountKey(masterKey, TEST_SERVICE_ACCOUNT_KEY);

    await expect(
      decryptServiceAccountKey(wrongKey, envelope),
    ).rejects.toThrow();
  });
});
