/**
 * Unit tests for briefing lib helpers.
 *
 * Tests:
 * - getCategoryColor returns correct colors for known and unknown categories
 * - formatCategory capitalizes first letter
 * - formatReputationScore returns correct display/label/color
 * - computeDriftIndicator returns correct drift level based on days
 * - formatTruthLevel returns human-readable labels
 */
import { describe, it, expect } from "vitest";
import {
  getCategoryColor,
  formatCategory,
  formatReputationScore,
  computeDriftIndicator,
  formatTruthLevel,
  EXCUSE_TONES,
  TRUTH_LEVELS,
} from "./briefing";

// ---------------------------------------------------------------------------
// getCategoryColor
// ---------------------------------------------------------------------------

describe("getCategoryColor", () => {
  it("returns blue for colleague", () => {
    expect(getCategoryColor("colleague")).toBe("#3b82f6");
  });

  it("returns purple for client", () => {
    expect(getCategoryColor("client")).toBe("#8b5cf6");
  });

  it("returns green for friend", () => {
    expect(getCategoryColor("friend")).toBe("#22c55e");
  });

  it("returns amber for family", () => {
    expect(getCategoryColor("family")).toBe("#f59e0b");
  });

  it("returns default gray for unknown category", () => {
    expect(getCategoryColor("stranger")).toBe("#94a3b8");
  });

  it("is case-insensitive", () => {
    expect(getCategoryColor("Colleague")).toBe("#3b82f6");
    expect(getCategoryColor("CLIENT")).toBe("#8b5cf6");
  });
});

// ---------------------------------------------------------------------------
// formatCategory
// ---------------------------------------------------------------------------

describe("formatCategory", () => {
  it("capitalizes first letter", () => {
    expect(formatCategory("colleague")).toBe("Colleague");
    expect(formatCategory("client")).toBe("Client");
  });

  it("handles already capitalized", () => {
    expect(formatCategory("Friend")).toBe("Friend");
  });

  it("handles empty string", () => {
    expect(formatCategory("")).toBe("Unknown");
  });
});

// ---------------------------------------------------------------------------
// formatReputationScore
// ---------------------------------------------------------------------------

describe("formatReputationScore", () => {
  it("returns High for score >= 0.8", () => {
    const result = formatReputationScore(0.9);
    expect(result.display).toBe("90");
    expect(result.label).toBe("High");
    expect(result.color).toBe("#22c55e");
  });

  it("returns Medium for score >= 0.5 and < 0.8", () => {
    const result = formatReputationScore(0.65);
    expect(result.display).toBe("65");
    expect(result.label).toBe("Medium");
    expect(result.color).toBe("#f59e0b");
  });

  it("returns Low for score < 0.5", () => {
    const result = formatReputationScore(0.3);
    expect(result.display).toBe("30");
    expect(result.label).toBe("Low");
    expect(result.color).toBe("#ef4444");
  });

  it("rounds correctly", () => {
    const result = formatReputationScore(0.856);
    expect(result.display).toBe("86");
  });

  it("handles boundary at 0.8", () => {
    const result = formatReputationScore(0.8);
    expect(result.label).toBe("High");
  });

  it("handles boundary at 0.5", () => {
    const result = formatReputationScore(0.5);
    expect(result.label).toBe("Medium");
  });

  it("handles zero", () => {
    const result = formatReputationScore(0);
    expect(result.display).toBe("0");
    expect(result.label).toBe("Low");
  });
});

// ---------------------------------------------------------------------------
// computeDriftIndicator
// ---------------------------------------------------------------------------

describe("computeDriftIndicator", () => {
  const now = new Date("2026-02-15T12:00:00Z");

  it("returns Recent for interaction within 7 days", () => {
    const ts = new Date("2026-02-10T12:00:00Z").toISOString();
    const result = computeDriftIndicator(ts, now);
    expect(result.label).toBe("Recent");
    expect(result.color).toBe("#22c55e");
  });

  it("returns Normal for interaction within 30 days", () => {
    const ts = new Date("2026-01-20T12:00:00Z").toISOString();
    const result = computeDriftIndicator(ts, now);
    expect(result.label).toBe("Normal");
    expect(result.color).toBe("#94a3b8");
  });

  it("returns Drifting for interaction within 90 days", () => {
    const ts = new Date("2025-12-01T12:00:00Z").toISOString();
    const result = computeDriftIndicator(ts, now);
    expect(result.label).toBe("Drifting");
    expect(result.color).toBe("#f59e0b");
  });

  it("returns Distant for interaction over 90 days ago", () => {
    const ts = new Date("2025-06-01T12:00:00Z").toISOString();
    const result = computeDriftIndicator(ts, now);
    expect(result.label).toBe("Distant");
    expect(result.color).toBe("#ef4444");
  });

  it("returns Unknown for null timestamp", () => {
    const result = computeDriftIndicator(null, now);
    expect(result.label).toBe("Unknown");
    expect(result.color).toBe("#64748b");
  });
});

// ---------------------------------------------------------------------------
// formatTruthLevel
// ---------------------------------------------------------------------------

describe("formatTruthLevel", () => {
  it("formats full truth", () => {
    expect(formatTruthLevel("full")).toBe("Full Truth");
  });

  it("formats vague", () => {
    expect(formatTruthLevel("vague")).toBe("Vague");
  });

  it("formats white lie", () => {
    expect(formatTruthLevel("white_lie")).toBe("White Lie");
  });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("constants", () => {
  it("exports all excuse tones", () => {
    expect(EXCUSE_TONES).toEqual(["formal", "casual", "apologetic"]);
  });

  it("exports all truth levels", () => {
    expect(TRUTH_LEVELS).toEqual(["full", "vague", "white_lie"]);
  });
});
