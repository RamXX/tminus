/**
 * Unit tests for event-form utilities.
 *
 * Tests cover:
 * - Form validation (required title, start before end, required fields)
 * - Payload construction (buildCreatePayload)
 * - Optimistic update helpers (add, replace, remove)
 * - Default form values
 * - Edge cases
 */
import { describe, it, expect } from "vitest";
import {
  validateEventForm,
  hasErrors,
  buildCreatePayload,
  createOptimisticEvent,
  addOptimisticEvent,
  replaceOptimisticEvent,
  removeOptimisticEvent,
  createDefaultFormValues,
  getLocalTimezone,
  updateOptimisticEvent,
  deleteOptimisticEvent,
  buildUpdatePayload,
  createEditFormValues,
  type EventFormValues,
} from "./event-form";
import type { CalendarEvent, CreateEventPayload } from "./api";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validForm(overrides: Partial<EventFormValues> = {}): EventFormValues {
  return {
    title: "Team Meeting",
    startDate: "2026-02-14",
    startTime: "09:00",
    endDate: "2026-02-14",
    endTime: "10:00",
    timezone: "America/New_York",
    description: "Discuss Q1 goals",
    location: "Conference Room A",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// validateEventForm
// ---------------------------------------------------------------------------

describe("validateEventForm", () => {
  it("returns no errors for a valid form", () => {
    const errors = validateEventForm(validForm());
    expect(errors).toEqual({});
  });

  it("returns error when title is empty", () => {
    const errors = validateEventForm(validForm({ title: "" }));
    expect(errors.title).toBe("Title is required");
  });

  it("returns error when title is only whitespace", () => {
    const errors = validateEventForm(validForm({ title: "   " }));
    expect(errors.title).toBe("Title is required");
  });

  it("returns error when start date is missing", () => {
    const errors = validateEventForm(validForm({ startDate: "" }));
    expect(errors.startDate).toBe("Start date is required");
  });

  it("returns error when start time is missing", () => {
    const errors = validateEventForm(validForm({ startTime: "" }));
    expect(errors.startTime).toBe("Start time is required");
  });

  it("returns error when end date is missing", () => {
    const errors = validateEventForm(validForm({ endDate: "" }));
    expect(errors.endDate).toBe("End date is required");
  });

  it("returns error when end time is missing", () => {
    const errors = validateEventForm(validForm({ endTime: "" }));
    expect(errors.endTime).toBe("End time is required");
  });

  it("returns error when end is before start (same day)", () => {
    const errors = validateEventForm(
      validForm({ startTime: "14:00", endTime: "10:00" }),
    );
    expect(errors.endTime).toBe("End time must be after start time");
  });

  it("returns error when end equals start", () => {
    const errors = validateEventForm(
      validForm({ startTime: "10:00", endTime: "10:00" }),
    );
    expect(errors.endTime).toBe("End time must be after start time");
  });

  it("returns error when end date is before start date", () => {
    const errors = validateEventForm(
      validForm({ startDate: "2026-02-15", endDate: "2026-02-14" }),
    );
    expect(errors.endTime).toBe("End time must be after start time");
  });

  it("allows end on a later day even if end time is earlier", () => {
    // 2/14 at 22:00 to 2/15 at 08:00 -- valid (overnight event)
    const errors = validateEventForm(
      validForm({
        startDate: "2026-02-14",
        startTime: "22:00",
        endDate: "2026-02-15",
        endTime: "08:00",
      }),
    );
    expect(errors).toEqual({});
  });

  it("returns multiple errors simultaneously", () => {
    const errors = validateEventForm(
      validForm({ title: "", startDate: "", endTime: "" }),
    );
    expect(errors.title).toBeDefined();
    expect(errors.startDate).toBeDefined();
    expect(errors.endTime).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// hasErrors
// ---------------------------------------------------------------------------

describe("hasErrors", () => {
  it("returns false for empty errors object", () => {
    expect(hasErrors({})).toBe(false);
  });

  it("returns true when errors are present", () => {
    expect(hasErrors({ title: "Title is required" })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildCreatePayload
// ---------------------------------------------------------------------------

describe("buildCreatePayload", () => {
  it("builds correct payload from form values", () => {
    const payload = buildCreatePayload(validForm());
    expect(payload).toEqual({
      summary: "Team Meeting",
      start: "2026-02-14T09:00:00",
      end: "2026-02-14T10:00:00",
      timezone: "America/New_York",
      description: "Discuss Q1 goals",
      location: "Conference Room A",
      source: "ui",
    });
  });

  it("trims whitespace from title", () => {
    const payload = buildCreatePayload(validForm({ title: "  Standup  " }));
    expect(payload.summary).toBe("Standup");
  });

  it("omits empty description", () => {
    const payload = buildCreatePayload(validForm({ description: "" }));
    expect(payload.description).toBeUndefined();
  });

  it("omits whitespace-only description", () => {
    const payload = buildCreatePayload(validForm({ description: "   " }));
    expect(payload.description).toBeUndefined();
  });

  it("omits empty location", () => {
    const payload = buildCreatePayload(validForm({ location: "" }));
    expect(payload.location).toBeUndefined();
  });

  it("omits empty timezone", () => {
    const payload = buildCreatePayload(validForm({ timezone: "" }));
    expect(payload.timezone).toBeUndefined();
  });

  it("always sets source to 'ui'", () => {
    const payload = buildCreatePayload(validForm());
    expect(payload.source).toBe("ui");
  });
});

// ---------------------------------------------------------------------------
// createOptimisticEvent
// ---------------------------------------------------------------------------

describe("createOptimisticEvent", () => {
  const payload: CreateEventPayload = {
    summary: "Quick Sync",
    start: "2026-02-14T09:00:00",
    end: "2026-02-14T09:30:00",
    timezone: "UTC",
    description: "Brief check-in",
    location: "Zoom",
    source: "ui",
  };

  it("creates event with temp- prefixed ID", () => {
    const evt = createOptimisticEvent(payload);
    expect(evt.canonical_event_id).toMatch(/^temp-/);
  });

  it("maps payload fields to event fields", () => {
    const evt = createOptimisticEvent(payload);
    expect(evt.summary).toBe("Quick Sync");
    expect(evt.start).toBe("2026-02-14T09:00:00");
    expect(evt.end).toBe("2026-02-14T09:30:00");
    expect(evt.description).toBe("Brief check-in");
    expect(evt.location).toBe("Zoom");
  });

  it("sets status to pending", () => {
    const evt = createOptimisticEvent(payload);
    expect(evt.status).toBe("pending");
  });

  it("generates unique IDs on each call", () => {
    const a = createOptimisticEvent(payload);
    const b = createOptimisticEvent(payload);
    expect(a.canonical_event_id).not.toBe(b.canonical_event_id);
  });
});

// ---------------------------------------------------------------------------
// Optimistic update helpers
// ---------------------------------------------------------------------------

describe("addOptimisticEvent", () => {
  const existing: CalendarEvent[] = [
    { canonical_event_id: "evt-1", summary: "Existing", start: "2026-02-14T09:00:00Z", end: "2026-02-14T10:00:00Z" },
  ];
  const newEvt: CalendarEvent = {
    canonical_event_id: "temp-123",
    summary: "New",
    start: "2026-02-14T11:00:00Z",
    end: "2026-02-14T12:00:00Z",
  };

  it("adds event to list without mutation", () => {
    const result = addOptimisticEvent(existing, newEvt);
    expect(result).toHaveLength(2);
    expect(result[1]).toBe(newEvt);
    // Original array unchanged
    expect(existing).toHaveLength(1);
  });
});

describe("replaceOptimisticEvent", () => {
  const events: CalendarEvent[] = [
    { canonical_event_id: "evt-1", summary: "Keep", start: "s", end: "e" },
    { canonical_event_id: "temp-123", summary: "Temp", start: "s", end: "e" },
  ];
  const real: CalendarEvent = {
    canonical_event_id: "evt-2",
    summary: "Real",
    start: "s",
    end: "e",
    version: 1,
  };

  it("replaces temp event with real event", () => {
    const result = replaceOptimisticEvent(events, "temp-123", real);
    expect(result).toHaveLength(2);
    expect(result[0].canonical_event_id).toBe("evt-1");
    expect(result[1].canonical_event_id).toBe("evt-2");
    expect(result[1].summary).toBe("Real");
  });

  it("does not mutate original array", () => {
    replaceOptimisticEvent(events, "temp-123", real);
    expect(events[1].canonical_event_id).toBe("temp-123");
  });
});

describe("removeOptimisticEvent", () => {
  const events: CalendarEvent[] = [
    { canonical_event_id: "evt-1", summary: "Keep", start: "s", end: "e" },
    { canonical_event_id: "temp-123", summary: "Remove", start: "s", end: "e" },
  ];

  it("removes the temp event (rollback)", () => {
    const result = removeOptimisticEvent(events, "temp-123");
    expect(result).toHaveLength(1);
    expect(result[0].canonical_event_id).toBe("evt-1");
  });

  it("does not mutate original array", () => {
    removeOptimisticEvent(events, "temp-123");
    expect(events).toHaveLength(2);
  });

  it("returns same content if temp ID not found", () => {
    const result = removeOptimisticEvent(events, "temp-999");
    expect(result).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// createDefaultFormValues
// ---------------------------------------------------------------------------

describe("createDefaultFormValues", () => {
  it("creates form values from a date", () => {
    const d = new Date("2026-02-14T09:00:00");
    const values = createDefaultFormValues(d);
    expect(values.startDate).toBe("2026-02-14");
    expect(values.startTime).toBe("09:00");
    expect(values.title).toBe("");
    expect(values.description).toBe("");
    expect(values.location).toBe("");
  });

  it("defaults to 1-hour duration", () => {
    const d = new Date("2026-02-14T09:00:00");
    const values = createDefaultFormValues(d);
    expect(values.endDate).toBe("2026-02-14");
    expect(values.endTime).toBe("10:00");
  });

  it("supports custom duration", () => {
    const d = new Date("2026-02-14T09:00:00");
    const values = createDefaultFormValues(d, 30);
    expect(values.endTime).toBe("09:30");
  });

  it("sets timezone to local timezone", () => {
    const d = new Date("2026-02-14T09:00:00");
    const values = createDefaultFormValues(d);
    // Should be a non-empty string (actual value depends on test environment)
    expect(values.timezone.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// getLocalTimezone
// ---------------------------------------------------------------------------

describe("getLocalTimezone", () => {
  it("returns a non-empty string", () => {
    const tz = getLocalTimezone();
    expect(tz.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// updateOptimisticEvent
// ---------------------------------------------------------------------------

describe("updateOptimisticEvent", () => {
  const events: CalendarEvent[] = [
    { canonical_event_id: "evt-1", summary: "Meeting", start: "2026-02-14T09:00:00", end: "2026-02-14T10:00:00", description: "Original desc" },
    { canonical_event_id: "evt-2", summary: "Lunch", start: "2026-02-14T12:00:00", end: "2026-02-14T13:00:00" },
  ];

  it("updates the matching event's summary", () => {
    const result = updateOptimisticEvent(events, "evt-1", { summary: "Updated Meeting" });
    expect(result[0].summary).toBe("Updated Meeting");
    expect(result[1].summary).toBe("Lunch");
  });

  it("updates multiple fields at once", () => {
    const result = updateOptimisticEvent(events, "evt-1", {
      summary: "New Title",
      start: "2026-02-14T10:00:00",
      description: "New desc",
    });
    expect(result[0].summary).toBe("New Title");
    expect(result[0].start).toBe("2026-02-14T10:00:00");
    expect(result[0].description).toBe("New desc");
  });

  it("does not mutate original array", () => {
    updateOptimisticEvent(events, "evt-1", { summary: "Changed" });
    expect(events[0].summary).toBe("Meeting");
  });

  it("returns same-length array when ID not found", () => {
    const result = updateOptimisticEvent(events, "evt-999", { summary: "Nope" });
    expect(result).toHaveLength(2);
    expect(result[0].summary).toBe("Meeting");
  });

  it("preserves other fields when updating one field", () => {
    const result = updateOptimisticEvent(events, "evt-1", { summary: "New" });
    expect(result[0].start).toBe("2026-02-14T09:00:00");
    expect(result[0].end).toBe("2026-02-14T10:00:00");
    expect(result[0].description).toBe("Original desc");
  });
});

// ---------------------------------------------------------------------------
// deleteOptimisticEvent
// ---------------------------------------------------------------------------

describe("deleteOptimisticEvent", () => {
  const events: CalendarEvent[] = [
    { canonical_event_id: "evt-1", summary: "Keep", start: "s", end: "e" },
    { canonical_event_id: "evt-2", summary: "Delete", start: "s", end: "e" },
    { canonical_event_id: "evt-3", summary: "Also Keep", start: "s", end: "e" },
  ];

  it("removes the event with matching ID", () => {
    const result = deleteOptimisticEvent(events, "evt-2");
    expect(result).toHaveLength(2);
    expect(result.map((e) => e.canonical_event_id)).toEqual(["evt-1", "evt-3"]);
  });

  it("does not mutate original array", () => {
    deleteOptimisticEvent(events, "evt-2");
    expect(events).toHaveLength(3);
  });

  it("returns same array if ID not found", () => {
    const result = deleteOptimisticEvent(events, "evt-999");
    expect(result).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// buildUpdatePayload
// ---------------------------------------------------------------------------

describe("buildUpdatePayload", () => {
  const original: CalendarEvent = {
    canonical_event_id: "evt-1",
    summary: "Team Meeting",
    start: "2026-02-14T09:00:00",
    end: "2026-02-14T10:00:00",
    description: "Discuss Q1",
    location: "Room A",
  };

  it("returns empty object when nothing changed", () => {
    const values = validForm({
      title: "Team Meeting",
      startDate: "2026-02-14",
      startTime: "09:00",
      endDate: "2026-02-14",
      endTime: "10:00",
      description: "Discuss Q1",
      location: "Room A",
    });
    const payload = buildUpdatePayload(original, values);
    expect(payload).toEqual({});
  });

  it("includes only changed fields (summary)", () => {
    const values = validForm({
      title: "Updated Title",
      startDate: "2026-02-14",
      startTime: "09:00",
      endDate: "2026-02-14",
      endTime: "10:00",
      description: "Discuss Q1",
      location: "Room A",
    });
    const payload = buildUpdatePayload(original, values);
    expect(payload).toEqual({ summary: "Updated Title" });
  });

  it("includes changed start time", () => {
    const values = validForm({
      title: "Team Meeting",
      startDate: "2026-02-14",
      startTime: "10:00",
      endDate: "2026-02-14",
      endTime: "10:00",
      description: "Discuss Q1",
      location: "Room A",
    });
    const payload = buildUpdatePayload(original, values);
    expect(payload.start).toBe("2026-02-14T10:00:00");
  });

  it("includes cleared description as empty string", () => {
    const values = validForm({
      title: "Team Meeting",
      startDate: "2026-02-14",
      startTime: "09:00",
      endDate: "2026-02-14",
      endTime: "10:00",
      description: "",
      location: "Room A",
    });
    const payload = buildUpdatePayload(original, values);
    expect(payload.description).toBe("");
  });

  it("includes multiple changed fields", () => {
    const values = validForm({
      title: "New Name",
      startDate: "2026-02-15",
      startTime: "11:00",
      endDate: "2026-02-15",
      endTime: "12:00",
      description: "New desc",
      location: "Room B",
    });
    const payload = buildUpdatePayload(original, values);
    expect(payload.summary).toBe("New Name");
    expect(payload.start).toBe("2026-02-15T11:00:00");
    expect(payload.end).toBe("2026-02-15T12:00:00");
    expect(payload.description).toBe("New desc");
    expect(payload.location).toBe("Room B");
  });
});

// ---------------------------------------------------------------------------
// createEditFormValues
// ---------------------------------------------------------------------------

describe("createEditFormValues", () => {
  it("creates form values from an event with all fields", () => {
    const event: CalendarEvent = {
      canonical_event_id: "evt-1",
      summary: "Test Event",
      start: "2026-02-14T09:00:00",
      end: "2026-02-14T10:30:00",
      description: "Some description",
      location: "Office",
    };
    const values = createEditFormValues(event);
    expect(values.title).toBe("Test Event");
    expect(values.startDate).toBe("2026-02-14");
    expect(values.startTime).toBe("09:00");
    expect(values.endDate).toBe("2026-02-14");
    expect(values.endTime).toBe("10:30");
    expect(values.description).toBe("Some description");
    expect(values.location).toBe("Office");
  });

  it("handles event with timezone suffix (Z)", () => {
    const event: CalendarEvent = {
      canonical_event_id: "evt-2",
      summary: "UTC Event",
      start: "2026-02-14T14:00:00Z",
      end: "2026-02-14T15:30:00Z",
    };
    const values = createEditFormValues(event);
    expect(values.startDate).toBe("2026-02-14");
    expect(values.startTime).toBe("14:00");
    expect(values.endDate).toBe("2026-02-14");
    expect(values.endTime).toBe("15:30");
  });

  it("defaults missing fields to empty strings", () => {
    const event: CalendarEvent = {
      canonical_event_id: "evt-3",
      start: "2026-02-14T09:00:00",
      end: "2026-02-14T10:00:00",
    };
    const values = createEditFormValues(event);
    expect(values.title).toBe("");
    expect(values.description).toBe("");
    expect(values.location).toBe("");
  });

  it("sets timezone to local timezone", () => {
    const event: CalendarEvent = {
      canonical_event_id: "evt-4",
      start: "2026-02-14T09:00:00",
      end: "2026-02-14T10:00:00",
    };
    const values = createEditFormValues(event);
    expect(values.timezone.length).toBeGreaterThan(0);
  });
});
