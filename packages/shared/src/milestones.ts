/**
 * @tminus/shared -- Milestone tracking for life event milestones.
 *
 * Pure functions for milestone kind validation, annual recurrence
 * computation, and upcoming milestone filtering.
 *
 * Milestones represent significant life events (birthdays, anniversaries,
 * graduations, funding rounds, relocations) associated with relationship
 * contacts. Milestones with annual recurrence create implicit busy blocks
 * that the scheduler avoids.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Valid milestone kinds. */
export const MILESTONE_KINDS = [
  "birthday",
  "anniversary",
  "graduation",
  "funding",
  "relocation",
  "custom",
] as const;

export type MilestoneKind = (typeof MILESTONE_KINDS)[number];

/** A milestone as stored in the database. */
export interface Milestone {
  readonly milestone_id: string;
  readonly participant_hash: string;
  readonly kind: MilestoneKind;
  /** ISO date string (YYYY-MM-DD) for the milestone date. */
  readonly date: string;
  readonly recurs_annually: boolean;
  readonly note: string | null;
  readonly created_at: string;
}

/** A milestone with its computed next occurrence date. */
export interface UpcomingMilestone extends Milestone {
  /** The next occurrence of this milestone (same as date if non-recurring, or computed for recurring). */
  readonly next_occurrence: string;
  /** Days until the next occurrence from the reference date. */
  readonly days_until: number;
  /** Display name of the associated contact (joined from relationships). */
  readonly display_name: string | null;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate that a string is a valid milestone kind.
 */
export function isValidMilestoneKind(value: string): value is MilestoneKind {
  return MILESTONE_KINDS.includes(value as MilestoneKind);
}

/**
 * Validate a date string is in YYYY-MM-DD format and represents a real date.
 */
export function isValidMilestoneDate(dateStr: string): boolean {
  if (typeof dateStr !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) return false;

  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);

  // Basic range checks
  if (year < 1900 || year > 2200) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;

  // Validate actual date (handles Feb 30, etc.)
  const d = new Date(year, month - 1, day);
  return (
    d.getFullYear() === year &&
    d.getMonth() === month - 1 &&
    d.getDate() === day
  );
}

// ---------------------------------------------------------------------------
// Recurrence computation
// ---------------------------------------------------------------------------

/**
 * Compute the next occurrence of a milestone relative to a reference date.
 *
 * For non-recurring milestones, returns the original date.
 * For annually recurring milestones, returns the next occurrence
 * on or after the reference date by advancing the year.
 *
 * Special handling for Feb 29 (leap day): if the milestone date is Feb 29
 * and the target year is not a leap year, the occurrence is shifted to Feb 28.
 *
 * @param milestoneDate - The original milestone date (YYYY-MM-DD)
 * @param refDate - The reference date (YYYY-MM-DD) to compute from
 * @param recursAnnually - Whether the milestone recurs annually
 * @returns The next occurrence date (YYYY-MM-DD)
 */
export function computeNextOccurrence(
  milestoneDate: string,
  refDate: string,
  recursAnnually: boolean,
): string {
  if (!recursAnnually) {
    return milestoneDate;
  }

  const refYear = parseInt(refDate.slice(0, 4), 10);
  const refMonth = parseInt(refDate.slice(5, 7), 10);
  const refDay = parseInt(refDate.slice(8, 10), 10);

  const milMonth = parseInt(milestoneDate.slice(5, 7), 10);
  const milDay = parseInt(milestoneDate.slice(8, 10), 10);

  // Try this year first
  let targetYear = refYear;

  // Check if this year's occurrence has already passed
  const thisYearOccurrence = resolveLeapDay(targetYear, milMonth, milDay);
  if (
    thisYearOccurrence.month < refMonth ||
    (thisYearOccurrence.month === refMonth && thisYearOccurrence.day < refDay)
  ) {
    // This year's occurrence has passed, use next year
    targetYear++;
  }

  const resolved = resolveLeapDay(targetYear, milMonth, milDay);
  return formatDate(targetYear, resolved.month, resolved.day);
}

/**
 * Compute the number of days between two dates (YYYY-MM-DD).
 * Returns positive if target is after ref, negative if before.
 */
export function daysBetween(refDate: string, targetDate: string): number {
  const ref = new Date(refDate + "T00:00:00Z");
  const target = new Date(targetDate + "T00:00:00Z");
  const diffMs = target.getTime() - ref.getTime();
  return Math.round(diffMs / (24 * 60 * 60 * 1000));
}

/**
 * Expand milestone dates into busy intervals for the scheduler.
 *
 * For each milestone within the query range, creates an all-day busy block.
 * Recurring milestones generate occurrences for each year in the range.
 *
 * @param milestones - Milestones to expand
 * @param rangeStart - Start of the query range (ISO datetime)
 * @param rangeEnd - End of the query range (ISO datetime)
 * @returns Array of {start, end} intervals (all-day blocks)
 */
export function expandMilestonesToBusy(
  milestones: ReadonlyArray<{
    date: string;
    recurs_annually: boolean | number;
  }>,
  rangeStart: string,
  rangeEnd: string,
): Array<{ start: string; end: string }> {
  const startDate = rangeStart.slice(0, 10);
  const endDate = rangeEnd.slice(0, 10);
  const startYear = parseInt(startDate.slice(0, 4), 10);
  const endYear = parseInt(endDate.slice(0, 4), 10);

  const intervals: Array<{ start: string; end: string }> = [];

  for (const ms of milestones) {
    const recurs =
      typeof ms.recurs_annually === "number"
        ? ms.recurs_annually === 1
        : ms.recurs_annually;

    if (!recurs) {
      // Non-recurring: check if the date falls within range
      if (ms.date >= startDate && ms.date <= endDate) {
        intervals.push(makeDayInterval(ms.date));
      }
    } else {
      // Recurring: check each year in range
      const milMonth = parseInt(ms.date.slice(5, 7), 10);
      const milDay = parseInt(ms.date.slice(8, 10), 10);

      for (let year = startYear; year <= endYear; year++) {
        const resolved = resolveLeapDay(year, milMonth, milDay);
        const dateStr = formatDate(year, resolved.month, resolved.day);
        if (dateStr >= startDate && dateStr <= endDate) {
          intervals.push(makeDayInterval(dateStr));
        }
      }
    }
  }

  return intervals;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * Resolve a Feb 29 milestone date to the correct day in a given year.
 * If the year is not a leap year and the date is Feb 29, returns Feb 28.
 */
function resolveLeapDay(
  year: number,
  month: number,
  day: number,
): { month: number; day: number } {
  if (month === 2 && day === 29 && !isLeapYear(year)) {
    return { month: 2, day: 28 };
  }
  return { month, day };
}

function formatDate(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function makeDayInterval(dateStr: string): { start: string; end: string } {
  return {
    start: `${dateStr}T00:00:00Z`,
    end: `${dateStr}T23:59:59Z`,
  };
}
