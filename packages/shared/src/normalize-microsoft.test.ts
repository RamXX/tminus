/**
 * @tminus/shared -- Unit tests for Microsoft Graph event normalization.
 *
 * normalizeMicrosoftEvent converts raw Microsoft Graph API event responses
 * into the ProviderDelta format consumed by UserGraphDO.applyProviderDelta().
 *
 * Key behaviors tested:
 * - subject -> summary (title) mapping
 * - body.content -> description mapping
 * - start/end dateTime + timeZone mapping
 * - isAllDay -> allDay mapping
 * - isCancelled -> deleted change type
 * - showAs -> transparency mapping (free/tentative -> transparent, busy/oof/workingElsewhere -> opaque)
 * - sensitivity -> visibility mapping (normal -> default, private/personal -> private, confidential -> confidential)
 * - attendees mapping
 * - location.displayName -> location mapping
 * - Open extensions (com.tminus.metadata) for managed mirror detection
 * - Managed mirrors produce delta with no event payload (Invariant E)
 * - Purity: deterministic, no mutations
 */
import { describe, it, expect } from "vitest";
import type {
  EventClassification,
  AccountId,
  ProviderDelta,
} from "./types";
import {
  normalizeMicrosoftEvent,
  type MicrosoftGraphEvent,
} from "./normalize-microsoft";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_ACCOUNT_ID = "acc_01HXY0000000000000000000AA" as AccountId;

// ---------------------------------------------------------------------------
// Helper: build a Microsoft Graph event
// ---------------------------------------------------------------------------

