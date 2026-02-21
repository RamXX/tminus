/**
 * Pure availability helper functions and types.
 *
 * Extracted to a separate module to avoid circular imports between
 * index.ts and analytics-mixin.ts. Both modules import from this file.
 *
 * All functions in this file are pure: no side effects, no database access.
 */

// ---------------------------------------------------------------------------
// Availability types
// ---------------------------------------------------------------------------

/** Query parameters for computing free/busy availability. */
export interface AvailabilityQuery {
  /** ISO 8601 start of the time range. */
  readonly start: string;
  /** ISO 8601 end of the time range. */
  readonly end: string;
  /** Optional account IDs to filter. When omitted, all accounts are included. */
  readonly accounts?: string[];
}

/** A busy interval with the accounts that contribute to it. */
export interface BusyInterval {
  start: string;
  end: string;
  account_ids: string[];
}

/** A free interval (a gap between busy blocks). */
export interface FreeInterval {
  start: string;
  end: string;
}

/** Result of computing availability across accounts. */
export interface AvailabilityResult {
  readonly busy_intervals: BusyInterval[];
  readonly free_intervals: FreeInterval[];
}

// ---------------------------------------------------------------------------
// Pure functions for interval merging and gap computation
// ---------------------------------------------------------------------------

/**
 * Normalize a date or datetime string for consistent comparison.
 * All-day event dates ("2026-02-15") are expanded to "2026-02-15T00:00:00Z"
 * so they compare correctly with ISO 8601 datetime strings.
 *
 * This is needed because "2026-02-16" < "2026-02-16T00:00:00Z" in lexicographic
 * comparison, but they represent the same point in time.
 */
function normalizeForComparison(ts: string): string {
  // Date-only format is exactly 10 characters: YYYY-MM-DD
  if (ts.length === 10) {
    return `${ts}T00:00:00Z`;
  }
  return ts;
}

/**
 * Merge overlapping or adjacent busy intervals, combining account_ids.
 *
 * Algorithm:
 * 1. Sort intervals by start time
 * 2. Walk through sorted intervals, extending the current merged interval
 *    when the next interval overlaps or is adjacent (end >= next.start)
 * 3. When a gap is found, push the current merged interval and start a new one
 *
 * Time complexity: O(n log n) due to sorting.
 */
export function mergeIntervals(intervals: BusyInterval[]): BusyInterval[] {
  if (intervals.length === 0) return [];

  // Sort by start time using normalized comparison for mixed date/datetime strings
  const sorted = [...intervals].sort((a, b) =>
    normalizeForComparison(a.start).localeCompare(normalizeForComparison(b.start)),
  );

  const merged: BusyInterval[] = [];
  let current: BusyInterval = {
    start: sorted[0].start,
    end: sorted[0].end,
    account_ids: [...sorted[0].account_ids],
  };

  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i];
    const nextStartNorm = normalizeForComparison(next.start);
    const currentEndNorm = normalizeForComparison(current.end);

    if (nextStartNorm <= currentEndNorm) {
      // Overlapping or adjacent: extend the current interval
      const nextEndNorm = normalizeForComparison(next.end);
      if (nextEndNorm > currentEndNorm) {
        current.end = next.end;
      }
      // Merge account_ids (deduplicate)
      for (const aid of next.account_ids) {
        if (!current.account_ids.includes(aid)) {
          current.account_ids.push(aid);
        }
      }
    } else {
      // Gap found: push current and start new
      merged.push(current);
      current = {
        start: next.start,
        end: next.end,
        account_ids: [...next.account_ids],
      };
    }
  }

  // Push the last interval
  merged.push(current);

  return merged;
}

/**
 * Compute free intervals as gaps between merged busy intervals
 * within the given [rangeStart, rangeEnd) window.
 *
 * Assumes busyIntervals are already sorted and non-overlapping
 * (i.e., output of mergeIntervals).
 *
 * Uses normalizeForComparison to handle mixed date/datetime strings
 * correctly (all-day events use YYYY-MM-DD, timed events use ISO 8601 datetime).
 */
