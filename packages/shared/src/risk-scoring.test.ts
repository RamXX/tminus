/**
 * Unit tests for temporal risk scoring engine.
 *
 * Tests the risk scoring engine which computes:
 *   - Burnout risk from cognitive load history
 *   - Travel overload from trip days vs working days
 *   - Strategic drift from allocation trends
 *   - Composite risk score with weighted average
 *   - Risk level classification (LOW / MODERATE / HIGH / CRITICAL)
 *   - Actionable recommendations generation
 *
 * TDD RED phase: all tests written before implementation.
 */

import { describe, it, expect } from "vitest";
import {
  RISK_LEVELS,
  computeBurnoutRisk,
  computeTravelOverload,
  computeStrategicDrift,
  computeOverallRisk,
  generateRiskRecommendations,
  getRiskLevel,
  type RiskLevel,
  type CognitiveLoadHistoryEntry,
  type CategoryAllocation,
  type RiskScoreResult,
} from "./risk-scoring";

// ---------------------------------------------------------------------------
// RISK_LEVELS constant
// ---------------------------------------------------------------------------

describe("RISK_LEVELS", () => {
  it("defines LOW as 0-30", () => {
    expect(RISK_LEVELS.LOW).toEqual({ min: 0, max: 30 });
  });

  it("defines MODERATE as 31-60", () => {
    expect(RISK_LEVELS.MODERATE).toEqual({ min: 31, max: 60 });
  });

  it("defines HIGH as 61-80", () => {
    expect(RISK_LEVELS.HIGH).toEqual({ min: 61, max: 80 });
  });

  it("defines CRITICAL as 81-100", () => {
    expect(RISK_LEVELS.CRITICAL).toEqual({ min: 81, max: 100 });
  });
});

// ---------------------------------------------------------------------------
// getRiskLevel
// ---------------------------------------------------------------------------

describe("getRiskLevel", () => {
  it("returns LOW for score 0", () => {
    expect(getRiskLevel(0)).toBe("LOW");
  });

  it("returns LOW for score 30", () => {
    expect(getRiskLevel(30)).toBe("LOW");
  });

  it("returns MODERATE for score 31", () => {
    expect(getRiskLevel(31)).toBe("MODERATE");
  });

  it("returns MODERATE for score 60", () => {
    expect(getRiskLevel(60)).toBe("MODERATE");
  });

  it("returns HIGH for score 61", () => {
    expect(getRiskLevel(61)).toBe("HIGH");
  });

  it("returns HIGH for score 80", () => {
    expect(getRiskLevel(80)).toBe("HIGH");
  });

  it("returns CRITICAL for score 81", () => {
    expect(getRiskLevel(81)).toBe("CRITICAL");
  });

  it("returns CRITICAL for score 100", () => {
    expect(getRiskLevel(100)).toBe("CRITICAL");
  });

  it("clamps negative scores to LOW", () => {
    expect(getRiskLevel(-5)).toBe("LOW");
  });

  it("clamps scores above 100 to CRITICAL", () => {
    expect(getRiskLevel(110)).toBe("CRITICAL");
  });
});

// ---------------------------------------------------------------------------
// computeBurnoutRisk
// ---------------------------------------------------------------------------

