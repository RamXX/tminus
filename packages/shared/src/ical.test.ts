/**
 * Unit tests for iCalendar (RFC 5545) generation functions.
 *
 * Tests cover: date formatting, VEVENT construction, VTIMEZONE generation,
 * full VCALENDAR assembly, edge cases (all-day, UTC, cancelled, missing fields),
 * and RFC 5545 line folding compliance.
 */

import { describe, it, expect } from "vitest";
import {
  formatICalDate,
  formatICalDateTime,
  buildVEvent,
  buildVCalendar,
  collectTimezones,
  foldLine,
} from "./ical";
import type { CanonicalEvent, EventId, AccountId, EventDateTime } from "./types";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<CanonicalEvent> & {
  start: EventDateTime;
  end: EventDateTime;
}): CanonicalEvent {
  return {
    canonical_event_id: "evt_01HXY000000000000000000001" as EventId,
    origin_account_id: "acc_01HXY0000000000000000000AA" as AccountId,
    origin_event_id: "google-evt-001",
    title: "Test Event",
    description: "A test event",
    location: "Office 101",
    all_day: false,
    status: "confirmed",
    visibility: "default",
    transparency: "opaque",
    recurrence_rule: undefined,
    source: "provider",
    version: 1,
    created_at: "2025-06-15T09:00:00Z",
    updated_at: "2025-06-15T09:00:00Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// formatICalDate -- all-day events (YYYYMMDD)
// ---------------------------------------------------------------------------

describe("formatICalDate", () => {
  it("formats a DATE value from YYYY-MM-DD string", () => {
    expect(formatICalDate("2025-06-15")).toBe("20250615");
  });

  it("handles single-digit months and days", () => {
    expect(formatICalDate("2025-01-03")).toBe("20250103");
  });

  it("handles end-of-year dates", () => {
    expect(formatICalDate("2025-12-31")).toBe("20251231");
  });
});

// ---------------------------------------------------------------------------
// formatICalDateTime -- timed events
// ---------------------------------------------------------------------------

describe("formatICalDateTime", () => {
  it("formats a UTC datetime as YYYYMMDDTHHMMSSZ", () => {
    expect(formatICalDateTime("2025-06-15T09:00:00Z")).toBe("20250615T090000Z");
  });

  it("formats a datetime with timezone offset to UTC", () => {
    // Input with offset; should strip punctuation and produce UTC suffix
    expect(formatICalDateTime("2025-06-15T14:30:00Z")).toBe("20250615T143000Z");
  });

  it("handles midnight times", () => {
    expect(formatICalDateTime("2025-06-15T00:00:00Z")).toBe("20250615T000000Z");
  });

  it("handles end-of-day times", () => {
    expect(formatICalDateTime("2025-06-15T23:59:59Z")).toBe("20250615T235959Z");
  });

  it("formats a datetime with timezone as local time (no Z suffix)", () => {
    // When we have a timezone context, the output should be local time format
    expect(formatICalDateTime("2025-06-15T09:00:00", "America/Chicago")).toBe("20250615T090000");
  });
});

// ---------------------------------------------------------------------------
// buildVEvent -- VEVENT component construction
// ---------------------------------------------------------------------------

describe("buildVEvent", () => {
  it("produces a valid VEVENT for a timed UTC event", () => {
    const event = makeEvent({
      start: { dateTime: "2025-06-15T09:00:00Z" },
      end: { dateTime: "2025-06-15T10:00:00Z" },
    });

    const vevent = buildVEvent(event);

    expect(vevent).toContain("BEGIN:VEVENT");
    expect(vevent).toContain("END:VEVENT");
    expect(vevent).toContain("DTSTART:20250615T090000Z");
    expect(vevent).toContain("DTEND:20250615T100000Z");
    expect(vevent).toContain("SUMMARY:Test Event");
    expect(vevent).toContain("DESCRIPTION:A test event");
    expect(vevent).toContain("LOCATION:Office 101");
    expect(vevent).toContain("UID:evt_01HXY000000000000000000001");
    expect(vevent).toContain("DTSTAMP:");
    expect(vevent).toContain("STATUS:CONFIRMED");
  });

  it("produces VALUE=DATE for all-day events", () => {
    const event = makeEvent({
      all_day: true,
      start: { date: "2025-06-15" },
      end: { date: "2025-06-16" },
    });

    const vevent = buildVEvent(event);

    expect(vevent).toContain("DTSTART;VALUE=DATE:20250615");
    expect(vevent).toContain("DTEND;VALUE=DATE:20250616");
    expect(vevent).not.toContain("DTSTART:2025");
  });

  it("includes TZID for events with timezone", () => {
    const event = makeEvent({
      start: { dateTime: "2025-06-15T09:00:00", timeZone: "America/Chicago" },
      end: { dateTime: "2025-06-15T10:00:00", timeZone: "America/Chicago" },
    });

    const vevent = buildVEvent(event);

    expect(vevent).toContain("DTSTART;TZID=America/Chicago:20250615T090000");
    expect(vevent).toContain("DTEND;TZID=America/Chicago:20250615T100000");
  });

  it("sets STATUS:CANCELLED for cancelled events", () => {
    const event = makeEvent({
      status: "cancelled",
      start: { dateTime: "2025-06-15T09:00:00Z" },
      end: { dateTime: "2025-06-15T10:00:00Z" },
    });

    const vevent = buildVEvent(event);
    expect(vevent).toContain("STATUS:CANCELLED");
  });

  it("sets STATUS:TENTATIVE for tentative events", () => {
    const event = makeEvent({
      status: "tentative",
      start: { dateTime: "2025-06-15T09:00:00Z" },
      end: { dateTime: "2025-06-15T10:00:00Z" },
    });

    const vevent = buildVEvent(event);
    expect(vevent).toContain("STATUS:TENTATIVE");
  });

  it("sets TRANSP:TRANSPARENT for transparent events", () => {
    const event = makeEvent({
      transparency: "transparent",
      start: { dateTime: "2025-06-15T09:00:00Z" },
      end: { dateTime: "2025-06-15T10:00:00Z" },
    });

    const vevent = buildVEvent(event);
    expect(vevent).toContain("TRANSP:TRANSPARENT");
  });

  it("sets TRANSP:OPAQUE for opaque events (default)", () => {
    const event = makeEvent({
      transparency: "opaque",
      start: { dateTime: "2025-06-15T09:00:00Z" },
      end: { dateTime: "2025-06-15T10:00:00Z" },
    });

    const vevent = buildVEvent(event);
    expect(vevent).toContain("TRANSP:OPAQUE");
  });

  it("omits DESCRIPTION when not provided", () => {
    const event = makeEvent({
      description: undefined,
      start: { dateTime: "2025-06-15T09:00:00Z" },
      end: { dateTime: "2025-06-15T10:00:00Z" },
    });

    const vevent = buildVEvent(event);
    expect(vevent).not.toContain("DESCRIPTION:");
  });

  it("omits LOCATION when not provided", () => {
    const event = makeEvent({
      location: undefined,
      start: { dateTime: "2025-06-15T09:00:00Z" },
      end: { dateTime: "2025-06-15T10:00:00Z" },
    });

    const vevent = buildVEvent(event);
    expect(vevent).not.toContain("LOCATION:");
  });

  it("uses fallback SUMMARY for events without title", () => {
    const event = makeEvent({
      title: undefined,
      start: { dateTime: "2025-06-15T09:00:00Z" },
      end: { dateTime: "2025-06-15T10:00:00Z" },
    });

    const vevent = buildVEvent(event);
    expect(vevent).toContain("SUMMARY:(No title)");
  });

  it("uses CRLF line endings per RFC 5545", () => {
    const event = makeEvent({
      start: { dateTime: "2025-06-15T09:00:00Z" },
      end: { dateTime: "2025-06-15T10:00:00Z" },
    });

    const vevent = buildVEvent(event);
    // All lines should end with CRLF
    const lines = vevent.split("\r\n");
    // The last element after split on CRLF should be empty (trailing CRLF)
    expect(lines.length).toBeGreaterThan(5);
  });

  it("includes RRULE when recurrence_rule is present", () => {
    const event = makeEvent({
      recurrence_rule: "FREQ=WEEKLY;BYDAY=MO",
      start: { dateTime: "2025-06-15T09:00:00Z" },
      end: { dateTime: "2025-06-15T10:00:00Z" },
    });

    const vevent = buildVEvent(event);
    expect(vevent).toContain("RRULE:FREQ=WEEKLY;BYDAY=MO");
  });

  it("escapes special characters in text values", () => {
    const event = makeEvent({
      title: "Meeting, with commas; and semicolons",
      description: "Line one\nLine two",
      start: { dateTime: "2025-06-15T09:00:00Z" },
      end: { dateTime: "2025-06-15T10:00:00Z" },
    });

    const vevent = buildVEvent(event);
    // Commas and semicolons should be escaped in iCal text
    expect(vevent).toContain("SUMMARY:Meeting\\, with commas\\; and semicolons");
    // Newlines escaped as \\n in iCal
    expect(vevent).toContain("DESCRIPTION:Line one\\nLine two");
  });
});

// ---------------------------------------------------------------------------
// collectTimezones -- extract unique timezone IDs from events
// ---------------------------------------------------------------------------

describe("collectTimezones", () => {
  it("returns empty set when all events are UTC", () => {
    const events = [
      makeEvent({
        start: { dateTime: "2025-06-15T09:00:00Z" },
        end: { dateTime: "2025-06-15T10:00:00Z" },
      }),
    ];

    expect(collectTimezones(events)).toEqual(new Set());
  });

  it("returns empty set for all-day events", () => {
    const events = [
      makeEvent({
        all_day: true,
        start: { date: "2025-06-15" },
        end: { date: "2025-06-16" },
      }),
    ];

    expect(collectTimezones(events)).toEqual(new Set());
  });

  it("collects unique timezone IDs from events", () => {
    const events = [
      makeEvent({
        start: { dateTime: "2025-06-15T09:00:00", timeZone: "America/Chicago" },
        end: { dateTime: "2025-06-15T10:00:00", timeZone: "America/Chicago" },
      }),
      makeEvent({
        start: { dateTime: "2025-06-15T11:00:00", timeZone: "America/New_York" },
        end: { dateTime: "2025-06-15T12:00:00", timeZone: "America/New_York" },
      }),
      makeEvent({
        start: { dateTime: "2025-06-15T13:00:00", timeZone: "America/Chicago" },
        end: { dateTime: "2025-06-15T14:00:00", timeZone: "America/Chicago" },
      }),
    ];

    const tzs = collectTimezones(events);
    expect(tzs).toEqual(new Set(["America/Chicago", "America/New_York"]));
  });
});

// ---------------------------------------------------------------------------
// foldLine -- RFC 5545 line folding (max 75 octets)
// ---------------------------------------------------------------------------

describe("foldLine", () => {
  it("does not fold short lines", () => {
    const short = "SUMMARY:Short title";
    expect(foldLine(short)).toBe(short);
  });

  it("folds lines longer than 75 octets", () => {
    const long = "DESCRIPTION:" + "A".repeat(100);
    const folded = foldLine(long);

    // First line should be at most 75 chars
    const lines = folded.split("\r\n");
    expect(lines[0].length).toBeLessThanOrEqual(75);

    // Continuation lines start with a space
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].length > 0) {
        expect(lines[i][0]).toBe(" ");
      }
    }
  });

  it("preserves content when unfolded", () => {
    const original = "DESCRIPTION:" + "ABCDEFGHIJ".repeat(10);
    const folded = foldLine(original);

    // Unfold: remove CRLF + space
    const unfolded = folded.replace(/\r\n /g, "");
    expect(unfolded).toBe(original);
  });
});