export function computeFreeIntervals(
  busyIntervals: BusyInterval[],
  rangeStart: string,
  rangeEnd: string,
): FreeInterval[] {
  const free: FreeInterval[] = [];
  let cursor = rangeStart;

  for (const busy of busyIntervals) {
    const busyStartNorm = normalizeForComparison(busy.start);
    const busyEndNorm = normalizeForComparison(busy.end);
    const cursorNorm = normalizeForComparison(cursor);

    // If there is a gap before this busy interval, add a free interval
    if (busyStartNorm > cursorNorm) {
      free.push({ start: cursor, end: busy.start });
    }
    // Advance cursor past this busy interval
    if (busyEndNorm > cursorNorm) {
      cursor = busy.end;
    }
  }

  // If there is time left after the last busy interval, add a free interval
  const cursorNorm = normalizeForComparison(cursor);
  const rangeEndNorm = normalizeForComparison(rangeEnd);
  if (cursorNorm < rangeEndNorm) {
    free.push({ start: cursor, end: rangeEnd });
  }

  return free;
}

// ---------------------------------------------------------------------------
// Working hours constraint helpers
// ---------------------------------------------------------------------------

/**
 * Working hours config shape as stored in config_json.
 */
export interface WorkingHoursConfig {
  /** Days of the week this applies to (0=Sunday through 6=Saturday). */
  readonly days: number[];
  /** Start time in HH:MM 24-hour format. */
  readonly start_time: string;
  /** End time in HH:MM 24-hour format. */
  readonly end_time: string;
  /** IANA timezone string (e.g. "America/New_York"). */
  readonly timezone: string;
}

/**
 * Get the day of week (0=Sunday through 6=Saturday) for a Date
 * in a specific timezone.
 */
function getDayOfWeekInTimezone(date: Date, timezone: string): number {
  // Format the date in the target timezone and extract the weekday
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
  });
  const weekdayStr = formatter.format(date);

  const dayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  return dayMap[weekdayStr] ?? 0;
}

/**
 * Extract local time parts (hours, minutes, date string) for a UTC timestamp
 * in a specific timezone.
 */
function getLocalTimeParts(
  date: Date,
  timezone: string,
): { hours: number; minutes: number; dateStr: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  let hours = 0;
  let minutes = 0;
  let year = "";
  let month = "";
  let day = "";

  for (const part of parts) {
    switch (part.type) {
      case "hour":
        hours = parseInt(part.value, 10);
        // Handle midnight: Intl formats 24 as "24" in hour24 mode
        if (hours === 24) hours = 0;
        break;
      case "minute":
        minutes = parseInt(part.value, 10);
        break;
      case "year":
        year = part.value;
        break;
      case "month":
        month = part.value.padStart(2, "0");
        break;
      case "day":
        day = part.value.padStart(2, "0");
        break;
    }
  }

  return { hours, minutes, dateStr: `${year}-${month}-${day}` };
}

/**
 * Get the UTC timestamp (ms) for a specific HH:MM time on a given date
 * in a specific timezone.
 *
 * For example, getTimestampForTimeInTimezone(date, "09:00", "America/New_York")
 * returns the UTC ms timestamp for 9:00 AM Eastern on that date.
 */
function getTimestampForTimeInTimezone(
  baseDate: Date,
  time: string,
  timezone: string,
): number {
  // Get the date components in the target timezone
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const dateParts = formatter.format(baseDate); // "YYYY-MM-DD"

  const [hours, minutes] = time.split(":").map(Number);

  // Use an iterative approach: guess UTC, check local, adjust
  // Start with naive UTC guess
  const utcGuess = new Date(`${dateParts}T${time}:00Z`).getTime();

  // Get what local time this UTC timestamp maps to in the timezone
  const localParts = getLocalTimeParts(new Date(utcGuess), timezone);
  const targetMinutes = hours * 60 + minutes;
  const actualMinutes = localParts.hours * 60 + localParts.minutes;

  // Adjust by the difference
  const diffMs = (targetMinutes - actualMinutes) * 60 * 1000;

  // Also check if the date rolled over
  if (localParts.dateStr !== dateParts) {
    // Date mismatch -- more complex timezone handling needed
    // Re-derive: if local date is day+1, subtract 24h; if day-1, add 24h
    const localDate = new Date(localParts.dateStr).getTime();
    const targetDate = new Date(dateParts).getTime();
    const dateDiffMs = targetDate - localDate;
    return utcGuess + diffMs + dateDiffMs;
  }

  return utcGuess + diffMs;
}