describe("computeBurnoutRisk", () => {
  it("returns 0 for empty history", () => {
    expect(computeBurnoutRisk([])).toBe(0);
  });

  it("returns 0 for low cognitive load history (all below 40)", () => {
    const history: CognitiveLoadHistoryEntry[] = [
      { date: "2025-06-01", score: 20 },
      { date: "2025-06-02", score: 25 },
      { date: "2025-06-03", score: 30 },
      { date: "2025-06-04", score: 15 },
      { date: "2025-06-05", score: 35 },
      { date: "2025-06-06", score: 10 },
      { date: "2025-06-07", score: 20 },
    ];
    expect(computeBurnoutRisk(history)).toBeLessThanOrEqual(30);
  });

  it("returns CRITICAL range (81-100) for sustained load >80 for 2+ weeks (14+ days)", () => {
    // 14 days of high cognitive load
    const history: CognitiveLoadHistoryEntry[] = [];
    for (let i = 0; i < 14; i++) {
      const date = new Date(2025, 5, 1 + i).toISOString().slice(0, 10);
      history.push({ date, score: 85 });
    }
    const risk = computeBurnoutRisk(history);
    expect(risk).toBeGreaterThanOrEqual(81);
    expect(risk).toBeLessThanOrEqual(100);
  });

  it("returns HIGH range (61-80) for sustained load >80 for 1 week (7 days)", () => {
    const history: CognitiveLoadHistoryEntry[] = [];
    for (let i = 0; i < 7; i++) {
      const date = new Date(2025, 5, 1 + i).toISOString().slice(0, 10);
      history.push({ date, score: 85 });
    }
    const risk = computeBurnoutRisk(history);
    expect(risk).toBeGreaterThanOrEqual(61);
    expect(risk).toBeLessThanOrEqual(80);
  });

  it("returns moderate risk for mixed high/low days", () => {
    const history: CognitiveLoadHistoryEntry[] = [
      { date: "2025-06-01", score: 85 },
      { date: "2025-06-02", score: 40 },
      { date: "2025-06-03", score: 90 },
      { date: "2025-06-04", score: 30 },
      { date: "2025-06-05", score: 85 },
      { date: "2025-06-06", score: 50 },
      { date: "2025-06-07", score: 20 },
    ];
    const risk = computeBurnoutRisk(history);
    // Not sustained enough for HIGH, but some spikes
    expect(risk).toBeGreaterThan(0);
    expect(risk).toBeLessThan(80);
  });

  it("considers only the most recent data when longer history is provided", () => {
    // 3 weeks of low load, followed by 2 weeks of high load
    const history: CognitiveLoadHistoryEntry[] = [];
    // Old low load
    for (let i = 0; i < 21; i++) {
      const date = new Date(2025, 4, 1 + i).toISOString().slice(0, 10);
      history.push({ date, score: 20 });
    }
    // Recent high load (14 days)
    for (let i = 0; i < 14; i++) {
      const date = new Date(2025, 4, 22 + i).toISOString().slice(0, 10);
      history.push({ date, score: 90 });
    }
    const risk = computeBurnoutRisk(history);
    // Recent sustained high load should result in CRITICAL
    expect(risk).toBeGreaterThanOrEqual(81);
  });

  it("returns a number between 0 and 100", () => {
    const history: CognitiveLoadHistoryEntry[] = [
      { date: "2025-06-01", score: 50 },
    ];
    const risk = computeBurnoutRisk(history);
    expect(risk).toBeGreaterThanOrEqual(0);
    expect(risk).toBeLessThanOrEqual(100);
  });
});

// ---------------------------------------------------------------------------
// computeTravelOverload
// ---------------------------------------------------------------------------

describe("computeTravelOverload", () => {
  it("returns 0 for no travel days", () => {
    expect(computeTravelOverload(0, 20)).toBe(0);
  });

  it("returns 0 for 0 working days (no division by zero)", () => {
    expect(computeTravelOverload(5, 0)).toBe(0);
  });

  it("returns LOW risk for 10% travel (2 of 20 days)", () => {
    const risk = computeTravelOverload(2, 20);
    expect(risk).toBeLessThanOrEqual(30);
  });

  it("returns MODERATE risk for 30% travel (6 of 20 days)", () => {
    const risk = computeTravelOverload(6, 20);
    expect(risk).toBeGreaterThan(30);
    expect(risk).toBeLessThanOrEqual(60);
  });

  it("returns HIGH risk for >40% travel (9 of 20 days)", () => {
    const risk = computeTravelOverload(9, 20);
    expect(risk).toBeGreaterThanOrEqual(61);
  });

  it("returns CRITICAL risk for extreme travel (16 of 20 days)", () => {
    const risk = computeTravelOverload(16, 20);
    expect(risk).toBeGreaterThanOrEqual(81);
  });

  it("clamps to 100 for 100% travel", () => {
    const risk = computeTravelOverload(20, 20);
    expect(risk).toBeLessThanOrEqual(100);
  });

  it("returns a number between 0 and 100", () => {
    const risk = computeTravelOverload(5, 20);
    expect(risk).toBeGreaterThanOrEqual(0);
    expect(risk).toBeLessThanOrEqual(100);
  });
});

