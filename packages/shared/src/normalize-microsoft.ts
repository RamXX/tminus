/**
 * @tminus/shared -- Microsoft Graph Calendar event normalization.
 *
 * Converts raw Microsoft Graph API event responses into the ProviderDelta
 * format consumed by UserGraphDO.applyProviderDelta().
 *
 * Deterministic, no mutations. Parallel to normalize.ts (Google).
 *
 * Key field mappings:
 * - subject -> title
 * - body.content -> description
 * - location.displayName -> location
 * - start.dateTime + start.timeZone -> start (as EventDateTime)
 * - end.dateTime + end.timeZone -> end (as EventDateTime)
 * - isAllDay -> all_day
 * - isCancelled -> change type 'deleted'
 * - showAs -> transparency: free/tentative -> transparent, everything else -> opaque
 * - sensitivity -> visibility: normal -> default, private/personal -> private, confidential -> confidential
 *
 * Phase 1 excludes: attendees, organizer, onlineMeeting, recurrence patterns.
 * Microsoft uses structured recurrence objects (not RRULE strings);
 * RRULE conversion is deferred to a later story.
 */

import type {
  EventClassification,
  AccountId,
  ProviderDelta,
  EventDateTime,
} from "./types";

// ---------------------------------------------------------------------------
// Microsoft Graph Event type (raw from Graph API)
// ---------------------------------------------------------------------------

/**
 * Raw event shape from Microsoft Graph API v1.0.
 * Only includes fields we consume in Phase 1 normalization.
 */
export interface MicrosoftGraphEvent {
  readonly id?: string;
  readonly subject?: string;
  readonly body?: {
    readonly contentType?: string;
    readonly content?: string;
  };
  readonly start?: {
    readonly dateTime?: string;
    readonly timeZone?: string;
  };
  readonly end?: {
    readonly dateTime?: string;
    readonly timeZone?: string;
  };
  readonly isAllDay?: boolean;
  readonly isCancelled?: boolean;
  readonly showAs?: string;
  readonly sensitivity?: string;
  readonly location?: {
    readonly displayName?: string;
  };
  readonly attendees?: ReadonlyArray<{
    readonly emailAddress?: { readonly name?: string; readonly address?: string };
    readonly type?: string;
  }>;
  readonly onlineMeeting?: {
    readonly joinUrl?: string;
  };
  /** Event categories (used for managed-marker fallback classification). */
  readonly categories?: ReadonlyArray<string>;
  /** Open extensions attached to the event. */
  readonly extensions?: ReadonlyArray<{
    readonly "@odata.type"?: string;
    readonly extensionName?: string;
    readonly [key: string]: unknown;
  }>;
  /**
   * Microsoft Graph returns '@removed' property on delta query results
   * for deleted events. The event object will have minimal data.
   */
  readonly "@removed"?: { readonly reason?: string };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Normalize a raw Microsoft Graph event into a ProviderDelta.
 *
 * @param msEvent - Raw event from the Microsoft Graph API
 * @param accountId - The account this event belongs to
 * @param classification - How the event was classified (origin, managed_mirror, foreign_managed)
 * @returns A ProviderDelta ready for the sync pipeline
 */
export function normalizeMicrosoftEvent(
  msEvent: MicrosoftGraphEvent,
  accountId: AccountId,
  classification: EventClassification,
): ProviderDelta {
  const changeType = determineChangeType(msEvent);
  const originEventId = msEvent.id ?? "";

  // Deleted events and managed mirrors never carry an event payload.
  // Same logic as Google normalization -- Invariant E.
  if (changeType === "deleted" || classification === "managed_mirror") {
    return {
      type: changeType,
      origin_event_id: originEventId,
      origin_account_id: accountId,
    };
  }

  return {
    type: changeType,
    origin_event_id: originEventId,
    origin_account_id: accountId,
    event: {
      origin_account_id: accountId,
      origin_event_id: originEventId,
      title: msEvent.subject,
      description: msEvent.body?.content,
      location: msEvent.location?.displayName,
      start: normalizeDateTime(msEvent.start, msEvent.isAllDay),
      end: normalizeDateTime(msEvent.end, msEvent.isAllDay),
      all_day: msEvent.isAllDay ?? false,
      status: "confirmed", // Microsoft has no direct status field like Google; non-cancelled = confirmed
      visibility: normalizeVisibility(msEvent.sensitivity),
      transparency: normalizeTransparency(msEvent.showAs),
      recurrence_rule: undefined, // Microsoft uses structured recurrence, not RRULE. Deferred.
    },
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Determine the change type from the Microsoft event.
 * Microsoft uses isCancelled=true for cancelled events, or @removed in delta queries.
 */
function determineChangeType(
  event: MicrosoftGraphEvent,
): "updated" | "deleted" {
  if (event.isCancelled === true) {
    return "deleted";
  }
  if (event["@removed"] !== undefined) {
    return "deleted";
  }
  return "updated";
}

/**
 * Normalize a Microsoft Graph dateTime + timeZone into an EventDateTime.
 *
 * For all-day events, extract the date portion from dateTime and use the
 * date-only format (matching Google's all-day format).
 * For timed events, preserve dateTime + timeZone as-is.
 */
function normalizeDateTime(
  dt: MicrosoftGraphEvent["start"],
  isAllDay?: boolean,
): EventDateTime {
  if (!dt) {
    return {};
  }

  if (isAllDay && dt.dateTime) {
    // Extract YYYY-MM-DD from the dateTime string
    const datePart = dt.dateTime.substring(0, 10);
    return { date: datePart };
  }

  const result: { dateTime?: string; timeZone?: string } = {};
  if (dt.dateTime !== undefined) {
    result.dateTime = dt.dateTime;
  }
  if (dt.timeZone !== undefined) {
    result.timeZone = dt.timeZone;
  }
  return result;
}

/**
 * Map Microsoft sensitivity to our visibility model.
 * - 'normal' -> 'default'
 * - 'private' -> 'private'
 * - 'personal' -> 'private' (Microsoft 'personal' is closest to our 'private')
 * - 'confidential' -> 'confidential'
 */
function normalizeVisibility(
  sensitivity: string | undefined,
): "default" | "public" | "private" | "confidential" {
  switch (sensitivity) {
    case "normal":
      return "default";
    case "private":
      return "private";
    case "personal":
      return "private";
    case "confidential":
      return "confidential";
    default:
      return "default";
  }
}

/**
 * Map Microsoft showAs to our transparency model.
 * - 'free', 'tentative' -> 'transparent'
 * - 'busy', 'oof', 'workingElsewhere' -> 'opaque'
 */
function normalizeTransparency(
  showAs: string | undefined,
): "opaque" | "transparent" {
  switch (showAs) {
    case "free":
      return "transparent";
    case "tentative":
      return "transparent";
    default:
      return "opaque";
  }
}
