/**
 * Unit tests for cognitive load score computation.
 *
 * Tests the CognitiveLoadEngine which computes meeting density,
 * context switch count, deep work blocks, fragmentation score,
 * and aggregate cognitive load score for a day or week.
 *
 * TDD RED phase: all tests written before implementation.
 */

import { describe, it, expect } from "vitest";
import {
  computeCognitiveLoad,
  computeMeetingDensity,
  computeContextSwitches,
  computeDeepWorkBlocks,
  computeFragmentationScore,
  computeAggregateScore,
} from "./cognitive-load";
import type {
  CognitiveLoadInput,
  CognitiveLoadResult,
  WorkingHoursConstraint,
} from "./cognitive-load";
import type { CanonicalEvent, EventId, AccountId } from "./types";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Create a minimal timed CanonicalEvent for testing. */
function makeEvent(
  overrides: Partial<CanonicalEvent> & { start_dt: string; end_dt: string },
): CanonicalEvent {
  const { start_dt, end_dt, ...rest } = overrides;
  return {
    canonical_event_id: `evt_${Math.random().toString(36).slice(2, 10)}` as EventId,
    origin_account_id: "acc_test" as AccountId,
    origin_event_id: "google_123",
    title: "Meeting",
    start: { dateTime: start_dt },
    end: { dateTime: end_dt },
    all_day: false,
    status: "confirmed",
    visibility: "default",
    transparency: "opaque",
    source: "provider",
    version: 1,
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-01T00:00:00Z",
    ...rest,
  };
}

const DEFAULT_CONSTRAINTS: WorkingHoursConstraint = {
  workingHoursStart: 9,
  workingHoursEnd: 17,
};

// ---------------------------------------------------------------------------
// computeMeetingDensity
// ---------------------------------------------------------------------------

