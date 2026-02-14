/**
 * @tminus/shared -- Unit tests for Google event normalization.
 *
 * normalizeGoogleEvent converts raw Google Calendar API event responses
 * into the ProviderDelta format consumed by UserGraphDO.applyProviderDelta().
 *
 * Key behaviors tested:
 * - Timed events normalize to dateTime + timeZone
 * - All-day events normalize to date only
 * - Cancelled events produce type='deleted'
 * - Missing fields use undefined (TypeScript optional field semantics)
 * - Managed mirrors produce delta with no event payload (Invariant E)
 * - Recurring events preserve RRULE
 * - Attendees/creator/organizer are NOT included in output (Phase 1 scope)
 */
import { describe, it, expect } from "vitest";
import type {
  GoogleCalendarEvent,
  EventClassification,
  AccountId,
  ProviderDelta,
} from "./types";
import { normalizeGoogleEvent } from "./normalize";

// ---------------------------------------------------------------------------
// Test constants -- valid ULID format per learnings (4-char prefix + 26 chars)
// ---------------------------------------------------------------------------

const TEST_ACCOUNT_ID = "acc_01HXY0000000000000000000AA" as AccountId;

// ---------------------------------------------------------------------------
// Helper: build a minimal timed GoogleCalendarEvent
// ---------------------------------------------------------------------------

