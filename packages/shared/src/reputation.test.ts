import { describe, it, expect } from "vitest";
import {
  computeReliabilityScore,
  computeReciprocityScore,
  computeReputation,
  computeDecayFactor,
} from "./reputation";
import type { LedgerInput, ReputationResult } from "./reputation";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = "2026-02-15T12:00:00Z";
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function daysAgo(days: number): string {
  return new Date(new Date(NOW).getTime() - days * MS_PER_DAY).toISOString();
}

function makeLedgerEntry(
  outcome: string,
  weight: number,
  daysOld: number,
): LedgerInput {
  return {
    outcome,
    weight,
    ts: daysAgo(daysOld),
  };
}

// ---------------------------------------------------------------------------
// computeDecayFactor
// ---------------------------------------------------------------------------

describe("computeDecayFactor", () => {
  it("returns 1.0 for zero age (today)", () => {
    expect(computeDecayFactor(0)).toBe(1.0);
  });

  it("returns 0.95 for 30 days old (one half-life)", () => {
    expect(computeDecayFactor(30)).toBeCloseTo(0.95, 5);
  });

  it("returns 0.95^2 for 60 days old", () => {
    expect(computeDecayFactor(60)).toBeCloseTo(0.95 ** 2, 5);
  });

  it("returns 0.95^4 for 120 days old", () => {
    expect(computeDecayFactor(120)).toBeCloseTo(0.95 ** 4, 5);
  });

  it("returns a very small but positive number for very old entries", () => {
    const factor = computeDecayFactor(3650); // ~10 years
    expect(factor).toBeGreaterThan(0);
    expect(factor).toBeLessThan(0.1);
  });

  it("never returns negative", () => {
    expect(computeDecayFactor(100000)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// computeReliabilityScore
// ---------------------------------------------------------------------------

describe("computeReliabilityScore", () => {
  it("returns 0.5 for empty ledger (neutral default)", () => {
    expect(computeReliabilityScore([], NOW)).toBe(0.5);
  });

  it("returns 1.0 for a single recent ATTENDED entry", () => {
    const entries: LedgerInput[] = [makeLedgerEntry("ATTENDED", 1.0, 0)];
    const score = computeReliabilityScore(entries, NOW);
    expect(score).toBeCloseTo(1.0, 2);
  });

  it("returns 0.0 for a single recent NO_SHOW_THEM entry", () => {
    const entries: LedgerInput[] = [makeLedgerEntry("NO_SHOW_THEM", -1.0, 0)];
    const score = computeReliabilityScore(entries, NOW);
    expect(score).toBe(0.0);
  });

  it("returns 0.5 for neutral _ME outcomes only", () => {
    const entries: LedgerInput[] = [
      makeLedgerEntry("CANCELED_BY_ME", 0.0, 1),
      makeLedgerEntry("NO_SHOW_ME", 0.0, 2),
      makeLedgerEntry("MOVED_LAST_MINUTE_ME", 0.0, 3),
    ];
    const score = computeReliabilityScore(entries, NOW);
    expect(score).toBe(0.5);
  });

  it("applies decay: recent entries weigh more than old ones", () => {
    // One bad entry 1 day ago, one good entry 365 days ago
    const recentBad: LedgerInput[] = [
      makeLedgerEntry("NO_SHOW_THEM", -1.0, 1),
      makeLedgerEntry("ATTENDED", 1.0, 365),
    ];
    const scoreBadRecent = computeReliabilityScore(recentBad, NOW);

    // One good entry 1 day ago, one bad entry 365 days ago
    const recentGood: LedgerInput[] = [
      makeLedgerEntry("ATTENDED", 1.0, 1),
      makeLedgerEntry("NO_SHOW_THEM", -1.0, 365),
    ];
    const scoreGoodRecent = computeReliabilityScore(recentGood, NOW);

    // Recent good should score higher than recent bad
    expect(scoreGoodRecent).toBeGreaterThan(scoreBadRecent);
  });

  it("mixed outcomes produce a score between 0 and 1", () => {
    const entries: LedgerInput[] = [
      makeLedgerEntry("ATTENDED", 1.0, 1),
      makeLedgerEntry("ATTENDED", 1.0, 5),
      makeLedgerEntry("CANCELED_BY_THEM", -0.5, 10),
      makeLedgerEntry("NO_SHOW_THEM", -1.0, 20),
      makeLedgerEntry("ATTENDED", 1.0, 30),
    ];
    const score = computeReliabilityScore(entries, NOW);
    expect(score).toBeGreaterThan(0.0);
    expect(score).toBeLessThan(1.0);
  });

  it("score is always clamped between 0 and 1", () => {
    // All bad outcomes
    const allBad: LedgerInput[] = [
      makeLedgerEntry("NO_SHOW_THEM", -1.0, 1),
      makeLedgerEntry("NO_SHOW_THEM", -1.0, 2),
      makeLedgerEntry("NO_SHOW_THEM", -1.0, 3),
      makeLedgerEntry("CANCELED_BY_THEM", -0.5, 4),
    ];
    const scoreBad = computeReliabilityScore(allBad, NOW);
    expect(scoreBad).toBeGreaterThanOrEqual(0.0);
    expect(scoreBad).toBeLessThanOrEqual(1.0);

    // All good outcomes
    const allGood: LedgerInput[] = [
      makeLedgerEntry("ATTENDED", 1.0, 1),
      makeLedgerEntry("ATTENDED", 1.0, 2),
      makeLedgerEntry("ATTENDED", 1.0, 3),
    ];
    const scoreGood = computeReliabilityScore(allGood, NOW);
    expect(scoreGood).toBeGreaterThanOrEqual(0.0);
    expect(scoreGood).toBeLessThanOrEqual(1.0);
  });

  it("handles single entry correctly", () => {
    // CANCELED_BY_THEM has weight -0.5; normalized = (-0.5 + 1) / 2 = 0.25
    const entries: LedgerInput[] = [
      makeLedgerEntry("CANCELED_BY_THEM", -0.5, 0),
    ];
    const score = computeReliabilityScore(entries, NOW);
    expect(score).toBeCloseTo(0.25, 2);
  });

  it("rounds to 2 decimal places", () => {
    // Use entries that would produce many decimal places
    const entries: LedgerInput[] = [
      makeLedgerEntry("ATTENDED", 1.0, 7),
      makeLedgerEntry("CANCELED_BY_THEM", -0.5, 14),
      makeLedgerEntry("ATTENDED", 1.0, 21),
    ];
    const score = computeReliabilityScore(entries, NOW);
    // Score should have at most 2 decimal places
    const rounded = Math.round(score * 100) / 100;
    expect(score).toBe(rounded);
  });
});

// ---------------------------------------------------------------------------
// computeReciprocityScore
// ---------------------------------------------------------------------------

describe("computeReciprocityScore", () => {
  it("returns 0.5 (balanced) for empty ledger", () => {
    expect(computeReciprocityScore([])).toBe(0.5);
  });

  it("returns 0.5 when cancellation rates are equal", () => {
    const entries: LedgerInput[] = [
      makeLedgerEntry("CANCELED_BY_ME", 0.0, 1),
      makeLedgerEntry("CANCELED_BY_THEM", -0.5, 2),
      makeLedgerEntry("ATTENDED", 1.0, 3),
      makeLedgerEntry("ATTENDED", 1.0, 4),
    ];
    const score = computeReciprocityScore(entries);
    expect(score).toBeCloseTo(0.5, 2);
  });

  it("returns > 0.5 when they cancel more than me (they are less reliable)", () => {
    const entries: LedgerInput[] = [
      makeLedgerEntry("CANCELED_BY_THEM", -0.5, 1),
      makeLedgerEntry("CANCELED_BY_THEM", -0.5, 2),
      makeLedgerEntry("CANCELED_BY_THEM", -0.5, 3),
      makeLedgerEntry("CANCELED_BY_ME", 0.0, 4),
      makeLedgerEntry("ATTENDED", 1.0, 5),
      makeLedgerEntry("ATTENDED", 1.0, 6),
    ];
    const score = computeReciprocityScore(entries);
    expect(score).toBeGreaterThan(0.5);
  });

  it("returns < 0.5 when I cancel more than them (I am less reliable)", () => {
    const entries: LedgerInput[] = [
      makeLedgerEntry("CANCELED_BY_ME", 0.0, 1),
      makeLedgerEntry("CANCELED_BY_ME", 0.0, 2),
      makeLedgerEntry("CANCELED_BY_ME", 0.0, 3),
      makeLedgerEntry("CANCELED_BY_THEM", -0.5, 4),
      makeLedgerEntry("ATTENDED", 1.0, 5),
    ];
    const score = computeReciprocityScore(entries);
    expect(score).toBeLessThan(0.5);
  });

  it("returns 0.5 when neither party cancels", () => {
    const entries: LedgerInput[] = [
      makeLedgerEntry("ATTENDED", 1.0, 1),
      makeLedgerEntry("ATTENDED", 1.0, 2),
    ];
    const score = computeReciprocityScore(entries);
    expect(score).toBe(0.5);
  });

  it("includes NO_SHOW variants in cancellation comparison", () => {
    const entries: LedgerInput[] = [
      makeLedgerEntry("NO_SHOW_THEM", -1.0, 1),
      makeLedgerEntry("NO_SHOW_THEM", -1.0, 2),
      makeLedgerEntry("ATTENDED", 1.0, 3),
    ];
    const score = computeReciprocityScore(entries);
    // They have 2 negative actions, I have 0 -- reciprocity > 0.5
    expect(score).toBeGreaterThan(0.5);
  });

  it("includes MOVED_LAST_MINUTE variants", () => {
    const entries: LedgerInput[] = [
      makeLedgerEntry("MOVED_LAST_MINUTE_ME", 0.0, 1),
      makeLedgerEntry("MOVED_LAST_MINUTE_ME", 0.0, 2),
      makeLedgerEntry("ATTENDED", 1.0, 3),
    ];
    const score = computeReciprocityScore(entries);
    // I have 2 negative actions, they have 0 -- reciprocity < 0.5
    expect(score).toBeLessThan(0.5);
  });

  it("score is always clamped between 0.0 and 1.0", () => {
    // All cancellations by them
    const allThem: LedgerInput[] = Array.from({ length: 10 }, (_, i) =>
      makeLedgerEntry("CANCELED_BY_THEM", -0.5, i + 1),
    );
    const score = computeReciprocityScore(allThem);
    expect(score).toBeGreaterThanOrEqual(0.0);
    expect(score).toBeLessThanOrEqual(1.0);
  });

  it("rounds to 2 decimal places", () => {
    const entries: LedgerInput[] = [
      makeLedgerEntry("CANCELED_BY_THEM", -0.5, 1),
      makeLedgerEntry("CANCELED_BY_ME", 0.0, 2),
      makeLedgerEntry("ATTENDED", 1.0, 3),
      makeLedgerEntry("ATTENDED", 1.0, 4),
      makeLedgerEntry("ATTENDED", 1.0, 5),
    ];
    const score = computeReciprocityScore(entries);
    const rounded = Math.round(score * 100) / 100;
    expect(score).toBe(rounded);
  });
});

// ---------------------------------------------------------------------------
// computeReputation (combined)
// ---------------------------------------------------------------------------

describe("computeReputation", () => {
  it("returns neutral scores for empty ledger", () => {
    const result = computeReputation([], NOW);
    expect(result.reliability_score).toBe(0.5);
    expect(result.reciprocity_score).toBe(0.5);
    expect(result.total_interactions).toBe(0);
    expect(result.last_30_days).toBe(0);
    expect(result.computed_at).toBeTruthy();
  });

  it("counts total_interactions correctly", () => {
    const entries: LedgerInput[] = [
      makeLedgerEntry("ATTENDED", 1.0, 1),
      makeLedgerEntry("ATTENDED", 1.0, 10),
      makeLedgerEntry("CANCELED_BY_THEM", -0.5, 40),
    ];
    const result = computeReputation(entries, NOW);
    expect(result.total_interactions).toBe(3);
  });

  it("counts last_30_days correctly", () => {
    const entries: LedgerInput[] = [
      makeLedgerEntry("ATTENDED", 1.0, 1), // within 30 days
      makeLedgerEntry("ATTENDED", 1.0, 15), // within 30 days
      makeLedgerEntry("ATTENDED", 1.0, 29), // within 30 days
      makeLedgerEntry("CANCELED_BY_THEM", -0.5, 31), // outside 30 days
      makeLedgerEntry("NO_SHOW_THEM", -1.0, 60), // outside 30 days
    ];
    const result = computeReputation(entries, NOW);
    expect(result.last_30_days).toBe(3);
  });

  it("includes computed_at timestamp", () => {
    const result = computeReputation([], NOW);
    expect(result.computed_at).toBe("2026-02-15T12:00:00.000Z");
  });

  it("perfect attendance produces high reliability", () => {
    const entries: LedgerInput[] = [
      makeLedgerEntry("ATTENDED", 1.0, 1),
      makeLedgerEntry("ATTENDED", 1.0, 7),
      makeLedgerEntry("ATTENDED", 1.0, 14),
      makeLedgerEntry("ATTENDED", 1.0, 21),
      makeLedgerEntry("ATTENDED", 1.0, 28),
    ];
    const result = computeReputation(entries, NOW);
    expect(result.reliability_score).toBeGreaterThanOrEqual(0.95);
  });

  it("all no-shows produce low reliability", () => {
    const entries: LedgerInput[] = [
      makeLedgerEntry("NO_SHOW_THEM", -1.0, 1),
      makeLedgerEntry("NO_SHOW_THEM", -1.0, 7),
      makeLedgerEntry("NO_SHOW_THEM", -1.0, 14),
    ];
    const result = computeReputation(entries, NOW);
    expect(result.reliability_score).toBeLessThanOrEqual(0.05);
  });

  it("asymmetric cancellation is detected in reciprocity", () => {
    const entries: LedgerInput[] = [
      makeLedgerEntry("CANCELED_BY_THEM", -0.5, 1),
      makeLedgerEntry("CANCELED_BY_THEM", -0.5, 5),
      makeLedgerEntry("CANCELED_BY_THEM", -0.5, 10),
      makeLedgerEntry("ATTENDED", 1.0, 15),
    ];
    const result = computeReputation(entries, NOW);
    // They cancel 3 times, I cancel 0 -- reciprocity should be > 0.5
    expect(result.reciprocity_score).toBeGreaterThan(0.5);
  });

  it("boundary: entry exactly 30 days old counts in last_30_days", () => {
    const entries: LedgerInput[] = [
      makeLedgerEntry("ATTENDED", 1.0, 30),
    ];
    const result = computeReputation(entries, NOW);
    expect(result.last_30_days).toBe(1);
  });

  it("boundary: entry 31 days old does not count in last_30_days", () => {
    const entries: LedgerInput[] = [
      makeLedgerEntry("ATTENDED", 1.0, 31),
    ];
    const result = computeReputation(entries, NOW);
    expect(result.last_30_days).toBe(0);
  });
});