describe("computeMeetingDensity", () => {
  it("returns 0 for an empty day (no meetings)", () => {
    const result = computeMeetingDensity(
      [],
      "2025-06-15",
      DEFAULT_CONSTRAINTS,
    );
    expect(result).toBe(0);
  });

  it("returns 100 for a fully packed day (8h of meetings in 8h working day)", () => {
    // One continuous 8-hour meeting fills the entire working day
    const events = [
      makeEvent({
        start_dt: "2025-06-15T09:00:00Z",
        end_dt: "2025-06-15T17:00:00Z",
      }),
    ];
    const result = computeMeetingDensity(
      events,
      "2025-06-15",
      DEFAULT_CONSTRAINTS,
    );
    expect(result).toBe(100);
  });

  it("returns 50 for half a day of meetings", () => {
    // 4 hours of meetings in an 8-hour working day
    const events = [
      makeEvent({
        start_dt: "2025-06-15T09:00:00Z",
        end_dt: "2025-06-15T13:00:00Z",
      }),
    ];
    const result = computeMeetingDensity(
      events,
      "2025-06-15",
      DEFAULT_CONSTRAINTS,
    );
    expect(result).toBe(50);
  });

  it("handles overlapping meetings without double-counting time", () => {
    // Two overlapping 2-hour meetings should count as 3 hours, not 4
    const events = [
      makeEvent({
        start_dt: "2025-06-15T09:00:00Z",
        end_dt: "2025-06-15T11:00:00Z",
      }),
      makeEvent({
        start_dt: "2025-06-15T10:00:00Z",
        end_dt: "2025-06-15T12:00:00Z",
      }),
    ];
    const result = computeMeetingDensity(
      events,
      "2025-06-15",
      DEFAULT_CONSTRAINTS,
    );
    // 3 hours out of 8 = 37.5%
    expect(result).toBeCloseTo(37.5, 1);
  });

  it("excludes transparent (free) events from density calculation", () => {
    const events = [
      makeEvent({
        start_dt: "2025-06-15T09:00:00Z",
        end_dt: "2025-06-15T13:00:00Z",
        transparency: "transparent",
      }),
    ];
    const result = computeMeetingDensity(
      events,
      "2025-06-15",
      DEFAULT_CONSTRAINTS,
    );
    expect(result).toBe(0);
  });

  it("excludes cancelled events from density calculation", () => {
    const events = [
      makeEvent({
        start_dt: "2025-06-15T09:00:00Z",
        end_dt: "2025-06-15T13:00:00Z",
        status: "cancelled",
      }),
    ];
    const result = computeMeetingDensity(
      events,
      "2025-06-15",
      DEFAULT_CONSTRAINTS,
    );
    expect(result).toBe(0);
  });

  it("clips events that extend outside working hours", () => {
    // Meeting from 7am to 11am, but working hours start at 9am
    // Only 9-11 (2 hours) should count
    const events = [
      makeEvent({
        start_dt: "2025-06-15T07:00:00Z",
        end_dt: "2025-06-15T11:00:00Z",
      }),
    ];
    const result = computeMeetingDensity(
      events,
      "2025-06-15",
      DEFAULT_CONSTRAINTS,
    );
    // 2 hours out of 8 = 25%
    expect(result).toBe(25);
  });

  it("excludes all-day events from density calculation", () => {
    const events = [
      {
        ...makeEvent({
          start_dt: "2025-06-15",
          end_dt: "2025-06-16",
        }),
        all_day: true,
        start: { date: "2025-06-15" },
        end: { date: "2025-06-16" },
      },
    ];
    const result = computeMeetingDensity(
      events,
      "2025-06-15",
      DEFAULT_CONSTRAINTS,
    );
    expect(result).toBe(0);
  });

  it("caps density at 100 even with more-than-full overlap", () => {
    // Three overlapping 8-hour meetings
    const events = [
      makeEvent({
        start_dt: "2025-06-15T09:00:00Z",
        end_dt: "2025-06-15T17:00:00Z",
      }),
      makeEvent({
        start_dt: "2025-06-15T09:00:00Z",
        end_dt: "2025-06-15T17:00:00Z",
      }),
    ];
    const result = computeMeetingDensity(
      events,
      "2025-06-15",
      DEFAULT_CONSTRAINTS,
    );
    // After merging overlaps, still 8 hours out of 8 = 100%
    expect(result).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// computeContextSwitches
// ---------------------------------------------------------------------------

describe("computeContextSwitches", () => {
  it("returns 0 for no meetings", () => {
    expect(computeContextSwitches([])).toBe(0);
  });

  it("returns 0 for a single meeting", () => {
    const events = [
      makeEvent({
        start_dt: "2025-06-15T09:00:00Z",
        end_dt: "2025-06-15T10:00:00Z",
        title: "Team Sync",
      }),
    ];
    expect(computeContextSwitches(events)).toBe(0);
  });

  it("counts transitions between meetings with different titles", () => {
    const events = [
      makeEvent({
        start_dt: "2025-06-15T09:00:00Z",
        end_dt: "2025-06-15T10:00:00Z",
        title: "Team Sync",
      }),
      makeEvent({
        start_dt: "2025-06-15T10:00:00Z",
        end_dt: "2025-06-15T11:00:00Z",
        title: "Client Call",
      }),
      makeEvent({
        start_dt: "2025-06-15T11:00:00Z",
        end_dt: "2025-06-15T12:00:00Z",
        title: "Sprint Planning",
      }),
    ];
    // Team Sync -> Client Call -> Sprint Planning = 2 switches
    expect(computeContextSwitches(events)).toBe(2);
  });

  it("does not count back-to-back meetings with the same title as a switch", () => {
    const events = [
      makeEvent({
        start_dt: "2025-06-15T09:00:00Z",
        end_dt: "2025-06-15T10:00:00Z",
        title: "Team Sync",
      }),
      makeEvent({
        start_dt: "2025-06-15T10:00:00Z",
        end_dt: "2025-06-15T11:00:00Z",
        title: "Team Sync",
      }),
    ];
    expect(computeContextSwitches(events)).toBe(0);
  });

  it("sorts events by start time before counting", () => {
    // Out of order: should still count transitions correctly
    const events = [
      makeEvent({
        start_dt: "2025-06-15T11:00:00Z",
        end_dt: "2025-06-15T12:00:00Z",
        title: "Sprint Planning",
      }),
      makeEvent({
        start_dt: "2025-06-15T09:00:00Z",
        end_dt: "2025-06-15T10:00:00Z",
        title: "Team Sync",
      }),
      makeEvent({
        start_dt: "2025-06-15T10:00:00Z",
        end_dt: "2025-06-15T11:00:00Z",
        title: "Client Call",
      }),
    ];
    expect(computeContextSwitches(events)).toBe(2);
  });

  it("excludes cancelled events from switch counting", () => {
    const events = [
      makeEvent({
        start_dt: "2025-06-15T09:00:00Z",
        end_dt: "2025-06-15T10:00:00Z",
        title: "Team Sync",
      }),
      makeEvent({
        start_dt: "2025-06-15T10:00:00Z",
        end_dt: "2025-06-15T11:00:00Z",
        title: "Cancelled Meeting",
        status: "cancelled",
      }),
      makeEvent({
        start_dt: "2025-06-15T11:00:00Z",
        end_dt: "2025-06-15T12:00:00Z",
        title: "Sprint Planning",
      }),
    ];
    // Cancelled meeting is ignored, so only Team Sync -> Sprint Planning = 1 switch
    expect(computeContextSwitches(events)).toBe(1);
  });

  it("is case-insensitive when comparing titles", () => {
    const events = [
      makeEvent({
        start_dt: "2025-06-15T09:00:00Z",
        end_dt: "2025-06-15T10:00:00Z",
        title: "Team Sync",
      }),
      makeEvent({
        start_dt: "2025-06-15T10:00:00Z",
        end_dt: "2025-06-15T11:00:00Z",
        title: "team sync",
      }),
    ];
    expect(computeContextSwitches(events)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computeDeepWorkBlocks
// ---------------------------------------------------------------------------

describe("computeDeepWorkBlocks", () => {
  it("returns full working day as one deep work block when no meetings", () => {
    const blocks = computeDeepWorkBlocks(
      [],
      "2025-06-15",
      DEFAULT_CONSTRAINTS,
    );
    // 9am to 5pm = 8 hours => one deep work block
    expect(blocks).toBe(1);
  });

  it("returns 0 when the entire day is meetings", () => {
    const events = [
      makeEvent({
        start_dt: "2025-06-15T09:00:00Z",
        end_dt: "2025-06-15T17:00:00Z",
      }),
    ];
    const blocks = computeDeepWorkBlocks(
      events,
      "2025-06-15",
      DEFAULT_CONSTRAINTS,
    );
    expect(blocks).toBe(0);
  });

  it("identifies gaps >= 2 hours as deep work blocks", () => {
    // Meeting 9-10, then free 10-12 (2h gap), then meeting 12-13
    const events = [
      makeEvent({
        start_dt: "2025-06-15T09:00:00Z",
        end_dt: "2025-06-15T10:00:00Z",
      }),
      makeEvent({
        start_dt: "2025-06-15T12:00:00Z",
        end_dt: "2025-06-15T13:00:00Z",
      }),
    ];
    const blocks = computeDeepWorkBlocks(
      events,
      "2025-06-15",
      DEFAULT_CONSTRAINTS,
    );
    // Free: 10-12 (2h, qualifies), 13-17 (4h, qualifies) = 2 blocks
    expect(blocks).toBe(2);
  });

  it("does not count gaps less than 2 hours", () => {
    // Meetings every hour with 30-minute gaps
    const events = [
      makeEvent({
        start_dt: "2025-06-15T09:00:00Z",
        end_dt: "2025-06-15T09:30:00Z",
      }),
      makeEvent({
        start_dt: "2025-06-15T10:00:00Z",
        end_dt: "2025-06-15T10:30:00Z",
      }),
      makeEvent({
        start_dt: "2025-06-15T11:00:00Z",
        end_dt: "2025-06-15T11:30:00Z",
      }),
      makeEvent({
        start_dt: "2025-06-15T12:00:00Z",
        end_dt: "2025-06-15T12:30:00Z",
      }),
      makeEvent({
        start_dt: "2025-06-15T13:00:00Z",
        end_dt: "2025-06-15T13:30:00Z",
      }),
      makeEvent({
        start_dt: "2025-06-15T14:00:00Z",
        end_dt: "2025-06-15T14:30:00Z",
      }),
      makeEvent({
        start_dt: "2025-06-15T15:00:00Z",
        end_dt: "2025-06-15T15:30:00Z",
      }),
      makeEvent({
        start_dt: "2025-06-15T16:00:00Z",
        end_dt: "2025-06-15T16:30:00Z",
      }),
    ];
    const blocks = computeDeepWorkBlocks(
      events,
      "2025-06-15",
      DEFAULT_CONSTRAINTS,
    );
    // All gaps are 30 minutes -- none qualify
    expect(blocks).toBe(0);
  });

  it("handles exactly 2-hour gap as qualifying", () => {
    // Meeting 9-10, free 10-12 (exactly 2h), meeting 12-17
    const events = [
      makeEvent({
        start_dt: "2025-06-15T09:00:00Z",
        end_dt: "2025-06-15T10:00:00Z",
      }),
      makeEvent({
        start_dt: "2025-06-15T12:00:00Z",
        end_dt: "2025-06-15T17:00:00Z",
      }),
    ];
    const blocks = computeDeepWorkBlocks(
      events,
      "2025-06-15",
      DEFAULT_CONSTRAINTS,
    );
    // 10-12 is exactly 2 hours, qualifies
    expect(blocks).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// computeFragmentationScore
// ---------------------------------------------------------------------------

describe("computeFragmentationScore", () => {
  it("returns 0 when no meetings", () => {
    const score = computeFragmentationScore(
      [],
      "2025-06-15",
      DEFAULT_CONSTRAINTS,
    );
    expect(score).toBe(0);
  });

  it("returns 0 when there is only one meeting", () => {
    const events = [
      makeEvent({
        start_dt: "2025-06-15T09:00:00Z",
        end_dt: "2025-06-15T10:00:00Z",
      }),
    ];
    const score = computeFragmentationScore(
      events,
      "2025-06-15",
      DEFAULT_CONSTRAINTS,
    );
    // Only one meeting = no gaps between meetings
    expect(score).toBe(0);
  });

  it("counts small gaps (< 30min) between meetings", () => {
    // 3 meetings with 15-minute gaps between them
    const events = [
      makeEvent({
        start_dt: "2025-06-15T09:00:00Z",
        end_dt: "2025-06-15T10:00:00Z",
      }),
      makeEvent({
        start_dt: "2025-06-15T10:15:00Z",
        end_dt: "2025-06-15T11:00:00Z",
      }),
      makeEvent({
        start_dt: "2025-06-15T11:15:00Z",
        end_dt: "2025-06-15T12:00:00Z",
      }),
    ];
    const score = computeFragmentationScore(
      events,
      "2025-06-15",
      DEFAULT_CONSTRAINTS,
    );
    // 2 gaps of 15 minutes each, both < 30 min
    expect(score).toBe(2);
  });

  it("does not count gaps >= 30 minutes", () => {
    const events = [
      makeEvent({
        start_dt: "2025-06-15T09:00:00Z",
        end_dt: "2025-06-15T10:00:00Z",
      }),
      makeEvent({
        start_dt: "2025-06-15T10:30:00Z",
        end_dt: "2025-06-15T11:30:00Z",
      }),
    ];
    const score = computeFragmentationScore(
      events,
      "2025-06-15",
      DEFAULT_CONSTRAINTS,
    );
    // 30-minute gap exactly is NOT < 30 min
    expect(score).toBe(0);
  });

  it("counts back-to-back meetings (0-minute gap) as fragmentation", () => {
    const events = [
      makeEvent({
        start_dt: "2025-06-15T09:00:00Z",
        end_dt: "2025-06-15T10:00:00Z",
      }),
      makeEvent({
        start_dt: "2025-06-15T10:00:00Z",
        end_dt: "2025-06-15T11:00:00Z",
      }),
    ];
    const score = computeFragmentationScore(
      events,
      "2025-06-15",
      DEFAULT_CONSTRAINTS,
    );
    // 0-minute gap < 30 min = 1 fragmented gap
    expect(score).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// computeAggregateScore
// ---------------------------------------------------------------------------

describe("computeAggregateScore", () => {
  it("returns 0 for empty metrics", () => {
    const score = computeAggregateScore({
      meeting_density: 0,
      context_switches: 0,
      deep_work_blocks: 1, // Full day free
      fragmentation: 0,
    });
    expect(score).toBe(0);
  });

  it("returns 100 for maximum load", () => {
    const score = computeAggregateScore({
      meeting_density: 100,
      context_switches: 20,
      deep_work_blocks: 0,
      fragmentation: 10,
    });
    expect(score).toBe(100);
  });

  it("returns value between 0 and 100 for mixed metrics", () => {
    const score = computeAggregateScore({
      meeting_density: 50,
      context_switches: 5,
      deep_work_blocks: 1,
      fragmentation: 3,
    });
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(100);
  });

  it("score is always clamped between 0 and 100", () => {
    // Even with extreme values
    const score = computeAggregateScore({
      meeting_density: 200, // Beyond 100
      context_switches: 100,
      deep_work_blocks: 0,
      fragmentation: 50,
    });
    expect(score).toBeLessThanOrEqual(100);
    expect(score).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// computeCognitiveLoad (main entry point)
// ---------------------------------------------------------------------------

describe("computeCognitiveLoad", () => {
  it("computes all metrics for an empty day", () => {
    const result = computeCognitiveLoad({
      events: [],
      date: "2025-06-15",
      range: "day",
      constraints: DEFAULT_CONSTRAINTS,
    });

    expect(result.score).toBe(0);
    expect(result.meeting_density).toBe(0);
    expect(result.context_switches).toBe(0);
    expect(result.deep_work_blocks).toBe(1); // Full day free
    expect(result.fragmentation).toBe(0);
  });

  it("computes all metrics for a packed day", () => {
    // Back-to-back different meetings every hour
    const events = [
      makeEvent({
        start_dt: "2025-06-15T09:00:00Z",
        end_dt: "2025-06-15T10:00:00Z",
        title: "Standup",
      }),
      makeEvent({
        start_dt: "2025-06-15T10:00:00Z",
        end_dt: "2025-06-15T11:00:00Z",
        title: "Design Review",
      }),
      makeEvent({
        start_dt: "2025-06-15T11:00:00Z",
        end_dt: "2025-06-15T12:00:00Z",
        title: "Client Call",
      }),
      makeEvent({
        start_dt: "2025-06-15T12:00:00Z",
        end_dt: "2025-06-15T13:00:00Z",
        title: "Lunch Talk",
      }),
      makeEvent({
        start_dt: "2025-06-15T13:00:00Z",
        end_dt: "2025-06-15T14:00:00Z",
        title: "1:1 with Manager",
      }),
      makeEvent({
        start_dt: "2025-06-15T14:00:00Z",
        end_dt: "2025-06-15T15:00:00Z",
        title: "Sprint Planning",
      }),
      makeEvent({
        start_dt: "2025-06-15T15:00:00Z",
        end_dt: "2025-06-15T16:00:00Z",
        title: "Tech Debt",
      }),
      makeEvent({
        start_dt: "2025-06-15T16:00:00Z",
        end_dt: "2025-06-15T17:00:00Z",
        title: "Retro",
      }),
    ];

    const result = computeCognitiveLoad({
      events,
      date: "2025-06-15",
      range: "day",
      constraints: DEFAULT_CONSTRAINTS,
    });

    expect(result.meeting_density).toBe(100);
    expect(result.context_switches).toBe(7); // 8 different meetings = 7 switches
    expect(result.deep_work_blocks).toBe(0); // No free time
    expect(result.fragmentation).toBe(7); // 7 gaps of 0 minutes
    expect(result.score).toBeGreaterThan(80); // Should be very high
  });

  it("computes all metrics for a mixed day", () => {
    // Morning meeting, long gap, afternoon meeting
    const events = [
      makeEvent({
        start_dt: "2025-06-15T09:00:00Z",
        end_dt: "2025-06-15T10:00:00Z",
        title: "Standup",
      }),
      makeEvent({
        start_dt: "2025-06-15T14:00:00Z",
        end_dt: "2025-06-15T15:00:00Z",
        title: "Design Review",
      }),
    ];

    const result = computeCognitiveLoad({
      events,
      date: "2025-06-15",
      range: "day",
      constraints: DEFAULT_CONSTRAINTS,
    });

    expect(result.meeting_density).toBe(25); // 2h out of 8h
    expect(result.context_switches).toBe(1); // Different titles
    expect(result.deep_work_blocks).toBe(2); // 10-14 (4h) and 15-17 (2h)
    expect(result.fragmentation).toBe(0); // 4h gap is not < 30min
    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThan(50);
  });

  it("handles week range by aggregating across multiple days", () => {
    // Events spread across Monday-Friday
    const events = [
      // Monday: 2 meetings (1 switch)
      makeEvent({
        start_dt: "2025-06-16T09:00:00Z",
        end_dt: "2025-06-16T10:00:00Z",
        title: "Monday Standup",
      }),
      makeEvent({
        start_dt: "2025-06-16T10:00:00Z",
        end_dt: "2025-06-16T11:00:00Z",
        title: "Design Review",
      }),
      // Tuesday: 1 meeting (0 switches)
      makeEvent({
        start_dt: "2025-06-17T09:00:00Z",
        end_dt: "2025-06-17T10:00:00Z",
        title: "Tuesday Standup",
      }),
      // Wednesday: fully packed (0 switches, same title)
      makeEvent({
        start_dt: "2025-06-18T09:00:00Z",
        end_dt: "2025-06-18T17:00:00Z",
        title: "Workshop",
      }),
    ];

    const result = computeCognitiveLoad({
      events,
      date: "2025-06-16", // Monday of the week
      range: "week",
      constraints: DEFAULT_CONSTRAINTS,
    });

    // Week metrics are computed across the full 7-day window
    // Total working hours = 7 * 8 = 56 hours
    // Total meeting hours = 1 + 1 + 1 + 8 = 11 hours
    expect(result.meeting_density).toBeCloseTo((11 / 56) * 100, 0);
    // Context switches are summed per day: Mon=1, Tue=0, Wed=0 = 1 total
    expect(result.context_switches).toBe(1);
    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThan(100);
  });

  it("returns result with correct shape", () => {
    const result = computeCognitiveLoad({
      events: [],
      date: "2025-06-15",
      range: "day",
      constraints: DEFAULT_CONSTRAINTS,
    });

    expect(result).toHaveProperty("score");
    expect(result).toHaveProperty("meeting_density");
    expect(result).toHaveProperty("context_switches");
    expect(result).toHaveProperty("deep_work_blocks");
    expect(result).toHaveProperty("fragmentation");
    expect(typeof result.score).toBe("number");
    expect(typeof result.meeting_density).toBe("number");
    expect(typeof result.context_switches).toBe("number");
    expect(typeof result.deep_work_blocks).toBe("number");
    expect(typeof result.fragmentation).toBe("number");
  });

  it("uses default working hours 9-17 when not specified", () => {
    // Meeting from 8-9 should be outside default working hours
    const events = [
      makeEvent({
        start_dt: "2025-06-15T08:00:00Z",
        end_dt: "2025-06-15T09:00:00Z",
      }),
    ];

    const result = computeCognitiveLoad({
      events,
      date: "2025-06-15",
      range: "day",
      // No constraints -- should default to 9-17
    });

    // Meeting is entirely before working hours, so density should be 0
    expect(result.meeting_density).toBe(0);
  });

  it("respects custom working hours", () => {
    // Working hours 6am to 2pm (8 hours)
    const customConstraints: WorkingHoursConstraint = {
      workingHoursStart: 6,
      workingHoursEnd: 14,
    };

    const events = [
      makeEvent({
        start_dt: "2025-06-15T06:00:00Z",
        end_dt: "2025-06-15T10:00:00Z",
      }),
    ];

    const result = computeCognitiveLoad({
      events,
      date: "2025-06-15",
      range: "day",
      constraints: customConstraints,
    });

    // 4 hours out of 8 = 50%
    expect(result.meeting_density).toBe(50);
  });
});
