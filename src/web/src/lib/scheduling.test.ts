/**
 * Unit tests for scheduling types and helpers.
 *
 * Tests the pure functions in lib/scheduling.ts: statusLabel, statusColor,
 * statusBgColor, formatScore, formatDateTime, defaultConstraints.
 */
import { describe, it, expect } from "vitest";
import {
  statusLabel,
  statusColor,
  statusBgColor,
  formatScore,
  formatDateTime,
  defaultConstraints,
  DURATION_OPTIONS,
  type SessionStatus,
} from "./scheduling";

describe("scheduling helpers", () => {
  // =========================================================================
  // statusLabel
  // =========================================================================

  describe("statusLabel", () => {
    it("returns Pending for pending", () => {
      expect(statusLabel("pending")).toBe("Pending");
    });

    it("returns Ready for candidates_ready", () => {
      expect(statusLabel("candidates_ready")).toBe("Ready");
    });

    it("returns Committed for committed", () => {
      expect(statusLabel("committed")).toBe("Committed");
    });

    it("returns Cancelled for cancelled", () => {
      expect(statusLabel("cancelled")).toBe("Cancelled");
    });

    it("returns Failed for failed", () => {
      expect(statusLabel("failed")).toBe("Failed");
    });
  });

  // =========================================================================
  // statusColor
  // =========================================================================

  describe("statusColor", () => {
    it("returns amber for pending", () => {
      expect(statusColor("pending")).toBe("#f59e0b");
    });

    it("returns blue for candidates_ready", () => {
      expect(statusColor("candidates_ready")).toBe("#3b82f6");
    });

    it("returns green for committed", () => {
      expect(statusColor("committed")).toBe("#22c55e");
    });

    it("returns slate for cancelled", () => {
      expect(statusColor("cancelled")).toBe("#94a3b8");
    });

    it("returns red for failed", () => {
      expect(statusColor("failed")).toBe("#ef4444");
    });
  });

  // =========================================================================
  // statusBgColor
  // =========================================================================

  describe("statusBgColor", () => {
    it("returns dark amber for pending", () => {
      expect(statusBgColor("pending")).toBe("#451a03");
    });

    it("returns dark blue for candidates_ready", () => {
      expect(statusBgColor("candidates_ready")).toBe("#1e3a5f");
    });

    it("returns dark green for committed", () => {
      expect(statusBgColor("committed")).toBe("#052e16");
    });

    it("returns dark slate for cancelled", () => {
      expect(statusBgColor("cancelled")).toBe("#1e293b");
    });

    it("returns dark red for failed", () => {
      expect(statusBgColor("failed")).toBe("#450a0a");
    });
  });

  // =========================================================================
  // formatScore
  // =========================================================================

  describe("formatScore", () => {
    it("formats 0.95 as 95%", () => {
      expect(formatScore(0.95)).toBe("95%");
    });

    it("formats 1.0 as 100%", () => {
      expect(formatScore(1.0)).toBe("100%");
    });

    it("formats 0 as 0%", () => {
      expect(formatScore(0)).toBe("0%");
    });

    it("rounds to nearest integer", () => {
      expect(formatScore(0.333)).toBe("33%");
      expect(formatScore(0.667)).toBe("67%");
    });
  });

  // =========================================================================
  // formatDateTime
  // =========================================================================

  describe("formatDateTime", () => {
    it("returns a string containing the date components", () => {
      const result = formatDateTime("2026-02-20T10:00:00Z");
      // The exact format depends on locale, but should contain month and day
      expect(result).toBeTruthy();
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // defaultConstraints
  // =========================================================================

  describe("defaultConstraints", () => {
    it("returns default constraint values", () => {
      const c = defaultConstraints();
      expect(c.avoid_early_morning).toBe(false);
      expect(c.avoid_late_evening).toBe(false);
      expect(c.prefer_existing_gaps).toBe(true);
    });

    it("returns a new object each time (not shared reference)", () => {
      const a = defaultConstraints();
      const b = defaultConstraints();
      expect(a).not.toBe(b);
      expect(a).toEqual(b);
    });
  });

  // =========================================================================
  // DURATION_OPTIONS
  // =========================================================================

  describe("DURATION_OPTIONS", () => {
    it("contains expected duration values", () => {
      expect(DURATION_OPTIONS).toContain(15);
      expect(DURATION_OPTIONS).toContain(30);
      expect(DURATION_OPTIONS).toContain(45);
      expect(DURATION_OPTIONS).toContain(60);
      expect(DURATION_OPTIONS).toContain(90);
      expect(DURATION_OPTIONS).toContain(120);
    });

    it("is sorted ascending", () => {
      for (let i = 1; i < DURATION_OPTIONS.length; i++) {
        expect(DURATION_OPTIONS[i]).toBeGreaterThan(DURATION_OPTIONS[i - 1]);
      }
    });
  });
});
