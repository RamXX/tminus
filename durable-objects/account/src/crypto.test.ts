/**
 * Unit tests for envelope encryption module.
 *
 * Tests use real Web Crypto API (available in Node.js 22+).
 * No mocks -- these prove encryption/decryption actually works.
 */

import { describe, it, expect } from "vitest";
import {
  importMasterKey,
  encryptTokens,
  decryptTokens,
  reEncryptDek,
  extractDekForBackup,
  restoreDekFromBackup,
} from "./crypto";
import type { EncryptedEnvelope, TokenPayload, DekBackupEntry } from "./crypto";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** A valid 32-byte (64 hex char) master key for testing. */
const TEST_MASTER_KEY_HEX =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

/** A different valid master key for wrong-key tests. */
const WRONG_MASTER_KEY_HEX =
  "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

const TEST_TOKENS: TokenPayload = {
  access_token: "ya29.test-access-token-abcdef",
  refresh_token: "1//test-refresh-token-xyz",
  expiry: "2026-02-15T12:00:00Z",
};

// ---------------------------------------------------------------------------
// importMasterKey tests
// ---------------------------------------------------------------------------

describe("importMasterKey", () => {
  it("imports a valid 64-char hex key", async () => {
    const key = await importMasterKey(TEST_MASTER_KEY_HEX);
    expect(key).toBeDefined();
    // CryptoKey is an opaque type, but we can verify it was created
    expect(key.type).toBe("secret");
    expect(key.algorithm).toMatchObject({ name: "AES-GCM" });
  });

  it("rejects a key shorter than 32 bytes", async () => {
    await expect(importMasterKey("0123456789abcdef")).rejects.toThrow(
      /must be 32 bytes/,
    );
  });

  it("rejects a key longer than 32 bytes", async () => {
    await expect(
      importMasterKey(TEST_MASTER_KEY_HEX + "aabb"),
    ).rejects.toThrow(/must be 32 bytes/);
  });

  it("rejects invalid hex characters", async () => {
    const badHex = "zz" + TEST_MASTER_KEY_HEX.slice(2);
    await expect(importMasterKey(badHex)).rejects.toThrow(
      /Invalid hex character/,
    );
  });

  it("rejects odd-length hex string", async () => {
    await expect(importMasterKey("abc")).rejects.toThrow(/odd length/);
  });
});

// ---------------------------------------------------------------------------
// encryptTokens + decryptTokens round-trip tests
// ---------------------------------------------------------------------------

