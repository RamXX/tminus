/**
 * Unit tests for relationship types and helpers.
 *
 * Tests the pure functions in lib/relationships.ts: computeDriftLevel,
 * driftColor, driftBgColor, driftLabel, categoryStyle, categoryLabel,
 * formatDate, formatScore, daysOverdue, sortByDriftSeverity.
 */
import { describe, it, expect } from "vitest";
import {
  computeDriftLevel,
  driftColor,
  driftBgColor,
  driftLabel,
  categoryStyle,
  categoryLabel,
  formatDate,
  formatScore,
  daysOverdue,
  sortByDriftSeverity,
  COLOR_GREEN,
  COLOR_YELLOW,
  COLOR_RED,
  BG_GREEN,
  BG_YELLOW,
  BG_RED,
  CATEGORY_COLORS,
  CATEGORIES,
  FREQUENCY_OPTIONS,
  type DriftLevel,
  type DriftReportEntry,
  type RelationshipCategory,
} from "./relationships";

// ---------------------------------------------------------------------------
// computeDriftLevel
// ---------------------------------------------------------------------------

describe("computeDriftLevel", () => {
  const now = new Date("2026-02-15T12:00:00Z");

  it("returns green when last interaction is within frequency target", () => {
    // 5 days ago, frequency = 7 days
    expect(computeDriftLevel("2026-02-10T12:00:00Z", 7, now)).toBe("green");
  });

  it("returns green when last interaction is exactly at frequency target", () => {
    // Exactly 7 days ago, frequency = 7 days
    expect(computeDriftLevel("2026-02-08T12:00:00Z", 7, now)).toBe("green");
  });

  it("returns yellow when days since is between 1x and 2x frequency", () => {
    // 10 days ago, frequency = 7 days (1.4x)
    expect(computeDriftLevel("2026-02-05T12:00:00Z", 7, now)).toBe("yellow");
  });

  it("returns yellow at exactly 2x frequency (boundary)", () => {
    // 14 days ago, frequency = 7 days (exactly 2x)
    expect(computeDriftLevel("2026-02-01T12:00:00Z", 7, now)).toBe("yellow");
  });

  it("returns red when days since exceeds 2x frequency", () => {
    // 15 days ago, frequency = 7 days (>2x)
    expect(computeDriftLevel("2026-01-31T12:00:00Z", 7, now)).toBe("red");
  });

  it("returns red when last interaction is null (never contacted)", () => {
    expect(computeDriftLevel(null, 7, now)).toBe("red");
  });

  it("returns green for very recent interaction", () => {
    // 1 day ago, frequency = 30 days
    expect(computeDriftLevel("2026-02-14T12:00:00Z", 30, now)).toBe("green");
  });

  it("handles large frequency targets", () => {
    // 100 days ago, frequency = 365 days
    expect(computeDriftLevel("2025-11-07T12:00:00Z", 365, now)).toBe("green");
  });
});

// ---------------------------------------------------------------------------
// driftColor
// ---------------------------------------------------------------------------

describe("driftColor", () => {
  it("returns green color for green level", () => {
    expect(driftColor("green")).toBe(COLOR_GREEN);
  });

  it("returns yellow color for yellow level", () => {
    expect(driftColor("yellow")).toBe(COLOR_YELLOW);
  });

  it("returns red color for red level", () => {
    expect(driftColor("red")).toBe(COLOR_RED);
  });
});

// ---------------------------------------------------------------------------
// driftBgColor
// ---------------------------------------------------------------------------

describe("driftBgColor", () => {
  it("returns green bg for green level", () => {
    expect(driftBgColor("green")).toBe(BG_GREEN);
  });

  it("returns yellow bg for yellow level", () => {
    expect(driftBgColor("yellow")).toBe(BG_YELLOW);
  });

  it("returns red bg for red level", () => {
    expect(driftBgColor("red")).toBe(BG_RED);
  });
});

// ---------------------------------------------------------------------------
// driftLabel
// ---------------------------------------------------------------------------

describe("driftLabel", () => {
  it("returns On Track for green", () => {
    expect(driftLabel("green")).toBe("On Track");
  });

  it("returns Drifting for yellow", () => {
    expect(driftLabel("yellow")).toBe("Drifting");
  });

  it("returns Overdue for red", () => {
    expect(driftLabel("red")).toBe("Overdue");
  });
});

// ---------------------------------------------------------------------------
// categoryStyle
// ---------------------------------------------------------------------------

