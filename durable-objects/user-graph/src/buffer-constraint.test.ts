/**
 * Unit tests for buffer constraint logic.
 *
 * Tests the pure function expandBuffersToBusy and the static
 * validateBufferConfig validator. No database or DO needed --
 * these operate on plain data structures.
 *
 * Covers:
 * - Buffer slot reduction logic
 * - Travel/prep positioning (before events)
 * - Cooldown positioning (after events)
 * - applies_to filter (all vs external events)
 * - Multiple buffer constraints stacking
 * - Validation of buffer config
 */

import { describe, it, expect } from "vitest";
import { expandBuffersToBusy, UserGraphDO } from "./index";
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
