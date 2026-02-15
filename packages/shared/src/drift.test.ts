import { describe, it, expect } from "vitest";
import {
  computeDrift,
  matchEventParticipants,
  computeDriftBadge,
  driftEntryBadge,
  matchCity,
  categoryDurationMinutes,
  enrichSuggestionsWithTimeWindows,
  enrichWithTimezoneWindows,
} from "./drift";
import type { DriftInput, DriftEntry, ReconnectionSuggestion } from "./drift";
import type { TimezoneAwareMeetingWindow } from "./geo";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function daysAgo(days: number, from?: Date): string {
  const base = from ?? new Date("2026-02-15T12:00:00Z");
  return new Date(base.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

const NOW = "2026-02-15T12:00:00Z";

// ---------------------------------------------------------------------------
// computeDrift
// ---------------------------------------------------------------------------

describe("computeDrift", () => {
  it("returns empty overdue list when no relationships have frequency targets", () => {
    const relationships: DriftInput[] = [
      {
        relationship_id: "rel_01HXY000000000000000000E01",
        participant_hash: "abc123",
        display_name: "Alice",
        category: "FRIEND",
        closeness_weight: 0.5,
        last_interaction_ts: daysAgo(5),
        interaction_frequency_target: null,
      },
    ];

    const report = computeDrift(relationships, NOW);
    expect(report.overdue).toHaveLength(0);
    expect(report.total_tracked).toBe(0);
    expect(report.total_overdue).toBe(0);
  });

  it("detects overdue relationships when days since last interaction exceeds target", () => {
    const relationships: DriftInput[] = [
      {
        relationship_id: "rel_01HXY000000000000000000E01",
        participant_hash: "abc123",
        display_name: "Alice",
        category: "FRIEND",
        closeness_weight: 0.8,
        last_interaction_ts: daysAgo(10, new Date(NOW)),
        interaction_frequency_target: 7,
      },
    ];

    const report = computeDrift(relationships, NOW);
    expect(report.overdue).toHaveLength(1);
    expect(report.overdue[0].relationship_id).toBe("rel_01HXY000000000000000000E01");
    expect(report.overdue[0].days_since_interaction).toBe(10);
    expect(report.overdue[0].days_overdue).toBe(3);
    expect(report.overdue[0].drift_ratio).toBeCloseTo(10 / 7, 1);
    expect(report.overdue[0].urgency).toBeCloseTo(3 * 0.8);
    expect(report.total_tracked).toBe(1);
    expect(report.total_overdue).toBe(1);
  });

  it("computes drift_ratio as days_since_interaction / interaction_frequency_target", () => {
    const relationships: DriftInput[] = [
      {
        relationship_id: "rel_01HXY000000000000000000E01",
        participant_hash: "abc123",
        display_name: "Alice",
        category: "FRIEND",
        closeness_weight: 0.5,
        last_interaction_ts: daysAgo(21, new Date(NOW)),
        interaction_frequency_target: 7,
      },
    ];

    const report = computeDrift(relationships, NOW);
    expect(report.overdue).toHaveLength(1);
    // 21 days / 7 day target = 3.0
    expect(report.overdue[0].drift_ratio).toBe(3.0);
  });

  it("rounds drift_ratio to two decimal places", () => {
    const relationships: DriftInput[] = [
      {
        relationship_id: "rel_01HXY000000000000000000E01",
        participant_hash: "abc123",
        display_name: "Test",
        category: "FRIEND",
        closeness_weight: 0.5,
        last_interaction_ts: daysAgo(10, new Date(NOW)),
        interaction_frequency_target: 3,
      },
    ];

    const report = computeDrift(relationships, NOW);
    expect(report.overdue).toHaveLength(1);
    // 10 / 3 = 3.333... -> rounds to 3.33
    expect(report.overdue[0].drift_ratio).toBe(3.33);
  });

  it("does not flag relationships that are within their frequency target", () => {
    const relationships: DriftInput[] = [
      {
        relationship_id: "rel_01HXY000000000000000000E01",
        participant_hash: "abc123",
        display_name: "Bob",
        category: "COLLEAGUE",
        closeness_weight: 0.5,
        last_interaction_ts: daysAgo(3, new Date(NOW)),
        interaction_frequency_target: 7,
      },
    ];

    const report = computeDrift(relationships, NOW);
    expect(report.overdue).toHaveLength(0);
    expect(report.total_tracked).toBe(1);
    expect(report.total_overdue).toBe(0);
  });

  it("treats null last_interaction_ts as epoch (maximally overdue)", () => {
    const relationships: DriftInput[] = [
      {
        relationship_id: "rel_01HXY000000000000000000E01",
        participant_hash: "abc123",
        display_name: "Charlie",
        category: "INVESTOR",
        closeness_weight: 1.0,
        last_interaction_ts: null,
        interaction_frequency_target: 30,
      },
    ];

    const report = computeDrift(relationships, NOW);
    expect(report.overdue).toHaveLength(1);
    // Days since epoch should be very large
    expect(report.overdue[0].days_since_interaction).toBeGreaterThan(365);
    expect(report.overdue[0].days_overdue).toBeGreaterThan(335);
  });

  it("sorts by urgency descending (closeness_weight * days_overdue)", () => {
    const relationships: DriftInput[] = [
      {
        relationship_id: "rel_01HXY000000000000000000E01",
        participant_hash: "aaa",
        display_name: "Low Priority",
        category: "COLLEAGUE",
        closeness_weight: 0.2,
        last_interaction_ts: daysAgo(20, new Date(NOW)),
        interaction_frequency_target: 7,
      },
      {
        relationship_id: "rel_01HXY000000000000000000E02",
        participant_hash: "bbb",
        display_name: "High Priority",
        category: "FAMILY",
        closeness_weight: 1.0,
        last_interaction_ts: daysAgo(15, new Date(NOW)),
        interaction_frequency_target: 7,
      },
    ];

    const report = computeDrift(relationships, NOW);
    expect(report.overdue).toHaveLength(2);
    // High Priority: (15-7) * 1.0 = 8.0
    // Low Priority: (20-7) * 0.2 = 2.6
    expect(report.overdue[0].display_name).toBe("High Priority");
    expect(report.overdue[1].display_name).toBe("Low Priority");
    expect(report.overdue[0].urgency).toBeGreaterThan(report.overdue[1].urgency);
  });

  it("skips relationships with zero or negative frequency targets", () => {
    const relationships: DriftInput[] = [
      {
        relationship_id: "rel_01HXY000000000000000000E01",
        participant_hash: "abc",
        display_name: "Zero Target",
        category: "OTHER",
        closeness_weight: 0.5,
        last_interaction_ts: daysAgo(100, new Date(NOW)),
        interaction_frequency_target: 0,
      },
    ];

    const report = computeDrift(relationships, NOW);
    expect(report.total_tracked).toBe(0);
    expect(report.overdue).toHaveLength(0);
  });

  it("includes computed_at timestamp in the report", () => {
    const report = computeDrift([], NOW);
    expect(report.computed_at).toBe("2026-02-15T12:00:00.000Z");
  });

  it("handles empty relationships array", () => {
    const report = computeDrift([], NOW);
    expect(report.overdue).toHaveLength(0);
    expect(report.total_tracked).toBe(0);
    expect(report.total_overdue).toBe(0);
  });

  it("handles Date object as now parameter", () => {
    const relationships: DriftInput[] = [
      {
        relationship_id: "rel_01HXY000000000000000000E01",
        participant_hash: "abc",
        display_name: "Test",
        category: "FRIEND",
        closeness_weight: 0.5,
        last_interaction_ts: "2026-02-01T12:00:00Z",
        interaction_frequency_target: 7,
      },
    ];

    const report = computeDrift(relationships, new Date(NOW));
    expect(report.overdue).toHaveLength(1);
    expect(report.overdue[0].days_overdue).toBe(7); // 14 days since - 7 target
  });
});

// ---------------------------------------------------------------------------
// matchEventParticipants
// ---------------------------------------------------------------------------

describe("matchEventParticipants", () => {
  it("returns matching relationship IDs for participant hashes", () => {
    const eventHashes = ["hash_a", "hash_b", "hash_c"];
    const relationships = [
      { relationship_id: "rel_01HXY000000000000000000E01", participant_hash: "hash_a" },
      { relationship_id: "rel_01HXY000000000000000000E02", participant_hash: "hash_d" },
      { relationship_id: "rel_01HXY000000000000000000E03", participant_hash: "hash_b" },
    ];

    const matches = matchEventParticipants(eventHashes, relationships);
    expect(matches).toEqual([
      "rel_01HXY000000000000000000E01",
      "rel_01HXY000000000000000000E03",
    ]);
  });

  it("returns empty array when no hashes match", () => {
    const matches = matchEventParticipants(
      ["hash_x"],
      [{ relationship_id: "rel_01HXY000000000000000000E01", participant_hash: "hash_y" }],
    );
    expect(matches).toHaveLength(0);
  });

  it("returns empty array for empty event hashes", () => {
    const matches = matchEventParticipants(
      [],
      [{ relationship_id: "rel_01HXY000000000000000000E01", participant_hash: "hash_a" }],
    );
    expect(matches).toHaveLength(0);
  });

  it("returns empty array for empty relationships", () => {
    const matches = matchEventParticipants(["hash_a"], []);
    expect(matches).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// computeDriftBadge
// ---------------------------------------------------------------------------

describe("computeDriftBadge", () => {
  it("returns 'none' when frequency target is null", () => {
    expect(computeDriftBadge(5, null)).toBe("none");
  });

  it("returns 'none' when frequency target is zero", () => {
    expect(computeDriftBadge(5, 0)).toBe("none");
  });

  it("returns 'none' when frequency target is negative", () => {
    expect(computeDriftBadge(5, -1)).toBe("none");
  });

  it("returns 'red' when days since interaction is null (never interacted)", () => {
    expect(computeDriftBadge(null, 7)).toBe("red");
  });

  it("returns 'green' when within frequency target (ratio <= 1.0)", () => {
    // 3 days / 7 day target = 0.43
    expect(computeDriftBadge(3, 7)).toBe("green");
  });

  it("returns 'green' at exact frequency target boundary (ratio = 1.0)", () => {
    expect(computeDriftBadge(7, 7)).toBe("green");
  });

  it("returns 'yellow' when slightly overdue (1.0 < ratio <= 2.0)", () => {
    // 10 days / 7 day target = 1.43
    expect(computeDriftBadge(10, 7)).toBe("yellow");
  });

  it("returns 'yellow' at double the target (ratio = 2.0)", () => {
    expect(computeDriftBadge(14, 7)).toBe("yellow");
  });

  it("returns 'red' when significantly overdue (ratio > 2.0)", () => {
    // 21 days / 7 day target = 3.0
    expect(computeDriftBadge(21, 7)).toBe("red");
  });

  it("returns 'green' for zero days since interaction", () => {
    expect(computeDriftBadge(0, 7)).toBe("green");
  });
});

// ---------------------------------------------------------------------------
// driftEntryBadge
// ---------------------------------------------------------------------------

describe("driftEntryBadge", () => {
  it("returns badge from a DriftEntry", () => {
    const entry: DriftEntry = {
      relationship_id: "rel_01HXY000000000000000000E01",
      participant_hash: "abc",
      display_name: "Test",
      category: "FRIEND",
      closeness_weight: 0.5,
      last_interaction_ts: "2026-02-01T12:00:00Z",
      interaction_frequency_target: 7,
      days_since_interaction: 14,
      days_overdue: 7,
      drift_ratio: 2.0,
      urgency: 3.5,
    };
    // 14 days / 7 target = 2.0 -> yellow (at boundary)
    expect(driftEntryBadge(entry)).toBe("yellow");
  });

  it("returns red for highly overdue entry", () => {
    const entry: DriftEntry = {
      relationship_id: "rel_01HXY000000000000000000E01",
      participant_hash: "abc",
      display_name: "Test",
      category: "FRIEND",
      closeness_weight: 0.5,
      last_interaction_ts: "2026-01-01T12:00:00Z",
      interaction_frequency_target: 7,
      days_since_interaction: 45,
      days_overdue: 38,
      drift_ratio: 6.43,
      urgency: 19.0,
    };
    expect(driftEntryBadge(entry)).toBe("red");
  });
});

// ---------------------------------------------------------------------------
// matchCity (TM-xwn.1)
// ---------------------------------------------------------------------------

describe("matchCity", () => {
  it("matches same city case-insensitively", () => {
    expect(matchCity("Berlin", "berlin")).toBe(true);
    expect(matchCity("berlin", "BERLIN")).toBe(true);
    expect(matchCity("Berlin", "Berlin")).toBe(true);
  });

  it("rejects different cities", () => {
    expect(matchCity("Berlin", "Munich")).toBe(false);
    expect(matchCity("New York", "Los Angeles")).toBe(false);
  });

  it("trims whitespace before comparing", () => {
    expect(matchCity("  Berlin  ", "berlin")).toBe(true);
    expect(matchCity("Berlin", "  berlin  ")).toBe(true);
  });

  it("returns false for null/empty inputs", () => {
    expect(matchCity(null, "Berlin")).toBe(false);
    expect(matchCity("Berlin", null)).toBe(false);
    expect(matchCity("", "Berlin")).toBe(false);
    expect(matchCity("Berlin", "")).toBe(false);
    expect(matchCity(null, null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// categoryDurationMinutes (TM-xwn.1)
// ---------------------------------------------------------------------------

describe("categoryDurationMinutes", () => {
  it("returns 60 minutes for FRIEND", () => {
    expect(categoryDurationMinutes("FRIEND")).toBe(60);
  });

  it("returns 60 minutes for FAMILY", () => {
    expect(categoryDurationMinutes("FAMILY")).toBe(60);
  });

  it("returns 45 minutes for COLLEAGUE", () => {
    expect(categoryDurationMinutes("COLLEAGUE")).toBe(45);
  });

  it("returns 45 minutes for CLIENT", () => {
    expect(categoryDurationMinutes("CLIENT")).toBe(45);
  });

  it("returns 45 minutes for BOARD", () => {
    expect(categoryDurationMinutes("BOARD")).toBe(45);
  });

  it("returns 30 minutes for INVESTOR", () => {
    expect(categoryDurationMinutes("INVESTOR")).toBe(30);
  });

  it("returns 30 minutes for OTHER", () => {
    expect(categoryDurationMinutes("OTHER")).toBe(30);
  });

  it("returns 30 minutes for unknown categories", () => {
    expect(categoryDurationMinutes("UNKNOWN" as string)).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// enrichSuggestionsWithTimeWindows (TM-xwn.1)
// ---------------------------------------------------------------------------

describe("enrichSuggestionsWithTimeWindows", () => {
  const baseDriftEntry: DriftEntry = {
    relationship_id: "rel_01HXY000000000000000000E01",
    participant_hash: "abc",
    display_name: "Alice in Berlin",
    category: "FRIEND",
    closeness_weight: 0.8,
    last_interaction_ts: "2026-01-01T12:00:00Z",
    interaction_frequency_target: 7,
    days_since_interaction: 45,
    days_overdue: 38,
    drift_ratio: 6.43,
    urgency: 30.4,
  };

  it("enriches each suggestion with suggested_duration_minutes based on category", () => {
    const suggestions = enrichSuggestionsWithTimeWindows(
      [baseDriftEntry],
      "2026-04-01T00:00:00Z",
      "2026-04-05T00:00:00Z",
    );
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].suggested_duration_minutes).toBe(60); // FRIEND -> 60
  });

  it("computes suggested_time_window within trip dates", () => {
    const suggestions = enrichSuggestionsWithTimeWindows(
      [baseDriftEntry],
      "2026-04-01T00:00:00Z",
      "2026-04-05T00:00:00Z",
    );
    expect(suggestions[0].suggested_time_window).toBeDefined();
    expect(suggestions[0].suggested_time_window!.earliest).toBe("2026-04-01T00:00:00Z");
    expect(suggestions[0].suggested_time_window!.latest).toBe("2026-04-05T00:00:00Z");
  });

  it("returns null time_window when no trip dates provided", () => {
    const suggestions = enrichSuggestionsWithTimeWindows(
      [baseDriftEntry],
      null,
      null,
    );
    expect(suggestions[0].suggested_time_window).toBeNull();
    // Duration should still be computed
    expect(suggestions[0].suggested_duration_minutes).toBe(60);
  });

  it("preserves all original drift entry fields", () => {
    const suggestions = enrichSuggestionsWithTimeWindows(
      [baseDriftEntry],
      "2026-04-01T00:00:00Z",
      "2026-04-05T00:00:00Z",
    );
    const s = suggestions[0];
    expect(s.relationship_id).toBe(baseDriftEntry.relationship_id);
    expect(s.display_name).toBe(baseDriftEntry.display_name);
    expect(s.category).toBe(baseDriftEntry.category);
    expect(s.drift_ratio).toBe(baseDriftEntry.drift_ratio);
    expect(s.days_overdue).toBe(baseDriftEntry.days_overdue);
    expect(s.urgency).toBe(baseDriftEntry.urgency);
  });

  it("enriches multiple suggestions maintaining urgency order", () => {
    const friend: DriftEntry = {
      ...baseDriftEntry,
      relationship_id: "rel_friend",
      display_name: "Friend Alice",
      category: "FRIEND",
      urgency: 30,
    };
    const colleague: DriftEntry = {
      ...baseDriftEntry,
      relationship_id: "rel_colleague",
      display_name: "Colleague Bob",
      category: "COLLEAGUE",
      urgency: 20,
    };
    const suggestions = enrichSuggestionsWithTimeWindows(
      [friend, colleague],
      "2026-04-01T00:00:00Z",
      "2026-04-05T00:00:00Z",
    );
    expect(suggestions).toHaveLength(2);
    expect(suggestions[0].relationship_id).toBe("rel_friend");
    expect(suggestions[0].suggested_duration_minutes).toBe(60);
    expect(suggestions[1].relationship_id).toBe("rel_colleague");
    expect(suggestions[1].suggested_duration_minutes).toBe(45);
  });

  it("handles empty suggestion list", () => {
    const suggestions = enrichSuggestionsWithTimeWindows(
      [],
      "2026-04-01T00:00:00Z",
      "2026-04-05T00:00:00Z",
    );
    expect(suggestions).toHaveLength(0);
  });

  it("returns null time_window when only trip_start provided without trip_end", () => {
    const suggestions = enrichSuggestionsWithTimeWindows(
      [baseDriftEntry],
      "2026-04-01T00:00:00Z",
      null,
    );
    expect(suggestions[0].suggested_time_window).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// enrichWithTimezoneWindows (TM-xwn.3)
// ---------------------------------------------------------------------------

describe("enrichWithTimezoneWindows", () => {
  const baseSuggestion: ReconnectionSuggestion = {
    relationship_id: "rel_01HXY000000000000000000E01",
    participant_hash: "abc",
    display_name: "Alice in Berlin",
    category: "FRIEND",
    closeness_weight: 0.8,
    last_interaction_ts: "2026-01-01T12:00:00Z",
    interaction_frequency_target: 7,
    days_since_interaction: 45,
    days_overdue: 38,
    drift_ratio: 6.43,
    urgency: 30.4,
    suggested_duration_minutes: 60,
    suggested_time_window: {
      earliest: "2026-04-01T00:00:00Z",
      latest: "2026-04-05T00:00:00Z",
    },
  };

  // Mock suggestMeetingWindow for isolated testing
  const mockSuggestMeetingWindow = (
    tripStart: string | null,
    tripEnd: string | null,
    userTz: string | null | undefined,
    contactTz: string | null | undefined,
    duration: number,
  ): TimezoneAwareMeetingWindow | null => {
    if (!tripStart || !tripEnd) return null;
    return {
      earliest: tripStart,
      latest: tripEnd,
      suggested_start_hour_utc: userTz && contactTz ? 14 : null,
      suggested_end_hour_utc: userTz && contactTz ? 17 : null,
      user_timezone: userTz ?? null,
      contact_timezone: contactTz ?? null,
    };
  };

  it("adds timezone_meeting_window to each suggestion", () => {
    const contactTimezones = new Map<string, string | null>([
      ["rel_01HXY000000000000000000E01", "Europe/Berlin"],
    ]);

    const result = enrichWithTimezoneWindows(
      [baseSuggestion],
      "2026-04-01T00:00:00Z",
      "2026-04-05T00:00:00Z",
      "America/New_York",
      contactTimezones,
      mockSuggestMeetingWindow,
    );

    expect(result).toHaveLength(1);
    expect(result[0].timezone_meeting_window).toBeDefined();
    expect(result[0].timezone_meeting_window!.user_timezone).toBe("America/New_York");
    expect(result[0].timezone_meeting_window!.contact_timezone).toBe("Europe/Berlin");
    expect(result[0].timezone_meeting_window!.suggested_start_hour_utc).toBe(14);
    expect(result[0].timezone_meeting_window!.suggested_end_hour_utc).toBe(17);
  });

  it("preserves all original suggestion fields", () => {
    const contactTimezones = new Map<string, string | null>([
      ["rel_01HXY000000000000000000E01", "Europe/Berlin"],
    ]);

    const result = enrichWithTimezoneWindows(
      [baseSuggestion],
      "2026-04-01T00:00:00Z",
      "2026-04-05T00:00:00Z",
      "America/New_York",
      contactTimezones,
      mockSuggestMeetingWindow,
    );

    const s = result[0];
    expect(s.relationship_id).toBe(baseSuggestion.relationship_id);
    expect(s.display_name).toBe(baseSuggestion.display_name);
    expect(s.suggested_duration_minutes).toBe(baseSuggestion.suggested_duration_minutes);
    expect(s.suggested_time_window).toBe(baseSuggestion.suggested_time_window);
    expect(s.drift_ratio).toBe(baseSuggestion.drift_ratio);
    expect(s.urgency).toBe(baseSuggestion.urgency);
  });

  it("returns null timezone window when no trip dates", () => {
    const contactTimezones = new Map<string, string | null>([
      ["rel_01HXY000000000000000000E01", "Europe/Berlin"],
    ]);

    const result = enrichWithTimezoneWindows(
      [baseSuggestion],
      null,
      null,
      "America/New_York",
      contactTimezones,
      mockSuggestMeetingWindow,
    );

    expect(result[0].timezone_meeting_window).toBeNull();
  });

  it("passes null for contact timezone when not in map", () => {
    const emptyMap = new Map<string, string | null>();

    const result = enrichWithTimezoneWindows(
      [baseSuggestion],
      "2026-04-01T00:00:00Z",
      "2026-04-05T00:00:00Z",
      "America/New_York",
      emptyMap,
      mockSuggestMeetingWindow,
    );

    expect(result[0].timezone_meeting_window).toBeDefined();
    expect(result[0].timezone_meeting_window!.contact_timezone).toBeNull();
    // No working hours overlap when contact timezone unknown
    expect(result[0].timezone_meeting_window!.suggested_start_hour_utc).toBeNull();
  });

  it("handles multiple suggestions with different contact timezones", () => {
    const secondSuggestion: ReconnectionSuggestion = {
      ...baseSuggestion,
      relationship_id: "rel_02",
      display_name: "Bob in Tokyo",
    };

    const contactTimezones = new Map<string, string | null>([
      ["rel_01HXY000000000000000000E01", "Europe/Berlin"],
      ["rel_02", "Asia/Tokyo"],
    ]);

    const result = enrichWithTimezoneWindows(
      [baseSuggestion, secondSuggestion],
      "2026-04-01T00:00:00Z",
      "2026-04-05T00:00:00Z",
      "America/New_York",
      contactTimezones,
      mockSuggestMeetingWindow,
    );

    expect(result).toHaveLength(2);
    expect(result[0].timezone_meeting_window!.contact_timezone).toBe("Europe/Berlin");
    expect(result[1].timezone_meeting_window!.contact_timezone).toBe("Asia/Tokyo");
  });
});
