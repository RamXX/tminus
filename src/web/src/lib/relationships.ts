/**
 * Relationship domain logic for the T-Minus SPA.
 *
 * Types and pure functions for relationship management, drift detection,
 * and reputation scoring. Used by the Relationships dashboard page and
 * its tests.
 *
 * Drift color coding:
 *   - green: contact is within their frequency target (no drift)
 *   - yellow: contact is 1-2x overdue (mild drift)
 *   - red: contact is >2x overdue (severe drift)
 *
 * Category badges: professional, personal, vip, community, family
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Contact category for relationship management. */
export type RelationshipCategory =
  | "professional"
  | "personal"
  | "vip"
  | "community"
  | "family";

/** Drift severity level for a contact. */
export type DriftLevel = "green" | "yellow" | "red";

/** A single relationship/contact entry. */
export interface Relationship {
  id: string;
  name: string;
  email: string;
  category: RelationshipCategory;
  city: string;
  timezone: string;
  /** Contact frequency target in days. */
  frequency_days: number;
  /** ISO date of last interaction. */
  last_interaction: string | null;
  /** Computed drift level based on last_interaction and frequency_days. */
  drift_level: DriftLevel;
  /** Overall reliability score (0-100). */
  reliability_score: number;
  created_at: string;
  updated_at: string;
}

/** Payload for creating a new relationship. */
export interface CreateRelationshipPayload {
  name: string;
  email: string;
  category: RelationshipCategory;
  city: string;
  timezone: string;
  frequency_days: number;
}

/** Payload for updating an existing relationship. */
export interface UpdateRelationshipPayload {
  name?: string;
  email?: string;
  category?: RelationshipCategory;
  city?: string;
  timezone?: string;
  frequency_days?: number;
}

/** Reputation scores for a relationship. */
export interface ReputationScores {
  reliability_score: number;
  responsiveness_score: number;
  follow_through_score: number;
  overall_score: number;
  total_interactions: number;
  positive_outcomes: number;
  negative_outcomes: number;
}

/** A single interaction outcome entry. */
export interface Outcome {
  outcome_id: string;
  relationship_id: string;
  outcome_type: "positive" | "negative" | "neutral";
  description: string;
  occurred_at: string;
  created_at: string;
}

/** Payload for recording an outcome. */
export interface CreateOutcomePayload {
  outcome_type: "positive" | "negative" | "neutral";
  description: string;
  occurred_at: string;
}

/** A single entry in the drift report. */
export interface DriftReportEntry {
  relationship_id: string;
  name: string;
  category: RelationshipCategory;
  days_overdue: number;
  drift_level: DriftLevel;
  last_interaction: string | null;
  frequency_days: number;
}

/** Drift report response shape. */
export interface DriftReport {
  entries: DriftReportEntry[];
  generated_at: string;
}

/** A drift alert. */
export interface DriftAlert {
  alert_id: string;
  relationship_id: string;
  name: string;
  drift_level: DriftLevel;
  days_overdue: number;
  message: string;
  created_at: string;
}

