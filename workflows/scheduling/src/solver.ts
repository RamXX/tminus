/**
 * Greedy scheduling solver for T-Minus (AD-3).
 *
 * Enumerates 30-minute aligned slots within a time window, filters out
 * slots that overlap any busy interval for any required account, scores
 * remaining slots by time-of-day preference, adjacency, and constraint
 * awareness, and returns the top N candidates sorted by score descending.
 *
 * This is a pure function with no side effects, no database access, and
 * no external dependencies. It runs well within the 128 MB Workers limit.
 *
 * Scoring:
 * - Morning bonus: slots between 08:00-12:00 UTC get +20 points
 * - Afternoon penalty: slots between 12:00-17:00 UTC get +10 points
 * - Evening penalty: slots after 17:00 UTC get +0 points
 * - Adjacency penalty: -5 points per busy interval that ends or starts
 *   within 30 minutes of the candidate slot
 * - Earlier-in-week bonus: +1 point per day closer to window start
 *
 * Constraint-aware scoring (TM-946.2):
 * - Working hours bonus: +15 if slot falls entirely within working hours
 * - Buffer adequacy bonus: +10 if slot has adequate buffer gap from events
 * - Trip exclusion: slots overlapping trips are hard-excluded (score 0)
 * - No-meetings-after penalty: -20 for slots past the daily cutoff
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A busy interval from computeAvailability. */
export interface BusyInterval {
  readonly start: string;
  readonly end: string;
  readonly account_ids: string[];
}

// -- Constraint types for solver scoring --

/** Working hours constraint: defines allowed meeting times. */
export interface WorkingHoursConstraint {
  readonly kind: "working_hours";
  readonly config: {
    readonly days: readonly number[];     // 0=Sunday through 6=Saturday
    readonly start_time: string;          // HH:MM 24-hour
    readonly end_time: string;            // HH:MM 24-hour
    readonly timezone: string;            // IANA timezone
  };
}

/** Trip constraint: blocks all scheduling during the trip period. */
export interface TripConstraint {
  readonly kind: "trip";
  readonly activeFrom: string;  // ISO 8601
  readonly activeTo: string;    // ISO 8601
}

/** Buffer constraint: requires buffer time around events. */
export interface BufferConstraint {
  readonly kind: "buffer";
  readonly config: {
    readonly type: "travel" | "prep" | "cooldown";
    readonly minutes: number;
    readonly applies_to: "all" | "external";
  };
}

/** No-meetings-after constraint: daily cutoff time. */
export interface NoMeetingsAfterConstraint {
  readonly kind: "no_meetings_after";
  readonly config: {
    readonly time: string;       // HH:MM 24-hour
    readonly timezone: string;   // IANA timezone
  };
}

/** VIP override constraint: relaxes working hours for VIP participants. */
export interface VipOverrideConstraint {
  readonly kind: "vip_override";
  readonly config: {
    readonly participant_hash: string;
    readonly display_name: string;
    readonly priority_weight: number;
    readonly allow_after_hours: boolean;
    readonly min_notice_hours: number;
    readonly override_deep_work: boolean;
  };
}

/** Union type for all solver constraints. */
export type SolverConstraint =
  | WorkingHoursConstraint
  | TripConstraint
  | BufferConstraint
  | NoMeetingsAfterConstraint
  | VipOverrideConstraint;

/** Input to the greedy solver. */
export interface SolverInput {
  /** ISO 8601 start of the scheduling window. */
  readonly windowStart: string;
  /** ISO 8601 end of the scheduling window. */
  readonly windowEnd: string;
  /** Requested meeting duration in minutes. */
  readonly durationMinutes: number;
  /** Busy intervals across all relevant accounts. */
  readonly busyIntervals: readonly BusyInterval[];
  /** Account IDs that must all be free for a candidate to be valid. */
  readonly requiredAccountIds: readonly string[];
  /** Optional constraints for enhanced scoring and filtering. */
  readonly constraints?: readonly SolverConstraint[];
  /** Participant hashes for the meeting attendees (for VIP matching). */
  readonly participantHashes?: readonly string[];
}

