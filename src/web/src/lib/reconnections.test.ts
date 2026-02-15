/**
 * Unit tests for reconnection dashboard helpers.
 *
 * Tests the pure functions in lib/reconnections.ts: formatDriftDays,
 * formatSuggestedDuration, formatMilestoneDate, milestoneKindLabel,
 * driftSeverityFromRatio, suggestedActionForCategory, toReconnectionCard,
 * sortByUrgency, groupByCity, filterUpcomingMilestones, groupMilestonesByMonth,
 * formatMonthLabel, buildScheduleParams, buildScheduleUrl.
 */
import { describe, it, expect } from "vitest";
import {
  formatDriftDays,
  formatSuggestedDuration,
  formatMilestoneDate,
  milestoneKindLabel,
  driftSeverityFromRatio,
  suggestedActionForCategory,
  toReconnectionCard,
  sortByUrgency,
  groupByCity,
  filterUpcomingMilestones,
  groupMilestonesByMonth,
  formatMonthLabel,
  buildScheduleParams,
  buildScheduleUrl,
  DRIFT_RATIO_THRESHOLDS,
  MILESTONE_KIND_LABELS,
  CATEGORY_ACTIONS,
  type ReconnectionSuggestionFull,
  type UpcomingMilestone,
  type ReconnectionCardData,
  type TripReconnectionGroup,
} from "./reconnections";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeSuggestion(overrides: Partial<ReconnectionSuggestionFull> = {}): ReconnectionSuggestionFull {
  return {
    relationship_id: "rel_01",
    participant_hash: "abc123",
    display_name: "Alice",
    category: "FRIEND",
    closeness_weight: 0.8,
    last_interaction_ts: "2026-01-15T12:00:00Z",
    interaction_frequency_target: 14,
    days_since_interaction: 30,
    days_overdue: 16,
    drift_ratio: 2.14,
    urgency: 12.8,
    suggested_duration_minutes: 60,
    suggested_time_window: { earliest: "2026-02-20", latest: "2026-02-25" },
    city: "Berlin",
    ...overrides,
  };
}

