/**
 * Unit tests for context-switch cost estimation.
 *
 * Tests the context-switch engine which computes:
 *   - Event category classification (title keywords -> work category)
 *   - Transition detection between consecutive events
 *   - Cost matrix lookup for category transitions
 *   - Daily and weekly aggregation
 *   - Clustering suggestions for expensive transitions
 *
 * TDD RED phase: all tests written before implementation.
 */

import { describe, it, expect } from "vitest";
import {
  classifyEventCategory,
  lookupTransitionCost,
  COST_MATRIX,
  computeTransitions,
  computeDailySwitchCost,
  computeWeeklySwitchCost,
  generateClusteringSuggestions,
  DEFAULT_TRANSITION_COST,
  type EventCategory,
  type Transition,
  type ContextSwitchResult,
  type ClusteringSuggestion,
} from "./context-switch";
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

// ---------------------------------------------------------------------------
// classifyEventCategory
// ---------------------------------------------------------------------------

describe("classifyEventCategory", () => {
  it("classifies 'standup' title as engineering", () => {
    const event = makeEvent({
      title: "Daily Standup",
      start_dt: "2025-06-15T09:00:00Z",
      end_dt: "2025-06-15T09:30:00Z",
    });
    expect(classifyEventCategory(event)).toBe("engineering");
  });

  it("classifies 'code review' title as engineering", () => {
    const event = makeEvent({
      title: "Code Review: PR #123",
      start_dt: "2025-06-15T10:00:00Z",
      end_dt: "2025-06-15T11:00:00Z",
    });
    expect(classifyEventCategory(event)).toBe("engineering");
  });

  it("classifies 'sprint' title as engineering", () => {
    const event = makeEvent({
      title: "Sprint Planning",
      start_dt: "2025-06-15T10:00:00Z",
      end_dt: "2025-06-15T11:00:00Z",
    });
    expect(classifyEventCategory(event)).toBe("engineering");
  });

  it("classifies 'pitch' title as sales", () => {
    const event = makeEvent({
      title: "Pitch to Sequoia",
      start_dt: "2025-06-15T14:00:00Z",
      end_dt: "2025-06-15T15:00:00Z",
    });
    expect(classifyEventCategory(event)).toBe("sales");
  });

  it("classifies 'demo' title as sales", () => {
    const event = makeEvent({
      title: "Product Demo for Client",
      start_dt: "2025-06-15T14:00:00Z",
      end_dt: "2025-06-15T15:00:00Z",
    });
    expect(classifyEventCategory(event)).toBe("sales");
  });

  it("classifies 'quarterly' title as admin", () => {
    const event = makeEvent({
      title: "Quarterly Business Review",
      start_dt: "2025-06-15T11:00:00Z",
      end_dt: "2025-06-15T12:00:00Z",
    });
    expect(classifyEventCategory(event)).toBe("admin");
  });

  it("classifies '1:1' title as admin", () => {
    const event = makeEvent({
      title: "1:1 with Manager",
      start_dt: "2025-06-15T13:00:00Z",
      end_dt: "2025-06-15T13:30:00Z",
    });
    expect(classifyEventCategory(event)).toBe("admin");
  });

  it("classifies 'focus time' title as deep_work", () => {
    const event = makeEvent({
      title: "Focus Time",
      start_dt: "2025-06-15T13:00:00Z",
      end_dt: "2025-06-15T15:00:00Z",
    });
    expect(classifyEventCategory(event)).toBe("deep_work");
  });

  it("classifies 'deep work' title as deep_work", () => {
    const event = makeEvent({
      title: "Deep Work Block",
      start_dt: "2025-06-15T13:00:00Z",
      end_dt: "2025-06-15T15:00:00Z",
    });
    expect(classifyEventCategory(event)).toBe("deep_work");
  });

  it("classifies 'interview' title as hiring", () => {
    const event = makeEvent({
      title: "Interview: Sr. Engineer",
      start_dt: "2025-06-15T14:00:00Z",
      end_dt: "2025-06-15T15:00:00Z",
    });
    expect(classifyEventCategory(event)).toBe("hiring");
  });

  it("classifies 'onsite' title as hiring", () => {
    const event = makeEvent({
      title: "Onsite Interview Panel",
      start_dt: "2025-06-15T14:00:00Z",
      end_dt: "2025-06-15T15:00:00Z",
    });
    expect(classifyEventCategory(event)).toBe("hiring");
  });

  it("returns 'other' for unrecognized titles", () => {
    const event = makeEvent({
      title: "Lunch with Sam",
      start_dt: "2025-06-15T12:00:00Z",
      end_dt: "2025-06-15T13:00:00Z",
    });
    expect(classifyEventCategory(event)).toBe("other");
  });

  it("classifies case-insensitively", () => {
    const event = makeEvent({
      title: "STANDUP MEETING",
      start_dt: "2025-06-15T09:00:00Z",
      end_dt: "2025-06-15T09:30:00Z",
    });
    expect(classifyEventCategory(event)).toBe("engineering");
  });

  it("handles events with no title", () => {
    const event = makeEvent({
      title: undefined,
      start_dt: "2025-06-15T09:00:00Z",
      end_dt: "2025-06-15T09:30:00Z",
    });
    expect(classifyEventCategory(event)).toBe("other");
  });

  it("classifies 'design' title as engineering", () => {
    const event = makeEvent({
      title: "Design Sync",
      start_dt: "2025-06-15T10:00:00Z",
      end_dt: "2025-06-15T11:00:00Z",
    });
    expect(classifyEventCategory(event)).toBe("engineering");
  });

  it("classifies 'customer' title as sales", () => {
    const event = makeEvent({
      title: "Customer Success Call",
      start_dt: "2025-06-15T14:00:00Z",
      end_dt: "2025-06-15T15:00:00Z",
    });
    expect(classifyEventCategory(event)).toBe("sales");
  });
});

