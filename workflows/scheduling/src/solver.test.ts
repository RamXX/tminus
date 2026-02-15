/**
 * Unit tests for the greedy scheduling solver.
 *
 * Tests the pure function greedySolver which enumerates 30-minute aligned
 * slots in a time window, checks each slot against busy intervals, and
 * scores candidates by time-of-day preference, adjacency to other events,
 * and constraint awareness.
 *
 * Covers:
 * - Produces 3+ candidates for a week-long window with sparse events
 * - Produces 0 candidates when the window is fully busy
 * - Candidates never overlap existing busy intervals
 * - Scoring prefers morning slots over afternoon
 * - Scoring penalizes slots adjacent to existing events
 * - Respects requested meeting duration (30, 60, 90 minutes)
 * - Handles edge case: window shorter than meeting duration
 * - Handles all-day busy intervals
 * - Candidates are sorted by score descending
 *
 * Constraint-aware scoring (TM-946.2):
 * - Working hours constraints boost in-hours slots
 * - Trip constraints hard-exclude overlapping slots
 * - Buffer constraints penalize insufficient buffer gaps
 * - No-meetings-after constraints penalize post-cutoff slots
 * - Multiple constraint types compose correctly
 * - Performance: solver completes in <2s for 1-week window
 */

import { describe, it, expect } from "vitest";
import { greedySolver, CONSTRAINT_SCORES } from "./solver";
import type { SolverInput, ScoredCandidate, SolverConstraint } from "./solver";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInput(overrides: Partial<SolverInput> = {}): SolverInput {
  return {
    windowStart: "2026-03-02T08:00:00Z",
    windowEnd: "2026-03-06T18:00:00Z", // Mon-Fri, 5 days
    durationMinutes: 60,
    busyIntervals: [],
    requiredAccountIds: ["acc_001"],
    ...overrides,
  };
}

