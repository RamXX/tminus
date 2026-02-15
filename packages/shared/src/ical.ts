/**
 * iCalendar (RFC 5545) generation for CalDAV feed serving.
 *
 * Pure functions that convert canonical events into valid iCalendar text.
 * No external dependencies -- iCalendar is a simple text format.
 *
 * RFC 5545 reference: https://tools.ietf.org/html/rfc5545
 */

import type { CanonicalEvent } from "./types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** CRLF line ending required by RFC 5545 */
const CRLF = "\r\n";

/** Maximum line length in octets before folding (RFC 5545 Section 3.1) */
const MAX_LINE_OCTETS = 75;

// ---------------------------------------------------------------------------
// Text escaping (RFC 5545 Section 3.3.11)
// ---------------------------------------------------------------------------

/**
 * Escape special characters in iCalendar TEXT values.
 * Backslash, semicolons, commas, and newlines must be escaped.
 */
function escapeText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

// ---------------------------------------------------------------------------
// Line folding (RFC 5545 Section 3.1)
// ---------------------------------------------------------------------------

/**
 * Fold a content line at 75 octets per RFC 5545.
 * Continuation lines begin with a single space.
 */
export function foldLine(line: string): string {
  if (line.length <= MAX_LINE_OCTETS) {
    return line;
  }

  const parts: string[] = [];
  // First line: up to 75 chars
  parts.push(line.slice(0, MAX_LINE_OCTETS));
  let pos = MAX_LINE_OCTETS;

  // Continuation lines: space + up to 74 chars (space counts as 1 octet)
  while (pos < line.length) {
    const chunkSize = MAX_LINE_OCTETS - 1; // 1 octet for the leading space
    parts.push(" " + line.slice(pos, pos + chunkSize));
    pos += chunkSize;
  }

  return parts.join(CRLF);
}

// ---------------------------------------------------------------------------
// Date / DateTime formatting
// ---------------------------------------------------------------------------

/**
 * Format a YYYY-MM-DD date string to iCalendar DATE format (YYYYMMDD).
 * Used for all-day events.
 */
export function formatICalDate(dateStr: string): string {
  return dateStr.replace(/-/g, "");
}

/**
 * Format an ISO 8601 datetime to iCalendar DATE-TIME format.
 *
 * - UTC datetimes (ending in Z): YYYYMMDDTHHMMSSZ
 * - Local datetimes (with timezone context): YYYYMMDDTHHMMSS (no Z suffix)
 *
 * @param dateTimeStr ISO 8601 datetime string
 * @param _timeZone Optional IANA timezone (controls whether Z suffix is emitted)
 */
export function formatICalDateTime(dateTimeStr: string, _timeZone?: string): string {
  // Strip everything except digits and T
  // Input: "2025-06-15T09:00:00Z" or "2025-06-15T09:00:00"
  const isUTC = dateTimeStr.endsWith("Z") && !_timeZone;

  const cleaned = dateTimeStr
    .replace(/Z$/, "")
    .replace(/-/g, "")
    .replace(/:/g, "");

  // Ensure we have exactly YYYYMMDDTHHMMSS (15 chars)
  // Trim any sub-second precision (.000)
  const dotIdx = cleaned.indexOf(".");
  const trimmed = dotIdx >= 0 ? cleaned.slice(0, dotIdx) : cleaned;

  return isUTC ? trimmed + "Z" : trimmed;
}

// ---------------------------------------------------------------------------
// Timezone collection
// ---------------------------------------------------------------------------

/**
 * Collect all unique IANA timezone IDs referenced by a set of events.
 * UTC (no timeZone field) and all-day events (date-only) are excluded.
 */
export function collectTimezones(events: readonly CanonicalEvent[]): Set<string> {
  const tzIds = new Set<string>();

  for (const event of events) {
    if (event.start.timeZone) {
      tzIds.add(event.start.timeZone);
    }
    if (event.end.timeZone) {
      tzIds.add(event.end.timeZone);
    }
  }

  return tzIds;
}

// ---------------------------------------------------------------------------
// VTIMEZONE generation
// ---------------------------------------------------------------------------

/**
 * Generate a minimal VTIMEZONE component for an IANA timezone.
 *
 * Since we cannot access the full Olson database at runtime in a Worker,
 * we emit a minimal VTIMEZONE stub with the TZID. Most modern calendar
 * clients (Apple Calendar, Google Calendar, Outlook) resolve IANA timezone
 * IDs natively and do not rely on the VTIMEZONE transition rules.
 *
 * This approach is consistent with how Google Calendar itself generates
 * iCalendar feeds.
 */