function makeGoogleEvent(
  overrides: Partial<GoogleCalendarEvent> = {},
): GoogleCalendarEvent {
  return {
    id: "google_evt_abc123",
    summary: "Team standup",
    description: "Daily standup meeting",
    location: "Conference Room B",
    start: { dateTime: "2025-06-15T09:00:00-05:00", timeZone: "America/Chicago" },
    end: { dateTime: "2025-06-15T09:30:00-05:00", timeZone: "America/Chicago" },
    status: "confirmed",
    visibility: "default",
    transparency: "opaque",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// AC 1: Timed events normalized correctly with timezone
// ---------------------------------------------------------------------------

describe("normalizeGoogleEvent -- timed events", () => {
  it("normalizes a timed event with dateTime and timeZone", () => {
    const event = makeGoogleEvent();
    const delta = normalizeGoogleEvent(event, TEST_ACCOUNT_ID, "origin");

    expect(delta.type).toBe("updated");
    expect(delta.origin_event_id).toBe("google_evt_abc123");
    expect(delta.origin_account_id).toBe(TEST_ACCOUNT_ID);
    expect(delta.event).toBeDefined();
    expect(delta.event!.start).toEqual({
      dateTime: "2025-06-15T09:00:00-05:00",
      timeZone: "America/Chicago",
    });
    expect(delta.event!.end).toEqual({
      dateTime: "2025-06-15T09:30:00-05:00",
      timeZone: "America/Chicago",
    });
    expect(delta.event!.all_day).toBe(false);
  });

  it("normalizes a timed event with UTC dateTime (no explicit timeZone)", () => {
    const event = makeGoogleEvent({
      start: { dateTime: "2025-06-15T14:00:00Z" },
      end: { dateTime: "2025-06-15T14:30:00Z" },
    });
    const delta = normalizeGoogleEvent(event, TEST_ACCOUNT_ID, "origin");

    expect(delta.event!.start).toEqual({
      dateTime: "2025-06-15T14:00:00Z",
    });
    expect(delta.event!.end).toEqual({
      dateTime: "2025-06-15T14:30:00Z",
    });
    expect(delta.event!.all_day).toBe(false);
  });

  it("preserves title, description, and location for timed events", () => {
    const event = makeGoogleEvent();
    const delta = normalizeGoogleEvent(event, TEST_ACCOUNT_ID, "origin");

    expect(delta.event!.title).toBe("Team standup");
    expect(delta.event!.description).toBe("Daily standup meeting");
    expect(delta.event!.location).toBe("Conference Room B");
  });

  it("preserves status, visibility, and transparency for timed events", () => {
    const event = makeGoogleEvent({
      status: "tentative",
      visibility: "private",
      transparency: "transparent",
    });
    const delta = normalizeGoogleEvent(event, TEST_ACCOUNT_ID, "origin");

    expect(delta.event!.status).toBe("tentative");
    expect(delta.event!.visibility).toBe("private");
    expect(delta.event!.transparency).toBe("transparent");
  });
});

// ---------------------------------------------------------------------------
// AC 2: All-day events normalized with date format
// ---------------------------------------------------------------------------

describe("normalizeGoogleEvent -- all-day events", () => {
  it("normalizes an all-day event using date (not dateTime)", () => {
    const event = makeGoogleEvent({
      start: { date: "2025-06-15" },
      end: { date: "2025-06-16" },
    });
    const delta = normalizeGoogleEvent(event, TEST_ACCOUNT_ID, "origin");

    expect(delta.event!.start).toEqual({ date: "2025-06-15" });
    expect(delta.event!.end).toEqual({ date: "2025-06-16" });
    expect(delta.event!.all_day).toBe(true);
  });

  it("sets all_day=true when start.date is present (even if dateTime also present)", () => {
    // Google API should not send both, but if it does, date takes precedence
    // for the all_day flag.
    const event = makeGoogleEvent({
      start: { date: "2025-06-15", dateTime: "2025-06-15T00:00:00Z" },
      end: { date: "2025-06-16" },
    });
    const delta = normalizeGoogleEvent(event, TEST_ACCOUNT_ID, "origin");

    expect(delta.event!.all_day).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC 3: Cancelled events produce deleted change type
// ---------------------------------------------------------------------------

describe("normalizeGoogleEvent -- cancelled events", () => {
  it("produces type='deleted' for cancelled events", () => {
    const event = makeGoogleEvent({ status: "cancelled" });
    const delta = normalizeGoogleEvent(event, TEST_ACCOUNT_ID, "origin");

    expect(delta.type).toBe("deleted");
    expect(delta.origin_event_id).toBe("google_evt_abc123");
    expect(delta.origin_account_id).toBe(TEST_ACCOUNT_ID);
  });

  it("does not include event payload for cancelled events", () => {
    const event = makeGoogleEvent({ status: "cancelled" });
    const delta = normalizeGoogleEvent(event, TEST_ACCOUNT_ID, "origin");

    expect(delta.event).toBeUndefined();
  });

  it("produces type='deleted' for cancelled managed mirrors", () => {
    const event = makeGoogleEvent({
      status: "cancelled",
      extendedProperties: {
        private: { tminus: "true", managed: "true" },
      },
    });
    const delta = normalizeGoogleEvent(event, TEST_ACCOUNT_ID, "managed_mirror");

    expect(delta.type).toBe("deleted");
    expect(delta.event).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC 4: Missing fields handled correctly
// ---------------------------------------------------------------------------

describe("normalizeGoogleEvent -- missing fields", () => {
  it("uses undefined for missing optional string fields", () => {
    const event: GoogleCalendarEvent = {
      id: "google_evt_minimal",
      start: { dateTime: "2025-06-15T09:00:00Z" },
      end: { dateTime: "2025-06-15T09:30:00Z" },
    };
    const delta = normalizeGoogleEvent(event, TEST_ACCOUNT_ID, "origin");

    expect(delta.event!.title).toBeUndefined();
    expect(delta.event!.description).toBeUndefined();
    expect(delta.event!.location).toBeUndefined();
    expect(delta.event!.recurrence_rule).toBeUndefined();
  });

  it("defaults status to 'confirmed' when missing", () => {
    const event: GoogleCalendarEvent = {
      id: "google_evt_no_status",
      start: { dateTime: "2025-06-15T09:00:00Z" },
      end: { dateTime: "2025-06-15T09:30:00Z" },
    };
    const delta = normalizeGoogleEvent(event, TEST_ACCOUNT_ID, "origin");

    expect(delta.event!.status).toBe("confirmed");
  });

  it("defaults visibility to 'default' when missing", () => {
    const event: GoogleCalendarEvent = {
      id: "google_evt_no_vis",
      start: { dateTime: "2025-06-15T09:00:00Z" },
      end: { dateTime: "2025-06-15T09:30:00Z" },
    };
    const delta = normalizeGoogleEvent(event, TEST_ACCOUNT_ID, "origin");

    expect(delta.event!.visibility).toBe("default");
  });

  it("defaults transparency to 'opaque' when missing", () => {
    const event: GoogleCalendarEvent = {
      id: "google_evt_no_trans",
      start: { dateTime: "2025-06-15T09:00:00Z" },
      end: { dateTime: "2025-06-15T09:30:00Z" },
    };
    const delta = normalizeGoogleEvent(event, TEST_ACCOUNT_ID, "origin");

    expect(delta.event!.transparency).toBe("opaque");
  });

  it("handles event with missing start/end by using empty EventDateTime", () => {
    const event: GoogleCalendarEvent = { id: "google_evt_no_times" };
    const delta = normalizeGoogleEvent(event, TEST_ACCOUNT_ID, "origin");

    // Even without start/end, the function should not throw
    expect(delta.event!.start).toEqual({});
    expect(delta.event!.end).toEqual({});
    expect(delta.event!.all_day).toBe(false);
  });

  it("handles event with missing id gracefully", () => {
    const event: GoogleCalendarEvent = {
      start: { dateTime: "2025-06-15T09:00:00Z" },
      end: { dateTime: "2025-06-15T09:30:00Z" },
    };
    const delta = normalizeGoogleEvent(event, TEST_ACCOUNT_ID, "origin");

    // origin_event_id should be empty string when id is undefined
    expect(delta.origin_event_id).toBe("");
  });
});

// ---------------------------------------------------------------------------
// AC 5: Managed mirrors flagged correctly (no event payload)
// ---------------------------------------------------------------------------

describe("normalizeGoogleEvent -- managed mirrors (Invariant E)", () => {
  it("produces delta with no event payload for managed_mirror classification", () => {
    const event = makeGoogleEvent();
    const delta = normalizeGoogleEvent(event, TEST_ACCOUNT_ID, "managed_mirror");

    expect(delta.type).toBe("updated");
    expect(delta.origin_event_id).toBe("google_evt_abc123");
    expect(delta.origin_account_id).toBe(TEST_ACCOUNT_ID);
    expect(delta.event).toBeUndefined();
  });

  it("produces type='deleted' with no event payload for cancelled managed_mirror", () => {
    const event = makeGoogleEvent({ status: "cancelled" });
    const delta = normalizeGoogleEvent(event, TEST_ACCOUNT_ID, "managed_mirror");

    expect(delta.type).toBe("deleted");
    expect(delta.event).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC 6: Recurring events preserve RRULE
// ---------------------------------------------------------------------------

describe("normalizeGoogleEvent -- recurring events", () => {
  it("preserves RRULE from recurrence array", () => {
    const event = makeGoogleEvent({
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"],
    });
    const delta = normalizeGoogleEvent(event, TEST_ACCOUNT_ID, "origin");

    expect(delta.event!.recurrence_rule).toBe("RRULE:FREQ=WEEKLY;BYDAY=MO");
  });

  it("takes first element from recurrence array when multiple rules present", () => {
    const event = makeGoogleEvent({
      recurrence: [
        "RRULE:FREQ=DAILY;COUNT=5",
        "EXDATE:20250620T090000Z",
      ],
    });
    const delta = normalizeGoogleEvent(event, TEST_ACCOUNT_ID, "origin");

    expect(delta.event!.recurrence_rule).toBe("RRULE:FREQ=DAILY;COUNT=5");
  });

  it("sets recurrence_rule to undefined when recurrence is empty array", () => {
    const event = makeGoogleEvent({ recurrence: [] });
    const delta = normalizeGoogleEvent(event, TEST_ACCOUNT_ID, "origin");

    expect(delta.event!.recurrence_rule).toBeUndefined();
  });

  it("sets recurrence_rule to undefined when recurrence is absent", () => {
    const event = makeGoogleEvent();
    const delta = normalizeGoogleEvent(event, TEST_ACCOUNT_ID, "origin");

    expect(delta.event!.recurrence_rule).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Phase 1 scope: attendees/creator/organizer NOT included
// ---------------------------------------------------------------------------

describe("normalizeGoogleEvent -- Phase 1 field exclusions", () => {
  it("does not include attendees, creator, or organizer in output", () => {
    // Even if the Google event has these fields, the normalized ProviderDelta
    // event payload should NOT include them. The CanonicalEvent type does not
    // have these fields, so TypeScript enforces this. We verify at runtime too.
    const event = makeGoogleEvent();
    const delta = normalizeGoogleEvent(event, TEST_ACCOUNT_ID, "origin");

    const eventPayload = delta.event as Record<string, unknown>;
    expect(eventPayload).not.toHaveProperty("attendees");
    expect(eventPayload).not.toHaveProperty("creator");
    expect(eventPayload).not.toHaveProperty("organizer");
    expect(eventPayload).not.toHaveProperty("conferenceData");
    expect(eventPayload).not.toHaveProperty("hangoutLink");
  });
});

// ---------------------------------------------------------------------------
// origin_account_id set correctly
// ---------------------------------------------------------------------------

describe("normalizeGoogleEvent -- origin_account_id", () => {
  it("sets origin_account_id from the provided accountId parameter", () => {
    const event = makeGoogleEvent();
    const customAccountId = "acc_01HXY0000000000000000000BB" as AccountId;
    const delta = normalizeGoogleEvent(event, customAccountId, "origin");

    expect(delta.origin_account_id).toBe(customAccountId);
  });

  it("sets origin_account_id for foreign_managed events", () => {
    const event = makeGoogleEvent();
    const delta = normalizeGoogleEvent(event, TEST_ACCOUNT_ID, "foreign_managed");

    expect(delta.origin_account_id).toBe(TEST_ACCOUNT_ID);
    // foreign_managed is treated like origin -- should have event payload
    expect(delta.event).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Purity
// ---------------------------------------------------------------------------

describe("normalizeGoogleEvent -- purity", () => {
  it("is a pure function: same input always produces same output", () => {
    const event = makeGoogleEvent();
    const r1 = normalizeGoogleEvent(event, TEST_ACCOUNT_ID, "origin");
    const r2 = normalizeGoogleEvent(event, TEST_ACCOUNT_ID, "origin");

    expect(r1).toEqual(r2);
  });

  it("does not mutate the input event", () => {
    const event = makeGoogleEvent();
    const eventCopy = JSON.parse(JSON.stringify(event));
    normalizeGoogleEvent(event, TEST_ACCOUNT_ID, "origin");

    expect(event).toEqual(eventCopy);
  });
});

// ---------------------------------------------------------------------------
// Return type conformance
// ---------------------------------------------------------------------------

describe("normalizeGoogleEvent -- return type conformance", () => {
  it("returns a valid ProviderDelta with all required fields", () => {
    const event = makeGoogleEvent();
    const delta: ProviderDelta = normalizeGoogleEvent(event, TEST_ACCOUNT_ID, "origin");

    expect(delta).toHaveProperty("type");
    expect(delta).toHaveProperty("origin_event_id");
    expect(delta).toHaveProperty("origin_account_id");
    expect(["created", "updated", "deleted"]).toContain(delta.type);
  });

  it("non-cancelled origin event has type='updated'", () => {
    // Google API uses 'updated' for both creates and updates.
    // sync-consumer distinguishes by checking if canonical event exists.
    const event = makeGoogleEvent({ status: "confirmed" });
    const delta = normalizeGoogleEvent(event, TEST_ACCOUNT_ID, "origin");

    expect(delta.type).toBe("updated");
  });

  it("non-cancelled tentative event has type='updated'", () => {
    const event = makeGoogleEvent({ status: "tentative" });
    const delta = normalizeGoogleEvent(event, TEST_ACCOUNT_ID, "origin");

    expect(delta.type).toBe("updated");
  });
});