/**
 * Expand working_hours constraints into "outside working hours" busy intervals.
 *
 * For a given time range, this function determines which periods fall OUTSIDE
 * working hours and returns them as busy intervals. When multiple working_hours
 * constraints exist, their working periods are unioned: a time slot is
 * considered "working time" if ANY constraint covers it. Only time slots
 * not covered by any constraint become busy.
 *
 * Algorithm:
 * 1. For each day in the range, compute working periods from all constraints
 * 2. Union (merge) all working periods
 * 3. The gaps between working periods (and before/after them) are "outside
 *    working hours" and thus busy
 *
 * Returns empty array when no working_hours constraints exist.
 */
export function expandWorkingHoursToOutsideBusy(
  constraints: readonly { config_json: Record<string, unknown> }[],
  rangeStart: string,
  rangeEnd: string,
): BusyInterval[] {
  if (constraints.length === 0) return [];

  const configs: WorkingHoursConfig[] = constraints.map(
    (c) => c.config_json as unknown as WorkingHoursConfig,
  );

  const rangeStartMs = new Date(rangeStart).getTime();
  const rangeEndMs = new Date(rangeEnd).getTime();

  if (rangeStartMs >= rangeEndMs) return [];

  // Collect all working intervals across all constraints for the range
  const workingIntervals: { start: number; end: number }[] = [];

  // Iterate day by day across the range. We expand slightly to cover
  // timezone edge cases (a working day in e.g. Pacific could start on the
  // "previous" UTC day).
  const oneDayMs = 24 * 60 * 60 * 1000;
  // Start one day before range start to handle timezone offsets
  const scanStart = rangeStartMs - oneDayMs;
  const scanEnd = rangeEndMs + oneDayMs;

  for (const config of configs) {
    // For each day in the scan window, check if this config applies
    let dayStart = scanStart;
    while (dayStart < scanEnd) {
      const dayDate = new Date(dayStart);
      // Get day-of-week in the constraint's timezone
      const dayOfWeek = getDayOfWeekInTimezone(dayDate, config.timezone);

      if (config.days.includes(dayOfWeek)) {
        // This constraint applies to this day
        const workStart = getTimestampForTimeInTimezone(
          dayDate,
          config.start_time,
          config.timezone,
        );
        const workEnd = getTimestampForTimeInTimezone(
          dayDate,
          config.end_time,
          config.timezone,
        );

        // Only include if it overlaps with the query range
        if (workEnd > rangeStartMs && workStart < rangeEndMs) {
          workingIntervals.push({
            start: Math.max(workStart, rangeStartMs),
            end: Math.min(workEnd, rangeEndMs),
          });
        }
      }

      dayStart += oneDayMs;
    }
  }

  if (workingIntervals.length === 0) {
    // No working hours at all in this range -- entire range is outside working hours
    return [{
      start: rangeStart,
      end: rangeEnd,
      account_ids: ["working_hours"],
    }];
  }

  // Merge overlapping working intervals
  workingIntervals.sort((a, b) => a.start - b.start);
  const mergedWorking: { start: number; end: number }[] = [];
  let current = { ...workingIntervals[0] };

  for (let i = 1; i < workingIntervals.length; i++) {
    const next = workingIntervals[i];
    if (next.start <= current.end) {
      current.end = Math.max(current.end, next.end);
    } else {
      mergedWorking.push(current);
      current = { ...next };
    }
  }
  mergedWorking.push(current);

  // Compute gaps (outside working hours) between working intervals
  const outsideBusy: BusyInterval[] = [];
  let cursor = rangeStartMs;

  for (const work of mergedWorking) {
    if (work.start > cursor) {
      outsideBusy.push({
        start: new Date(cursor).toISOString(),
        end: new Date(work.start).toISOString(),
        account_ids: ["working_hours"],
      });
    }
    if (work.end > cursor) {
      cursor = work.end;
    }
  }

  // Gap after the last working interval
  if (cursor < rangeEndMs) {
    outsideBusy.push({
      start: new Date(cursor).toISOString(),
      end: rangeEnd,
      account_ids: ["working_hours"],
    });
  }

  return outsideBusy;
}

