/**
 * @tminus/shared -- iCalendar (RFC 5545) parsing for CalDAV integration.
 *
 * Parses raw iCalendar text into structured ParsedVEvent objects.
 * This is the inverse of ical.ts (which generates iCalendar from CanonicalEvent).
 *
 * Pure functions, no side effects, no external dependencies.
 *
 * Key design decisions:
 * - Only VEVENT components are parsed (VTODO, VJOURNAL ignored)
 * - Line unfolding per RFC 5545 Section 3.1
 * - Text unescaping per RFC 5545 Section 3.3.11
 * - Property parameters are parsed (VALUE=DATE, TZID=...)
 * - Custom X-TMINUS-* properties are preserved for loop prevention
 */

import type { ParsedVEvent } from "./caldav-types";

// ---------------------------------------------------------------------------
// Line unfolding (RFC 5545 Section 3.1)
// ---------------------------------------------------------------------------

/**
 * Unfold content lines per RFC 5545.
 * Continuation lines begin with a single space or tab.
 * CRLF followed by space/tab is removed to rejoin the line.
 */
export function unfoldLines(text: string): string {
  // Normalize line endings to CRLF first, then unfold
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n[ \t]/g, "");
}

// ---------------------------------------------------------------------------
// Text unescaping (RFC 5545 Section 3.3.11)
// ---------------------------------------------------------------------------

/**
 * Unescape iCalendar TEXT values.
 * Reverses the escaping from ical.ts.
 */
export function unescapeText(text: string): string {
  return text
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

// ---------------------------------------------------------------------------
// Property parsing
// ---------------------------------------------------------------------------

/**
 * Parse an iCalendar property line into name, parameters, and value.
 *
 * Format: NAME;PARAM1=VAL1;PARAM2=VAL2:VALUE
 *
 * @returns { name, params, value } or null if line is malformed
 */
export function parsePropertyLine(
  line: string,
): { name: string; params: Record<string, string>; value: string } | null {
  // Find the colon that separates name+params from value
  // Must handle quoted parameter values that may contain colons
  let colonIdx = -1;
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') {
      inQuote = !inQuote;
    } else if (line[i] === ":" && !inQuote) {
      colonIdx = i;
      break;
    }
  }

  if (colonIdx === -1) return null;

  const nameAndParams = line.substring(0, colonIdx);
  const value = line.substring(colonIdx + 1);

  // Split name from parameters
  const semicolonIdx = nameAndParams.indexOf(";");
  let name: string;
  const params: Record<string, string> = {};

  if (semicolonIdx === -1) {
    name = nameAndParams.toUpperCase();
  } else {
    name = nameAndParams.substring(0, semicolonIdx).toUpperCase();
    const paramStr = nameAndParams.substring(semicolonIdx + 1);

    // Parse parameters (KEY=VALUE pairs separated by semicolons)
    for (const param of paramStr.split(";")) {
      const eqIdx = param.indexOf("=");
      if (eqIdx !== -1) {
        const pKey = param.substring(0, eqIdx).toUpperCase();
        let pVal = param.substring(eqIdx + 1);
        // Remove surrounding quotes if present
        if (pVal.startsWith('"') && pVal.endsWith('"')) {
          pVal = pVal.slice(1, -1);
        }
        params[pKey] = pVal;
      }
    }
  }

  return { name, params, value };
}

// ---------------------------------------------------------------------------
// VEVENT extraction
// ---------------------------------------------------------------------------

/**
 * Parse iCalendar text and extract all VEVENT components as ParsedVEvent.
 *
 * Handles:
 * - Line unfolding
 * - Multiple VEVENTs in a single VCALENDAR
 * - Property parameters (VALUE=DATE, TZID=...)
 * - Text unescaping for SUMMARY, DESCRIPTION, LOCATION
 * - Custom X-TMINUS-* properties
 *
 * @param icalText - Raw iCalendar text (VCALENDAR document)
 * @returns Array of parsed VEVENT objects
 */
