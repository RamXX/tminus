/**
 * @tminus/shared -- Full iCalendar (RFC 5545) Feed Parser & Event Normalization.
 *
 * Builds on the walking skeleton's basic parsing (ics-feed.ts, ical-parse.ts)
 * to handle the full spectrum of real-world ICS feeds from Google, Microsoft,
 * Apple, Fastmail, and ProtonMail.
 *
 * Key capabilities:
 * - VEVENT, VTODO, VFREEBUSY, VTIMEZONE component parsing
 * - RRULE recurrence expansion with EXDATE exceptions
 * - DURATION as alternative to DTEND
 * - Structured ATTENDEE/ORGANIZER extraction (CN, PARTSTAT, ROLE)
 * - Virtual meeting URL extraction (X-GOOGLE-CONFERENCE, X-MICROSOFT-ONLINEMEETINGURL, Zoom in LOCATION)
 * - Line folding (RFC 5545 Section 3.1)
 * - Non-standard X-property preservation
 * - Graceful handling of malformed input (partial parse, not crash)
 * - Zod schemas for runtime validation of all parsed types
 *
 * Design: Pure functions, no side effects, no external dependencies beyond Zod-like
 * inline validation (we use a minimal Zod-compatible schema approach since the shared
 * package doesn't depend on Zod -- we define schema objects with .safeParse()).
 *
 * CanonicalEvent mapping table:
 * | iCalendar Property  | NormalizedFeedEvent Field  | Notes                           |
 * |---------------------|---------------------------|---------------------------------|
 * | UID                 | origin_event_id           | Required; events without UID skipped |
 * | SUMMARY             | title                     | Unescaped                       |
 * | DESCRIPTION         | description               | Unescaped                       |
 * | LOCATION            | location                  | Unescaped; also scanned for URLs |
 * | DTSTART             | start                     | EventDateTime {dateTime, date, timeZone} |
 * | DTEND / DURATION    | end                       | DURATION computed to absolute end |
 * | VALUE=DATE          | all_day                   | true when VALUE=DATE            |
 * | STATUS              | status                    | confirmed/tentative/cancelled   |
 * | CLASS               | visibility                | default/public/private/confidential |
 * | TRANSP              | transparency              | opaque/transparent              |
 * | RRULE               | recurrence_rule           | Raw RRULE string                |
 * | EXDATE              | exdates                   | Array of excluded dates         |
 * | ATTENDEE            | attendees                 | Structured: email, cn, partstat, role |
 * | ORGANIZER           | organizer                 | Structured: email, cn           |
 * | X-GOOGLE-CONFERENCE | meeting_url               | Priority 1 for meeting URL      |
 * | X-MICROSOFT-*       | meeting_url               | Priority 2 for meeting URL      |
 * | LOCATION (URL)      | meeting_url               | Priority 3: URL extracted from location |
 * | X-*                 | x_properties              | All non-standard properties preserved |
 * | (source)            | source = "ics_feed"       | Always "ics_feed"               |
 * | VTODO SUMMARY       | title (is_task=true)      | VTODOs mapped with task flag    |
 * | VFREEBUSY FREEBUSY  | events (busy overlays)    | Per AD-4 busy overlay calendars |
 */

import type { EventDateTime } from "./types";
import { unfoldLines, parsePropertyLine, unescapeText, icalDateTimeToEventDateTime } from "./ical-parse";

// ---------------------------------------------------------------------------
// Zod-compatible schema validation (inline, no external dependency)
// ---------------------------------------------------------------------------

/**
 * Minimal Zod-compatible schema interface for runtime validation.
 * We implement .safeParse() directly to avoid adding Zod as a dependency.
 */
interface SafeParseResult<T> {
  success: boolean;
  data?: T;
  error?: { issues: Array<{ message: string; path: string[] }> };
}