describe("categoryStyle", () => {
  it("returns style for professional category", () => {
    const style = categoryStyle("professional");
    expect(style.color).toBe(CATEGORY_COLORS.professional.color);
    expect(style.bg).toBe(CATEGORY_COLORS.professional.bg);
  });

  it("returns style for vip category", () => {
    const style = categoryStyle("vip");
    expect(style.color).toBe(CATEGORY_COLORS.vip.color);
    expect(style.bg).toBe(CATEGORY_COLORS.vip.bg);
  });

  it("returns style for all categories", () => {
    for (const cat of CATEGORIES) {
      const style = categoryStyle(cat);
      expect(style.color).toBeTruthy();
      expect(style.bg).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// categoryLabel
// ---------------------------------------------------------------------------

describe("categoryLabel", () => {
  it("capitalizes professional", () => {
    expect(categoryLabel("professional")).toBe("Professional");
  });

  it("capitalizes personal", () => {
    expect(categoryLabel("personal")).toBe("Personal");
  });

  it("capitalizes vip", () => {
    expect(categoryLabel("vip")).toBe("Vip");
  });

  it("capitalizes community", () => {
    expect(categoryLabel("community")).toBe("Community");
  });

  it("capitalizes family", () => {
    expect(categoryLabel("family")).toBe("Family");
  });
});

// ---------------------------------------------------------------------------
// formatDate
// ---------------------------------------------------------------------------

describe("formatDate", () => {
  it("returns Never for null", () => {
    expect(formatDate(null)).toBe("Never");
  });

  it("formats a date string", () => {
    const result = formatDate("2026-02-15T12:00:00Z");
    // Should contain "Feb" and "2026" in some format
    expect(result).toMatch(/Feb/);
    expect(result).toMatch(/2026/);
    expect(result).toMatch(/15/);
  });

  it("formats another date", () => {
    // Use midday to avoid timezone boundary issues
    const result = formatDate("2025-12-15T12:00:00Z");
    expect(result).toMatch(/Dec/);
    expect(result).toMatch(/2025/);
  });
});

// ---------------------------------------------------------------------------
// formatScore
// ---------------------------------------------------------------------------

describe("formatScore", () => {
  it("returns N/A for null", () => {
    expect(formatScore(null)).toBe("N/A");
  });

  it("returns N/A for undefined", () => {
    expect(formatScore(undefined)).toBe("N/A");
  });

  it("formats a whole number score", () => {
    expect(formatScore(85)).toBe("85/100");
  });

  it("rounds decimal scores", () => {
    expect(formatScore(72.7)).toBe("73/100");
  });

  it("formats zero", () => {
    expect(formatScore(0)).toBe("0/100");
  });

  it("formats 100", () => {
    expect(formatScore(100)).toBe("100/100");
  });
});

// ---------------------------------------------------------------------------
// daysOverdue
// ---------------------------------------------------------------------------

describe("daysOverdue", () => {
  const now = new Date("2026-02-15T12:00:00Z");

  it("returns 0 when not overdue", () => {
    // 5 days ago, frequency 7 days => not overdue
    expect(daysOverdue("2026-02-10T12:00:00Z", 7, now)).toBe(0);
  });

  it("returns positive number when overdue", () => {
    // 10 days ago, frequency 7 days => 3 days overdue
    expect(daysOverdue("2026-02-05T12:00:00Z", 7, now)).toBe(3);
  });

  it("returns frequency_days when last interaction is null", () => {
    expect(daysOverdue(null, 7, now)).toBe(7);
  });

  it("returns 0 at exactly the frequency boundary", () => {
    // 7 days ago, frequency 7 days => 0 days overdue
    expect(daysOverdue("2026-02-08T12:00:00Z", 7, now)).toBe(0);
  });

  it("handles large overdue values", () => {
    // 100 days ago, frequency 7 days => 93 days overdue
    expect(daysOverdue("2025-11-07T12:00:00Z", 7, now)).toBe(93);
  });
});

// ---------------------------------------------------------------------------
// sortByDriftSeverity
// ---------------------------------------------------------------------------

describe("sortByDriftSeverity", () => {
  const entries: DriftReportEntry[] = [
    {
      relationship_id: "r1",
      name: "Alice",
      category: "professional",
      days_overdue: 5,
      drift_level: "yellow",
      last_interaction: "2026-02-10T12:00:00Z",
      frequency_days: 7,
    },
    {
      relationship_id: "r2",
      name: "Bob",
      category: "vip",
      days_overdue: 30,
      drift_level: "red",
      last_interaction: "2026-01-01T12:00:00Z",
      frequency_days: 7,
    },
    {
      relationship_id: "r3",
      name: "Charlie",
      category: "personal",
      days_overdue: 0,
      drift_level: "green",
      last_interaction: "2026-02-14T12:00:00Z",
      frequency_days: 30,
    },
  ];

  it("sorts entries by days_overdue descending", () => {
    const sorted = sortByDriftSeverity(entries);
    expect(sorted[0].name).toBe("Bob");
    expect(sorted[1].name).toBe("Alice");
    expect(sorted[2].name).toBe("Charlie");
  });

  it("does not mutate the original array", () => {
    const original = [...entries];
    sortByDriftSeverity(entries);
    expect(entries).toEqual(original);
  });

  it("returns empty array for empty input", () => {
    expect(sortByDriftSeverity([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Constants validation
// ---------------------------------------------------------------------------

describe("constants", () => {
  it("CATEGORIES contains all expected values", () => {
    expect(CATEGORIES).toContain("professional");
    expect(CATEGORIES).toContain("personal");
    expect(CATEGORIES).toContain("vip");
    expect(CATEGORIES).toContain("community");
    expect(CATEGORIES).toContain("family");
    expect(CATEGORIES).toHaveLength(5);
  });

  it("FREQUENCY_OPTIONS has valid entries", () => {
    expect(FREQUENCY_OPTIONS.length).toBeGreaterThan(0);
    for (const opt of FREQUENCY_OPTIONS) {
      expect(opt.label).toBeTruthy();
      expect(opt.days).toBeGreaterThan(0);
    }
  });

  it("CATEGORY_COLORS has entries for all categories", () => {
    for (const cat of CATEGORIES) {
      expect(CATEGORY_COLORS[cat]).toBeDefined();
      expect(CATEGORY_COLORS[cat].color).toBeTruthy();
      expect(CATEGORY_COLORS[cat].bg).toBeTruthy();
    }
  });
});
