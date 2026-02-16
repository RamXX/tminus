/**
 * @tminus/shared -- Unit tests for event classification (Invariants A & E).
 *
 * classifyEvent determines whether a Google Calendar event is:
 * - 'origin': a real user event T-Minus should track
 * - 'managed_mirror': a mirror event created by T-Minus (loop prevention)
 *
 * These tests verify that ONLY tminus='true' AND managed='true' produces
 * managed_mirror. All other cases produce 'origin'. This is critical for
 * preventing infinite sync loops (Risk R1).
 */
import { describe, it, expect } from "vitest";
import type { GoogleCalendarEvent } from "./types";
import { classifyEvent } from "./classify";

// ---------------------------------------------------------------------------
// Helper: build a GoogleCalendarEvent with optional overrides
// ---------------------------------------------------------------------------

function makeProviderEvent(
  overrides: Partial<GoogleCalendarEvent> = {},
): GoogleCalendarEvent {
  return {
    id: "google_evt_abc123",
    summary: "Team standup",
    start: { dateTime: "2025-06-15T09:00:00Z" },
    end: { dateTime: "2025-06-15T09:30:00Z" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// origin classification
// ---------------------------------------------------------------------------

describe("classifyEvent -- origin events", () => {
  it("classifies event with no extendedProperties as origin", () => {
    const event = makeProviderEvent(); // no extendedProperties field at all
    expect(classifyEvent(event)).toBe("origin");
  });

  it("classifies event with undefined extendedProperties as origin", () => {
    const event = makeProviderEvent({ extendedProperties: undefined });
    expect(classifyEvent(event)).toBe("origin");
  });

  it("classifies event with empty private properties as origin", () => {
    const event = makeProviderEvent({
      extendedProperties: { private: {} },
    });
    expect(classifyEvent(event)).toBe("origin");
  });

  it("classifies event with random other extended properties as origin", () => {
    const event = makeProviderEvent({
      extendedProperties: {
        private: {
          someOtherApp: "true",
          anotherKey: "value",
        },
      },
    });
    expect(classifyEvent(event)).toBe("origin");
  });

  it("classifies event with tminus='true' but managed missing as origin (defensive)", () => {
    const event = makeProviderEvent({
      extendedProperties: {
        private: { tminus: "true" },
      },
    });
    expect(classifyEvent(event)).toBe("origin");
  });

  it("classifies event with managed='true' but tminus missing as origin", () => {
    const event = makeProviderEvent({
      extendedProperties: {
        private: { managed: "true" },
      },
    });
    expect(classifyEvent(event)).toBe("origin");
  });

  it("classifies event with tminus='false' and managed='true' as origin", () => {
    const event = makeProviderEvent({
      extendedProperties: {
        private: { tminus: "false", managed: "true" },
      },
    });
    expect(classifyEvent(event)).toBe("origin");
  });

  it("classifies event with tminus='true' and managed='false' as origin", () => {
    const event = makeProviderEvent({
      extendedProperties: {
        private: { tminus: "true", managed: "false" },
      },
    });
    expect(classifyEvent(event)).toBe("origin");
  });

  it("classifies event with only shared properties (no private) as origin", () => {
    const event = makeProviderEvent({
      extendedProperties: {
        shared: { tminus: "true", managed: "true" },
      },
    });
    expect(classifyEvent(event)).toBe("origin");
  });

  it("classifies event with private undefined but shared present as origin", () => {
    const event = makeProviderEvent({
      extendedProperties: {
        private: undefined,
        shared: { someKey: "someValue" },
      },
    });
    expect(classifyEvent(event)).toBe("origin");
  });
});

// ---------------------------------------------------------------------------
// managed_mirror classification
// ---------------------------------------------------------------------------

describe("classifyEvent -- managed_mirror events", () => {
  it("classifies event with tminus='true' AND managed='true' as managed_mirror", () => {
    const event = makeProviderEvent({
      extendedProperties: {
        private: {
          tminus: "true",
          managed: "true",
          canonical_event_id: "evt_01HXYZ000012345678901234AB",
          origin_account_id: "acc_01HXYZ000012345678901234AB",
        },
      },
    });
    expect(classifyEvent(event)).toBe("managed_mirror");
  });

  it("classifies event with only tminus and managed (no other keys) as managed_mirror", () => {
    const event = makeProviderEvent({
      extendedProperties: {
        private: {
          tminus: "true",
          managed: "true",
        },
      },
    });
    expect(classifyEvent(event)).toBe("managed_mirror");
  });

  it("classifies event with tminus+managed plus extra keys as managed_mirror", () => {
    const event = makeProviderEvent({
      extendedProperties: {
        private: {
          tminus: "true",
          managed: "true",
          extraKey: "extraValue",
        },
      },
    });
    expect(classifyEvent(event)).toBe("managed_mirror");
  });
});

// ---------------------------------------------------------------------------
// Purity and determinism
// ---------------------------------------------------------------------------

describe("classifyEvent -- purity", () => {
  it("is a pure function: same input always produces same output", () => {
    const event = makeProviderEvent({
      extendedProperties: {
        private: { tminus: "true", managed: "true" },
      },
    });
    const result1 = classifyEvent(event);
    const result2 = classifyEvent(event);
    const result3 = classifyEvent(event);
    expect(result1).toBe(result2);
    expect(result2).toBe(result3);
  });

  it("does not mutate the input event", () => {
    const event = makeProviderEvent({
      extendedProperties: {
        private: { tminus: "true", managed: "true" },
      },
    });
    const eventCopy = JSON.parse(JSON.stringify(event));
    classifyEvent(event);
    expect(event).toEqual(eventCopy);
  });
});

// ---------------------------------------------------------------------------
// Return type exhaustiveness
// ---------------------------------------------------------------------------

describe("classifyEvent -- return type", () => {
  it("only returns valid EventClassification values", () => {
    const validValues = new Set(["origin", "managed_mirror", "foreign_managed"]);

    const testCases: GoogleCalendarEvent[] = [
      makeProviderEvent(),
      makeProviderEvent({ extendedProperties: undefined }),
      makeProviderEvent({ extendedProperties: { private: {} } }),
      makeProviderEvent({ extendedProperties: { private: { tminus: "true" } } }),
      makeProviderEvent({ extendedProperties: { private: { managed: "true" } } }),
      makeProviderEvent({
        extendedProperties: { private: { tminus: "true", managed: "true" } },
      }),
      makeProviderEvent({
        extendedProperties: { private: { someApp: "data" } },
      }),
    ];

    for (const event of testCases) {
      const result = classifyEvent(event);
      expect(validValues.has(result)).toBe(true);
    }
  });
});
