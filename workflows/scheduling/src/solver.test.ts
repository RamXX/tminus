/**
 * Unit tests for the greedy scheduling solver.
 *
 * Tests the pure function greedySolver which enumerates 30-minute aligned
 * slots in a time window, checks each slot against busy intervals, and
 * scores candidates by time-of-day preference and adjacency to other events.
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
 */

import { describe, it, expect } from "vitest";
import { greedySolver } from "./solver";
import type { SolverInput, ScoredCandidate } from "./solver";

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