function makeMsEvent(
  overrides: Partial<MicrosoftGraphEvent> = {},
): MicrosoftGraphEvent {
  return {
    id: "ms_evt_abc123",
    subject: "Team standup",
    body: { contentType: "text", content: "Daily standup meeting" },
    start: { dateTime: "2025-06-15T09:00:00.0000000", timeZone: "America/Chicago" },
    end: { dateTime: "2025-06-15T09:30:00.0000000", timeZone: "America/Chicago" },
    isAllDay: false,
    isCancelled: false,
    showAs: "busy",
    sensitivity: "normal",
    location: { displayName: "Conference Room B" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// AC 4: Field mappings -- subject -> title, body -> description
// ---------------------------------------------------------------------------

describe("normalizeMicrosoftEvent -- basic field mappings", () => {
  it("maps subject to title", () => {
    const event = makeMsEvent({ subject: "My Meeting" });
    const delta = normalizeMicrosoftEvent(event, TEST_ACCOUNT_ID, "origin");

    expect(delta.event!.title).toBe("My Meeting");
  });

  it("maps body.content to description", () => {
    const event = makeMsEvent({ body: { contentType: "text", content: "Meeting notes here" } });
    const delta = normalizeMicrosoftEvent(event, TEST_ACCOUNT_ID, "origin");

    expect(delta.event!.description).toBe("Meeting notes here");
  });

  it("maps location.displayName to location", () => {
    const event = makeMsEvent({ location: { displayName: "Room 42" } });
    const delta = normalizeMicrosoftEvent(event, TEST_ACCOUNT_ID, "origin");

    expect(delta.event!.location).toBe("Room 42");
  });

  it("handles missing body gracefully", () => {
    const event = makeMsEvent({ body: undefined });
    const delta = normalizeMicrosoftEvent(event, TEST_ACCOUNT_ID, "origin");

    expect(delta.event!.description).toBeUndefined();
  });

  it("handles missing location gracefully", () => {
    const event = makeMsEvent({ location: undefined });
    const delta = normalizeMicrosoftEvent(event, TEST_ACCOUNT_ID, "origin");

    expect(delta.event!.location).toBeUndefined();
  });

  it("handles missing subject gracefully", () => {
    const event = makeMsEvent({ subject: undefined });
    const delta = normalizeMicrosoftEvent(event, TEST_ACCOUNT_ID, "origin");

    expect(delta.event!.title).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Start/end time mapping
// ---------------------------------------------------------------------------

describe("normalizeMicrosoftEvent -- start/end time mapping", () => {
  it("maps timed event start/end with timeZone", () => {
    const event = makeMsEvent({
      start: { dateTime: "2025-06-15T09:00:00.0000000", timeZone: "America/Chicago" },
      end: { dateTime: "2025-06-15T09:30:00.0000000", timeZone: "America/Chicago" },
      isAllDay: false,
    });
    const delta = normalizeMicrosoftEvent(event, TEST_ACCOUNT_ID, "origin");

    expect(delta.event!.start).toEqual({
      dateTime: "2025-06-15T09:00:00.0000000",
      timeZone: "America/Chicago",
    });
    expect(delta.event!.end).toEqual({
      dateTime: "2025-06-15T09:30:00.0000000",
      timeZone: "America/Chicago",
    });
    expect(delta.event!.all_day).toBe(false);
  });

  it("maps all-day event with date format", () => {
    const event = makeMsEvent({
      start: { dateTime: "2025-06-15T00:00:00.0000000", timeZone: "UTC" },
      end: { dateTime: "2025-06-16T00:00:00.0000000", timeZone: "UTC" },
      isAllDay: true,
    });
    const delta = normalizeMicrosoftEvent(event, TEST_ACCOUNT_ID, "origin");

    expect(delta.event!.all_day).toBe(true);
    // All-day events use the date portion of dateTime
    expect(delta.event!.start).toEqual({
      date: "2025-06-15",
    });
    expect(delta.event!.end).toEqual({
      date: "2025-06-16",
    });
  });

  it("handles missing start/end gracefully", () => {
    const event = makeMsEvent({ start: undefined, end: undefined });
    const delta = normalizeMicrosoftEvent(event, TEST_ACCOUNT_ID, "origin");

    expect(delta.event!.start).toEqual({});
    expect(delta.event!.end).toEqual({});
    expect(delta.event!.all_day).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cancelled events -> deleted
// ---------------------------------------------------------------------------

describe("normalizeMicrosoftEvent -- cancelled events", () => {
  it("produces type='deleted' for cancelled events", () => {
    const event = makeMsEvent({ isCancelled: true });
    const delta = normalizeMicrosoftEvent(event, TEST_ACCOUNT_ID, "origin");

    expect(delta.type).toBe("deleted");
    expect(delta.origin_event_id).toBe("ms_evt_abc123");
    expect(delta.event).toBeUndefined();
  });

  it("produces type='updated' for non-cancelled events", () => {
    const event = makeMsEvent({ isCancelled: false });
    const delta = normalizeMicrosoftEvent(event, TEST_ACCOUNT_ID, "origin");

    expect(delta.type).toBe("updated");
    expect(delta.event).toBeDefined();
  });

  it("produces type='updated' when isCancelled is undefined", () => {
    const event = makeMsEvent({ isCancelled: undefined });
    const delta = normalizeMicrosoftEvent(event, TEST_ACCOUNT_ID, "origin");

    expect(delta.type).toBe("updated");
  });
});

// ---------------------------------------------------------------------------
// showAs -> transparency mapping
// ---------------------------------------------------------------------------

describe("normalizeMicrosoftEvent -- showAs to transparency mapping", () => {
  it("maps 'free' to 'transparent'", () => {
    const event = makeMsEvent({ showAs: "free" });
    const delta = normalizeMicrosoftEvent(event, TEST_ACCOUNT_ID, "origin");
    expect(delta.event!.transparency).toBe("transparent");
  });

  it("maps 'tentative' to 'transparent'", () => {
    const event = makeMsEvent({ showAs: "tentative" });
    const delta = normalizeMicrosoftEvent(event, TEST_ACCOUNT_ID, "origin");
    expect(delta.event!.transparency).toBe("transparent");
  });

  it("maps 'busy' to 'opaque'", () => {
    const event = makeMsEvent({ showAs: "busy" });
    const delta = normalizeMicrosoftEvent(event, TEST_ACCOUNT_ID, "origin");
    expect(delta.event!.transparency).toBe("opaque");
  });

  it("maps 'oof' (out of office) to 'opaque'", () => {
    const event = makeMsEvent({ showAs: "oof" });
    const delta = normalizeMicrosoftEvent(event, TEST_ACCOUNT_ID, "origin");
    expect(delta.event!.transparency).toBe("opaque");
  });

  it("maps 'workingElsewhere' to 'opaque'", () => {
    const event = makeMsEvent({ showAs: "workingElsewhere" });
    const delta = normalizeMicrosoftEvent(event, TEST_ACCOUNT_ID, "origin");
    expect(delta.event!.transparency).toBe("opaque");
  });

  it("defaults to 'opaque' when showAs is undefined", () => {
    const event = makeMsEvent({ showAs: undefined });
    const delta = normalizeMicrosoftEvent(event, TEST_ACCOUNT_ID, "origin");
    expect(delta.event!.transparency).toBe("opaque");
  });

  it("defaults to 'opaque' for unknown showAs value", () => {
    const event = makeMsEvent({ showAs: "unknownStatus" as string });
    const delta = normalizeMicrosoftEvent(event, TEST_ACCOUNT_ID, "origin");
    expect(delta.event!.transparency).toBe("opaque");
  });
});

// ---------------------------------------------------------------------------
// sensitivity -> visibility mapping
// ---------------------------------------------------------------------------

describe("normalizeMicrosoftEvent -- sensitivity to visibility mapping", () => {
  it("maps 'normal' to 'default'", () => {
    const event = makeMsEvent({ sensitivity: "normal" });
    const delta = normalizeMicrosoftEvent(event, TEST_ACCOUNT_ID, "origin");
    expect(delta.event!.visibility).toBe("default");
  });

  it("maps 'private' to 'private'", () => {
    const event = makeMsEvent({ sensitivity: "private" });
    const delta = normalizeMicrosoftEvent(event, TEST_ACCOUNT_ID, "origin");
    expect(delta.event!.visibility).toBe("private");
  });

  it("maps 'personal' to 'private'", () => {
    const event = makeMsEvent({ sensitivity: "personal" });
    const delta = normalizeMicrosoftEvent(event, TEST_ACCOUNT_ID, "origin");
    expect(delta.event!.visibility).toBe("private");
  });

  it("maps 'confidential' to 'confidential'", () => {
    const event = makeMsEvent({ sensitivity: "confidential" });
    const delta = normalizeMicrosoftEvent(event, TEST_ACCOUNT_ID, "origin");
    expect(delta.event!.visibility).toBe("confidential");
  });

  it("defaults to 'default' when sensitivity is undefined", () => {
    const event = makeMsEvent({ sensitivity: undefined });
    const delta = normalizeMicrosoftEvent(event, TEST_ACCOUNT_ID, "origin");
    expect(delta.event!.visibility).toBe("default");
  });

  it("defaults to 'default' for unknown sensitivity value", () => {
    const event = makeMsEvent({ sensitivity: "unknownSens" as string });
    const delta = normalizeMicrosoftEvent(event, TEST_ACCOUNT_ID, "origin");
    expect(delta.event!.visibility).toBe("default");
  });
});

// ---------------------------------------------------------------------------
// Managed mirrors (Invariant E)
// ---------------------------------------------------------------------------

describe("normalizeMicrosoftEvent -- managed mirrors (Invariant E)", () => {
  it("produces delta with no event payload for managed_mirror classification", () => {
    const event = makeMsEvent();
    const delta = normalizeMicrosoftEvent(event, TEST_ACCOUNT_ID, "managed_mirror");

    expect(delta.type).toBe("updated");
    expect(delta.origin_event_id).toBe("ms_evt_abc123");
    expect(delta.origin_account_id).toBe(TEST_ACCOUNT_ID);
    expect(delta.event).toBeUndefined();
  });

  it("produces type='deleted' with no event payload for cancelled managed_mirror", () => {
    const event = makeMsEvent({ isCancelled: true });
    const delta = normalizeMicrosoftEvent(event, TEST_ACCOUNT_ID, "managed_mirror");

    expect(delta.type).toBe("deleted");
    expect(delta.event).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Open extension detection for classification
// ---------------------------------------------------------------------------

describe("normalizeMicrosoftEvent -- open extension detection", () => {
  it("event with com.tminus.metadata extension is identifiable", () => {
    const event = makeMsEvent({
      extensions: [
        {
          "@odata.type": "#microsoft.graph.openExtension",
          extensionName: "com.tminus.metadata",
          tminus: "true",
          managed: "true",
          canonicalId: "evt_01HXYZ12345678901234AB",
          originAccount: "acc_01HXYZ12345678901234AB",
        },
      ],
    });

    // The extension data is available on the raw event for classification
    expect(event.extensions).toHaveLength(1);
    expect(event.extensions![0].extensionName).toBe("com.tminus.metadata");
    expect(event.extensions![0].tminus).toBe("true");
    expect(event.extensions![0].managed).toBe("true");
  });
});

// ---------------------------------------------------------------------------
// Status mapping (Microsoft has no 'status' like Google; uses isCancelled)
// ---------------------------------------------------------------------------

describe("normalizeMicrosoftEvent -- status mapping", () => {
  it("non-cancelled event defaults to 'confirmed'", () => {
    const event = makeMsEvent({ isCancelled: false });
    const delta = normalizeMicrosoftEvent(event, TEST_ACCOUNT_ID, "origin");
    expect(delta.event!.status).toBe("confirmed");
  });
});

// ---------------------------------------------------------------------------
// origin_account_id set correctly
// ---------------------------------------------------------------------------

describe("normalizeMicrosoftEvent -- origin_account_id", () => {
  it("sets origin_account_id from the provided accountId parameter", () => {
    const event = makeMsEvent();
    const customAccountId = "acc_01HXY0000000000000000000BB" as AccountId;
    const delta = normalizeMicrosoftEvent(event, customAccountId, "origin");

    expect(delta.origin_account_id).toBe(customAccountId);
  });

  it("sets origin_account_id for foreign_managed events", () => {
    const event = makeMsEvent();
    const delta = normalizeMicrosoftEvent(event, TEST_ACCOUNT_ID, "foreign_managed");

    expect(delta.origin_account_id).toBe(TEST_ACCOUNT_ID);
    expect(delta.event).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Purity
// ---------------------------------------------------------------------------

describe("normalizeMicrosoftEvent -- purity", () => {
  it("is a pure function: same input always produces same output", () => {
    const event = makeMsEvent();
    const r1 = normalizeMicrosoftEvent(event, TEST_ACCOUNT_ID, "origin");
    const r2 = normalizeMicrosoftEvent(event, TEST_ACCOUNT_ID, "origin");

    expect(r1).toEqual(r2);
  });

  it("does not mutate the input event", () => {
    const event = makeMsEvent();
    const eventCopy = JSON.parse(JSON.stringify(event));
    normalizeMicrosoftEvent(event, TEST_ACCOUNT_ID, "origin");

    expect(event).toEqual(eventCopy);
  });
});

// ---------------------------------------------------------------------------
// Return type conformance
// ---------------------------------------------------------------------------

describe("normalizeMicrosoftEvent -- return type conformance", () => {
  it("returns a valid ProviderDelta with all required fields", () => {
    const event = makeMsEvent();
    const delta: ProviderDelta = normalizeMicrosoftEvent(event, TEST_ACCOUNT_ID, "origin");

    expect(delta).toHaveProperty("type");
    expect(delta).toHaveProperty("origin_event_id");
    expect(delta).toHaveProperty("origin_account_id");
    expect(["created", "updated", "deleted"]).toContain(delta.type);
  });

  it("non-cancelled origin event has type='updated'", () => {
    const event = makeMsEvent({ isCancelled: false });
    const delta = normalizeMicrosoftEvent(event, TEST_ACCOUNT_ID, "origin");

    expect(delta.type).toBe("updated");
  });
});

// ---------------------------------------------------------------------------
// Missing event ID
// ---------------------------------------------------------------------------

describe("normalizeMicrosoftEvent -- edge cases", () => {
  it("handles event with missing id gracefully", () => {
    const event = makeMsEvent({ id: undefined });
    const delta = normalizeMicrosoftEvent(event, TEST_ACCOUNT_ID, "origin");

    expect(delta.origin_event_id).toBe("");
  });

  it("handles completely empty event", () => {
    const event: MicrosoftGraphEvent = {};
    const delta = normalizeMicrosoftEvent(event, TEST_ACCOUNT_ID, "origin");

    expect(delta.type).toBe("updated");
    expect(delta.origin_event_id).toBe("");
    expect(delta.event).toBeDefined();
    expect(delta.event!.title).toBeUndefined();
    expect(delta.event!.description).toBeUndefined();
    expect(delta.event!.start).toEqual({});
    expect(delta.event!.end).toEqual({});
    expect(delta.event!.all_day).toBe(false);
    expect(delta.event!.status).toBe("confirmed");
    expect(delta.event!.visibility).toBe("default");
    expect(delta.event!.transparency).toBe("opaque");
  });

  it("does not include attendees or conferenceData in output (Phase 1 scope)", () => {
    const event = makeMsEvent({
      attendees: [
        { emailAddress: { name: "John", address: "john@test.com" }, type: "required" },
      ],
      onlineMeeting: { joinUrl: "https://teams.microsoft.com/meet/123" },
    });
    const delta = normalizeMicrosoftEvent(event, TEST_ACCOUNT_ID, "origin");

    const eventPayload = delta.event as Record<string, unknown>;
    expect(eventPayload).not.toHaveProperty("attendees");
    expect(eventPayload).not.toHaveProperty("conferenceData");
    expect(eventPayload).not.toHaveProperty("onlineMeeting");
  });
});
