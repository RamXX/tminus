/**
 * Reconnection dashboard helpers and types.
 *
 * Pure functions and types for the Reconnections dashboard page.
 * Operates on reconnection suggestions (from the API) and upcoming
 * milestones to produce display-ready data structures.
 *
 * The API returns ReconnectionSuggestion[] from /v1/reconnection-suggestions
 * and UpcomingMilestone[] from /v1/milestones/upcoming.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A suggested time window for a reconnection meeting. */
export interface SuggestedTimeWindow {
  readonly earliest: string;
  readonly latest: string;
}

/**
 * Reconnection suggestion as returned by the API.
 *
 * Richer than the basic ReconnectionSuggestion in relationships.ts:
 * includes drift metrics, suggested duration, and time window.
 */
export interface ReconnectionSuggestionFull {
  readonly relationship_id: string;
  readonly participant_hash: string;
  readonly display_name: string | null;
  readonly category: string;
  readonly closeness_weight: number;
  readonly last_interaction_ts: string | null;
  readonly interaction_frequency_target: number;
  readonly days_since_interaction: number;
  readonly days_overdue: number;
  readonly drift_ratio: number;
  readonly urgency: number;
  readonly suggested_duration_minutes: number;
  readonly suggested_time_window: SuggestedTimeWindow | null;
  /** City of the contact (if known). */
  readonly city?: string;
}

/** An upcoming milestone from /v1/milestones/upcoming. */
export interface UpcomingMilestone {
  readonly milestone_id: string;
  readonly participant_hash: string;
  readonly kind: string;
  readonly date: string;
  readonly recurs_annually: boolean;
  readonly note: string | null;
  readonly next_occurrence: string;
  readonly days_until: number;
  /** Display name from the associated relationship. */
  readonly display_name?: string | null;
}

/** A trip grouping: city + date range + reconnection suggestions in that city. */
export interface TripReconnectionGroup {
  readonly city: string;
  readonly tripStart: string;
  readonly tripEnd: string;
  readonly suggestions: ReconnectionSuggestionFull[];
}

/** Data for a single reconnection card (display-ready). */
export interface ReconnectionCardData {
  readonly relationshipId: string;
  readonly name: string;
  readonly city: string;
  readonly category: string;
  readonly daysOverdue: number;
  readonly driftRatio: number;
  readonly suggestedAction: string;
  readonly suggestedDurationMinutes: number;
  readonly timeWindow: SuggestedTimeWindow | null;
  readonly urgency: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Priority color thresholds for drift ratio. */
export const DRIFT_RATIO_THRESHOLDS = {
  /** Drift ratio below this is moderate (yellow). */
  MODERATE: 1.5,
  /** Drift ratio above this is severe (red). */
  SEVERE: 2.0,
} as const;

/** Milestone kind display labels. */
export const MILESTONE_KIND_LABELS: Record<string, string> = {
  birthday: "Birthday",
  anniversary: "Anniversary",
  graduation: "Graduation",
  funding: "Funding Round",
  relocation: "Relocation",
  custom: "Custom",
};

/** Category-to-suggested-action mapping. */
export const CATEGORY_ACTIONS: Record<string, string> = {
  FRIEND: "Coffee or meal",
  COLLEAGUE: "Working lunch",
  MENTOR: "Mentorship catch-up",
  MENTEE: "Mentorship check-in",
  PARTNER: "Business review",
  FAMILY: "Family visit",
  ACQUAINTANCE: "Quick hello",
  // Fallback for web UI categories (lowercase from relationships.ts)
  professional: "Working lunch",
  personal: "Coffee or meal",
  vip: "Priority meeting",
  community: "Quick catch-up",
  family: "Family visit",
};

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

/**
 * Format days overdue for display.
 *
 * Returns a human-readable string like "5 days overdue" or "On track".
 */
export function formatDriftDays(daysOverdue: number): string {
  if (daysOverdue <= 0) return "On track";
  if (daysOverdue === 1) return "1 day overdue";
  return `${daysOverdue} days overdue`;
}

/**
 * Format suggested meeting duration for display.
 *
 * Converts minutes to a readable string like "30 min" or "1h 30min".
 */
export function formatSuggestedDuration(minutes: number): string {
  if (minutes <= 0) return "0 min";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (remainingMinutes === 0) return `${hours}h`;
  return `${hours}h ${remainingMinutes}min`;
}

/**
 * Format a milestone date for calendar display.
 *
 * Returns a readable date like "Feb 15" or "Feb 15, 2026".
 * If showYear is true, includes the year.
 */
export function formatMilestoneDate(
  dateStr: string,
  showYear: boolean = false,
): string {
  const d = new Date(dateStr + "T00:00:00");
  if (isNaN(d.getTime())) return dateStr;
  const options: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    ...(showYear ? { year: "numeric" } : {}),
  };
  return d.toLocaleDateString("en-US", options);
}

/**
 * Get display label for a milestone kind.
 *
 * Falls back to capitalizing the kind string if not in the lookup table.
 */
export function milestoneKindLabel(kind: string): string {
  return MILESTONE_KIND_LABELS[kind] ?? kind.charAt(0).toUpperCase() + kind.slice(1);
}

/**
 * Get the drift severity level from a drift ratio.
 *
 * - "green" if drift_ratio <= 1.0 (on track)
 * - "yellow" if drift_ratio <= SEVERE threshold (moderate)
 * - "red" if drift_ratio > SEVERE threshold (severe)
 */