/** A scored candidate slot. */
export interface ScoredCandidate {
  /** ISO 8601 start of the proposed slot. */
  readonly start: string;
  /** ISO 8601 end of the proposed slot. */
  readonly end: string;
  /** Numeric score (higher is better). */
  readonly score: number;
  /** Human-readable explanation of why this slot was chosen. */
  readonly explanation: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Slot alignment in minutes. */
const SLOT_STEP_MINUTES = 30;

/** Adjacency threshold in milliseconds (30 minutes). */
const ADJACENCY_THRESHOLD_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
// Solver
// ---------------------------------------------------------------------------

/**
 * Greedy interval enumeration solver.
 *
 * Iterates 30-minute aligned slots in [windowStart, windowEnd), checks each
 * slot of length durationMinutes against all busy intervals. If no busy
 * interval overlaps the slot for any required account, the slot is a
 * candidate. Candidates are scored and the top maxCandidates are returned.
 *
 * When constraints are provided, they influence both filtering (trip
 * constraints hard-exclude overlapping slots) and scoring (working hours,
 * buffer adequacy, no-meetings-after).
 *
 * Time complexity: O(S * (B + C)) where S = number of slots, B = number of
 * busy intervals, and C = number of constraints. For a 1-week window with
 * 30-min steps, S ~ 336. Typical B < 100, C < 20. Well within Workers limits.
 *
 * @param input - Solver input parameters
 * @param maxCandidates - Maximum number of candidates to return (default 5)
 * @returns Scored candidates sorted by score descending
 */
export function greedySolver(
  input: SolverInput,
  maxCandidates = 5,
): ScoredCandidate[] {
  const windowStartMs = new Date(input.windowStart).getTime();
  const windowEndMs = new Date(input.windowEnd).getTime();
  const durationMs = input.durationMinutes * 60 * 1000;
  const stepMs = SLOT_STEP_MINUTES * 60 * 1000;

  // Pre-compute busy intervals as ms ranges for faster comparison
  const busyRanges = input.busyIntervals.map((b) => ({
    start: new Date(b.start).getTime(),
    end: new Date(b.end).getTime(),
    accountIds: new Set(b.account_ids),
  }));

  const requiredSet = new Set(input.requiredAccountIds);
  const constraints = input.constraints ?? [];

  // Pre-compute trip ranges for fast overlap checks
  const tripRanges = precomputeTripRanges(constraints);

  const candidates: ScoredCandidate[] = [];

  // Enumerate 30-minute aligned slots
  for (let slotStart = windowStartMs; slotStart + durationMs <= windowEndMs; slotStart += stepMs) {
    const slotEnd = slotStart + durationMs;

    // Hard-exclude: trip constraint overlap (belt + suspenders with busy intervals)
    if (isBlockedByTrip(slotStart, slotEnd, tripRanges)) {
      continue;
    }

    // Check if any busy interval overlaps this slot for any required account
    let blocked = false;
    for (const busy of busyRanges) {
      // Overlap: slot starts before busy ends AND slot ends after busy starts
      if (slotStart < busy.end && slotEnd > busy.start) {
        // Check if any required account is in this busy interval
        for (const accId of requiredSet) {
          if (busy.accountIds.has(accId)) {
            blocked = true;
            break;
          }
        }
        if (blocked) break;
      }
    }

    if (blocked) continue;

    // Score this slot (base + constraint-aware + VIP-aware)
    const { score, explanation } = scoreSlot(
      slotStart,
      slotEnd,
      windowStartMs,
      busyRanges,
      constraints,
      input.participantHashes,
    );

    candidates.push({
      start: new Date(slotStart).toISOString().replace(".000Z", "Z"),
      end: new Date(slotEnd).toISOString().replace(".000Z", "Z"),
      score,
      explanation,
    });
  }

  // Sort by score descending, then by start time ascending for stability
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.start.localeCompare(b.start);
  });

  return candidates.slice(0, maxCandidates);
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function scoreSlot(
  slotStartMs: number,
  slotEndMs: number,
  windowStartMs: number,
  busyRanges: ReadonlyArray<{ start: number; end: number }>,
  constraints: readonly SolverConstraint[],
  participantHashes?: readonly string[],
): { score: number; explanation: string } {
  let score = 0;
  const reasons: string[] = [];

  // Time-of-day preference (based on UTC hour of slot start)
  const hour = new Date(slotStartMs).getUTCHours();
  if (hour >= 8 && hour < 12) {
    score += 20;
    reasons.push("morning slot (+20)");
  } else if (hour >= 12 && hour < 17) {
    score += 10;
    reasons.push("afternoon slot (+10)");
  } else {
    reasons.push("evening/early slot (+0)");
  }

  // Adjacency penalty: penalize slots close to existing events
  let adjacentCount = 0;
  for (const busy of busyRanges) {
    // Check if busy interval ends within ADJACENCY_THRESHOLD_MS before slot start
    const gapBefore = slotStartMs - busy.end;
    if (gapBefore >= 0 && gapBefore < ADJACENCY_THRESHOLD_MS) {
      adjacentCount++;
    }
    // Check if busy interval starts within ADJACENCY_THRESHOLD_MS after slot end
    const gapAfter = busy.start - slotEndMs;
    if (gapAfter >= 0 && gapAfter < ADJACENCY_THRESHOLD_MS) {
      adjacentCount++;
    }
  }
  if (adjacentCount > 0) {
    const penalty = adjacentCount * 5;
    score -= penalty;
    reasons.push(`adjacent to ${adjacentCount} event(s) (-${penalty})`);
  }

  // Earlier-in-week bonus: 1 point per day closer to window start
  const daysFromStart = (slotStartMs - windowStartMs) / (24 * 60 * 60 * 1000);
  const dayBonus = Math.max(0, 7 - Math.floor(daysFromStart));
  score += dayBonus;
  if (dayBonus > 0) {
    reasons.push(`early in window (+${dayBonus})`);
  }

  // -----------------------------------------------------------------------
  // Constraint-aware scoring (TM-946.2)
  // -----------------------------------------------------------------------

  if (constraints.length > 0) {
    // Working hours bonus: +15 if slot falls entirely within working hours
    const whResult = scoreWorkingHours(slotStartMs, slotEndMs, constraints);
    score += whResult.delta;
    if (whResult.reason) reasons.push(whResult.reason);

    // Buffer adequacy bonus: +10 if slot has adequate buffer from events
    const bufResult = scoreBufferAdequacy(slotStartMs, slotEndMs, busyRanges, constraints);
    score += bufResult.delta;
    if (bufResult.reason) reasons.push(bufResult.reason);

    // No-meetings-after penalty: -20 if slot violates daily cutoff
    const nmaResult = scoreNoMeetingsAfter(slotStartMs, slotEndMs, constraints);
    score += nmaResult.delta;
    if (nmaResult.reason) reasons.push(nmaResult.reason);

    // VIP override: if participants include a VIP with allow_after_hours,
    // compensate for working hours violation and add priority weight bonus
    const vipResult = scoreVipOverride(slotStartMs, slotEndMs, constraints, participantHashes, whResult);
    score += vipResult.delta;
    if (vipResult.reason) reasons.push(vipResult.reason);
  }

  return {
    score,
    explanation: reasons.join(", "),
  };
}

