/**
 * Multi-user availability intersection (pure functions).
 *
 * Given free/busy data from multiple users, computes the union of all
 * busy intervals to produce a single merged busy list. The greedy solver
 * then operates on this merged list to find mutually free slots.
 *
 * Privacy: These functions operate on BusyInterval arrays (start/end/account_ids).
 * No event titles, descriptions, or other details cross user boundaries.
 * Each user's UserGraphDO only returns free/busy -- never event details --
 * to GroupScheduleDO.
 */

import type { BusyInterval } from "@tminus/workflow-scheduling";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Free/busy response from a single user's UserGraphDO. */
export interface UserAvailability {
  /** The T-Minus user ID (owner of the UserGraphDO). */
  readonly userId: string;
  /** Busy intervals across all of this user's accounts. */
  readonly busyIntervals: readonly BusyInterval[];
}

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

/**
 * Merge busy intervals from multiple users into a single unified busy list.
 *
 * The output is suitable for feeding directly into the greedy solver.
 * Account IDs in the output are synthetic ("group_<userId>") to avoid
 * leaking real account IDs across user boundaries.
 *
 * Overlapping intervals from different users are kept separate (the solver
 * handles overlapping busy intervals correctly). Overlapping intervals from
 * the same user are merged to reduce solver work.
 *
 * @param userAvailabilities - Free/busy data from each participant
 * @returns Merged busy intervals with synthetic account IDs
 */
export function mergeBusyIntervals(
  userAvailabilities: readonly UserAvailability[],
): BusyInterval[] {
  const allBusy: BusyInterval[] = [];

  for (const ua of userAvailabilities) {
    // Merge overlapping intervals within each user first, then tag with
    // a synthetic group account ID for privacy
    const merged = mergeOverlapping(ua.busyIntervals);
    const syntheticAccountId = `group_${ua.userId}`;

    for (const interval of merged) {
      allBusy.push({
        start: interval.start,
        end: interval.end,
        account_ids: [syntheticAccountId],
      });
    }
  }

  return allBusy;
}

/**
 * Compute the set of synthetic "group_<userId>" account IDs that the
 * solver should treat as "required" -- meaning ALL participants must be
 * free for a slot to be valid.
 *
 * @param userIds - Array of participating user IDs
 * @returns Array of synthetic account IDs for solver's requiredAccountIds
 */
export function buildGroupAccountIds(userIds: readonly string[]): string[] {
  return userIds.map((uid) => `group_${uid}`);
}

/**
 * Merge overlapping or adjacent intervals within a single user's busy list.
 * Returns a sorted, non-overlapping array.
 *
 * Exported for testing.
 */
export function mergeOverlapping(
  intervals: readonly BusyInterval[],
): Array<{ start: string; end: string }> {
  if (intervals.length === 0) return [];

  // Sort by start time
  const sorted = [...intervals].sort(
    (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime(),
  );

  const result: Array<{ start: string; end: string }> = [];
  let current = { start: sorted[0].start, end: sorted[0].end };

  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i];
    const currentEnd = new Date(current.end).getTime();
    const nextStart = new Date(next.start).getTime();

    if (nextStart <= currentEnd) {
      // Overlapping or adjacent -- extend current
      const nextEnd = new Date(next.end).getTime();
      if (nextEnd > currentEnd) {
        current.end = next.end;
      }
    } else {
      // Gap -- push current, start new
      result.push({ ...current });
      current = { start: next.start, end: next.end };
    }
  }

  result.push(current);
  return result;
}
