/**
 * Analytics computation mixin for UserGraphDO.
 *
 * Extracted from UserGraphDO to reduce class size. Contains all methods
 * related to the analytics/computation domain:
 * - Availability computation: computeAvailability (constraint-aware free/busy)
 * - Cognitive load: getCognitiveLoad (day/week scoring)
 * - Context switches: getContextSwitches (cost estimation)
 * - Deep work: getDeepWork (window optimization)
 * - Risk scoring: getRiskScores (burnout, travel, drift)
 * - Probabilistic availability: getProbabilisticAvailability
 * - Simulation snapshot: buildSimulationSnapshot (read-only)
 *
 * Uses composition: the mixin receives the sql handle and a migration
 * callback from the host DO, so it can operate on the same SQLite store.
 *
 * Note: analytics methods read from constraint, milestone, allocation,
 * and commitment tables via SQL. The mixin owns these queries as
 * read-only consumers -- it never writes to those tables.
 */

import {
  expandMilestonesToBusy,
  simulate,
  computeCognitiveLoad,
  computeTransitions,
  computeDailySwitchCost,
  computeWeeklySwitchCost,
  generateClusteringSuggestions,
  computeDeepWorkReport,
  suggestDeepWorkOptimizations,
  computeBurnoutRisk,
  computeTravelOverload,
  computeStrategicDrift,
  computeOverallRisk,
  generateRiskRecommendations,
  getRiskLevel,
  classifyEventCategory,
  computeProbabilisticAvailability,
} from "@tminus/shared";
import type {
  SqlStorageLike,
  CanonicalEvent,
  EventId,
  AccountId,
  CognitiveLoadResult,
  ContextSwitchResult,
  DeepWorkReport,
  RiskScoreResult,
  CognitiveLoadHistoryEntry,
  CategoryAllocation,
  ProbabilisticEvent,
  ProbabilisticAvailabilityResult,
  CancellationHistory,
  SimulationSnapshot,
  SimulationEvent,
  SimulationConstraint,
  SimulationCommitment,
  Transition,
} from "@tminus/shared";

import type {
  AvailabilityQuery,
  AvailabilityResult,
  BusyInterval,
} from "./availability-helpers";

import {
  mergeIntervals,
  computeFreeIntervals,
  expandWorkingHoursToOutsideBusy,
  expandNoMeetingsAfterToBusy,
  expandBuffersToBusy,
} from "./availability-helpers";

// ---------------------------------------------------------------------------
// Internal row types (local to this mixin)
// ---------------------------------------------------------------------------

interface CanonicalEventRow {
  [key: string]: unknown;
  canonical_event_id: string;
  origin_account_id: string;
  origin_event_id: string;
  title: string | null;
  description: string | null;
  location: string | null;
  start_ts: string;
  end_ts: string;
  timezone: string | null;
  all_day: number;
  status: string;
  visibility: string;
  transparency: string;
  recurrence_rule: string | null;
  source: string;
  version: number;
  created_at: string;
  updated_at: string;
  constraint_id: string | null;
}