// ---------------------------------------------------------------------------
// Constraint scoring helpers (pure functions)
// ---------------------------------------------------------------------------

/** Scoring constants for constraint-aware evaluation. */
export const CONSTRAINT_SCORES = {
  WORKING_HOURS_BONUS: 15,
  WORKING_HOURS_VIOLATION: -10,
  BUFFER_ADEQUATE_BONUS: 10,
  BUFFER_INADEQUATE_PENALTY: -5,
  NO_MEETINGS_AFTER_PENALTY: -20,
  VIP_OVERRIDE_BONUS: 25,
  VIP_PRIORITY_WEIGHT_MULTIPLIER: 10,
} as const;

/**
 * Pre-compute trip ranges from constraints for fast overlap checks.
 * Returns sorted array of {start, end} in milliseconds.
 */
function precomputeTripRanges(
  constraints: readonly SolverConstraint[],
): ReadonlyArray<{ start: number; end: number }> {
  const ranges: { start: number; end: number }[] = [];
  for (const c of constraints) {
    if (c.kind === "trip") {
      ranges.push({
        start: new Date(c.activeFrom).getTime(),
        end: new Date(c.activeTo).getTime(),
      });
    }
  }
  return ranges;
}

/**
 * Check if a slot overlaps any trip constraint.
 * Trips are hard exclusions: any overlap means the slot is blocked.
 */