function makeMilestone(overrides: Partial<UpcomingMilestone> = {}): UpcomingMilestone {
  return {
    milestone_id: "ms_01",
    participant_hash: "abc123",
    kind: "birthday",
    date: "1990-03-15",
    recurs_annually: true,
    note: "30th birthday celebration",
    next_occurrence: "2026-03-15",
    days_until: 28,
    display_name: "Alice",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// formatDriftDays
// ---------------------------------------------------------------------------

describe("formatDriftDays", () => {
  it("returns 'On track' for zero days overdue", () => {
    expect(formatDriftDays(0)).toBe("On track");
  });

  it("returns 'On track' for negative days (ahead of schedule)", () => {
    expect(formatDriftDays(-5)).toBe("On track");
  });

  it("returns singular form for 1 day", () => {
    expect(formatDriftDays(1)).toBe("1 day overdue");
  });

  it("returns plural form for multiple days", () => {
    expect(formatDriftDays(16)).toBe("16 days overdue");
  });

  it("handles large values", () => {
    expect(formatDriftDays(365)).toBe("365 days overdue");
  });
});

// ---------------------------------------------------------------------------
// formatSuggestedDuration
// ---------------------------------------------------------------------------

describe("formatSuggestedDuration", () => {
  it("returns '0 min' for zero minutes", () => {
    expect(formatSuggestedDuration(0)).toBe("0 min");
  });

  it("returns '0 min' for negative minutes", () => {
    expect(formatSuggestedDuration(-10)).toBe("0 min");
  });

  it("returns minutes for durations under 60", () => {
    expect(formatSuggestedDuration(30)).toBe("30 min");
    expect(formatSuggestedDuration(45)).toBe("45 min");
  });

  it("returns hours for exact hour durations", () => {
    expect(formatSuggestedDuration(60)).toBe("1h");
    expect(formatSuggestedDuration(120)).toBe("2h");
  });

  it("returns hours and minutes for mixed durations", () => {
    expect(formatSuggestedDuration(90)).toBe("1h 30min");
    expect(formatSuggestedDuration(150)).toBe("2h 30min");
  });
});

// ---------------------------------------------------------------------------
// formatMilestoneDate
// ---------------------------------------------------------------------------

describe("formatMilestoneDate", () => {
  it("formats a date without year by default", () => {
    const result = formatMilestoneDate("2026-03-15");
    expect(result).toBe("Mar 15");
  });

  it("formats a date with year when showYear is true", () => {
    const result = formatMilestoneDate("2026-03-15", true);
    expect(result).toBe("Mar 15, 2026");
  });

  it("returns original string for invalid dates", () => {
    expect(formatMilestoneDate("invalid")).toBe("invalid");
  });
});

// ---------------------------------------------------------------------------
// milestoneKindLabel
// ---------------------------------------------------------------------------

describe("milestoneKindLabel", () => {
  it("returns known labels for standard kinds", () => {
    expect(milestoneKindLabel("birthday")).toBe("Birthday");
    expect(milestoneKindLabel("anniversary")).toBe("Anniversary");
    expect(milestoneKindLabel("graduation")).toBe("Graduation");
    expect(milestoneKindLabel("funding")).toBe("Funding Round");
    expect(milestoneKindLabel("relocation")).toBe("Relocation");
    expect(milestoneKindLabel("custom")).toBe("Custom");
  });

  it("capitalizes unknown kinds as fallback", () => {
    expect(milestoneKindLabel("wedding")).toBe("Wedding");
    expect(milestoneKindLabel("promotion")).toBe("Promotion");
  });
});

// ---------------------------------------------------------------------------
// driftSeverityFromRatio
// ---------------------------------------------------------------------------

describe("driftSeverityFromRatio", () => {
  it("returns green for ratio <= 1.0", () => {
    expect(driftSeverityFromRatio(0.5)).toBe("green");
    expect(driftSeverityFromRatio(1.0)).toBe("green");
  });

  it("returns yellow for ratio between 1.0 and SEVERE threshold", () => {
    expect(driftSeverityFromRatio(1.5)).toBe("yellow");
    expect(driftSeverityFromRatio(DRIFT_RATIO_THRESHOLDS.SEVERE)).toBe("yellow");
  });

  it("returns red for ratio above SEVERE threshold", () => {
    expect(driftSeverityFromRatio(2.1)).toBe("red");
    expect(driftSeverityFromRatio(5.0)).toBe("red");
  });
});

// ---------------------------------------------------------------------------
// suggestedActionForCategory
// ---------------------------------------------------------------------------

describe("suggestedActionForCategory", () => {
  it("returns known actions for standard categories", () => {
    expect(suggestedActionForCategory("FRIEND")).toBe("Coffee or meal");
    expect(suggestedActionForCategory("COLLEAGUE")).toBe("Working lunch");
    expect(suggestedActionForCategory("professional")).toBe("Working lunch");
    expect(suggestedActionForCategory("vip")).toBe("Priority meeting");
  });

  it("returns generic fallback for unknown categories", () => {
    expect(suggestedActionForCategory("UNKNOWN")).toBe("Schedule a meeting");
  });
});

// ---------------------------------------------------------------------------
// toReconnectionCard
// ---------------------------------------------------------------------------

describe("toReconnectionCard", () => {
  it("converts a full suggestion to card data", () => {
    const suggestion = makeSuggestion();
    const card = toReconnectionCard(suggestion);

    expect(card.relationshipId).toBe("rel_01");
    expect(card.name).toBe("Alice");
    expect(card.city).toBe("Berlin");
    expect(card.category).toBe("FRIEND");
    expect(card.daysOverdue).toBe(16);
    expect(card.driftRatio).toBe(2.14);
    expect(card.suggestedAction).toBe("Coffee or meal");
    expect(card.suggestedDurationMinutes).toBe(60);
    expect(card.timeWindow).toEqual({ earliest: "2026-02-20", latest: "2026-02-25" });
    expect(card.urgency).toBe(12.8);
  });

  it("handles null display_name gracefully", () => {
    const card = toReconnectionCard(makeSuggestion({ display_name: null }));
    expect(card.name).toBe("Unknown");
  });

  it("handles missing city gracefully", () => {
    const card = toReconnectionCard(makeSuggestion({ city: undefined }));
    expect(card.city).toBe("");
  });

  it("handles null time window", () => {
    const card = toReconnectionCard(makeSuggestion({ suggested_time_window: null }));
    expect(card.timeWindow).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// sortByUrgency
// ---------------------------------------------------------------------------

describe("sortByUrgency", () => {
  it("sorts suggestions by urgency descending (highest first)", () => {
    const suggestions = [
      makeSuggestion({ relationship_id: "rel_low", urgency: 5 }),
      makeSuggestion({ relationship_id: "rel_high", urgency: 20 }),
      makeSuggestion({ relationship_id: "rel_mid", urgency: 10 }),
    ];

    const sorted = sortByUrgency(suggestions);
    expect(sorted.map((s) => s.relationship_id)).toEqual(["rel_high", "rel_mid", "rel_low"]);
  });

  it("does not mutate the original array", () => {
    const suggestions = [
      makeSuggestion({ urgency: 5 }),
      makeSuggestion({ urgency: 20 }),
    ];
    const original = [...suggestions];
    sortByUrgency(suggestions);
    expect(suggestions).toEqual(original);
  });

  it("returns empty array for empty input", () => {
    expect(sortByUrgency([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// groupByCity
// ---------------------------------------------------------------------------

describe("groupByCity", () => {
  it("groups suggestions by city", () => {
    const suggestions = [
      makeSuggestion({ relationship_id: "rel_1", city: "Berlin", urgency: 10 }),
      makeSuggestion({ relationship_id: "rel_2", city: "Berlin", urgency: 15 }),
      makeSuggestion({ relationship_id: "rel_3", city: "Tokyo", urgency: 8 }),
    ];

    const groups = groupByCity(suggestions);
    expect(groups).toHaveLength(2);
    // Berlin group first (more suggestions)
    expect(groups[0].city).toBe("Berlin");
    expect(groups[0].suggestions).toHaveLength(2);
    // Within Berlin, sorted by urgency descending
    expect(groups[0].suggestions[0].relationship_id).toBe("rel_2");
    expect(groups[0].suggestions[1].relationship_id).toBe("rel_1");
    // Tokyo group second
    expect(groups[1].city).toBe("Tokyo");
    expect(groups[1].suggestions).toHaveLength(1);
  });

  it("places suggestions without city in 'Other' group", () => {
    const suggestions = [
      makeSuggestion({ relationship_id: "rel_1", city: undefined }),
      makeSuggestion({ relationship_id: "rel_2", city: "" }),
    ];

    const groups = groupByCity(suggestions);
    expect(groups).toHaveLength(1);
    expect(groups[0].city).toBe("Other");
    expect(groups[0].suggestions).toHaveLength(2);
  });

  it("expands time window to cover all suggestions in group", () => {
    const suggestions = [
      makeSuggestion({
        city: "Berlin",
        suggested_time_window: { earliest: "2026-02-20", latest: "2026-02-25" },
      }),
      makeSuggestion({
        city: "Berlin",
        suggested_time_window: { earliest: "2026-02-18", latest: "2026-02-27" },
      }),
    ];

    const groups = groupByCity(suggestions);
    expect(groups[0].tripStart).toBe("2026-02-18");
    expect(groups[0].tripEnd).toBe("2026-02-27");
  });

  it("returns empty array for empty input", () => {
    expect(groupByCity([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// filterUpcomingMilestones
// ---------------------------------------------------------------------------

describe("filterUpcomingMilestones", () => {
  it("filters milestones within the default 30-day window", () => {
    const milestones = [
      makeMilestone({ milestone_id: "ms_1", days_until: 5 }),
      makeMilestone({ milestone_id: "ms_2", days_until: 28 }),
      makeMilestone({ milestone_id: "ms_3", days_until: 45 }),
    ];

    const result = filterUpcomingMilestones(milestones);
    expect(result).toHaveLength(2);
    expect(result[0].milestone_id).toBe("ms_1");
    expect(result[1].milestone_id).toBe("ms_2");
  });

  it("accepts a custom day window", () => {
    const milestones = [
      makeMilestone({ milestone_id: "ms_1", days_until: 5 }),
      makeMilestone({ milestone_id: "ms_2", days_until: 15 }),
    ];

    const result = filterUpcomingMilestones(milestones, 10);
    expect(result).toHaveLength(1);
    expect(result[0].milestone_id).toBe("ms_1");
  });

  it("sorts by days_until ascending", () => {
    const milestones = [
      makeMilestone({ milestone_id: "ms_far", days_until: 20 }),
      makeMilestone({ milestone_id: "ms_near", days_until: 3 }),
      makeMilestone({ milestone_id: "ms_mid", days_until: 10 }),
    ];

    const result = filterUpcomingMilestones(milestones);
    expect(result.map((m) => m.milestone_id)).toEqual(["ms_near", "ms_mid", "ms_far"]);
  });

  it("excludes milestones with negative days_until (past)", () => {
    const milestones = [
      makeMilestone({ milestone_id: "ms_past", days_until: -1 }),
      makeMilestone({ milestone_id: "ms_today", days_until: 0 }),
    ];

    const result = filterUpcomingMilestones(milestones);
    expect(result).toHaveLength(1);
    expect(result[0].milestone_id).toBe("ms_today");
  });

  it("returns empty array for empty input", () => {
    expect(filterUpcomingMilestones([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// groupMilestonesByMonth
// ---------------------------------------------------------------------------

describe("groupMilestonesByMonth", () => {
  it("groups milestones by month key", () => {
    const milestones = [
      makeMilestone({ milestone_id: "ms_1", next_occurrence: "2026-02-20" }),
      makeMilestone({ milestone_id: "ms_2", next_occurrence: "2026-02-25" }),
      makeMilestone({ milestone_id: "ms_3", next_occurrence: "2026-03-15" }),
    ];

    const groups = groupMilestonesByMonth(milestones);
    expect(groups.size).toBe(2);
    expect(groups.get("2026-02")).toHaveLength(2);
    expect(groups.get("2026-03")).toHaveLength(1);
  });

  it("sorts within each month by date ascending", () => {
    const milestones = [
      makeMilestone({ milestone_id: "ms_late", next_occurrence: "2026-02-28" }),
      makeMilestone({ milestone_id: "ms_early", next_occurrence: "2026-02-05" }),
    ];

    const groups = groupMilestonesByMonth(milestones);
    const feb = groups.get("2026-02")!;
    expect(feb[0].milestone_id).toBe("ms_early");
    expect(feb[1].milestone_id).toBe("ms_late");
  });

  it("returns empty map for empty input", () => {
    const groups = groupMilestonesByMonth([]);
    expect(groups.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// formatMonthLabel
// ---------------------------------------------------------------------------

describe("formatMonthLabel", () => {
  it("formats a month key to a readable label", () => {
    expect(formatMonthLabel("2026-02")).toBe("February 2026");
    expect(formatMonthLabel("2026-12")).toBe("December 2026");
  });

  it("returns original string for invalid input", () => {
    expect(formatMonthLabel("invalid")).toBe("invalid");
  });
});

// ---------------------------------------------------------------------------
// buildScheduleParams
// ---------------------------------------------------------------------------

describe("buildScheduleParams", () => {
  it("builds params from card data with time window", () => {
    const card: ReconnectionCardData = {
      relationshipId: "rel_01",
      name: "Alice",
      city: "Berlin",
      category: "FRIEND",
      daysOverdue: 16,
      driftRatio: 2.14,
      suggestedAction: "Coffee or meal",
      suggestedDurationMinutes: 60,
      timeWindow: { earliest: "2026-02-20", latest: "2026-02-25" },
      urgency: 12.8,
    };

    const params = buildScheduleParams(card);
    expect(params.duration).toBe("60");
    expect(params.contact).toBe("Alice");
    expect(params.relationship_id).toBe("rel_01");
    expect(params.window_start).toBe("2026-02-20");
    expect(params.window_end).toBe("2026-02-25");
  });

  it("omits window params when time window is null", () => {
    const card: ReconnectionCardData = {
      relationshipId: "rel_01",
      name: "Alice",
      city: "Berlin",
      category: "FRIEND",
      daysOverdue: 16,
      driftRatio: 2.14,
      suggestedAction: "Coffee or meal",
      suggestedDurationMinutes: 60,
      timeWindow: null,
      urgency: 12.8,
    };

    const params = buildScheduleParams(card);
    expect(params.duration).toBe("60");
    expect(params.contact).toBe("Alice");
    expect(params.window_start).toBeUndefined();
    expect(params.window_end).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildScheduleUrl
// ---------------------------------------------------------------------------

describe("buildScheduleUrl", () => {
  it("builds a hash URL with params", () => {
    const card: ReconnectionCardData = {
      relationshipId: "rel_01",
      name: "Alice",
      city: "Berlin",
      category: "FRIEND",
      daysOverdue: 16,
      driftRatio: 2.14,
      suggestedAction: "Coffee or meal",
      suggestedDurationMinutes: 60,
      timeWindow: { earliest: "2026-02-20", latest: "2026-02-25" },
      urgency: 12.8,
    };

    const url = buildScheduleUrl(card);
    expect(url).toMatch(/^#\/scheduling\?/);
    expect(url).toContain("duration=60");
    expect(url).toContain("contact=Alice");
    expect(url).toContain("relationship_id=rel_01");
    expect(url).toContain("window_start=2026-02-20");
    expect(url).toContain("window_end=2026-02-25");
  });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("constants", () => {
  it("exports DRIFT_RATIO_THRESHOLDS with correct structure", () => {
    expect(DRIFT_RATIO_THRESHOLDS.MODERATE).toBe(1.5);
    expect(DRIFT_RATIO_THRESHOLDS.SEVERE).toBe(2.0);
  });

  it("exports MILESTONE_KIND_LABELS for all standard kinds", () => {
    expect(Object.keys(MILESTONE_KIND_LABELS)).toContain("birthday");
    expect(Object.keys(MILESTONE_KIND_LABELS)).toContain("anniversary");
    expect(Object.keys(MILESTONE_KIND_LABELS)).toContain("graduation");
    expect(Object.keys(MILESTONE_KIND_LABELS)).toContain("funding");
    expect(Object.keys(MILESTONE_KIND_LABELS)).toContain("relocation");
    expect(Object.keys(MILESTONE_KIND_LABELS)).toContain("custom");
  });

  it("exports CATEGORY_ACTIONS for both backend and frontend categories", () => {
    // Backend categories (uppercase)
    expect(CATEGORY_ACTIONS["FRIEND"]).toBeDefined();
    expect(CATEGORY_ACTIONS["COLLEAGUE"]).toBeDefined();
    // Frontend categories (lowercase)
    expect(CATEGORY_ACTIONS["professional"]).toBeDefined();
    expect(CATEGORY_ACTIONS["vip"]).toBeDefined();
  });
});