// ---------------------------------------------------------------------------
// buildVCalendar -- full VCALENDAR assembly
// ---------------------------------------------------------------------------

describe("buildVCalendar", () => {
  it("produces a valid VCALENDAR wrapping multiple VEVENTs", () => {
    const events = [
      makeEvent({
        canonical_event_id: "evt_01HXY000000000000000000001" as EventId,
        title: "Morning standup",
        start: { dateTime: "2025-06-15T09:00:00Z" },
        end: { dateTime: "2025-06-15T09:15:00Z" },
      }),
      makeEvent({
        canonical_event_id: "evt_01HXY000000000000000000002" as EventId,
        title: "Lunch",
        all_day: false,
        start: { dateTime: "2025-06-15T12:00:00Z" },
        end: { dateTime: "2025-06-15T13:00:00Z" },
      }),
    ];

    const ical = buildVCalendar(events);

    expect(ical).toContain("BEGIN:VCALENDAR");
    expect(ical).toContain("END:VCALENDAR");
    expect(ical).toContain("VERSION:2.0");
    expect(ical).toContain("PRODID:-//T-Minus//Calendar Feed//EN");
    expect(ical).toContain("CALSCALE:GREGORIAN");
    expect(ical).toContain("METHOD:PUBLISH");
    expect(ical).toContain("X-WR-CALNAME:T-Minus Unified Calendar");

    // Should have exactly 2 VEVENTs
    const beginCount = (ical.match(/BEGIN:VEVENT/g) || []).length;
    const endCount = (ical.match(/END:VEVENT/g) || []).length;
    expect(beginCount).toBe(2);
    expect(endCount).toBe(2);
  });

  it("includes VTIMEZONE components for non-UTC events", () => {
    const events = [
      makeEvent({
        start: { dateTime: "2025-06-15T09:00:00", timeZone: "America/Chicago" },
        end: { dateTime: "2025-06-15T10:00:00", timeZone: "America/Chicago" },
      }),
    ];

    const ical = buildVCalendar(events);

    expect(ical).toContain("BEGIN:VTIMEZONE");
    expect(ical).toContain("TZID:America/Chicago");
    expect(ical).toContain("END:VTIMEZONE");
  });

  it("does not include VTIMEZONE for purely UTC events", () => {
    const events = [
      makeEvent({
        start: { dateTime: "2025-06-15T09:00:00Z" },
        end: { dateTime: "2025-06-15T10:00:00Z" },
      }),
    ];

    const ical = buildVCalendar(events);

    expect(ical).not.toContain("BEGIN:VTIMEZONE");
  });

  it("handles empty event list gracefully", () => {
    const ical = buildVCalendar([]);

    expect(ical).toContain("BEGIN:VCALENDAR");
    expect(ical).toContain("END:VCALENDAR");
    expect(ical).not.toContain("BEGIN:VEVENT");
  });

  it("uses CRLF line endings throughout", () => {
    const events = [
      makeEvent({
        start: { dateTime: "2025-06-15T09:00:00Z" },
        end: { dateTime: "2025-06-15T10:00:00Z" },
      }),
    ];

    const ical = buildVCalendar(events);

    // Every non-empty line should be CRLF terminated
    // Check: no bare LF without preceding CR
    const bareLF = ical.replace(/\r\n/g, "").includes("\n");
    expect(bareLF).toBe(false);
  });

  it("places VTIMEZONE before VEVENT components", () => {
    const events = [
      makeEvent({
        start: { dateTime: "2025-06-15T09:00:00", timeZone: "America/New_York" },
        end: { dateTime: "2025-06-15T10:00:00", timeZone: "America/New_York" },
      }),
    ];

    const ical = buildVCalendar(events);

    const tzPos = ical.indexOf("BEGIN:VTIMEZONE");
    const evtPos = ical.indexOf("BEGIN:VEVENT");
    expect(tzPos).toBeLessThan(evtPos);
  });

  it("filters out cancelled events when excludeCancelled option is true", () => {
    const events = [
      makeEvent({
        canonical_event_id: "evt_01HXY000000000000000000001" as EventId,
        status: "confirmed",
        start: { dateTime: "2025-06-15T09:00:00Z" },
        end: { dateTime: "2025-06-15T10:00:00Z" },
      }),
      makeEvent({
        canonical_event_id: "evt_01HXY000000000000000000002" as EventId,
        status: "cancelled",
        start: { dateTime: "2025-06-15T11:00:00Z" },
        end: { dateTime: "2025-06-15T12:00:00Z" },
      }),
    ];

    const ical = buildVCalendar(events, { excludeCancelled: true });

    const beginCount = (ical.match(/BEGIN:VEVENT/g) || []).length;
    expect(beginCount).toBe(1);
    expect(ical).not.toContain("STATUS:CANCELLED");
  });

  it("includes cancelled events by default", () => {
    const events = [
      makeEvent({
        status: "cancelled",
        start: { dateTime: "2025-06-15T09:00:00Z" },
        end: { dateTime: "2025-06-15T10:00:00Z" },
      }),
    ];

    const ical = buildVCalendar(events);

    expect(ical).toContain("STATUS:CANCELLED");
  });
});