function isBlockedByTrip(
  slotStartMs: number,
  slotEndMs: number,
  tripRanges: ReadonlyArray<{ start: number; end: number }>,
): boolean {
  for (const trip of tripRanges) {
    if (slotStartMs < trip.end && slotEndMs > trip.start) {
      return true;
    }
  }
  return false;
}

/**
 * Score a slot based on working hours constraints.
 *
 * If working hours constraints exist:
 * - Slot fully within working hours: +15
 * - Slot partially or fully outside: -10
 * - No working hours on this day: no adjustment (neutral)
 *
 * When multiple working hours constraints exist, they are unioned:
 * a slot is "within working hours" if ANY constraint covers it.
 */
function scoreWorkingHours(
  slotStartMs: number,
  slotEndMs: number,
  constraints: readonly SolverConstraint[],
): { delta: number; reason: string | null } {
  const whConstraints = constraints.filter(
    (c): c is WorkingHoursConstraint => c.kind === "working_hours",
  );

  if (whConstraints.length === 0) return { delta: 0, reason: null };

  const slotDate = new Date(slotStartMs);
  const slotDay = slotDate.getUTCDay();

  // Check if any working hours constraint applies to this day and covers the slot
  let anyApplies = false;
  let fullyCovered = false;

  for (const wh of whConstraints) {
    // Check day-of-week. We use UTC day for simplicity when timezone is UTC.
    // For non-UTC timezones, we use Intl to get the correct day.
    let dayOfWeek: number;
    if (wh.config.timezone === "UTC") {
      dayOfWeek = slotDay;
    } else {
      dayOfWeek = getDayOfWeekInTimezone(slotDate, wh.config.timezone);
    }

    if (!wh.config.days.includes(dayOfWeek)) continue;
    anyApplies = true;

    // Compute working hours range for this day in the constraint's timezone
    const workStart = getTimestampForTimeInTimezone(
      slotDate,
      wh.config.start_time,
      wh.config.timezone,
    );
    const workEnd = getTimestampForTimeInTimezone(
      slotDate,
      wh.config.end_time,
      wh.config.timezone,
    );

    // Check if slot is fully within this working hours range
    if (slotStartMs >= workStart && slotEndMs <= workEnd) {
      fullyCovered = true;
      break;
    }
  }

  if (!anyApplies) {
    // No working hours constraint applies to this day -- neutral
    return { delta: 0, reason: null };
  }

  if (fullyCovered) {
    return {
      delta: CONSTRAINT_SCORES.WORKING_HOURS_BONUS,
      reason: `within working hours (+${CONSTRAINT_SCORES.WORKING_HOURS_BONUS})`,
    };
  }

  return {
    delta: CONSTRAINT_SCORES.WORKING_HOURS_VIOLATION,
    reason: `outside working hours (${CONSTRAINT_SCORES.WORKING_HOURS_VIOLATION})`,
  };
}

/**
 * Score a slot based on buffer constraint adequacy.
 *
 * If buffer constraints exist, checks whether the slot has adequate
 * gap from nearby busy events (based on the required buffer minutes).
 *
 * - All buffers satisfied: +10
 * - Any buffer violated: -5
 * - No buffer constraints: no adjustment
 */
