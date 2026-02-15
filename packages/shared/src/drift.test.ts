import { describe, it, expect } from "vitest";
import { computeDrift, matchEventParticipants } from "./drift";
import type { DriftInput } from "./drift";

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
    expect(report.overdue[0].urgency).toBeCloseTo(3 * 0.8);
    expect(report.total_tracked).toBe(1);
    expect(report.total_overdue).toBe(1);
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
