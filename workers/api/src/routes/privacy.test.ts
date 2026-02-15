/**
 * Unit tests for privacy route helpers (GDPR deletion request).
 *
 * Tests pure logic functions: grace period computation, grace period checking,
 * and constant values. These functions have no I/O dependencies.
 */

import { describe, it, expect } from "vitest";
import {
  computeScheduledAt,
  isWithinGracePeriod,
  DELETION_GRACE_PERIOD_MS,
  DELETION_GRACE_PERIOD_HOURS,
} from "./privacy";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("DELETION_GRACE_PERIOD constants", () => {
  it("grace period is exactly 72 hours in milliseconds", () => {
    expect(DELETION_GRACE_PERIOD_MS).toBe(72 * 60 * 60 * 1000);
    expect(DELETION_GRACE_PERIOD_MS).toBe(259_200_000);
  });

  it("grace period hours is 72", () => {
    expect(DELETION_GRACE_PERIOD_HOURS).toBe(72);
  });

  it("hours and milliseconds are consistent", () => {
    expect(DELETION_GRACE_PERIOD_HOURS * 60 * 60 * 1000).toBe(DELETION_GRACE_PERIOD_MS);
  });
});

// ---------------------------------------------------------------------------
// computeScheduledAt
// ---------------------------------------------------------------------------

describe("computeScheduledAt", () => {
  const fixedNow = new Date("2026-02-14T12:00:00.000Z");

  it("returns ISO timestamp exactly 72 hours from now", () => {
    const result = computeScheduledAt(fixedNow);
    expect(result).toBe("2026-02-17T12:00:00.000Z");
  });

  it("returns a valid ISO-8601 string", () => {
    const result = computeScheduledAt(fixedNow);
    // Parsing it back should produce the same date
    const parsed = new Date(result);
    expect(parsed.toISOString()).toBe(result);
  });

  it("handles midnight boundary correctly", () => {
    const midnight = new Date("2026-02-14T00:00:00.000Z");
    const result = computeScheduledAt(midnight);
    expect(result).toBe("2026-02-17T00:00:00.000Z");
  });

  it("handles end of month correctly", () => {
    const endOfMonth = new Date("2026-02-26T12:00:00.000Z");
    const result = computeScheduledAt(endOfMonth);
    // February 26 + 72h = March 1 (2026 is not a leap year)
    expect(result).toBe("2026-03-01T12:00:00.000Z");
  });

  it("uses current time when no argument provided", () => {
    const before = Date.now();
    const result = computeScheduledAt();
    const after = Date.now();

    const resultMs = new Date(result).getTime();
    // Should be 72 hours from approximately now
    expect(resultMs).toBeGreaterThanOrEqual(before + DELETION_GRACE_PERIOD_MS);
    expect(resultMs).toBeLessThanOrEqual(after + DELETION_GRACE_PERIOD_MS);
  });
});

// ---------------------------------------------------------------------------
// isWithinGracePeriod
// ---------------------------------------------------------------------------

describe("isWithinGracePeriod", () => {
  const fixedNow = new Date("2026-02-14T12:00:00.000Z");

  it("returns true when scheduled_at is in the future", () => {
    const scheduledAt = "2026-02-17T12:00:00.000Z"; // 72h from fixedNow
    expect(isWithinGracePeriod(scheduledAt, fixedNow)).toBe(true);
  });

  it("returns true when scheduled_at is 1ms in the future", () => {
    const scheduledAt = new Date(fixedNow.getTime() + 1).toISOString();
    expect(isWithinGracePeriod(scheduledAt, fixedNow)).toBe(true);
  });

  it("returns false when scheduled_at equals now (grace period expired)", () => {
    const scheduledAt = fixedNow.toISOString();
    expect(isWithinGracePeriod(scheduledAt, fixedNow)).toBe(false);
  });

  it("returns false when scheduled_at is in the past", () => {
    const scheduledAt = "2026-02-14T11:00:00.000Z"; // 1h before fixedNow
    expect(isWithinGracePeriod(scheduledAt, fixedNow)).toBe(false);
  });

  it("returns false when scheduled_at is well in the past", () => {
    const scheduledAt = "2026-02-10T00:00:00.000Z"; // 4+ days before
    expect(isWithinGracePeriod(scheduledAt, fixedNow)).toBe(false);
  });

  it("uses current time when no now argument provided", () => {
    // Scheduled far in the future -> should be within grace period
    const farFuture = "2099-01-01T00:00:00.000Z";
    expect(isWithinGracePeriod(farFuture)).toBe(true);

    // Scheduled far in the past -> should NOT be within grace period
    const farPast = "2020-01-01T00:00:00.000Z";
    expect(isWithinGracePeriod(farPast)).toBe(false);
  });
});
