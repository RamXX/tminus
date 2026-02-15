/**
 * Unit tests for milestone tracking pure functions.
 *
 * Tests cover:
 * - Milestone kind validation (birthday, anniversary, graduation, funding, relocation, custom)
 * - Date validation (YYYY-MM-DD format, real dates)
 * - Annual recurrence computation (next occurrence from reference date)
 * - Leap day handling (Feb 29 -> Feb 28 in non-leap years)
 * - Days between computation
 * - Milestone-to-busy interval expansion for scheduler integration
 */

import { describe, it, expect } from "vitest";
import {
  MILESTONE_KINDS,
  isValidMilestoneKind,
  isValidMilestoneDate,
  computeNextOccurrence,
  daysBetween,
  expandMilestonesToBusy,
} from "./milestones";

// ---------------------------------------------------------------------------
// Milestone kind validation
// ---------------------------------------------------------------------------

describe("MILESTONE_KINDS", () => {
  it("contains exactly 6 kinds", () => {
    expect(MILESTONE_KINDS).toHaveLength(6);
    expect(MILESTONE_KINDS).toEqual([
      "birthday",
      "anniversary",
      "graduation",
      "funding",
      "relocation",
      "custom",
    ]);
  });
});

describe("isValidMilestoneKind", () => {
  it.each(["birthday", "anniversary", "graduation", "funding", "relocation", "custom"])(
    "accepts valid kind: %s",
    (kind) => {
      expect(isValidMilestoneKind(kind)).toBe(true);
    },
  );

  it.each(["BIRTHDAY", "Birthday", "wedding", "death", "", "null", "undefined"])(
    "rejects invalid kind: %s",
    (kind) => {
      expect(isValidMilestoneKind(kind)).toBe(false);
    },
  );
});

// ---------------------------------------------------------------------------
// Date validation
// ---------------------------------------------------------------------------

