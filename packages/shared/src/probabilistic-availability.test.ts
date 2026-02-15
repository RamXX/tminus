/**
 * Unit tests for probabilistic availability modeling.
 *
 * Tests probability-weighted availability computation that accounts for
 * event likelihood: confirmed events = 0.95 busy, tentative = 0.50 busy,
 * historically-cancelled recurring = adjusted probability.
 *
 * TDD RED phase: all tests written before implementation.
 */

import { describe, it, expect } from "vitest";
import {
  computeEventBusyProbability,
  computeSlotFreeProbability,
  computeProbabilisticAvailability,
  computeMultiParticipantProbability,
  DEFAULT_CONFIRMED_BUSY_PROBABILITY,
  DEFAULT_TENTATIVE_BUSY_PROBABILITY,
} from "./probabilistic-availability";
import type {
  ProbabilisticEvent,
  ProbabilisticSlot,
  ProbabilisticAvailabilityInput,
  CancellationHistory,
} from "./probabilistic-availability";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeEvent(
  overrides: Partial<ProbabilisticEvent> & { start: string; end: string },
): ProbabilisticEvent {
  return {
    event_id: `evt_${Math.random().toString(36).slice(2, 10)}`,
    start: overrides.start,
    end: overrides.end,
    status: overrides.status ?? "confirmed",
    transparency: overrides.transparency ?? "opaque",
    recurrence_rule: overrides.recurrence_rule,
    origin_event_id: overrides.origin_event_id ?? "google_123",
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("probability constants", () => {
  it("confirmed busy probability is 0.95", () => {
    expect(DEFAULT_CONFIRMED_BUSY_PROBABILITY).toBe(0.95);
  });

  it("tentative busy probability is 0.50", () => {
    expect(DEFAULT_TENTATIVE_BUSY_PROBABILITY).toBe(0.50);
  });
});

// ---------------------------------------------------------------------------
// computeEventBusyProbability
// ---------------------------------------------------------------------------

describe("computeEventBusyProbability", () => {
  it("returns 0.95 for a confirmed opaque event", () => {
    const event = makeEvent({
      start: "2026-03-15T09:00:00Z",
      end: "2026-03-15T10:00:00Z",
      status: "confirmed",
      transparency: "opaque",
    });
    expect(computeEventBusyProbability(event)).toBe(0.95);
  });

  it("returns 0.50 for a tentative event", () => {
    const event = makeEvent({
      start: "2026-03-15T09:00:00Z",
      end: "2026-03-15T10:00:00Z",
      status: "tentative",
      transparency: "opaque",
    });
    expect(computeEventBusyProbability(event)).toBe(0.50);
  });

  it("returns 0.0 for a cancelled event", () => {
    const event = makeEvent({
      start: "2026-03-15T09:00:00Z",
      end: "2026-03-15T10:00:00Z",
      status: "cancelled",
      transparency: "opaque",
    });
    expect(computeEventBusyProbability(event)).toBe(0.0);
  });

  it("returns 0.0 for a transparent event (does not block time)", () => {
    const event = makeEvent({
      start: "2026-03-15T09:00:00Z",
      end: "2026-03-15T10:00:00Z",
      status: "confirmed",
      transparency: "transparent",
    });
    expect(computeEventBusyProbability(event)).toBe(0.0);
  });

  it("adjusts probability for recurring event with cancellation history", () => {
    const event = makeEvent({
      start: "2026-03-15T09:00:00Z",
      end: "2026-03-15T10:00:00Z",
      status: "confirmed",
      transparency: "opaque",
      recurrence_rule: "RRULE:FREQ=WEEKLY;BYDAY=MO",
      origin_event_id: "recurring_123",
    });

    // 10 total occurrences, 3 cancelled -> 30% cancellation rate
    // adjusted probability = 0.95 * (1 - 0.3) = 0.665
    const history: CancellationHistory = {
      recurring_123: { total_occurrences: 10, cancelled_occurrences: 3 },
    };

    const prob = computeEventBusyProbability(event, history);
    expect(prob).toBeCloseTo(0.665, 3);
  });

  it("does not adjust probability for non-recurring event even with history", () => {
    const event = makeEvent({
      start: "2026-03-15T09:00:00Z",
      end: "2026-03-15T10:00:00Z",
      status: "confirmed",
      transparency: "opaque",
      origin_event_id: "single_123",
    });

    const history: CancellationHistory = {
      single_123: { total_occurrences: 10, cancelled_occurrences: 3 },
    };

    // No recurrence_rule => no adjustment
    expect(computeEventBusyProbability(event, history)).toBe(0.95);
  });

  it("handles recurring event with no cancellation history (full probability)", () => {
    const event = makeEvent({
      start: "2026-03-15T09:00:00Z",
      end: "2026-03-15T10:00:00Z",
      status: "confirmed",
      transparency: "opaque",
      recurrence_rule: "RRULE:FREQ=WEEKLY;BYDAY=MO",
      origin_event_id: "recurring_456",
    });

    // No history at all -> no adjustment
    const prob = computeEventBusyProbability(event);
    expect(prob).toBe(0.95);
  });

  it("handles 100% cancellation rate for recurring event", () => {
    const event = makeEvent({
      start: "2026-03-15T09:00:00Z",
      end: "2026-03-15T10:00:00Z",
      status: "confirmed",
      transparency: "opaque",
      recurrence_rule: "RRULE:FREQ=WEEKLY;BYDAY=MO",
      origin_event_id: "always_cancelled",
    });

    const history: CancellationHistory = {
      always_cancelled: { total_occurrences: 10, cancelled_occurrences: 10 },
    };

    const prob = computeEventBusyProbability(event, history);
    expect(prob).toBe(0.0);
  });

  it("handles tentative recurring event with cancellation history", () => {
    const event = makeEvent({
      start: "2026-03-15T09:00:00Z",
      end: "2026-03-15T10:00:00Z",
      status: "tentative",
      transparency: "opaque",
      recurrence_rule: "RRULE:FREQ=WEEKLY;BYDAY=MO",
      origin_event_id: "tent_recur",
    });

    // 20 total, 4 cancelled -> 20% cancellation rate
    // adjusted = 0.50 * (1 - 0.2) = 0.40
    const history: CancellationHistory = {
      tent_recur: { total_occurrences: 20, cancelled_occurrences: 4 },
    };

    const prob = computeEventBusyProbability(event, history);
    expect(prob).toBeCloseTo(0.40, 3);
  });
});

// ---------------------------------------------------------------------------
// computeSlotFreeProbability
// ---------------------------------------------------------------------------

describe("computeSlotFreeProbability", () => {
  it("returns 1.0 for a slot with no overlapping events", () => {
    const prob = computeSlotFreeProbability([]);
    expect(prob).toBe(1.0);
  });

  it("returns 0.05 for a slot with one confirmed event", () => {
    // P(free) = 1 - P(busy) = 1 - 0.95 = 0.05
    const prob = computeSlotFreeProbability([0.95]);
    expect(prob).toBeCloseTo(0.05, 3);
  });

  it("returns 0.50 for a slot with one tentative event", () => {
    const prob = computeSlotFreeProbability([0.50]);
    expect(prob).toBeCloseTo(0.50, 3);
  });

  it("computes independent probabilities for multiple events", () => {
    // Two independent events: P(free) = P(not-busy-1) * P(not-busy-2)
    // = (1 - 0.95) * (1 - 0.50) = 0.05 * 0.50 = 0.025
    const prob = computeSlotFreeProbability([0.95, 0.50]);
    expect(prob).toBeCloseTo(0.025, 3);
  });

  it("returns 0.0 when a slot has a probability of 1.0 busy", () => {
    const prob = computeSlotFreeProbability([1.0]);
    expect(prob).toBe(0.0);
  });

  it("handles three overlapping events", () => {
    // P(free) = (1-0.95) * (1-0.50) * (1-0.30) = 0.05 * 0.50 * 0.70 = 0.0175
    const prob = computeSlotFreeProbability([0.95, 0.50, 0.30]);
    expect(prob).toBeCloseTo(0.0175, 4);
  });
});

// ---------------------------------------------------------------------------
// computeProbabilisticAvailability
// ---------------------------------------------------------------------------

describe("computeProbabilisticAvailability", () => {
  it("returns slots with probability 1.0 when no events", () => {
    const input: ProbabilisticAvailabilityInput = {
      events: [],
      start: "2026-03-15T09:00:00Z",
      end: "2026-03-15T12:00:00Z",
      granularity_minutes: 60,
    };

    const result = computeProbabilisticAvailability(input);
    expect(result.slots).toHaveLength(3); // 9-10, 10-11, 11-12
    for (const slot of result.slots) {
      expect(slot.probability).toBe(1.0);
    }
  });

  it("confirmed event reduces slot probability to 0.05", () => {
    const input: ProbabilisticAvailabilityInput = {
      events: [
        makeEvent({
          start: "2026-03-15T09:00:00Z",
          end: "2026-03-15T10:00:00Z",
          status: "confirmed",
        }),
      ],
      start: "2026-03-15T09:00:00Z",
      end: "2026-03-15T11:00:00Z",
      granularity_minutes: 60,
    };

    const result = computeProbabilisticAvailability(input);
    expect(result.slots).toHaveLength(2);
    expect(result.slots[0].probability).toBeCloseTo(0.05, 3); // 9-10 busy
    expect(result.slots[1].probability).toBe(1.0); // 10-11 free
  });

  it("tentative event reduces slot probability to 0.50", () => {
    const input: ProbabilisticAvailabilityInput = {
      events: [
        makeEvent({
          start: "2026-03-15T09:00:00Z",
          end: "2026-03-15T10:00:00Z",
          status: "tentative",
        }),
      ],
      start: "2026-03-15T09:00:00Z",
      end: "2026-03-15T11:00:00Z",
      granularity_minutes: 60,
    };

    const result = computeProbabilisticAvailability(input);
    expect(result.slots[0].probability).toBeCloseTo(0.50, 3);
    expect(result.slots[1].probability).toBe(1.0);
  });

  it("cancellation history adjusts recurring event probability", () => {
    const input: ProbabilisticAvailabilityInput = {
      events: [
        makeEvent({
          start: "2026-03-15T09:00:00Z",
          end: "2026-03-15T10:00:00Z",
          status: "confirmed",
          recurrence_rule: "RRULE:FREQ=WEEKLY;BYDAY=MO",
          origin_event_id: "weekly_standup",
        }),
      ],
      start: "2026-03-15T09:00:00Z",
      end: "2026-03-15T11:00:00Z",
      granularity_minutes: 60,
      cancellation_history: {
        weekly_standup: { total_occurrences: 20, cancelled_occurrences: 10 },
      },
    };

    const result = computeProbabilisticAvailability(input);
    // 0.95 * (1 - 0.50) = 0.475 busy -> 0.525 free
    expect(result.slots[0].probability).toBeCloseTo(0.525, 3);
  });

  it("supports 30-minute granularity", () => {
    const input: ProbabilisticAvailabilityInput = {
      events: [
        makeEvent({
          start: "2026-03-15T09:00:00Z",
          end: "2026-03-15T10:00:00Z",
          status: "confirmed",
        }),
      ],
      start: "2026-03-15T09:00:00Z",
      end: "2026-03-15T11:00:00Z",
      granularity_minutes: 30,
    };

    const result = computeProbabilisticAvailability(input);
    expect(result.slots).toHaveLength(4); // 4x30min slots
    expect(result.slots[0].probability).toBeCloseTo(0.05, 3); // 9:00-9:30
    expect(result.slots[1].probability).toBeCloseTo(0.05, 3); // 9:30-10:00
    expect(result.slots[2].probability).toBe(1.0); // 10:00-10:30
    expect(result.slots[3].probability).toBe(1.0); // 10:30-11:00
  });

  it("handles overlapping events (probabilities multiply)", () => {
    const input: ProbabilisticAvailabilityInput = {
      events: [
        makeEvent({
          start: "2026-03-15T09:00:00Z",
          end: "2026-03-15T10:00:00Z",
          status: "confirmed",
        }),
        makeEvent({
          start: "2026-03-15T09:00:00Z",
          end: "2026-03-15T10:00:00Z",
          status: "tentative",
        }),
      ],
      start: "2026-03-15T09:00:00Z",
      end: "2026-03-15T10:00:00Z",
      granularity_minutes: 60,
    };

    const result = computeProbabilisticAvailability(input);
    // P(free) = (1-0.95) * (1-0.50) = 0.05 * 0.50 = 0.025
    expect(result.slots[0].probability).toBeCloseTo(0.025, 3);
  });

  it("cancelled events have zero probability (don't affect free probability)", () => {
    const input: ProbabilisticAvailabilityInput = {
      events: [
        makeEvent({
          start: "2026-03-15T09:00:00Z",
          end: "2026-03-15T10:00:00Z",
          status: "cancelled",
        }),
      ],
      start: "2026-03-15T09:00:00Z",
      end: "2026-03-15T10:00:00Z",
      granularity_minutes: 60,
    };

    const result = computeProbabilisticAvailability(input);
    expect(result.slots[0].probability).toBe(1.0);
  });

  it("transparent events have zero probability (don't affect free probability)", () => {
    const input: ProbabilisticAvailabilityInput = {
      events: [
        makeEvent({
          start: "2026-03-15T09:00:00Z",
          end: "2026-03-15T10:00:00Z",
          status: "confirmed",
          transparency: "transparent",
        }),
      ],
      start: "2026-03-15T09:00:00Z",
      end: "2026-03-15T10:00:00Z",
      granularity_minutes: 60,
    };

    const result = computeProbabilisticAvailability(input);
    expect(result.slots[0].probability).toBe(1.0);
  });

  it("returns ISO 8601 timestamps for each slot", () => {
    const input: ProbabilisticAvailabilityInput = {
      events: [],
      start: "2026-03-15T09:00:00Z",
      end: "2026-03-15T10:00:00Z",
      granularity_minutes: 30,
    };

    const result = computeProbabilisticAvailability(input);
    expect(result.slots[0].start).toBe("2026-03-15T09:00:00.000Z");
    expect(result.slots[0].end).toBe("2026-03-15T09:30:00.000Z");
    expect(result.slots[1].start).toBe("2026-03-15T09:30:00.000Z");
    expect(result.slots[1].end).toBe("2026-03-15T10:00:00.000Z");
  });

  it("event partially overlapping a slot still affects it", () => {
    const input: ProbabilisticAvailabilityInput = {
      events: [
        makeEvent({
          start: "2026-03-15T09:45:00Z",
          end: "2026-03-15T10:15:00Z",
          status: "confirmed",
        }),
      ],
      start: "2026-03-15T09:00:00Z",
      end: "2026-03-15T11:00:00Z",
      granularity_minutes: 60,
    };

    const result = computeProbabilisticAvailability(input);
    // 9-10 slot: event partially overlaps (9:45-10:00) -> still affects
    expect(result.slots[0].probability).toBeCloseTo(0.05, 3);
    // 10-11 slot: event partially overlaps (10:00-10:15) -> still affects
    expect(result.slots[1].probability).toBeCloseTo(0.05, 3);
  });

  it("default granularity is 30 minutes", () => {
    const input: ProbabilisticAvailabilityInput = {
      events: [],
      start: "2026-03-15T09:00:00Z",
      end: "2026-03-15T10:00:00Z",
    };

    const result = computeProbabilisticAvailability(input);
    expect(result.slots).toHaveLength(2); // 30-min default
  });
});

// ---------------------------------------------------------------------------
// computeMultiParticipantProbability
// ---------------------------------------------------------------------------

describe("computeMultiParticipantProbability", () => {
  it("returns the product of individual free probabilities", () => {
    // Two participants: P(all free) = P1(free) * P2(free)
    const result = computeMultiParticipantProbability([0.50, 0.80]);
    expect(result).toBeCloseTo(0.40, 3); // 0.50 * 0.80
  });

  it("returns 1.0 when all participants are fully free", () => {
    const result = computeMultiParticipantProbability([1.0, 1.0, 1.0]);
    expect(result).toBe(1.0);
  });

  it("returns 0.0 when any participant has 0 probability", () => {
    const result = computeMultiParticipantProbability([0.50, 0.0, 0.80]);
    expect(result).toBe(0.0);
  });

  it("handles single participant", () => {
    const result = computeMultiParticipantProbability([0.75]);
    expect(result).toBe(0.75);
  });

  it("handles empty participants array", () => {
    const result = computeMultiParticipantProbability([]);
    expect(result).toBe(1.0);
  });

  it("handles three participants with different probabilities", () => {
    // P = 0.80 * 0.50 * 0.90 = 0.36
    const result = computeMultiParticipantProbability([0.80, 0.50, 0.90]);
    expect(result).toBeCloseTo(0.36, 3);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  it("handles event with exactly zero-length (start === end)", () => {
    const input: ProbabilisticAvailabilityInput = {
      events: [
        makeEvent({
          start: "2026-03-15T09:00:00Z",
          end: "2026-03-15T09:00:00Z", // zero-length
          status: "confirmed",
        }),
      ],
      start: "2026-03-15T09:00:00Z",
      end: "2026-03-15T10:00:00Z",
      granularity_minutes: 60,
    };

    const result = computeProbabilisticAvailability(input);
    // Zero-length event should not overlap any slot
    expect(result.slots[0].probability).toBe(1.0);
  });

  it("handles events entirely outside the query range", () => {
    const input: ProbabilisticAvailabilityInput = {
      events: [
        makeEvent({
          start: "2026-03-14T09:00:00Z",
          end: "2026-03-14T10:00:00Z",
          status: "confirmed",
        }),
      ],
      start: "2026-03-15T09:00:00Z",
      end: "2026-03-15T10:00:00Z",
      granularity_minutes: 60,
    };

    const result = computeProbabilisticAvailability(input);
    expect(result.slots[0].probability).toBe(1.0);
  });

  it("handles very small cancellation history (1 occurrence)", () => {
    const event = makeEvent({
      start: "2026-03-15T09:00:00Z",
      end: "2026-03-15T10:00:00Z",
      status: "confirmed",
      recurrence_rule: "RRULE:FREQ=WEEKLY",
      origin_event_id: "new_recur",
    });

    const history: CancellationHistory = {
      new_recur: { total_occurrences: 1, cancelled_occurrences: 0 },
    };

    // With only 1 occurrence and 0 cancellations, no adjustment
    const prob = computeEventBusyProbability(event, history);
    expect(prob).toBe(0.95);
  });

  it("handles history with 0 total occurrences (edge case)", () => {
    const event = makeEvent({
      start: "2026-03-15T09:00:00Z",
      end: "2026-03-15T10:00:00Z",
      status: "confirmed",
      recurrence_rule: "RRULE:FREQ=WEEKLY",
      origin_event_id: "no_history",
    });

    const history: CancellationHistory = {
      no_history: { total_occurrences: 0, cancelled_occurrences: 0 },
    };

    // 0 total should not cause division by zero; treat as no adjustment
    const prob = computeEventBusyProbability(event, history);
    expect(prob).toBe(0.95);
  });
});
