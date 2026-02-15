/**
 * @tminus/shared -- Constants for the T-Minus calendar federation engine.
 *
 * All magic strings, default values, and prefix maps live here so that
 * every worker, DO, and workflow references the same values.
 */

import type { DetailLevel, CalendarKind } from "./types";

// ---------------------------------------------------------------------------
// Google Calendar extended properties keys
// ---------------------------------------------------------------------------

/** Extended property key: marks the event as known to T-Minus. */
export const EXTENDED_PROP_TMINUS = "tminus" as const;

/** Extended property key: marks the event as a managed mirror. */
export const EXTENDED_PROP_MANAGED = "managed" as const;

/** Extended property key: the canonical event ID this mirror represents. */
export const EXTENDED_PROP_CANONICAL_ID = "canonical_event_id" as const;

/** Extended property key: the account that originally owns the event. */
export const EXTENDED_PROP_ORIGIN_ACCOUNT = "origin_account_id" as const;

// ---------------------------------------------------------------------------
// Calendar defaults
// ---------------------------------------------------------------------------

/** Display name for the auto-created busy overlay calendar. */
export const BUSY_OVERLAY_CALENDAR_NAME =
  "External Busy (T-Minus)" as const;

/** Default detail level for new policy edges. */
export const DEFAULT_DETAIL_LEVEL: DetailLevel = "BUSY";

/** Default calendar kind for new policy edges. */
export const DEFAULT_CALENDAR_KIND: CalendarKind = "BUSY_OVERLAY";

// ---------------------------------------------------------------------------
// ID prefix map
// ---------------------------------------------------------------------------

/**
 * Prefix map for generating branded IDs.
 * Usage: `ID_PREFIXES.user + ulid()` => "usr_01HXYZ..."
 */
export const ID_PREFIXES = {
  user: "usr_",
  account: "acc_",
  event: "evt_",
  policy: "pol_",
  calendar: "cal_",
  journal: "jrn_",
  constraint: "cst_",
  apikey: "key_",
  cert: "crt_",
  session: "ses_",
  candidate: "cnd_",
  hold: "hld_",
  vip: "vip_",
  allocation: "alc_",
  commitment: "cmt_",
  report: "rpt_",
  relationship: "rel_",
  ledger: "ldg_",
  alert: "alt_",
  milestone: "mst_",
  proof: "prf_",
  schedHist: "shx_",
} as const;

// ---------------------------------------------------------------------------
// Billing category enum for time allocations
// ---------------------------------------------------------------------------

/**
 * Valid billing categories for time allocation tagging.
 * Used by the time_allocations table in UserGraphDO.
 */
export const BILLING_CATEGORIES = [
  "BILLABLE",
  "NON_BILLABLE",
  "STRATEGIC",
  "INVESTOR",
  "INTERNAL",
] as const;

export type BillingCategory = (typeof BILLING_CATEGORIES)[number];

/**
 * Validate that a string is a valid billing category.
 */
export function isValidBillingCategory(value: string): value is BillingCategory {
  return BILLING_CATEGORIES.includes(value as BillingCategory);
}

// ---------------------------------------------------------------------------
// Relationship categories (Phase 4)
// ---------------------------------------------------------------------------

/**
 * Valid categories for relationship tracking.
 * Used by the relationships table in UserGraphDO.
 */
export const RELATIONSHIP_CATEGORIES = [
  "FAMILY",
  "INVESTOR",
  "FRIEND",
  "CLIENT",
  "BOARD",
  "COLLEAGUE",
  "OTHER",
] as const;

export type RelationshipCategory = (typeof RELATIONSHIP_CATEGORIES)[number];

/**
 * Validate that a string is a valid relationship category.
 */
export function isValidRelationshipCategory(value: string): value is RelationshipCategory {
  return RELATIONSHIP_CATEGORIES.includes(value as RelationshipCategory);
}

// ---------------------------------------------------------------------------
// Interaction outcome types (Phase 4 -- interaction ledger)
// ---------------------------------------------------------------------------

/**
 * Valid outcomes for interaction ledger entries.
 * Used by the interaction_ledger table in UserGraphDO.
 *
 * "_ME" suffixed outcomes indicate user's own action.
 * "_THEM" suffixed outcomes indicate the other party's action.
 */
export const INTERACTION_OUTCOMES = [
  "ATTENDED",
  "CANCELED_BY_ME",
  "CANCELED_BY_THEM",
  "NO_SHOW_THEM",
  "NO_SHOW_ME",
  "MOVED_LAST_MINUTE_THEM",
  "MOVED_LAST_MINUTE_ME",
] as const;

export type InteractionOutcome = (typeof INTERACTION_OUTCOMES)[number];

/**
 * Weight map for interaction outcomes. Positive = good, negative = bad.
 * Used for reputation scoring in the relationship graph.
 *
 * ATTENDED: full positive credit
 * CANCELED_BY_THEM: moderate negative (they cancelled)
 * NO_SHOW_THEM: severe negative (they didn't show)
 * MOVED_LAST_MINUTE_THEM: mild negative (they rescheduled late)
 * *_ME variants: neutral weight (user's own actions don't affect other's reputation)
 */
export const OUTCOME_WEIGHTS: Record<InteractionOutcome, number> = {
  ATTENDED: 1.0,
  CANCELED_BY_ME: 0.0,
  CANCELED_BY_THEM: -0.5,
  NO_SHOW_THEM: -1.0,
  NO_SHOW_ME: 0.0,
  MOVED_LAST_MINUTE_THEM: -0.3,
  MOVED_LAST_MINUTE_ME: 0.0,
};

/**
 * Validate that a string is a valid interaction outcome.
 */
export function isValidOutcome(value: string): value is InteractionOutcome {
  return INTERACTION_OUTCOMES.includes(value as InteractionOutcome);
}

/**
 * Get the weight for an interaction outcome.
 * Returns the predefined weight from OUTCOME_WEIGHTS.
 */
export function getOutcomeWeight(outcome: InteractionOutcome): number {
  return OUTCOME_WEIGHTS[outcome];
}
