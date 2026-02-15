/**
 * @tminus/shared -- CalDAV (Apple Calendar) event normalization.
 *
 * Converts parsed iCalendar VEVENT data into the ProviderDelta
 * format consumed by UserGraphDO.applyProviderDelta().
 *
 * Deterministic, no mutations. Parallel to normalize.ts (Google)
 * and normalize-microsoft.ts (Microsoft).
 *
 * Key field mappings:
 * - SUMMARY -> title
 * - DESCRIPTION -> description
 * - LOCATION -> location
 * - DTSTART -> start (as EventDateTime)
 * - DTEND -> end (as EventDateTime)
 * - VALUE=DATE -> all_day: true
 * - STATUS -> status: CONFIRMED/TENTATIVE/CANCELLED
 * - TRANSP -> transparency: OPAQUE/TRANSPARENT
 * - CLASS -> visibility: PUBLIC/PRIVATE/CONFIDENTIAL
 * - RRULE -> recurrence_rule
 */

import type {
  EventClassification,
  AccountId,
  ProviderDelta,
  EventDateTime,
} from "./types";
import type { ParsedVEvent } from "./caldav-types";
import { icalDateTimeToEventDateTime } from "./ical-parse";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Normalize a parsed CalDAV VEVENT into a ProviderDelta.
 *
 * @param vevent - Parsed VEVENT from iCalendar data
 * @param accountId - The account this event belongs to
 * @param classification - How the event was classified (origin, managed_mirror, foreign_managed)
 * @returns A ProviderDelta ready for the sync pipeline
 */
export function normalizeCalDavEvent(
  vevent: ParsedVEvent,
  accountId: AccountId,
  classification: EventClassification,
): ProviderDelta {
  const changeType = determineChangeType(vevent);
  const originEventId = vevent.uid;

  // Deleted events and managed mirrors never carry an event payload.
  // Same logic as Google/Microsoft normalization -- Invariant E.
  if (changeType === "deleted" || classification === "managed_mirror") {
    return {
      type: changeType,
      origin_event_id: originEventId,
      origin_account_id: accountId,
    };
  }

  const start = normalizeDateTime(vevent.dtstart, vevent.dtstartParams);
  const end = normalizeDateTime(vevent.dtend, vevent.dtendParams);
  const allDay = isAllDay(vevent.dtstartParams);

  return {
    type: changeType,
    origin_event_id: originEventId,
    origin_account_id: accountId,
    event: {
      origin_account_id: accountId,
      origin_event_id: originEventId,
      title: vevent.summary,
      description: vevent.description,
      location: vevent.location,
      start,
      end,
      all_day: allDay,
      status: normalizeStatus(vevent.status),
      visibility: normalizeVisibility(vevent.class),
      transparency: normalizeTransparency(vevent.transp),
      recurrence_rule: vevent.rrule,
    },
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Determine change type from VEVENT status.
 * CANCELLED status maps to 'deleted', everything else to 'updated'.
 */
function determineChangeType(
  vevent: ParsedVEvent,
): "updated" | "deleted" {
  if (vevent.status?.toUpperCase() === "CANCELLED") {
    return "deleted";
  }
  return "updated";
}

/**
 * Normalize an iCalendar datetime into EventDateTime format.
 */
function normalizeDateTime(
  value?: string,
  params?: Record<string, string>,
): EventDateTime {
  if (!value) {
    return {};
  }
  return icalDateTimeToEventDateTime(value, params);
}

/**
 * Check if the event is all-day based on DTSTART parameters.
 */
function isAllDay(dtstartParams?: Record<string, string>): boolean {
  return dtstartParams?.["VALUE"] === "DATE";
}

/**
 * Normalize VEVENT STATUS to our status model.
 * iCalendar STATUS: CONFIRMED, TENTATIVE, CANCELLED
 */
function normalizeStatus(
  status: string | undefined,
): "confirmed" | "tentative" | "cancelled" {
  if (!status) return "confirmed";
  const upper = status.toUpperCase();
  if (upper === "TENTATIVE") return "tentative";
  if (upper === "CANCELLED") return "cancelled";
  return "confirmed";
}

/**
 * Normalize VEVENT CLASS to our visibility model.
 * iCalendar CLASS: PUBLIC, PRIVATE, CONFIDENTIAL
 */
function normalizeVisibility(
  cls: string | undefined,
): "default" | "public" | "private" | "confidential" {
  if (!cls) return "default";
  const upper = cls.toUpperCase();
  if (upper === "PUBLIC") return "public";
  if (upper === "PRIVATE") return "private";
  if (upper === "CONFIDENTIAL") return "confidential";
  return "default";
}

/**
 * Normalize VEVENT TRANSP to our transparency model.
 * iCalendar TRANSP: OPAQUE, TRANSPARENT
 */
function normalizeTransparency(
  transp: string | undefined,
): "opaque" | "transparent" {
  if (!transp) return "opaque";
  if (transp.toUpperCase() === "TRANSPARENT") return "transparent";
  return "opaque";
}