function generateVTimezone(tzId: string): string {
  const lines = [
    "BEGIN:VTIMEZONE",
    `TZID:${tzId}`,
    // Minimal STANDARD sub-component (required by RFC 5545)
    "BEGIN:STANDARD",
    "DTSTART:19700101T000000",
    `TZNAME:${tzId}`,
    "TZOFFSETFROM:+0000",
    "TZOFFSETTO:+0000",
    "END:STANDARD",
    "END:VTIMEZONE",
  ];
  return lines.join(CRLF);
}

// ---------------------------------------------------------------------------
// VEVENT construction
// ---------------------------------------------------------------------------

/**
 * Build a VEVENT component string from a CanonicalEvent.
 *
 * Handles all-day events (VALUE=DATE), timed UTC events, and
 * timed events with timezone (TZID parameter).
 */
export function buildVEvent(event: CanonicalEvent): string {
  const lines: string[] = [];

  lines.push("BEGIN:VEVENT");

  // UID -- use the canonical event ID for global uniqueness
  lines.push(`UID:${event.canonical_event_id}`);

  // DTSTAMP -- last modification time
  lines.push(`DTSTAMP:${formatICalDateTime(event.updated_at)}`);

  // DTSTART / DTEND
  if (event.all_day && event.start.date && event.end.date) {
    lines.push(`DTSTART;VALUE=DATE:${formatICalDate(event.start.date)}`);
    lines.push(`DTEND;VALUE=DATE:${formatICalDate(event.end.date)}`);
  } else if (event.start.dateTime && event.end.dateTime) {
    if (event.start.timeZone) {
      lines.push(`DTSTART;TZID=${event.start.timeZone}:${formatICalDateTime(event.start.dateTime, event.start.timeZone)}`);
    } else {
      lines.push(`DTSTART:${formatICalDateTime(event.start.dateTime)}`);
    }

    if (event.end.timeZone) {
      lines.push(`DTEND;TZID=${event.end.timeZone}:${formatICalDateTime(event.end.dateTime, event.end.timeZone)}`);
    } else {
      lines.push(`DTEND:${formatICalDateTime(event.end.dateTime)}`);
    }
  }

  // SUMMARY
  lines.push(`SUMMARY:${escapeText(event.title ?? "(No title)")}`);

  // DESCRIPTION (optional)
  if (event.description) {
    lines.push(`DESCRIPTION:${escapeText(event.description)}`);
  }

  // LOCATION (optional)
  if (event.location) {
    lines.push(`LOCATION:${escapeText(event.location)}`);
  }

  // STATUS
  lines.push(`STATUS:${event.status.toUpperCase()}`);

  // TRANSP
  lines.push(`TRANSP:${event.transparency.toUpperCase()}`);

  // RRULE (optional)
  if (event.recurrence_rule) {
    lines.push(`RRULE:${event.recurrence_rule}`);
  }

  lines.push("END:VEVENT");

  // Join with CRLF and apply line folding
  return lines.map(foldLine).join(CRLF);
}

// ---------------------------------------------------------------------------
// Full VCALENDAR assembly
// ---------------------------------------------------------------------------

/** Options for buildVCalendar. */
export interface VCalendarOptions {
  /** If true, exclude events with status "cancelled". Default: false. */
  excludeCancelled?: boolean;
  /** Custom calendar name. Default: "T-Minus Unified Calendar". */
  calendarName?: string;
}

/**
 * Build a complete VCALENDAR document from an array of canonical events.
 *
 * Includes:
 * - VCALENDAR header with PRODID, VERSION, CALSCALE, METHOD
 * - VTIMEZONE components for all referenced timezones
 * - VEVENT components for each event
 *
 * @param events Array of canonical events to include
 * @param options Optional configuration
 * @returns Complete iCalendar document string
 */
export function buildVCalendar(
  events: readonly CanonicalEvent[],
  options?: VCalendarOptions,
): string {
  const calName = options?.calendarName ?? "T-Minus Unified Calendar";

  // Filter cancelled events if requested
  const filteredEvents = options?.excludeCancelled
    ? events.filter(e => e.status !== "cancelled")
    : events;

  // Collect timezones from filtered events
  const timezones = collectTimezones(filteredEvents);

  // Build the document
  const parts: string[] = [];

  // Header
  parts.push("BEGIN:VCALENDAR");
  parts.push("VERSION:2.0");
  parts.push("PRODID:-//T-Minus//Calendar Feed//EN");
  parts.push("CALSCALE:GREGORIAN");
  parts.push("METHOD:PUBLISH");
  parts.push(foldLine(`X-WR-CALNAME:${escapeText(calName)}`));

  // VTIMEZONE components (before VEVENTs per convention)
  for (const tzId of timezones) {
    parts.push(generateVTimezone(tzId));
  }

  // VEVENT components
  for (const event of filteredEvents) {
    parts.push(buildVEvent(event));
  }

  parts.push("END:VCALENDAR");

  return parts.join(CRLF) + CRLF;
}
