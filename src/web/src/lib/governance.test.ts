/**
 * Unit tests for governance types and helpers.
 *
 * Tests the pure functions in lib/governance.ts: complianceStatus,
 * complianceColor, complianceBgColor, complianceLabel, toChartData,
 * chartMaxHours, barPercent, aggregateTimeAllocations, formatHours.
 */
import { describe, it, expect } from "vitest";
import {
  complianceStatus,
  complianceColor,
  complianceBgColor,
  complianceLabel,
  toChartData,
  chartMaxHours,
  barPercent,
  aggregateTimeAllocations,
  formatHours,
  COLOR_COMPLIANT,
  COLOR_UNDER,
  COLOR_OVER,
  BG_COMPLIANT,
  BG_UNDER,
  BG_OVER,
  type Commitment,
  type ComplianceStatus,
} from "./governance";

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const MOCK_COMMITMENTS: Commitment[] = [
  {
    commitment_id: "cmt_1",
    client_name: "Acme Corp",
    target_hours: 40,
    actual_hours: 38,
    period_start: "2026-02-10",
    period_end: "2026-02-16",
  },
  {
    commitment_id: "cmt_2",
    client_name: "Globex Inc",
    target_hours: 20,
    actual_hours: 12,
    period_start: "2026-02-10",
    period_end: "2026-02-16",
  },
  {
    commitment_id: "cmt_3",
    client_name: "Initech",
    target_hours: 10,
    actual_hours: 15,
    period_start: "2026-02-10",
    period_end: "2026-02-16",
  },
];

// ---------------------------------------------------------------------------
// complianceStatus
// ---------------------------------------------------------------------------

describe("complianceStatus", () => {
  it("returns compliant when actual is exactly at target", () => {
    expect(complianceStatus(40, 40)).toBe("compliant");
  });

  it("returns compliant when actual is within +10% of target", () => {
    expect(complianceStatus(44, 40)).toBe("compliant");
  });

  it("returns compliant when actual is within -10% of target", () => {
    expect(complianceStatus(36, 40)).toBe("compliant");
  });

  it("returns under when actual is more than 10% below target", () => {
    expect(complianceStatus(35, 40)).toBe("under");
  });

  it("returns over when actual is more than 10% above target", () => {
    expect(complianceStatus(45, 40)).toBe("over");
  });

  it("returns compliant for 0 actual with 0 target", () => {
    expect(complianceStatus(0, 0)).toBe("compliant");
  });

  it("returns over for any actual with 0 target", () => {
    expect(complianceStatus(5, 0)).toBe("over");
  });

  it("returns under for 0 actual with nonzero target", () => {
    expect(complianceStatus(0, 10)).toBe("under");
  });

  it("boundary: exactly at 90% is compliant", () => {
    // 90% of 100 = 90, ratio = 0.9, NOT < 0.9
    expect(complianceStatus(90, 100)).toBe("compliant");
  });

  it("boundary: exactly at 110% is compliant", () => {
    // 110% of 100 = 110, ratio = 1.1, NOT > 1.1
    expect(complianceStatus(110, 100)).toBe("compliant");
  });

  it("boundary: just below 90% is under", () => {
    // 89/100 = 0.89 < 0.9
    expect(complianceStatus(89, 100)).toBe("under");
  });

  it("boundary: just above 110% is over", () => {
    // 111/100 = 1.11 > 1.1
    expect(complianceStatus(111, 100)).toBe("over");
  });
});

// ---------------------------------------------------------------------------
// complianceColor
// ---------------------------------------------------------------------------

describe("complianceColor", () => {
  it("returns green for compliant", () => {
    expect(complianceColor("compliant")).toBe(COLOR_COMPLIANT);
  });

  it("returns yellow for under", () => {
    expect(complianceColor("under")).toBe(COLOR_UNDER);
  });

  it("returns blue for over", () => {
    expect(complianceColor("over")).toBe(COLOR_OVER);
  });
});

