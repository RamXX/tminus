/**
 * Unit tests for ICS feed URL validation and event normalization.
 *
 * Tests cover:
 * - URL validation: HTTPS required, various valid/invalid URLs
 * - ICS text parsing to CanonicalEvent-compatible format
 * - Multiple VEVENT handling
 * - All-day event handling
 * - Timezone-aware datetime handling
 */

import { describe, it, expect } from "vitest";
import {
  validateFeedUrl,
  normalizeIcsFeedEvents,
  type FeedValidationResult,
  type NormalizedFeedEvent,
} from "./ics-feed";

// ---------------------------------------------------------------------------
// Sample ICS data fixtures
// ---------------------------------------------------------------------------

const MINIMAL_ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
BEGIN:VEVENT
UID:event-001@example.com
DTSTART:20260301T090000Z
DTEND:20260301T100000Z
SUMMARY:Morning Standup
END:VEVENT
END:VCALENDAR`;

const MULTI_EVENT_ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
BEGIN:VEVENT
UID:event-001@example.com
DTSTART:20260301T090000Z
DTEND:20260301T100000Z
SUMMARY:Morning Standup
DESCRIPTION:Daily sync meeting
LOCATION:Zoom Room 1
STATUS:CONFIRMED
END:VEVENT
BEGIN:VEVENT
UID:event-002@example.com
DTSTART:20260302T140000Z
DTEND:20260302T150000Z
SUMMARY:1:1 with Manager
STATUS:TENTATIVE
TRANSP:OPAQUE
END:VEVENT
BEGIN:VEVENT
UID:event-003@example.com
DTSTART;VALUE=DATE:20260305
DTEND;VALUE=DATE:20260306
SUMMARY:Company Holiday
TRANSP:TRANSPARENT
END:VEVENT
END:VCALENDAR`;

const RECURRING_ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
BEGIN:VEVENT
UID:recurring-001@example.com
DTSTART;TZID=America/New_York:20260301T090000
DTEND;TZID=America/New_York:20260301T093000
SUMMARY:Weekly Team Sync
RRULE:FREQ=WEEKLY;BYDAY=MO
END:VEVENT
END:VCALENDAR`;

// ---------------------------------------------------------------------------
// URL validation tests
// ---------------------------------------------------------------------------

describe("validateFeedUrl", () => {
  it("accepts valid HTTPS URL", () => {
    const result = validateFeedUrl("https://calendar.google.com/calendar/ical/example/public/basic.ics");
    expect(result.valid).toBe(true);
    expect(result.url).toBe("https://calendar.google.com/calendar/ical/example/public/basic.ics");
  });

  it("accepts HTTPS URL without .ics extension", () => {
    const result = validateFeedUrl("https://example.com/calendar/feed");
    expect(result.valid).toBe(true);
  });

  it("rejects HTTP URL (HTTPS required)", () => {
    const result = validateFeedUrl("http://example.com/calendar.ics");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("HTTPS");
  });

  it("rejects empty string", () => {
    const result = validateFeedUrl("");
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("rejects non-URL string", () => {
    const result = validateFeedUrl("not a url");
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("rejects FTP protocol", () => {
    const result = validateFeedUrl("ftp://example.com/calendar.ics");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("HTTPS");
  });

  it("rejects data: URL", () => {
    const result = validateFeedUrl("data:text/calendar,BEGIN:VCALENDAR");
    expect(result.valid).toBe(false);
  });

  it("trims whitespace from URL", () => {
    const result = validateFeedUrl("  https://example.com/cal.ics  ");
    expect(result.valid).toBe(true);
    expect(result.url).toBe("https://example.com/cal.ics");
  });
});

// ---------------------------------------------------------------------------
// ICS normalization tests
// ---------------------------------------------------------------------------

describe("normalizeIcsFeedEvents", () => {
  it("parses a single VEVENT into normalized feed event", () => {
    const events = normalizeIcsFeedEvents(MINIMAL_ICS, "acc_test123");
    expect(events).toHaveLength(1);

    const evt = events[0];
    expect(evt.origin_event_id).toBe("event-001@example.com");
    expect(evt.origin_account_id).toBe("acc_test123");
    expect(evt.title).toBe("Morning Standup");
    expect(evt.start.dateTime).toBe("2026-03-01T09:00:00Z");
    expect(evt.end.dateTime).toBe("2026-03-01T10:00:00Z");
    expect(evt.all_day).toBe(false);
    expect(evt.status).toBe("confirmed");
    expect(evt.source).toBe("ics_feed");
  });

  it("parses multiple VEVENTs from a single ICS feed", () => {
    const events = normalizeIcsFeedEvents(MULTI_EVENT_ICS, "acc_feed1");
    expect(events).toHaveLength(3);

    // First event -- timed, confirmed
    expect(events[0].title).toBe("Morning Standup");
    expect(events[0].description).toBe("Daily sync meeting");
    expect(events[0].location).toBe("Zoom Room 1");
    expect(events[0].status).toBe("confirmed");

    // Second event -- timed, tentative
    expect(events[1].title).toBe("1:1 with Manager");
    expect(events[1].status).toBe("tentative");
    expect(events[1].transparency).toBe("opaque");

    // Third event -- all-day
    expect(events[2].title).toBe("Company Holiday");
    expect(events[2].all_day).toBe(true);
    expect(events[2].start.date).toBe("2026-03-05");
    expect(events[2].transparency).toBe("transparent");
  });

  it("handles recurring events with RRULE", () => {
    const events = normalizeIcsFeedEvents(RECURRING_ICS, "acc_feed2");
    expect(events).toHaveLength(1);

    const evt = events[0];
    expect(evt.title).toBe("Weekly Team Sync");
    expect(evt.recurrence_rule).toBe("FREQ=WEEKLY;BYDAY=MO");
    expect(evt.start.timeZone).toBe("America/New_York");
  });

  it("returns empty array for empty ICS text", () => {
    const events = normalizeIcsFeedEvents("", "acc_test");
    expect(events).toHaveLength(0);
  });

  it("returns empty array for ICS with no VEVENTs", () => {
    const ics = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
END:VCALENDAR`;
    const events = normalizeIcsFeedEvents(ics, "acc_test");
    expect(events).toHaveLength(0);
  });

  it("sets all events as read-only ics_feed source", () => {
    const events = normalizeIcsFeedEvents(MULTI_EVENT_ICS, "acc_feed1");
    for (const evt of events) {
      expect(evt.source).toBe("ics_feed");
    }
  });

  it("normalizes visibility from CLASS property", () => {
    const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:private-event@example.com
DTSTART:20260301T090000Z
DTEND:20260301T100000Z
SUMMARY:Private Meeting
CLASS:PRIVATE
END:VEVENT
END:VCALENDAR`;
    const events = normalizeIcsFeedEvents(ics, "acc_test");
    expect(events[0].visibility).toBe("private");
  });
});