function scoreBufferAdequacy(
  slotStartMs: number,
  slotEndMs: number,
  busyRanges: ReadonlyArray<{ start: number; end: number }>,
  constraints: readonly SolverConstraint[],
): { delta: number; reason: string | null } {
  const bufferConstraints = constraints.filter(
    (c): c is BufferConstraint => c.kind === "buffer",
  );

  if (bufferConstraints.length === 0) return { delta: 0, reason: null };

  // Compute the required buffer before and after
  let requiredBeforeMs = 0;
  let requiredAfterMs = 0;

  for (const bc of bufferConstraints) {
    const bufMs = bc.config.minutes * 60 * 1000;
    if (bc.config.type === "travel" || bc.config.type === "prep") {
      requiredBeforeMs = Math.max(requiredBeforeMs, bufMs);
    } else if (bc.config.type === "cooldown") {
      requiredAfterMs = Math.max(requiredAfterMs, bufMs);
    }
  }

  // Check if any busy event is too close (violates buffer)
  let bufferViolated = false;
  for (const busy of busyRanges) {
    // Gap before slot: busy ends before slot starts
    if (busy.end <= slotStartMs) {
      const gap = slotStartMs - busy.end;
      if (gap < requiredBeforeMs) {
        bufferViolated = true;
        break;
      }
    }
    // Gap after slot: busy starts after slot ends
    if (busy.start >= slotEndMs) {
      const gap = busy.start - slotEndMs;
      if (gap < requiredAfterMs) {
        bufferViolated = true;
        break;
      }
    }
  }

  if (bufferViolated) {
    return {
      delta: CONSTRAINT_SCORES.BUFFER_INADEQUATE_PENALTY,
      reason: `insufficient buffer (${CONSTRAINT_SCORES.BUFFER_INADEQUATE_PENALTY})`,
    };
  }

  return {
    delta: CONSTRAINT_SCORES.BUFFER_ADEQUATE_BONUS,
    reason: `adequate buffer (+${CONSTRAINT_SCORES.BUFFER_ADEQUATE_BONUS})`,
  };
}

/**
 * Score a slot based on no_meetings_after constraints.
 *
 * If the slot starts at or after the daily cutoff time, it receives a
 * penalty. When multiple constraints exist, the earliest cutoff wins.
 *
 * Note: computeAvailability already blocks these slots via busy intervals.
 * This scoring is belt+suspenders and differentiates borderline slots.
 */
function scoreNoMeetingsAfter(
  slotStartMs: number,
  _slotEndMs: number,
  constraints: readonly SolverConstraint[],
): { delta: number; reason: string | null } {
  const nmaConstraints = constraints.filter(
    (c): c is NoMeetingsAfterConstraint => c.kind === "no_meetings_after",
  );

  if (nmaConstraints.length === 0) return { delta: 0, reason: null };

  const slotDate = new Date(slotStartMs);

  // Find the earliest cutoff that applies
  let earliestCutoffMs: number | null = null;

  for (const nma of nmaConstraints) {
    const cutoffMs = getTimestampForTimeInTimezone(
      slotDate,
      nma.config.time,
      nma.config.timezone,
    );
    if (earliestCutoffMs === null || cutoffMs < earliestCutoffMs) {
      earliestCutoffMs = cutoffMs;
    }
  }

  if (earliestCutoffMs !== null && slotStartMs >= earliestCutoffMs) {
    return {
      delta: CONSTRAINT_SCORES.NO_MEETINGS_AFTER_PENALTY,
      reason: `past daily cutoff (${CONSTRAINT_SCORES.NO_MEETINGS_AFTER_PENALTY})`,
    };
  }

  return { delta: 0, reason: null };
}

/**
 * Score a slot based on VIP override policies.
 *
 * When participants include a VIP with allow_after_hours=true and the slot
 * was penalized for being outside working hours, the VIP override:
 * 1. Compensates the working hours violation penalty (reverses -10 to neutral)
 * 2. Adds a VIP override bonus (+25)
 * 3. Adds priority weight bonus (weight * 10)
 *
 * This ensures VIP meetings can be scheduled outside working hours while
 * non-VIP meetings remain blocked by working hours constraints.
 */