// ---------------------------------------------------------------------------
// complianceBgColor
// ---------------------------------------------------------------------------

describe("complianceBgColor", () => {
  it("returns dark green for compliant", () => {
    expect(complianceBgColor("compliant")).toBe(BG_COMPLIANT);
  });

  it("returns dark yellow for under", () => {
    expect(complianceBgColor("under")).toBe(BG_UNDER);
  });

  it("returns dark blue for over", () => {
    expect(complianceBgColor("over")).toBe(BG_OVER);
  });
});

// ---------------------------------------------------------------------------
// complianceLabel
// ---------------------------------------------------------------------------

describe("complianceLabel", () => {
  it("returns On Track for compliant", () => {
    expect(complianceLabel("compliant")).toBe("On Track");
  });

  it("returns Under Target for under", () => {
    expect(complianceLabel("under")).toBe("Under Target");
  });

  it("returns Over Target for over", () => {
    expect(complianceLabel("over")).toBe("Over Target");
  });
});

// ---------------------------------------------------------------------------
// toChartData
// ---------------------------------------------------------------------------

describe("toChartData", () => {
  it("transforms commitments to chart data points", () => {
    const data = toChartData(MOCK_COMMITMENTS);
    expect(data).toHaveLength(3);
  });

  it("preserves client name and hours", () => {
    const data = toChartData(MOCK_COMMITMENTS);
    expect(data[0].client_name).toBe("Acme Corp");
    expect(data[0].target_hours).toBe(40);
    expect(data[0].actual_hours).toBe(38);
  });

  it("computes compliance status for each point", () => {
    const data = toChartData(MOCK_COMMITMENTS);
    // Acme: 38/40 = 0.95 -> compliant
    expect(data[0].compliance_status).toBe("compliant");
    // Globex: 12/20 = 0.6 -> under
    expect(data[1].compliance_status).toBe("under");
    // Initech: 15/10 = 1.5 -> over
    expect(data[2].compliance_status).toBe("over");
  });

  it("returns empty array for empty input", () => {
    expect(toChartData([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// chartMaxHours
// ---------------------------------------------------------------------------

describe("chartMaxHours", () => {
  it("returns the maximum of all target and actual hours", () => {
    const data = toChartData(MOCK_COMMITMENTS);
    // Max is 40 (Acme target)
    expect(chartMaxHours(data)).toBe(40);
  });

  it("returns at least 1 for empty data", () => {
    expect(chartMaxHours([])).toBe(1);
  });

  it("returns at least 1 when all values are 0", () => {
    expect(chartMaxHours([{
      client_name: "Zero",
      target_hours: 0,
      actual_hours: 0,
      compliance_status: "compliant",
    }])).toBe(1);
  });

  it("considers actual hours that exceed target", () => {
    const data = toChartData([{
      commitment_id: "cmt_x",
      client_name: "Big Actual",
      target_hours: 10,
      actual_hours: 50,
      period_start: "2026-02-10",
      period_end: "2026-02-16",
    }]);
    expect(chartMaxHours(data)).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// barPercent
// ---------------------------------------------------------------------------

describe("barPercent", () => {
  it("returns 50 for 20 out of 40", () => {
    expect(barPercent(20, 40)).toBe(50);
  });

  it("returns 100 for value equal to max", () => {
    expect(barPercent(40, 40)).toBe(100);
  });

  it("returns 0 for 0 hours", () => {
    expect(barPercent(0, 40)).toBe(0);
  });

  it("caps at 100 even if hours exceed max", () => {
    expect(barPercent(50, 40)).toBe(100);
  });

  it("returns 0 when maxHours is 0", () => {
    expect(barPercent(10, 0)).toBe(0);
  });

  it("rounds to nearest integer", () => {
    // 33/100 = 33%
    expect(barPercent(33, 100)).toBe(33);
    // 1/3 = 33.33... -> 33
    expect(barPercent(1, 3)).toBe(33);
  });
});

// ---------------------------------------------------------------------------
// aggregateTimeAllocations
// ---------------------------------------------------------------------------

describe("aggregateTimeAllocations", () => {
  it("returns empty array for empty input", () => {
    expect(aggregateTimeAllocations([], "weekly")).toEqual([]);
    expect(aggregateTimeAllocations([], "monthly")).toEqual([]);
  });

  it("aggregates into weekly periods", () => {
    const result = aggregateTimeAllocations(MOCK_COMMITMENTS, "weekly");
    expect(result.length).toBeGreaterThan(0);
    // All three commitments are in the same week
    expect(result[0].allocations).toHaveLength(3);
  });

  it("computes total hours for weekly period", () => {
    const result = aggregateTimeAllocations(MOCK_COMMITMENTS, "weekly");
    // 38 + 12 + 15 = 65
    expect(result[0].total_hours).toBe(65);
  });

  it("aggregates into monthly periods", () => {
    const result = aggregateTimeAllocations(MOCK_COMMITMENTS, "monthly");
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].allocations).toHaveLength(3);
  });

  it("computes total hours for monthly period", () => {
    const result = aggregateTimeAllocations(MOCK_COMMITMENTS, "monthly");
    expect(result[0].total_hours).toBe(65);
  });

  it("produces a label for weekly periods", () => {
    const result = aggregateTimeAllocations(MOCK_COMMITMENTS, "weekly");
    expect(result[0].period_label).toMatch(/^Week \d+, \d{4}$/);
  });

  it("produces a label for monthly periods", () => {
    const result = aggregateTimeAllocations(MOCK_COMMITMENTS, "monthly");
    // e.g., "Feb 2026"
    expect(result[0].period_label).toMatch(/\w+ \d{4}/);
  });

  it("groups commitments from different periods separately", () => {
    const multiPeriod: Commitment[] = [
      {
        commitment_id: "cmt_a",
        client_name: "Client A",
        target_hours: 10,
        actual_hours: 8,
        period_start: "2026-01-05",
        period_end: "2026-01-11",
      },
      {
        commitment_id: "cmt_b",
        client_name: "Client A",
        target_hours: 10,
        actual_hours: 12,
        period_start: "2026-02-10",
        period_end: "2026-02-16",
      },
    ];
    const result = aggregateTimeAllocations(multiPeriod, "monthly");
    expect(result).toHaveLength(2);
  });

  it("sums hours for same client in same period", () => {
    const sameClient: Commitment[] = [
      {
        commitment_id: "cmt_a",
        client_name: "Client A",
        target_hours: 10,
        actual_hours: 5,
        period_start: "2026-02-10",
        period_end: "2026-02-16",
      },
      {
        commitment_id: "cmt_b",
        client_name: "Client A",
        target_hours: 10,
        actual_hours: 7,
        period_start: "2026-02-12",
        period_end: "2026-02-16",
      },
    ];
    const result = aggregateTimeAllocations(sameClient, "weekly");
    // Both are in the same week (Feb 10-16, 2026 is week 7)
    expect(result).toHaveLength(1);
    expect(result[0].allocations).toHaveLength(1);
    expect(result[0].allocations[0].hours).toBe(12);
    expect(result[0].total_hours).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// formatHours
// ---------------------------------------------------------------------------

describe("formatHours", () => {
  it("formats 0 as 0h", () => {
    expect(formatHours(0)).toBe("0h");
  });

  it("formats whole numbers without decimal", () => {
    expect(formatHours(10)).toBe("10h");
    expect(formatHours(1)).toBe("1h");
  });

  it("formats decimal numbers with one decimal place", () => {
    expect(formatHours(12.5)).toBe("12.5h");
    expect(formatHours(3.75)).toBe("3.8h");
  });

  it("formats large numbers", () => {
    expect(formatHours(100)).toBe("100h");
  });
});