export function driftSeverityFromRatio(driftRatio: number): "green" | "yellow" | "red" {
  if (driftRatio <= 1.0) return "green";
  if (driftRatio <= DRIFT_RATIO_THRESHOLDS.SEVERE) return "yellow";
  return "red";
}

/**
 * Get the suggested action for a category.
 *
 * Looks up from CATEGORY_ACTIONS, falls back to a generic suggestion.
 */
export function suggestedActionForCategory(category: string): string {
  return CATEGORY_ACTIONS[category] ?? "Schedule a meeting";
}

/**
 * Convert a ReconnectionSuggestionFull into display-ready card data.
 */
export function toReconnectionCard(
  suggestion: ReconnectionSuggestionFull,
): ReconnectionCardData {
  return {
    relationshipId: suggestion.relationship_id,
    name: suggestion.display_name ?? "Unknown",
    city: suggestion.city ?? "",
    category: suggestion.category,
    daysOverdue: suggestion.days_overdue,
    driftRatio: suggestion.drift_ratio,
    suggestedAction: suggestedActionForCategory(suggestion.category),
    suggestedDurationMinutes: suggestion.suggested_duration_minutes,
    timeWindow: suggestion.suggested_time_window,
    urgency: suggestion.urgency,
  };
}

/**
 * Sort reconnection suggestions by urgency (highest first).
 */
export function sortByUrgency(
  suggestions: readonly ReconnectionSuggestionFull[],
): ReconnectionSuggestionFull[] {
  return [...suggestions].sort((a, b) => b.urgency - a.urgency);
}

/**
 * Group reconnection suggestions by city for trip display.
 *
 * Each group contains a city, trip date window (from the suggestion's
 * time_window), and the suggestions in that city sorted by urgency.
 *
 * Suggestions without a city or time window are placed in an "Other" group.
 */
export function groupByCity(
  suggestions: readonly ReconnectionSuggestionFull[],
): TripReconnectionGroup[] {
  const groups = new Map<string, {
    tripStart: string;
    tripEnd: string;
    suggestions: ReconnectionSuggestionFull[];
  }>();

  for (const s of suggestions) {
    const city = s.city?.trim() || "Other";
    const existing = groups.get(city);
    if (existing) {
      existing.suggestions.push(s);
      // Expand the time window if needed
      if (s.suggested_time_window) {
        if (s.suggested_time_window.earliest < existing.tripStart) {
          existing.tripStart = s.suggested_time_window.earliest;
        }
        if (s.suggested_time_window.latest > existing.tripEnd) {
          existing.tripEnd = s.suggested_time_window.latest;
        }
      }
    } else {
      groups.set(city, {
        tripStart: s.suggested_time_window?.earliest ?? "",
        tripEnd: s.suggested_time_window?.latest ?? "",
        suggestions: [s],
      });
    }
  }

  // Sort groups by number of suggestions (most first), sort suggestions within by urgency
  return Array.from(groups.entries())
    .map(([city, group]) => ({
      city,
      tripStart: group.tripStart,
      tripEnd: group.tripEnd,
      suggestions: sortByUrgency(group.suggestions),
    }))
    .sort((a, b) => b.suggestions.length - a.suggestions.length);
}

/**
 * Filter milestones to only those within N days.
 *
 * Returns milestones sorted by days_until ascending (soonest first).
 */
export function filterUpcomingMilestones(
  milestones: readonly UpcomingMilestone[],
  maxDays: number = 30,
): UpcomingMilestone[] {
  return [...milestones]
    .filter((m) => m.days_until >= 0 && m.days_until <= maxDays)
    .sort((a, b) => a.days_until - b.days_until);
}

/**
 * Group milestones by month for calendar display.
 *
 * Returns a Map of "YYYY-MM" -> milestones in that month, ordered by date.
 */
export function groupMilestonesByMonth(
  milestones: readonly UpcomingMilestone[],
): Map<string, UpcomingMilestone[]> {
  const groups = new Map<string, UpcomingMilestone[]>();

  for (const m of milestones) {
    const monthKey = m.next_occurrence.slice(0, 7); // "YYYY-MM"
    const existing = groups.get(monthKey);
    if (existing) {
      existing.push(m);
    } else {
      groups.set(monthKey, [m]);
    }
  }

  // Sort within each group by date
  for (const [, group] of groups) {
    group.sort((a, b) => a.next_occurrence.localeCompare(b.next_occurrence));
  }

  return groups;
}

/**
 * Format a month key "YYYY-MM" to a display string like "February 2026".
 */
export function formatMonthLabel(monthKey: string): string {
  const [year, month] = monthKey.split("-");
  const d = new Date(Number(year), Number(month) - 1, 1);
  if (isNaN(d.getTime())) return monthKey;
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

/**
 * Build a scheduling pre-fill payload from a reconnection card.
 *
 * Returns query parameters suitable for navigating to #/scheduling with
 * pre-filled values.
 */
export function buildScheduleParams(card: ReconnectionCardData): Record<string, string> {
  const params: Record<string, string> = {
    duration: String(card.suggestedDurationMinutes),
    contact: card.name,
    relationship_id: card.relationshipId,
  };

  if (card.timeWindow) {
    params.window_start = card.timeWindow.earliest;
    params.window_end = card.timeWindow.latest;
  }

  return params;
}

/**
 * Build a hash URL for scheduling with pre-filled params.
 */
export function buildScheduleUrl(card: ReconnectionCardData): string {
  const params = buildScheduleParams(card);
  const search = new URLSearchParams(params).toString();
  return `#/scheduling?${search}`;
}
