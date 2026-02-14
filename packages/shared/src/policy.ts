/**
 * @tminus/shared -- Policy compiler for the T-Minus projection engine.
 *
 * Pure function that transforms a CanonicalEvent + PolicyEdge into a
 * ProjectedEvent payload suitable for writing to the Google Calendar API.
 *
 * Business rules enforced:
 * - BR-3:  Projections are deterministic (same input => same output)
 * - BR-10: Default projection mode is BUSY (time only, no title/description/location)
 * - BR-11: Default calendar kind is BUSY_OVERLAY
 */

import type {
  CanonicalEvent,
  PolicyEdge,
  ProjectedEvent,
  EventDateTime,
} from "./types";

/**
 * Convert a CanonicalEvent's start/end into the Google Calendar EventDateTime
 * shape. All-day events produce {date}, timed events produce {dateTime, timeZone?}.
 */
function toEventDateTime(
  eventDt: EventDateTime,
  allDay: boolean,
): EventDateTime {
  if (allDay) {
    // All-day events: extract YYYY-MM-DD from dateTime, or use date directly
    const dateStr = eventDt.date ?? eventDt.dateTime?.split("T")[0];
    return { date: dateStr };
  }
  // Timed events: pass through dateTime and optional timeZone
  const result: EventDateTime = { dateTime: eventDt.dateTime };
  if (eventDt.timeZone !== undefined) {
    return { dateTime: eventDt.dateTime, timeZone: eventDt.timeZone };
  }
  return result;
}

/**
 * Compile a canonical event into a projected event payload based on the
 * policy edge's detail level.
 *
 * @param canonicalEvent - The source canonical event
 * @param edge - The policy edge controlling projection detail
 * @returns A ProjectedEvent ready for the Google Calendar API
 */
export function compileProjection(
  canonicalEvent: CanonicalEvent,
  edge: PolicyEdge,
): ProjectedEvent {
  const base = {
    start: toEventDateTime(canonicalEvent.start, canonicalEvent.all_day),
    end: toEventDateTime(canonicalEvent.end, canonicalEvent.all_day),
    transparency: canonicalEvent.transparency,
    extendedProperties: {
      private: {
        tminus: "true" as const,
        managed: "true" as const,
        canonical_event_id: canonicalEvent.canonical_event_id as string,
        origin_account_id: canonicalEvent.origin_account_id as string,
      },
    },
  };

  switch (edge.detail_level) {
    case "BUSY":
      return { ...base, summary: "Busy", visibility: "private" };
    case "TITLE":
      return {
        ...base,
        summary: canonicalEvent.title || "Busy",
        visibility: "default",
      };
    case "FULL":
      return {
        ...base,
        summary: canonicalEvent.title || "Busy",
        description: canonicalEvent.description || undefined,
        location: canonicalEvent.location || undefined,
        visibility: "default",
      };
  }
}
