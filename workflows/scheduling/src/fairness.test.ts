/**
 * Unit tests for fairness and priority scoring (TM-82s.3).
 *
 * Tests the pure functions that compute fairness adjustments, VIP weights,
 * multi-factor candidate scoring, and human-readable explanations.
 *
 * Covers:
 * - Fairness score computation from scheduling history
 * - VIP priority weight integration
 * - Multi-factor scoring: preference + fairness + VIP + constraints
 * - Human-readable explanation generation per candidate
 * - Scheduling history recording
 * - No participant consistently disadvantaged after multiple sessions
 */

import { describe, it, expect } from "vitest";
import {
  computeFairnessScore,
  applyVipWeight,
  computeMultiFactorScore,
  buildExplanation,
  recordSchedulingOutcome,
  type SchedulingHistoryEntry,
  type FairnessContext,
  type VipPolicy,
  type MultiFactorInput,
  type ScoreComponents,
} from "./fairness";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeHistory(
  overrides: Partial<SchedulingHistoryEntry> = {},
): SchedulingHistoryEntry {
  return {
    participant_hash: "alice_hash",
    sessions_participated: 5,
    sessions_preferred: 3,
    last_session_ts: "2026-03-01T10:00:00Z",
    ...overrides,
  };
}

function makeVipPolicy(overrides: Partial<VipPolicy> = {}): VipPolicy {
  return {
    participant_hash: "vip_hash",
    display_name: "Sarah - Investor",
    priority_weight: 2.0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// computeFairnessScore
// ---------------------------------------------------------------------------

describe("computeFairnessScore", () => {
  it("returns 1.0 (no adjustment) when no history exists", () => {
    const result = computeFairnessScore([]);
    expect(result.adjustment).toBe(1.0);
    expect(result.explanation).toContain("no history");
  });

  it("returns 1.0 when all participants have equal preference rates", () => {
    const history: SchedulingHistoryEntry[] = [
      makeHistory({ participant_hash: "alice", sessions_participated: 10, sessions_preferred: 5 }),
      makeHistory({ participant_hash: "bob", sessions_participated: 10, sessions_preferred: 5 }),
    ];
    const result = computeFairnessScore(history);
    expect(result.adjustment).toBe(1.0);
  });

  it("lowers score for participant who always gets preferred time", () => {
    const history: SchedulingHistoryEntry[] = [
      makeHistory({ participant_hash: "alice", sessions_participated: 10, sessions_preferred: 9 }),
      makeHistory({ participant_hash: "bob", sessions_participated: 10, sessions_preferred: 2 }),
    ];
    // Alice has 90% preferred rate, Bob has 20% -- score should be < 1.0
    // to lower priority for Alice's preferred times
    const result = computeFairnessScore(history, "alice");
    expect(result.adjustment).toBeLessThan(1.0);
    expect(result.adjustment).toBeGreaterThan(0);
    expect(result.explanation).toContain("fairness");
  });

  it("raises score for consistently disadvantaged participant", () => {
    const history: SchedulingHistoryEntry[] = [
      makeHistory({ participant_hash: "alice", sessions_participated: 10, sessions_preferred: 9 }),
      makeHistory({ participant_hash: "bob", sessions_participated: 10, sessions_preferred: 2 }),
    ];
    // Bob has been disadvantaged -- score should be > 1.0
    const result = computeFairnessScore(history, "bob");
    expect(result.adjustment).toBeGreaterThan(1.0);
    expect(result.explanation).toContain("fairness");
  });

  it("handles single participant (no fairness adjustment needed)", () => {
    const history: SchedulingHistoryEntry[] = [
      makeHistory({ participant_hash: "alice", sessions_participated: 10, sessions_preferred: 8 }),
    ];
    const result = computeFairnessScore(history, "alice");
    expect(result.adjustment).toBe(1.0);
  });

  it("handles zero sessions_participated gracefully", () => {
    const history: SchedulingHistoryEntry[] = [
      makeHistory({ participant_hash: "alice", sessions_participated: 0, sessions_preferred: 0 }),
      makeHistory({ participant_hash: "bob", sessions_participated: 0, sessions_preferred: 0 }),
    ];
    const result = computeFairnessScore(history, "alice");
    expect(result.adjustment).toBe(1.0);
  });

  it("fairness adjustment is bounded between 0.5 and 1.5", () => {
    // Extreme case: one participant got every preferred time, other got none
    const history: SchedulingHistoryEntry[] = [
      makeHistory({ participant_hash: "alice", sessions_participated: 100, sessions_preferred: 100 }),
      makeHistory({ participant_hash: "bob", sessions_participated: 100, sessions_preferred: 0 }),
    ];
    const aliceResult = computeFairnessScore(history, "alice");
    expect(aliceResult.adjustment).toBeGreaterThanOrEqual(0.5);

    const bobResult = computeFairnessScore(history, "bob");
    expect(bobResult.adjustment).toBeLessThanOrEqual(1.5);
  });
});

// ---------------------------------------------------------------------------
// applyVipWeight
// ---------------------------------------------------------------------------

describe("applyVipWeight", () => {
  it("returns weight of 1.0 when no VIP policies match", () => {
    const result = applyVipWeight([], ["unknown_hash"]);
    expect(result.weight).toBe(1.0);
    expect(result.explanation).toBeNull();
  });

  it("returns VIP priority_weight when participant matches", () => {
    const policies = [makeVipPolicy({ participant_hash: "vip_hash", priority_weight: 2.5 })];
    const result = applyVipWeight(policies, ["vip_hash"]);
    expect(result.weight).toBe(2.5);
    expect(result.explanation).toContain("VIP");
    expect(result.explanation).toContain("Sarah - Investor");
  });

  it("uses highest VIP weight when multiple match", () => {
    const policies = [
      makeVipPolicy({ participant_hash: "vip1", priority_weight: 1.5, display_name: "VIP A" }),
      makeVipPolicy({ participant_hash: "vip2", priority_weight: 3.0, display_name: "VIP B" }),
    ];
    const result = applyVipWeight(policies, ["vip1", "vip2"]);
    expect(result.weight).toBe(3.0);
    expect(result.explanation).toContain("VIP B");
  });

  it("returns 1.0 when participant list is empty", () => {
    const policies = [makeVipPolicy()];
    const result = applyVipWeight(policies, []);
    expect(result.weight).toBe(1.0);
  });

  it("returns 1.0 when policies list is empty", () => {
    const result = applyVipWeight([], ["some_hash"]);
    expect(result.weight).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// computeMultiFactorScore
// ---------------------------------------------------------------------------

describe("computeMultiFactorScore", () => {
  it("computes combined score from all factors", () => {
    const input: MultiFactorInput = {
      timePreferenceScore: 20,
      constraintScore: 15,
      fairnessAdjustment: 1.0,
      vipWeight: 1.0,
    };
    const result = computeMultiFactorScore(input);
    // (20 + 15) * 1.0 * 1.0 = 35
    expect(result.finalScore).toBe(35);
  });

  it("applies fairness adjustment as multiplier", () => {
    const input: MultiFactorInput = {
      timePreferenceScore: 20,
      constraintScore: 10,
      fairnessAdjustment: 0.8,
      vipWeight: 1.0,
    };
    const result = computeMultiFactorScore(input);
    // (20 + 10) * 0.8 * 1.0 = 24
    expect(result.finalScore).toBe(24);
  });

  it("applies VIP weight as multiplier", () => {
    const input: MultiFactorInput = {
      timePreferenceScore: 20,
      constraintScore: 10,
      fairnessAdjustment: 1.0,
      vipWeight: 2.0,
    };
    const result = computeMultiFactorScore(input);
    // (20 + 10) * 1.0 * 2.0 = 60
    expect(result.finalScore).toBe(60);
  });

  it("applies both fairness and VIP simultaneously", () => {
    const input: MultiFactorInput = {
      timePreferenceScore: 20,
      constraintScore: 10,
      fairnessAdjustment: 0.9,
      vipWeight: 2.0,
    };
    const result = computeMultiFactorScore(input);
    // (20 + 10) * 0.9 * 2.0 = 54
    expect(result.finalScore).toBe(54);
  });

  it("returns components in result for transparency", () => {
    const input: MultiFactorInput = {
      timePreferenceScore: 25,
      constraintScore: 15,
      fairnessAdjustment: 0.85,
      vipWeight: 1.5,
    };
    const result = computeMultiFactorScore(input);
    expect(result.components.timePreferenceScore).toBe(25);
    expect(result.components.constraintScore).toBe(15);
    expect(result.components.fairnessAdjustment).toBe(0.85);
    expect(result.components.vipWeight).toBe(1.5);
  });

  it("handles zero base score", () => {
    const input: MultiFactorInput = {
      timePreferenceScore: 0,
      constraintScore: 0,
      fairnessAdjustment: 1.0,
      vipWeight: 2.0,
    };
    const result = computeMultiFactorScore(input);
    expect(result.finalScore).toBe(0);
  });

  it("handles negative constraint scores", () => {
    const input: MultiFactorInput = {
      timePreferenceScore: 20,
      constraintScore: -15,
      fairnessAdjustment: 1.0,
      vipWeight: 1.0,
    };
    const result = computeMultiFactorScore(input);
    // (20 + (-15)) * 1.0 * 1.0 = 5
    expect(result.finalScore).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// buildExplanation
// ---------------------------------------------------------------------------

describe("buildExplanation", () => {
  it("builds human-readable explanation with all components", () => {
    const components: ScoreComponents = {
      timePreferenceScore: 20,
      constraintScore: 15,
      fairnessAdjustment: 0.85,
      vipWeight: 2.0,
      baseExplanation: "morning slot (+20), within working hours (+15)",
      fairnessExplanation: "fairness adjustment for alice (0.85x)",
      vipExplanation: "VIP priority: Sarah - Investor (2.0x)",
    };

    const result = buildExplanation(components);
    expect(result).toContain("morning slot");
    expect(result).toContain("working hours");
    expect(result).toContain("fairness");
    expect(result).toContain("VIP");
  });

  it("omits fairness when adjustment is 1.0", () => {
    const components: ScoreComponents = {
      timePreferenceScore: 20,
      constraintScore: 0,
      fairnessAdjustment: 1.0,
      vipWeight: 1.0,
      baseExplanation: "morning slot (+20)",
      fairnessExplanation: null,
      vipExplanation: null,
    };

    const result = buildExplanation(components);
    expect(result).toContain("morning slot");
    expect(result).not.toContain("fairness");
    expect(result).not.toContain("VIP");
  });

  it("includes VIP when weight > 1.0", () => {
    const components: ScoreComponents = {
      timePreferenceScore: 10,
      constraintScore: 5,
      fairnessAdjustment: 1.0,
      vipWeight: 2.5,
      baseExplanation: "afternoon slot (+10)",
      fairnessExplanation: null,
      vipExplanation: "VIP priority: Board Member (2.5x)",
    };

    const result = buildExplanation(components);
    expect(result).toContain("VIP");
    expect(result).toContain("Board Member");
  });

  it("includes only fairness when VIP is 1.0", () => {
    const components: ScoreComponents = {
      timePreferenceScore: 20,
      constraintScore: 0,
      fairnessAdjustment: 0.7,
      vipWeight: 1.0,
      baseExplanation: "morning slot (+20)",
      fairnessExplanation: "fairness adjustment for bob (0.7x)",
      vipExplanation: null,
    };

    const result = buildExplanation(components);
    expect(result).toContain("fairness");
    expect(result).not.toContain("VIP");
  });
});

// ---------------------------------------------------------------------------
// recordSchedulingOutcome
// ---------------------------------------------------------------------------

describe("recordSchedulingOutcome", () => {
  it("creates history entries for all participants", () => {
    const participantHashes = ["alice", "bob", "charlie"];
    const preferredParticipant = "alice"; // Alice got her preferred time

    const entries = recordSchedulingOutcome(
      "ses_123",
      participantHashes,
      preferredParticipant,
      "2026-03-02T10:00:00Z",
    );

    expect(entries.length).toBe(3);

    const alice = entries.find((e) => e.participant_hash === "alice");
    expect(alice).toBeDefined();
    expect(alice!.got_preferred).toBe(true);

    const bob = entries.find((e) => e.participant_hash === "bob");
    expect(bob).toBeDefined();
    expect(bob!.got_preferred).toBe(false);
  });

  it("marks all as non-preferred when no one got their preferred time", () => {
    const entries = recordSchedulingOutcome(
      "ses_456",
      ["alice", "bob"],
      null, // No one got preferred
      "2026-03-02T10:00:00Z",
    );

    for (const entry of entries) {
      expect(entry.got_preferred).toBe(false);
    }
  });

  it("records session ID and timestamp on all entries", () => {
    const ts = "2026-03-05T14:00:00Z";
    const entries = recordSchedulingOutcome("ses_789", ["alice"], "alice", ts);

    expect(entries[0].session_id).toBe("ses_789");
    expect(entries[0].scheduled_ts).toBe(ts);
  });

  it("returns empty array when no participants", () => {
    const entries = recordSchedulingOutcome("ses_000", [], null, "2026-03-02T10:00:00Z");
    expect(entries.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Integration: fairness prevents consistent disadvantage
// ---------------------------------------------------------------------------

describe("fairness prevents consistent disadvantage", () => {
  it("after multiple sessions favoring Alice, Bob gets priority boost", () => {
    // Simulate history: Alice got preferred 8/10 times, Bob 2/10
    const history: SchedulingHistoryEntry[] = [
      makeHistory({ participant_hash: "alice", sessions_participated: 10, sessions_preferred: 8 }),
      makeHistory({ participant_hash: "bob", sessions_participated: 10, sessions_preferred: 2 }),
    ];

    const aliceFairness = computeFairnessScore(history, "alice");
    const bobFairness = computeFairnessScore(history, "bob");

    // Bob should get a higher fairness boost than Alice
    expect(bobFairness.adjustment).toBeGreaterThan(aliceFairness.adjustment);

    // Now compute final scores for two candidate slots:
    // Slot A: Alice prefers (higher time preference for Alice)
    // Slot B: Bob prefers (higher time preference for Bob)
    const slotA = computeMultiFactorScore({
      timePreferenceScore: 30,
      constraintScore: 10,
      fairnessAdjustment: aliceFairness.adjustment,
      vipWeight: 1.0,
    });

    const slotB = computeMultiFactorScore({
      timePreferenceScore: 25,
      constraintScore: 10,
      fairnessAdjustment: bobFairness.adjustment,
      vipWeight: 1.0,
    });

    // Even though Slot A has higher base preference score,
    // fairness adjustment should boost Slot B enough to compete
    // (Bob's boost should make his lower preference score competitive)
    expect(slotB.finalScore).toBeGreaterThanOrEqual(slotA.finalScore * 0.9);
  });

  it("VIP status can override fairness for important meetings", () => {
    const history: SchedulingHistoryEntry[] = [
      makeHistory({ participant_hash: "alice", sessions_participated: 10, sessions_preferred: 9 }),
      makeHistory({ participant_hash: "vip_investor", sessions_participated: 10, sessions_preferred: 1 }),
    ];

    // Alice has been advantaged, investor disadvantaged
    // But investor is VIP with weight 3.0
    const aliceFairness = computeFairnessScore(history, "alice");
    const vipPolicies = [makeVipPolicy({ participant_hash: "vip_investor", priority_weight: 3.0 })];
    const vipWeight = applyVipWeight(vipPolicies, ["vip_investor"]);

    const aliceSlot = computeMultiFactorScore({
      timePreferenceScore: 30,
      constraintScore: 10,
      fairnessAdjustment: aliceFairness.adjustment,
      vipWeight: 1.0,
    });

    const vipSlot = computeMultiFactorScore({
      timePreferenceScore: 20,
      constraintScore: 10,
      fairnessAdjustment: 1.0, // VIP fairness handled separately
      vipWeight: vipWeight.weight,
    });

    // VIP slot should score higher despite lower base preference
    expect(vipSlot.finalScore).toBeGreaterThan(aliceSlot.finalScore);
  });
});
