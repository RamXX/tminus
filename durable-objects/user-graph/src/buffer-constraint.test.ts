/**
 * Unit tests for constraint pure functions.
 *
 * Tests the pure functions expandBuffersToBusy, expandTripConstraintsToBusy,
 * expandNoMeetingsAfterToBusy, mergeIntervals, and the static validators.
 * No database or DO needed -- these operate on plain data structures.
 *
 * Covers:
 * - Buffer slot reduction logic
 * - Travel/prep positioning (before events)
 * - Cooldown positioning (after events)
 * - applies_to filter (all vs external events)
 * - Multiple buffer constraints stacking
 * - Validation of buffer config
 * - Trip constraint expansion
 * - No-meetings-after constraint expansion
 * - Constraint evaluation order (working hours -> trips -> no_meetings_after -> buffers)
 * - Merged result correctness with all constraint types active simultaneously
 */

import { describe, it, expect } from "vitest";
import {
  expandBuffersToBusy,
  expandTripConstraintsToBusy,
  expandNoMeetingsAfterToBusy,
  expandWorkingHoursToOutsideBusy,
  mergeIntervals,
  computeFreeIntervals,
  UserGraphDO,
} from "./index";
import type { EventRowForBuffer, BufferConfig, BusyInterval } from "./index";

// ---------------------------------------------------------------------------
// Helper to create constraint objects matching the Constraint shape
// ---------------------------------------------------------------------------

function makeBufferConstraint(config: BufferConfig) {
  return { config_json: config as unknown as Record<string, unknown> };
}

function makeEvent(
  startTs: string,
  endTs: string,
  originAccountId = "acc_external_001",
): EventRowForBuffer {
  return {
    start_ts: startTs,
    end_ts: endTs,
    origin_account_id: originAccountId,
  };
}

// ---------------------------------------------------------------------------
// validateBufferConfig
// ---------------------------------------------------------------------------

describe("UserGraphDO.validateBufferConfig (static)", () => {
  it("accepts a valid travel buffer config", () => {
    expect(() =>
      UserGraphDO.validateBufferConfig({
        type: "travel",
        minutes: 15,
        applies_to: "all",
      }),
    ).not.toThrow();
  });

  it("accepts a valid prep buffer config", () => {
    expect(() =>
      UserGraphDO.validateBufferConfig({
        type: "prep",
        minutes: 30,
        applies_to: "external",
      }),
    ).not.toThrow();
  });

  it("accepts a valid cooldown buffer config", () => {
    expect(() =>
      UserGraphDO.validateBufferConfig({
        type: "cooldown",
        minutes: 10,
        applies_to: "all",
      }),
    ).not.toThrow();
  });

  it("rejects invalid type", () => {
    expect(() =>
      UserGraphDO.validateBufferConfig({
        type: "break",
        minutes: 15,
        applies_to: "all",
      }),
    ).toThrow("type must be one of: travel, prep, cooldown");
  });

  it("rejects missing type", () => {
    expect(() =>
      UserGraphDO.validateBufferConfig({
        minutes: 15,
        applies_to: "all",
      }),
    ).toThrow("type must be one of");
  });

  it("rejects non-string type", () => {
    expect(() =>
      UserGraphDO.validateBufferConfig({
        type: 42,
        minutes: 15,
        applies_to: "all",
      }),
    ).toThrow("type must be one of");
  });

  it("rejects zero minutes", () => {
    expect(() =>
      UserGraphDO.validateBufferConfig({
        type: "travel",
        minutes: 0,
        applies_to: "all",
      }),
    ).toThrow("minutes must be a positive integer");
  });

  it("rejects negative minutes", () => {
    expect(() =>
      UserGraphDO.validateBufferConfig({
        type: "travel",
        minutes: -5,
        applies_to: "all",
      }),
    ).toThrow("minutes must be a positive integer");
  });

  it("rejects fractional minutes", () => {
    expect(() =>
      UserGraphDO.validateBufferConfig({
        type: "travel",
        minutes: 7.5,
        applies_to: "all",
      }),
    ).toThrow("minutes must be a positive integer");
  });

  it("rejects missing minutes", () => {
    expect(() =>
      UserGraphDO.validateBufferConfig({
        type: "travel",
        applies_to: "all",
      }),
    ).toThrow("minutes must be a positive integer");
  });

  it("rejects invalid applies_to", () => {
    expect(() =>
      UserGraphDO.validateBufferConfig({
        type: "travel",
        minutes: 15,
        applies_to: "internal",
      }),
    ).toThrow("applies_to must be one of: all, external");
  });

  it("rejects missing applies_to", () => {
    expect(() =>
      UserGraphDO.validateBufferConfig({
        type: "travel",
        minutes: 15,
      }),
    ).toThrow("applies_to must be one of");
  });
});

