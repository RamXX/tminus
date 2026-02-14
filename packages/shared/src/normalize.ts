/**
 * @tminus/shared -- Google Calendar event normalization.
 *
 * Converts raw Google Calendar API event responses into the ProviderDelta
 * format consumed by UserGraphDO.applyProviderDelta().
 *
 * Deterministic, no mutations. The only side effect is console.warn()
 * when an unexpected enum-like value is received from the Google API.
 *
 * Key design decisions:
 * - Google API uses "updated" for both create and update; the sync-consumer
 *   distinguishes by checking if a canonical event already exists.
 * - Managed mirrors (Invariant E) produce deltas with NO event payload
 *   to prevent treating mirror events as origins (loop prevention, Risk R1).
 * - Phase 1 deliberately excludes attendees, creator, organizer,
 *   conferenceData, and hangoutLink per BR-9 (minimal data collection).
 */

import type {
  GoogleCalendarEvent,
  EventClassification,
  AccountId,
  ProviderDelta,
  EventDateTime,
} from "./types";

/**
 * Normalize a raw Google Calendar event into a ProviderDelta.
 *
 * @param googleEvent - Raw event from the Google Calendar API
 * @param accountId - The account this event belongs to
 * @param classification - How the event was classified (origin, managed_mirror, foreign_managed)
 * @returns A ProviderDelta ready for the sync pipeline
 */
export function normalizeGoogleEvent(
  googleEvent: GoogleCalendarEvent,
  accountId: AccountId,
  classification: EventClassification,
): ProviderDelta {
  const changeType = determineChangeType(googleEvent);
  const originEventId = googleEvent.id ?? "";

  // Deleted events and managed mirrors never carry an event payload.
  // - Deleted: the event is gone; only the ID matters.
  // - Managed mirror (Invariant E): mirrors must never be treated as origins.
  //   We pass through the delta type so sync-consumer can detect drift, but
  //   we omit the event payload to prevent re-canonicalization.
  if (changeType === "deleted" || classification === "managed_mirror") {
    return {
      type: changeType,
      origin_event_id: originEventId,
      origin_account_id: accountId,
    };
  }

  // For origin and foreign_managed: extract and normalize event fields.
  return {
    type: changeType,
    origin_event_id: originEventId,
    origin_account_id: accountId,
    event: {
      origin_account_id: accountId,
      origin_event_id: originEventId,
      title: googleEvent.summary,
      description: googleEvent.description,
      location: googleEvent.location,
      start: normalizeDateTime(googleEvent.start),
      end: normalizeDateTime(googleEvent.end),
      all_day: isAllDay(googleEvent.start),
      status: normalizeStatus(googleEvent.status),
      visibility: normalizeVisibility(googleEvent.visibility),
      transparency: normalizeTransparency(googleEvent.transparency),
      recurrence_rule: extractRecurrenceRule(googleEvent.recurrence),
    },
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Known valid values for each validated field. */
const VALID_STATUS = new Set(["confirmed", "tentative", "cancelled"]);
const VALID_VISIBILITY = new Set(["default", "public", "private", "confidential"]);
const VALID_TRANSPARENCY = new Set(["opaque", "transparent"]);

/**
 * Validate a string field against a set of known values.
 * If the value is undefined (missing), returns silently -- the caller
 * handles the default. If the value is present but not in the known set,
 * emits a console.warn with the field name, received value, and the
 * default that will be used.
 */
function warnIfUnknown(
  fieldName: string,
  value: string | undefined,
  validValues: ReadonlySet<string>,
  defaultValue: string,
): void {
  if (value === undefined) {
    return;
  }
  if (!validValues.has(value)) {
    console.warn(
      `normalizeGoogleEvent: unknown ${fieldName} "${value}", defaulting to "${defaultValue}"`,
    );
  }
}

/**
 * Determine the change type from the Google event status.
 * Google API: status='cancelled' means the event was deleted.
 * All other statuses (confirmed, tentative, or missing) map to 'updated'
 * because Google uses 'updated' for both creates and updates during
 * incremental sync. The sync-consumer distinguishes create vs update
 * by checking if a canonical event already exists.
 */
function determineChangeType(
  event: GoogleCalendarEvent,
): "updated" | "deleted" {
  if (event.status === "cancelled") {
    return "deleted";
  }
  return "updated";
}

/**
 * Normalize an EventDateTime from Google's format.
 * Preserves the original structure -- all-day events use `date`,
 * timed events use `dateTime` + optional `timeZone`.
 */
function normalizeDateTime(dt: EventDateTime | undefined): EventDateTime {
  if (!dt) {
    return {};
  }

  const result: { dateTime?: string; date?: string; timeZone?: string } = {};

  if (dt.dateTime !== undefined) {
    result.dateTime = dt.dateTime;
  }
  if (dt.date !== undefined) {
    result.date = dt.date;
  }
  if (dt.timeZone !== undefined) {
    result.timeZone = dt.timeZone;
  }

  return result;
}

/**
 * Determine if the event is an all-day event.
 * Google Calendar all-day events use `start.date` (YYYY-MM-DD) instead of
 * `start.dateTime`. If `date` is present, the event is all-day.
 */
function isAllDay(start: EventDateTime | undefined): boolean {
  if (!start) {
    return false;
  }
  return start.date !== undefined;
}

/**
 * Normalize event status, defaulting to 'confirmed' if absent.
 * Google Calendar API status values: 'confirmed', 'tentative', 'cancelled'.
 * Note: 'cancelled' events are handled by determineChangeType and never
 * reach the event payload, so only 'confirmed' and 'tentative' appear here.
 *
 * Warns via console.warn if an unexpected value is received.
 */
function normalizeStatus(
  status: string | undefined,
): "confirmed" | "tentative" | "cancelled" {
  warnIfUnknown("status", status, VALID_STATUS, "confirmed");
  if (status === "tentative" || status === "cancelled") {
    return status;
  }
  return "confirmed";
}

/**
 * Normalize event visibility, defaulting to 'default' if absent.
 *
 * Warns via console.warn if an unexpected value is received.
 */
function normalizeVisibility(
  visibility: string | undefined,
): "default" | "public" | "private" | "confidential" {
  warnIfUnknown("visibility", visibility, VALID_VISIBILITY, "default");
  if (
    visibility === "public" ||
    visibility === "private" ||
    visibility === "confidential"
  ) {
    return visibility;
  }
  return "default";
}

/**
 * Normalize event transparency, defaulting to 'opaque' if absent.
 *
 * Warns via console.warn if an unexpected value is received.
 */
function normalizeTransparency(
  transparency: string | undefined,
): "opaque" | "transparent" {
  warnIfUnknown("transparency", transparency, VALID_TRANSPARENCY, "opaque");
  if (transparency === "transparent") {
    return transparency;
  }
  return "opaque";
}

/**
 * Extract the first recurrence rule from the recurrence array.
 * Google Calendar stores recurrence rules as an array of strings
 * (e.g., ["RRULE:FREQ=WEEKLY;BYDAY=MO", "EXDATE:..."]).
 * We store only the first rule (typically the RRULE) in Phase 1.
 */
function extractRecurrenceRule(
  recurrence: readonly string[] | undefined,
): string | undefined {
  if (!recurrence || recurrence.length === 0) {
    return undefined;
  }
  return recurrence[0];
}