/** Helper to verify no candidate overlaps any busy interval. */
function assertNoOverlaps(
  candidates: ScoredCandidate[],
  busyIntervals: { start: string; end: string }[],
): void {
  for (const candidate of candidates) {
    const cStart = new Date(candidate.start).getTime();
    const cEnd = new Date(candidate.end).getTime();
    for (const busy of busyIntervals) {
      const bStart = new Date(busy.start).getTime();
      const bEnd = new Date(busy.end).getTime();
      // Overlap exists if candidate starts before busy ends AND candidate ends after busy starts
      const overlaps = cStart < bEnd && cEnd > bStart;
      expect(overlaps, `Candidate ${candidate.start}-${candidate.end} overlaps busy ${busy.start}-${busy.end}`).toBe(false);
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("greedySolver", () => {
  it("produces 3+ candidates for a 1-hour meeting in a week with no events", () => {
    const input = makeInput();
    const result = greedySolver(input);
    expect(result.length).toBeGreaterThanOrEqual(3);
  });

  it("all candidates have the requested duration", () => {
    const input = makeInput({ durationMinutes: 60 });
    const result = greedySolver(input);
    for (const c of result) {
      const start = new Date(c.start).getTime();
      const end = new Date(c.end).getTime();
      expect(end - start).toBe(60 * 60 * 1000);
    }
  });

  it("candidates never overlap busy intervals", () => {
    const busyIntervals = [
      { start: "2026-03-02T09:00:00Z", end: "2026-03-02T10:00:00Z", account_ids: ["acc_001"] },
      { start: "2026-03-03T14:00:00Z", end: "2026-03-03T16:00:00Z", account_ids: ["acc_001"] },
      { start: "2026-03-04T08:00:00Z", end: "2026-03-04T12:00:00Z", account_ids: ["acc_001"] },
    ];
    const input = makeInput({ busyIntervals });
    const result = greedySolver(input);
    expect(result.length).toBeGreaterThanOrEqual(3);
    assertNoOverlaps(result, busyIntervals);
  });

  it("returns 0 candidates when window is fully busy", () => {
    const busyIntervals = [
      { start: "2026-03-02T00:00:00Z", end: "2026-03-07T00:00:00Z", account_ids: ["acc_001"] },
    ];
    const input = makeInput({ busyIntervals });
    const result = greedySolver(input);
    expect(result.length).toBe(0);
  });

  it("returns 0 candidates when window is shorter than meeting duration", () => {
    const input = makeInput({
      windowStart: "2026-03-02T08:00:00Z",
      windowEnd: "2026-03-02T08:30:00Z",
      durationMinutes: 60,
    });
    const result = greedySolver(input);
    expect(result.length).toBe(0);
  });

  it("candidates are sorted by score descending", () => {
    const input = makeInput();
    const result = greedySolver(input);
    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1].score).toBeGreaterThanOrEqual(result[i].score);
    }
  });

  it("scores morning slots higher than afternoon slots (all else equal)", () => {
    // Window is a single day with no events
    const input = makeInput({
      windowStart: "2026-03-02T08:00:00Z",
      windowEnd: "2026-03-02T18:00:00Z",
      durationMinutes: 60,
    });
    const result = greedySolver(input);
    expect(result.length).toBeGreaterThanOrEqual(2);

    // The top-scored candidate should be in the morning (before 12:00)
    const topCandidate = result[0];
    const topHour = new Date(topCandidate.start).getUTCHours();
    expect(topHour).toBeLessThan(12);
  });

  it("penalizes slots adjacent to existing events", () => {
    // One event at 10:00-11:00. Slot at 11:00 (adjacent) should score lower
    // than a slot at 08:00 (not adjacent, also morning).
    const busyIntervals = [
      { start: "2026-03-02T10:00:00Z", end: "2026-03-02T11:00:00Z", account_ids: ["acc_001"] },
    ];
    const input = makeInput({
      windowStart: "2026-03-02T08:00:00Z",
      windowEnd: "2026-03-02T18:00:00Z",
      durationMinutes: 60,
      busyIntervals,
    });
    const result = greedySolver(input);

    // Find the 08:00 and 11:00 candidates
    const slot08 = result.find(c => c.start === "2026-03-02T08:00:00Z");
    const slot11 = result.find(c => c.start === "2026-03-02T11:00:00Z");
    expect(slot08).toBeDefined();
    expect(slot11).toBeDefined();
    expect(slot08!.score).toBeGreaterThan(slot11!.score);
  });

  it("handles 30-minute meeting duration", () => {
    const input = makeInput({ durationMinutes: 30 });
    const result = greedySolver(input);
    expect(result.length).toBeGreaterThanOrEqual(3);
    for (const c of result) {
      const start = new Date(c.start).getTime();
      const end = new Date(c.end).getTime();
      expect(end - start).toBe(30 * 60 * 1000);
    }
  });

  it("handles 90-minute meeting duration", () => {
    const input = makeInput({ durationMinutes: 90 });
    const result = greedySolver(input);
    expect(result.length).toBeGreaterThanOrEqual(3);
    for (const c of result) {
      const start = new Date(c.start).getTime();
      const end = new Date(c.end).getTime();
      expect(end - start).toBe(90 * 60 * 1000);
    }
  });

  it("limits output to maxCandidates (default 5)", () => {
    const input = makeInput();
    const result = greedySolver(input);
    expect(result.length).toBeLessThanOrEqual(5);
  });

  it("respects custom maxCandidates", () => {
    const input = makeInput();
    const result = greedySolver(input, 10);
    expect(result.length).toBeLessThanOrEqual(10);
    expect(result.length).toBeGreaterThanOrEqual(3);
  });

  it("provides an explanation for each candidate", () => {
    const input = makeInput();
    const result = greedySolver(input);
    for (const c of result) {
      expect(typeof c.explanation).toBe("string");
      expect(c.explanation.length).toBeGreaterThan(0);
    }
  });

  it("handles multiple required accounts (all must be free)", () => {
    // acc_001 is busy 09:00-10:00, acc_002 is busy 08:00-09:00
    // Only 10:00+ should be available for both
    const busyIntervals = [
      { start: "2026-03-02T09:00:00Z", end: "2026-03-02T10:00:00Z", account_ids: ["acc_001"] },
      { start: "2026-03-02T08:00:00Z", end: "2026-03-02T09:00:00Z", account_ids: ["acc_002"] },
    ];
    const input = makeInput({
      windowStart: "2026-03-02T08:00:00Z",
      windowEnd: "2026-03-02T18:00:00Z",
      durationMinutes: 60,
      busyIntervals,
      requiredAccountIds: ["acc_001", "acc_002"],
    });
    const result = greedySolver(input);
    assertNoOverlaps(result, busyIntervals);

    // 08:00-09:00 should NOT appear (acc_002 busy)
    // 09:00-10:00 should NOT appear (acc_001 busy)
    const has08 = result.some(c => c.start === "2026-03-02T08:00:00Z");
    const has09 = result.some(c => c.start === "2026-03-02T09:00:00Z");
    expect(has08).toBe(false);
    expect(has09).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Constraint-aware solver tests (TM-946.2)
// ---------------------------------------------------------------------------

describe("greedySolver with constraints", () => {
  // -----------------------------------------------------------------------
  // Working hours constraints
  // -----------------------------------------------------------------------

  describe("working hours constraints", () => {
    it("scores slots within working hours higher than slots outside", () => {
      // Working hours: Mon-Fri 09:00-17:00 UTC
      // Window: single Monday 06:00-20:00 UTC
      const constraints: SolverConstraint[] = [
        {
          kind: "working_hours",
          config: {
            days: [1, 2, 3, 4, 5], // Mon-Fri
            start_time: "09:00",
            end_time: "17:00",
            timezone: "UTC",
          },
        },
      ];

      const input = makeInput({
        windowStart: "2026-03-02T06:00:00Z", // Monday
        windowEnd: "2026-03-02T20:00:00Z",
        durationMinutes: 60,
        constraints,
      });

      const result = greedySolver(input, 50);
      expect(result.length).toBeGreaterThan(0);

      // Find a slot within working hours (09:00) and outside (06:00)
      const slot09 = result.find(c => c.start === "2026-03-02T09:00:00Z");
      const slot06 = result.find(c => c.start === "2026-03-02T06:00:00Z");

      expect(slot09).toBeDefined();
      expect(slot06).toBeDefined();

      // Within working hours should score higher
      expect(slot09!.score).toBeGreaterThan(slot06!.score);
      expect(slot09!.explanation).toContain("within working hours");
      expect(slot06!.explanation).toContain("outside working hours");
    });

    it("ignores working hours on non-working days", () => {
      // Working hours Mon-Fri, but window is Saturday
      const constraints: SolverConstraint[] = [
        {
          kind: "working_hours",
          config: {
            days: [1, 2, 3, 4, 5], // Mon-Fri
            start_time: "09:00",
            end_time: "17:00",
            timezone: "UTC",
          },
        },
      ];

      const input = makeInput({
        windowStart: "2026-03-07T08:00:00Z", // Saturday
        windowEnd: "2026-03-07T18:00:00Z",
        durationMinutes: 60,
        constraints,
      });

      const result = greedySolver(input, 50);
      expect(result.length).toBeGreaterThan(0);

      // No working hours adjustment on Saturday (day not in days list)
      for (const c of result) {
        expect(c.explanation).not.toContain("working hours");
      }
    });

    it("handles multiple working hours constraints (union)", () => {
      // Two working hour configs: one covers 08:00-12:00, another 14:00-18:00
      const constraints: SolverConstraint[] = [
        {
          kind: "working_hours",
          config: {
            days: [1], // Monday
            start_time: "08:00",
            end_time: "12:00",
            timezone: "UTC",
          },
        },
        {
          kind: "working_hours",
          config: {
            days: [1], // Monday
            start_time: "14:00",
            end_time: "18:00",
            timezone: "UTC",
          },
        },
      ];

      const input = makeInput({
        windowStart: "2026-03-02T06:00:00Z", // Monday
        windowEnd: "2026-03-02T20:00:00Z",
        durationMinutes: 60,
        constraints,
      });

      const result = greedySolver(input, 50);

      // 09:00 should be within working hours (first constraint)
      const slot09 = result.find(c => c.start === "2026-03-02T09:00:00Z");
      expect(slot09).toBeDefined();
      expect(slot09!.explanation).toContain("within working hours");

      // 15:00 should be within working hours (second constraint)
      const slot15 = result.find(c => c.start === "2026-03-02T15:00:00Z");
      expect(slot15).toBeDefined();
      expect(slot15!.explanation).toContain("within working hours");

      // 13:00 should be outside working hours (gap between constraints)
      const slot13 = result.find(c => c.start === "2026-03-02T13:00:00Z");
      expect(slot13).toBeDefined();
      expect(slot13!.explanation).toContain("outside working hours");
    });
  });

  // -----------------------------------------------------------------------
  // Trip constraints
  // -----------------------------------------------------------------------

  describe("trip constraints", () => {
    it("excludes slots that overlap with a trip", () => {
      // Trip: Tue-Wed, Window: Mon-Fri
      const constraints: SolverConstraint[] = [
        {
          kind: "trip",
          activeFrom: "2026-03-03T00:00:00Z", // Tuesday
          activeTo: "2026-03-05T00:00:00Z",   // through Wednesday end
        },
      ];

      const input = makeInput({
        windowStart: "2026-03-02T08:00:00Z", // Monday
        windowEnd: "2026-03-06T18:00:00Z",   // Friday
        durationMinutes: 60,
        constraints,
      });

      const result = greedySolver(input, 50);

      // No candidates should fall within the trip period
      for (const c of result) {
        const cStartMs = new Date(c.start).getTime();
        const cEndMs = new Date(c.end).getTime();
        const tripStartMs = new Date("2026-03-03T00:00:00Z").getTime();
        const tripEndMs = new Date("2026-03-05T00:00:00Z").getTime();
        const overlaps = cStartMs < tripEndMs && cEndMs > tripStartMs;
        expect(overlaps, `Candidate ${c.start} overlaps trip`).toBe(false);
      }
    });

    it("returns 0 candidates when trip covers entire window", () => {
      const constraints: SolverConstraint[] = [
        {
          kind: "trip",
          activeFrom: "2026-03-01T00:00:00Z",
          activeTo: "2026-03-08T00:00:00Z",
        },
      ];

      const input = makeInput({
        windowStart: "2026-03-02T08:00:00Z",
        windowEnd: "2026-03-06T18:00:00Z",
        durationMinutes: 60,
        constraints,
      });

      const result = greedySolver(input, 50);
      expect(result.length).toBe(0);
    });

    it("allows slots outside trip period", () => {
      // Trip only on Wednesday
      const constraints: SolverConstraint[] = [
        {
          kind: "trip",
          activeFrom: "2026-03-04T00:00:00Z", // Wednesday
          activeTo: "2026-03-05T00:00:00Z",   // Wednesday end
        },
      ];

      const input = makeInput({
        windowStart: "2026-03-02T08:00:00Z", // Monday
        windowEnd: "2026-03-06T18:00:00Z",   // Friday
        durationMinutes: 60,
        constraints,
      });

      const result = greedySolver(input, 10);
      expect(result.length).toBeGreaterThan(0);

      // Monday slots should still be available
      const mondaySlots = result.filter(c => c.start.startsWith("2026-03-02T"));
      expect(mondaySlots.length).toBeGreaterThan(0);
    });
  });

  // -----------------------------------------------------------------------
  // Buffer constraints
  // -----------------------------------------------------------------------

  describe("buffer constraints", () => {
    it("penalizes slots with insufficient buffer from events", () => {
      // Busy event at 10:00-11:00. Buffer requires 30min before events.
      // Slot at 11:00 (0 gap after event ends) should have buffer penalty.
      // Slot at 08:00 (2 hour gap from event) should have buffer bonus.
      const busyIntervals = [
        { start: "2026-03-02T10:00:00Z", end: "2026-03-02T11:00:00Z", account_ids: ["acc_001"] },
      ];

      const constraints: SolverConstraint[] = [
        {
          kind: "buffer",
          config: {
            type: "prep",
            minutes: 30,
            applies_to: "all",
          },
        },
      ];

      const input = makeInput({
        windowStart: "2026-03-02T08:00:00Z",
        windowEnd: "2026-03-02T18:00:00Z",
        durationMinutes: 60,
        busyIntervals,
        constraints,
      });

      const result = greedySolver(input, 50);

      // 08:00-09:00 slot: 10:00 event starts 60min after slot ends -> gap=60min >= 30min required before
      // This slot has adequate gap from events (no event ends right before it)
      const slot08 = result.find(c => c.start === "2026-03-02T08:00:00Z");
      expect(slot08).toBeDefined();
      expect(slot08!.explanation).toContain("adequate buffer");

      // 09:00-10:00 slot: event at 10:00 starts 0 min after slot ends
      // BUT the buffer is "prep" (before events), meaning we need 30min before
      // the event at 10:00. The busy end is 11:00, slot 11:00 starts right at
      // event end, gap before slot is 0 from 10-11 busy block.
      // Actually, slot 09:00-10:00 is not blocked (event starts at 10:00, slot
      // ends at 10:00, they don't overlap). But the event at 10:00 ends at 11:00.
      // For slot 11:00-12:00: busy ends at 11:00, gap before = 0 < 30min required.
      const slot11 = result.find(c => c.start === "2026-03-02T11:00:00Z");
      expect(slot11).toBeDefined();
      expect(slot11!.explanation).toContain("insufficient buffer");
    });

    it("gives buffer bonus when adequate gap exists (cooldown)", () => {
      // Busy event 09:00-10:00. Cooldown buffer 15 min after events.
      // Slot at 10:30 has 30min gap after event end -> adequate.
      const busyIntervals = [
        { start: "2026-03-02T09:00:00Z", end: "2026-03-02T10:00:00Z", account_ids: ["acc_001"] },
      ];

      const constraints: SolverConstraint[] = [
        {
          kind: "buffer",
          config: {
            type: "cooldown",
            minutes: 15,
            applies_to: "all",
          },
        },
      ];

      const input = makeInput({
        windowStart: "2026-03-02T08:00:00Z",
        windowEnd: "2026-03-02T18:00:00Z",
        durationMinutes: 60,
        busyIntervals,
        constraints,
      });

      const result = greedySolver(input, 50);

      // Slot at 14:00 should have no busy events nearby -> adequate buffer
      const slot14 = result.find(c => c.start === "2026-03-02T14:00:00Z");
      expect(slot14).toBeDefined();
      expect(slot14!.explanation).toContain("adequate buffer");
    });
  });

  // -----------------------------------------------------------------------
  // No-meetings-after constraints
  // -----------------------------------------------------------------------

  describe("no_meetings_after constraints", () => {
    it("penalizes slots past the daily cutoff", () => {
      // No meetings after 16:00 UTC
      const constraints: SolverConstraint[] = [
        {
          kind: "no_meetings_after",
          config: {
            time: "16:00",
            timezone: "UTC",
          },
        },
      ];

      const input = makeInput({
        windowStart: "2026-03-02T08:00:00Z",
        windowEnd: "2026-03-02T20:00:00Z",
        durationMinutes: 60,
        constraints,
      });

      const result = greedySolver(input, 50);

      // Slot at 10:00 (before cutoff) should NOT have penalty
      const slot10 = result.find(c => c.start === "2026-03-02T10:00:00Z");
      expect(slot10).toBeDefined();
      expect(slot10!.explanation).not.toContain("past daily cutoff");

      // Slot at 17:00 (after cutoff) should have penalty
      const slot17 = result.find(c => c.start === "2026-03-02T17:00:00Z");
      expect(slot17).toBeDefined();
      expect(slot17!.explanation).toContain("past daily cutoff");

      // Pre-cutoff slot should score higher than post-cutoff (all else being similar)
      expect(slot10!.score).toBeGreaterThan(slot17!.score);
    });

    it("uses earliest cutoff when multiple constraints exist", () => {
      // Two constraints: 16:00 and 18:00. Earliest (16:00) should win.
      const constraints: SolverConstraint[] = [
        {
          kind: "no_meetings_after",
          config: { time: "18:00", timezone: "UTC" },
        },
        {
          kind: "no_meetings_after",
          config: { time: "16:00", timezone: "UTC" },
        },
      ];

      const input = makeInput({
        windowStart: "2026-03-02T08:00:00Z",
        windowEnd: "2026-03-02T20:00:00Z",
        durationMinutes: 60,
        constraints,
      });

      const result = greedySolver(input, 50);

      // Slot at 16:00 should already be penalized (>= 16:00 cutoff)
      const slot16 = result.find(c => c.start === "2026-03-02T16:00:00Z");
      expect(slot16).toBeDefined();
      expect(slot16!.explanation).toContain("past daily cutoff");
    });
  });

  // -----------------------------------------------------------------------
  // Multiple constraint composition
  // -----------------------------------------------------------------------

  describe("constraint composition", () => {
    it("composes working hours + buffer + no_meetings_after correctly", () => {
      // Working hours: 09:00-17:00 UTC Mon-Fri
      // Buffer: 15min prep before events
      // No meetings after: 16:00 UTC
      // Busy event at 12:00-13:00
      const constraints: SolverConstraint[] = [
        {
          kind: "working_hours",
          config: {
            days: [1, 2, 3, 4, 5],
            start_time: "09:00",
            end_time: "17:00",
            timezone: "UTC",
          },
        },
        {
          kind: "buffer",
          config: {
            type: "prep",
            minutes: 15,
            applies_to: "all",
          },
        },
        {
          kind: "no_meetings_after",
          config: { time: "16:00", timezone: "UTC" },
        },
      ];

      const busyIntervals = [
        { start: "2026-03-02T12:00:00Z", end: "2026-03-02T13:00:00Z", account_ids: ["acc_001"] },
      ];

      const input = makeInput({
        windowStart: "2026-03-02T06:00:00Z", // Monday
        windowEnd: "2026-03-02T20:00:00Z",
        durationMinutes: 60,
        busyIntervals,
        constraints,
      });

      const result = greedySolver(input, 50);
      expect(result.length).toBeGreaterThan(0);

      // Best slot should be within working hours, before cutoff, with good buffer
      // 09:00 slot: within working hours (+15), adequate buffer (+10), before cutoff
      const slot09 = result.find(c => c.start === "2026-03-02T09:00:00Z");
      expect(slot09).toBeDefined();
      expect(slot09!.explanation).toContain("within working hours");
      expect(slot09!.explanation).toContain("adequate buffer");
      expect(slot09!.explanation).not.toContain("past daily cutoff");

      // 17:00 slot: outside working hours (-10), past cutoff (-20)
      const slot17 = result.find(c => c.start === "2026-03-02T17:00:00Z");
      expect(slot17).toBeDefined();
      expect(slot17!.explanation).toContain("outside working hours");
      expect(slot17!.explanation).toContain("past daily cutoff");

      // 09:00 slot should score much higher than 17:00
      expect(slot09!.score).toBeGreaterThan(slot17!.score);
    });

    it("composes trip + working hours: trip exclusion takes priority", () => {
      // Working hours Mon-Fri 09:00-17:00 UTC
      // Trip on Tuesday
      const constraints: SolverConstraint[] = [
        {
          kind: "working_hours",
          config: {
            days: [1, 2, 3, 4, 5],
            start_time: "09:00",
            end_time: "17:00",
            timezone: "UTC",
          },
        },
        {
          kind: "trip",
          activeFrom: "2026-03-03T00:00:00Z", // Tuesday
          activeTo: "2026-03-04T00:00:00Z",   // Tuesday end
        },
      ];

      const input = makeInput({
        windowStart: "2026-03-02T08:00:00Z",
        windowEnd: "2026-03-04T18:00:00Z",
        durationMinutes: 60,
        constraints,
      });

      const result = greedySolver(input, 50);

      // No Tuesday slots should appear (blocked by trip)
      const tuesdaySlots = result.filter(c => c.start.startsWith("2026-03-03T"));
      expect(tuesdaySlots.length).toBe(0);

      // Monday working hours slots should still score well
      const mondayWorkSlots = result.filter(
        c => c.start.startsWith("2026-03-02T") &&
        new Date(c.start).getUTCHours() >= 9 &&
        new Date(c.start).getUTCHours() < 17
      );
      expect(mondayWorkSlots.length).toBeGreaterThan(0);
    });
  });

  // -----------------------------------------------------------------------
  // Backward compatibility
  // -----------------------------------------------------------------------

  describe("backward compatibility", () => {
    it("works without constraints (same as before)", () => {
      const input = makeInput();
      const result = greedySolver(input);
      expect(result.length).toBeGreaterThanOrEqual(3);

      // No constraint-related scoring in explanation
      for (const c of result) {
        expect(c.explanation).not.toContain("working hours");
        expect(c.explanation).not.toContain("buffer");
        expect(c.explanation).not.toContain("cutoff");
      }
    });

    it("works with empty constraints array", () => {
      const input = makeInput({ constraints: [] });
      const result = greedySolver(input);
      expect(result.length).toBeGreaterThanOrEqual(3);
    });
  });

  // -----------------------------------------------------------------------
  // Performance
  // -----------------------------------------------------------------------

  describe("performance", () => {
    it("completes 1-week window with constraints in <2s", () => {
      // 1-week window with multiple constraints and busy intervals
      const busyIntervals = [];
      // Generate 50 busy intervals spread across the week
      for (let day = 0; day < 7; day++) {
        for (let hour = 9; hour < 17; hour += 2) {
          const dayStr = String(2 + day).padStart(2, "0");
          busyIntervals.push({
            start: `2026-03-${dayStr}T${String(hour).padStart(2, "0")}:00:00Z`,
            end: `2026-03-${dayStr}T${String(hour + 1).padStart(2, "0")}:00:00Z`,
            account_ids: ["acc_001"],
          });
        }
      }

      const constraints: SolverConstraint[] = [
        {
          kind: "working_hours",
          config: {
            days: [1, 2, 3, 4, 5],
            start_time: "08:00",
            end_time: "18:00",
            timezone: "UTC",
          },
        },
        {
          kind: "buffer",
          config: {
            type: "prep",
            minutes: 15,
            applies_to: "all",
          },
        },
        {
          kind: "buffer",
          config: {
            type: "cooldown",
            minutes: 10,
            applies_to: "all",
          },
        },
        {
          kind: "no_meetings_after",
          config: { time: "17:00", timezone: "UTC" },
        },
        {
          kind: "trip",
          activeFrom: "2026-03-05T00:00:00Z",
          activeTo: "2026-03-06T00:00:00Z",
        },
      ];

      const input = makeInput({
        windowStart: "2026-03-02T00:00:00Z",
        windowEnd: "2026-03-09T00:00:00Z", // Full week
        durationMinutes: 60,
        busyIntervals,
        constraints,
      });

      const start = performance.now();
      const result = greedySolver(input, 10);
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(2000); // <2s
      expect(result.length).toBeGreaterThan(0);
      expect(result.length).toBeLessThanOrEqual(10);

      // Verify no candidates fall in trip period
      for (const c of result) {
        const cStart = new Date(c.start).getTime();
        const tripStart = new Date("2026-03-05T00:00:00Z").getTime();
        const tripEnd = new Date("2026-03-06T00:00:00Z").getTime();
        expect(cStart < tripStart || cStart >= tripEnd).toBe(true);
      }
    });
  });

  // -----------------------------------------------------------------------
  // VIP override constraints (TM-5rp.1)
  // -----------------------------------------------------------------------

  describe("VIP override constraints", () => {
    const workingHoursConstraint: SolverConstraint = {
      kind: "working_hours",
      config: {
        days: [1, 2, 3, 4, 5], // Mon-Fri
        start_time: "09:00",
        end_time: "17:00",
        timezone: "UTC",
      },
    };

    const vipConstraint: SolverConstraint = {
      kind: "vip_override",
      config: {
        participant_hash: "abc123hash",
        display_name: "Sarah - Investor",
        priority_weight: 2.0,
        allow_after_hours: true,
        min_notice_hours: 0,
        override_deep_work: false,
      },
    };

    it("VIP with allow_after_hours compensates working hours penalty for after-hours slots", () => {
      const constraints: SolverConstraint[] = [workingHoursConstraint, vipConstraint];

      const input = makeInput({
        windowStart: "2026-03-02T08:00:00Z", // Monday
        windowEnd: "2026-03-02T22:00:00Z",   // Monday evening
        durationMinutes: 60,
        constraints,
        participantHashes: ["abc123hash"],
      });

      const result = greedySolver(input, 50);
      expect(result.length).toBeGreaterThan(0);

      // After-hours slot (18:00) should have VIP override bonus
      const slot18 = result.find(c => c.start === "2026-03-02T18:00:00Z");
      expect(slot18).toBeDefined();
      expect(slot18!.explanation).toContain("VIP override");
      expect(slot18!.explanation).toContain("VIP priority weight");
    });

    it("non-VIP meetings still penalized outside working hours", () => {
      // Same constraints but NO participant hashes (non-VIP meeting)
      const constraints: SolverConstraint[] = [workingHoursConstraint, vipConstraint];

      const input = makeInput({
        windowStart: "2026-03-02T08:00:00Z",
        windowEnd: "2026-03-02T22:00:00Z",
        durationMinutes: 60,
        constraints,
        // No participantHashes -- non-VIP meeting
      });

      const result = greedySolver(input, 50);
      expect(result.length).toBeGreaterThan(0);

      // After-hours slot should still be penalized
      const slot18 = result.find(c => c.start === "2026-03-02T18:00:00Z");
      expect(slot18).toBeDefined();
      expect(slot18!.explanation).toContain("outside working hours");
      expect(slot18!.explanation).not.toContain("VIP override");
    });

    it("VIP priority weight adds score bonus", () => {
      const highPriorityVip: SolverConstraint = {
        kind: "vip_override",
        config: {
          participant_hash: "highprio123",
          display_name: "Board Member",
          priority_weight: 3.0,
          allow_after_hours: true,
          min_notice_hours: 0,
          override_deep_work: false,
        },
      };

      const constraints: SolverConstraint[] = [workingHoursConstraint, highPriorityVip];

      const input = makeInput({
        windowStart: "2026-03-02T08:00:00Z",
        windowEnd: "2026-03-02T22:00:00Z",
        durationMinutes: 60,
        constraints,
        participantHashes: ["highprio123"],
      });

      const result = greedySolver(input, 50);
      const slot18 = result.find(c => c.start === "2026-03-02T18:00:00Z");
      expect(slot18).toBeDefined();
      // Priority weight 3.0 * 10 = +30 points from weight
      expect(slot18!.explanation).toContain("VIP priority weight (+30)");
    });

    it("VIP override only activates for matching participant hashes", () => {
      const constraints: SolverConstraint[] = [workingHoursConstraint, vipConstraint];

      const input = makeInput({
        windowStart: "2026-03-02T08:00:00Z",
        windowEnd: "2026-03-02T22:00:00Z",
        durationMinutes: 60,
        constraints,
        participantHashes: ["different_hash"], // does NOT match abc123hash
      });

      const result = greedySolver(input, 50);
      const slot18 = result.find(c => c.start === "2026-03-02T18:00:00Z");
      expect(slot18).toBeDefined();
      // No VIP override since hash doesn't match
      expect(slot18!.explanation).not.toContain("VIP override");
      expect(slot18!.explanation).toContain("outside working hours");
    });

    it("VIP after-hours slot scores higher than without VIP", () => {
      // Run solver with VIP override
      const constraintsWithVip: SolverConstraint[] = [workingHoursConstraint, vipConstraint];
      const inputWithVip = makeInput({
        windowStart: "2026-03-02T17:00:00Z",
        windowEnd: "2026-03-02T22:00:00Z",
        durationMinutes: 60,
        constraints: constraintsWithVip,
        participantHashes: ["abc123hash"],
      });
      const vipResult = greedySolver(inputWithVip, 5);

      // Run solver without VIP
      const constraintsNoVip: SolverConstraint[] = [workingHoursConstraint];
      const inputNoVip = makeInput({
        windowStart: "2026-03-02T17:00:00Z",
        windowEnd: "2026-03-02T22:00:00Z",
        durationMinutes: 60,
        constraints: constraintsNoVip,
      });
      const noVipResult = greedySolver(inputNoVip, 5);

      // Same slot should score higher with VIP
      const vipSlot18 = vipResult.find(c => c.start === "2026-03-02T18:00:00Z");
      const noVipSlot18 = noVipResult.find(c => c.start === "2026-03-02T18:00:00Z");
      expect(vipSlot18).toBeDefined();
      expect(noVipSlot18).toBeDefined();
      expect(vipSlot18!.score).toBeGreaterThan(noVipSlot18!.score);
    });

    it("backward compatible: works without participantHashes", () => {
      const constraints: SolverConstraint[] = [workingHoursConstraint, vipConstraint];
      const input = makeInput({
        windowStart: "2026-03-02T08:00:00Z",
        windowEnd: "2026-03-02T22:00:00Z",
        durationMinutes: 60,
        constraints,
        // participantHashes intentionally omitted
      });

      const result = greedySolver(input);
      expect(result.length).toBeGreaterThanOrEqual(3);
      // No VIP scoring should appear
      for (const c of result) {
        expect(c.explanation).not.toContain("VIP override");
      }
    });
  });
});