describe("isValidMilestoneDate", () => {
  it("accepts valid dates", () => {
    expect(isValidMilestoneDate("2024-01-15")).toBe(true);
    expect(isValidMilestoneDate("1990-12-31")).toBe(true);
    expect(isValidMilestoneDate("2000-02-29")).toBe(true); // leap year
  });

  it("rejects invalid format", () => {
    expect(isValidMilestoneDate("2024-1-15")).toBe(false); // missing leading zero
    expect(isValidMilestoneDate("01/15/2024")).toBe(false); // wrong format
    expect(isValidMilestoneDate("2024-01")).toBe(false); // missing day
    expect(isValidMilestoneDate("not-a-date")).toBe(false);
    expect(isValidMilestoneDate("")).toBe(false);
  });

  it("rejects impossible dates", () => {
    expect(isValidMilestoneDate("2023-02-29")).toBe(false); // not a leap year
    expect(isValidMilestoneDate("2024-02-30")).toBe(false); // Feb never has 30 days
    expect(isValidMilestoneDate("2024-04-31")).toBe(false); // April has 30 days
    expect(isValidMilestoneDate("2024-13-01")).toBe(false); // month 13
    expect(isValidMilestoneDate("2024-00-01")).toBe(false); // month 0
    expect(isValidMilestoneDate("2024-01-00")).toBe(false); // day 0
  });

  it("rejects years outside acceptable range", () => {
    expect(isValidMilestoneDate("1899-01-01")).toBe(false);
    expect(isValidMilestoneDate("2201-01-01")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Annual recurrence computation
// ---------------------------------------------------------------------------

describe("computeNextOccurrence", () => {
  describe("non-recurring milestones", () => {
    it("returns the original date unchanged", () => {
      expect(computeNextOccurrence("2020-06-15", "2026-02-15", false)).toBe("2020-06-15");
    });
  });

  describe("recurring milestones", () => {
    it("returns this year if milestone date has not passed yet", () => {
      // Ref: Feb 15 2026, milestone: June 15 -> still June 15 2026
      expect(computeNextOccurrence("1990-06-15", "2026-02-15", true)).toBe("2026-06-15");
    });

    it("returns next year if milestone date has already passed this year", () => {
      // Ref: Sep 15 2026, milestone: June 15 -> next is June 15 2027
      expect(computeNextOccurrence("1990-06-15", "2026-09-15", true)).toBe("2027-06-15");
    });

    it("returns this year if milestone is today", () => {
      // The milestone date matches the reference date this year -> not passed yet (on or after)
      expect(computeNextOccurrence("1990-02-15", "2026-02-15", true)).toBe("2026-02-15");
    });

    it("handles Jan 1 milestone correctly at year boundary", () => {
      // Ref: Dec 31 2025, milestone: Jan 1 -> next is Jan 1 2026
      expect(computeNextOccurrence("1985-01-01", "2025-12-31", true)).toBe("2026-01-01");
    });

    it("handles Dec 31 milestone correctly", () => {
      // Ref: Jan 1 2026, milestone: Dec 31 -> still Dec 31 2026
      expect(computeNextOccurrence("1985-12-31", "2026-01-01", true)).toBe("2026-12-31");
    });
  });

  describe("leap day handling", () => {
    it("returns Feb 29 when target year is a leap year", () => {
      // 2028 is a leap year
      expect(computeNextOccurrence("2000-02-29", "2028-01-15", true)).toBe("2028-02-29");
    });

    it("falls back to Feb 28 when target year is NOT a leap year", () => {
      // 2026 is not a leap year, so Feb 29 -> Feb 28
      expect(computeNextOccurrence("2000-02-29", "2026-01-15", true)).toBe("2026-02-28");
    });

    it("advances to next year Feb 28 when this year Feb 28 has passed for Feb 29 milestone", () => {
      // Ref: March 1 2026 (non-leap), milestone Feb 29 -> Feb 28 2026 has passed -> Feb 28 2027
      expect(computeNextOccurrence("2000-02-29", "2026-03-01", true)).toBe("2027-02-28");
    });

    it("returns Feb 29 when advancing to a leap year", () => {
      // Ref: March 1 2027 (non-leap), milestone Feb 29 -> 2027 Feb 28 passed -> 2028 is leap -> Feb 29
      expect(computeNextOccurrence("2000-02-29", "2027-03-01", true)).toBe("2028-02-29");
    });
  });
});

// ---------------------------------------------------------------------------
// Days between
// ---------------------------------------------------------------------------

describe("daysBetween", () => {
  it("returns 0 for same date", () => {
    expect(daysBetween("2026-02-15", "2026-02-15")).toBe(0);
  });

  it("returns positive for future date", () => {
    expect(daysBetween("2026-02-15", "2026-02-22")).toBe(7);
  });

  it("returns negative for past date", () => {
    expect(daysBetween("2026-02-15", "2026-02-08")).toBe(-7);
  });

  it("handles year boundary", () => {
    expect(daysBetween("2025-12-31", "2026-01-01")).toBe(1);
  });

  it("handles large spans", () => {
    expect(daysBetween("2026-01-01", "2026-12-31")).toBe(364);
  });
});

// ---------------------------------------------------------------------------
// Milestone-to-busy expansion
// ---------------------------------------------------------------------------

describe("expandMilestonesToBusy", () => {
  it("returns empty array for empty milestones", () => {
    const result = expandMilestonesToBusy(
      [],
      "2026-02-01T00:00:00Z",
      "2026-02-28T23:59:59Z",
    );
    expect(result).toEqual([]);
  });

  it("includes non-recurring milestone within range", () => {
    const result = expandMilestonesToBusy(
      [{ date: "2026-02-15", recurs_annually: false }],
      "2026-02-01T00:00:00Z",
      "2026-02-28T23:59:59Z",
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      start: "2026-02-15T00:00:00Z",
      end: "2026-02-15T23:59:59Z",
    });
  });

  it("excludes non-recurring milestone outside range", () => {
    const result = expandMilestonesToBusy(
      [{ date: "2025-02-15", recurs_annually: false }],
      "2026-02-01T00:00:00Z",
      "2026-02-28T23:59:59Z",
    );
    expect(result).toHaveLength(0);
  });

  it("expands recurring milestone for current year", () => {
    const result = expandMilestonesToBusy(
      [{ date: "1990-06-15", recurs_annually: true }],
      "2026-01-01T00:00:00Z",
      "2026-12-31T23:59:59Z",
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      start: "2026-06-15T00:00:00Z",
      end: "2026-06-15T23:59:59Z",
    });
  });

  it("expands recurring milestone across multiple years", () => {
    const result = expandMilestonesToBusy(
      [{ date: "1990-06-15", recurs_annually: true }],
      "2025-01-01T00:00:00Z",
      "2027-12-31T23:59:59Z",
    );
    expect(result).toHaveLength(3);
    expect(result[0].start).toBe("2025-06-15T00:00:00Z");
    expect(result[1].start).toBe("2026-06-15T00:00:00Z");
    expect(result[2].start).toBe("2027-06-15T00:00:00Z");
  });

  it("handles numeric recurs_annually (from SQLite INTEGER)", () => {
    const result = expandMilestonesToBusy(
      [{ date: "1990-06-15", recurs_annually: 1 }],
      "2026-01-01T00:00:00Z",
      "2026-12-31T23:59:59Z",
    );
    expect(result).toHaveLength(1);
    expect(result[0].start).toBe("2026-06-15T00:00:00Z");
  });

  it("treats recurs_annually=0 as non-recurring", () => {
    const result = expandMilestonesToBusy(
      [{ date: "2025-06-15", recurs_annually: 0 }],
      "2026-01-01T00:00:00Z",
      "2026-12-31T23:59:59Z",
    );
    expect(result).toHaveLength(0);
  });

  it("handles leap day recurring milestone in non-leap year", () => {
    const result = expandMilestonesToBusy(
      [{ date: "2000-02-29", recurs_annually: true }],
      "2026-01-01T00:00:00Z",
      "2026-12-31T23:59:59Z",
    );
    // 2026 is not a leap year, so Feb 29 -> Feb 28
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      start: "2026-02-28T00:00:00Z",
      end: "2026-02-28T23:59:59Z",
    });
  });

  it("handles multiple milestones", () => {
    const result = expandMilestonesToBusy(
      [
        { date: "1990-03-10", recurs_annually: true },
        { date: "2026-05-20", recurs_annually: false },
        { date: "1985-07-04", recurs_annually: true },
      ],
      "2026-01-01T00:00:00Z",
      "2026-12-31T23:59:59Z",
    );
    expect(result).toHaveLength(3);
    expect(result.map((i) => i.start)).toEqual([
      "2026-03-10T00:00:00Z",
      "2026-05-20T00:00:00Z",
      "2026-07-04T00:00:00Z",
    ]);
  });
});
