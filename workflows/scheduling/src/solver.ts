/**
 * Greedy scheduling solver for T-Minus (AD-3).
 *
 * Enumerates 30-minute aligned slots within a time window, filters out
 * slots that overlap any busy interval for any required account, scores
 * remaining slots by time-of-day preference and adjacency, and returns
 * the top N candidates sorted by score descending.
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
 * Time complexity: O(S * B) where S = number of slots and B = number of
 * busy intervals. For a 1-week window with 30-min steps, S ~ 336. Typical
 * B is < 100. This is well within Workers limits.
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
  const candidates: ScoredCandidate[] = [];

  // Enumerate 30-minute aligned slots
  for (let slotStart = windowStartMs; slotStart + durationMs <= windowEndMs; slotStart += stepMs) {
    const slotEnd = slotStart + durationMs;

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

    // Score this slot
    const { score, explanation } = scoreSlot(
      slotStart,
      slotEnd,
      windowStartMs,
      busyRanges,
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

  return {
    score,
    explanation: reasons.join(", "),
  };
}
