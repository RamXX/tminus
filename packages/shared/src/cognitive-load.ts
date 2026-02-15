/**
 * Cognitive Load Engine -- pure computation functions for measuring
 * the cognitive burden of a calendar day or week.
 *
 * Metrics computed:
 *   - meeting_density: percentage of working hours occupied by meetings
 *   - context_switches: number of transitions between differently-titled meetings
 *   - deep_work_blocks: count of uninterrupted free periods >= 2 hours
 *   - fragmentation: count of small gaps (< 30 min) between meetings
 *   - score: aggregate 0-100 cognitive load score
 *
 * All functions are pure (no I/O, no side effects). Input is an array
 * of CanonicalEvent and optional working hours constraints.
 */

import type { CanonicalEvent } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Working hours boundaries (hour numbers, 0-23). */
export interface WorkingHoursConstraint {
  /** Hour when the working day starts (inclusive). Default: 9. */
  readonly workingHoursStart: number;
  /** Hour when the working day ends (exclusive). Default: 17. */
  readonly workingHoursEnd: number;
}

/** Input for the main computeCognitiveLoad function. */
export interface CognitiveLoadInput {
  /** Canonical events for the period. */
  readonly events: readonly CanonicalEvent[];
  /** Reference date in YYYY-MM-DD format. */
  readonly date: string;
  /** Compute for a single day or an entire week starting from date. */
  readonly range: "day" | "week";
  /** Optional working hours. Defaults to 9-17 if not provided. */
  readonly constraints?: WorkingHoursConstraint;
}

/** Result shape returned by computeCognitiveLoad. */
export interface CognitiveLoadResult {
  /** Aggregate cognitive load score, 0 (empty) to 100 (packed). */
  readonly score: number;
  /** Percentage of working hours occupied by meetings (0-100). */
  readonly meeting_density: number;
  /** Number of context switches between differently-titled meetings. */
  readonly context_switches: number;
  /** Count of uninterrupted free periods >= 2 hours within working hours. */
  readonly deep_work_blocks: number;
  /** Count of small gaps (< 30 minutes) between meetings. */
  readonly fragmentation: number;
}

/** Intermediate metrics used by the aggregate score function. */
export interface AggregateMetrics {
  readonly meeting_density: number;
  readonly context_switches: number;
  readonly deep_work_blocks: number;
  readonly fragmentation: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_WORKING_HOURS_START = 9;
const DEFAULT_WORKING_HOURS_END = 17;
const DEEP_WORK_THRESHOLD_MINUTES = 120; // 2 hours
const FRAGMENTATION_THRESHOLD_MINUTES = 30;
const DAYS_IN_WEEK = 7;

// Aggregate score weights (sum to 1.0 for the components that increase load)
// meeting_density: 40%, context_switches: 25%, fragmentation: 15%, deep_work_penalty: 20%
const WEIGHT_DENSITY = 0.40;
const WEIGHT_SWITCHES = 0.25;
const WEIGHT_FRAGMENTATION = 0.15;
const WEIGHT_DEEP_WORK = 0.20;

// Normalization caps for context switches and fragmentation
// (diminishing returns beyond these values)
const MAX_SWITCHES_CAP = 15;
const MAX_FRAGMENTATION_CAP = 10;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Filter events to only opaque, non-cancelled, non-all-day timed events.
 * These are the events that "cost" cognitive attention.
 */
function filterActiveTimedEvents(
  events: readonly CanonicalEvent[],
): CanonicalEvent[] {
  return events.filter(
    (e) =>
      !e.all_day &&
      e.status !== "cancelled" &&
      e.transparency !== "transparent" &&
      e.start.dateTime != null &&
      e.end.dateTime != null,
  );
}

/** Get the epoch-millis timestamp for a dateTime string. */
function toMs(dateTime: string): number {
  return new Date(dateTime).getTime();
}

/**
 * Build working hours boundaries for a single date.
 * Returns [startMs, endMs] for the working window on that date.
 */
function workingWindow(
  date: string,
  constraints: WorkingHoursConstraint,
): [number, number] {
  const dayStart = new Date(`${date}T00:00:00Z`);
  const startMs =
    dayStart.getTime() + constraints.workingHoursStart * 60 * 60 * 1000;
  const endMs =
    dayStart.getTime() + constraints.workingHoursEnd * 60 * 60 * 1000;
  return [startMs, endMs];
}

/**
 * Build an array of [date, startMs, endMs] tuples for each working day
 * in the range (day or week).
 */
function workingDays(
  date: string,
  range: "day" | "week",
  constraints: WorkingHoursConstraint,
): Array<[string, number, number]> {
  const days: Array<[string, number, number]> = [];
  const count = range === "week" ? DAYS_IN_WEEK : 1;
  const baseDate = new Date(`${date}T00:00:00Z`);

  for (let i = 0; i < count; i++) {
    const d = new Date(baseDate.getTime() + i * 24 * 60 * 60 * 1000);
    const isoDate = d.toISOString().slice(0, 10);
    const [startMs, endMs] = workingWindow(isoDate, constraints);
    days.push([isoDate, startMs, endMs]);
  }
  return days;
}

/**
 * Merge overlapping time intervals into a non-overlapping set.
 * Input: sorted array of [start, end] tuples.
 * Output: merged array of [start, end] tuples.
 */
function mergeTimeIntervals(
  intervals: Array<[number, number]>,
): Array<[number, number]> {
  if (intervals.length === 0) return [];

  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    const current = sorted[i];
    if (current[0] <= last[1]) {
      // Overlapping or adjacent -- extend
      last[1] = Math.max(last[1], current[1]);
    } else {
      merged.push([...current]);
    }
  }
  return merged;
}

