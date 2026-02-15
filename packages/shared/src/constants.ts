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
