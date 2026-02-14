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

  it("returns false for 'microsoft' (not yet implemented)", () => {
    expect(isSupportedProvider("microsoft")).toBe(false);
  });

  it("returns false for 'caldav' (not yet implemented)", () => {
    expect(isSupportedProvider("caldav")).toBe(false);
  });

  it("returns false for arbitrary strings", () => {
    expect(isSupportedProvider("yahoo")).toBe(false);
    expect(isSupportedProvider("")).toBe(false);
    expect(isSupportedProvider("GOOGLE")).toBe(false);
  });
});

describe("SUPPORTED_PROVIDERS", () => {
  it("contains only 'google' in Phase 1", () => {
    expect(SUPPORTED_PROVIDERS).toEqual(["google"]);
  });

  it("is readonly (frozen at the type level)", () => {
    // TypeScript enforces readonly, but we can verify it's an array
    expect(Array.isArray(SUPPORTED_PROVIDERS)).toBe(true);
    expect(SUPPORTED_PROVIDERS.length).toBe(1);
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

  it("throws for 'microsoft' (unsupported in Phase 1)", () => {
    expect(() => getClassificationStrategy("microsoft" as ProviderType)).toThrow(
      /no classification strategy/i,
    );
  });

  it("throws for 'caldav' (unsupported in Phase 1)", () => {
    expect(() => getClassificationStrategy("caldav" as ProviderType)).toThrow(
      /no classification strategy/i,
    );
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

  it("throws for unsupported provider 'microsoft'", () => {
    const event = makeGoogleEvent();
    expect(() =>
      normalizeProviderEvent("microsoft" as ProviderType, event, TEST_ACCOUNT_ID, "origin"),
    ).toThrow(/no normalizer/i);
  });

  it("throws for unsupported provider 'caldav'", () => {
    const event = makeGoogleEvent();
    expect(() =>
      normalizeProviderEvent("caldav" as ProviderType, event, TEST_ACCOUNT_ID, "origin"),
    ).toThrow(/no normalizer/i);
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

  it("throws for unsupported provider 'microsoft'", () => {
    expect(() =>
      createCalendarProvider("microsoft" as ProviderType, "test-token"),
    ).toThrow(/cannot create provider/i);
  });

  it("throws for unsupported provider 'caldav'", () => {
    expect(() =>
      createCalendarProvider("caldav" as ProviderType, "test-token"),
    ).toThrow(/cannot create provider/i);
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
