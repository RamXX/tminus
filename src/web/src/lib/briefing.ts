/**
 * Briefing helpers for the web UI.
 *
 * Types re-exported from @tminus/shared for convenience, plus
 * formatting helpers used by BriefingPanel and ParticipantCard.
 */

// ---------------------------------------------------------------------------
// Types (mirrored from @tminus/shared for web-local use)
// ---------------------------------------------------------------------------

/** A participant in the briefing output with context. */
export interface BriefingParticipant {
  readonly participant_hash: string;
  readonly display_name: string | null;
  readonly category: string;
  readonly last_interaction_ts: string | null;
  readonly last_interaction_summary: string | null;
  readonly reputation_score: number;
  readonly mutual_connections_count: number;
}

/** The full briefing response for an event. */
export interface EventBriefing {
  readonly event_id: string;
  readonly event_title: string | null;
  readonly event_start: string;
  readonly topics: string[];
  readonly participants: BriefingParticipant[];
  readonly computed_at: string;
}

/** Valid tone options for excuse generation. */
export type ExcuseTone = "formal" | "casual" | "apologetic";

/** Valid truth level options for excuse generation. */
export type TruthLevel = "full" | "vague" | "white_lie";

/** Structured output from excuse generation. */
export interface ExcuseOutput {
  readonly draft_message: string;
  readonly suggested_reschedule?: {
    readonly reason: string;
    readonly proposed_times?: string[];
  };
  readonly is_draft: true;
  readonly tone: ExcuseTone;
  readonly truth_level: TruthLevel;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Category badge color mapping. */
const CATEGORY_COLORS: Record<string, string> = {
  colleague: "#3b82f6",    // blue
  client: "#8b5cf6",       // purple
  friend: "#22c55e",       // green
  family: "#f59e0b",       // amber
  acquaintance: "#64748b", // slate
  mentor: "#06b6d4",       // cyan
  investor: "#ec4899",     // pink
};

/** Default fallback category color. */
const DEFAULT_CATEGORY_COLOR = "#94a3b8";

/**
 * Get the display color for a relationship category badge.
 *
 * @param category - Relationship category string
 * @returns Hex color string for the badge
 */
export function getCategoryColor(category: string): string {
  return CATEGORY_COLORS[category.toLowerCase()] ?? DEFAULT_CATEGORY_COLOR;
}

/**
 * Format a category string for display (capitalize first letter).
 *
 * @param category - Raw category string
 * @returns Formatted category label
 */
export function formatCategory(category: string): string {
  if (!category) return "Unknown";
  return category.charAt(0).toUpperCase() + category.slice(1).toLowerCase();
}

/**
 * Format a reputation score for display (0-100 scale with label).
 *
 * Scores:
 *   >= 0.8 -> "High"
 *   >= 0.5 -> "Medium"
 *   < 0.5  -> "Low"
 *
 * @param score - Reputation score between 0 and 1
 * @returns Object with numeric display (0-100) and label
 */
export function formatReputationScore(score: number): {
  display: string;
  label: string;
  color: string;
} {
  const rounded = Math.round(score * 100);
  if (score >= 0.8) {
    return { display: `${rounded}`, label: "High", color: "#22c55e" };
  }
  if (score >= 0.5) {
    return { display: `${rounded}`, label: "Medium", color: "#f59e0b" };
  }
  return { display: `${rounded}`, label: "Low", color: "#ef4444" };
}

/**
 * Compute a drift indicator based on last interaction time.
 *
 * Drift levels based on days since last interaction:
 *   <= 7 days  -> "recent" (green)
 *   <= 30 days -> "normal" (no indicator)
 *   <= 90 days -> "drifting" (yellow)
 *   > 90 days  -> "distant" (red)
 *   null       -> "unknown" (gray)
 *
 * @param lastInteractionTs - ISO 8601 timestamp, or null
 * @param now - Current time for comparison
 * @returns Drift indicator with label and color
 */
export function computeDriftIndicator(
  lastInteractionTs: string | null,
  now: Date = new Date(),
): { label: string; color: string } {
  if (!lastInteractionTs) {
    return { label: "Unknown", color: "#64748b" };
  }

  const lastMs = new Date(lastInteractionTs).getTime();
  const diffMs = now.getTime() - lastMs;
  const days = Math.floor(diffMs / (24 * 60 * 60 * 1000));

  if (days <= 7) {
    return { label: "Recent", color: "#22c55e" };
  }
  if (days <= 30) {
    return { label: "Normal", color: "#94a3b8" };
  }
  if (days <= 90) {
    return { label: "Drifting", color: "#f59e0b" };
  }
  return { label: "Distant", color: "#ef4444" };
}

/** All valid excuse tones for the tone selector. */
export const EXCUSE_TONES: ExcuseTone[] = ["formal", "casual", "apologetic"];

/** All valid truth levels for the truth level selector. */
export const TRUTH_LEVELS: TruthLevel[] = ["full", "vague", "white_lie"];

/**
 * Format a truth level for display.
 *
 * @param level - Truth level value
 * @returns Human-readable label
 */
export function formatTruthLevel(level: TruthLevel): string {
  switch (level) {
    case "full":
      return "Full Truth";
    case "vague":
      return "Vague";
    case "white_lie":
      return "White Lie";
  }
}