// ---------------------------------------------------------------------------
// expandBuffersToBusy -- travel buffer (before events)
// ---------------------------------------------------------------------------

describe("expandBuffersToBusy", () => {
  describe("travel buffer (before events)", () => {
    it("adds 15-minute buffer before a single event", () => {
      const constraints = [
        makeBufferConstraint({ type: "travel", minutes: 15, applies_to: "all" }),
      ];
      const events = [
        makeEvent("2026-02-16T10:00:00Z", "2026-02-16T11:00:00Z"),
      ];

      const result = expandBuffersToBusy(constraints, events);

      expect(result).toHaveLength(1);
      // Buffer ends at event start, starts 15 minutes before
      expect(result[0].start).toBe("2026-02-16T09:45:00.000Z");
      expect(result[0].end).toBe("2026-02-16T10:00:00Z");
      expect(result[0].account_ids).toContain("buffer");
    });

    it("adds buffer before multiple events", () => {
      const constraints = [
        makeBufferConstraint({ type: "travel", minutes: 30, applies_to: "all" }),
      ];
      const events = [
        makeEvent("2026-02-16T10:00:00Z", "2026-02-16T11:00:00Z"),
        makeEvent("2026-02-16T14:00:00Z", "2026-02-16T15:00:00Z"),
      ];

      const result = expandBuffersToBusy(constraints, events);

      expect(result).toHaveLength(2);
      expect(result[0].start).toBe("2026-02-16T09:30:00.000Z");
      expect(result[0].end).toBe("2026-02-16T10:00:00Z");
      expect(result[1].start).toBe("2026-02-16T13:30:00.000Z");
      expect(result[1].end).toBe("2026-02-16T14:00:00Z");
    });
  });

  describe("prep buffer (before events)", () => {
    it("adds prep buffer before events (same as travel positioning)", () => {
      const constraints = [
        makeBufferConstraint({ type: "prep", minutes: 10, applies_to: "all" }),
      ];
      const events = [
        makeEvent("2026-02-16T10:00:00Z", "2026-02-16T11:00:00Z"),
      ];

      const result = expandBuffersToBusy(constraints, events);

      expect(result).toHaveLength(1);
      expect(result[0].start).toBe("2026-02-16T09:50:00.000Z");
      expect(result[0].end).toBe("2026-02-16T10:00:00Z");
    });
  });

  describe("cooldown buffer (after events)", () => {
    it("adds 15-minute buffer after a single event", () => {
      const constraints = [
        makeBufferConstraint({ type: "cooldown", minutes: 15, applies_to: "all" }),
      ];
      const events = [
        makeEvent("2026-02-16T10:00:00Z", "2026-02-16T11:00:00Z"),
      ];

      const result = expandBuffersToBusy(constraints, events);

      expect(result).toHaveLength(1);
      // Buffer starts at event end, ends 15 minutes after
      expect(result[0].start).toBe("2026-02-16T11:00:00Z");
      expect(result[0].end).toBe("2026-02-16T11:15:00.000Z");
      expect(result[0].account_ids).toContain("buffer");
    });

    it("adds cooldown after multiple events", () => {
      const constraints = [
        makeBufferConstraint({ type: "cooldown", minutes: 20, applies_to: "all" }),
      ];
      const events = [
        makeEvent("2026-02-16T10:00:00Z", "2026-02-16T11:00:00Z"),
        makeEvent("2026-02-16T14:00:00Z", "2026-02-16T15:00:00Z"),
      ];

      const result = expandBuffersToBusy(constraints, events);

      expect(result).toHaveLength(2);
      expect(result[0].start).toBe("2026-02-16T11:00:00Z");
      expect(result[0].end).toBe("2026-02-16T11:20:00.000Z");
      expect(result[1].start).toBe("2026-02-16T15:00:00Z");
      expect(result[1].end).toBe("2026-02-16T15:20:00.000Z");
    });
  });

  describe("applies_to filter", () => {
    it("applies_to='all' includes internal events", () => {
      const constraints = [
        makeBufferConstraint({ type: "travel", minutes: 15, applies_to: "all" }),
      ];
      const events = [
        makeEvent("2026-02-16T10:00:00Z", "2026-02-16T11:00:00Z", "internal"),
      ];

      const result = expandBuffersToBusy(constraints, events);

      expect(result).toHaveLength(1);
      expect(result[0].start).toBe("2026-02-16T09:45:00.000Z");
      expect(result[0].end).toBe("2026-02-16T10:00:00Z");
    });

    it("applies_to='external' skips internal events", () => {
      const constraints = [
        makeBufferConstraint({ type: "travel", minutes: 15, applies_to: "external" }),
      ];
      const events = [
        makeEvent("2026-02-16T10:00:00Z", "2026-02-16T11:00:00Z", "internal"),
      ];

      const result = expandBuffersToBusy(constraints, events);

      expect(result).toHaveLength(0);
    });

    it("applies_to='external' includes non-internal events", () => {
      const constraints = [
        makeBufferConstraint({ type: "cooldown", minutes: 10, applies_to: "external" }),
      ];
      const events = [
        makeEvent("2026-02-16T10:00:00Z", "2026-02-16T11:00:00Z", "acc_google_001"),
      ];

      const result = expandBuffersToBusy(constraints, events);

      expect(result).toHaveLength(1);
      expect(result[0].start).toBe("2026-02-16T11:00:00Z");
      expect(result[0].end).toBe("2026-02-16T11:10:00.000Z");
    });

    it("applies_to='external' filters mixed internal/external events", () => {
      const constraints = [
        makeBufferConstraint({ type: "travel", minutes: 15, applies_to: "external" }),
      ];
      const events = [
        makeEvent("2026-02-16T09:00:00Z", "2026-02-16T10:00:00Z", "internal"),
        makeEvent("2026-02-16T11:00:00Z", "2026-02-16T12:00:00Z", "acc_google_001"),
        makeEvent("2026-02-16T14:00:00Z", "2026-02-16T15:00:00Z", "internal"),
      ];

      const result = expandBuffersToBusy(constraints, events);

      // Only the external event gets a buffer
      expect(result).toHaveLength(1);
      expect(result[0].start).toBe("2026-02-16T10:45:00.000Z");
      expect(result[0].end).toBe("2026-02-16T11:00:00Z");
    });
  });

  describe("multiple buffer constraints stacking", () => {
    it("stacks travel and cooldown buffers for the same event", () => {
      const constraints = [
        makeBufferConstraint({ type: "travel", minutes: 15, applies_to: "all" }),
        makeBufferConstraint({ type: "cooldown", minutes: 10, applies_to: "all" }),
      ];
      const events = [
        makeEvent("2026-02-16T10:00:00Z", "2026-02-16T11:00:00Z"),
      ];

      const result = expandBuffersToBusy(constraints, events);

      // Should produce 2 intervals: travel before + cooldown after
      expect(result).toHaveLength(2);

      // Travel: 09:45 - 10:00
      const travelBuffer = result.find((r) => r.end === "2026-02-16T10:00:00Z");
      expect(travelBuffer).toBeDefined();
      expect(travelBuffer!.start).toBe("2026-02-16T09:45:00.000Z");

      // Cooldown: 11:00 - 11:10
      const cooldownBuffer = result.find((r) => r.start === "2026-02-16T11:00:00Z");
      expect(cooldownBuffer).toBeDefined();
      expect(cooldownBuffer!.end).toBe("2026-02-16T11:10:00.000Z");
    });

    it("stacks prep and travel buffers (both before, additive effect)", () => {
      const constraints = [
        makeBufferConstraint({ type: "travel", minutes: 15, applies_to: "all" }),
        makeBufferConstraint({ type: "prep", minutes: 10, applies_to: "all" }),
      ];
      const events = [
        makeEvent("2026-02-16T10:00:00Z", "2026-02-16T11:00:00Z"),
      ];

      const result = expandBuffersToBusy(constraints, events);

      // Both produce a before-buffer, so 2 intervals
      // (mergeIntervals in computeAvailability will merge overlapping ones)
      expect(result).toHaveLength(2);

      // Travel: 09:45 - 10:00
      expect(result[0].start).toBe("2026-02-16T09:45:00.000Z");
      expect(result[0].end).toBe("2026-02-16T10:00:00Z");

      // Prep: 09:50 - 10:00
      expect(result[1].start).toBe("2026-02-16T09:50:00.000Z");
      expect(result[1].end).toBe("2026-02-16T10:00:00Z");
    });

    it("stacks with different applies_to filters", () => {
      const constraints = [
        makeBufferConstraint({ type: "travel", minutes: 15, applies_to: "external" }),
        makeBufferConstraint({ type: "cooldown", minutes: 10, applies_to: "all" }),
      ];
      const events = [
        makeEvent("2026-02-16T10:00:00Z", "2026-02-16T11:00:00Z", "internal"),
        makeEvent("2026-02-16T14:00:00Z", "2026-02-16T15:00:00Z", "acc_google_001"),
      ];

      const result = expandBuffersToBusy(constraints, events);

      // Travel (external only): only for google event -> 1 interval before 14:00
      // Cooldown (all): for both events -> 2 intervals after 11:00 and 15:00
      expect(result).toHaveLength(3);

      // Travel before external event
      const travelBuf = result.find(
        (r) => r.end === "2026-02-16T14:00:00Z" && r.start === "2026-02-16T13:45:00.000Z",
      );
      expect(travelBuf).toBeDefined();

      // Cooldown after internal event
      const cd1 = result.find(
        (r) => r.start === "2026-02-16T11:00:00Z",
      );
      expect(cd1).toBeDefined();
      expect(cd1!.end).toBe("2026-02-16T11:10:00.000Z");

      // Cooldown after external event
      const cd2 = result.find(
        (r) => r.start === "2026-02-16T15:00:00Z",
      );
      expect(cd2).toBeDefined();
      expect(cd2!.end).toBe("2026-02-16T15:10:00.000Z");
    });
  });

  describe("edge cases", () => {
    it("returns empty array when no constraints", () => {
      const events = [
        makeEvent("2026-02-16T10:00:00Z", "2026-02-16T11:00:00Z"),
      ];
      const result = expandBuffersToBusy([], events);
      expect(result).toEqual([]);
    });

    it("returns empty array when no events", () => {
      const constraints = [
        makeBufferConstraint({ type: "travel", minutes: 15, applies_to: "all" }),
      ];
      const result = expandBuffersToBusy(constraints, []);
      expect(result).toEqual([]);
    });

    it("returns empty array when both empty", () => {
      const result = expandBuffersToBusy([], []);
      expect(result).toEqual([]);
    });

    it("handles large buffer (60 minutes)", () => {
      const constraints = [
        makeBufferConstraint({ type: "travel", minutes: 60, applies_to: "all" }),
      ];
      const events = [
        makeEvent("2026-02-16T10:00:00Z", "2026-02-16T11:00:00Z"),
      ];

      const result = expandBuffersToBusy(constraints, events);

      expect(result).toHaveLength(1);
      expect(result[0].start).toBe("2026-02-16T09:00:00.000Z");
      expect(result[0].end).toBe("2026-02-16T10:00:00Z");
    });

    it("buffer account_ids are always ['buffer']", () => {
      const constraints = [
        makeBufferConstraint({ type: "travel", minutes: 15, applies_to: "all" }),
        makeBufferConstraint({ type: "cooldown", minutes: 10, applies_to: "all" }),
      ];
      const events = [
        makeEvent("2026-02-16T10:00:00Z", "2026-02-16T11:00:00Z"),
      ];

      const result = expandBuffersToBusy(constraints, events);

      for (const interval of result) {
        expect(interval.account_ids).toEqual(["buffer"]);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// expandTripConstraintsToBusy
// ---------------------------------------------------------------------------

describe("expandTripConstraintsToBusy", () => {
  function makeTripConstraint(activeFrom: string | null, activeTo: string | null) {
    return { active_from: activeFrom, active_to: activeTo };
  }

  it("returns empty array when no constraints", () => {
    const result = expandTripConstraintsToBusy(
      [],
      "2026-02-16T00:00:00Z",
      "2026-02-17T00:00:00Z",
    );
    expect(result).toEqual([]);
  });

  it("skips constraints with null active_from or active_to", () => {
    const constraints = [
      makeTripConstraint(null, null),
      makeTripConstraint("2026-02-16T09:00:00Z", null),
      makeTripConstraint(null, "2026-02-16T17:00:00Z"),
    ];
    const result = expandTripConstraintsToBusy(
      constraints,
      "2026-02-16T00:00:00Z",
      "2026-02-17T00:00:00Z",
    );
    expect(result).toEqual([]);
  });

  it("returns busy interval for trip overlapping query range", () => {
    const constraints = [
      makeTripConstraint("2026-02-16T09:00:00Z", "2026-02-16T17:00:00Z"),
    ];
    const result = expandTripConstraintsToBusy(
      constraints,
      "2026-02-16T00:00:00Z",
      "2026-02-17T00:00:00Z",
    );
    expect(result).toHaveLength(1);
    expect(result[0].start).toBe("2026-02-16T09:00:00.000Z");
    expect(result[0].end).toBe("2026-02-16T17:00:00.000Z");
    expect(result[0].account_ids).toEqual(["trip"]);
  });

  it("clamps trip to query range when trip extends beyond", () => {
    const constraints = [
      makeTripConstraint("2026-02-15T00:00:00Z", "2026-02-18T00:00:00Z"),
    ];
    const result = expandTripConstraintsToBusy(
      constraints,
      "2026-02-16T00:00:00Z",
      "2026-02-17T00:00:00Z",
    );
    expect(result).toHaveLength(1);
    expect(result[0].start).toBe("2026-02-16T00:00:00.000Z");
    expect(result[0].end).toBe("2026-02-17T00:00:00.000Z");
  });

  it("excludes trip completely outside query range", () => {
    const constraints = [
      makeTripConstraint("2026-02-10T00:00:00Z", "2026-02-11T00:00:00Z"),
    ];
    const result = expandTripConstraintsToBusy(
      constraints,
      "2026-02-16T00:00:00Z",
      "2026-02-17T00:00:00Z",
    );
    expect(result).toEqual([]);
  });

  it("handles multiple trips in the same query range", () => {
    const constraints = [
      makeTripConstraint("2026-02-16T09:00:00Z", "2026-02-16T12:00:00Z"),
      makeTripConstraint("2026-02-16T14:00:00Z", "2026-02-16T18:00:00Z"),
    ];
    const result = expandTripConstraintsToBusy(
      constraints,
      "2026-02-16T00:00:00Z",
      "2026-02-17T00:00:00Z",
    );
    expect(result).toHaveLength(2);
    expect(result[0].account_ids).toEqual(["trip"]);
    expect(result[1].account_ids).toEqual(["trip"]);
  });

  it("returns empty when range start >= range end", () => {
    const constraints = [
      makeTripConstraint("2026-02-16T09:00:00Z", "2026-02-16T17:00:00Z"),
    ];
    const result = expandTripConstraintsToBusy(
      constraints,
      "2026-02-17T00:00:00Z",
      "2026-02-16T00:00:00Z",
    );
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// expandNoMeetingsAfterToBusy
// ---------------------------------------------------------------------------

describe("expandNoMeetingsAfterToBusy", () => {
  function makeNoMeetingsConstraint(time: string, timezone: string) {
    return { config_json: { time, timezone } as unknown as Record<string, unknown> };
  }

  it("returns empty array when no constraints", () => {
    const result = expandNoMeetingsAfterToBusy(
      [],
      "2026-02-16T00:00:00Z",
      "2026-02-17T00:00:00Z",
    );
    expect(result).toEqual([]);
  });

  it("generates busy interval after cutoff time for a single day", () => {
    // 18:00 UTC cutoff
    const constraints = [makeNoMeetingsConstraint("18:00", "UTC")];
    const result = expandNoMeetingsAfterToBusy(
      constraints,
      "2026-02-16T00:00:00Z",
      "2026-02-17T00:00:00Z",
    );

    // Should have at least one busy interval starting at 18:00 UTC
    const cutoffInterval = result.find((r) =>
      new Date(r.start).getTime() === new Date("2026-02-16T18:00:00Z").getTime(),
    );
    expect(cutoffInterval).toBeDefined();
    expect(cutoffInterval!.account_ids).toEqual(["no_meetings_after"]);
  });

  it("returns empty when range start >= range end", () => {
    const constraints = [makeNoMeetingsConstraint("18:00", "UTC")];
    const result = expandNoMeetingsAfterToBusy(
      constraints,
      "2026-02-17T00:00:00Z",
      "2026-02-16T00:00:00Z",
    );
    expect(result).toEqual([]);
  });

  it("generates busy intervals for multiple days in range", () => {
    // 18:00 UTC cutoff over a 3-day range
    const constraints = [makeNoMeetingsConstraint("18:00", "UTC")];
    const result = expandNoMeetingsAfterToBusy(
      constraints,
      "2026-02-16T00:00:00Z",
      "2026-02-19T00:00:00Z",
    );

    // Should have busy intervals for at least 3 evenings
    // (Feb 16, 17, 18 from 18:00 to midnight)
    expect(result.length).toBeGreaterThanOrEqual(3);
    for (const interval of result) {
      expect(interval.account_ids).toEqual(["no_meetings_after"]);
    }
  });

  it("account_ids are always ['no_meetings_after']", () => {
    const constraints = [makeNoMeetingsConstraint("17:00", "UTC")];
    const result = expandNoMeetingsAfterToBusy(
      constraints,
      "2026-02-16T00:00:00Z",
      "2026-02-17T00:00:00Z",
    );
    for (const interval of result) {
      expect(interval.account_ids).toEqual(["no_meetings_after"]);
    }
  });
});

// ---------------------------------------------------------------------------
// Constraint evaluation order -- combined test
// ---------------------------------------------------------------------------

describe("constraint evaluation order and merged result", () => {
  it("working hours + trip + buffer all produce correct interval types", () => {
    // Working hours: Mon-Fri 09:00-17:00 UTC
    // A Monday query range: 2026-02-16 is a Monday
    const workingHoursConstraints = [
      {
        config_json: {
          days: [1, 2, 3, 4, 5],
          start_time: "09:00",
          end_time: "17:00",
          timezone: "UTC",
        } as unknown as Record<string, unknown>,
      },
    ];

    const rangeStart = "2026-02-16T00:00:00Z";
    const rangeEnd = "2026-02-16T23:59:59Z";

    // Step 2: Working hours -> outside hours are busy
    const outsideWorkingHours = expandWorkingHoursToOutsideBusy(
      workingHoursConstraints,
      rangeStart,
      rangeEnd,
    );
    // Should produce busy before 09:00 and after 17:00
    expect(outsideWorkingHours.length).toBeGreaterThanOrEqual(2);
    const beforeWork = outsideWorkingHours.find((i) =>
      new Date(i.end).getTime() <= new Date("2026-02-16T09:00:00Z").getTime(),
    );
    expect(beforeWork).toBeDefined();
    expect(beforeWork!.account_ids).toEqual(["working_hours"]);

    // Step 3: Trip blocks (2 hour trip in the afternoon)
    const tripConstraints = [
      { active_from: "2026-02-16T14:00:00Z", active_to: "2026-02-16T16:00:00Z" },
    ];
    const tripBusy = expandTripConstraintsToBusy(tripConstraints, rangeStart, rangeEnd);
    expect(tripBusy).toHaveLength(1);
    expect(tripBusy[0].account_ids).toEqual(["trip"]);

    // Step 5: Buffers (15 min travel before events)
    const events: EventRowForBuffer[] = [
      { start_ts: "2026-02-16T10:00:00Z", end_ts: "2026-02-16T11:00:00Z", origin_account_id: "acc_001" },
    ];
    const bufferConstraints = [
      { config_json: { type: "travel", minutes: 15, applies_to: "all" } as unknown as Record<string, unknown> },
    ];
    const bufferBusy = expandBuffersToBusy(bufferConstraints, events);
    expect(bufferBusy).toHaveLength(1);
    expect(bufferBusy[0].account_ids).toEqual(["buffer"]);

    // Combine all intervals (simulating computeAvailability's merge)
    const rawBusy: BusyInterval[] = [
      // Raw events
      { start: "2026-02-16T10:00:00Z", end: "2026-02-16T11:00:00Z", account_ids: ["acc_001"] },
      ...outsideWorkingHours,
      ...tripBusy,
      ...bufferBusy,
    ];

    const merged = mergeIntervals(rawBusy);
    const free = computeFreeIntervals(merged, rangeStart, rangeEnd);

    // Verify that merged intervals reflect all constraint types:
    // - Before 09:00: busy (working hours)
    // - 09:00-09:45: free
    // - 09:45-11:00: busy (buffer 09:45-10:00 + event 10:00-11:00 merged)
    // - 11:00-14:00: free
    // - 14:00-16:00: busy (trip)
    // - 16:00-17:00: free (still in working hours)
    // - 17:00+: busy (working hours)

    // Free intervals should include:
    // 1. 09:00 to 09:45 (between working hours start and buffer)
    // 2. 11:00 to 14:00 (between event end and trip start)
    // 3. 16:00 to 17:00 (between trip end and working hours end)
    expect(free.length).toBeGreaterThanOrEqual(3);

    // Verify the account_ids in merged intervals indicate all constraint sources
    const allAccountIds = new Set(merged.flatMap((m) => m.account_ids));
    expect(allAccountIds.has("working_hours")).toBe(true);
    expect(allAccountIds.has("buffer")).toBe(true);
    // Trip block from expandTripConstraintsToBusy has account_ids=["trip"]
    // but trip derived events have "internal" -- either or both may be present
    const hasTripSource = allAccountIds.has("trip") || allAccountIds.has("internal");
    expect(hasTripSource).toBe(true);
  });

  it("evaluation order: working hours applied before buffers", () => {
    // This test verifies that working hours restrictions apply first,
    // and buffers are applied to the raw event rows (not affected by
    // working hours masking). This matches the step order:
    // 1. Raw events, 2. Working hours, 3. Trips, 4. No-meetings-after, 5. Buffers

    // Event at 10:00-11:00 on Monday
    const events: EventRowForBuffer[] = [
      { start_ts: "2026-02-16T10:00:00Z", end_ts: "2026-02-16T11:00:00Z", origin_account_id: "acc_001" },
    ];

    // Working hours 09:00-17:00 UTC
    const workingHours = expandWorkingHoursToOutsideBusy(
      [{ config_json: { days: [1, 2, 3, 4, 5], start_time: "09:00", end_time: "17:00", timezone: "UTC" } as unknown as Record<string, unknown> }],
      "2026-02-16T00:00:00Z",
      "2026-02-16T23:59:59Z",
    );

    // Buffer: 15 min travel before events
    const buffers = expandBuffersToBusy(
      [{ config_json: { type: "travel", minutes: 15, applies_to: "all" } as unknown as Record<string, unknown> }],
      events,
    );

    // Buffer should start at 09:45, inside working hours
    expect(buffers).toHaveLength(1);
    expect(buffers[0].start).toBe("2026-02-16T09:45:00.000Z");

    // Combine in correct order
    const rawBusy: BusyInterval[] = [
      { start: "2026-02-16T10:00:00Z", end: "2026-02-16T11:00:00Z", account_ids: ["acc_001"] },
      ...workingHours,
      ...buffers,
    ];

    const merged = mergeIntervals(rawBusy);
    const free = computeFreeIntervals(merged, "2026-02-16T00:00:00Z", "2026-02-16T23:59:59Z");

    // Free gap between working hours start and buffer should be 09:00-09:45
    const morningFree = free.find((f) =>
      new Date(f.start).getTime() >= new Date("2026-02-16T09:00:00Z").getTime() &&
      new Date(f.end).getTime() <= new Date("2026-02-16T10:00:00Z").getTime(),
    );
    expect(morningFree).toBeDefined();
    // The free gap should end at the buffer start (09:45)
    expect(new Date(morningFree!.end).getTime()).toBe(
      new Date("2026-02-16T09:45:00.000Z").getTime(),
    );
  });

  it("no_meetings_after combined with working hours", () => {
    // Working hours: 09:00-17:00 UTC on Monday
    // No meetings after: 16:00 UTC
    // Expected: effectively busy before 09:00, after 16:00

    const workingHours = expandWorkingHoursToOutsideBusy(
      [{ config_json: { days: [1, 2, 3, 4, 5], start_time: "09:00", end_time: "17:00", timezone: "UTC" } as unknown as Record<string, unknown> }],
      "2026-02-16T00:00:00Z",
      "2026-02-17T00:00:00Z",
    );

    const noMeetings = expandNoMeetingsAfterToBusy(
      [{ config_json: { time: "16:00", timezone: "UTC" } as unknown as Record<string, unknown> }],
      "2026-02-16T00:00:00Z",
      "2026-02-17T00:00:00Z",
    );

    const allBusy = [...workingHours, ...noMeetings];
    const merged = mergeIntervals(allBusy);
    const free = computeFreeIntervals(merged, "2026-02-16T00:00:00Z", "2026-02-17T00:00:00Z");

    // Only free period should be 09:00-16:00
    // (working hours give 09:00-17:00 as working, no_meetings_after cuts at 16:00)
    expect(free.length).toBeGreaterThanOrEqual(1);
    const mainFree = free.find((f) =>
      new Date(f.start).getTime() >= new Date("2026-02-16T09:00:00Z").getTime(),
    );
    expect(mainFree).toBeDefined();
    // The free period should end at or before 16:00
    expect(new Date(mainFree!.end).getTime()).toBeLessThanOrEqual(
      new Date("2026-02-16T16:00:00Z").getTime(),
    );
  });
});