/**
 * Resolve constraints, falling back to defaults.
 */
function resolveConstraints(
  constraints?: WorkingHoursConstraint,
): WorkingHoursConstraint {
  return {
    workingHoursStart: constraints?.workingHoursStart ?? DEFAULT_WORKING_HOURS_START,
    workingHoursEnd: constraints?.workingHoursEnd ?? DEFAULT_WORKING_HOURS_END,
  };
}

// ---------------------------------------------------------------------------
// Public API -- individual metric functions
// ---------------------------------------------------------------------------

/**
 * Compute meeting density as a percentage of working hours occupied
 * by opaque, non-cancelled meetings.
 *
 * Overlapping meetings are merged so time is not double-counted.
 * Events outside working hours are clipped.
 * Returns a value from 0 to 100.
 */
export function computeMeetingDensity(
  events: readonly CanonicalEvent[],
  date: string,
  constraints: WorkingHoursConstraint,
): number {
  const resolved = resolveConstraints(constraints);
  const active = filterActiveTimedEvents(events);
  const days = workingDays(date, "day", resolved);

  let totalWorkingMs = 0;
  let totalMeetingMs = 0;

  for (const [, dayStartMs, dayEndMs] of days) {
    totalWorkingMs += dayEndMs - dayStartMs;

    // Collect meeting intervals clipped to working hours
    const clipped: Array<[number, number]> = [];
    for (const event of active) {
      const eventStart = toMs(event.start.dateTime!);
      const eventEnd = toMs(event.end.dateTime!);

      // Clip to working hours
      const start = Math.max(eventStart, dayStartMs);
      const end = Math.min(eventEnd, dayEndMs);

      if (start < end) {
        clipped.push([start, end]);
      }
    }

    // Merge overlapping intervals
    const merged = mergeTimeIntervals(clipped);
    for (const [s, e] of merged) {
      totalMeetingMs += e - s;
    }
  }

  if (totalWorkingMs === 0) return 0;
  return Math.min(100, (totalMeetingMs / totalWorkingMs) * 100);
}

/**
 * Count context switches: number of transitions between meetings
 * with different titles (case-insensitive).
 *
 * Cancelled events are excluded. Events are sorted by start time.
 */
export function computeContextSwitches(
  events: readonly CanonicalEvent[],
): number {
  const active = filterActiveTimedEvents(events);
  if (active.length <= 1) return 0;

  // Sort by start time
  const sorted = [...active].sort((a, b) => {
    const aStart = a.start.dateTime ? toMs(a.start.dateTime) : 0;
    const bStart = b.start.dateTime ? toMs(b.start.dateTime) : 0;
    return aStart - bStart;
  });

  let switches = 0;
  for (let i = 1; i < sorted.length; i++) {
    const prevTitle = (sorted[i - 1].title ?? "").toLowerCase().trim();
    const currTitle = (sorted[i].title ?? "").toLowerCase().trim();
    if (prevTitle !== currTitle) {
      switches++;
    }
  }
  return switches;
}

/**
 * Count deep work blocks: uninterrupted free periods >= 2 hours
 * within working hours.
 *
 * Computes the free gaps between merged meeting intervals within
 * working hours, and counts those >= DEEP_WORK_THRESHOLD_MINUTES.
 */
