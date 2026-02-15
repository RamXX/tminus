/**
 * Context-Switch Cost Estimation Engine -- pure computation functions
 * for measuring the cognitive cost of switching between meeting categories
 * throughout a day or week.
 *
 * Metrics computed:
 *   - Event category classification: maps events to work categories via
 *     title keyword matching (engineering, sales, admin, deep_work, hiring, other)
 *   - Transitions: consecutive event pairs with their from/to categories and cost
 *   - Daily switch cost: sum of all transition costs in a day
 *   - Weekly switch cost: sum + average across daily costs
 *   - Clustering suggestions: actionable advice to reduce expensive transitions
 *
 * All functions are pure (no I/O, no side effects). Input is an array
 * of CanonicalEvent objects.
 */

import type { CanonicalEvent } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Semantic work category inferred from event title keywords. */
export type EventCategory =
  | "engineering"
  | "sales"
  | "admin"
  | "deep_work"
  | "hiring"
  | "other";

/** A transition between two consecutive events with its context-switch cost. */
export interface Transition {
  readonly from_category: EventCategory;
  readonly to_category: EventCategory;
  readonly cost: number;
  readonly event_before_id: string;
  readonly event_after_id: string;
}

/** Weekly aggregation of switch costs. */
export interface WeeklySwitchCost {
  readonly total: number;
  readonly average: number;
}

/** A suggestion to reduce context-switch overhead by clustering meetings. */
export interface ClusteringSuggestion {
  readonly message: string;
  readonly estimated_savings: number;
}

