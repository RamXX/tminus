/**
 * @tminus/shared -- What-If Simulation Engine.
 *
 * Pure functions for simulating calendar impact of accepting new
 * commitments, adding recurring events, or changing working hours.
 *
 * "What if I accept this board seat?" -> shows projected time allocation,
 * conflict count, constraint violations, burnout risk delta.
 *
 * CRITICAL: Simulation does NOT modify real data. It takes a snapshot
 * of current events + constraints, applies a hypothetical scenario,
 * and computes projected metrics.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Number of weeks to project forward in simulation. */
export const SIMULATION_WEEKS = 4;

/** Standard working week hours used as burnout baseline (40h). */
const STANDARD_WORK_WEEK_HOURS = 40;

const MS_PER_HOUR = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal event shape needed for simulation computation. */
export interface SimulationEvent {
  readonly canonical_event_id: string;
  readonly title: string;
  readonly start_ts: string;
  readonly end_ts: string;
  readonly all_day: boolean;
  readonly status: string;
  /** Client ID for commitment tracking. Null if not billable. */
  readonly client_id: string | null;
}

/** Minimal constraint shape needed for simulation. */
export interface SimulationConstraint {
  readonly kind: string;
  readonly config_json: Record<string, unknown>;
}

/** Minimal commitment shape needed for simulation. */
export interface SimulationCommitment {
  readonly commitment_id: string;
  readonly client_id: string;
  readonly client_name: string | null;
  readonly target_hours: number;
  readonly window_type: "WEEKLY" | "MONTHLY";
  readonly rolling_window_weeks: number;
  readonly hard_minimum: boolean;
}

/**
 * A read-only snapshot of the user's current calendar state.
 * This is the input to the simulation engine -- it is never mutated.
 */
export interface SimulationSnapshot {
  readonly events: readonly SimulationEvent[];
  readonly constraints: readonly SimulationConstraint[];
  readonly commitments: readonly SimulationCommitment[];
  /** ISO 8601 timestamp marking the start of the simulation window. */
  readonly simulation_start: string;
}

/** Add a new time commitment scenario. */
export interface AddCommitmentScenario {
  readonly type: "add_commitment";
  readonly client_id: string;
  readonly hours_per_week: number;
}

/** Add a new recurring event scenario. */
export interface AddRecurringEventScenario {
  readonly type: "add_recurring_event";
  readonly title: string;
  /** Day of week: 0=Monday, 1=Tuesday, ..., 6=Sunday. */
  readonly day_of_week: number;
  /** Start time as decimal hour (e.g., 14 for 2pm, 9.5 for 9:30am). */
  readonly start_time: number;
  /** End time as decimal hour. */
  readonly end_time: number;
  /** How many weeks the recurring event spans. */
  readonly duration_weeks: number;
}

/** Change working hours scenario. */
export interface ChangeWorkingHoursScenario {
  readonly type: "change_working_hours";
  readonly start_hour: number;
  readonly end_hour: number;
}

/** Union of all simulation scenario types. */
export type SimulationScenario =
  | AddCommitmentScenario
  | AddRecurringEventScenario
  | ChangeWorkingHoursScenario;

/** Per-client compliance before/after the scenario. */
export interface ComplianceEntry {
  readonly before: number;
  readonly after: number;
}

/** The simulation impact report returned to the caller. */
export interface ImpactReport {
  /** Projected average weekly hours after applying the scenario. */
  readonly projected_weekly_hours: number;
  /** Number of time conflicts (overlapping event pairs) after scenario. */
  readonly conflict_count: number;
  /** Human-readable constraint violations detected after scenario. */
  readonly constraint_violations: string[];
  /** Change in burnout risk: -1 (less risk) to +1 (more risk). */
  readonly burnout_risk_delta: number;
  /**
   * Per-client commitment compliance: hours-per-week before vs after.
   * Keys are client IDs.
   */
  readonly commitment_compliance_delta: Record<string, ComplianceEntry>;
}

// ---------------------------------------------------------------------------
// Helper: event duration in hours
// ---------------------------------------------------------------------------