// ---------------------------------------------------------------------------
// Buffer constraint helpers
// ---------------------------------------------------------------------------

/**
 * Buffer config shape as stored in config_json.
 */
export interface BufferConfig {
  /** Buffer type: travel and prep apply before events, cooldown applies after. */
  readonly type: "travel" | "prep" | "cooldown";
  /** Buffer duration in minutes. */
  readonly minutes: number;
  /** Which events the buffer applies to: 'all' or 'external' only. */
  readonly applies_to: "all" | "external";
}

/**
 * Minimal event row shape needed by expandBuffersToBusy.
 * Matches the columns queried by computeAvailability.
 */
export interface EventRowForBuffer {
  readonly start_ts: string;
  readonly end_ts: string;
  readonly origin_account_id: string;
}

/**
 * Expand buffer constraints into busy intervals around existing events.
 *
 * For each buffer constraint, generates additional busy time around events:
 * - type='travel': adds buffer BEFORE the event (travel time to get there)
 * - type='prep': adds buffer BEFORE the event (preparation time)
 * - type='cooldown': adds buffer AFTER the event (recovery/wind-down time)
 *
 * When applies_to='external', buffers only apply to events where
 * origin_account_id is not 'internal' (i.e., real calendar events,
 * not system-generated ones like trip blocks).
 *
 * Returns BusyInterval[] -- these are NOT calendar events, just busy slots
 * that reduce availability.
 *
 * Pure function: no side effects, no database access.
 */
export function expandBuffersToBusy(
  constraints: readonly { config_json: Record<string, unknown> }[],
  events: readonly EventRowForBuffer[],
): BusyInterval[] {
  if (constraints.length === 0 || events.length === 0) return [];

  const configs: BufferConfig[] = constraints.map(
    (c) => c.config_json as unknown as BufferConfig,
  );

  const bufferIntervals: BusyInterval[] = [];

  for (const config of configs) {
    const bufferMs = config.minutes * 60 * 1000;

    for (const event of events) {
      // Skip internal events when applies_to is 'external'
      if (config.applies_to === "external" && event.origin_account_id === "internal") {
        continue;
      }

      const eventStartMs = new Date(event.start_ts).getTime();
      const eventEndMs = new Date(event.end_ts).getTime();

      if (config.type === "travel" || config.type === "prep") {
        // Buffer goes BEFORE the event
        const bufferStart = new Date(eventStartMs - bufferMs).toISOString();
        bufferIntervals.push({
          start: bufferStart,
          end: event.start_ts,
          account_ids: ["buffer"],
        });
      } else if (config.type === "cooldown") {
        // Buffer goes AFTER the event
        const bufferEnd = new Date(eventEndMs + bufferMs).toISOString();
        bufferIntervals.push({
          start: event.end_ts,
          end: bufferEnd,
          account_ids: ["buffer"],
        });
      }
    }
  }

  return bufferIntervals;
}

// ---------------------------------------------------------------------------
// Trip constraint helpers
// ---------------------------------------------------------------------------

/**
 * Expand trip constraints into busy intervals for the query range.
 *
 * Trip constraints have active_from and active_to dates that define the trip
 * period. Any overlap with the query range produces a busy interval.
 *
 * Pure function: no side effects, no database access.
 */