describe("encryptTokens / decryptTokens", () => {
  it("round-trips tokens through encrypt then decrypt", async () => {
    const masterKey = await importMasterKey(TEST_MASTER_KEY_HEX);
    const envelope = await encryptTokens(masterKey, TEST_TOKENS);
    const decrypted = await decryptTokens(masterKey, envelope);

    expect(decrypted).toEqual(TEST_TOKENS);
  });

  it("produces a valid envelope structure", async () => {
    const masterKey = await importMasterKey(TEST_MASTER_KEY_HEX);
    const envelope = await encryptTokens(masterKey, TEST_TOKENS);

    // All fields are non-empty base64 strings
    expect(typeof envelope.iv).toBe("string");
    expect(typeof envelope.ciphertext).toBe("string");
    expect(typeof envelope.encryptedDek).toBe("string");
    expect(typeof envelope.dekIv).toBe("string");

    expect(envelope.iv.length).toBeGreaterThan(0);
    expect(envelope.ciphertext.length).toBeGreaterThan(0);
    expect(envelope.encryptedDek.length).toBeGreaterThan(0);
    expect(envelope.dekIv.length).toBeGreaterThan(0);
  });

  it("ciphertext does NOT contain plaintext token values", async () => {
    const masterKey = await importMasterKey(TEST_MASTER_KEY_HEX);
    const envelope = await encryptTokens(masterKey, TEST_TOKENS);

    // The ciphertext (base64) should not contain the plaintext tokens
    const envelopeJson = JSON.stringify(envelope);
    expect(envelopeJson).not.toContain(TEST_TOKENS.access_token);
    expect(envelopeJson).not.toContain(TEST_TOKENS.refresh_token);
  });

  it("produces different ciphertext for each encryption (random IV and DEK)", async () => {
    const masterKey = await importMasterKey(TEST_MASTER_KEY_HEX);
    const envelope1 = await encryptTokens(masterKey, TEST_TOKENS);
    const envelope2 = await encryptTokens(masterKey, TEST_TOKENS);

    // IVs should differ
    expect(envelope1.iv).not.toBe(envelope2.iv);
    // Ciphertexts should differ (different DEK + different IV)
    expect(envelope1.ciphertext).not.toBe(envelope2.ciphertext);
    // DEK IVs should differ
    expect(envelope1.dekIv).not.toBe(envelope2.dekIv);
  });

  it("fails to decrypt with wrong master key", async () => {
    const masterKey = await importMasterKey(TEST_MASTER_KEY_HEX);
    const wrongKey = await importMasterKey(WRONG_MASTER_KEY_HEX);

    const envelope = await encryptTokens(masterKey, TEST_TOKENS);

    // Decryption with wrong master key should fail (GCM authentication)
    await expect(decryptTokens(wrongKey, envelope)).rejects.toThrow();
  });

  it("fails to decrypt with tampered ciphertext", async () => {
    const masterKey = await importMasterKey(TEST_MASTER_KEY_HEX);
    const envelope = await encryptTokens(masterKey, TEST_TOKENS);

    // Tamper with the ciphertext
    const tampered: EncryptedEnvelope = {
      ...envelope,
      ciphertext: envelope.ciphertext.slice(0, -4) + "XXXX",
    };

    await expect(decryptTokens(masterKey, tampered)).rejects.toThrow();
  });

  it("fails to decrypt with tampered encryptedDek", async () => {
    const masterKey = await importMasterKey(TEST_MASTER_KEY_HEX);
    const envelope = await encryptTokens(masterKey, TEST_TOKENS);

    const tampered: EncryptedEnvelope = {
      ...envelope,
      encryptedDek: envelope.encryptedDek.slice(0, -4) + "XXXX",
    };

    await expect(decryptTokens(masterKey, tampered)).rejects.toThrow();
  });

  it("round-trips tokens with special characters", async () => {
    const masterKey = await importMasterKey(TEST_MASTER_KEY_HEX);
    const specialTokens: TokenPayload = {
      access_token: 'ya29.token-with-"quotes"-and-{braces}',
      refresh_token: "1//token-with-unicode-\u00e9\u00e8\u00ea",
      expiry: "2026-12-31T23:59:59.999Z",
    };

    const envelope = await encryptTokens(masterKey, specialTokens);
    const decrypted = await decryptTokens(masterKey, envelope);

    expect(decrypted).toEqual(specialTokens);
  });

  it("envelope can be serialized to and parsed from JSON", async () => {
    const masterKey = await importMasterKey(TEST_MASTER_KEY_HEX);
    const envelope = await encryptTokens(masterKey, TEST_TOKENS);

    // Simulate storing in SQLite (serialize to JSON string, parse back)
    const json = JSON.stringify(envelope);
    const parsed: EncryptedEnvelope = JSON.parse(json);

    const decrypted = await decryptTokens(masterKey, parsed);
    expect(decrypted).toEqual(TEST_TOKENS);
  });
});

// ---------------------------------------------------------------------------
// reEncryptDek tests (master key rotation)
// ---------------------------------------------------------------------------

describe("reEncryptDek", () => {
  it("re-encrypts DEK with new master key and tokens are still accessible", async () => {
    const oldKey = await importMasterKey(TEST_MASTER_KEY_HEX);
    const newKey = await importMasterKey(WRONG_MASTER_KEY_HEX); // using "wrong" key as new key

    const envelope = await encryptTokens(oldKey, TEST_TOKENS);
    const rotated = await reEncryptDek(oldKey, newKey, envelope);

    // Decrypt with the NEW key should work
    const decrypted = await decryptTokens(newKey, rotated);
    expect(decrypted).toEqual(TEST_TOKENS);
  });

  it("old master key cannot decrypt after rotation", async () => {
    const oldKey = await importMasterKey(TEST_MASTER_KEY_HEX);
    const newKey = await importMasterKey(WRONG_MASTER_KEY_HEX);

    const envelope = await encryptTokens(oldKey, TEST_TOKENS);
    const rotated = await reEncryptDek(oldKey, newKey, envelope);

    // Old key should fail to decrypt the rotated envelope
    await expect(decryptTokens(oldKey, rotated)).rejects.toThrow();
  });

  it("preserves token ciphertext (iv and ciphertext unchanged)", async () => {
    const oldKey = await importMasterKey(TEST_MASTER_KEY_HEX);
    const newKey = await importMasterKey(WRONG_MASTER_KEY_HEX);

    const envelope = await encryptTokens(oldKey, TEST_TOKENS);
    const rotated = await reEncryptDek(oldKey, newKey, envelope);

    // Token IV and ciphertext must NOT change (only DEK wrapper changes)
    expect(rotated.iv).toBe(envelope.iv);
    expect(rotated.ciphertext).toBe(envelope.ciphertext);

    // DEK encryption wrapper MUST change
    expect(rotated.encryptedDek).not.toBe(envelope.encryptedDek);
    expect(rotated.dekIv).not.toBe(envelope.dekIv);
  });

  it("fails when old master key is wrong", async () => {
    const realKey = await importMasterKey(TEST_MASTER_KEY_HEX);
    const wrongOldKey = await importMasterKey(WRONG_MASTER_KEY_HEX);
    const newKey = await importMasterKey(
      "aaaabbbbccccddddaaaabbbbccccddddaaaabbbbccccddddaaaabbbbccccdddd",
    );

    const envelope = await encryptTokens(realKey, TEST_TOKENS);

    // Using wrong old key should fail (cannot decrypt DEK)
    await expect(reEncryptDek(wrongOldKey, newKey, envelope)).rejects.toThrow();
  });

  it("produces different DEK IV on each rotation (fresh random IV)", async () => {
    const oldKey = await importMasterKey(TEST_MASTER_KEY_HEX);
    const newKey = await importMasterKey(WRONG_MASTER_KEY_HEX);

    const envelope = await encryptTokens(oldKey, TEST_TOKENS);
    const rotated1 = await reEncryptDek(oldKey, newKey, envelope);

    // Re-encrypt again (rotate to yet another key)
    const thirdKey = await importMasterKey(
      "aaaabbbbccccddddaaaabbbbccccddddaaaabbbbccccddddaaaabbbbccccdddd",
    );
    const rotated2 = await reEncryptDek(newKey, thirdKey, rotated1);

    // DEK IVs should differ between rotations
    expect(rotated1.dekIv).not.toBe(rotated2.dekIv);
    expect(rotated1.encryptedDek).not.toBe(rotated2.encryptedDek);

    // But tokens should still be accessible with the latest key
    const decrypted = await decryptTokens(thirdKey, rotated2);
    expect(decrypted).toEqual(TEST_TOKENS);
  });
});

