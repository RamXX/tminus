/**
 * Unit tests for What-If Simulation Engine.
 *
 * Tests pure simulation functions that compute calendar impact
 * of accepting new commitments without modifying real data.
 *
 * TDD RED phase: these tests define the expected behavior.
 */

import { describe, it, expect } from "vitest";
import {
  simulate,
  computeWeeklyHours,
  countConflicts,
  checkConstraintViolations,
  computeBurnoutRiskDelta,
  computeCommitmentComplianceDelta,
  generateRecurringEvents,
  SIMULATION_WEEKS,
} from "./simulation";
import type {
  SimulationSnapshot,
  SimulationScenario,
  ImpactReport,
  SimulationEvent,
  SimulationConstraint,
  SimulationCommitment,
} from "./simulation";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** Helper to create an ISO datetime string for a given day and hour. */
function dt(dayOffset: number, hour: number, minute = 0): string {
  const d = new Date("2026-02-16T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + dayOffset);
  d.setUTCHours(hour, minute, 0, 0);
  return d.toISOString();
}

function makeEvent(
  id: string,
  dayOffset: number,
  startHour: number,
  endHour: number,
  opts?: { title?: string; clientId?: string },
): SimulationEvent {
  return {
    canonical_event_id: id,
    title: opts?.title ?? `Event ${id}`,
    start_ts: dt(dayOffset, startHour),
    end_ts: dt(dayOffset, endHour),
    all_day: false,
    status: "confirmed",
    client_id: opts?.clientId ?? null,
  };
}

function makeConstraint(
  kind: string,
  config: Record<string, unknown>,
): SimulationConstraint {
  return { kind, config_json: config };
}

function makeCommitment(
  clientId: string,
  targetHours: number,
  opts?: { windowType?: string; hardMinimum?: boolean },
): SimulationCommitment {
  return {
    commitment_id: `cmt-${clientId}`,
    client_id: clientId,
    client_name: `Client ${clientId}`,
    target_hours: targetHours,
    window_type: (opts?.windowType ?? "WEEKLY") as "WEEKLY" | "MONTHLY",
    rolling_window_weeks: 4,
    hard_minimum: opts?.hardMinimum ?? false,
  };
}

function baseSnapshot(): SimulationSnapshot {
  return {
    events: [
      // Mon 9-10 (1h)
      makeEvent("ev-1", 0, 9, 10, { title: "Standup", clientId: "acme" }),
      // Mon 10-12 (2h)
      makeEvent("ev-2", 0, 10, 12, { title: "Deep Work", clientId: "acme" }),
      // Tue 14-15 (1h)
      makeEvent("ev-3", 1, 14, 15, { title: "Client Call", clientId: "beta" }),
      // Wed 9-11 (2h)
      makeEvent("ev-4", 2, 9, 11, { title: "Planning", clientId: "acme" }),
      // Thu 13-14 (1h)
      makeEvent("ev-5", 3, 13, 14, { title: "1:1", clientId: "beta" }),
    ],
    constraints: [
      makeConstraint("working_hours", { start_hour: 9, end_hour: 17 }),
      makeConstraint("max_hours_per_day", { max_hours: 8 }),
    ],
    commitments: [
      makeCommitment("acme", 10),
      makeCommitment("beta", 5),
    ],
    simulation_start: "2026-02-16T00:00:00Z",
  };
}

// ---------------------------------------------------------------------------
// computeWeeklyHours
// ---------------------------------------------------------------------------

describe("computeWeeklyHours", () => {
  it("computes total hours from a list of events", () => {
    const events: SimulationEvent[] = [
      makeEvent("a", 0, 9, 10),   // 1h
      makeEvent("b", 0, 14, 16),  // 2h
      makeEvent("c", 1, 10, 11),  // 1h
    ];
    // Total = 4h over the events; weekly average depends on span
    const hours = computeWeeklyHours(events, "2026-02-16T00:00:00Z", SIMULATION_WEEKS);
    expect(hours).toBeGreaterThan(0);
    expect(typeof hours).toBe("number");
  });

  it("returns 0 for empty events", () => {
    const hours = computeWeeklyHours([], "2026-02-16T00:00:00Z", SIMULATION_WEEKS);
    expect(hours).toBe(0);
  });

  it("ignores cancelled events", () => {
    const events: SimulationEvent[] = [
      makeEvent("a", 0, 9, 10),
      { ...makeEvent("b", 0, 14, 16), status: "cancelled" },
    ];
    const hours = computeWeeklyHours(events, "2026-02-16T00:00:00Z", SIMULATION_WEEKS);
    // Only 1h event counts
    const hoursAllActive = computeWeeklyHours(
      [makeEvent("a", 0, 9, 10)],
      "2026-02-16T00:00:00Z",
      SIMULATION_WEEKS,
    );
    expect(hours).toBe(hoursAllActive);
  });

  it("ignores all-day events", () => {
    const events: SimulationEvent[] = [
      makeEvent("a", 0, 9, 10),
      { ...makeEvent("b", 1, 0, 0), all_day: true },
    ];
    const hours = computeWeeklyHours(events, "2026-02-16T00:00:00Z", SIMULATION_WEEKS);
    const hoursOnlyTimed = computeWeeklyHours(
      [makeEvent("a", 0, 9, 10)],
      "2026-02-16T00:00:00Z",
      SIMULATION_WEEKS,
    );
    expect(hours).toBe(hoursOnlyTimed);
  });
});

// ---------------------------------------------------------------------------
// countConflicts
// ---------------------------------------------------------------------------

describe("countConflicts", () => {
  it("returns 0 for non-overlapping events", () => {
    const events: SimulationEvent[] = [
      makeEvent("a", 0, 9, 10),
      makeEvent("b", 0, 10, 11),
      makeEvent("c", 0, 14, 15),
    ];
    expect(countConflicts(events)).toBe(0);
  });

  it("counts a pair of overlapping events as 1 conflict", () => {
    const events: SimulationEvent[] = [
      makeEvent("a", 0, 9, 11),
      makeEvent("b", 0, 10, 12),
    ];
    expect(countConflicts(events)).toBe(1);
  });

  it("counts multiple conflicts correctly", () => {
    const events: SimulationEvent[] = [
      makeEvent("a", 0, 9, 11),  // overlaps with b
      makeEvent("b", 0, 10, 12), // overlaps with a and c
      makeEvent("c", 0, 11, 13), // overlaps with b
    ];
    // a-b overlap, b-c overlap = 2 conflict pairs
    expect(countConflicts(events)).toBe(2);
  });

  it("ignores cancelled events in conflict counting", () => {
    const events: SimulationEvent[] = [
      makeEvent("a", 0, 9, 11),
      { ...makeEvent("b", 0, 10, 12), status: "cancelled" },
    ];
    expect(countConflicts(events)).toBe(0);
  });

  it("ignores all-day events in conflict counting", () => {
    const events: SimulationEvent[] = [
      makeEvent("a", 0, 9, 11),
      { ...makeEvent("b", 0, 0, 0), all_day: true },
    ];
    expect(countConflicts(events)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// checkConstraintViolations
// ---------------------------------------------------------------------------

describe("checkConstraintViolations", () => {
  it("returns empty array when no constraints are violated", () => {
    const events: SimulationEvent[] = [
      makeEvent("a", 0, 9, 10),
      makeEvent("b", 0, 14, 15),
    ];
    const constraints: SimulationConstraint[] = [
      makeConstraint("working_hours", { start_hour: 9, end_hour: 17 }),
    ];
    expect(checkConstraintViolations(events, constraints)).toEqual([]);
  });

  it("detects working_hours violation", () => {
    const events: SimulationEvent[] = [
      makeEvent("a", 0, 7, 8),  // before 9am
    ];
    const constraints: SimulationConstraint[] = [
      makeConstraint("working_hours", { start_hour: 9, end_hour: 17 }),
    ];
    const violations = checkConstraintViolations(events, constraints);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]).toContain("working_hours");
  });

  it("detects working_hours violation for events ending after hours", () => {
    const events: SimulationEvent[] = [
      makeEvent("a", 0, 16, 18),  // ends after 17
    ];
    const constraints: SimulationConstraint[] = [
      makeConstraint("working_hours", { start_hour: 9, end_hour: 17 }),
    ];
    const violations = checkConstraintViolations(events, constraints);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]).toContain("working_hours");
  });

  it("detects max_hours_per_day violation", () => {
    // 9h of meetings on one day exceeds 8h max
    const events: SimulationEvent[] = [
      makeEvent("a", 0, 8, 12),   // 4h
      makeEvent("b", 0, 12, 17),  // 5h
    ];
    const constraints: SimulationConstraint[] = [
      makeConstraint("max_hours_per_day", { max_hours: 8 }),
    ];
    const violations = checkConstraintViolations(events, constraints);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]).toContain("max_hours_per_day");
  });

  it("detects no_meetings_after violation", () => {
    const events: SimulationEvent[] = [
      makeEvent("a", 0, 20, 21),  // 8pm-9pm
    ];
    const constraints: SimulationConstraint[] = [
      makeConstraint("no_meetings_after", { hour: 18 }),
    ];
    const violations = checkConstraintViolations(events, constraints);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]).toContain("no_meetings_after");
  });

  it("handles unknown constraint kinds gracefully", () => {
    const events: SimulationEvent[] = [
      makeEvent("a", 0, 9, 10),
    ];
    const constraints: SimulationConstraint[] = [
      makeConstraint("unknown_kind", { foo: "bar" }),
    ];
    // Unknown constraints should not cause violations
    expect(checkConstraintViolations(events, constraints)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// computeBurnoutRiskDelta
// ---------------------------------------------------------------------------

describe("computeBurnoutRiskDelta", () => {
  it("returns 0 when hours are unchanged", () => {
    expect(computeBurnoutRiskDelta(40, 40)).toBe(0);
  });

  it("returns positive value when hours increase", () => {
    const delta = computeBurnoutRiskDelta(40, 50);
    expect(delta).toBeGreaterThan(0);
    expect(delta).toBeLessThanOrEqual(1);
  });

  it("returns negative value when hours decrease", () => {
    const delta = computeBurnoutRiskDelta(50, 40);
    expect(delta).toBeLessThan(0);
    expect(delta).toBeGreaterThanOrEqual(-1);
  });

  it("clamps to [-1, 1] range", () => {
    // Massive increase
    expect(computeBurnoutRiskDelta(10, 100)).toBeLessThanOrEqual(1);
    expect(computeBurnoutRiskDelta(10, 100)).toBeGreaterThanOrEqual(-1);
    // Massive decrease
    expect(computeBurnoutRiskDelta(100, 10)).toBeLessThanOrEqual(1);
    expect(computeBurnoutRiskDelta(100, 10)).toBeGreaterThanOrEqual(-1);
  });

  it("handles zero baseline gracefully", () => {
    const delta = computeBurnoutRiskDelta(0, 10);
    expect(delta).toBeGreaterThan(0);
    expect(delta).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// computeCommitmentComplianceDelta
// ---------------------------------------------------------------------------

describe("computeCommitmentComplianceDelta", () => {
  it("returns before/after compliance for each commitment", () => {
    const commitments: SimulationCommitment[] = [
      makeCommitment("acme", 10),
    ];
    const beforeEvents: SimulationEvent[] = [
      // 3h for acme per week * 4 weeks = 12h
      makeEvent("a", 0, 9, 12, { clientId: "acme" }),
    ];
    const afterEvents: SimulationEvent[] = [
      ...beforeEvents,
      makeEvent("b", 1, 9, 12, { clientId: "acme" }), // +3h
    ];
    const result = computeCommitmentComplianceDelta(
      commitments,
      beforeEvents,
      afterEvents,
      "2026-02-16T00:00:00Z",
      SIMULATION_WEEKS,
    );
    expect(result).toHaveProperty("acme");
    expect(result.acme).toHaveProperty("before");
    expect(result.acme).toHaveProperty("after");
    expect(typeof result.acme.before).toBe("number");
    expect(typeof result.acme.after).toBe("number");
    expect(result.acme.after).toBeGreaterThanOrEqual(result.acme.before);
  });

  it("handles commitments with no matching events", () => {
    const commitments: SimulationCommitment[] = [
      makeCommitment("ghost", 10),
    ];
    const result = computeCommitmentComplianceDelta(
      commitments,
      [],
      [],
      "2026-02-16T00:00:00Z",
      SIMULATION_WEEKS,
    );
    expect(result).toHaveProperty("ghost");
    expect(result.ghost.before).toBe(0);
    expect(result.ghost.after).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// generateRecurringEvents
// ---------------------------------------------------------------------------

describe("generateRecurringEvents", () => {
  it("generates events for each week in simulation window", () => {
    const events = generateRecurringEvents(
      "Board Meeting",
      1,    // Tuesday (0=Mon for day_of_week)
      14,   // 2pm
      16,   // 4pm
      SIMULATION_WEEKS,
      "2026-02-16T00:00:00Z",
    );
    expect(events.length).toBe(SIMULATION_WEEKS);
    for (const ev of events) {
      expect(ev.title).toBe("Board Meeting");
      expect(ev.status).toBe("confirmed");
      expect(ev.all_day).toBe(false);
    }
  });

  it("generates events with correct duration", () => {
    const events = generateRecurringEvents(
      "Standup",
      0,    // Monday
      9,    // 9am
      9.5,  // 9:30am (30 min)
      SIMULATION_WEEKS,
      "2026-02-16T00:00:00Z",
    );
    for (const ev of events) {
      const start = new Date(ev.start_ts).getTime();
      const end = new Date(ev.end_ts).getTime();
      expect(end - start).toBe(30 * 60 * 1000); // 30 minutes
    }
  });

  it("respects custom duration_weeks", () => {
    const events = generateRecurringEvents(
      "Temp Meeting",
      3,    // Thursday
      10,
      11,
      2,    // Only 2 weeks
      "2026-02-16T00:00:00Z",
    );
    expect(events.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// simulate (main entry point)
// ---------------------------------------------------------------------------

describe("simulate", () => {
  describe("add_commitment scenario", () => {
    it("produces a valid impact report", () => {
      const snapshot = baseSnapshot();
      const scenario: SimulationScenario = {
        type: "add_commitment",
        client_id: "gamma",
        hours_per_week: 10,
      };
      const report = simulate(snapshot, scenario);

      expect(report).toHaveProperty("projected_weekly_hours");
      expect(report).toHaveProperty("conflict_count");
      expect(report).toHaveProperty("constraint_violations");
      expect(report).toHaveProperty("burnout_risk_delta");
      expect(report).toHaveProperty("commitment_compliance_delta");
      expect(Array.isArray(report.constraint_violations)).toBe(true);
      expect(typeof report.projected_weekly_hours).toBe("number");
      expect(typeof report.conflict_count).toBe("number");
      expect(typeof report.burnout_risk_delta).toBe("number");
    });

    it("increases projected hours for new commitment", () => {
      const snapshot = baseSnapshot();
      const beforeReport = simulate(snapshot, {
        type: "add_commitment",
        client_id: "gamma",
        hours_per_week: 0,
      });
      const afterReport = simulate(snapshot, {
        type: "add_commitment",
        client_id: "gamma",
        hours_per_week: 20,
      });

      expect(afterReport.projected_weekly_hours).toBeGreaterThan(
        beforeReport.projected_weekly_hours,
      );
    });

    it("adds new commitment to compliance tracking", () => {
      const snapshot = baseSnapshot();
      const report = simulate(snapshot, {
        type: "add_commitment",
        client_id: "gamma",
        hours_per_week: 10,
      });
      expect(report.commitment_compliance_delta).toHaveProperty("gamma");
    });

    it("does not modify the original snapshot", () => {
      const snapshot = baseSnapshot();
      const originalEventsCount = snapshot.events.length;
      const originalCommitmentsCount = snapshot.commitments.length;
      simulate(snapshot, {
        type: "add_commitment",
        client_id: "gamma",
        hours_per_week: 10,
      });
      expect(snapshot.events.length).toBe(originalEventsCount);
      expect(snapshot.commitments.length).toBe(originalCommitmentsCount);
    });
  });

  describe("add_recurring_event scenario", () => {
    it("produces a valid impact report", () => {
      const snapshot = baseSnapshot();
      const scenario: SimulationScenario = {
        type: "add_recurring_event",
        title: "Board Meeting",
        day_of_week: 4,   // Friday
        start_time: 14,
        end_time: 16,
        duration_weeks: SIMULATION_WEEKS,
      };
      const report = simulate(snapshot, scenario);

      expect(report.projected_weekly_hours).toBeGreaterThan(0);
      expect(typeof report.conflict_count).toBe("number");
      expect(Array.isArray(report.constraint_violations)).toBe(true);
    });

    it("increases weekly hours by the recurring event duration", () => {
      const snapshot = baseSnapshot();
      const baseReport = simulate(snapshot, {
        type: "add_recurring_event",
        title: "Nothing",
        day_of_week: 4,
        start_time: 14,
        end_time: 14, // 0 duration
        duration_weeks: SIMULATION_WEEKS,
      });
      const withMeeting = simulate(snapshot, {
        type: "add_recurring_event",
        title: "Board Meeting",
        day_of_week: 4,
        start_time: 14,
        end_time: 16,  // 2h per week
        duration_weeks: SIMULATION_WEEKS,
      });

      expect(withMeeting.projected_weekly_hours).toBeGreaterThan(
        baseReport.projected_weekly_hours,
      );
    });

    it("detects conflicts when recurring event overlaps existing", () => {
      const snapshot = baseSnapshot();
      // Mon 9-10 already has ev-1 (Standup)
      const report = simulate(snapshot, {
        type: "add_recurring_event",
        title: "Conflicting Meeting",
        day_of_week: 0,    // Monday
        start_time: 9,
        end_time: 10,
        duration_weeks: SIMULATION_WEEKS,
      });
      expect(report.conflict_count).toBeGreaterThan(0);
    });

    it("detects constraint violations for out-of-hours events", () => {
      const snapshot = baseSnapshot();
      const report = simulate(snapshot, {
        type: "add_recurring_event",
        title: "Late Night Call",
        day_of_week: 2,   // Wednesday
        start_time: 20,   // 8pm
        end_time: 21,     // 9pm
        duration_weeks: SIMULATION_WEEKS,
      });
      expect(report.constraint_violations.length).toBeGreaterThan(0);
    });
  });

  describe("change_working_hours scenario", () => {
    it("produces a valid impact report", () => {
      const snapshot = baseSnapshot();
      const scenario: SimulationScenario = {
        type: "change_working_hours",
        start_hour: 10,
        end_hour: 16,
      };
      const report = simulate(snapshot, scenario);

      expect(typeof report.projected_weekly_hours).toBe("number");
      expect(typeof report.conflict_count).toBe("number");
      expect(Array.isArray(report.constraint_violations)).toBe(true);
    });

    it("detects violations when narrowing hours makes events outside range", () => {
      const snapshot = baseSnapshot();
      // Narrowing to 10-16 should flag ev-1 (9-10am) as violation
      const report = simulate(snapshot, {
        type: "change_working_hours",
        start_hour: 10,
        end_hour: 16,
      });
      expect(report.constraint_violations.length).toBeGreaterThan(0);
    });

    it("no violations when widening hours", () => {
      const snapshot = baseSnapshot();
      // Widening to 7-22 should have no violations
      const report = simulate(snapshot, {
        type: "change_working_hours",
        start_hour: 7,
        end_hour: 22,
      });
      // Events are all between 9-17, so widening should not create violations
      // (unless max_hours_per_day is violated, but total hours are low)
      const workingHoursViolations = report.constraint_violations.filter(
        (v) => v.includes("working_hours"),
      );
      expect(workingHoursViolations.length).toBe(0);
    });
  });

  describe("burnout risk", () => {
    it("increases burnout risk when adding significant hours", () => {
      const snapshot = baseSnapshot();
      const report = simulate(snapshot, {
        type: "add_commitment",
        client_id: "gamma",
        hours_per_week: 30,
      });
      expect(report.burnout_risk_delta).toBeGreaterThan(0);
    });
  });

  describe("immutability", () => {
    it("does not modify snapshot events array", () => {
      const snapshot = baseSnapshot();
      const originalLength = snapshot.events.length;
      simulate(snapshot, {
        type: "add_recurring_event",
        title: "Test",
        day_of_week: 4,
        start_time: 14,
        end_time: 16,
        duration_weeks: 4,
      });
      expect(snapshot.events.length).toBe(originalLength);
    });

    it("does not modify snapshot constraints array", () => {
      const snapshot = baseSnapshot();
      const originalLength = snapshot.constraints.length;
      simulate(snapshot, {
        type: "change_working_hours",
        start_hour: 10,
        end_hour: 16,
      });
      expect(snapshot.constraints.length).toBe(originalLength);
    });

    it("does not modify snapshot commitments array", () => {
      const snapshot = baseSnapshot();
      const originalLength = snapshot.commitments.length;
      simulate(snapshot, {
        type: "add_commitment",
        client_id: "gamma",
        hours_per_week: 10,
      });
      expect(snapshot.commitments.length).toBe(originalLength);
    });
  });
});
