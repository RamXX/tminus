/**
 * Unit tests for API key generation, hashing, and validation.
 *
 * Tests:
 * - Key generation produces correct format (tmk_live_ prefix)
 * - Generated keys have correct length
 * - SHA-256 hashing produces consistent results
 * - Hash is different from the raw key (not plaintext)
 * - Format validation accepts valid keys, rejects invalid ones
 * - Prefix extraction works correctly
 * - Each generated key is unique
 */

import { describe, it, expect } from "vitest";
import {
  generateApiKey,
  hashApiKey,
  isApiKeyFormat,
  extractPrefix,
  API_KEY_PREFIX,
  LOOKUP_PREFIX_LENGTH,
  RANDOM_PORTION_LENGTH,
} from "./api-keys";

// ---------------------------------------------------------------------------
// Key generation
// ---------------------------------------------------------------------------

describe("generateApiKey", () => {
  it("produces a key starting with tmk_live_", async () => {
    const { rawKey } = await generateApiKey();
    expect(rawKey.startsWith(API_KEY_PREFIX)).toBe(true);
  });

  it("produces a key of correct total length", async () => {
    const { rawKey } = await generateApiKey();
    const expectedLength =
      API_KEY_PREFIX.length + LOOKUP_PREFIX_LENGTH + RANDOM_PORTION_LENGTH;
    expect(rawKey.length).toBe(expectedLength);
  });

  it("returns an 8-char hex prefix", async () => {
    const { prefix } = await generateApiKey();
    expect(prefix.length).toBe(LOOKUP_PREFIX_LENGTH);
    expect(/^[0-9a-f]+$/.test(prefix)).toBe(true);
  });

  it("returns a non-empty keyHash that differs from rawKey", async () => {
    const { rawKey, keyHash } = await generateApiKey();
    expect(keyHash.length).toBeGreaterThan(0);
    expect(keyHash).not.toBe(rawKey);
    // SHA-256 produces 64 hex characters
    expect(keyHash.length).toBe(64);
    expect(/^[0-9a-f]+$/.test(keyHash)).toBe(true);
  });

  it("generates unique keys on successive calls", async () => {
    const keys = await Promise.all(
      Array.from({ length: 10 }, () => generateApiKey()),
    );
    const rawKeys = keys.map((k) => k.rawKey);
    const uniqueKeys = new Set(rawKeys);
    expect(uniqueKeys.size).toBe(rawKeys.length);
  });

  it("prefix in rawKey matches returned prefix", async () => {
    const { rawKey, prefix } = await generateApiKey();
    const prefixFromKey = rawKey.slice(
      API_KEY_PREFIX.length,
      API_KEY_PREFIX.length + LOOKUP_PREFIX_LENGTH,
    );
    expect(prefixFromKey).toBe(prefix);
  });
});

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

describe("hashApiKey", () => {
  it("produces a 64-char hex SHA-256 hash", async () => {
    const hash = await hashApiKey("tmk_live_abcdef1234567890abcdef1234567890abcdef12");
    expect(hash.length).toBe(64);
    expect(/^[0-9a-f]+$/.test(hash)).toBe(true);
  });

  it("produces the same hash for the same input", async () => {
    const key = "tmk_live_abcdef1234567890abcdef1234567890abcdef12";
    const hash1 = await hashApiKey(key);
    const hash2 = await hashApiKey(key);
    expect(hash1).toBe(hash2);
  });

  it("produces different hashes for different inputs", async () => {
    const hash1 = await hashApiKey("tmk_live_aaaaaaa1234567890abcdef1234567890abcdef12");
    const hash2 = await hashApiKey("tmk_live_bbbbbbb1234567890abcdef1234567890abcdef12");
    expect(hash1).not.toBe(hash2);
  });

  it("hash does not contain the original key material", async () => {
    const key = "tmk_live_abcdef1234567890abcdef1234567890abcdef12";
    const hash = await hashApiKey(key);
    expect(hash).not.toContain("tmk_live_");
    expect(hash).not.toContain("abcdef1234567890abcdef1234567890abcdef12");
  });
});

// ---------------------------------------------------------------------------
// Format validation
// ---------------------------------------------------------------------------

describe("isApiKeyFormat", () => {
  it("accepts a valid API key format", () => {
    // 8 prefix + 32 random = 40 hex chars after tmk_live_
    const validKey = "tmk_live_" + "a".repeat(40);
    expect(isApiKeyFormat(validKey)).toBe(true);
  });

  it("rejects empty string", () => {
    expect(isApiKeyFormat("")).toBe(false);
  });

  it("rejects a JWT-like token", () => {
    expect(isApiKeyFormat("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.sig")).toBe(false);
  });

  it("rejects key with wrong prefix", () => {
    expect(isApiKeyFormat("n2k_live_" + "a".repeat(40))).toBe(false);
  });

  it("rejects key that is too short", () => {
    expect(isApiKeyFormat("tmk_live_" + "a".repeat(39))).toBe(false);
  });

  it("rejects key that is too long", () => {
    expect(isApiKeyFormat("tmk_live_" + "a".repeat(41))).toBe(false);
  });

  it("rejects key with non-hex characters in body", () => {
    expect(isApiKeyFormat("tmk_live_" + "g".repeat(40))).toBe(false);
  });

  it("rejects key with uppercase hex", () => {
    // We only accept lowercase hex
    expect(isApiKeyFormat("tmk_live_" + "A".repeat(40))).toBe(false);
  });

  it("accepts a key produced by generateApiKey", async () => {
    const { rawKey } = await generateApiKey();
    expect(isApiKeyFormat(rawKey)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Prefix extraction
// ---------------------------------------------------------------------------

describe("extractPrefix", () => {
  it("extracts the 8-char prefix from a valid key", () => {
    const key = "tmk_live_12345678" + "a".repeat(32);
    expect(extractPrefix(key)).toBe("12345678");
  });

  it("returns null for an invalid key", () => {
    expect(extractPrefix("not-a-valid-key")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractPrefix("")).toBeNull();
  });

  it("extracts correct prefix from generated key", async () => {
    const { rawKey, prefix } = await generateApiKey();
    expect(extractPrefix(rawKey)).toBe(prefix);
  });
});