// ---------------------------------------------------------------------------
// DEK backup/restore tests
// ---------------------------------------------------------------------------

describe("extractDekForBackup / restoreDekFromBackup", () => {
  it("extracts DEK material for backup (encryptedDek + dekIv only)", async () => {
    const masterKey = await importMasterKey(TEST_MASTER_KEY_HEX);
    const envelope = await encryptTokens(masterKey, TEST_TOKENS);

    const backup = extractDekForBackup("acct_123", envelope);

    expect(backup.accountId).toBe("acct_123");
    expect(backup.encryptedDek).toBe(envelope.encryptedDek);
    expect(backup.dekIv).toBe(envelope.dekIv);
    expect(backup.backedUpAt).toBeDefined();
    expect(new Date(backup.backedUpAt).getTime()).toBeGreaterThan(0);
  });

  it("backup does NOT contain token ciphertext", async () => {
    const masterKey = await importMasterKey(TEST_MASTER_KEY_HEX);
    const envelope = await encryptTokens(masterKey, TEST_TOKENS);

    const backup = extractDekForBackup("acct_123", envelope);

    // Backup should NOT have iv or ciphertext (token data)
    expect(backup).not.toHaveProperty("iv");
    expect(backup).not.toHaveProperty("ciphertext");
  });

  it("restoreDekFromBackup replaces DEK in envelope while preserving token data", async () => {
    const masterKey = await importMasterKey(TEST_MASTER_KEY_HEX);
    const envelope = await encryptTokens(masterKey, TEST_TOKENS);

    // Create a backup from the original envelope
    const backup = extractDekForBackup("acct_123", envelope);

    // Simulate a corrupted envelope (wrong DEK)
    const corruptedEnvelope: EncryptedEnvelope = {
      iv: envelope.iv,
      ciphertext: envelope.ciphertext,
      encryptedDek: "corrupted_dek_data",
      dekIv: "corrupted_iv_data",
    };

    // Restore the DEK from backup
    const restored = restoreDekFromBackup(corruptedEnvelope, backup);

    // Token data should be preserved from the corrupted envelope
    expect(restored.iv).toBe(envelope.iv);
    expect(restored.ciphertext).toBe(envelope.ciphertext);

    // DEK should be restored from backup
    expect(restored.encryptedDek).toBe(backup.encryptedDek);
    expect(restored.dekIv).toBe(backup.dekIv);

    // Should be able to decrypt tokens with the restored envelope
    const decrypted = await decryptTokens(masterKey, restored);
    expect(decrypted).toEqual(TEST_TOKENS);
  });

  it("backup can be serialized to JSON and parsed back", async () => {
    const masterKey = await importMasterKey(TEST_MASTER_KEY_HEX);
    const envelope = await encryptTokens(masterKey, TEST_TOKENS);

    const backup = extractDekForBackup("acct_123", envelope);

    // Simulate R2 storage: serialize to JSON, parse back
    const json = JSON.stringify(backup);
    const parsed: DekBackupEntry = JSON.parse(json);

    expect(parsed.accountId).toBe(backup.accountId);
    expect(parsed.encryptedDek).toBe(backup.encryptedDek);
    expect(parsed.dekIv).toBe(backup.dekIv);
  });
});