/** A reconnection suggestion. */
export interface ReconnectionSuggestion {
  relationship_id: string;
  name: string;
  reason: string;
  suggested_action: string;
  priority: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Color for green (no drift) status. */
export const COLOR_GREEN = "#22c55e";

/** Color for yellow (mild drift) status. */
export const COLOR_YELLOW = "#eab308";

/** Color for red (severe drift) status. */
export const COLOR_RED = "#ef4444";

/** Background color for green drift. */
export const BG_GREEN = "#052e16";

/** Background color for yellow drift. */
export const BG_YELLOW = "#422006";

/** Background color for red drift. */
export const BG_RED = "#450a0a";

/** Category display colors. */
export const CATEGORY_COLORS: Record<RelationshipCategory, { color: string; bg: string }> = {
  professional: { color: "#3b82f6", bg: "#1e3a5f" },
  personal: { color: "#8b5cf6", bg: "#2e1065" },
  vip: { color: "#f59e0b", bg: "#451a03" },
  community: { color: "#06b6d4", bg: "#083344" },
  family: { color: "#ec4899", bg: "#500724" },
};

/** Valid relationship categories for forms. */
export const CATEGORIES: RelationshipCategory[] = [
  "professional",
  "personal",
  "vip",
  "community",
  "family",
];

/** Common frequency targets in days for dropdown. */
export const FREQUENCY_OPTIONS = [
  { label: "Weekly", days: 7 },
  { label: "Bi-weekly", days: 14 },
  { label: "Monthly", days: 30 },
  { label: "Quarterly", days: 90 },
  { label: "Bi-annually", days: 180 },
  { label: "Annually", days: 365 },
];

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

/**
 * Compute drift level from days since last interaction and frequency target.
 *
 * - green: days_since <= frequency_days (on track)
 * - yellow: days_since > frequency_days AND days_since <= 2 * frequency_days
 * - red: days_since > 2 * frequency_days
 *
 * If last_interaction is null, always returns red (never contacted).
 */
export function computeDriftLevel(
  lastInteraction: string | null,
  frequencyDays: number,
  now: Date = new Date(),
): DriftLevel {
  if (!lastInteraction) return "red";
  const lastDate = new Date(lastInteraction);
  const diffMs = now.getTime() - lastDate.getTime();
  const daysSince = diffMs / (1000 * 60 * 60 * 24);

  if (daysSince <= frequencyDays) return "green";
  if (daysSince <= 2 * frequencyDays) return "yellow";
  return "red";
}

/**
 * Get the display color for a drift level.
 */
export function driftColor(level: DriftLevel): string {
  switch (level) {
    case "green":
      return COLOR_GREEN;
    case "yellow":
      return COLOR_YELLOW;
    case "red":
      return COLOR_RED;
  }
}

/**
 * Get the background color for a drift level.
 */
export function driftBgColor(level: DriftLevel): string {
  switch (level) {
    case "green":
      return BG_GREEN;
    case "yellow":
      return BG_YELLOW;
    case "red":
      return BG_RED;
  }
}

/**
 * Human-readable drift label.
 */
export function driftLabel(level: DriftLevel): string {
  switch (level) {
    case "green":
      return "On Track";
    case "yellow":
      return "Drifting";
    case "red":
      return "Overdue";
  }
}

/**
 * Get display color and background for a category.
 */
export function categoryStyle(category: RelationshipCategory): {
  color: string;
  bg: string;
} {
  return CATEGORY_COLORS[category] ?? CATEGORY_COLORS.professional;
}

/**
 * Capitalize first letter of a category for display.
 */
export function categoryLabel(category: RelationshipCategory): string {
  return category.charAt(0).toUpperCase() + category.slice(1);
}

/**
 * Format a date string for display. Returns "Never" for null.
 */
export function formatDate(isoDate: string | null): string {
  if (!isoDate) return "Never";
  const d = new Date(isoDate);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Format a reputation score for display (0-100 scale).
 * Returns "N/A" for null/undefined.
 */
export function formatScore(score: number | null | undefined): string {
  if (score == null) return "N/A";
  return `${Math.round(score)}/100`;
}

/**
 * Calculate days overdue for a relationship.
 * Returns 0 if not overdue, positive number if overdue.
 */
export function daysOverdue(
  lastInteraction: string | null,
  frequencyDays: number,
  now: Date = new Date(),
): number {
  if (!lastInteraction) return frequencyDays; // treat as one full cycle overdue
  const lastDate = new Date(lastInteraction);
  const diffMs = now.getTime() - lastDate.getTime();
  const daysSince = diffMs / (1000 * 60 * 60 * 24);
  return Math.max(0, Math.round(daysSince - frequencyDays));
}

/**
 * Sort drift report entries by days_overdue descending (most overdue first).
 */
export function sortByDriftSeverity(
  entries: DriftReportEntry[],
): DriftReportEntry[] {
  return [...entries].sort((a, b) => b.days_overdue - a.days_overdue);
}