// ---------------------------------------------------------------------------
// computeStrategicDrift
// ---------------------------------------------------------------------------

describe("computeStrategicDrift", () => {
  it("returns 0 for empty allocations", () => {
    expect(computeStrategicDrift([], [])).toBe(0);
  });

  it("returns 0 when allocations are identical", () => {
    const allocations: CategoryAllocation[] = [
      { category: "engineering", hours: 20 },
      { category: "sales", hours: 10 },
      { category: "admin", hours: 5 },
    ];
    expect(computeStrategicDrift(allocations, allocations)).toBe(0);
  });

  it("returns HIGH risk when admin hours increase significantly", () => {
    const historical: CategoryAllocation[] = [
      { category: "engineering", hours: 25 },
      { category: "sales", hours: 10 },
      { category: "admin", hours: 5 },
    ];
    const current: CategoryAllocation[] = [
      { category: "engineering", hours: 10 },
      { category: "sales", hours: 5 },
      { category: "admin", hours: 25 },
    ];
    const risk = computeStrategicDrift(current, historical);
    expect(risk).toBeGreaterThanOrEqual(61);
  });

  it("returns LOW risk when strategic categories dominate", () => {
    const historical: CategoryAllocation[] = [
      { category: "engineering", hours: 20 },
      { category: "client", hours: 10 },
      { category: "admin", hours: 5 },
    ];
    const current: CategoryAllocation[] = [
      { category: "engineering", hours: 22 },
      { category: "client", hours: 10 },
      { category: "admin", hours: 3 },
    ];
    const risk = computeStrategicDrift(current, historical);
    expect(risk).toBeLessThanOrEqual(30);
  });

  it("detects increasing misc/personal as drift", () => {
    const historical: CategoryAllocation[] = [
      { category: "engineering", hours: 30 },
      { category: "misc", hours: 2 },
      { category: "personal", hours: 3 },
    ];
    const current: CategoryAllocation[] = [
      { category: "engineering", hours: 15 },
      { category: "misc", hours: 10 },
      { category: "personal", hours: 10 },
    ];
    const risk = computeStrategicDrift(current, historical);
    expect(risk).toBeGreaterThan(30);
  });

  it("returns a number between 0 and 100", () => {
    const current: CategoryAllocation[] = [
      { category: "engineering", hours: 10 },
    ];
    const historical: CategoryAllocation[] = [
      { category: "engineering", hours: 20 },
    ];
    const risk = computeStrategicDrift(current, historical);
    expect(risk).toBeGreaterThanOrEqual(0);
    expect(risk).toBeLessThanOrEqual(100);
  });
});

// ---------------------------------------------------------------------------
// computeOverallRisk
// ---------------------------------------------------------------------------

describe("computeOverallRisk", () => {
  it("returns 0 when all components are 0", () => {
    expect(computeOverallRisk(0, 0, 0)).toBe(0);
  });

  it("returns 100 when all components are 100", () => {
    expect(computeOverallRisk(100, 100, 100)).toBe(100);
  });

  it("returns weighted average of components", () => {
    // With burnout=80, travel=40, drift=20
    // Weighted average should be between min and max
    const risk = computeOverallRisk(80, 40, 20);
    expect(risk).toBeGreaterThan(20);
    expect(risk).toBeLessThan(80);
  });

  it("burnout has the highest weight", () => {
    // When only burnout is high, overall should reflect burnout dominance
    const burnoutHigh = computeOverallRisk(100, 0, 0);
    const travelHigh = computeOverallRisk(0, 100, 0);
    const driftHigh = computeOverallRisk(0, 0, 100);

    expect(burnoutHigh).toBeGreaterThan(travelHigh);
    expect(burnoutHigh).toBeGreaterThan(driftHigh);
  });

  it("returns a number between 0 and 100", () => {
    const risk = computeOverallRisk(50, 60, 40);
    expect(risk).toBeGreaterThanOrEqual(0);
    expect(risk).toBeLessThanOrEqual(100);
  });
});

// ---------------------------------------------------------------------------
// generateRiskRecommendations
// ---------------------------------------------------------------------------

