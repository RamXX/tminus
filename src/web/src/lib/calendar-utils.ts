/**
 * Calendar utility functions.
 *
 * Pure functions for date range computation, color mapping, event grouping,
 * and formatting. No side effects, no React dependencies -- easy to test.
 */
import type { CalendarEvent } from "./api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CalendarViewType = "week" | "month" | "day";

export interface DateRange {
  start: Date;
  end: Date;
}

// ---------------------------------------------------------------------------
// Account color mapping
// ---------------------------------------------------------------------------

/**
 * Curated palette of 12 visually distinct colors.
 * Designed for dark backgrounds (the T-Minus SPA uses a slate-900 theme).
 * Colors are ordered to maximize contrast between adjacent slots.
 */
const ACCOUNT_COLORS = [
  "#3b82f6", // blue-500
  "#ef4444", // red-500
  "#22c55e", // green-500
  "#f59e0b", // amber-500
  "#8b5cf6", // violet-500
  "#ec4899", // pink-500
  "#06b6d4", // cyan-500
  "#f97316", // orange-500
  "#14b8a6", // teal-500
  "#a855f7", // purple-500
  "#eab308", // yellow-500
  "#6366f1", // indigo-500
] as const;

/** Fallback color for events with no origin account. */
const FALLBACK_COLOR = "#94a3b8"; // slate-400

/**
 * Simple string hash (djb2 algorithm).
 * Deterministic: same input always produces same output.
 */
function hashString(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 33) ^ str.charCodeAt(i);
  }
  return hash >>> 0; // Ensure unsigned 32-bit integer
}

/**
 * Get a stable color for an account ID.
 *
 * The same account ID always maps to the same color.
 * Different account IDs map to different colors (modulo palette size).
 * Undefined/null returns a neutral fallback color.
 */
export function getAccountColor(accountId: string | undefined | null): string {
  if (!accountId) return FALLBACK_COLOR;
  const index = hashString(accountId) % ACCOUNT_COLORS.length;
  return ACCOUNT_COLORS[index];
}

// ---------------------------------------------------------------------------
// Date range computation
// ---------------------------------------------------------------------------

/**
 * Get the start (Sunday) and end (Saturday) of the week containing `date`.
 */
export function getWeekRange(date: Date): DateRange {
  const start = new Date(date);
  start.setDate(start.getDate() - start.getDay());
  start.setHours(0, 0, 0, 0);

  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  end.setHours(23, 59, 59, 999);

  return { start, end };
}

/**
 * Get the first and last day of the month containing `date`.
 */
export function getMonthRange(date: Date): DateRange {
  const start = new Date(date.getFullYear(), date.getMonth(), 1);
  start.setHours(0, 0, 0, 0);

  const end = new Date(date.getFullYear(), date.getMonth() + 1, 0);
  end.setHours(23, 59, 59, 999);

  return { start, end };
}

/**
 * Get the start and end of a single day.
 */
export function getDayRange(date: Date): DateRange {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);

  const end = new Date(date);
  end.setHours(23, 59, 59, 999);

  return { start, end };
}

/**
 * Get date range for a given calendar view type.
 */
export function getDateRangeForView(
  date: Date,
  view: CalendarViewType,
): DateRange {
  switch (view) {
    case "week":
      return getWeekRange(date);
    case "month":
      return getMonthRange(date);
    case "day":
      return getDayRange(date);
  }
}

// ---------------------------------------------------------------------------
// Event grouping
// ---------------------------------------------------------------------------

/**
 * Extract the local date key (YYYY-MM-DD) from an ISO timestamp.
 */
function dateKey(iso: string): string {
  const d = new Date(iso);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Group events by their start date (local time).
 * Events within each group are sorted by start time ascending.
 */
export function groupEventsByDate(
  events: CalendarEvent[],
): Record<string, CalendarEvent[]> {
  const groups: Record<string, CalendarEvent[]> = {};

  for (const event of events) {
    const key = dateKey(event.start);
    if (!groups[key]) groups[key] = [];
    groups[key].push(event);
  }

  // Sort events within each group by start time
  for (const key of Object.keys(groups)) {
    groups[key].sort(
      (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime(),
    );
  }

  return groups;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/**
 * Format an ISO string to a short time (e.g. "9:30 AM").
 * Returns the raw string on parse failure.
 */
export function formatTimeShort(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

/**
 * Format a date key (YYYY-MM-DD) or Date to a readable header
 * (e.g. "Wednesday, February 14").
 */
export function formatDateHeader(dateStr: string | Date): string {
  try {
    const d = typeof dateStr === "string" ? new Date(dateStr + "T00:00:00") : dateStr;
    if (isNaN(d.getTime())) return String(dateStr);
    return d.toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
  } catch {
    return String(dateStr);
  }
}

// ---------------------------------------------------------------------------
// General date helpers
// ---------------------------------------------------------------------------

/**
 * Return an array of hours [0, 1, 2, ..., 23] for rendering day/week grids.
 */
export function getHoursInDay(): number[] {
  return Array.from({ length: 24 }, (_, i) => i);
}

/**
 * Check if a date is today (local time).
 */
export function isToday(date: Date): boolean {
  const now = new Date();
  return isSameDay(date, now);
}

/**
 * Check if two dates fall on the same calendar day (local time).
 */
export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
