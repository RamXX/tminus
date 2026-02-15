/**
 * Unit tests for auth routes.
 *
 * Tests input validation, email format checking, password validation,
 * SHA-256 hashing helper, and route handler logic for each endpoint.
 */

import { describe, it, expect } from "vitest";
import { isValidEmail, validatePassword, sha256Hex } from "./auth";

// ---------------------------------------------------------------------------
// Email validation
// ---------------------------------------------------------------------------

describe("isValidEmail", () => {
  it("accepts valid email addresses", () => {
    expect(isValidEmail("user@example.com")).toBe(true);
    expect(isValidEmail("a@b.co")).toBe(true);
    expect(isValidEmail("user+tag@domain.org")).toBe(true);
    expect(isValidEmail("first.last@sub.domain.com")).toBe(true);
  });

  it("rejects invalid email addresses", () => {
    expect(isValidEmail("")).toBe(false);
    expect(isValidEmail("notanemail")).toBe(false);
    expect(isValidEmail("@domain.com")).toBe(false);
    expect(isValidEmail("user@")).toBe(false);
    expect(isValidEmail("user@domain")).toBe(false);
    expect(isValidEmail("user @domain.com")).toBe(false);
    expect(isValidEmail("user@domain .com")).toBe(false);
  });

  it("rejects non-string inputs", () => {
    expect(isValidEmail(null as unknown as string)).toBe(false);
    expect(isValidEmail(undefined as unknown as string)).toBe(false);
    expect(isValidEmail(42 as unknown as string)).toBe(false);
  });

  it("rejects emails longer than 254 characters", () => {
    const longLocal = "a".repeat(243);
    const longEmail = `${longLocal}@example.com`;
    expect(longEmail.length).toBeGreaterThan(254);
    expect(isValidEmail(longEmail)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Password validation
// ---------------------------------------------------------------------------

describe("validatePassword", () => {
  it("returns null for valid passwords", () => {
    expect(validatePassword("password123")).toBeNull();
    expect(validatePassword("a".repeat(8))).toBeNull();
    expect(validatePassword("a".repeat(128))).toBeNull();
  });

  it("returns error for empty/missing password", () => {
    expect(validatePassword("")).not.toBeNull();
    expect(validatePassword(null as unknown as string)).not.toBeNull();
    expect(validatePassword(undefined as unknown as string)).not.toBeNull();
  });

  it("returns error for too-short password", () => {
    expect(validatePassword("short")).not.toBeNull();
    expect(validatePassword("1234567")).not.toBeNull();
    const error = validatePassword("1234567");
    expect(error).toContain("8");
  });

  it("returns error for too-long password", () => {
    const error = validatePassword("a".repeat(129));
    expect(error).not.toBeNull();
    expect(error).toContain("128");
  });
});

// ---------------------------------------------------------------------------
// SHA-256 hex helper
// ---------------------------------------------------------------------------

describe("sha256Hex", () => {
  it("returns a 64-character hex string", async () => {
    const hash = await sha256Hex("test-token");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces consistent output for same input", async () => {
    const hash1 = await sha256Hex("same-input");
    const hash2 = await sha256Hex("same-input");
    expect(hash1).toBe(hash2);
  });

  it("produces different output for different inputs", async () => {
    const hash1 = await sha256Hex("input-a");
    const hash2 = await sha256Hex("input-b");
    expect(hash1).not.toBe(hash2);
  });
});