interface ConstraintRow {
  [key: string]: unknown;
  constraint_id: string;
  kind: string;
  config_json: string;
  active_from: string | null;
  active_to: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Internal constraint type (mirrors the host DO's Constraint interface)
// ---------------------------------------------------------------------------

interface Constraint {
  readonly constraint_id: string;
  readonly kind: string;
  readonly config_json: Record<string, unknown>;
  readonly active_from: string | null;
  readonly active_to: string | null;
  readonly created_at: string;
}

// ---------------------------------------------------------------------------
// Mixin class
// ---------------------------------------------------------------------------

/**
 * Encapsulates analytics and computation logic: availability, cognitive load,
 * context switches, deep work, risk scoring, probabilistic availability,
 * and simulation snapshots.
 *
 * Constructed with a reference to the DO's SqlStorageLike handle and a
 * callback that ensures migrations have been applied. This avoids
 * duplicating migration logic while keeping the analytics code isolated.
 */
export class AnalyticsMixin {
  private readonly sql: SqlStorageLike;
  private readonly ensureMigrated: () => void;

  constructor(sql: SqlStorageLike, ensureMigrated: () => void) {
    this.sql = sql;
    this.ensureMigrated = ensureMigrated;
  }

  // -----------------------------------------------------------------------
  // computeAvailability -- Constraint-aware unified free/busy computation
  // -----------------------------------------------------------------------

  /**
   * Compute unified free/busy intervals across all (or specified) accounts
   * for a given time range. Evaluates ALL active constraints in a defined
   * order to produce a complete availability picture.
   *
   * Constraint evaluation order (story TM-gj5.4, TM-xwn.2):
   *   1. Raw free/busy from canonical events (including trip-derived events)
   *   2. Working hours -- times outside any active working_hours constraint
   *      are treated as busy. Multiple working_hours are unioned.
   *   3. Trip blocks -- trip constraints with active_from/active_to overlapping
   *      the query range mark that time as busy. These are always applied
   *      regardless of the account filter (trips are cross-account blocks).
   *   4. No-meetings-after -- daily cutoff times after which all time is busy.
   *   5. Buffers -- travel/prep/cooldown time around events reduces availability.
   *   5.5. Milestones -- life event milestones (birthdays, anniversaries, etc.)
   *        create all-day busy blocks. Recurring milestones expand for each year.
   *   6. Merge all intervals and compute free gaps.
   *
   * Performance target (NFR-16): under 500ms for 1-week range with 10+ constraints.
   */
  computeAvailability(query: AvailabilityQuery): AvailabilityResult {
    this.ensureMigrated();

    // ----- Step 1: Raw free/busy from canonical events -----
    const conditions: string[] = [
      "end_ts > ?",
      "start_ts < ?",
      "transparency = 'opaque'",
      "status != 'cancelled'",
    ];
    const params: unknown[] = [query.start, query.end];

    // Optional account filtering
    const hasAccountFilter = query.accounts && query.accounts.length > 0;
    if (hasAccountFilter) {
      const allAccounts = [...query.accounts!];
      if (!allAccounts.includes("internal")) {
        allAccounts.push("internal");
      }
      const placeholders = allAccounts.map(() => "?").join(", ");
      conditions.push(`origin_account_id IN (${placeholders})`);
      params.push(...allAccounts);
    }

    const where = `WHERE ${conditions.join(" AND ")}`;
    const sql = `SELECT start_ts, end_ts, origin_account_id FROM canonical_events ${where} ORDER BY start_ts ASC`;

    const rows = this.sql
      .exec<{ start_ts: string; end_ts: string; origin_account_id: string }>(
        sql,
        ...params,
      )
      .toArray();

    // Build raw busy intervals from query results
    const rawIntervals: BusyInterval[] = rows.map((row) => ({
      start: row.start_ts,
      end: row.end_ts,
      account_ids: [row.origin_account_id],
    }));

    // ----- Step 2: Working hours (exclude outside hours) -----
    const workingHoursConstraints = this.listConstraints("working_hours");
    const outsideWorkingHours = expandWorkingHoursToOutsideBusy(
      workingHoursConstraints,
      query.start,
      query.end,
    );
    rawIntervals.push(...outsideWorkingHours);

    // ----- Step 3: Trip blocks (mark as busy) -----
    // Trip constraints create derived canonical events with origin_account_id=
    // 'internal' and transparency='opaque'. These are included in step 1 above.
    // No separate expansion needed here.

    // ----- Step 4: No-meetings-after (daily cutoff) -----
    const noMeetingsAfterConstraints = this.listConstraints("no_meetings_after");
    const noMeetingsBusy = expandNoMeetingsAfterToBusy(
      noMeetingsAfterConstraints,
      query.start,
      query.end,
    );
    rawIntervals.push(...noMeetingsBusy);

    // ----- Step 5: Buffers (reduce available time around events) -----
    const bufferConstraints = this.listConstraints("buffer");
    if (bufferConstraints.length > 0) {
      const bufferIntervals = expandBuffersToBusy(bufferConstraints, rows);
      rawIntervals.push(...bufferIntervals);
    }

    // ----- Step 5.5: Milestone busy blocks -----
    const allMilestones = this.getAllMilestones();
    if (allMilestones.length > 0) {
      const milestoneIntervals = expandMilestonesToBusy(
        allMilestones,
        query.start,
        query.end,
      );
      rawIntervals.push(
        ...milestoneIntervals.map((iv: { start: string; end: string }) => ({
          start: iv.start,
          end: iv.end,
          account_ids: ["milestones"],
        })),
      );
    }

    // ----- Step 6: Merge and compute free intervals -----
    const busyIntervals = mergeIntervals(rawIntervals);
    const freeIntervals = computeFreeIntervals(busyIntervals, query.start, query.end);

    return {
      busy_intervals: busyIntervals,
      free_intervals: freeIntervals,
    };
  }

  // -----------------------------------------------------------------------
  // getCognitiveLoad -- Compute cognitive load score for a day/week
  // -----------------------------------------------------------------------

  /**
   * Compute cognitive load score for a day or week based on the user's
   * canonical events. Reads events from SQLite and delegates to the pure
   * computeCognitiveLoad function in @tminus/shared.
   *
   * Extracts working hours from active working_hours constraints if present,
   * otherwise defaults to 9-17.
   */
  getCognitiveLoad(date: string, range: "day" | "week"): CognitiveLoadResult {
    this.ensureMigrated();

    // Determine query time range
    const startDate = new Date(`${date}T00:00:00Z`);
    const dayCount = range === "week" ? 7 : 1;
    const endDate = new Date(startDate.getTime() + dayCount * 24 * 60 * 60 * 1000);

    const startIso = startDate.toISOString();
    const endIso = endDate.toISOString();

    // Fetch canonical events for the period
    const rows = this.sql
      .exec<CanonicalEventRow>(
        `SELECT * FROM canonical_events
         WHERE end_ts > ? AND start_ts < ?
           AND status != 'cancelled'
         ORDER BY start_ts ASC`,
        startIso,
        endIso,
      )
      .toArray();

    const events = rows.map((row) => this.rowToCanonicalEvent(row));

    // Extract working hours from constraints (if set)
    const workingHoursConstraints = this.listConstraints("working_hours");
    let workingHoursStart = 9;
    let workingHoursEnd = 17;
    if (workingHoursConstraints.length > 0) {
      const config = workingHoursConstraints[0].config_json as {
        start_hour?: number;
        end_hour?: number;
      };
      if (typeof config.start_hour === "number") workingHoursStart = config.start_hour;
      if (typeof config.end_hour === "number") workingHoursEnd = config.end_hour;
    }

    return computeCognitiveLoad({
      events,
      date,
      range,
      constraints: {
        workingHoursStart,
        workingHoursEnd,
      },
    });
  }

  // -----------------------------------------------------------------------
  // getContextSwitches -- Context-switch cost estimation for a day/week
  // -----------------------------------------------------------------------

  /**
   * Compute context-switch costs for a day or week based on the user's
   * canonical events. Reads events from SQLite and delegates to the pure
   * context-switch functions in @tminus/shared.
   *
   * For "day" range: computes transitions for the single date.
   * For "week" range: computes transitions for each day, aggregates costs.
   */
  getContextSwitches(date: string, range: "day" | "week"): ContextSwitchResult {
    this.ensureMigrated();

    const dayCount = range === "week" ? 7 : 1;
    const startDate = new Date(`${date}T00:00:00Z`);
    const endDate = new Date(startDate.getTime() + dayCount * 24 * 60 * 60 * 1000);

    const startIso = startDate.toISOString();
    const endIso = endDate.toISOString();

    // Fetch canonical events for the period
    const rows = this.sql
      .exec<CanonicalEventRow>(
        `SELECT * FROM canonical_events
         WHERE end_ts > ? AND start_ts < ?
           AND status != 'cancelled'
         ORDER BY start_ts ASC`,
        startIso,
        endIso,
      )
      .toArray();

    const allEvents = rows.map((row) => this.rowToCanonicalEvent(row));

    if (range === "day") {
      const transitions = computeTransitions(allEvents);
      const totalCost = computeDailySwitchCost(transitions);
      const suggestions = generateClusteringSuggestions(transitions, allEvents);
      return {
        transitions,
        total_cost: Math.round(totalCost * 100) / 100,
        daily_costs: [Math.round(totalCost * 100) / 100],
        suggestions,
      };
    }

    // Week range: compute per-day then aggregate
    const allTransitions: Transition[] = [];
    const dailyCosts: number[] = [];

    for (let i = 0; i < dayCount; i++) {
      const d = new Date(startDate.getTime() + i * 24 * 60 * 60 * 1000);
      const dayStr = d.toISOString().slice(0, 10);
      const dayStart = new Date(`${dayStr}T00:00:00Z`).getTime();
      const dayEnd = dayStart + 24 * 60 * 60 * 1000;

      // Filter events for this day
      const dayEvents = allEvents.filter((e) => {
        if (!e.start.dateTime || !e.end.dateTime) return false;
        const eStart = new Date(e.start.dateTime).getTime();
        const eEnd = new Date(e.end.dateTime).getTime();
        return eStart < dayEnd && eEnd > dayStart;
      });

      const dayTransitions = computeTransitions(dayEvents);
      const dayCost = computeDailySwitchCost(dayTransitions);
      allTransitions.push(...dayTransitions);
      dailyCosts.push(Math.round(dayCost * 100) / 100);
    }

    const weekly = computeWeeklySwitchCost(dailyCosts);
    const suggestions = generateClusteringSuggestions(allTransitions, allEvents);

    return {
      transitions: allTransitions,
      total_cost: Math.round(weekly.total * 100) / 100,
      daily_costs: dailyCosts,
      suggestions,
    };
  }

  // -----------------------------------------------------------------------
  // getDeepWork -- Deep work window optimization for a day/week
  // -----------------------------------------------------------------------

  /**
   * Compute deep work report for a day or week based on the user's
   * canonical events. Reads events from SQLite and delegates to the pure
   * deep work functions in @tminus/shared.
   *
   * For "day" range: computes deep work blocks for the single date.
   * For "week" range: computes across 7 days starting from date.
   *
   * Returns blocks, total deep hours, protected hours target, and
   * optimization suggestions.
   */
  getDeepWork(
    date: string,
    range: "day" | "week",
    minBlockMinutes?: number,
  ): DeepWorkReport & { suggestions: Array<{ message: string; estimated_gain_minutes: number }> } {
    this.ensureMigrated();

    // Determine query time range
    const dayCount = range === "week" ? 7 : 1;
    const startDate = new Date(`${date}T00:00:00Z`);
    const endDate = new Date(startDate.getTime() + dayCount * 24 * 60 * 60 * 1000);

    const startIso = startDate.toISOString();
    const endIso = endDate.toISOString();

    // Fetch canonical events for the period
    const rows = this.sql
      .exec<CanonicalEventRow>(
        `SELECT * FROM canonical_events
         WHERE end_ts > ? AND start_ts < ?
           AND status != 'cancelled'
         ORDER BY start_ts ASC`,
        startIso,
        endIso,
      )
      .toArray();

    const events = rows.map((row) => this.rowToCanonicalEvent(row));

    // Extract working hours from constraints (if set)
    const workingHoursConstraints = this.listConstraints("working_hours");
    let workingHoursStart = 9;
    let workingHoursEnd = 17;
    if (workingHoursConstraints.length > 0) {
      const config = workingHoursConstraints[0].config_json as {
        start_hour?: number;
        end_hour?: number;
      };
      if (typeof config.start_hour === "number") workingHoursStart = config.start_hour;
      if (typeof config.end_hour === "number") workingHoursEnd = config.end_hour;
    }

    // Build array of day strings
    const days: string[] = [];
    for (let i = 0; i < dayCount; i++) {
      const d = new Date(startDate.getTime() + i * 24 * 60 * 60 * 1000);
      days.push(d.toISOString().slice(0, 10));
    }

    const workingHours = { workingHoursStart, workingHoursEnd };

    const report = computeDeepWorkReport(events, workingHours, days, minBlockMinutes);
    const suggestions = suggestDeepWorkOptimizations(events, workingHours, minBlockMinutes);

    return {
      ...report,
      suggestions: suggestions.map((s) => ({
        message: s.message,
        estimated_gain_minutes: s.estimated_gain_minutes,
      })),
    };
  }

  // -----------------------------------------------------------------------
  // getRiskScores -- Temporal risk scoring (burnout, travel, drift)
  // -----------------------------------------------------------------------

  /**
   * Compute temporal risk scores for the user.
   *
   * Queries cognitive load history, trip constraints, and time allocations
   * to build inputs for the pure risk scoring functions.
   *
   * @param weeks - Number of weeks to analyze (default 4).
   * @returns Complete risk score result with burnout, travel, drift, overall,
   *          risk level, and recommendations.
   */
  getRiskScores(weeks: number = 4): RiskScoreResult {
    this.ensureMigrated();

    const now = new Date();
    const periodDays = weeks * 7;
    const periodStart = new Date(now.getTime() - periodDays * 24 * 60 * 60 * 1000);

    // 1. Build cognitive load history: compute daily cognitive load for each day
    const cognitiveLoadHistory: CognitiveLoadHistoryEntry[] = [];
    for (let i = 0; i < periodDays; i++) {
      const d = new Date(periodStart.getTime() + i * 24 * 60 * 60 * 1000);
      const dateStr = d.toISOString().slice(0, 10);
      const result = this.getCognitiveLoad(dateStr, "day");
      cognitiveLoadHistory.push({ date: dateStr, score: result.score });
    }

    // 2. Compute travel overload from trip constraints
    const tripConstraints = this.listConstraints("trip");
    const startMs = periodStart.getTime();
    const endMs = now.getTime();
    let tripDays = 0;

    for (const tc of tripConstraints) {
      if (!tc.active_from || !tc.active_to) continue;
      const tripStart = new Date(tc.active_from).getTime();
      const tripEnd = new Date(tc.active_to).getTime();

      // Overlap with analysis period
      const overlapStart = Math.max(tripStart, startMs);
      const overlapEnd = Math.min(tripEnd, endMs);
      if (overlapStart < overlapEnd) {
        tripDays += Math.ceil((overlapEnd - overlapStart) / (24 * 60 * 60 * 1000));
      }
    }

    // Working days = total days minus weekends (approximate)
    const workingDays = Math.round(periodDays * 5 / 7);

    // 3. Compute strategic drift from time allocations
    const midPoint = new Date(periodStart.getTime() + (endMs - startMs) / 2);
    const midIso = midPoint.toISOString();
    const startIso = periodStart.toISOString();
    const endIso = now.toISOString();

    // Get events for historical period (first half)
    const historicalRows = this.sql
      .exec<CanonicalEventRow>(
        `SELECT * FROM canonical_events
         WHERE end_ts > ? AND start_ts < ?
           AND status != 'cancelled' AND all_day = 0
         ORDER BY start_ts ASC`,
        startIso,
        midIso,
      )
      .toArray();

    // Get events for current period (second half)
    const currentRows = this.sql
      .exec<CanonicalEventRow>(
        `SELECT * FROM canonical_events
         WHERE end_ts > ? AND start_ts < ?
           AND status != 'cancelled' AND all_day = 0
         ORDER BY start_ts ASC`,
        midIso,
        endIso,
      )
      .toArray();

    const historicalAllocations = this.computeAllocationsFromEvents(
      historicalRows.map((r) => this.rowToCanonicalEvent(r)),
    );
    const currentAllocations = this.computeAllocationsFromEvents(
      currentRows.map((r) => this.rowToCanonicalEvent(r)),
    );

    // 4. Compute risk scores using pure functions
    const burnout = computeBurnoutRisk(cognitiveLoadHistory);
    const travel = computeTravelOverload(tripDays, workingDays);
    const drift = computeStrategicDrift(currentAllocations, historicalAllocations);
    const overall = computeOverallRisk(burnout, travel, drift);
    const riskLevel = getRiskLevel(overall);
    const recommendations = generateRiskRecommendations(burnout, travel, drift);

    return {
      burnout_risk: burnout,
      travel_overload: travel,
      strategic_drift: drift,
      overall_risk: overall,
      risk_level: riskLevel,
      recommendations,
    };
  }

  // -----------------------------------------------------------------------
  // getProbabilisticAvailability -- probability-weighted availability
  // -----------------------------------------------------------------------

  /**
   * Compute probabilistic availability for a time range.
   *
   * Instead of binary free/busy, each slot has a probability of being free
   * (0.0 to 1.0) based on event status (confirmed=0.95, tentative=0.50),
   * with adjustments for recurring events that historically get cancelled.
   *
   * Cancellation history is derived from the event_journal: for each
   * recurring event series (identified by origin_event_id), we count
   * the total occurrences and how many were cancelled.
   */
  getProbabilisticAvailability(
    start: string,
    end: string,
    granularity_minutes?: number,
  ): ProbabilisticAvailabilityResult {
    this.ensureMigrated();

    // Fetch canonical events for the period (including tentative)
    const rows = this.sql
      .exec<CanonicalEventRow>(
        `SELECT * FROM canonical_events
         WHERE end_ts > ? AND start_ts < ?
           AND all_day = 0
           AND transparency = 'opaque'
         ORDER BY start_ts ASC`,
        start,
        end,
      )
      .toArray();

    // Convert rows to ProbabilisticEvent format
    const events: ProbabilisticEvent[] = rows
      .filter((r) => r.start_ts && r.end_ts)
      .map((r) => ({
        event_id: r.canonical_event_id,
        start: r.start_ts,
        end: r.end_ts,
        status: r.status as "confirmed" | "tentative" | "cancelled",
        transparency: r.transparency as "opaque" | "transparent",
        recurrence_rule: r.recurrence_rule ?? undefined,
        origin_event_id: r.origin_event_id,
      }));

    // Build cancellation history for recurring events from the journal
    const recurringOriginIds = [
      ...new Set(
        events
          .filter((e) => e.recurrence_rule)
          .map((e) => e.origin_event_id),
      ),
    ];

    const cancellation_history: CancellationHistory = {};

    for (const originId of recurringOriginIds) {
      const totalRows = this.sql
        .exec<{ cnt: number }>(
          `SELECT COUNT(*) as cnt FROM canonical_events
           WHERE origin_event_id = ?`,
          originId,
        )
        .toArray();

      const cancelledRows = this.sql
        .exec<{ cnt: number }>(
          `SELECT COUNT(DISTINCT ej.canonical_event_id) as cnt
           FROM event_journal ej
           JOIN canonical_events ce ON ej.canonical_event_id = ce.canonical_event_id
           WHERE ce.origin_event_id = ?
             AND ej.change_type = 'deleted'`,
          originId,
        )
        .toArray();

      const total = totalRows[0]?.cnt ?? 0;
      const cancelled = cancelledRows[0]?.cnt ?? 0;

      if (total > 0) {
        cancellation_history[originId] = {
          total_occurrences: total,
          cancelled_occurrences: cancelled,
        };
      }
    }

    return computeProbabilisticAvailability({
      events,
      start,
      end,
      granularity_minutes,
      cancellation_history,
    });
  }

  // -----------------------------------------------------------------------
  // buildSimulationSnapshot -- What-If Simulation read-only snapshot builder
  // -----------------------------------------------------------------------

  /**
   * Build a read-only snapshot of the user's current calendar state
   * for the simulation engine.
   *
   * Fetches upcoming events (next 4 weeks), all constraints, and all
   * commitments. Returns a SimulationSnapshot that the pure simulate()
   * function can consume without any side effects.
   */
  buildSimulationSnapshot(): SimulationSnapshot {
    this.ensureMigrated();

    const now = new Date();
    const fourWeeksLater = new Date(now.getTime() + 28 * 24 * 60 * 60 * 1000);
    const nowIso = now.toISOString();
    const futureIso = fourWeeksLater.toISOString();

    // Fetch upcoming events (next 4 weeks)
    const eventRows = this.sql
      .exec<CanonicalEventRow>(
        `SELECT * FROM canonical_events
         WHERE end_ts > ? AND start_ts < ?
         ORDER BY start_ts ASC`,
        nowIso,
        futureIso,
      )
      .toArray();

    const events: SimulationEvent[] = eventRows.map((r) => ({
      canonical_event_id: r.canonical_event_id,
      title: r.title ?? "",
      start_ts: r.start_ts,
      end_ts: r.end_ts,
      all_day: r.all_day === 1,
      status: r.status,
      client_id: this.getEventClientId(r.canonical_event_id),
    }));

    // Fetch all constraints and normalize config for simulation engine
    const constraintRows = this.listConstraints();
    const constraints: SimulationConstraint[] = constraintRows.map((c) => {
      let configJson = c.config_json;
      if (c.kind === "working_hours" && typeof configJson.start_time === "string") {
        const startHour = parseInt((configJson.start_time as string).split(":")[0], 10);
        const endHour = parseInt((configJson.end_time as string).split(":")[0], 10);
        configJson = { ...configJson, start_hour: startHour, end_hour: endHour };
      }
      return { kind: c.kind, config_json: configJson };
    });

    // Fetch all commitments
    const commitmentRows = this.listCommitments();
    const commitments: SimulationCommitment[] = commitmentRows.map((c) => ({
      commitment_id: c.commitment_id,
      client_id: c.client_id,
      client_name: c.client_name,
      target_hours: c.target_hours,
      window_type: c.window_type as "WEEKLY" | "MONTHLY",
      rolling_window_weeks: c.rolling_window_weeks,
      hard_minimum: c.hard_minimum,
    }));

    return {
      events,
      constraints,
      commitments,
      simulation_start: nowIso,
    };
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /** Convert a DB row to a CanonicalEvent domain object. */
  private rowToCanonicalEvent(row: CanonicalEventRow): CanonicalEvent {
    const allDay = row.all_day === 1;

    return {
      canonical_event_id: row.canonical_event_id as EventId,
      origin_account_id: row.origin_account_id as AccountId,
      origin_event_id: row.origin_event_id,
      title: row.title ?? undefined,
      description: row.description ?? undefined,
      location: row.location ?? undefined,
      start: allDay
        ? { date: row.start_ts }
        : { dateTime: row.start_ts, ...(row.timezone ? { timeZone: row.timezone } : {}) },
      end: allDay
        ? { date: row.end_ts }
        : { dateTime: row.end_ts, ...(row.timezone ? { timeZone: row.timezone } : {}) },
      all_day: allDay,
      status: row.status as CanonicalEvent["status"],
      visibility: row.visibility as CanonicalEvent["visibility"],
      transparency: row.transparency as CanonicalEvent["transparency"],
      recurrence_rule: row.recurrence_rule ?? undefined,
      source: row.source as CanonicalEvent["source"],
      version: row.version,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  /**
   * Compute time allocation by category from a set of canonical events.
   * Uses classifyEventCategory to determine each event's category,
   * then sums hours per category.
   */
  private computeAllocationsFromEvents(
    events: readonly CanonicalEvent[],
  ): CategoryAllocation[] {
    const categoryHours = new Map<string, number>();

    for (const event of events) {
      if (!event.start.dateTime || !event.end.dateTime) continue;
      if (event.transparency === "transparent") continue;

      const category = classifyEventCategory(event);
      const startMs = new Date(event.start.dateTime).getTime();
      const endMs = new Date(event.end.dateTime).getTime();
      const hours = (endMs - startMs) / (60 * 60 * 1000);

      if (hours > 0) {
        const current = categoryHours.get(category) ?? 0;
        categoryHours.set(category, current + hours);
      }
    }

    const allocations: CategoryAllocation[] = [];
    for (const [category, hours] of categoryHours) {
      allocations.push({ category, hours: Math.round(hours * 100) / 100 });
    }
    return allocations;
  }

  /**
   * List constraints from the constraints table, optionally filtered by kind.
   * Read-only SQL consumer -- does not write to the constraints table.
   */
  private listConstraints(kind?: string): Constraint[] {
    this.ensureMigrated();

    let rows: ConstraintRow[];
    if (kind) {
      rows = this.sql
        .exec<ConstraintRow>(
          `SELECT * FROM constraints WHERE kind = ? ORDER BY created_at ASC`,
          kind,
        )
        .toArray();
    } else {
      rows = this.sql
        .exec<ConstraintRow>(
          `SELECT * FROM constraints ORDER BY created_at ASC`,
        )
        .toArray();
    }

    return rows.map((r) => this.rowToConstraint(r));
  }

  /** Convert a ConstraintRow to a Constraint domain object. */
  private rowToConstraint(row: ConstraintRow): Constraint {
    let configJson: Record<string, unknown> = {};
    try {
      configJson = JSON.parse(row.config_json);
    } catch {
      // If config_json is malformed, use empty object
    }

    return {
      constraint_id: row.constraint_id,
      kind: row.kind,
      config_json: configJson,
      active_from: row.active_from,
      active_to: row.active_to,
      created_at: row.created_at,
    };
  }

  /**
   * Get all milestones for availability computation.
   * Read-only SQL consumer -- does not write to the milestones table.
   */
  private getAllMilestones(): Array<{
    date: string;
    recurs_annually: number;
  }> {
    return this.sql
      .exec<{ date: string; recurs_annually: number }>(
        "SELECT date, recurs_annually FROM milestones",
      )
      .toArray();
  }

  /**
   * Get the client_id for an event from its time_allocation, if any.
   * Read-only SQL consumer -- does not write to the time_allocations table.
   */
  private getEventClientId(canonicalEventId: string): string | null {
    const rows = this.sql
      .exec<{ client_id: string | null }>(
        `SELECT client_id FROM time_allocations WHERE canonical_event_id = ? LIMIT 1`,
        canonicalEventId,
      )
      .toArray();
    return rows.length > 0 ? rows[0].client_id : null;
  }

  /**
   * List all time commitments.
   * Read-only SQL consumer -- does not write to the time_commitments table.
   */
  private listCommitments(): Array<{
    commitment_id: string;
    client_id: string;
    client_name: string | null;
    target_hours: number;
    window_type: string;
    rolling_window_weeks: number;
    hard_minimum: boolean;
  }> {
    const rows = this.sql
      .exec<{
        commitment_id: string;
        client_id: string;
        client_name: string | null;
        target_hours: number;
        window_type: string;
        rolling_window_weeks: number;
        hard_minimum: number;
      }>(
        `SELECT commitment_id, client_id, client_name, target_hours, window_type, rolling_window_weeks, hard_minimum
         FROM time_commitments ORDER BY created_at DESC`,
      )
      .toArray();

    return rows.map((r) => ({
      commitment_id: r.commitment_id,
      client_id: r.client_id,
      client_name: r.client_name,
      target_hours: r.target_hours,
      window_type: r.window_type,
      rolling_window_weeks: r.rolling_window_weeks,
      hard_minimum: r.hard_minimum === 1,
    }));
  }
}