export function parseVEvents(icalText: string): ParsedVEvent[] {
  const unfolded = unfoldLines(icalText);
  const lines = unfolded.split("\n").filter((l) => l.length > 0);

  const events: ParsedVEvent[] = [];
  let inVEvent = false;
  let currentProps: Record<
    string,
    { value: string; params: Record<string, string> }
  > = {};

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === "BEGIN:VEVENT") {
      inVEvent = true;
      currentProps = {};
      continue;
    }

    if (trimmed === "END:VEVENT") {
      inVEvent = false;

      // Build ParsedVEvent from collected properties
      const uid = currentProps["UID"]?.value;
      if (uid) {
        const event: ParsedVEvent = {
          uid,
          summary: currentProps["SUMMARY"]
            ? unescapeText(currentProps["SUMMARY"].value)
            : undefined,
          description: currentProps["DESCRIPTION"]
            ? unescapeText(currentProps["DESCRIPTION"].value)
            : undefined,
          location: currentProps["LOCATION"]
            ? unescapeText(currentProps["LOCATION"].value)
            : undefined,
          dtstart: currentProps["DTSTART"]?.value ?? "",
          dtstartParams: currentProps["DTSTART"]?.params,
          dtend: currentProps["DTEND"]?.value,
          dtendParams: currentProps["DTEND"]?.params,
          status: currentProps["STATUS"]?.value,
          transp: currentProps["TRANSP"]?.value,
          rrule: currentProps["RRULE"]?.value,
          class: currentProps["CLASS"]?.value,
          dtstamp: currentProps["DTSTAMP"]?.value,
          lastModified: currentProps["LAST-MODIFIED"]?.value,
          xTminusManaged: currentProps["X-TMINUS-MANAGED"]?.value,
          xTminusCanonicalId: currentProps["X-TMINUS-CANONICAL-ID"]?.value,
        };

        // Collect attendees
        const attendees: string[] = [];
        // Re-scan for ATTENDEE lines since there can be multiple
        // (we stored only the last one above)
        for (const scanLine of lines) {
          const parsed = parsePropertyLine(scanLine.trim());
          if (parsed && parsed.name === "ATTENDEE") {
            attendees.push(parsed.value);
          }
        }
        if (attendees.length > 0) {
          events.push({ ...event, attendees });
        } else {
          events.push(event);
        }
      }
      continue;
    }

    if (inVEvent) {
      const parsed = parsePropertyLine(trimmed);
      if (parsed) {
        currentProps[parsed.name] = {
          value: parsed.value,
          params: parsed.params,
        };
      }
    }
  }

  return events;
}

// ---------------------------------------------------------------------------
// DateTime conversion
// ---------------------------------------------------------------------------

/**
 * Convert an iCalendar date/datetime value to EventDateTime format.
 *
 * Handles:
 * - All-day events: VALUE=DATE with format YYYYMMDD -> { date: "YYYY-MM-DD" }
 * - UTC datetimes: YYYYMMDDTHHMMSSZ -> { dateTime: ISO8601 }
 * - Timezone datetimes: TZID=... with YYYYMMDDTHHMMSS -> { dateTime, timeZone }
 *
 * @param value - The date/datetime value from the iCal property
 * @param params - Property parameters (VALUE, TZID, etc.)
 */
export function icalDateTimeToEventDateTime(
  value: string,
  params?: Record<string, string>,
): { dateTime?: string; date?: string; timeZone?: string } {
  // All-day event: VALUE=DATE or 8-digit date without time
  if (params?.["VALUE"] === "DATE" || /^\d{8}$/.test(value)) {
    // Convert YYYYMMDD to YYYY-MM-DD
    const date = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
    return { date };
  }

  // Parse YYYYMMDDTHHMMSS[Z]
  const isUTC = value.endsWith("Z");
  const clean = value.replace("Z", "");

  // Extract components
  const year = clean.slice(0, 4);
  const month = clean.slice(4, 6);
  const day = clean.slice(6, 8);
  // Skip 'T' at index 8
  const hour = clean.slice(9, 11);
  const minute = clean.slice(11, 13);
  const second = clean.slice(13, 15);

  const dateTime = `${year}-${month}-${day}T${hour}:${minute}:${second}${isUTC ? "Z" : ""}`;

  const tzid = params?.["TZID"];

  if (isUTC) {
    return { dateTime };
  }

  if (tzid) {
    return { dateTime, timeZone: tzid };
  }

  // No timezone info -- treat as-is
  return { dateTime };
}