describe("generateRiskRecommendations", () => {
  it("returns empty array when all risks are LOW", () => {
    const recs = generateRiskRecommendations(10, 10, 10);
    expect(recs).toEqual([]);
  });

  it("generates burnout recommendation when burnout is HIGH", () => {
    const recs = generateRiskRecommendations(75, 10, 10);
    expect(recs.length).toBeGreaterThanOrEqual(1);
    expect(recs.some((r) => r.toLowerCase().includes("burnout") || r.toLowerCase().includes("cognitive"))).toBe(true);
  });

  it("generates burnout recommendation when burnout is CRITICAL", () => {
    const recs = generateRiskRecommendations(90, 10, 10);
    expect(recs.length).toBeGreaterThanOrEqual(1);
    expect(recs.some((r) => r.toLowerCase().includes("burnout") || r.toLowerCase().includes("immediate"))).toBe(true);
  });

  it("generates travel recommendation when travel overload is HIGH", () => {
    const recs = generateRiskRecommendations(10, 70, 10);
    expect(recs.length).toBeGreaterThanOrEqual(1);
    expect(recs.some((r) => r.toLowerCase().includes("travel"))).toBe(true);
  });

  it("generates drift recommendation when strategic drift is HIGH", () => {
    const recs = generateRiskRecommendations(10, 10, 70);
    expect(recs.length).toBeGreaterThanOrEqual(1);
    expect(recs.some((r) => r.toLowerCase().includes("strategic") || r.toLowerCase().includes("drift") || r.toLowerCase().includes("admin"))).toBe(true);
  });

  it("generates multiple recommendations when multiple risks are HIGH", () => {
    const recs = generateRiskRecommendations(80, 70, 65);
    expect(recs.length).toBeGreaterThanOrEqual(3);
  });

  it("returns strings that are actionable (not empty)", () => {
    const recs = generateRiskRecommendations(90, 80, 70);
    for (const rec of recs) {
      expect(typeof rec).toBe("string");
      expect(rec.length).toBeGreaterThan(10);
    }
  });

  it("generates MODERATE-level recommendation for moderate travel overload", () => {
    const recs = generateRiskRecommendations(10, 50, 10);
    expect(recs.length).toBeGreaterThanOrEqual(1);
    expect(recs.some((r) => r.toLowerCase().includes("travel"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Full integration: end-to-end risk scoring
// ---------------------------------------------------------------------------

describe("end-to-end risk scoring", () => {
  it("healthy schedule produces LOW overall risk", () => {
    const history: CognitiveLoadHistoryEntry[] = [];
    for (let i = 0; i < 14; i++) {
      const date = new Date(2025, 5, 1 + i).toISOString().slice(0, 10);
      history.push({ date, score: 30 });
    }

    const burnout = computeBurnoutRisk(history);
    const travel = computeTravelOverload(2, 20);
    const drift = computeStrategicDrift(
      [
        { category: "engineering", hours: 25 },
        { category: "admin", hours: 5 },
      ],
      [
        { category: "engineering", hours: 25 },
        { category: "admin", hours: 5 },
      ],
    );

    const overall = computeOverallRisk(burnout, travel, drift);
    const level = getRiskLevel(overall);

    expect(level).toBe("LOW");
    expect(generateRiskRecommendations(burnout, travel, drift)).toEqual([]);
  });

  it("overloaded schedule produces HIGH/CRITICAL overall risk", () => {
    const history: CognitiveLoadHistoryEntry[] = [];
    for (let i = 0; i < 14; i++) {
      const date = new Date(2025, 5, 1 + i).toISOString().slice(0, 10);
      history.push({ date, score: 90 });
    }

    const burnout = computeBurnoutRisk(history);
    const travel = computeTravelOverload(10, 20);
    const drift = computeStrategicDrift(
      [
        { category: "engineering", hours: 5 },
        { category: "admin", hours: 30 },
      ],
      [
        { category: "engineering", hours: 30 },
        { category: "admin", hours: 5 },
      ],
    );

    const overall = computeOverallRisk(burnout, travel, drift);
    const level = getRiskLevel(overall);

    expect(["HIGH", "CRITICAL"]).toContain(level);
    const recs = generateRiskRecommendations(burnout, travel, drift);
    expect(recs.length).toBeGreaterThanOrEqual(3);
  });
});