export function scoreVipOverride(
  _slotStartMs: number,
  _slotEndMs: number,
  constraints: readonly SolverConstraint[],
  participantHashes?: readonly string[],
  workingHoursResult?: { delta: number; reason: string | null },
): { delta: number; reason: string | null } {
  if (!participantHashes || participantHashes.length === 0) {
    return { delta: 0, reason: null };
  }

  const vipConstraints = constraints.filter(
    (c): c is VipOverrideConstraint => c.kind === "vip_override",
  );

  if (vipConstraints.length === 0) return { delta: 0, reason: null };

  // Find matching VIP policies for the meeting participants
  const participantSet = new Set(participantHashes);
  const matchingVips = vipConstraints.filter((v) =>
    participantSet.has(v.config.participant_hash),
  );

  if (matchingVips.length === 0) return { delta: 0, reason: null };

  // Use the highest priority VIP for scoring
  const bestVip = matchingVips.reduce((best, current) =>
    current.config.priority_weight > best.config.priority_weight ? current : best,
  );

  let delta = 0;
  const reasons: string[] = [];

  // If slot was penalized for being outside working hours and VIP allows after hours,
  // compensate the penalty and add VIP bonus
  const isOutsideWorkingHours =
    workingHoursResult &&
    workingHoursResult.delta === CONSTRAINT_SCORES.WORKING_HOURS_VIOLATION;

  if (isOutsideWorkingHours && bestVip.config.allow_after_hours) {
    // Reverse the working hours violation
    delta -= CONSTRAINT_SCORES.WORKING_HOURS_VIOLATION; // removes -10 (adds +10)
    // Add VIP override bonus
    delta += CONSTRAINT_SCORES.VIP_OVERRIDE_BONUS;
    reasons.push(
      `VIP override for ${bestVip.config.display_name}: after-hours allowed (+${CONSTRAINT_SCORES.VIP_OVERRIDE_BONUS + Math.abs(CONSTRAINT_SCORES.WORKING_HOURS_VIOLATION)})`,
    );
  }

  // Add priority weight bonus regardless
  const weightBonus = Math.round(
    bestVip.config.priority_weight * CONSTRAINT_SCORES.VIP_PRIORITY_WEIGHT_MULTIPLIER,
  );
  if (weightBonus > 0) {
    delta += weightBonus;
    reasons.push(`VIP priority weight (+${weightBonus})`);
  }

  return {
    delta,
    reason: reasons.length > 0 ? reasons.join(", ") : null,
  };
}

// ---------------------------------------------------------------------------
// Timezone helpers (duplicated from UserGraphDO for solver purity)
// ---------------------------------------------------------------------------

/**
 * Get the day of week (0=Sunday through 6=Saturday) for a Date
 * in a specific timezone.
 */
function getDayOfWeekInTimezone(date: Date, timezone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
  });
  const weekdayStr = formatter.format(date);

  const dayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };

  return dayMap[weekdayStr] ?? 0;
}

/**
 * Get the UTC timestamp (ms) for a specific HH:MM time on a given date
 * in a specific timezone.
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

  // Start with naive UTC guess
  const utcGuess = new Date(`${dateParts}T${time}:00Z`).getTime();

  // Get what local time this UTC timestamp maps to in the timezone
  const localParts = getLocalTimeParts(new Date(utcGuess), timezone);
  const targetMinutes = hours * 60 + minutes;
  const actualMinutes = localParts.hours * 60 + localParts.minutes;

  // Adjust by the difference
  const diffMs = (targetMinutes - actualMinutes) * 60 * 1000;

  // Check if the date rolled over
  if (localParts.dateStr !== dateParts) {
    const localDate = new Date(localParts.dateStr).getTime();
    const targetDate = new Date(dateParts).getTime();
    const dateDiffMs = targetDate - localDate;
    return utcGuess + diffMs + dateDiffMs;
  }

  return utcGuess + diffMs;
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
