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
} from "./crypto";
import type { EncryptedEnvelope, TokenPayload } from "./crypto";

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