// ---------------------------------------------------------------------------
// COST_MATRIX
// ---------------------------------------------------------------------------

describe("COST_MATRIX", () => {
  it("has a low cost for same_category transitions", () => {
    expect(COST_MATRIX.same_category).toBe(0.1);
  });

  it("has a high cost for engineering_to_sales transition", () => {
    expect(COST_MATRIX.engineering_to_sales).toBe(0.8);
  });

  it("has a high cost for sales_to_engineering transition", () => {
    expect(COST_MATRIX.sales_to_engineering).toBe(0.9);
  });

  it("has a moderate cost for admin_to_deep_work", () => {
    expect(COST_MATRIX.admin_to_deep_work).toBe(0.5);
  });

  it("exports a DEFAULT_TRANSITION_COST of 0.5", () => {
    expect(DEFAULT_TRANSITION_COST).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// computeTransitions
// ---------------------------------------------------------------------------

describe("computeTransitions", () => {
  it("returns empty array for 0 events", () => {
    const result = computeTransitions([]);
    expect(result).toEqual([]);
  });

  it("returns empty array for 1 event", () => {
    const event = makeEvent({
      title: "Standup",
      start_dt: "2025-06-15T09:00:00Z",
      end_dt: "2025-06-15T09:30:00Z",
    });
    expect(computeTransitions([event])).toEqual([]);
  });

  it("detects transition between two consecutive events of different categories", () => {
    const e1 = makeEvent({
      canonical_event_id: "evt_001" as EventId,
      title: "Sprint Planning",
      start_dt: "2025-06-15T09:00:00Z",
      end_dt: "2025-06-15T10:00:00Z",
    });
    const e2 = makeEvent({
      canonical_event_id: "evt_002" as EventId,
      title: "Client Pitch",
      start_dt: "2025-06-15T10:00:00Z",
      end_dt: "2025-06-15T11:00:00Z",
    });

    const transitions = computeTransitions([e1, e2]);
    expect(transitions).toHaveLength(1);
    expect(transitions[0].from_category).toBe("engineering");
    expect(transitions[0].to_category).toBe("sales");
    expect(transitions[0].event_before_id).toBe("evt_001");
    expect(transitions[0].event_after_id).toBe("evt_002");
    expect(transitions[0].cost).toBe(COST_MATRIX.engineering_to_sales);
  });

  it("assigns same_category cost when categories match", () => {
    const e1 = makeEvent({
      canonical_event_id: "evt_001" as EventId,
      title: "Sprint Planning",
      start_dt: "2025-06-15T09:00:00Z",
      end_dt: "2025-06-15T10:00:00Z",
    });
    const e2 = makeEvent({
      canonical_event_id: "evt_002" as EventId,
      title: "Code Review",
      start_dt: "2025-06-15T10:00:00Z",
      end_dt: "2025-06-15T11:00:00Z",
    });

    const transitions = computeTransitions([e1, e2]);
    expect(transitions).toHaveLength(1);
    expect(transitions[0].from_category).toBe("engineering");
    expect(transitions[0].to_category).toBe("engineering");
    expect(transitions[0].cost).toBe(COST_MATRIX.same_category);
  });

  it("sorts events by start time before computing transitions", () => {
    const e1 = makeEvent({
      canonical_event_id: "evt_late" as EventId,
      title: "Client Pitch",
      start_dt: "2025-06-15T14:00:00Z",
      end_dt: "2025-06-15T15:00:00Z",
    });
    const e2 = makeEvent({
      canonical_event_id: "evt_early" as EventId,
      title: "Sprint Planning",
      start_dt: "2025-06-15T09:00:00Z",
      end_dt: "2025-06-15T10:00:00Z",
    });

    // Pass in reverse order -- should still detect engineering -> sales
    const transitions = computeTransitions([e1, e2]);
    expect(transitions).toHaveLength(1);
    expect(transitions[0].from_category).toBe("engineering");
    expect(transitions[0].to_category).toBe("sales");
    expect(transitions[0].event_before_id).toBe("evt_early");
    expect(transitions[0].event_after_id).toBe("evt_late");
  });

  it("handles multiple transitions in a sequence", () => {
    const e1 = makeEvent({
      canonical_event_id: "evt_001" as EventId,
      title: "Standup",
      start_dt: "2025-06-15T09:00:00Z",
      end_dt: "2025-06-15T09:30:00Z",
    });
    const e2 = makeEvent({
      canonical_event_id: "evt_002" as EventId,
      title: "Client Demo",
      start_dt: "2025-06-15T10:00:00Z",
      end_dt: "2025-06-15T11:00:00Z",
    });
    const e3 = makeEvent({
      canonical_event_id: "evt_003" as EventId,
      title: "Quarterly Review",
      start_dt: "2025-06-15T11:00:00Z",
      end_dt: "2025-06-15T12:00:00Z",
    });

    const transitions = computeTransitions([e1, e2, e3]);
    expect(transitions).toHaveLength(2);
    // engineering -> sales
    expect(transitions[0].from_category).toBe("engineering");
    expect(transitions[0].to_category).toBe("sales");
    // sales -> admin
    expect(transitions[1].from_category).toBe("sales");
    expect(transitions[1].to_category).toBe("admin");
  });

  it("excludes cancelled events", () => {
    const e1 = makeEvent({
      canonical_event_id: "evt_001" as EventId,
      title: "Standup",
      start_dt: "2025-06-15T09:00:00Z",
      end_dt: "2025-06-15T09:30:00Z",
    });
    const e2 = makeEvent({
      canonical_event_id: "evt_002" as EventId,
      title: "Client Demo",
      start_dt: "2025-06-15T10:00:00Z",
      end_dt: "2025-06-15T11:00:00Z",
      status: "cancelled",
    });
    const e3 = makeEvent({
      canonical_event_id: "evt_003" as EventId,
      title: "Quarterly Review",
      start_dt: "2025-06-15T11:00:00Z",
      end_dt: "2025-06-15T12:00:00Z",
    });

    const transitions = computeTransitions([e1, e2, e3]);
    expect(transitions).toHaveLength(1);
    // Skips cancelled event -- engineering -> admin
    expect(transitions[0].from_category).toBe("engineering");
    expect(transitions[0].to_category).toBe("admin");
  });

  it("excludes all-day events", () => {
    const e1 = makeEvent({
      canonical_event_id: "evt_001" as EventId,
      title: "Standup",
      start_dt: "2025-06-15T09:00:00Z",
      end_dt: "2025-06-15T09:30:00Z",
    });
    const allDay: CanonicalEvent = {
      canonical_event_id: "evt_allday" as EventId,
      origin_account_id: "acc_test" as AccountId,
      origin_event_id: "google_allday",
      title: "Company Holiday",
      start: { date: "2025-06-15" },
      end: { date: "2025-06-16" },
      all_day: true,
      status: "confirmed",
      visibility: "default",
      transparency: "opaque",
      source: "provider",
      version: 1,
      created_at: "2025-01-01T00:00:00Z",
      updated_at: "2025-01-01T00:00:00Z",
    };
    const e3 = makeEvent({
      canonical_event_id: "evt_003" as EventId,
      title: "Pitch",
      start_dt: "2025-06-15T14:00:00Z",
      end_dt: "2025-06-15T15:00:00Z",
    });

    const transitions = computeTransitions([e1, allDay, e3]);
    expect(transitions).toHaveLength(1);
    expect(transitions[0].from_category).toBe("engineering");
    expect(transitions[0].to_category).toBe("sales");
  });

  it("excludes transparent events", () => {
    const e1 = makeEvent({
      canonical_event_id: "evt_001" as EventId,
      title: "Standup",
      start_dt: "2025-06-15T09:00:00Z",
      end_dt: "2025-06-15T09:30:00Z",
    });
    const transparent = makeEvent({
      canonical_event_id: "evt_trans" as EventId,
      title: "OOO (transparent)",
      start_dt: "2025-06-15T10:00:00Z",
      end_dt: "2025-06-15T11:00:00Z",
      transparency: "transparent",
    });
    const e3 = makeEvent({
      canonical_event_id: "evt_003" as EventId,
      title: "Pitch",
      start_dt: "2025-06-15T14:00:00Z",
      end_dt: "2025-06-15T15:00:00Z",
    });

    const transitions = computeTransitions([e1, transparent, e3]);
    expect(transitions).toHaveLength(1);
    expect(transitions[0].from_category).toBe("engineering");
    expect(transitions[0].to_category).toBe("sales");
  });

  it("uses explicit matrix cost for hiring_to_other pair", () => {
    const e1 = makeEvent({
      canonical_event_id: "evt_001" as EventId,
      title: "Interview Prep",
      start_dt: "2025-06-15T09:00:00Z",
      end_dt: "2025-06-15T10:00:00Z",
    });
    const e2 = makeEvent({
      canonical_event_id: "evt_002" as EventId,
      title: "Random Meeting",
      start_dt: "2025-06-15T10:00:00Z",
      end_dt: "2025-06-15T11:00:00Z",
    });

    const transitions = computeTransitions([e1, e2]);
    expect(transitions).toHaveLength(1);
    // hiring -> other is in the explicit matrix at 0.4
    expect(transitions[0].from_category).toBe("hiring");
    expect(transitions[0].to_category).toBe("other");
    expect(transitions[0].cost).toBe(0.4);
  });

  it("uses DEFAULT_TRANSITION_COST for truly unknown pair via lookupTransitionCost", () => {
    // Force a pair that is definitively not in the matrix by casting
    // hypothetical categories. lookupTransitionCost falls back to DEFAULT.
    const cost = lookupTransitionCost(
      "nonexistent_a" as EventCategory,
      "nonexistent_b" as EventCategory,
    );
    expect(cost).toBe(DEFAULT_TRANSITION_COST);
  });
});

// ---------------------------------------------------------------------------
// computeDailySwitchCost
// ---------------------------------------------------------------------------

describe("computeDailySwitchCost", () => {
  it("returns 0 for no transitions", () => {
    expect(computeDailySwitchCost([])).toBe(0);
  });

  it("sums costs from multiple transitions", () => {
    const transitions: Transition[] = [
      {
        from_category: "engineering",
        to_category: "sales",
        cost: 0.8,
        event_before_id: "evt_001",
        event_after_id: "evt_002",
      },
      {
        from_category: "sales",
        to_category: "admin",
        cost: 0.6,
        event_before_id: "evt_002",
        event_after_id: "evt_003",
      },
    ];
    expect(computeDailySwitchCost(transitions)).toBeCloseTo(1.4, 5);
  });

  it("returns a single cost when only one transition", () => {
    const transitions: Transition[] = [
      {
        from_category: "engineering",
        to_category: "engineering",
        cost: 0.1,
        event_before_id: "evt_001",
        event_after_id: "evt_002",
      },
    ];
    expect(computeDailySwitchCost(transitions)).toBe(0.1);
  });
});

// ---------------------------------------------------------------------------
// computeWeeklySwitchCost
// ---------------------------------------------------------------------------

describe("computeWeeklySwitchCost", () => {
  it("returns 0 sum and 0 average for empty daily costs", () => {
    const result = computeWeeklySwitchCost([]);
    expect(result.total).toBe(0);
    expect(result.average).toBe(0);
  });

  it("sums daily costs and computes average", () => {
    const dailyCosts = [1.0, 2.0, 3.0, 0.5, 1.5];
    const result = computeWeeklySwitchCost(dailyCosts);
    expect(result.total).toBeCloseTo(8.0, 5);
    expect(result.average).toBeCloseTo(1.6, 5);
  });

  it("handles single day", () => {
    const result = computeWeeklySwitchCost([2.5]);
    expect(result.total).toBe(2.5);
    expect(result.average).toBe(2.5);
  });
});

// ---------------------------------------------------------------------------
// generateClusteringSuggestions
// ---------------------------------------------------------------------------

describe("generateClusteringSuggestions", () => {
  it("returns empty array when no transitions", () => {
    const result = generateClusteringSuggestions([], []);
    expect(result).toEqual([]);
  });

  it("suggests clustering for the most expensive transition type", () => {
    const e1 = makeEvent({
      canonical_event_id: "evt_001" as EventId,
      title: "Sprint Planning",
      start_dt: "2025-06-15T09:00:00Z",
      end_dt: "2025-06-15T10:00:00Z",
    });
    const e2 = makeEvent({
      canonical_event_id: "evt_002" as EventId,
      title: "Client Pitch",
      start_dt: "2025-06-15T10:00:00Z",
      end_dt: "2025-06-15T11:00:00Z",
    });
    const e3 = makeEvent({
      canonical_event_id: "evt_003" as EventId,
      title: "Code Review",
      start_dt: "2025-06-15T11:00:00Z",
      end_dt: "2025-06-15T12:00:00Z",
    });

    const transitions = computeTransitions([e1, e2, e3]);
    const suggestions = generateClusteringSuggestions(transitions, [e1, e2, e3]);

    expect(suggestions.length).toBeGreaterThan(0);
    // Should reference at least one of the expensive category pairs
    const suggestion = suggestions[0];
    expect(suggestion.message).toBeTruthy();
    expect(typeof suggestion.message).toBe("string");
    expect(suggestion.estimated_savings).toBeGreaterThan(0);
  });

  it("suggests clustering engineering meetings together", () => {
    // Pattern: eng -> sales -> eng -> sales (interleaved)
    const events = [
      makeEvent({
        canonical_event_id: "evt_001" as EventId,
        title: "Standup",
        start_dt: "2025-06-15T09:00:00Z",
        end_dt: "2025-06-15T09:30:00Z",
      }),
      makeEvent({
        canonical_event_id: "evt_002" as EventId,
        title: "Client Demo",
        start_dt: "2025-06-15T10:00:00Z",
        end_dt: "2025-06-15T11:00:00Z",
      }),
      makeEvent({
        canonical_event_id: "evt_003" as EventId,
        title: "Code Review",
        start_dt: "2025-06-15T11:00:00Z",
        end_dt: "2025-06-15T12:00:00Z",
      }),
      makeEvent({
        canonical_event_id: "evt_004" as EventId,
        title: "Sales Call",
        start_dt: "2025-06-15T14:00:00Z",
        end_dt: "2025-06-15T15:00:00Z",
      }),
    ];

    const transitions = computeTransitions(events);
    const suggestions = generateClusteringSuggestions(transitions, events);

    expect(suggestions.length).toBeGreaterThan(0);
    // At least one suggestion should mention clustering
    const hasClusterSuggestion = suggestions.some(
      (s) => s.message.toLowerCase().includes("cluster") || s.message.toLowerCase().includes("group"),
    );
    expect(hasClusterSuggestion).toBe(true);
  });

  it("provides actionable suggestions with category names", () => {
    const events = [
      makeEvent({
        canonical_event_id: "evt_001" as EventId,
        title: "Sprint Planning",
        start_dt: "2025-06-15T09:00:00Z",
        end_dt: "2025-06-15T10:00:00Z",
      }),
      makeEvent({
        canonical_event_id: "evt_002" as EventId,
        title: "Pitch to VC",
        start_dt: "2025-06-15T10:00:00Z",
        end_dt: "2025-06-15T11:00:00Z",
      }),
    ];

    const transitions = computeTransitions(events);
    const suggestions = generateClusteringSuggestions(transitions, events);

    if (suggestions.length > 0) {
      // Suggestion should reference specific category names
      const msg = suggestions[0].message.toLowerCase();
      const referencesCategory =
        msg.includes("engineering") ||
        msg.includes("sales") ||
        msg.includes("admin");
      expect(referencesCategory).toBe(true);
    }
  });

  it("returns suggestions with estimated_savings property", () => {
    const events = [
      makeEvent({
        canonical_event_id: "evt_001" as EventId,
        title: "Sprint Planning",
        start_dt: "2025-06-15T09:00:00Z",
        end_dt: "2025-06-15T10:00:00Z",
      }),
      makeEvent({
        canonical_event_id: "evt_002" as EventId,
        title: "Pitch to VC",
        start_dt: "2025-06-15T10:00:00Z",
        end_dt: "2025-06-15T11:00:00Z",
      }),
      makeEvent({
        canonical_event_id: "evt_003" as EventId,
        title: "Code Review",
        start_dt: "2025-06-15T11:00:00Z",
        end_dt: "2025-06-15T12:00:00Z",
      }),
    ];

    const transitions = computeTransitions(events);
    const suggestions = generateClusteringSuggestions(transitions, events);

    for (const s of suggestions) {
      expect(typeof s.estimated_savings).toBe("number");
      expect(s.estimated_savings).toBeGreaterThanOrEqual(0);
    }
  });
});

// ---------------------------------------------------------------------------
// End-to-end: full pipeline
// ---------------------------------------------------------------------------

describe("context-switch full pipeline", () => {
  it("processes a realistic day of meetings end-to-end", () => {
    const events = [
      makeEvent({
        canonical_event_id: "evt_001" as EventId,
        title: "Morning Standup",
        start_dt: "2025-06-15T09:00:00Z",
        end_dt: "2025-06-15T09:30:00Z",
      }),
      makeEvent({
        canonical_event_id: "evt_002" as EventId,
        title: "Code Review",
        start_dt: "2025-06-15T09:30:00Z",
        end_dt: "2025-06-15T10:30:00Z",
      }),
      makeEvent({
        canonical_event_id: "evt_003" as EventId,
        title: "Client Pitch",
        start_dt: "2025-06-15T11:00:00Z",
        end_dt: "2025-06-15T12:00:00Z",
      }),
      makeEvent({
        canonical_event_id: "evt_004" as EventId,
        title: "Quarterly Review",
        start_dt: "2025-06-15T14:00:00Z",
        end_dt: "2025-06-15T15:00:00Z",
      }),
      makeEvent({
        canonical_event_id: "evt_005" as EventId,
        title: "Focus Time",
        start_dt: "2025-06-15T15:00:00Z",
        end_dt: "2025-06-15T17:00:00Z",
      }),
    ];

    // Step 1: compute transitions
    const transitions = computeTransitions(events);
    expect(transitions).toHaveLength(4);

    // engineering -> engineering (standup -> code review)
    expect(transitions[0].from_category).toBe("engineering");
    expect(transitions[0].to_category).toBe("engineering");
    expect(transitions[0].cost).toBe(COST_MATRIX.same_category);

    // engineering -> sales (code review -> pitch)
    expect(transitions[1].from_category).toBe("engineering");
    expect(transitions[1].to_category).toBe("sales");

    // sales -> admin (pitch -> quarterly review)
    expect(transitions[2].from_category).toBe("sales");
    expect(transitions[2].to_category).toBe("admin");

    // admin -> deep_work (quarterly -> focus time)
    expect(transitions[3].from_category).toBe("admin");
    expect(transitions[3].to_category).toBe("deep_work");
    expect(transitions[3].cost).toBe(COST_MATRIX.admin_to_deep_work);

    // Step 2: daily cost
    const dailyCost = computeDailySwitchCost(transitions);
    expect(dailyCost).toBeGreaterThan(0);

    // Step 3: weekly aggregation (simulate 5 identical days)
    const weeklyResult = computeWeeklySwitchCost([
      dailyCost, dailyCost, dailyCost, dailyCost, dailyCost,
    ]);
    expect(weeklyResult.total).toBeCloseTo(dailyCost * 5, 5);
    expect(weeklyResult.average).toBeCloseTo(dailyCost, 5);

    // Step 4: suggestions
    const suggestions = generateClusteringSuggestions(transitions, events);
    expect(suggestions.length).toBeGreaterThanOrEqual(0);
  });
});
