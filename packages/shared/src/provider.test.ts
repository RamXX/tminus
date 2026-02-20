/**
 * @tminus/shared -- Unit tests for provider-agnostic abstraction layer.
 *
 * Tests:
 * - ProviderType validation (isSupportedProvider)
 * - ClassificationStrategy interface + Google implementation
 * - getClassificationStrategy dispatch
 * - normalizeProviderEvent dispatch
 * - createCalendarProvider factory
 * - Error cases for unsupported providers
 */
import { describe, it, expect, vi } from "vitest";
import type { GoogleCalendarEvent, AccountId, EventClassification } from "./types";
import type { CalendarProvider, FetchFn } from "./google-api";
import { GoogleCalendarClient } from "./google-api";
import { normalizeGoogleEvent } from "./normalize";
import {
  type ProviderType,
  SUPPORTED_PROVIDERS,
  isSupportedProvider,
  googleClassificationStrategy,
  getClassificationStrategy,
  normalizeProviderEvent,
  createCalendarProvider,
} from "./provider";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_ACCOUNT_ID = "acc_01HXY0000000000000000000AA" as AccountId;

function makeGoogleEvent(
  overrides: Partial<GoogleCalendarEvent> = {},
): GoogleCalendarEvent {
  return {
    id: "google_evt_abc123",
    summary: "Team standup",
    start: { dateTime: "2025-06-15T09:00:00Z" },
    end: { dateTime: "2025-06-15T09:30:00Z" },
    status: "confirmed",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// ProviderType validation
// ---------------------------------------------------------------------------

describe("isSupportedProvider", () => {
  it("returns true for 'google'", () => {
    expect(isSupportedProvider("google")).toBe(true);
  });

  it("returns true for 'microsoft'", () => {
    expect(isSupportedProvider("microsoft")).toBe(true);
  });

  it("returns true for 'caldav'", () => {
    expect(isSupportedProvider("caldav")).toBe(true);
  });

  it("returns false for arbitrary strings", () => {
    expect(isSupportedProvider("yahoo")).toBe(false);
    expect(isSupportedProvider("")).toBe(false);
    expect(isSupportedProvider("GOOGLE")).toBe(false);
  });
});

describe("SUPPORTED_PROVIDERS", () => {
  it("contains 'google', 'microsoft', and 'caldav'", () => {
    expect(SUPPORTED_PROVIDERS).toEqual(["google", "microsoft", "caldav"]);
  });

  it("is readonly (frozen at the type level)", () => {
    // TypeScript enforces readonly, but we can verify it's an array
    expect(Array.isArray(SUPPORTED_PROVIDERS)).toBe(true);
    expect(SUPPORTED_PROVIDERS.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// ClassificationStrategy
// ---------------------------------------------------------------------------

describe("googleClassificationStrategy", () => {
  it("classifies an origin event (no extended properties)", () => {
    const event = makeGoogleEvent();
    expect(googleClassificationStrategy.classify(event)).toBe("origin");
  });

  it("classifies a managed_mirror event (tminus+managed)", () => {
    const event = makeGoogleEvent({
      extendedProperties: {
        private: { tminus: "true", managed: "true" },
      },
    });
    expect(googleClassificationStrategy.classify(event)).toBe("managed_mirror");
  });

  it("classifies event with partial tminus properties as origin", () => {
    const event = makeGoogleEvent({
      extendedProperties: {
        private: { tminus: "true" },
      },
    });
    expect(googleClassificationStrategy.classify(event)).toBe("origin");
  });
});

describe("getClassificationStrategy", () => {
  it("returns googleClassificationStrategy for 'google'", () => {
    const strategy = getClassificationStrategy("google");
    expect(strategy).toBe(googleClassificationStrategy);
  });

  it("returns microsoftClassificationStrategy for 'microsoft'", () => {
    const strategy = getClassificationStrategy("microsoft");
    expect(strategy).toBeDefined();
    expect(typeof strategy.classify).toBe("function");
    expect(
      strategy.classify({
        id: "AAMkAG-ms-managed",
        categories: ["T-Minus Managed"],
      }),
    ).toBe("managed_mirror");
  });

  it("returns caldavClassificationStrategy for 'caldav'", () => {
    const strategy = getClassificationStrategy("caldav" as ProviderType);
    expect(strategy).toBeDefined();
    expect(typeof strategy.classify).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// normalizeProviderEvent
// ---------------------------------------------------------------------------

describe("normalizeProviderEvent", () => {
  it("dispatches to Google normalizer for provider='google'", () => {
    const event = makeGoogleEvent();
    const delta = normalizeProviderEvent("google", event, TEST_ACCOUNT_ID, "origin");

    expect(delta.type).toBe("updated");
    expect(delta.origin_event_id).toBe("google_evt_abc123");
    expect(delta.origin_account_id).toBe(TEST_ACCOUNT_ID);
    expect(delta.event).toBeDefined();
    expect(delta.event!.title).toBe("Team standup");
  });

  it("normalizes a Google cancelled event as deleted via provider dispatch", () => {
    const event = makeGoogleEvent({ status: "cancelled" });
    const delta = normalizeProviderEvent("google", event, TEST_ACCOUNT_ID, "origin");

    expect(delta.type).toBe("deleted");
    expect(delta.event).toBeUndefined();
  });

  it("normalizes a Google managed_mirror with no event payload via provider dispatch", () => {
    const event = makeGoogleEvent();
    const delta = normalizeProviderEvent("google", event, TEST_ACCOUNT_ID, "managed_mirror");

    expect(delta.type).toBe("updated");
    expect(delta.event).toBeUndefined();
  });

  it("produces identical output to calling normalizeGoogleEvent directly", () => {
    const event = makeGoogleEvent({
      description: "Test description",
      location: "Room 42",
      visibility: "private",
      transparency: "transparent",
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"],
    });

    const directResult = normalizeGoogleEvent(event, TEST_ACCOUNT_ID, "origin");
    const dispatchResult = normalizeProviderEvent("google", event, TEST_ACCOUNT_ID, "origin");

    expect(dispatchResult).toEqual(directResult);
  });

  it("dispatches to Microsoft normalizer for provider='microsoft'", () => {
    // Use a minimal Microsoft Graph event shape
    const msEvent = {
      id: "ms_evt_123",
      subject: "MS Meeting",
      start: { dateTime: "2025-06-15T09:00:00", timeZone: "UTC" },
      end: { dateTime: "2025-06-15T09:30:00", timeZone: "UTC" },
      isCancelled: false,
    };
    const delta = normalizeProviderEvent("microsoft", msEvent, TEST_ACCOUNT_ID, "origin");
    expect(delta.type).toBeDefined();
    expect(delta.origin_account_id).toBe(TEST_ACCOUNT_ID);
  });

  it("dispatches to CalDAV normalizer for provider='caldav'", () => {
    // Use a minimal ParsedVEvent shape
    const caldavEvent = {
      uid: "caldav-evt-123@icloud.com",
      summary: "Apple Calendar Meeting",
      dtstart: "20250615T090000Z",
      dtend: "20250615T093000Z",
    };
    const delta = normalizeProviderEvent("caldav", caldavEvent, TEST_ACCOUNT_ID, "origin");
    expect(delta.type).toBe("updated");
    expect(delta.origin_event_id).toBe("caldav-evt-123@icloud.com");
    expect(delta.origin_account_id).toBe(TEST_ACCOUNT_ID);
    expect(delta.event).toBeDefined();
    expect(delta.event!.title).toBe("Apple Calendar Meeting");
  });
});

// ---------------------------------------------------------------------------
// createCalendarProvider factory
// ---------------------------------------------------------------------------

describe("createCalendarProvider", () => {
  it("returns a GoogleCalendarClient for provider='google'", () => {
    const provider = createCalendarProvider("google", "test-token");
    expect(provider).toBeInstanceOf(GoogleCalendarClient);
  });

  it("returned provider implements CalendarProvider interface", () => {
    const provider: CalendarProvider = createCalendarProvider("google", "test-token");

    expect(typeof provider.listEvents).toBe("function");
    expect(typeof provider.insertEvent).toBe("function");
    expect(typeof provider.patchEvent).toBe("function");
    expect(typeof provider.deleteEvent).toBe("function");
    expect(typeof provider.listCalendars).toBe("function");
    expect(typeof provider.insertCalendar).toBe("function");
    expect(typeof provider.watchEvents).toBe("function");
    expect(typeof provider.stopChannel).toBe("function");
  });

  it("passes fetchFn to GoogleCalendarClient when provided", async () => {
    const mockFetch: FetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const provider = createCalendarProvider("google", "test-token", mockFetch);
    await provider.listEvents("primary");

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("returns a MicrosoftCalendarClient for provider='microsoft'", () => {
    const provider = createCalendarProvider("microsoft", "test-token");
    expect(provider).toBeDefined();
    expect(typeof provider.listEvents).toBe("function");
  });

  it("returns a CalDavClient for provider='caldav'", () => {
    const config = JSON.stringify({
      appleId: "test@icloud.com",
      appSpecificPassword: "xxxx-xxxx-xxxx-xxxx",
    });
    const provider = createCalendarProvider("caldav", config);
    expect(provider).toBeDefined();
    expect(typeof provider.listCalendars).toBe("function");
    expect(typeof provider.listEvents).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Integration: classify + normalize pipeline
// ---------------------------------------------------------------------------

describe("Provider pipeline: classify then normalize", () => {
  it("classifies and normalizes a Google origin event end-to-end", () => {
    const event = makeGoogleEvent();
    const strategy = getClassificationStrategy("google");
    const classification = strategy.classify(event);
    const delta = normalizeProviderEvent("google", event, TEST_ACCOUNT_ID, classification);

    expect(classification).toBe("origin");
    expect(delta.type).toBe("updated");
    expect(delta.event).toBeDefined();
    expect(delta.event!.title).toBe("Team standup");
  });

  it("classifies and normalizes a Google managed_mirror event end-to-end", () => {
    const event = makeGoogleEvent({
      extendedProperties: {
        private: { tminus: "true", managed: "true" },
      },
    });
    const strategy = getClassificationStrategy("google");
    const classification = strategy.classify(event);
    const delta = normalizeProviderEvent("google", event, TEST_ACCOUNT_ID, classification);

    expect(classification).toBe("managed_mirror");
    expect(delta.type).toBe("updated");
    expect(delta.event).toBeUndefined(); // Invariant E: no payload for mirrors
  });

  it("classifies and normalizes a Google cancelled event end-to-end", () => {
    const event = makeGoogleEvent({ status: "cancelled" });
    const strategy = getClassificationStrategy("google");
    const classification = strategy.classify(event);
    const delta = normalizeProviderEvent("google", event, TEST_ACCOUNT_ID, classification);

    expect(classification).toBe("origin"); // cancelled is still origin classification
    expect(delta.type).toBe("deleted");
    expect(delta.event).toBeUndefined();
  });
});