export function computeDeepWorkBlocks(
  events: readonly CanonicalEvent[],
  date: string,
  constraints: WorkingHoursConstraint,
): number {
  const resolved = resolveConstraints(constraints);
  const active = filterActiveTimedEvents(events);
  const days = workingDays(date, "day", resolved);

  let blocks = 0;

  for (const [, dayStartMs, dayEndMs] of days) {
    // Collect and merge meeting intervals clipped to working hours
    const clipped: Array<[number, number]> = [];
    for (const event of active) {
      const eventStart = toMs(event.start.dateTime!);
      const eventEnd = toMs(event.end.dateTime!);
      const start = Math.max(eventStart, dayStartMs);
      const end = Math.min(eventEnd, dayEndMs);
      if (start < end) {
        clipped.push([start, end]);
      }
    }

    const merged = mergeTimeIntervals(clipped);

    // Find free gaps between meetings within working hours
    let cursor = dayStartMs;
    for (const [meetStart, meetEnd] of merged) {
      const gapMs = meetStart - cursor;
      if (gapMs >= DEEP_WORK_THRESHOLD_MINUTES * 60 * 1000) {
        blocks++;
      }
      cursor = meetEnd;
    }
    // Check trailing gap (from last meeting to end of working hours)
    const trailingGap = dayEndMs - cursor;
    if (trailingGap >= DEEP_WORK_THRESHOLD_MINUTES * 60 * 1000) {
      blocks++;
    }
  }

  return blocks;
}

/**
 * Compute fragmentation score: count of small gaps (< 30 minutes)
 * between consecutive meetings (after merging overlaps).
 *
 * A gap of 0 minutes (back-to-back meetings) counts as fragmentation
 * because there is no recovery time between context switches.
 */
export function computeFragmentationScore(
  events: readonly CanonicalEvent[],
  date: string,
  constraints: WorkingHoursConstraint,
): number {
  const resolved = resolveConstraints(constraints);
  const active = filterActiveTimedEvents(events);
  if (active.length <= 1) return 0;

  const days = workingDays(date, "day", resolved);
  let fragCount = 0;

  for (const [, dayStartMs, dayEndMs] of days) {
    // Collect individual meeting intervals clipped to working hours
    // We do NOT merge here because we want to detect gaps between
    // individual meetings (including back-to-back)
    const clipped: Array<[number, number]> = [];
    for (const event of active) {
      const eventStart = toMs(event.start.dateTime!);
      const eventEnd = toMs(event.end.dateTime!);
      const start = Math.max(eventStart, dayStartMs);
      const end = Math.min(eventEnd, dayEndMs);
      if (start < end) {
        clipped.push([start, end]);
      }
    }

    if (clipped.length <= 1) continue;

    // Sort by start time
    clipped.sort((a, b) => a[0] - b[0]);

    // Check gaps between consecutive meetings
    for (let i = 1; i < clipped.length; i++) {
      const prevEnd = clipped[i - 1][1];
      const currStart = clipped[i][0];
      const gapMinutes = (currStart - prevEnd) / (60 * 1000);

      // Gap < 30 minutes (including 0 = back-to-back) is fragmentation
      if (gapMinutes >= 0 && gapMinutes < FRAGMENTATION_THRESHOLD_MINUTES) {
        fragCount++;
      }
    }
  }

  return fragCount;
}

/**
 * Compute the aggregate cognitive load score (0-100) from individual metrics.
 *
 * Formula:
 *   - meeting_density contributes 40% (already a 0-100 value)
 *   - context_switches contributes 25% (normalized by MAX_SWITCHES_CAP)
 *   - fragmentation contributes 15% (normalized by MAX_FRAGMENTATION_CAP)
 *   - deep_work_blocks contributes 20% INVERSELY (more blocks = lower load)
 *     Normalized: 0 blocks = 100% penalty, 3+ blocks = 0% penalty
 *
 * The result is clamped to [0, 100].
 */