export function expandTripConstraintsToBusy(
  constraints: readonly { active_from: string | null; active_to: string | null }[],
  rangeStart: string,
  rangeEnd: string,
): BusyInterval[] {
  if (constraints.length === 0) return [];

  const rangeStartMs = new Date(rangeStart).getTime();
  const rangeEndMs = new Date(rangeEnd).getTime();
  if (rangeStartMs >= rangeEndMs) return [];

  const intervals: BusyInterval[] = [];

  for (const constraint of constraints) {
    if (!constraint.active_from || !constraint.active_to) continue;

    const tripStartMs = new Date(constraint.active_from).getTime();
    const tripEndMs = new Date(constraint.active_to).getTime();

    // Check overlap with query range
    if (tripEndMs <= rangeStartMs || tripStartMs >= rangeEndMs) continue;

    // Clamp to query range
    const clampedStart = Math.max(tripStartMs, rangeStartMs);
    const clampedEnd = Math.min(tripEndMs, rangeEndMs);

    intervals.push({
      start: new Date(clampedStart).toISOString(),
      end: new Date(clampedEnd).toISOString(),
      account_ids: ["trip"],
    });
  }

  return intervals;
}

// ---------------------------------------------------------------------------
// No-meetings-after constraint helpers
// ---------------------------------------------------------------------------

/**
 * Config shape for no_meetings_after constraints as stored in config_json.
 */
export interface NoMeetingsAfterConfig {
  /** Cutoff time in HH:MM 24-hour format. */
  readonly time: string;
  /** IANA timezone string (e.g. "America/New_York"). */
  readonly timezone: string;
}

/**
 * Expand no_meetings_after constraints into busy intervals.
 *
 * For each day in the query range, the time from the cutoff to midnight
 * (end of day) in the constraint's timezone is marked as busy.
 *
 * When multiple no_meetings_after constraints exist, the EARLIEST cutoff
 * wins for each day (most restrictive).
 *
 * Pure function: no side effects, no database access.
 */
export function expandNoMeetingsAfterToBusy(
  constraints: readonly { config_json: Record<string, unknown> }[],
  rangeStart: string,
  rangeEnd: string,
): BusyInterval[] {
  if (constraints.length === 0) return [];

  const configs: NoMeetingsAfterConfig[] = constraints.map(
    (c) => c.config_json as unknown as NoMeetingsAfterConfig,
  );

  const rangeStartMs = new Date(rangeStart).getTime();
  const rangeEndMs = new Date(rangeEnd).getTime();

  if (rangeStartMs >= rangeEndMs) return [];

  const busyIntervals: BusyInterval[] = [];
  const oneDayMs = 24 * 60 * 60 * 1000;

  // Scan day by day with timezone buffer to handle edge cases
  const scanStart = rangeStartMs - oneDayMs;
  const scanEnd = rangeEndMs + oneDayMs;

  let dayStart = scanStart;
  while (dayStart < scanEnd) {
    const dayDate = new Date(dayStart);

    let earliestCutoffMs: number | null = null;
    let earliestTimezone: string | null = null;

    for (const config of configs) {
      // Get the cutoff timestamp in UTC for this day/timezone
      const cutoffMs = getTimestampForTimeInTimezone(
        dayDate,
        config.time,
        config.timezone,
      );

      // End of this day in the constraint's timezone (midnight next day)
      const endOfDayMs = getTimestampForTimeInTimezone(
        dayDate,
        "23:59",
        config.timezone,
      ) + 60_000; // Add 1 minute to reach midnight

      // Skip if this day's cutoff-to-midnight doesn't overlap with query range
      if (endOfDayMs <= rangeStartMs || cutoffMs >= rangeEndMs) {
        continue;
      }

      if (earliestCutoffMs === null || cutoffMs < earliestCutoffMs) {
        earliestCutoffMs = cutoffMs;
        earliestTimezone = config.timezone;
      }
    }

    if (earliestCutoffMs !== null && earliestTimezone !== null) {
      // Busy from cutoff to end of day in the earliest constraint's timezone
      const endOfDayMs = getTimestampForTimeInTimezone(
        dayDate,
        "23:59",
        earliestTimezone,
      ) + 60_000;

      // Clamp to query range
      const busyStart = Math.max(earliestCutoffMs, rangeStartMs);
      const busyEnd = Math.min(endOfDayMs, rangeEndMs);

      if (busyStart < busyEnd) {
        busyIntervals.push({
          start: new Date(busyStart).toISOString(),
          end: new Date(busyEnd).toISOString(),
          account_ids: ["no_meetings_after"],
        });
      }
    }

    dayStart += oneDayMs;
  }

  return busyIntervals;
}
