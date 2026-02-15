/**
 * Unit tests for auth routes.
 *
 * Tests input validation, email format checking, password validation,
 * SHA-256 hashing helper, and account lockout logic (TM-as6.4).
 */

import { describe, it, expect } from "vitest";
import {
  isValidEmail,
  validatePassword,
  sha256Hex,
  getLockoutDurationSeconds,
  computeLockedUntil,
  getRetryAfterSeconds,
  LOCKOUT_THRESHOLDS,
} from "./auth";

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

// ---------------------------------------------------------------------------
// Account lockout logic (TM-as6.4)
// ---------------------------------------------------------------------------

describe("LOCKOUT_THRESHOLDS", () => {
  it("has exactly 3 thresholds in descending order of attempts", () => {
    expect(LOCKOUT_THRESHOLDS).toHaveLength(3);
    // Verify descending order (highest threshold first)
    expect(LOCKOUT_THRESHOLDS[0].attempts).toBeGreaterThan(LOCKOUT_THRESHOLDS[1].attempts);
    expect(LOCKOUT_THRESHOLDS[1].attempts).toBeGreaterThan(LOCKOUT_THRESHOLDS[2].attempts);
  });

  it("contains the correct threshold values", () => {
    // 20+ -> 24 hours (86400s)
    expect(LOCKOUT_THRESHOLDS[0]).toEqual({ attempts: 20, durationSeconds: 86400 });
    // 10+ -> 1 hour (3600s)
    expect(LOCKOUT_THRESHOLDS[1]).toEqual({ attempts: 10, durationSeconds: 3600 });
    // 5+ -> 15 min (900s)
    expect(LOCKOUT_THRESHOLDS[2]).toEqual({ attempts: 5, durationSeconds: 900 });
  });
});

describe("getLockoutDurationSeconds", () => {
  it("returns 0 for fewer than 5 failed attempts", () => {
    expect(getLockoutDurationSeconds(0)).toBe(0);
    expect(getLockoutDurationSeconds(1)).toBe(0);
    expect(getLockoutDurationSeconds(4)).toBe(0);
  });

  it("returns 900 (15 min) for 5-9 failed attempts", () => {
    expect(getLockoutDurationSeconds(5)).toBe(900);
    expect(getLockoutDurationSeconds(6)).toBe(900);
    expect(getLockoutDurationSeconds(9)).toBe(900);
  });

  it("returns 3600 (1 hour) for 10-19 failed attempts", () => {
    expect(getLockoutDurationSeconds(10)).toBe(3600);
    expect(getLockoutDurationSeconds(15)).toBe(3600);
    expect(getLockoutDurationSeconds(19)).toBe(3600);
  });

  it("returns 86400 (24 hours) for 20+ failed attempts", () => {
    expect(getLockoutDurationSeconds(20)).toBe(86400);
    expect(getLockoutDurationSeconds(50)).toBe(86400);
    expect(getLockoutDurationSeconds(100)).toBe(86400);
  });

  it("matches exact threshold boundaries", () => {
    // Just below threshold -> no lockout at that tier
    expect(getLockoutDurationSeconds(4)).toBe(0);
    expect(getLockoutDurationSeconds(9)).toBe(900);
    expect(getLockoutDurationSeconds(19)).toBe(3600);

    // Exactly at threshold -> lockout at that tier
    expect(getLockoutDurationSeconds(5)).toBe(900);
    expect(getLockoutDurationSeconds(10)).toBe(3600);
    expect(getLockoutDurationSeconds(20)).toBe(86400);
  });
});

describe("computeLockedUntil", () => {
  const fixedNow = new Date("2026-02-14T12:00:00.000Z");

  it("returns null when no lockout applies (< 5 attempts)", () => {
    expect(computeLockedUntil(0, fixedNow)).toBeNull();
    expect(computeLockedUntil(4, fixedNow)).toBeNull();
  });

  it("returns ISO timestamp 15 min ahead for 5 failed attempts", () => {
    const result = computeLockedUntil(5, fixedNow);
    expect(result).toBe("2026-02-14T12:15:00.000Z");
  });

  it("returns ISO timestamp 1 hour ahead for 10 failed attempts", () => {
    const result = computeLockedUntil(10, fixedNow);
    expect(result).toBe("2026-02-14T13:00:00.000Z");
  });

  it("returns ISO timestamp 24 hours ahead for 20 failed attempts", () => {
    const result = computeLockedUntil(20, fixedNow);
    expect(result).toBe("2026-02-15T12:00:00.000Z");
  });

  it("uses current time when now is not provided", () => {
    const before = Date.now();
    const result = computeLockedUntil(5);
    const after = Date.now();

    expect(result).not.toBeNull();
    const resultMs = new Date(result!).getTime();
    // Should be 900 seconds (15 min) from approximately now
    expect(resultMs).toBeGreaterThanOrEqual(before + 900_000);
    expect(resultMs).toBeLessThanOrEqual(after + 900_000);
  });
});

describe("getRetryAfterSeconds", () => {
  const fixedNow = new Date("2026-02-14T12:00:00.000Z");

  it("returns 0 when lockedUntil is null", () => {
    expect(getRetryAfterSeconds(null, fixedNow)).toBe(0);
  });

  it("returns 0 when lockout has expired (lockedUntil in the past)", () => {
    expect(getRetryAfterSeconds("2026-02-14T11:00:00.000Z", fixedNow)).toBe(0);
    expect(getRetryAfterSeconds("2026-02-14T11:59:59.000Z", fixedNow)).toBe(0);
  });

  it("returns 0 when lockedUntil is exactly now", () => {
    expect(getRetryAfterSeconds("2026-02-14T12:00:00.000Z", fixedNow)).toBe(0);
  });

  it("returns correct remaining seconds when locked", () => {
    // 15 minutes from now
    expect(getRetryAfterSeconds("2026-02-14T12:15:00.000Z", fixedNow)).toBe(900);
    // 1 hour from now
    expect(getRetryAfterSeconds("2026-02-14T13:00:00.000Z", fixedNow)).toBe(3600);
    // 24 hours from now
    expect(getRetryAfterSeconds("2026-02-15T12:00:00.000Z", fixedNow)).toBe(86400);
  });

  it("rounds up fractional seconds (Math.ceil)", () => {
    // 10.5 seconds from now -> should return 11
    const lockedUntil = new Date(fixedNow.getTime() + 10_500).toISOString();
    expect(getRetryAfterSeconds(lockedUntil, fixedNow)).toBe(11);
  });

  it("returns 1 for 1ms remaining (ceiling)", () => {
    const lockedUntil = new Date(fixedNow.getTime() + 1).toISOString();
    expect(getRetryAfterSeconds(lockedUntil, fixedNow)).toBe(1);
  });
});
