/**
 * @tminus/shared -- Unit tests for the policy compiler.
 *
 * Tests projection logic (BUSY/TITLE/FULL), extendedProperties,
 * all-day event handling, and edge cases.
 */
import { describe, it, expect } from "vitest";
import type {
  CanonicalEvent,
  EventId,
  AccountId,
  PolicyEdge,
  ProjectedEvent,
} from "./types";
import { compileProjection } from "./policy";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const now = "2025-06-15T12:00:00Z";

function makeEvent(overrides: Partial<CanonicalEvent> = {}): CanonicalEvent {
  return {
    canonical_event_id: "evt_01HXYZ12345678901234AB" as EventId,
    origin_account_id: "acc_01HXYZ12345678901234AB" as AccountId,
    origin_event_id: "google_evt_abc",
    title: "Team standup",
    description: "Daily sync with the team",
    location: "Zoom - https://zoom.us/j/123",
    start: { dateTime: "2025-06-15T09:00:00Z" },
    end: { dateTime: "2025-06-15T09:30:00Z" },
    all_day: false,
    status: "confirmed",
    visibility: "default",
    transparency: "opaque",
    source: "provider",
    version: 1,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function makeEdge(overrides: Partial<PolicyEdge> = {}): PolicyEdge {
  return {
    detail_level: "BUSY",
    calendar_kind: "BUSY_OVERLAY",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// BUSY projection
// ---------------------------------------------------------------------------

describe("compileProjection -- BUSY", () => {
  it("produces summary 'Busy' regardless of event title", () => {
    const result = compileProjection(makeEvent(), makeEdge({ detail_level: "BUSY" }));
    expect(result.summary).toBe("Busy");
  });

  it("sets visibility to 'private'", () => {
    const result = compileProjection(makeEvent(), makeEdge({ detail_level: "BUSY" }));
    expect(result.visibility).toBe("private");
  });

  it("does NOT include description", () => {
    const result = compileProjection(makeEvent(), makeEdge({ detail_level: "BUSY" }));
    expect(result.description).toBeUndefined();
  });

  it("does NOT include location", () => {
    const result = compileProjection(makeEvent(), makeEdge({ detail_level: "BUSY" }));
    expect(result.location).toBeUndefined();
  });

  it("preserves start/end times", () => {
    const result = compileProjection(makeEvent(), makeEdge({ detail_level: "BUSY" }));
    expect(result.start).toEqual({ dateTime: "2025-06-15T09:00:00Z" });
    expect(result.end).toEqual({ dateTime: "2025-06-15T09:30:00Z" });
  });

  it("preserves transparency", () => {
    const result = compileProjection(
      makeEvent({ transparency: "transparent" }),
      makeEdge({ detail_level: "BUSY" }),
    );
    expect(result.transparency).toBe("transparent");
  });
});

// ---------------------------------------------------------------------------
// TITLE projection
// ---------------------------------------------------------------------------

describe("compileProjection -- TITLE", () => {
  it("uses actual event title as summary", () => {
    const result = compileProjection(
      makeEvent({ title: "Important meeting" }),
      makeEdge({ detail_level: "TITLE" }),
    );
    expect(result.summary).toBe("Important meeting");
  });

  it("falls back to 'Busy' when title is undefined", () => {
    const result = compileProjection(
      makeEvent({ title: undefined }),
      makeEdge({ detail_level: "TITLE" }),
    );
    expect(result.summary).toBe("Busy");
  });

  it("sets visibility to 'default'", () => {
    const result = compileProjection(makeEvent(), makeEdge({ detail_level: "TITLE" }));
    expect(result.visibility).toBe("default");
  });

  it("does NOT include description", () => {
    const result = compileProjection(makeEvent(), makeEdge({ detail_level: "TITLE" }));
    expect(result.description).toBeUndefined();
  });

  it("does NOT include location", () => {
    const result = compileProjection(makeEvent(), makeEdge({ detail_level: "TITLE" }));
    expect(result.location).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// FULL projection
// ---------------------------------------------------------------------------

describe("compileProjection -- FULL", () => {
  it("uses actual event title as summary", () => {
    const result = compileProjection(makeEvent(), makeEdge({ detail_level: "FULL" }));
    expect(result.summary).toBe("Team standup");
  });

  it("falls back to 'Busy' when title is undefined", () => {
    const result = compileProjection(
      makeEvent({ title: undefined }),
      makeEdge({ detail_level: "FULL" }),
    );
    expect(result.summary).toBe("Busy");
  });

  it("includes description", () => {
    const result = compileProjection(makeEvent(), makeEdge({ detail_level: "FULL" }));
    expect(result.description).toBe("Daily sync with the team");
  });

  it("includes location", () => {
    const result = compileProjection(makeEvent(), makeEdge({ detail_level: "FULL" }));
    expect(result.location).toBe("Zoom - https://zoom.us/j/123");
  });

  it("sets visibility to 'default'", () => {
    const result = compileProjection(makeEvent(), makeEdge({ detail_level: "FULL" }));
    expect(result.visibility).toBe("default");
  });

  it("omits description when undefined on canonical event", () => {
    const result = compileProjection(
      makeEvent({ description: undefined }),
      makeEdge({ detail_level: "FULL" }),
    );
    expect(result.description).toBeUndefined();
  });

  it("omits location when undefined on canonical event", () => {
    const result = compileProjection(
      makeEvent({ location: undefined }),
      makeEdge({ detail_level: "FULL" }),
    );
    expect(result.location).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// extendedProperties -- ALWAYS set
// ---------------------------------------------------------------------------

describe("compileProjection -- extendedProperties", () => {
  for (const detail_level of ["BUSY", "TITLE", "FULL"] as const) {
    it(`sets extendedProperties for ${detail_level}`, () => {
      const event = makeEvent();
      const result = compileProjection(event, makeEdge({ detail_level }));
      expect(result.extendedProperties).toEqual({
        private: {
          tminus: "true",
          managed: "true",
          canonical_event_id: event.canonical_event_id,
          origin_account_id: event.origin_account_id,
        },
      });
    });
  }
});

// ---------------------------------------------------------------------------
// All-day events
// ---------------------------------------------------------------------------

describe("compileProjection -- all-day events", () => {
  it("produces {date} not {dateTime} for all-day events", () => {
    const event = makeEvent({
      all_day: true,
      start: { dateTime: "2025-06-15T00:00:00Z" },
      end: { dateTime: "2025-06-16T00:00:00Z" },
    });
    const result = compileProjection(event, makeEdge());

    // All-day events must produce date-only EventDateTime
    expect(result.start.date).toBeDefined();
    expect(result.start.dateTime).toBeUndefined();
    expect(result.end.date).toBeDefined();
    expect(result.end.dateTime).toBeUndefined();
  });

  it("extracts date portion from dateTime for all-day events", () => {
    const event = makeEvent({
      all_day: true,
      start: { dateTime: "2025-06-15T00:00:00Z" },
      end: { dateTime: "2025-06-16T00:00:00Z" },
    });
    const result = compileProjection(event, makeEdge());
    expect(result.start.date).toBe("2025-06-15");
    expect(result.end.date).toBe("2025-06-16");
  });

  it("handles all-day events that already have date field", () => {
    const event = makeEvent({
      all_day: true,
      start: { date: "2025-06-15" },
      end: { date: "2025-06-16" },
    });
    const result = compileProjection(event, makeEdge());
    expect(result.start.date).toBe("2025-06-15");
    expect(result.end.date).toBe("2025-06-16");
    expect(result.start.dateTime).toBeUndefined();
  });

  it("does not include timeZone for all-day events", () => {
    const event = makeEvent({
      all_day: true,
      start: { dateTime: "2025-06-15T00:00:00Z", timeZone: "America/Chicago" },
      end: { dateTime: "2025-06-16T00:00:00Z", timeZone: "America/Chicago" },
    });
    const result = compileProjection(event, makeEdge());
    expect(result.start.timeZone).toBeUndefined();
    expect(result.end.timeZone).toBeUndefined();
  });

  it("timed events preserve timeZone", () => {
    const event = makeEvent({
      all_day: false,
      start: { dateTime: "2025-06-15T09:00:00", timeZone: "America/Chicago" },
      end: { dateTime: "2025-06-15T10:00:00", timeZone: "America/Chicago" },
    });
    const result = compileProjection(event, makeEdge());
    expect(result.start.timeZone).toBe("America/Chicago");
    expect(result.end.timeZone).toBe("America/Chicago");
    expect(result.start.dateTime).toBe("2025-06-15T09:00:00");
    expect(result.start.date).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Determinism (same input => same output)
// ---------------------------------------------------------------------------

describe("compileProjection -- determinism (BR-3)", () => {
  it("produces identical output for identical inputs across calls", () => {
    const event = makeEvent();
    const edge = makeEdge({ detail_level: "FULL" });
    const result1 = compileProjection(event, edge);
    const result2 = compileProjection(event, edge);
    expect(result1).toEqual(result2);
  });
});