/** Full context-switch analysis result (returned by the API). */
export interface ContextSwitchResult {
  readonly transitions: readonly Transition[];
  readonly total_cost: number;
  readonly daily_costs: readonly number[];
  readonly suggestions: readonly ClusteringSuggestion[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default cost for transitions not explicitly in the matrix. */
export const DEFAULT_TRANSITION_COST = 0.5;

/**
 * Cost matrix for category transitions. Higher values indicate more
 * cognitively expensive switches. Values range from 0 to 1.
 *
 * Key format: "{from}_to_{to}" or "same_category".
 */
export const COST_MATRIX: Record<string, number> = {
  same_category: 0.1,
  engineering_to_sales: 0.8,
  sales_to_engineering: 0.9,
  engineering_to_admin: 0.6,
  admin_to_engineering: 0.6,
  engineering_to_deep_work: 0.3,
  deep_work_to_engineering: 0.4,
  engineering_to_hiring: 0.5,
  hiring_to_engineering: 0.5,
  sales_to_admin: 0.6,
  admin_to_sales: 0.7,
  sales_to_deep_work: 0.7,
  deep_work_to_sales: 0.8,
  sales_to_hiring: 0.6,
  hiring_to_sales: 0.6,
  admin_to_deep_work: 0.5,
  deep_work_to_admin: 0.5,
  admin_to_hiring: 0.4,
  hiring_to_admin: 0.4,
  deep_work_to_hiring: 0.6,
  hiring_to_deep_work: 0.6,
  engineering_to_other: 0.5,
  other_to_engineering: 0.5,
  sales_to_other: 0.5,
  other_to_sales: 0.5,
  admin_to_other: 0.4,
  other_to_admin: 0.4,
  deep_work_to_other: 0.5,
  other_to_deep_work: 0.5,
  hiring_to_other: 0.4,
  other_to_hiring: 0.4,
  other_to_other: 0.3,
} as const;

// ---------------------------------------------------------------------------
// Keyword classification rules
// ---------------------------------------------------------------------------

/**
 * Map from category to arrays of lowercase keyword fragments.
 * First match wins -- order the categories from most specific to least.
 */
const CATEGORY_KEYWORDS: ReadonlyArray<[EventCategory, readonly string[]]> = [
  [
    "deep_work",
    ["focus time", "deep work", "heads down", "no meetings", "maker time", "focus block"],
  ],
  [
    "hiring",
    ["interview", "onsite", "hiring", "recruit", "candidate", "phone screen"],
  ],
  [
    "engineering",
    [
      "standup", "stand-up", "sprint", "retro", "retrospective",
      "code review", "design sync", "design review", "tech debt",
      "architecture", "deploy", "incident", "postmortem", "post-mortem",
      "backlog", "grooming", "refinement", "scrum", "kanban",
      "engineering", "bug bash", "hackathon", "planning",
    ],
  ],
  [
    "sales",
    [
      "pitch", "demo", "sales", "prospect", "customer", "client",
      "deal review", "pipeline", "proposal", "closing", "negotiation",
      "discovery call", "lead", "account review",
    ],
  ],
  [
    "admin",
    [
      "quarterly", "all-hands", "all hands", "town hall",
      "budget", "expense", "1:1", "one-on-one", "1-on-1",
      "performance review", "team meeting", "staff meeting",
      "sync", "status update", "check-in", "check in",
      "offsite planning", "offsite", "board meeting",
    ],
  ],
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify a CanonicalEvent into a semantic work category based on its
 * title keywords. Case-insensitive matching. Returns "other" if no
 * keywords match.
 */
export function classifyEventCategory(event: CanonicalEvent): EventCategory {
  const title = (event.title ?? "").toLowerCase().trim();
  if (!title) return "other";

  for (const [category, keywords] of CATEGORY_KEYWORDS) {
    for (const keyword of keywords) {
      if (title.includes(keyword)) {
        return category;
      }
    }
  }
  return "other";
}

/**
 * Look up the transition cost between two categories.
 * Returns the explicit cost from COST_MATRIX if available,
 * same_category cost if categories match, or DEFAULT_TRANSITION_COST.
 */
export function lookupTransitionCost(
  from: EventCategory,
  to: EventCategory,
): number {
  if (from === to) return COST_MATRIX.same_category;
  const key = `${from}_to_${to}`;
  return COST_MATRIX[key] ?? DEFAULT_TRANSITION_COST;
}

/**
 * Filter events to only opaque, non-cancelled, non-all-day timed events.
 * These are the events that represent real cognitive context switches.
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

/** Get epoch-millis from a dateTime string. */
function toMs(dateTime: string): number {
  return new Date(dateTime).getTime();
}

/**
 * Compute transitions between consecutive events.
 *
 * Events are filtered (cancelled, all-day, transparent excluded),
 * sorted by start time, then each consecutive pair produces a Transition.
 */
export function computeTransitions(
  events: readonly CanonicalEvent[],
): Transition[] {
  const active = filterActiveTimedEvents(events);
  if (active.length <= 1) return [];

  // Sort by start time
  const sorted = [...active].sort((a, b) => {
    const aStart = a.start.dateTime ? toMs(a.start.dateTime) : 0;
    const bStart = b.start.dateTime ? toMs(b.start.dateTime) : 0;
    return aStart - bStart;
  });

  const transitions: Transition[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    const fromCategory = classifyEventCategory(prev);
    const toCategory = classifyEventCategory(curr);
    const cost = lookupTransitionCost(fromCategory, toCategory);

    transitions.push({
      from_category: fromCategory,
      to_category: toCategory,
      cost,
      event_before_id: prev.canonical_event_id,
      event_after_id: curr.canonical_event_id,
    });
  }

  return transitions;
}

/**
 * Compute total context-switch cost for a day by summing all transition costs.
 */
export function computeDailySwitchCost(
  transitions: readonly Transition[],
): number {
  return transitions.reduce((sum, t) => sum + t.cost, 0);
}

/**
 * Compute weekly context-switch cost: total sum and daily average.
 */
export function computeWeeklySwitchCost(
  dailyCosts: readonly number[],
): WeeklySwitchCost {
  if (dailyCosts.length === 0) {
    return { total: 0, average: 0 };
  }
  const total = dailyCosts.reduce((sum, c) => sum + c, 0);
  const average = total / dailyCosts.length;
  return { total, average };
}

/**
 * Generate actionable clustering suggestions to reduce the most expensive
 * context-switch transitions.
 *
 * Strategy: Find category pairs that appear multiple times with high cost.
 * For each, suggest grouping those meeting types together to convert
 * cross-category transitions into same-category transitions.
 */
export function generateClusteringSuggestions(
  transitions: readonly Transition[],
  _events: readonly CanonicalEvent[],
): ClusteringSuggestion[] {
  if (transitions.length === 0) return [];

  // Aggregate cost by unique directional category pair
  const pairCosts = new Map<string, { total: number; count: number; from: EventCategory; to: EventCategory }>();

  for (const t of transitions) {
    if (t.from_category === t.to_category) continue; // same-category transitions need no fix
    // Use a bidirectional key so eng->sales and sales->eng group together
    const categories = [t.from_category, t.to_category].sort();
    const key = `${categories[0]}_${categories[1]}`;
    const existing = pairCosts.get(key);
    if (existing) {
      existing.total += t.cost;
      existing.count += 1;
    } else {
      pairCosts.set(key, {
        total: t.cost,
        count: 1,
        from: categories[0] as EventCategory,
        to: categories[1] as EventCategory,
      });
    }
  }

  if (pairCosts.size === 0) return [];

  // Sort by total cost descending, then generate suggestions for the top pairs
  const sortedPairs = [...pairCosts.entries()].sort(
    (a, b) => b[1].total - a[1].total,
  );

  const suggestions: ClusteringSuggestion[] = [];

  for (const [, data] of sortedPairs) {
    // Only suggest if there is a meaningful saving
    // Savings = current cross-category cost - what it would be with same_category cost
    const sameCategoryCost = COST_MATRIX.same_category * data.count;
    const savings = data.total - sameCategoryCost;

    if (savings <= 0) continue;

    const categoryA = formatCategoryName(data.from);
    const categoryB = formatCategoryName(data.to);

    suggestions.push({
      message: `Cluster your ${categoryA} and ${categoryB} meetings together to reduce context-switching. You have ${data.count} transition${data.count > 1 ? "s" : ""} between these categories.`,
      estimated_savings: Math.round(savings * 100) / 100,
    });
  }

  return suggestions;
}

/**
 * Format a category ID into a human-readable label.
 */
function formatCategoryName(category: EventCategory): string {
  switch (category) {
    case "engineering":
      return "engineering";
    case "sales":
      return "sales";
    case "admin":
      return "admin";
    case "deep_work":
      return "deep work";
    case "hiring":
      return "hiring";
    case "other":
      return "other";
  }
}
