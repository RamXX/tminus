/**
 * Unit tests for PBKDF2 password hashing utilities.
 *
 * Tests:
 * - hashPassword/verifyPassword round-trip
 * - Stored hash format (salt:key)
 * - Different passwords produce different hashes
 * - Same password produces different hashes (different salts)
 * - Wrong password is rejected
 * - Tampered hash is rejected
 * - Malformed stored hash is rejected
 */

import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword } from "./password";

// ---------------------------------------------------------------------------
// Round-trip
// ---------------------------------------------------------------------------

describe("hashPassword / verifyPassword", () => {
  it("round-trips: hash then verify returns true", async () => {
    const password = "my-secure-password-123!";
    const hash = await hashPassword(password);
    const result = await verifyPassword(password, hash);
    expect(result).toBe(true);
  });

  it("works with unicode passwords", async () => {
    const password = "Passwort mit Umlauten: aou";
    const hash = await hashPassword(password);
    expect(await verifyPassword(password, hash)).toBe(true);
  });

  it("works with empty password (edge case)", async () => {
    const password = "";
    const hash = await hashPassword(password);
    expect(await verifyPassword(password, hash)).toBe(true);
  });

  it("works with very long passwords", async () => {
    const password = "a".repeat(10000);
    const hash = await hashPassword(password);
    expect(await verifyPassword(password, hash)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Hash format
// ---------------------------------------------------------------------------

describe("hashPassword: output format", () => {
  it("produces format <hex-salt>:<hex-key>", async () => {
    const hash = await hashPassword("test-password");
    const parts = hash.split(":");
    expect(parts).toHaveLength(2);

    const [salt, key] = parts;
    // Salt: 16 bytes = 32 hex chars
    expect(salt).toHaveLength(32);
    expect(salt).toMatch(/^[0-9a-f]{32}$/);

    // Key: 32 bytes = 64 hex chars
    expect(key).toHaveLength(64);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("uses different salts for the same password (randomized)", async () => {
    const password = "same-password";
    const hash1 = await hashPassword(password);
    const hash2 = await hashPassword(password);

    // Different salts means different full hashes
    expect(hash1).not.toBe(hash2);

    // But both should verify correctly
    expect(await verifyPassword(password, hash1)).toBe(true);
    expect(await verifyPassword(password, hash2)).toBe(true);
  });

  it("stored value is NOT plaintext (does not contain original password)", async () => {
    const password = "super-secret-value";
    const hash = await hashPassword(password);
    expect(hash).not.toContain(password);
  });
});

// ---------------------------------------------------------------------------
// Wrong password
// ---------------------------------------------------------------------------

describe("verifyPassword: rejection", () => {
  it("rejects a wrong password", async () => {
    const hash = await hashPassword("correct-password");
    const result = await verifyPassword("wrong-password", hash);
    expect(result).toBe(false);
  });

  it("rejects similar but different passwords", async () => {
    const hash = await hashPassword("password123");
    expect(await verifyPassword("password124", hash)).toBe(false);
    expect(await verifyPassword("Password123", hash)).toBe(false);
    expect(await verifyPassword("password123 ", hash)).toBe(false);
    expect(await verifyPassword(" password123", hash)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tampered / malformed hashes
// ---------------------------------------------------------------------------

describe("verifyPassword: tampered and malformed hashes", () => {
  it("rejects hash with tampered salt", async () => {
    const hash = await hashPassword("test-password");
    const parts = hash.split(":");
    // Flip a character in the salt
    const tamperedSalt =
      (parts[0][0] === "a" ? "b" : "a") + parts[0].slice(1);
    const tampered = `${tamperedSalt}:${parts[1]}`;
    expect(await verifyPassword("test-password", tampered)).toBe(false);
  });

  it("rejects hash with tampered key", async () => {
    const hash = await hashPassword("test-password");
    const parts = hash.split(":");
    // Flip a character in the derived key
    const tamperedKey =
      (parts[1][0] === "a" ? "b" : "a") + parts[1].slice(1);
    const tampered = `${parts[0]}:${tamperedKey}`;
    expect(await verifyPassword("test-password", tampered)).toBe(false);
  });

  it("rejects empty string as stored hash", async () => {
    expect(await verifyPassword("password", "")).toBe(false);
  });

  it("rejects hash without colon separator", async () => {
    expect(
      await verifyPassword("password", "abcdef1234567890abcdef1234567890"),
    ).toBe(false);
  });

  it("rejects hash with wrong salt length", async () => {
    expect(
      await verifyPassword(
        "password",
        "ab:" + "cd".repeat(32),
      ),
    ).toBe(false);
  });

  it("rejects hash with wrong key length", async () => {
    expect(
      await verifyPassword(
        "password",
        "ab".repeat(16) + ":cd",
      ),
    ).toBe(false);
  });
});
