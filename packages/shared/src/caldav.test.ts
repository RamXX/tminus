/**
 * @tminus/shared -- Comprehensive tests for CalDAV (Apple Calendar) integration.
 *
 * Test coverage:
 * 1. iCalendar VEVENT parsing (10+ variants)
 * 2. iCalendar line unfolding and text unescaping
 * 3. ParsedVEvent -> CanonicalEvent normalization
 * 4. CalDAV XML request building
 * 5. CalDAV XML response parsing
 * 6. CalDAV event classification (loop prevention)
 * 7. ctag/etag change detection logic
 * 8. CalDAV client with mocked server (integration-style)
 * 9. Credential validation via PROPFIND
 * 10. Incremental sync detects new/modified/deleted events
 * 11. Write path (PUT/DELETE)
 * 12. Provider adapter dispatch
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AccountId } from "./types";
import type { FetchFn } from "./google-api";
import type { ParsedVEvent, CalDavCalendarSyncState } from "./caldav-types";

// iCalendar parser
import {
  parseVEvents,
  unfoldLines,
  unescapeText,
  parsePropertyLine,
  icalDateTimeToEventDateTime,
} from "./ical-parse";

// CalDAV normalization
import { normalizeCalDavEvent } from "./normalize-caldav";

// CalDAV classification
import { classifyCalDavEvent } from "./classify-caldav";

// CalDAV XML
import {
  buildPrincipalPropfind,
  buildCalendarHomePropfind,
  buildCalendarListPropfind,
  buildCalendarMultiget,
  buildCalendarQuery,
  buildEtagPropfind,
  parsePrincipalResponse,
  parseCalendarHomeResponse,
  parseCalendarListResponse,
  parseCalendarDataResponse,
  parseEtagResponse,
} from "./caldav-xml";

// CalDAV client
import {
  CalDavClient,
  CalDavAuthError,
  CalDavNotFoundError,
  CalDavConflictError,
  CalDavApiError,
} from "./caldav-client";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_ACCOUNT_ID = "acc_01HXY0000000000000000000AA" as AccountId;

// ---------------------------------------------------------------------------
// 1. iCalendar line unfolding
// ---------------------------------------------------------------------------

describe("unfoldLines", () => {
  it("removes CRLF + space continuation", () => {
    const input = "SUMMARY:This is a lo\r\n ng line";
    expect(unfoldLines(input)).toBe("SUMMARY:This is a long line");
  });

  it("removes CRLF + tab continuation", () => {
    const input = "SUMMARY:This is a lo\r\n\tng line";
    expect(unfoldLines(input)).toBe("SUMMARY:This is a long line");
  });

  it("handles LF-only line endings", () => {
    const input = "SUMMARY:This is a lo\n ng line";
    expect(unfoldLines(input)).toBe("SUMMARY:This is a long line");
  });

  it("handles multiple continuations", () => {
    const input = "DESC:A\r\n B\r\n C";
    expect(unfoldLines(input)).toBe("DESC:ABC");
  });

  it("leaves non-continued lines unchanged", () => {
    const input = "SUMMARY:Normal line\r\nDTSTART:20250615T090000Z";
    expect(unfoldLines(input)).toBe("SUMMARY:Normal line\nDTSTART:20250615T090000Z");
  });
});

// ---------------------------------------------------------------------------
// 2. iCalendar text unescaping
// ---------------------------------------------------------------------------

describe("unescapeText", () => {
  it("unescapes \\n to newline", () => {
    expect(unescapeText("Line 1\\nLine 2")).toBe("Line 1\nLine 2");
  });

  it("unescapes \\N to newline (case-insensitive)", () => {
    expect(unescapeText("Line 1\\NLine 2")).toBe("Line 1\nLine 2");
  });

  it("unescapes \\, to comma", () => {
    expect(unescapeText("A\\, B\\, C")).toBe("A, B, C");
  });

  it("unescapes \\; to semicolon", () => {
    expect(unescapeText("A\\; B")).toBe("A; B");
  });

  it("unescapes \\\\ to backslash", () => {
    expect(unescapeText("path\\\\to\\\\file")).toBe("path\\to\\file");
  });

  it("handles mixed escapes", () => {
    expect(unescapeText("Hello\\, World\\n\\;test")).toBe("Hello, World\n;test");
  });
});

// ---------------------------------------------------------------------------
// 3. Property line parsing
// ---------------------------------------------------------------------------

describe("parsePropertyLine", () => {
  it("parses simple property", () => {
    const result = parsePropertyLine("SUMMARY:Team standup");
    expect(result).toEqual({
      name: "SUMMARY",
      params: {},
      value: "Team standup",
    });
  });

  it("parses property with VALUE parameter", () => {
    const result = parsePropertyLine("DTSTART;VALUE=DATE:20250615");
    expect(result).toEqual({
      name: "DTSTART",
      params: { VALUE: "DATE" },
      value: "20250615",
    });
  });

  it("parses property with TZID parameter", () => {
    const result = parsePropertyLine(
      "DTSTART;TZID=America/Chicago:20250615T090000",
    );
    expect(result).toEqual({
      name: "DTSTART",
      params: { TZID: "America/Chicago" },
      value: "20250615T090000",
    });
  });

  it("parses property with multiple parameters", () => {
    const result = parsePropertyLine(
      "DTSTART;VALUE=DATE-TIME;TZID=America/Chicago:20250615T090000",
    );
    expect(result).toEqual({
      name: "DTSTART",
      params: { VALUE: "DATE-TIME", TZID: "America/Chicago" },
      value: "20250615T090000",
    });
  });

  it("handles value containing colons", () => {
    const result = parsePropertyLine("DESCRIPTION:Meeting at 9:00 AM");
    expect(result?.value).toBe("Meeting at 9:00 AM");
  });

  it("returns null for malformed lines", () => {
    expect(parsePropertyLine("MALFORMED")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. iCalendar datetime conversion
// ---------------------------------------------------------------------------

describe("icalDateTimeToEventDateTime", () => {
  it("converts all-day date (VALUE=DATE)", () => {
    const result = icalDateTimeToEventDateTime("20250615", { VALUE: "DATE" });
    expect(result).toEqual({ date: "2025-06-15" });
  });

  it("converts 8-digit date without params as all-day", () => {
    const result = icalDateTimeToEventDateTime("20250615");
    expect(result).toEqual({ date: "2025-06-15" });
  });

  it("converts UTC datetime", () => {
    const result = icalDateTimeToEventDateTime("20250615T090000Z");
    expect(result).toEqual({ dateTime: "2025-06-15T09:00:00Z" });
  });

  it("converts datetime with timezone", () => {
    const result = icalDateTimeToEventDateTime("20250615T090000", {
      TZID: "America/Chicago",
    });
    expect(result).toEqual({
      dateTime: "2025-06-15T09:00:00",
      timeZone: "America/Chicago",
    });
  });

  it("converts floating datetime (no timezone)", () => {
    const result = icalDateTimeToEventDateTime("20250615T140000");
    expect(result).toEqual({ dateTime: "2025-06-15T14:00:00" });
  });
});

// ---------------------------------------------------------------------------
// 5. VEVENT parsing (10+ variants)
// ---------------------------------------------------------------------------

describe("parseVEvents", () => {
  it("parses a basic VEVENT", () => {
    const ical = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:event-001@icloud.com",
      "SUMMARY:Team standup",
      "DTSTART:20250615T090000Z",
      "DTEND:20250615T093000Z",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const events = parseVEvents(ical);
    expect(events).toHaveLength(1);
    expect(events[0].uid).toBe("event-001@icloud.com");
    expect(events[0].summary).toBe("Team standup");
    expect(events[0].dtstart).toBe("20250615T090000Z");
    expect(events[0].dtend).toBe("20250615T093000Z");
  });

  it("parses an all-day event", () => {
    const ical = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:event-002@icloud.com",
      "SUMMARY:Birthday",
      "DTSTART;VALUE=DATE:20250615",
      "DTEND;VALUE=DATE:20250616",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const events = parseVEvents(ical);
    expect(events).toHaveLength(1);
    expect(events[0].dtstartParams?.VALUE).toBe("DATE");
    expect(events[0].dtstart).toBe("20250615");
    expect(events[0].dtend).toBe("20250616");
  });

  it("parses an event with timezone", () => {
    const ical = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:event-003@icloud.com",
      "SUMMARY:Chicago meeting",
      "DTSTART;TZID=America/Chicago:20250615T090000",
      "DTEND;TZID=America/Chicago:20250615T100000",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const events = parseVEvents(ical);
    expect(events[0].dtstartParams?.TZID).toBe("America/Chicago");
  });

  it("parses event with description and location", () => {
    const ical = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:event-004@icloud.com",
      "SUMMARY:Lunch",
      "DESCRIPTION:Lunch with team",
      "LOCATION:Cafe Bella",
      "DTSTART:20250615T120000Z",
      "DTEND:20250615T130000Z",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const events = parseVEvents(ical);
    expect(events[0].description).toBe("Lunch with team");
    expect(events[0].location).toBe("Cafe Bella");
  });

  it("parses event with escaped text", () => {
    const ical = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:event-005@icloud.com",
      "SUMMARY:Meet\\, Greet\\, Repeat",
      "DESCRIPTION:Line 1\\nLine 2",
      "DTSTART:20250615T090000Z",
      "DTEND:20250615T100000Z",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const events = parseVEvents(ical);
    expect(events[0].summary).toBe("Meet, Greet, Repeat");
    expect(events[0].description).toBe("Line 1\nLine 2");
  });

  it("parses event with STATUS and TRANSP", () => {
    const ical = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:event-006@icloud.com",
      "SUMMARY:Tentative block",
      "DTSTART:20250615T090000Z",
      "DTEND:20250615T100000Z",
      "STATUS:TENTATIVE",
      "TRANSP:TRANSPARENT",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const events = parseVEvents(ical);
    expect(events[0].status).toBe("TENTATIVE");
    expect(events[0].transp).toBe("TRANSPARENT");
  });

  it("parses event with RRULE", () => {
    const ical = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:event-007@icloud.com",
      "SUMMARY:Weekly standup",
      "DTSTART:20250615T090000Z",
      "DTEND:20250615T093000Z",
      "RRULE:FREQ=WEEKLY;BYDAY=MO",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const events = parseVEvents(ical);
    expect(events[0].rrule).toBe("FREQ=WEEKLY;BYDAY=MO");
  });

  it("parses CANCELLED event", () => {
    const ical = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:event-008@icloud.com",
      "SUMMARY:Cancelled meeting",
      "DTSTART:20250615T090000Z",
      "DTEND:20250615T100000Z",
      "STATUS:CANCELLED",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const events = parseVEvents(ical);
    expect(events[0].status).toBe("CANCELLED");
  });

  it("parses event with CLASS property", () => {
    const ical = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:event-009@icloud.com",
      "SUMMARY:Private event",
      "DTSTART:20250615T090000Z",
      "DTEND:20250615T100000Z",
      "CLASS:PRIVATE",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const events = parseVEvents(ical);
    expect(events[0].class).toBe("PRIVATE");
  });

  it("parses event with X-TMINUS-MANAGED marker", () => {
    const ical = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:event-010@icloud.com",
      "SUMMARY:Managed mirror",
      "DTSTART:20250615T090000Z",
      "DTEND:20250615T100000Z",
      "X-TMINUS-MANAGED:true",
      "X-TMINUS-CANONICAL-ID:evt_01HXYZ",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const events = parseVEvents(ical);
    expect(events[0].xTminusManaged).toBe("true");
    expect(events[0].xTminusCanonicalId).toBe("evt_01HXYZ");
  });

  it("parses multiple VEVENTs in one VCALENDAR", () => {
    const ical = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:multi-001@icloud.com",
      "SUMMARY:Event One",
      "DTSTART:20250615T090000Z",
      "DTEND:20250615T100000Z",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:multi-002@icloud.com",
      "SUMMARY:Event Two",
      "DTSTART:20250616T090000Z",
      "DTEND:20250616T100000Z",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const events = parseVEvents(ical);
    expect(events).toHaveLength(2);
    expect(events[0].uid).toBe("multi-001@icloud.com");
    expect(events[1].uid).toBe("multi-002@icloud.com");
  });

  it("handles folded lines correctly", () => {
    const ical = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:event-fold@icloud.com",
      "SUMMARY:A very long event title that gets folded because it excee",
      " ds the 75 octet line limit in iCalendar",
      "DTSTART:20250615T090000Z",
      "DTEND:20250615T100000Z",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const events = parseVEvents(ical);
    expect(events[0].summary).toBe(
      "A very long event title that gets folded because it exceeds the 75 octet line limit in iCalendar",
    );
  });
});

// ---------------------------------------------------------------------------
// 6. CalDAV event normalization
// ---------------------------------------------------------------------------

describe("normalizeCalDavEvent", () => {
  it("normalizes a basic event to ProviderDelta", () => {
    const vevent: ParsedVEvent = {
      uid: "test-uid-001@icloud.com",
      summary: "Team standup",
      dtstart: "20250615T090000Z",
      dtend: "20250615T093000Z",
    };

    const delta = normalizeCalDavEvent(vevent, TEST_ACCOUNT_ID, "origin");

    expect(delta.type).toBe("updated");
    expect(delta.origin_event_id).toBe("test-uid-001@icloud.com");
    expect(delta.origin_account_id).toBe(TEST_ACCOUNT_ID);
    expect(delta.event).toBeDefined();
    expect(delta.event!.title).toBe("Team standup");
    expect(delta.event!.start).toEqual({ dateTime: "2025-06-15T09:00:00Z" });
    expect(delta.event!.end).toEqual({ dateTime: "2025-06-15T09:30:00Z" });
    expect(delta.event!.all_day).toBe(false);
    expect(delta.event!.status).toBe("confirmed");
    expect(delta.event!.visibility).toBe("default");
    expect(delta.event!.transparency).toBe("opaque");
  });

  it("normalizes an all-day event", () => {
    const vevent: ParsedVEvent = {
      uid: "allday-001@icloud.com",
      summary: "Birthday",
      dtstart: "20250615",
      dtstartParams: { VALUE: "DATE" },
      dtend: "20250616",
      dtendParams: { VALUE: "DATE" },
    };

    const delta = normalizeCalDavEvent(vevent, TEST_ACCOUNT_ID, "origin");

    expect(delta.event!.all_day).toBe(true);
    expect(delta.event!.start).toEqual({ date: "2025-06-15" });
    expect(delta.event!.end).toEqual({ date: "2025-06-16" });
  });

  it("normalizes event with timezone", () => {
    const vevent: ParsedVEvent = {
      uid: "tz-001@icloud.com",
      summary: "Chicago meeting",
      dtstart: "20250615T090000",
      dtstartParams: { TZID: "America/Chicago" },
      dtend: "20250615T100000",
      dtendParams: { TZID: "America/Chicago" },
    };

    const delta = normalizeCalDavEvent(vevent, TEST_ACCOUNT_ID, "origin");

    expect(delta.event!.start).toEqual({
      dateTime: "2025-06-15T09:00:00",
      timeZone: "America/Chicago",
    });
    expect(delta.event!.end).toEqual({
      dateTime: "2025-06-15T10:00:00",
      timeZone: "America/Chicago",
    });
  });

  it("normalizes CANCELLED event as deleted", () => {
    const vevent: ParsedVEvent = {
      uid: "cancel-001@icloud.com",
      summary: "Cancelled",
      dtstart: "20250615T090000Z",
      status: "CANCELLED",
    };

    const delta = normalizeCalDavEvent(vevent, TEST_ACCOUNT_ID, "origin");

    expect(delta.type).toBe("deleted");
    expect(delta.event).toBeUndefined();
  });

  it("normalizes managed_mirror with no event payload", () => {
    const vevent: ParsedVEvent = {
      uid: "mirror-001@icloud.com",
      summary: "Managed mirror",
      dtstart: "20250615T090000Z",
      xTminusManaged: "true",
    };

    const delta = normalizeCalDavEvent(vevent, TEST_ACCOUNT_ID, "managed_mirror");

    expect(delta.type).toBe("updated");
    expect(delta.event).toBeUndefined(); // Invariant E
  });

  it("normalizes TENTATIVE status", () => {
    const vevent: ParsedVEvent = {
      uid: "tent-001@icloud.com",
      summary: "Maybe",
      dtstart: "20250615T090000Z",
      status: "TENTATIVE",
    };

    const delta = normalizeCalDavEvent(vevent, TEST_ACCOUNT_ID, "origin");
    expect(delta.event!.status).toBe("tentative");
  });

  it("normalizes TRANSPARENT transparency", () => {
    const vevent: ParsedVEvent = {
      uid: "transp-001@icloud.com",
      summary: "Free time",
      dtstart: "20250615T090000Z",
      transp: "TRANSPARENT",
    };

    const delta = normalizeCalDavEvent(vevent, TEST_ACCOUNT_ID, "origin");
    expect(delta.event!.transparency).toBe("transparent");
  });

  it("normalizes PRIVATE class to private visibility", () => {
    const vevent: ParsedVEvent = {
      uid: "priv-001@icloud.com",
      summary: "Secret",
      dtstart: "20250615T090000Z",
      class: "PRIVATE",
    };

    const delta = normalizeCalDavEvent(vevent, TEST_ACCOUNT_ID, "origin");
    expect(delta.event!.visibility).toBe("private");
  });

  it("normalizes CONFIDENTIAL class", () => {
    const vevent: ParsedVEvent = {
      uid: "conf-001@icloud.com",
      summary: "Top secret",
      dtstart: "20250615T090000Z",
      class: "CONFIDENTIAL",
    };

    const delta = normalizeCalDavEvent(vevent, TEST_ACCOUNT_ID, "origin");
    expect(delta.event!.visibility).toBe("confidential");
  });

  it("preserves RRULE", () => {
    const vevent: ParsedVEvent = {
      uid: "rrule-001@icloud.com",
      summary: "Weekly",
      dtstart: "20250615T090000Z",
      rrule: "FREQ=WEEKLY;BYDAY=MO",
    };

    const delta = normalizeCalDavEvent(vevent, TEST_ACCOUNT_ID, "origin");
    expect(delta.event!.recurrence_rule).toBe("FREQ=WEEKLY;BYDAY=MO");
  });

  it("preserves description and location", () => {
    const vevent: ParsedVEvent = {
      uid: "desc-001@icloud.com",
      summary: "Lunch",
      description: "Team lunch at noon",
      location: "Cafe Bella, 123 Main St",
      dtstart: "20250615T120000Z",
      dtend: "20250615T130000Z",
    };

    const delta = normalizeCalDavEvent(vevent, TEST_ACCOUNT_ID, "origin");
    expect(delta.event!.description).toBe("Team lunch at noon");
    expect(delta.event!.location).toBe("Cafe Bella, 123 Main St");
  });
});

// ---------------------------------------------------------------------------
// 7. CalDAV event classification
// ---------------------------------------------------------------------------

describe("classifyCalDavEvent", () => {
  it("classifies event without X-TMINUS-MANAGED as origin", () => {
    const vevent: ParsedVEvent = {
      uid: "origin-001@icloud.com",
      summary: "Normal event",
      dtstart: "20250615T090000Z",
    };

    expect(classifyCalDavEvent(vevent)).toBe("origin");
  });

  it("classifies event with X-TMINUS-MANAGED=true as managed_mirror", () => {
    const vevent: ParsedVEvent = {
      uid: "mirror-001@icloud.com",
      summary: "Mirror event",
      dtstart: "20250615T090000Z",
      xTminusManaged: "true",
    };

    expect(classifyCalDavEvent(vevent)).toBe("managed_mirror");
  });

  it("classifies event with X-TMINUS-MANAGED=false as origin", () => {
    const vevent: ParsedVEvent = {
      uid: "other-001@icloud.com",
      summary: "Other event",
      dtstart: "20250615T090000Z",
      xTminusManaged: "false",
    };

    expect(classifyCalDavEvent(vevent)).toBe("origin");
  });

  it("classifies event with undefined xTminusManaged as origin", () => {
    const vevent: ParsedVEvent = {
      uid: "undef-001@icloud.com",
      summary: "No marker",
      dtstart: "20250615T090000Z",
    };

    expect(classifyCalDavEvent(vevent)).toBe("origin");
  });
});

// ---------------------------------------------------------------------------
// 8. CalDAV XML request building
// ---------------------------------------------------------------------------

describe("CalDAV XML builders", () => {
  it("builds principal PROPFIND XML", () => {
    const xml = buildPrincipalPropfind();
    expect(xml).toContain("propfind");
    expect(xml).toContain("current-user-principal");
  });

  it("builds calendar home PROPFIND XML", () => {
    const xml = buildCalendarHomePropfind();
    expect(xml).toContain("propfind");
    expect(xml).toContain("calendar-home-set");
  });

  it("builds calendar list PROPFIND XML", () => {
    const xml = buildCalendarListPropfind();
    expect(xml).toContain("displayname");
    expect(xml).toContain("resourcetype");
    expect(xml).toContain("getctag");
    expect(xml).toContain("calendar-color");
  });

  it("builds calendar-multiget REPORT XML", () => {
    const xml = buildCalendarMultiget([
      "/cal/event1.ics",
      "/cal/event2.ics",
    ]);
    expect(xml).toContain("calendar-multiget");
    expect(xml).toContain("/cal/event1.ics");
    expect(xml).toContain("/cal/event2.ics");
    expect(xml).toContain("getetag");
    expect(xml).toContain("calendar-data");
  });

  it("builds calendar-query REPORT XML", () => {
    const xml = buildCalendarQuery();
    expect(xml).toContain("calendar-query");
    expect(xml).toContain("comp-filter");
    expect(xml).toContain("VCALENDAR");
    expect(xml).toContain("VEVENT");
  });

  it("builds etag PROPFIND XML", () => {
    const xml = buildEtagPropfind();
    expect(xml).toContain("propfind");
    expect(xml).toContain("getetag");
  });

  it("escapes special XML characters in hrefs", () => {
    const xml = buildCalendarMultiget(["/cal/<special>&event.ics"]);
    expect(xml).toContain("&lt;special&gt;&amp;event.ics");
  });
});

// ---------------------------------------------------------------------------
// 9. CalDAV XML response parsing
// ---------------------------------------------------------------------------

describe("CalDAV XML parsers", () => {
  it("parses principal response", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/</d:href>
    <d:propstat>
      <d:prop>
        <d:current-user-principal>
          <d:href>/12345/principal/</d:href>
        </d:current-user-principal>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;

    expect(parsePrincipalResponse(xml)).toBe("/12345/principal/");
  });

  it("parses calendar home response", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/12345/principal/</d:href>
    <d:propstat>
      <d:prop>
        <c:calendar-home-set>
          <d:href>/12345/calendars/</d:href>
        </c:calendar-home-set>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;

    expect(parseCalendarHomeResponse(xml)).toBe("/12345/calendars/");
  });

  it("parses calendar list response", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:a="http://apple.com/ns/ical/">
  <d:response>
    <d:href>/12345/calendars/personal/</d:href>
    <d:propstat>
      <d:prop>
        <d:displayname>Personal</d:displayname>
        <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
        <cs:getctag>ctag-abc123</cs:getctag>
        <a:calendar-color>#FF0000</a:calendar-color>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/12345/calendars/work/</d:href>
    <d:propstat>
      <d:prop>
        <d:displayname>Work</d:displayname>
        <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
        <cs:getctag>ctag-def456</cs:getctag>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;

    const calendars = parseCalendarListResponse(xml);
    expect(calendars).toHaveLength(2);
    expect(calendars[0].href).toBe("/12345/calendars/personal/");
    expect(calendars[0].displayName).toBe("Personal");
    expect(calendars[0].ctag).toBe("ctag-abc123");
    expect(calendars[0].color).toBe("#FF0000");
    expect(calendars[1].href).toBe("/12345/calendars/work/");
    expect(calendars[1].displayName).toBe("Work");
    expect(calendars[1].ctag).toBe("ctag-def456");
  });

  it("parses calendar data response", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/12345/calendars/personal/event1.ics</d:href>
    <d:propstat>
      <d:prop>
        <d:getetag>"etag-event1"</d:getetag>
        <c:calendar-data>BEGIN:VCALENDAR
BEGIN:VEVENT
UID:event1@icloud.com
SUMMARY:Test Event
DTSTART:20250615T090000Z
DTEND:20250615T100000Z
END:VEVENT
END:VCALENDAR</c:calendar-data>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;

    const events = parseCalendarDataResponse(xml);
    expect(events).toHaveLength(1);
    expect(events[0].href).toBe("/12345/calendars/personal/event1.ics");
    expect(events[0].etag).toBe("etag-event1");
    expect(events[0].icalData).toContain("BEGIN:VEVENT");
    expect(events[0].icalData).toContain("UID:event1@icloud.com");
  });

  it("parses etag response", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/cal/event1.ics</d:href>
    <d:propstat>
      <d:prop><d:getetag>"etag-aaa"</d:getetag></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/cal/event2.ics</d:href>
    <d:propstat>
      <d:prop><d:getetag>"etag-bbb"</d:getetag></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;

    const etags = parseEtagResponse(xml);
    expect(etags["/cal/event1.ics"]).toBe("etag-aaa");
    expect(etags["/cal/event2.ics"]).toBe("etag-bbb");
  });
});

// ---------------------------------------------------------------------------
// 10. CalDAV client (mocked server)
// ---------------------------------------------------------------------------

describe("CalDavClient", () => {
  function createMockFetch(
    responses: Array<{
      status: number;
      body: string;
      headers?: Record<string, string>;
    }>,
  ): FetchFn {
    let callIndex = 0;
    return vi.fn(async () => {
      const resp = responses[callIndex] ?? { status: 200, body: "" };
      callIndex++;
      // 204 No Content must not have a body per HTTP spec
      const responseBody = resp.status === 204 ? null : resp.body;
      return new Response(responseBody, {
        status: resp.status,
        headers: {
          "Content-Type": "application/xml",
          ...(resp.headers ?? {}),
        },
      });
    }) as unknown as FetchFn;
  }

  const defaultConfig = {
    appleId: "test@icloud.com",
    appSpecificPassword: "xxxx-xxxx-xxxx-xxxx",
    serverUrl: "https://caldav.icloud.com",
  };

  describe("validateCredentials", () => {
    it("returns true when PROPFIND succeeds", async () => {
      const mockFetch = createMockFetch([
        {
          status: 207,
          body: `<d:multistatus xmlns:d="DAV:">
            <d:response>
              <d:href>/</d:href>
              <d:propstat>
                <d:prop>
                  <d:current-user-principal>
                    <d:href>/12345/principal/</d:href>
                  </d:current-user-principal>
                </d:prop>
              </d:propstat>
            </d:response>
          </d:multistatus>`,
        },
      ]);

      const client = new CalDavClient(defaultConfig, mockFetch);
      const result = await client.validateCredentials();
      expect(result).toBe(true);
    });

    it("returns false when PROPFIND returns 401", async () => {
      const mockFetch = createMockFetch([{ status: 401, body: "Unauthorized" }]);

      const client = new CalDavClient(defaultConfig, mockFetch);
      const result = await client.validateCredentials();
      expect(result).toBe(false);
    });
  });

  describe("discoverCalendars", () => {
    it("discovers calendars via PROPFIND chain", async () => {
      const mockFetch = createMockFetch([
        // Step 1: Discover principal
        {
          status: 207,
          body: `<d:multistatus xmlns:d="DAV:">
            <d:response><d:href>/</d:href><d:propstat><d:prop>
              <d:current-user-principal><d:href>/p/</d:href></d:current-user-principal>
            </d:prop></d:propstat></d:response>
          </d:multistatus>`,
        },
        // Step 2: Discover calendar home
        {
          status: 207,
          body: `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
            <d:response><d:href>/p/</d:href><d:propstat><d:prop>
              <c:calendar-home-set><d:href>/c/</d:href></c:calendar-home-set>
            </d:prop></d:propstat></d:response>
          </d:multistatus>`,
        },
        // Step 3: List calendars
        {
          status: 207,
          body: `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/">
            <d:response><d:href>/c/cal1/</d:href><d:propstat><d:prop>
              <d:displayname>My Calendar</d:displayname>
              <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
              <cs:getctag>ctag-001</cs:getctag>
            </d:prop></d:propstat></d:response>
          </d:multistatus>`,
        },
      ]);

      const client = new CalDavClient(defaultConfig, mockFetch);
      const calendars = await client.discoverCalendars();
      expect(calendars).toHaveLength(1);
      expect(calendars[0].displayName).toBe("My Calendar");
      expect(calendars[0].ctag).toBe("ctag-001");
    });
  });

  describe("listCalendars (CalendarProvider interface)", () => {
    it("returns CalendarListEntry array", async () => {
      const mockFetch = createMockFetch([
        // Principal
        {
          status: 207,
          body: `<d:multistatus xmlns:d="DAV:"><d:response><d:href>/</d:href><d:propstat><d:prop>
            <d:current-user-principal><d:href>/p/</d:href></d:current-user-principal>
          </d:prop></d:propstat></d:response></d:multistatus>`,
        },
        // Calendar home
        {
          status: 207,
          body: `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/p/</d:href><d:propstat><d:prop>
            <c:calendar-home-set><d:href>/c/</d:href></c:calendar-home-set>
          </d:prop></d:propstat></d:response></d:multistatus>`,
        },
        // Calendar list
        {
          status: 207,
          body: `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/">
            <d:response><d:href>/c/personal/</d:href><d:propstat><d:prop>
              <d:displayname>Personal</d:displayname>
              <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
              <cs:getctag>ctag-123</cs:getctag>
            </d:prop></d:propstat></d:response>
          </d:multistatus>`,
        },
      ]);

      const client = new CalDavClient(defaultConfig, mockFetch);
      const entries = await client.listCalendars();
      expect(entries).toHaveLength(1);
      expect(entries[0].id).toBe("/c/personal/");
      expect(entries[0].summary).toBe("Personal");
      expect(entries[0].accessRole).toBe("owner");
    });
  });

  describe("error handling", () => {
    it("throws CalDavAuthError on 401", async () => {
      const mockFetch = createMockFetch([{ status: 401, body: "Unauthorized" }]);
      const client = new CalDavClient(defaultConfig, mockFetch);

      await expect(client.discoverPrincipal()).rejects.toThrow(CalDavAuthError);
    });

    it("throws CalDavNotFoundError on 404", async () => {
      const mockFetch = createMockFetch([{ status: 404, body: "Not Found" }]);
      const client = new CalDavClient(defaultConfig, mockFetch);

      await expect(client.discoverPrincipal()).rejects.toThrow(CalDavNotFoundError);
    });

    it("throws CalDavConflictError on 409", async () => {
      const mockFetch = createMockFetch([{ status: 409, body: "Conflict" }]);
      const client = new CalDavClient(defaultConfig, mockFetch);

      await expect(client.discoverPrincipal()).rejects.toThrow(CalDavConflictError);
    });

    it("throws CalDavApiError on other errors", async () => {
      const mockFetch = createMockFetch([{ status: 500, body: "Server Error" }]);
      const client = new CalDavClient(defaultConfig, mockFetch);

      await expect(client.discoverPrincipal()).rejects.toThrow(CalDavApiError);
    });
  });

  describe("authentication", () => {
    it("sends HTTP Basic Auth header", async () => {
      const mockFetch = vi.fn(async () =>
        new Response(
          `<d:multistatus xmlns:d="DAV:">
            <d:response><d:href>/</d:href><d:propstat><d:prop>
              <d:current-user-principal><d:href>/p/</d:href></d:current-user-principal>
            </d:prop></d:propstat></d:response>
          </d:multistatus>`,
          { status: 207, headers: { "Content-Type": "application/xml" } },
        ),
      ) as unknown as FetchFn;

      const client = new CalDavClient(defaultConfig, mockFetch);
      await client.discoverPrincipal();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const calledInit = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0][1];
      const headers = new Headers(calledInit.headers);
      const authHeader = headers.get("Authorization");
      expect(authHeader).toBeDefined();
      expect(authHeader!.startsWith("Basic ")).toBe(true);

      // Decode and verify credentials
      const decoded = atob(authHeader!.replace("Basic ", ""));
      expect(decoded).toBe("test@icloud.com:xxxx-xxxx-xxxx-xxxx");
    });
  });

  describe("write path", () => {
    it("putEvent creates event and returns etag", async () => {
      // Principal + calHome + list calendars for setup -- but putEvent is direct
      const mockFetch = createMockFetch([
        {
          status: 201,
          body: "",
          headers: { ETag: '"new-etag-123"' },
        },
      ]);

      const client = new CalDavClient(defaultConfig, mockFetch);
      const result = await client.putEvent(
        "/c/personal/",
        "test-uid@tminus.app",
        "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:test-uid@tminus.app\r\nSUMMARY:Test\r\nEND:VEVENT\r\nEND:VCALENDAR",
      );

      expect(result.ok).toBe(true);
      expect(result.etag).toBe("new-etag-123");
    });

    it("deleteEventCalDav removes event and returns result", async () => {
      // 204 No Content requires null body (not empty string)
      const mockFetch = vi.fn(async () =>
        new Response(null, {
          status: 204,
          headers: { "Content-Type": "application/xml" },
        }),
      ) as unknown as FetchFn;

      const client = new CalDavClient(defaultConfig, mockFetch);
      const result = await client.deleteEventCalDav("/c/personal/", "test-uid@tminus.app");

      expect(result.ok).toBe(true);
    });

    it("deleteEventCalDav returns error on API failure", async () => {
      const mockFetch = createMockFetch([{ status: 500, body: "Internal Server Error" }]);

      const client = new CalDavClient(defaultConfig, mockFetch);
      const result = await client.deleteEventCalDav("/c/personal/", "test-uid@tminus.app");

      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("deleteEvent (CalendarProvider interface) resolves on success", async () => {
      const mockFetch = vi.fn(async () =>
        new Response(null, {
          status: 204,
          headers: { "Content-Type": "application/xml" },
        }),
      ) as unknown as FetchFn;

      const client = new CalDavClient(defaultConfig, mockFetch);
      // Should not throw -- returns Promise<void>
      await client.deleteEvent("/c/personal/", "test-uid@tminus.app");
    });

    it("deleteEvent (CalendarProvider interface) throws on failure", async () => {
      const mockFetch = createMockFetch([{ status: 500, body: "Internal Server Error" }]);

      const client = new CalDavClient(defaultConfig, mockFetch);
      await expect(
        client.deleteEvent("/c/personal/", "test-uid@tminus.app"),
      ).rejects.toThrow(/Failed to delete event/);
    });

    it("putEvent returns error on conflict", async () => {
      const mockFetch = createMockFetch([{ status: 412, body: "Precondition Failed" }]);

      const client = new CalDavClient(defaultConfig, mockFetch);
      const result = await client.putEvent(
        "/c/personal/",
        "test-uid@tminus.app",
        "BEGIN:VCALENDAR\r\nEND:VCALENDAR",
        "old-etag",
      );

      expect(result.ok).toBe(false);
      expect(result.error).toContain("Conflict");
    });
  });

  describe("watchEvents", () => {
    it("throws not-supported error", async () => {
      const mockFetch = createMockFetch([]);
      const client = new CalDavClient(defaultConfig, mockFetch);

      await expect(
        client.watchEvents("/c/", "https://webhook.example.com", "ch1", "tok"),
      ).rejects.toThrow(/not supported/i);
    });
  });

  describe("insertCalendar", () => {
    it("throws not-supported error", async () => {
      const mockFetch = createMockFetch([]);
      const client = new CalDavClient(defaultConfig, mockFetch);

      await expect(
        client.insertCalendar("New Calendar"),
      ).rejects.toThrow(/not supported/i);
    });
  });
});

// ---------------------------------------------------------------------------
// 11. ctag/etag incremental sync
// ---------------------------------------------------------------------------

describe("CalDavClient.incrementalSync", () => {
  function makeSyncMockFetch(
    calCtag: string,
    eventEtags: Record<string, string>,
    eventData?: string,
  ): FetchFn {
    let callIndex = 0;
    return vi.fn(async () => {
      callIndex++;

      // Call 1: discoverPrincipal
      if (callIndex === 1) {
        return new Response(
          `<d:multistatus xmlns:d="DAV:"><d:response><d:href>/</d:href><d:propstat><d:prop>
            <d:current-user-principal><d:href>/p/</d:href></d:current-user-principal>
          </d:prop></d:propstat></d:response></d:multistatus>`,
          { status: 207 },
        );
      }

      // Call 2: discoverCalendarHome
      if (callIndex === 2) {
        return new Response(
          `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/p/</d:href><d:propstat><d:prop>
            <c:calendar-home-set><d:href>/c/</d:href></c:calendar-home-set>
          </d:prop></d:propstat></d:response></d:multistatus>`,
          { status: 207 },
        );
      }

      // Call 3: discoverCalendars (for ctag)
      if (callIndex === 3) {
        return new Response(
          `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/">
            <d:response><d:href>/c/cal/</d:href><d:propstat><d:prop>
              <d:displayname>Cal</d:displayname>
              <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
              <cs:getctag>${calCtag}</cs:getctag>
            </d:prop></d:propstat></d:response>
          </d:multistatus>`,
          { status: 207 },
        );
      }

      // Call 4: getEventEtags
      if (callIndex === 4) {
        const etagResponses = Object.entries(eventEtags)
          .map(
            ([href, etag]) => `<d:response>
              <d:href>${href}</d:href>
              <d:propstat><d:prop><d:getetag>"${etag}"</d:getetag></d:prop></d:propstat>
            </d:response>`,
          )
          .join("");
        return new Response(
          `<d:multistatus xmlns:d="DAV:">${etagResponses}</d:multistatus>`,
          { status: 207 },
        );
      }

      // Call 5: fetchEvents (calendar-multiget)
      if (callIndex === 5 && eventData) {
        return new Response(eventData, { status: 207 });
      }

      return new Response("", { status: 200 });
    }) as unknown as FetchFn;
  }

  it("detects no changes when ctag matches", async () => {
    const storedState: CalDavCalendarSyncState = {
      href: "/c/cal/",
      ctag: "ctag-same",
      etags: { "/c/cal/evt1.ics": "etag-1" },
    };

    const mockFetch = makeSyncMockFetch("ctag-same", {});
    const client = new CalDavClient(
      {
        appleId: "test@icloud.com",
        appSpecificPassword: "test",
        serverUrl: "https://caldav.icloud.com",
      },
      mockFetch,
    );

    const result = await client.incrementalSync("/c/cal/", storedState);
    expect(result.events).toHaveLength(0);
    expect(result.deleted).toHaveLength(0);
    expect(result.newState.ctag).toBe("ctag-same");
  });

  it("detects new events when ctag changes", async () => {
    const storedState: CalDavCalendarSyncState = {
      href: "/c/cal/",
      ctag: "ctag-old",
      etags: {},
    };

    const eventDataResponse = `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
      <d:response>
        <d:href>/c/cal/new-event.ics</d:href>
        <d:propstat><d:prop>
          <d:getetag>"etag-new"</d:getetag>
          <c:calendar-data>BEGIN:VCALENDAR
BEGIN:VEVENT
UID:new-event@icloud.com
SUMMARY:New Event
DTSTART:20250615T090000Z
DTEND:20250615T100000Z
END:VEVENT
END:VCALENDAR</c:calendar-data>
        </d:prop></d:propstat>
      </d:response>
    </d:multistatus>`;

    const mockFetch = makeSyncMockFetch(
      "ctag-new",
      { "/c/cal/new-event.ics": "etag-new" },
      eventDataResponse,
    );

    const client = new CalDavClient(
      {
        appleId: "test@icloud.com",
        appSpecificPassword: "test",
        serverUrl: "https://caldav.icloud.com",
      },
      mockFetch,
    );

    const result = await client.incrementalSync("/c/cal/", storedState);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].etag).toBe("etag-new");
    expect(result.deleted).toHaveLength(0);
    expect(result.newState.ctag).toBe("ctag-new");
  });

  it("detects deleted events when ctag changes", async () => {
    const storedState: CalDavCalendarSyncState = {
      href: "/c/cal/",
      ctag: "ctag-old",
      etags: {
        "/c/cal/existing.ics": "etag-exist",
        "/c/cal/deleted.ics": "etag-del",
      },
    };

    // Only existing.ics is in current etags -- deleted.ics is gone
    const mockFetch = makeSyncMockFetch("ctag-changed", {
      "/c/cal/existing.ics": "etag-exist",
    });

    const client = new CalDavClient(
      {
        appleId: "test@icloud.com",
        appSpecificPassword: "test",
        serverUrl: "https://caldav.icloud.com",
      },
      mockFetch,
    );

    const result = await client.incrementalSync("/c/cal/", storedState);
    expect(result.events).toHaveLength(0);
    expect(result.deleted).toHaveLength(1);
    expect(result.deleted[0]).toBe("/c/cal/deleted.ics");
  });

  it("detects modified events via etag change", async () => {
    const storedState: CalDavCalendarSyncState = {
      href: "/c/cal/",
      ctag: "ctag-old",
      etags: {
        "/c/cal/modified.ics": "etag-old",
      },
    };

    const eventDataResponse = `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
      <d:response>
        <d:href>/c/cal/modified.ics</d:href>
        <d:propstat><d:prop>
          <d:getetag>"etag-updated"</d:getetag>
          <c:calendar-data>BEGIN:VCALENDAR
BEGIN:VEVENT
UID:modified@icloud.com
SUMMARY:Updated Event
DTSTART:20250615T090000Z
DTEND:20250615T100000Z
END:VEVENT
END:VCALENDAR</c:calendar-data>
        </d:prop></d:propstat>
      </d:response>
    </d:multistatus>`;

    const mockFetch = makeSyncMockFetch(
      "ctag-new",
      { "/c/cal/modified.ics": "etag-updated" },
      eventDataResponse,
    );

    const client = new CalDavClient(
      {
        appleId: "test@icloud.com",
        appSpecificPassword: "test",
        serverUrl: "https://caldav.icloud.com",
      },
      mockFetch,
    );

    const result = await client.incrementalSync("/c/cal/", storedState);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].etag).toBe("etag-updated");
    expect(result.newState.etags["/c/cal/modified.ics"]).toBe("etag-updated");
  });

  it("handles full sync (no stored state)", async () => {
    const eventDataResponse = `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
      <d:response>
        <d:href>/c/cal/evt1.ics</d:href>
        <d:propstat><d:prop>
          <d:getetag>"etag-1"</d:getetag>
          <c:calendar-data>BEGIN:VCALENDAR
BEGIN:VEVENT
UID:evt1@icloud.com
SUMMARY:Event One
DTSTART:20250615T090000Z
DTEND:20250615T100000Z
END:VEVENT
END:VCALENDAR</c:calendar-data>
        </d:prop></d:propstat>
      </d:response>
    </d:multistatus>`;

    const mockFetch = makeSyncMockFetch(
      "ctag-init",
      { "/c/cal/evt1.ics": "etag-1" },
      eventDataResponse,
    );

    const client = new CalDavClient(
      {
        appleId: "test@icloud.com",
        appSpecificPassword: "test",
        serverUrl: "https://caldav.icloud.com",
      },
      mockFetch,
    );

    const result = await client.incrementalSync("/c/cal/", null);
    expect(result.events).toHaveLength(1);
    expect(result.deleted).toHaveLength(0);
    expect(result.newState.ctag).toBe("ctag-init");
    expect(result.newState.etags["/c/cal/evt1.ics"]).toBe("etag-1");
  });
});

// ---------------------------------------------------------------------------
// 12. AccountDO migration v5 (CalDAV sync state table)
// ---------------------------------------------------------------------------

describe("AccountDO Migration V5", () => {
  it("migration V5 SQL is exported", async () => {
    const { ACCOUNT_DO_MIGRATION_V5 } = await import("./schema");
    expect(ACCOUNT_DO_MIGRATION_V5).toBeDefined();
    expect(ACCOUNT_DO_MIGRATION_V5).toContain("caldav_calendar_state");
    expect(ACCOUNT_DO_MIGRATION_V5).toContain("calendar_href");
    expect(ACCOUNT_DO_MIGRATION_V5).toContain("ctag");
    expect(ACCOUNT_DO_MIGRATION_V5).toContain("etags_json");
  });

  it("AccountDO migrations include V5", async () => {
    const { ACCOUNT_DO_MIGRATIONS } = await import("./schema");
    expect(ACCOUNT_DO_MIGRATIONS.length).toBeGreaterThanOrEqual(5);
    const v5 = ACCOUNT_DO_MIGRATIONS.find((m) => m.version === 5);
    expect(v5).toBeDefined();
    expect(v5?.description).toContain("CalDAV");
  });
});