export function computeAggregateScore(metrics: AggregateMetrics): number {
  const densityNorm = Math.min(metrics.meeting_density, 100) / 100;
  const switchesNorm = Math.min(metrics.context_switches, MAX_SWITCHES_CAP) / MAX_SWITCHES_CAP;
  const fragNorm = Math.min(metrics.fragmentation, MAX_FRAGMENTATION_CAP) / MAX_FRAGMENTATION_CAP;

  // Deep work: inverse relationship. 0 blocks = max penalty (1.0),
  // 3+ blocks = no penalty (0.0). Only applies when there are actual
  // meetings -- an empty day (density=0) should not incur a deep work
  // penalty since there is nothing to recover from.
  const hasMeetings = densityNorm > 0 || switchesNorm > 0 || fragNorm > 0;
  const deepWorkPenalty = hasMeetings
    ? Math.max(0, 1 - metrics.deep_work_blocks / 3)
    : 0;

  const raw =
    WEIGHT_DENSITY * densityNorm +
    WEIGHT_SWITCHES * switchesNorm +
    WEIGHT_FRAGMENTATION * fragNorm +
    WEIGHT_DEEP_WORK * deepWorkPenalty;

  return Math.round(Math.min(100, Math.max(0, raw * 100)));
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Compute cognitive load score and all sub-metrics for a day or week.
 *
 * For "day" range: computes metrics for the single date.
 * For "week" range: computes metrics across 7 days starting from date.
 */
export function computeCognitiveLoad(input: CognitiveLoadInput): CognitiveLoadResult {
  const resolved = resolveConstraints(input.constraints);
  const { events, date, range } = input;

  if (range === "week") {
    return computeWeekCognitiveLoad(events, date, resolved);
  }

  return computeDayCognitiveLoad(events, date, resolved);
}

/**
 * Compute cognitive load for a single day.
 */
function computeDayCognitiveLoad(
  events: readonly CanonicalEvent[],
  date: string,
  constraints: WorkingHoursConstraint,
): CognitiveLoadResult {
  // Filter events relevant to this specific day
  const dayEvents = filterEventsForDate(events, date, constraints);

  const meeting_density = computeMeetingDensity(dayEvents, date, constraints);
  const context_switches = computeContextSwitches(dayEvents);
  const deep_work_blocks = computeDeepWorkBlocks(dayEvents, date, constraints);
  const fragmentation = computeFragmentationScore(dayEvents, date, constraints);

  const score = computeAggregateScore({
    meeting_density,
    context_switches,
    deep_work_blocks,
    fragmentation,
  });

  return {
    score,
    meeting_density: Math.round(meeting_density * 100) / 100,
    context_switches,
    deep_work_blocks,
    fragmentation,
  };
}

/**
 * Compute cognitive load for a week (7 days from the given date).
 *
 * Meeting density and deep work blocks are computed across all 7 days.
 * Context switches and fragmentation are summed across days.
 */
function computeWeekCognitiveLoad(
  events: readonly CanonicalEvent[],
  startDate: string,
  constraints: WorkingHoursConstraint,
): CognitiveLoadResult {
  const days = workingDays(startDate, "week", constraints);

  let totalWorkingMs = 0;
  let totalMeetingMs = 0;
  let totalSwitches = 0;
  let totalDeepWorkBlocks = 0;
  let totalFragmentation = 0;

  const active = filterActiveTimedEvents(events);

  for (const [dayDate, dayStartMs, dayEndMs] of days) {
    totalWorkingMs += dayEndMs - dayStartMs;

    // Events for this day
    const dayEvents = active.filter((e) => {
      const eventStart = toMs(e.start.dateTime!);
      const eventEnd = toMs(e.end.dateTime!);
      return eventStart < dayEndMs && eventEnd > dayStartMs;
    });

    // Meeting density: accumulate clipped meeting time
    const clipped: Array<[number, number]> = [];
    for (const event of dayEvents) {
      const start = Math.max(toMs(event.start.dateTime!), dayStartMs);
      const end = Math.min(toMs(event.end.dateTime!), dayEndMs);
      if (start < end) clipped.push([start, end]);
    }
    const merged = mergeTimeIntervals(clipped);
    for (const [s, e] of merged) totalMeetingMs += e - s;

    // Deep work blocks for this day
    totalDeepWorkBlocks += computeDeepWorkBlocks(dayEvents, dayDate, constraints);

    // Context switches for this day
    totalSwitches += computeContextSwitches(dayEvents);

    // Fragmentation for this day
    totalFragmentation += computeFragmentationScore(dayEvents, dayDate, constraints);
  }

  const meeting_density =
    totalWorkingMs === 0 ? 0 : Math.min(100, (totalMeetingMs / totalWorkingMs) * 100);

  const score = computeAggregateScore({
    meeting_density,
    context_switches: totalSwitches,
    deep_work_blocks: totalDeepWorkBlocks,
    fragmentation: totalFragmentation,
  });

  return {
    score,
    meeting_density: Math.round(meeting_density * 100) / 100,
    context_switches: totalSwitches,
    deep_work_blocks: totalDeepWorkBlocks,
    fragmentation: totalFragmentation,
  };
}

/**
 * Filter events to those that overlap a specific date's working hours.
 */
function filterEventsForDate(
  events: readonly CanonicalEvent[],
  date: string,
  constraints: WorkingHoursConstraint,
): CanonicalEvent[] {
  const [dayStartMs, dayEndMs] = workingWindow(date, constraints);
  return events.filter((e) => {
    if (e.all_day) return false;
    if (!e.start.dateTime || !e.end.dateTime) return false;
    const eventStart = toMs(e.start.dateTime);
    const eventEnd = toMs(e.end.dateTime);
    return eventStart < dayEndMs && eventEnd > dayStartMs;
  });
}