function eventHours(ev: SimulationEvent): number {
  if (ev.all_day || ev.status === "cancelled") return 0;
  const start = new Date(ev.start_ts).getTime();
  const end = new Date(ev.end_ts).getTime();
  const diff = end - start;
  return diff > 0 ? diff / MS_PER_HOUR : 0;
}

/** Filter to only timed, confirmed/tentative events. */
function activeTimedEvents(events: readonly SimulationEvent[]): SimulationEvent[] {
  return events.filter((ev) => !ev.all_day && ev.status !== "cancelled");
}

// ---------------------------------------------------------------------------
// Public: computeWeeklyHours
// ---------------------------------------------------------------------------

/**
 * Compute the average weekly hours from a set of events over a
 * simulation window of `weeks` weeks.
 *
 * Total event hours are divided by the number of weeks to get
 * the weekly average.
 */
export function computeWeeklyHours(
  events: readonly SimulationEvent[],
  _simulationStart: string,
  weeks: number,
): number {
  if (events.length === 0 || weeks <= 0) return 0;

  const totalHours = activeTimedEvents(events).reduce(
    (sum, ev) => sum + eventHours(ev),
    0,
  );

  return Math.round((totalHours / weeks) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Public: countConflicts
// ---------------------------------------------------------------------------

/**
 * Count the number of overlapping event pairs (conflicts).
 *
 * Two events conflict if their time ranges overlap and both are
 * confirmed/tentative timed events. Uses a sweep-line approach
 * for efficiency.
 */
export function countConflicts(events: readonly SimulationEvent[]): number {
  const timed = activeTimedEvents(events);
  if (timed.length < 2) return 0;

  // Sort by start time
  const sorted = [...timed].sort(
    (a, b) => new Date(a.start_ts).getTime() - new Date(b.start_ts).getTime(),
  );

  let conflicts = 0;
  for (let i = 0; i < sorted.length; i++) {
    const endI = new Date(sorted[i].end_ts).getTime();
    for (let j = i + 1; j < sorted.length; j++) {
      const startJ = new Date(sorted[j].start_ts).getTime();
      // If j starts at or after i ends, no more overlaps for i
      if (startJ >= endI) break;
      conflicts++;
    }
  }

  return conflicts;
}

// ---------------------------------------------------------------------------
// Public: checkConstraintViolations
// ---------------------------------------------------------------------------

/**
 * Check which constraints would be violated by the given set of events.
 *
 * Returns an array of human-readable violation descriptions.
 * Unknown constraint kinds are silently ignored (forward compatible).
 */
export function checkConstraintViolations(
  events: readonly SimulationEvent[],
  constraints: readonly SimulationConstraint[],
): string[] {
  const violations: string[] = [];
  const timed = activeTimedEvents(events);

  for (const constraint of constraints) {
    switch (constraint.kind) {
      case "working_hours": {
        const startHour = constraint.config_json.start_hour as number;
        const endHour = constraint.config_json.end_hour as number;
        if (typeof startHour !== "number" || typeof endHour !== "number") break;

        for (const ev of timed) {
          const evStartHour = new Date(ev.start_ts).getUTCHours();
          const evEndHour = new Date(ev.end_ts).getUTCHours();
          const evEndMinutes = new Date(ev.end_ts).getUTCMinutes();
          // End hour: if there are minutes, the event extends past that hour
          const effectiveEndHour = evEndMinutes > 0 ? evEndHour + 1 : evEndHour;

          if (evStartHour < startHour || effectiveEndHour > endHour) {
            violations.push(
              `working_hours: "${ev.title}" (${evStartHour}:00-${evEndHour}:${String(new Date(ev.end_ts).getUTCMinutes()).padStart(2, "0")}) falls outside ${startHour}:00-${endHour}:00`,
            );
          }
        }
        break;
      }

      case "max_hours_per_day": {
        const maxHours = constraint.config_json.max_hours as number;
        if (typeof maxHours !== "number") break;

        // Group events by date
        const byDate = new Map<string, number>();
        for (const ev of timed) {
          const dateKey = ev.start_ts.slice(0, 10); // YYYY-MM-DD
          const hours = eventHours(ev);
          byDate.set(dateKey, (byDate.get(dateKey) ?? 0) + hours);
        }

        for (const [date, hours] of byDate) {
          if (hours > maxHours) {
            violations.push(
              `max_hours_per_day: ${hours.toFixed(1)}h scheduled on ${date} exceeds ${maxHours}h limit`,
            );
          }
        }
        break;
      }

      case "no_meetings_after": {
        const hour = constraint.config_json.hour as number;
        if (typeof hour !== "number") break;

        for (const ev of timed) {
          const evStartHour = new Date(ev.start_ts).getUTCHours();
          if (evStartHour >= hour) {
            violations.push(
              `no_meetings_after: "${ev.title}" starts at ${evStartHour}:00, after ${hour}:00 cutoff`,
            );
          }
        }
        break;
      }

      // Unknown constraint kinds are silently ignored for forward compatibility
      default:
        break;
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Public: computeBurnoutRiskDelta
// ---------------------------------------------------------------------------

/**
 * Compute the burnout risk delta as a number from -1 to +1.
 *
 * Based on the change in weekly hours relative to a standard work week.
 * Uses a sigmoid-like scaling: larger changes produce proportionally
 * larger deltas, but always clamped to [-1, 1].
 *
 * @param beforeHours - Weekly hours before scenario
 * @param afterHours - Weekly hours after scenario
 * @returns Delta from -1 (risk decreased) to +1 (risk increased)
 */
export function computeBurnoutRiskDelta(
  beforeHours: number,
  afterHours: number,
): number {
  const hoursDiff = afterHours - beforeHours;
  if (hoursDiff === 0) return 0;

  // Scale relative to standard work week:
  // +40h change = delta of ~1.0, +20h = ~0.5, +10h = ~0.25
  const raw = hoursDiff / STANDARD_WORK_WEEK_HOURS;

  // Clamp to [-1, 1]
  return Math.round(Math.max(-1, Math.min(1, raw)) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Public: computeCommitmentComplianceDelta
// ---------------------------------------------------------------------------

/**
 * Compute per-client commitment compliance hours-per-week, before and
 * after the scenario.
 *
 * For each commitment, sums hours from events tagged with that client_id,
 * then divides by weeks to get weekly averages.
 */
export function computeCommitmentComplianceDelta(
  commitments: readonly SimulationCommitment[],
  beforeEvents: readonly SimulationEvent[],
  afterEvents: readonly SimulationEvent[],
  _simulationStart: string,
  weeks: number,
): Record<string, ComplianceEntry> {
  const result: Record<string, ComplianceEntry> = {};

  for (const cmt of commitments) {
    const beforeHours = sumClientHours(beforeEvents, cmt.client_id, weeks);
    const afterHours = sumClientHours(afterEvents, cmt.client_id, weeks);
    result[cmt.client_id] = {
      before: Math.round(beforeHours * 100) / 100,
      after: Math.round(afterHours * 100) / 100,
    };
  }

  return result;
}

/** Sum hours for a specific client_id and compute weekly average. */
function sumClientHours(
  events: readonly SimulationEvent[],
  clientId: string,
  weeks: number,
): number {
  if (weeks <= 0) return 0;
  const total = activeTimedEvents(events)
    .filter((ev) => ev.client_id === clientId)
    .reduce((sum, ev) => sum + eventHours(ev), 0);
  return total / weeks;
}

// ---------------------------------------------------------------------------
// Public: generateRecurringEvents
// ---------------------------------------------------------------------------

/**
 * Generate simulated recurring events for the simulation window.
 *
 * Creates one event per week on the specified day_of_week for the
 * given duration_weeks. Events are synthetic (prefixed "sim-").
 *
 * @param title - Event title
 * @param dayOfWeek - 0=Monday, 1=Tuesday, ..., 6=Sunday
 * @param startTime - Start hour as decimal (14 = 2pm, 9.5 = 9:30am)
 * @param endTime - End hour as decimal
 * @param durationWeeks - How many weeks to generate
 * @param simulationStart - ISO 8601 start of simulation window
 * @returns Array of simulated events
 */
export function generateRecurringEvents(
  title: string,
  dayOfWeek: number,
  startTime: number,
  endTime: number,
  durationWeeks: number,
  simulationStart: string,
): SimulationEvent[] {
  const events: SimulationEvent[] = [];
  const start = new Date(simulationStart);

  // Find the first occurrence of dayOfWeek on or after simulationStart.
  // JavaScript getUTCDay(): 0=Sunday, 1=Monday, ..., 6=Saturday.
  // Our convention: 0=Monday, 1=Tuesday, ..., 6=Sunday.
  const jsDay = ((dayOfWeek + 1) % 7); // convert our 0=Mon to JS 0=Sun
  const currentJsDay = start.getUTCDay();
  let daysUntil = jsDay - currentJsDay;
  if (daysUntil < 0) daysUntil += 7;

  for (let week = 0; week < durationWeeks; week++) {
    const eventDate = new Date(start);
    eventDate.setUTCDate(eventDate.getUTCDate() + daysUntil + week * 7);

    const startHour = Math.floor(startTime);
    const startMinute = Math.round((startTime - startHour) * 60);
    const endHour = Math.floor(endTime);
    const endMinute = Math.round((endTime - endHour) * 60);

    const eventStart = new Date(eventDate);
    eventStart.setUTCHours(startHour, startMinute, 0, 0);

    const eventEnd = new Date(eventDate);
    eventEnd.setUTCHours(endHour, endMinute, 0, 0);

    events.push({
      canonical_event_id: `sim-${week}-${title.replace(/\s+/g, "-").toLowerCase()}`,
      title,
      start_ts: eventStart.toISOString(),
      end_ts: eventEnd.toISOString(),
      all_day: false,
      status: "confirmed",
      client_id: null,
    });
  }

  return events;
}

// ---------------------------------------------------------------------------
// Public: simulate (main entry point)
// ---------------------------------------------------------------------------

/**
 * Run a what-if simulation.
 *
 * Takes a read-only snapshot of the user's current calendar state
 * and a hypothetical scenario, then computes the projected impact.
 *
 * CRITICAL: This function is pure -- it never mutates the snapshot.
 *
 * @param snapshot - Current calendar state (events, constraints, commitments)
 * @param scenario - The hypothetical change to simulate
 * @returns Impact report with projected metrics
 */
export function simulate(
  snapshot: SimulationSnapshot,
  scenario: SimulationScenario,
): ImpactReport {
  const weeks = SIMULATION_WEEKS;
  const beforeEvents = [...snapshot.events];
  let afterEvents: SimulationEvent[];
  let afterConstraints: SimulationConstraint[];
  let afterCommitments: SimulationCommitment[];

  switch (scenario.type) {
    case "add_commitment": {
      // Simulate the commitment by generating placeholder events
      // that fill the committed hours across the simulation window.
      const hoursPerWeek = scenario.hours_per_week;
      const newEvents = generateCommitmentEvents(
        scenario.client_id,
        hoursPerWeek,
        weeks,
        snapshot.simulation_start,
      );
      afterEvents = [...snapshot.events, ...newEvents];
      afterConstraints = [...snapshot.constraints];
      afterCommitments = [
        ...snapshot.commitments,
        {
          commitment_id: `sim-cmt-${scenario.client_id}`,
          client_id: scenario.client_id,
          client_name: `Simulated: ${scenario.client_id}`,
          target_hours: hoursPerWeek,
          window_type: "WEEKLY",
          rolling_window_weeks: weeks,
          hard_minimum: false,
        },
      ];
      break;
    }

    case "add_recurring_event": {
      const newEvents = generateRecurringEvents(
        scenario.title,
        scenario.day_of_week,
        scenario.start_time,
        scenario.end_time,
        scenario.duration_weeks,
        snapshot.simulation_start,
      );
      afterEvents = [...snapshot.events, ...newEvents];
      afterConstraints = [...snapshot.constraints];
      afterCommitments = [...snapshot.commitments];
      break;
    }

    case "change_working_hours": {
      afterEvents = [...snapshot.events];
      // Replace working_hours constraints with the new values
      afterConstraints = snapshot.constraints.map((c) =>
        c.kind === "working_hours"
          ? {
              ...c,
              config_json: {
                ...c.config_json,
                start_hour: scenario.start_hour,
                end_hour: scenario.end_hour,
              },
            }
          : { ...c },
      );
      // If no working_hours constraint existed, add one
      if (!afterConstraints.some((c) => c.kind === "working_hours")) {
        afterConstraints.push({
          kind: "working_hours",
          config_json: {
            start_hour: scenario.start_hour,
            end_hour: scenario.end_hour,
          },
        });
      }
      afterCommitments = [...snapshot.commitments];
      break;
    }
  }

  // Compute metrics
  const beforeWeeklyHours = computeWeeklyHours(
    beforeEvents,
    snapshot.simulation_start,
    weeks,
  );
  const afterWeeklyHours = computeWeeklyHours(
    afterEvents,
    snapshot.simulation_start,
    weeks,
  );

  const conflictCount = countConflicts(afterEvents);
  const constraintViolations = checkConstraintViolations(
    afterEvents,
    afterConstraints,
  );
  const burnoutDelta = computeBurnoutRiskDelta(beforeWeeklyHours, afterWeeklyHours);
  const complianceDelta = computeCommitmentComplianceDelta(
    afterCommitments,
    beforeEvents,
    afterEvents,
    snapshot.simulation_start,
    weeks,
  );

  return {
    projected_weekly_hours: afterWeeklyHours,
    conflict_count: conflictCount,
    constraint_violations: constraintViolations,
    burnout_risk_delta: burnoutDelta,
    commitment_compliance_delta: complianceDelta,
  };
}

// ---------------------------------------------------------------------------
// Internal: generate placeholder events for a commitment
// ---------------------------------------------------------------------------

/**
 * Generate simulated events to represent commitment hours.
 *
 * Distributes hours_per_week across the simulation window by creating
 * 2-hour blocks on weekdays. This is a simplification -- real scheduling
 * would be more sophisticated.
 */
function generateCommitmentEvents(
  clientId: string,
  hoursPerWeek: number,
  weeks: number,
  simulationStart: string,
): SimulationEvent[] {
  if (hoursPerWeek <= 0) return [];

  const events: SimulationEvent[] = [];
  const start = new Date(simulationStart);

  // Distribute hours into 2-hour blocks across weekdays
  const blockSize = 2; // hours per block
  const blocksPerWeek = Math.ceil(hoursPerWeek / blockSize);

  for (let week = 0; week < weeks; week++) {
    let hoursRemaining = hoursPerWeek;

    for (let block = 0; block < blocksPerWeek && hoursRemaining > 0; block++) {
      const dayOffset = week * 7 + (block % 5); // Spread across Mon-Fri
      const blockHours = Math.min(blockSize, hoursRemaining);

      const eventDate = new Date(start);
      eventDate.setUTCDate(eventDate.getUTCDate() + dayOffset);

      const eventStart = new Date(eventDate);
      // Stagger start times: 9am, 11am, 13pm, 15pm, 9am next day...
      const startHour = 9 + (block % 4) * 2;
      eventStart.setUTCHours(startHour, 0, 0, 0);

      const eventEnd = new Date(eventStart);
      eventEnd.setUTCHours(startHour + blockHours, 0, 0, 0);

      events.push({
        canonical_event_id: `sim-cmt-${clientId}-w${week}-b${block}`,
        title: `[Simulated] ${clientId} work`,
        start_ts: eventStart.toISOString(),
        end_ts: eventEnd.toISOString(),
        all_day: false,
        status: "confirmed",
        client_id: clientId,
      });

      hoursRemaining -= blockHours;
    }
  }

  return events;
}