interface SchemaLike<T> {
  safeParse(data: unknown): SafeParseResult<T>;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Structured attendee data extracted from ATTENDEE property. */
export interface ParsedAttendee {
  readonly email: string;
  readonly cn?: string;
  readonly partstat?: string;
  readonly role?: string;
}

/** Structured organizer data extracted from ORGANIZER property. */
export interface ParsedOrganizer {
  readonly email: string;
  readonly cn?: string;
}

/** Parsed VTODO component. */
export interface ParsedTodo {
  readonly uid: string;
  readonly summary?: string;
  readonly description?: string;
  readonly dtstart?: string;
  readonly dtstartParams?: Record<string, string>;
  readonly due?: string;
  readonly dueParams?: Record<string, string>;
  readonly status?: string;
  readonly priority?: number;
}

/** A free/busy period from VFREEBUSY component. */
export interface FreeBusyPeriod {
  readonly start: string;
  readonly end: string;
  readonly fbtype: string; // BUSY, BUSY-TENTATIVE, BUSY-UNAVAILABLE, FREE
}

/** Parsed VFREEBUSY component. */
export interface ParsedFreeBusy {
  readonly uid: string;
  readonly dtstart?: string;
  readonly dtend?: string;
  readonly organizer?: string;
  readonly periods: readonly FreeBusyPeriod[];
}

/** Parsed timezone sub-component (STANDARD or DAYLIGHT). */
export interface TimezoneComponent {
  readonly type: "STANDARD" | "DAYLIGHT";
  readonly dtstart?: string;
  readonly tzoffsetfrom?: string;
  readonly tzoffsetto?: string;
  readonly tzname?: string;
  readonly rrule?: string;
}

/** Parsed VTIMEZONE component. */
export interface ParsedTimezone {
  readonly tzid: string;
  readonly components: readonly TimezoneComponent[];
}

/**
 * Extended NormalizedFeedEvent with full parser output.
 * Superset of NormalizedFeedEvent from ics-feed.ts.
 */
export interface ExtendedFeedEvent {
  readonly origin_event_id: string;
  readonly origin_account_id: string;
  readonly title?: string;
  readonly description?: string;
  readonly location?: string;
  readonly start: EventDateTime;
  readonly end: EventDateTime;
  readonly all_day: boolean;
  readonly status: "confirmed" | "tentative" | "cancelled";
  readonly visibility: "default" | "public" | "private" | "confidential";
  readonly transparency: "opaque" | "transparent";
  readonly recurrence_rule?: string;
  readonly exdates?: readonly string[];
  readonly source: "ics_feed";
  readonly is_task?: boolean;
  readonly attendees?: readonly ParsedAttendee[];
  readonly organizer?: ParsedOrganizer;
  readonly meeting_url?: string;
  readonly x_properties?: Record<string, string>;
}

/** Complete parsed ICS feed result. */
export interface ParsedFeed {
  readonly events: readonly ExtendedFeedEvent[];
  readonly todos: readonly ParsedTodo[];
  readonly freeBusy: readonly ParsedFreeBusy[];
  readonly timezones: readonly ParsedTimezone[];
}

/** Recurrence expansion options. */
export interface RecurrenceExpansionOptions {
  readonly windowEnd: string; // YYYY-MM-DD or ISO string
  readonly exdates?: readonly string[];
}

/** A single recurrence instance. */
export interface RecurrenceInstance {
  readonly start: string;
  readonly end: string;
}

/** Parsed component (internal intermediate representation). */
export type ParsedComponent = {
  readonly type: string;
  readonly properties: Record<string, { value: string; params: Record<string, string> }>;
  readonly multiProperties: Record<string, Array<{ value: string; params: Record<string, string> }>>;
  readonly subComponents: ParsedComponent[];
};

// ---------------------------------------------------------------------------
// Zod-compatible schemas for runtime validation
// ---------------------------------------------------------------------------

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Zod-compatible schema for ParsedAttendee. */
export const ParsedAttendeeSchema: SchemaLike<ParsedAttendee> = {
  safeParse(data: unknown): SafeParseResult<ParsedAttendee> {
    if (!isObject(data)) {
      return { success: false, error: { issues: [{ message: "Expected object", path: [] }] } };
    }
    if (!isString(data.email)) {
      return { success: false, error: { issues: [{ message: "email must be a string", path: ["email"] }] } };
    }
    return {
      success: true,
      data: {
        email: data.email as string,
        cn: isString(data.cn) ? data.cn : undefined,
        partstat: isString(data.partstat) ? data.partstat : undefined,
        role: isString(data.role) ? data.role : undefined,
      },
    };
  },
};

/** Zod-compatible schema for EventDateTime. */
const EventDateTimeSchema: SchemaLike<EventDateTime> = {
  safeParse(data: unknown): SafeParseResult<EventDateTime> {
    if (!isObject(data)) {
      return { success: false, error: { issues: [{ message: "Expected object", path: [] }] } };
    }
    return {
      success: true,
      data: {
        dateTime: isString(data.dateTime) ? data.dateTime : undefined,
        date: isString(data.date) ? data.date : undefined,
        timeZone: isString(data.timeZone) ? data.timeZone : undefined,
      },
    };
  },
};

/** Zod-compatible schema for NormalizedFeedEvent (extended). */
export const NormalizedFeedEventSchema: SchemaLike<ExtendedFeedEvent> = {
  safeParse(data: unknown): SafeParseResult<ExtendedFeedEvent> {
    if (!isObject(data)) {
      return { success: false, error: { issues: [{ message: "Expected object", path: [] }] } };
    }
    if (!isString(data.origin_event_id)) {
      return { success: false, error: { issues: [{ message: "origin_event_id required", path: ["origin_event_id"] }] } };
    }
    if (!isString(data.origin_account_id)) {
      return { success: false, error: { issues: [{ message: "origin_account_id required", path: ["origin_account_id"] }] } };
    }
    const startResult = EventDateTimeSchema.safeParse(data.start);
    if (!startResult.success) {
      return { success: false, error: { issues: [{ message: "invalid start", path: ["start"] }] } };
    }
    const endResult = EventDateTimeSchema.safeParse(data.end);
    if (!endResult.success) {
      return { success: false, error: { issues: [{ message: "invalid end", path: ["end"] }] } };
    }
    if (typeof data.all_day !== "boolean") {
      return { success: false, error: { issues: [{ message: "all_day must be boolean", path: ["all_day"] }] } };
    }
    const validStatuses = ["confirmed", "tentative", "cancelled"];
    if (!isString(data.status) || !validStatuses.includes(data.status)) {
      return { success: false, error: { issues: [{ message: "invalid status", path: ["status"] }] } };
    }
    if (data.source !== "ics_feed") {
      return { success: false, error: { issues: [{ message: "source must be ics_feed", path: ["source"] }] } };
    }

    // Validate attendees if present
    if (data.attendees !== undefined) {
      if (!Array.isArray(data.attendees)) {
        return { success: false, error: { issues: [{ message: "attendees must be array", path: ["attendees"] }] } };
      }
      for (let i = 0; i < data.attendees.length; i++) {
        const r = ParsedAttendeeSchema.safeParse(data.attendees[i]);
        if (!r.success) {
          return { success: false, error: { issues: [{ message: `invalid attendee at ${i}`, path: ["attendees", String(i)] }] } };
        }
      }
    }

    return {
      success: true,
      data: data as unknown as ExtendedFeedEvent,
    };
  },
};

// ---------------------------------------------------------------------------
// Component parser (RFC 5545 generic)
// ---------------------------------------------------------------------------

/**
 * Parse raw iCalendar text into a tree of components.
 *
 * Handles:
 * - Line unfolding (RFC 5545 Section 3.1)
 * - Nested components (VEVENT, VTIMEZONE > STANDARD/DAYLIGHT, VALARM)
 * - Multiple properties with the same name (ATTENDEE, FREEBUSY, EXDATE)
 * - Property parameters
 */
function parseComponents(icalText: string): ParsedComponent[] {
  const unfolded = unfoldLines(icalText);
  const lines = unfolded.split("\n").filter((l) => l.length > 0);

  const rootComponents: ParsedComponent[] = [];
  const stack: ParsedComponent[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("BEGIN:")) {
      const componentType = trimmed.substring(6).toUpperCase();
      const component: ParsedComponent = {
        type: componentType,
        properties: {},
        multiProperties: {},
        subComponents: [],
      };

      if (stack.length > 0) {
        // Nested component (e.g., VALARM inside VEVENT, STANDARD inside VTIMEZONE)
        const parent = stack[stack.length - 1];
        (parent.subComponents as ParsedComponent[]).push(component);
      }

      stack.push(component);
      continue;
    }

    if (trimmed.startsWith("END:")) {
      const component = stack.pop();
      if (component && stack.length === 0) {
        // Top-level component finished
        rootComponents.push(component);
      }
      continue;
    }

    // Property line inside a component
    if (stack.length > 0) {
      const parsed = parsePropertyLine(trimmed);
      if (parsed) {
        const current = stack[stack.length - 1];
        const entry = { value: parsed.value, params: parsed.params };

        // Store in single-value properties (last wins for most props)
        (current.properties as Record<string, { value: string; params: Record<string, string> }>)[parsed.name] = entry;

        // Also store in multi-value properties (for ATTENDEE, FREEBUSY, EXDATE)
        const multi = current.multiProperties as Record<string, Array<{ value: string; params: Record<string, string> }>>;
        if (!multi[parsed.name]) {
          multi[parsed.name] = [];
        }
        multi[parsed.name].push(entry);
      }
    }
  }

  return rootComponents;
}

// ---------------------------------------------------------------------------
// Meeting URL extraction
// ---------------------------------------------------------------------------

/** Known meeting URL patterns. */
const MEETING_URL_PATTERNS = [
  /https?:\/\/meet\.google\.com\/[a-z-]+/i,
  /https?:\/\/teams\.microsoft\.com\/[^\s)"]*/i,
  /https?:\/\/zoom\.us\/j\/[^\s?")]*(?:\?[^\s")]*)?/i,
  /https?:\/\/[a-z0-9]+\.zoom\.us\/j\/[^\s?")]*(?:\?[^\s")]*)?/i,
  /https?:\/\/webex\.com\/[^\s")]+/i,
];

/**
 * Extract a virtual meeting URL from X-properties and/or LOCATION text.
 *
 * Priority:
 * 1. X-GOOGLE-CONFERENCE
 * 2. X-MICROSOFT-ONLINEMEETINGURL
 * 3. URL pattern in LOCATION string
 *
 * @param xProperties - Map of X-* property names to values
 * @param location - LOCATION property value (may contain embedded URL)
 * @returns The meeting URL, or undefined if none found
 */
export function extractMeetingUrl(
  xProperties?: Record<string, string>,
  location?: string,
): string | undefined {
  // Priority 1: X-GOOGLE-CONFERENCE
  if (xProperties?.["X-GOOGLE-CONFERENCE"]) {
    return xProperties["X-GOOGLE-CONFERENCE"];
  }

  // Priority 2: X-MICROSOFT-ONLINEMEETINGURL
  if (xProperties?.["X-MICROSOFT-ONLINEMEETINGURL"]) {
    return xProperties["X-MICROSOFT-ONLINEMEETINGURL"];
  }

  // Priority 3: URL pattern in LOCATION
  if (location) {
    for (const pattern of MEETING_URL_PATTERNS) {
      const match = location.match(pattern);
      if (match) {
        return match[0];
      }
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// ATTENDEE / ORGANIZER extraction
// ---------------------------------------------------------------------------

/**
 * Extract email from ATTENDEE or ORGANIZER value.
 * The value is typically "mailto:email@example.com".
 */
function extractEmail(value: string): string {
  if (value.toLowerCase().startsWith("mailto:")) {
    return value.substring(7);
  }
  return value;
}

/**
 * Parse ATTENDEE properties into structured ParsedAttendee array.
 */
function parseAttendees(
  multiProps: Record<string, Array<{ value: string; params: Record<string, string> }>>,
): ParsedAttendee[] {
  const attendeeEntries = multiProps["ATTENDEE"];
  if (!attendeeEntries || attendeeEntries.length === 0) {
    return [];
  }

  return attendeeEntries.map((entry) => ({
    email: extractEmail(entry.value),
    cn: entry.params["CN"],
    partstat: entry.params["PARTSTAT"],
    role: entry.params["ROLE"],
  }));
}

/**
 * Parse ORGANIZER property into structured ParsedOrganizer.
 */
function parseOrganizer(
  props: Record<string, { value: string; params: Record<string, string> }>,
): ParsedOrganizer | undefined {
  const org = props["ORGANIZER"];
  if (!org) return undefined;

  return {
    email: extractEmail(org.value),
    cn: org.params["CN"],
  };
}

// ---------------------------------------------------------------------------
// X-property collection
// ---------------------------------------------------------------------------

/**
 * Collect all X-* (non-standard) properties from a component.
 */
function collectXProperties(
  props: Record<string, { value: string; params: Record<string, string> }>,
): Record<string, string> | undefined {
  const xProps: Record<string, string> = {};
  let hasAny = false;

  for (const [name, entry] of Object.entries(props)) {
    if (name.startsWith("X-")) {
      xProps[name] = entry.value;
      hasAny = true;
    }
  }

  return hasAny ? xProps : undefined;
}

// ---------------------------------------------------------------------------
// DURATION parsing (RFC 5545 Section 3.3.6)
// ---------------------------------------------------------------------------

/**
 * Parse an iCalendar DURATION value (e.g., "PT1H30M", "P1D", "P1W").
 * Returns duration in milliseconds.
 */
function parseDuration(dur: string): number {
  if (!dur || !dur.startsWith("P")) return 0;

  let remaining = dur.substring(1); // Remove 'P'
  let ms = 0;

  // Handle weeks
  const weekMatch = remaining.match(/^(\d+)W/);
  if (weekMatch) {
    ms += parseInt(weekMatch[1], 10) * 7 * 24 * 60 * 60 * 1000;
    remaining = remaining.substring(weekMatch[0].length);
  }

  // Handle days
  const dayMatch = remaining.match(/^(\d+)D/);
  if (dayMatch) {
    ms += parseInt(dayMatch[1], 10) * 24 * 60 * 60 * 1000;
    remaining = remaining.substring(dayMatch[0].length);
  }

  // Handle time portion
  if (remaining.startsWith("T")) {
    remaining = remaining.substring(1);

    const hourMatch = remaining.match(/^(\d+)H/);
    if (hourMatch) {
      ms += parseInt(hourMatch[1], 10) * 60 * 60 * 1000;
      remaining = remaining.substring(hourMatch[0].length);
    }

    const minMatch = remaining.match(/^(\d+)M/);
    if (minMatch) {
      ms += parseInt(minMatch[1], 10) * 60 * 1000;
      remaining = remaining.substring(minMatch[0].length);
    }

    const secMatch = remaining.match(/^(\d+)S/);
    if (secMatch) {
      ms += parseInt(secMatch[1], 10) * 1000;
    }
  }

  return ms;
}

/**
 * Compute end datetime from start + DURATION.
 *
 * @param dtstart - iCalendar DTSTART value (e.g., "20260301T100000Z")
 * @param dtstartParams - DTSTART parameters (VALUE, TZID, etc.)
 * @param duration - iCalendar DURATION value (e.g., "PT1H30M")
 * @returns EventDateTime for the end time
 */
function computeEndFromDuration(
  dtstart: string,
  dtstartParams: Record<string, string> | undefined,
  duration: string,
): EventDateTime {
  const durationMs = parseDuration(duration);
  if (durationMs === 0) {
    return icalDateTimeToEventDateTime(dtstart, dtstartParams);
  }

  const isAllDayEvent = dtstartParams?.["VALUE"] === "DATE" || /^\d{8}$/.test(dtstart);

  if (isAllDayEvent) {
    // All-day: add days
    const days = Math.ceil(durationMs / (24 * 60 * 60 * 1000));
    const year = parseInt(dtstart.slice(0, 4), 10);
    const month = parseInt(dtstart.slice(4, 6), 10) - 1;
    const day = parseInt(dtstart.slice(6, 8), 10);
    const date = new Date(Date.UTC(year, month, day + days));
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, "0");
    const d = String(date.getUTCDate()).padStart(2, "0");
    return { date: `${y}-${m}-${d}` };
  }

  // Timed event: parse the datetime and add duration
  const isUTC = dtstart.endsWith("Z");
  const clean = dtstart.replace("Z", "");
  const year = parseInt(clean.slice(0, 4), 10);
  const month = parseInt(clean.slice(4, 6), 10) - 1;
  const day = parseInt(clean.slice(6, 8), 10);
  const hour = parseInt(clean.slice(9, 11), 10);
  const minute = parseInt(clean.slice(11, 13), 10);
  const second = parseInt(clean.slice(13, 15), 10);

  const startMs = Date.UTC(year, month, day, hour, minute, second);
  const endMs = startMs + durationMs;
  const endDate = new Date(endMs);

  const y = endDate.getUTCFullYear();
  const mo = String(endDate.getUTCMonth() + 1).padStart(2, "0");
  const dy = String(endDate.getUTCDate()).padStart(2, "0");
  const hr = String(endDate.getUTCHours()).padStart(2, "0");
  const mi = String(endDate.getUTCMinutes()).padStart(2, "0");
  const se = String(endDate.getUTCSeconds()).padStart(2, "0");

  const dateTime = `${y}-${mo}-${dy}T${hr}:${mi}:${se}${isUTC ? "Z" : ""}`;
  const tzid = dtstartParams?.["TZID"];

  if (tzid) {
    return { dateTime, timeZone: tzid };
  }
  return { dateTime };
}

// ---------------------------------------------------------------------------
// Default end computation (when no DTEND and no DURATION)
// ---------------------------------------------------------------------------

/**
 * Compute default end when neither DTEND nor DURATION is present.
 * Per RFC 5545:
 * - All-day events: DTEND = DTSTART + 1 day
 * - Timed events: DTEND = DTSTART (zero-duration)
 */
function computeDefaultEnd(
  dtstart: string,
  dtstartParams: Record<string, string> | undefined,
): EventDateTime {
  const isAllDayEvent = dtstartParams?.["VALUE"] === "DATE" || /^\d{8}$/.test(dtstart);

  if (isAllDayEvent) {
    // Add 1 day
    const year = parseInt(dtstart.slice(0, 4), 10);
    const month = parseInt(dtstart.slice(4, 6), 10) - 1;
    const day = parseInt(dtstart.slice(6, 8), 10);
    const date = new Date(Date.UTC(year, month, day + 1));
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, "0");
    const d = String(date.getUTCDate()).padStart(2, "0");
    return { date: `${y}-${m}-${d}` };
  }

  // Timed: end = start
  return icalDateTimeToEventDateTime(dtstart, dtstartParams);
}

// ---------------------------------------------------------------------------
// EXDATE extraction
// ---------------------------------------------------------------------------

/**
 * Extract all EXDATE values from a component.
 * EXDATE can appear multiple times and can contain comma-separated values.
 */
function extractExdates(
  multiProps: Record<string, Array<{ value: string; params: Record<string, string> }>>,
): string[] {
  const exdateEntries = multiProps["EXDATE"];
  if (!exdateEntries || exdateEntries.length === 0) {
    return [];
  }

  const exdates: string[] = [];
  for (const entry of exdateEntries) {
    // EXDATE values can be comma-separated
    const values = entry.value.split(",");
    for (const v of values) {
      const trimmed = v.trim();
      if (trimmed) {
        exdates.push(trimmed);
      }
    }
  }
  return exdates;
}

// ---------------------------------------------------------------------------
// FREEBUSY period parsing
// ---------------------------------------------------------------------------

/**
 * Parse FREEBUSY property values.
 * Format: START/END or START/DURATION
 */
function parseFreeBusyPeriods(
  multiProps: Record<string, Array<{ value: string; params: Record<string, string> }>>,
): FreeBusyPeriod[] {
  const fbEntries = multiProps["FREEBUSY"];
  if (!fbEntries || fbEntries.length === 0) {
    return [];
  }

  const periods: FreeBusyPeriod[] = [];
  for (const entry of fbEntries) {
    const fbtype = entry.params["FBTYPE"] || "BUSY";
    // Value can contain comma-separated periods
    const periodStrs = entry.value.split(",");
    for (const periodStr of periodStrs) {
      const slashIdx = periodStr.indexOf("/");
      if (slashIdx === -1) continue;

      const startVal = periodStr.substring(0, slashIdx).trim();
      const endOrDuration = periodStr.substring(slashIdx + 1).trim();

      let endVal: string;
      if (endOrDuration.startsWith("P")) {
        // Duration format -- compute end
        const durationMs = parseDuration(endOrDuration);
        const startDt = parseICalDateToMs(startVal);
        if (startDt === null) continue;
        const endDate = new Date(startDt + durationMs);
        endVal = formatDateToICal(endDate);
      } else {
        endVal = endOrDuration;
      }

      periods.push({ start: startVal, end: endVal, fbtype });
    }
  }

  return periods;
}

// ---------------------------------------------------------------------------
// Date utilities
// ---------------------------------------------------------------------------

/**
 * Parse an iCalendar date/datetime string to milliseconds since epoch.
 */
function parseICalDateToMs(value: string): number | null {
  const isUTC = value.endsWith("Z");
  const clean = value.replace("Z", "");

  if (/^\d{8}$/.test(clean)) {
    // Date only
    const y = parseInt(clean.slice(0, 4), 10);
    const m = parseInt(clean.slice(4, 6), 10) - 1;
    const d = parseInt(clean.slice(6, 8), 10);
    return Date.UTC(y, m, d);
  }

  if (/^\d{8}T\d{6}$/.test(clean)) {
    // DateTime
    const y = parseInt(clean.slice(0, 4), 10);
    const m = parseInt(clean.slice(4, 6), 10) - 1;
    const d = parseInt(clean.slice(6, 8), 10);
    const hr = parseInt(clean.slice(9, 11), 10);
    const mi = parseInt(clean.slice(11, 13), 10);
    const se = parseInt(clean.slice(13, 15), 10);
    return Date.UTC(y, m, d, hr, mi, se);
  }

  return null;
}

/**
 * Format a Date object to iCalendar datetime (YYYYMMDDTHHMMSSZ).
 */
function formatDateToICal(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  const hr = String(date.getUTCHours()).padStart(2, "0");
  const mi = String(date.getUTCMinutes()).padStart(2, "0");
  const se = String(date.getUTCSeconds()).padStart(2, "0");
  return `${y}${m}${d}T${hr}${mi}${se}Z`;
}

/**
 * Format an iCalendar date value to ISO date string (YYYY-MM-DD).
 */
function icalToIsoDate(value: string): string {
  const clean = value.replace("Z", "").replace(/T.*$/, "");
  if (/^\d{8}$/.test(clean)) {
    return `${clean.slice(0, 4)}-${clean.slice(4, 6)}-${clean.slice(6, 8)}`;
  }
  return clean;
}

/**
 * Format an iCalendar datetime value to ISO datetime string.
 */
function icalToIsoDateTime(value: string): string {
  const isUTC = value.endsWith("Z");
  const clean = value.replace("Z", "");

  if (/^\d{8}T\d{6}$/.test(clean)) {
    const y = clean.slice(0, 4);
    const m = clean.slice(4, 6);
    const d = clean.slice(6, 8);
    const hr = clean.slice(9, 11);
    const mi = clean.slice(11, 13);
    const se = clean.slice(13, 15);
    return `${y}-${m}-${d}T${hr}:${mi}:${se}${isUTC ? "Z" : ""}`;
  }

  return value;
}

// ---------------------------------------------------------------------------
// VEVENT -> ExtendedFeedEvent mapping
// ---------------------------------------------------------------------------

function normalizeStatus(status: string | undefined): "confirmed" | "tentative" | "cancelled" {
  if (!status) return "confirmed";
  const upper = status.toUpperCase();
  if (upper === "TENTATIVE") return "tentative";
  if (upper === "CANCELLED") return "cancelled";
  return "confirmed";
}

function normalizeVisibility(cls: string | undefined): "default" | "public" | "private" | "confidential" {
  if (!cls) return "default";
  const upper = cls.toUpperCase();
  if (upper === "PUBLIC") return "public";
  if (upper === "PRIVATE") return "private";
  if (upper === "CONFIDENTIAL") return "confidential";
  return "default";
}

function normalizeTransparency(transp: string | undefined): "opaque" | "transparent" {
  if (!transp) return "opaque";
  if (transp.toUpperCase() === "TRANSPARENT") return "transparent";
  return "opaque";
}

/**
 * Map a parsed VEVENT component to an ExtendedFeedEvent.
 */
function mapVEventToFeedEvent(
  component: ParsedComponent,
  accountId: string,
): ExtendedFeedEvent | null {
  const props = component.properties;
  const multiProps = component.multiProperties;

  const uid = props["UID"]?.value;
  if (!uid) return null; // Skip events without UID

  const dtstart = props["DTSTART"]?.value;
  if (!dtstart) return null; // Skip events without DTSTART

  const dtstartParams = props["DTSTART"]?.params;
  const isAllDay = dtstartParams?.["VALUE"] === "DATE" || /^\d{8}$/.test(dtstart);

  // Compute start
  const start = icalDateTimeToEventDateTime(dtstart, dtstartParams);

  // Compute end: DTEND > DURATION > default
  let end: EventDateTime;
  if (props["DTEND"]) {
    end = icalDateTimeToEventDateTime(props["DTEND"].value, props["DTEND"].params);
  } else if (props["DURATION"]) {
    end = computeEndFromDuration(dtstart, dtstartParams, props["DURATION"].value);
  } else {
    end = computeDefaultEnd(dtstart, dtstartParams);
  }

  // Extract attendees and organizer
  const attendees = parseAttendees(multiProps);
  const organizer = parseOrganizer(props);

  // Collect X-properties
  const xProperties = collectXProperties(props);

  // Extract meeting URL
  const meetingUrl = extractMeetingUrl(xProperties, props["LOCATION"]?.value);

  // Extract EXDATE
  const exdates = extractExdates(multiProps);

  const event: ExtendedFeedEvent = {
    origin_event_id: uid,
    origin_account_id: accountId,
    title: props["SUMMARY"] ? unescapeText(props["SUMMARY"].value) : undefined,
    description: props["DESCRIPTION"] ? unescapeText(props["DESCRIPTION"].value) : undefined,
    location: props["LOCATION"] ? unescapeText(props["LOCATION"].value) : undefined,
    start,
    end,
    all_day: isAllDay,
    status: normalizeStatus(props["STATUS"]?.value),
    visibility: normalizeVisibility(props["CLASS"]?.value),
    transparency: normalizeTransparency(props["TRANSP"]?.value),
    recurrence_rule: props["RRULE"]?.value,
    exdates: exdates.length > 0 ? exdates : undefined,
    source: "ics_feed",
    attendees: attendees.length > 0 ? attendees : undefined,
    organizer,
    meeting_url: meetingUrl,
    x_properties: xProperties,
  };

  return event;
}

// ---------------------------------------------------------------------------
// VTODO -> ParsedTodo mapping (also produces feed event with is_task)
// ---------------------------------------------------------------------------

function mapVTodo(component: ParsedComponent): ParsedTodo | null {
  const props = component.properties;
  const uid = props["UID"]?.value;
  if (!uid) return null;

  const priority = props["PRIORITY"]?.value;

  return {
    uid,
    summary: props["SUMMARY"] ? unescapeText(props["SUMMARY"].value) : undefined,
    description: props["DESCRIPTION"] ? unescapeText(props["DESCRIPTION"].value) : undefined,
    dtstart: props["DTSTART"]?.value,
    dtstartParams: props["DTSTART"]?.params,
    due: props["DUE"]?.value,
    dueParams: props["DUE"]?.params,
    status: props["STATUS"]?.value,
    priority: priority !== undefined ? parseInt(priority, 10) : undefined,
  };
}

/**
 * Convert a VTODO to an ExtendedFeedEvent (task-flavored).
 */
function mapVTodoToFeedEvent(
  todo: ParsedTodo,
  accountId: string,
): ExtendedFeedEvent | null {
  if (!todo.dtstart && !todo.due) return null;

  const startValue = todo.dtstart || todo.due!;
  const startParams = todo.dtstart ? todo.dtstartParams : todo.dueParams;
  const start = icalDateTimeToEventDateTime(startValue, startParams);

  let end: EventDateTime;
  if (todo.due && todo.due !== todo.dtstart) {
    end = icalDateTimeToEventDateTime(todo.due, todo.dueParams);
  } else {
    end = start;
  }

  const isAllDay = startParams?.["VALUE"] === "DATE" || /^\d{8}$/.test(startValue);

  return {
    origin_event_id: todo.uid,
    origin_account_id: accountId,
    title: todo.summary,
    description: todo.description,
    start,
    end,
    all_day: isAllDay,
    status: "confirmed",
    visibility: "default",
    transparency: "opaque",
    source: "ics_feed",
    is_task: true,
  };
}

// ---------------------------------------------------------------------------
// VFREEBUSY mapping
// ---------------------------------------------------------------------------

function mapVFreeBusy(component: ParsedComponent): ParsedFreeBusy | null {
  const props = component.properties;
  const multiProps = component.multiProperties;
  const uid = props["UID"]?.value;
  if (!uid) return null;

  const periods = parseFreeBusyPeriods(multiProps);

  return {
    uid,
    dtstart: props["DTSTART"]?.value,
    dtend: props["DTEND"]?.value,
    organizer: props["ORGANIZER"]?.value,
    periods,
  };
}

/**
 * Convert VFREEBUSY BUSY periods to ExtendedFeedEvent busy overlays (AD-4).
 */
function mapFreeBusyToFeedEvents(
  fb: ParsedFreeBusy,
  accountId: string,
): ExtendedFeedEvent[] {
  const events: ExtendedFeedEvent[] = [];

  for (let i = 0; i < fb.periods.length; i++) {
    const period = fb.periods[i];
    // Only create busy events for BUSY and BUSY-UNAVAILABLE
    if (period.fbtype !== "BUSY" && period.fbtype !== "BUSY-UNAVAILABLE") {
      continue;
    }

    const startDt = icalDateTimeToEventDateTime(period.start);
    const endDt = icalDateTimeToEventDateTime(period.end);

    events.push({
      origin_event_id: `${fb.uid}-fb-${i}`,
      origin_account_id: accountId,
      title: "Busy",
      start: startDt,
      end: endDt,
      all_day: false,
      status: "confirmed",
      visibility: "default",
      transparency: "opaque",
      source: "ics_feed",
    });
  }

  return events;
}

// ---------------------------------------------------------------------------
// VTIMEZONE mapping
// ---------------------------------------------------------------------------

function mapVTimezone(component: ParsedComponent): ParsedTimezone | null {
  const props = component.properties;
  const tzid = props["TZID"]?.value;
  if (!tzid) return null;

  const tzComponents: TimezoneComponent[] = [];
  for (const sub of component.subComponents) {
    if (sub.type === "STANDARD" || sub.type === "DAYLIGHT") {
      tzComponents.push({
        type: sub.type as "STANDARD" | "DAYLIGHT",
        dtstart: sub.properties["DTSTART"]?.value,
        tzoffsetfrom: sub.properties["TZOFFSETFROM"]?.value,
        tzoffsetto: sub.properties["TZOFFSETTO"]?.value,
        tzname: sub.properties["TZNAME"]?.value,
        rrule: sub.properties["RRULE"]?.value,
      });
    }
  }

  return { tzid, components: tzComponents };
}

// ---------------------------------------------------------------------------
// RRULE expansion engine
// ---------------------------------------------------------------------------

/** Parsed RRULE parts. */
interface RRuleParts {
  freq: string;
  interval: number;
  count?: number;
  until?: number; // ms since epoch
  byday?: string[];
  bymonthday?: number[];
  bymonth?: number[];
}

/**
 * Parse an RRULE string into structured parts.
 */
function parseRRule(rrule: string): RRuleParts | null {
  const parts: Record<string, string> = {};
  for (const segment of rrule.split(";")) {
    const eqIdx = segment.indexOf("=");
    if (eqIdx === -1) continue;
    parts[segment.substring(0, eqIdx).toUpperCase()] = segment.substring(eqIdx + 1);
  }

  const freq = parts["FREQ"];
  if (!freq) return null;

  return {
    freq: freq.toUpperCase(),
    interval: parts["INTERVAL"] ? parseInt(parts["INTERVAL"], 10) : 1,
    count: parts["COUNT"] ? parseInt(parts["COUNT"], 10) : undefined,
    until: parts["UNTIL"] ? (parseICalDateToMs(parts["UNTIL"]) ?? undefined) : undefined,
    byday: parts["BYDAY"] ? parts["BYDAY"].split(",") : undefined,
    bymonthday: parts["BYMONTHDAY"]
      ? parts["BYMONTHDAY"].split(",").map((d) => parseInt(d, 10))
      : undefined,
    bymonth: parts["BYMONTH"]
      ? parts["BYMONTH"].split(",").map((m) => parseInt(m, 10))
      : undefined,
  };
}

/** Day-of-week mapping for BYDAY. */
const DAY_MAP: Record<string, number> = {
  SU: 0,
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
};

/**
 * Expand a recurrence rule into individual instances.
 *
 * Supports:
 * - FREQ: DAILY, WEEKLY, MONTHLY, YEARLY
 * - INTERVAL: expansion interval
 * - COUNT: maximum number of instances
 * - UNTIL: end date for expansion
 * - BYDAY: day-of-week filter (for WEEKLY)
 * - BYMONTHDAY: day-of-month filter (for MONTHLY)
 * - EXDATE: excluded dates (via options.exdates)
 *
 * Expansion is windowed by options.windowEnd to avoid infinite expansion.
 * Safety limit of 1000 instances maximum.
 *
 * @param rrule - RRULE string (e.g., "FREQ=WEEKLY;BYDAY=MO;COUNT=5")
 * @param dtstart - iCalendar DTSTART value
 * @param dtend - iCalendar DTEND value
 * @param options - Expansion options: windowEnd, exdates
 * @returns Array of recurrence instances with start/end ISO strings
 */
export function expandRecurrence(
  rrule: string,
  dtstart: string,
  dtend: string,
  options: RecurrenceExpansionOptions,
): RecurrenceInstance[] {
  const parts = parseRRule(rrule);
  if (!parts) return [];

  const startMs = parseICalDateToMs(dtstart);
  if (startMs === null) return [];

  const endMs = parseICalDateToMs(dtend);
  const durationMs = endMs !== null ? endMs - startMs : 0;

  const isDate = /^\d{8}$/.test(dtstart.replace("Z", ""));

  // Parse window end
  const windowEndStr = options.windowEnd.replace(/-/g, "");
  const windowEndMs = parseICalDateToMs(
    windowEndStr.includes("T") ? windowEndStr : windowEndStr + "T000000Z",
  );
  if (windowEndMs === null) return [];

  // Parse exdates into a Set of ms values for fast lookup
  const exdateSet = new Set<number>();
  if (options.exdates) {
    for (const ex of options.exdates) {
      const ms = parseICalDateToMs(ex);
      if (ms !== null) exdateSet.add(ms);
    }
  }

  // Phase 1: Generate all RRULE instances up to COUNT/UNTIL/windowEnd.
  // Phase 2: Apply EXDATE exclusions.
  // Per RFC 5545, COUNT limits the number of RRULE-generated occurrences,
  // and EXDATE then removes from that set. So we first expand the rule
  // to get COUNT instances, then filter out EXDATE matches.
  const allInstances: { candidateMs: number }[] = [];
  const maxInstances = parts.count ?? 1000; // Safety limit
  let generated = 0;

  const startDate = new Date(startMs);

  for (let iteration = 0; iteration < 10000 && generated < maxInstances; iteration++) {
    // Compute candidate date based on frequency and iteration
    const candidate = new Date(startDate.getTime());

    switch (parts.freq) {
      case "DAILY":
        candidate.setUTCDate(candidate.getUTCDate() + iteration * parts.interval);
        break;

      case "WEEKLY": {
        // For WEEKLY with BYDAY, we step by weeks and check each BYDAY
        if (parts.byday && parts.byday.length > 0) {
          const weekOffset = Math.floor(iteration / parts.byday.length);
          const dayIdx = iteration % parts.byday.length;
          const targetDay = DAY_MAP[parts.byday[dayIdx]];
          if (targetDay === undefined) continue;

          // Start from base week
          const baseDate = new Date(startDate.getTime());
          baseDate.setUTCDate(baseDate.getUTCDate() + weekOffset * 7 * parts.interval);

          // Find the target day in this week
          const currentDay = baseDate.getUTCDay();
          const diff = targetDay - currentDay;
          baseDate.setUTCDate(baseDate.getUTCDate() + diff);

          candidate.setTime(baseDate.getTime());
        } else {
          candidate.setUTCDate(candidate.getUTCDate() + iteration * 7 * parts.interval);
        }
        break;
      }

      case "MONTHLY": {
        if (parts.bymonthday && parts.bymonthday.length > 0) {
          const monthOffset = Math.floor(iteration / parts.bymonthday.length);
          const dayIdx = iteration % parts.bymonthday.length;
          candidate.setUTCMonth(candidate.getUTCMonth() + monthOffset * parts.interval);
          candidate.setUTCDate(parts.bymonthday[dayIdx]);
        } else {
          candidate.setUTCMonth(candidate.getUTCMonth() + iteration * parts.interval);
        }
        break;
      }

      case "YEARLY":
        candidate.setUTCFullYear(candidate.getUTCFullYear() + iteration * parts.interval);
        break;

      default:
        return []; // Unknown frequency
    }

    const candidateMs = candidate.getTime();

    // Skip if before start
    if (candidateMs < startMs) continue;

    // Check UNTIL
    if (parts.until !== undefined && candidateMs > parts.until) break;

    // Check window end
    if (candidateMs >= windowEndMs) break;

    // Count this as a valid RRULE instance (before EXDATE filtering)
    allInstances.push({ candidateMs });
    generated++;
  }

  // Phase 2: Apply EXDATE exclusions and build final instances
  const instances: RecurrenceInstance[] = [];
  for (const { candidateMs } of allInstances) {
    // Check EXDATE
    if (exdateSet.has(candidateMs)) {
      continue; // Excluded by EXDATE
    }

    const candidate = new Date(candidateMs);
    const instanceEnd = new Date(candidateMs + durationMs);

    let instanceStartStr: string;
    let instanceEndStr: string;

    if (isDate) {
      instanceStartStr = icalToIsoDate(formatDateToICal(candidate).substring(0, 8));
      instanceEndStr = icalToIsoDate(formatDateToICal(instanceEnd).substring(0, 8));
    } else {
      instanceStartStr = icalToIsoDateTime(formatDateToICal(candidate));
      instanceEndStr = icalToIsoDateTime(formatDateToICal(instanceEnd));
    }

    instances.push({ start: instanceStartStr, end: instanceEndStr });
  }

  return instances;
}

// ---------------------------------------------------------------------------
// Main entry point: parseIcsFeed
// ---------------------------------------------------------------------------

/**
 * Parse a complete ICS feed into structured components and normalized events.
 *
 * This is the full-featured parser that handles:
 * - VEVENT: standard events (single, all-day, multi-day, recurring)
 * - VTODO: tasks (mapped to events with is_task flag)
 * - VFREEBUSY: free/busy blocks (mapped to busy overlay events per AD-4)
 * - VTIMEZONE: timezone definitions
 * - VALARM: skipped gracefully (nested inside VEVENT)
 * - Malformed input: partial parse, skip bad components, never crash
 *
 * @param icsText - Raw iCalendar text (VCALENDAR document)
 * @param accountId - The feed account ID to tag events with
 * @returns ParsedFeed with all components and normalized events
 */
export function parseIcsFeed(icsText: string, accountId: string): ParsedFeed {
  if (!icsText || !icsText.trim()) {
    return { events: [], todos: [], freeBusy: [], timezones: [] };
  }

  let components: ParsedComponent[];
  try {
    components = parseComponents(icsText);
  } catch {
    // If parsing completely fails, return empty feed
    return { events: [], todos: [], freeBusy: [], timezones: [] };
  }

  const events: ExtendedFeedEvent[] = [];
  const todos: ParsedTodo[] = [];
  const freeBusyList: ParsedFreeBusy[] = [];
  const timezones: ParsedTimezone[] = [];

  for (const component of components) {
    if (component.type === "VCALENDAR") {
      // Process children of VCALENDAR
      for (const child of component.subComponents) {
        processComponent(child, accountId, events, todos, freeBusyList, timezones);
      }
    } else {
      // Top-level component (unusual but handle it)
      processComponent(component, accountId, events, todos, freeBusyList, timezones);
    }
  }

  return {
    events,
    todos,
    freeBusy: freeBusyList,
    timezones,
  };
}

/**
 * Process a single component and add to the appropriate collection.
 */
function processComponent(
  component: ParsedComponent,
  accountId: string,
  events: ExtendedFeedEvent[],
  todos: ParsedTodo[],
  freeBusyList: ParsedFreeBusy[],
  timezones: ParsedTimezone[],
): void {
  try {
    switch (component.type) {
      case "VEVENT": {
        const event = mapVEventToFeedEvent(component, accountId);
        if (event) events.push(event);
        break;
      }

      case "VTODO": {
        const todo = mapVTodo(component);
        if (todo) {
          todos.push(todo);
          // Also create an event representation with task flag
          const todoEvent = mapVTodoToFeedEvent(todo, accountId);
          if (todoEvent) events.push(todoEvent);
        }
        break;
      }

      case "VFREEBUSY": {
        const fb = mapVFreeBusy(component);
        if (fb) {
          freeBusyList.push(fb);
          // Create busy overlay events
          const busyEvents = mapFreeBusyToFeedEvents(fb, accountId);
          events.push(...busyEvents);
        }
        break;
      }

      case "VTIMEZONE": {
        const tz = mapVTimezone(component);
        if (tz) timezones.push(tz);
        break;
      }

      // VALARM, VJOURNAL, etc. -- silently skip
      default:
        break;
    }
  } catch {
    // Graceful degradation: skip malformed components, continue with others
  }
}
