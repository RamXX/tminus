/**
 * Event creation form utilities.
 *
 * Pure functions for form validation, payload construction, and
 * optimistic update logic. No React dependencies -- easy to unit test.
 */
import type { CalendarEvent, CreateEventPayload, UpdateEventPayload } from "./api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Form field values for event creation. */
export interface EventFormValues {
  title: string;
  startDate: string; // "YYYY-MM-DD"
  startTime: string; // "HH:MM" (24-hour)
  endDate: string;   // "YYYY-MM-DD"
  endTime: string;   // "HH:MM" (24-hour)
  timezone: string;  // IANA timezone string (e.g. "America/New_York")
  description: string;
  location: string;
}

/** Validation error map. Key = field name, value = error message. */
export type EventFormErrors = Partial<Record<keyof EventFormValues, string>>;

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Get the user's local IANA timezone. Falls back to UTC. */
export function getLocalTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

/** Create a default form values object for a given date/time. */
export function createDefaultFormValues(
  date: Date,
  durationMinutes = 60,
): EventFormValues {
  const startDate = formatDateLocal(date);
  const startTime = formatTimeLocal(date);

  const endDate_ = new Date(date.getTime() + durationMinutes * 60 * 1000);
  const endDate = formatDateLocal(endDate_);
  const endTime = formatTimeLocal(endDate_);

  return {
    title: "",
    startDate,
    startTime,
    endDate,
    endTime,
    timezone: getLocalTimezone(),
    description: "",
    location: "",
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate event form values. Returns an errors object.
 * Empty object means the form is valid.
 */
export function validateEventForm(values: EventFormValues): EventFormErrors {
  const errors: EventFormErrors = {};

  // Title is required
  if (!values.title.trim()) {
    errors.title = "Title is required";
  }

  // Start date/time required
  if (!values.startDate) {
    errors.startDate = "Start date is required";
  }
  if (!values.startTime) {
    errors.startTime = "Start time is required";
  }

  // End date/time required
  if (!values.endDate) {
    errors.endDate = "End date is required";
  }
  if (!values.endTime) {
    errors.endTime = "End time is required";
  }

  // Start must be before end (only check if both are present)
  if (values.startDate && values.startTime && values.endDate && values.endTime) {
    const start = new Date(`${values.startDate}T${values.startTime}`);
    const end = new Date(`${values.endDate}T${values.endTime}`);
    if (!isNaN(start.getTime()) && !isNaN(end.getTime()) && start >= end) {
      errors.endTime = "End time must be after start time";
    }
  }

  return errors;
}

/** Check whether a form errors object has any errors. */
export function hasErrors(errors: EventFormErrors): boolean {
  return Object.keys(errors).length > 0;
}

// ---------------------------------------------------------------------------
// Payload construction
// ---------------------------------------------------------------------------

/**
 * Build a CreateEventPayload from validated form values.
 * Converts local date/time + timezone into ISO strings for the API.
 */
export function buildCreatePayload(values: EventFormValues): CreateEventPayload {
  const start = `${values.startDate}T${values.startTime}:00`;
  const end = `${values.endDate}T${values.endTime}:00`;

  return {
    summary: values.title.trim(),
    start,
    end,
    timezone: values.timezone || undefined,
    description: values.description.trim() || undefined,
    location: values.location.trim() || undefined,
    source: "ui",
  };
}

// ---------------------------------------------------------------------------
// Optimistic update helpers
// ---------------------------------------------------------------------------

/**
 * Create a temporary CalendarEvent for optimistic rendering.
 * Uses a temporary ID prefixed with "temp-" that gets replaced
 * when the API responds with the real event.
 */
export function createOptimisticEvent(
  payload: CreateEventPayload,
): CalendarEvent {
  return {
    canonical_event_id: `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    summary: payload.summary,
    description: payload.description,
    location: payload.location,
    start: payload.start,
    end: payload.end,
    status: "pending",
    version: 1,
  };
}

/**
 * Apply an optimistic event addition to the current events list.
 * Returns a new array (does not mutate).
 */
export function addOptimisticEvent(
  events: CalendarEvent[],
  optimistic: CalendarEvent,
): CalendarEvent[] {
  return [...events, optimistic];
}

/**
 * Replace a temporary optimistic event with the real event from the API.
 * Returns a new array (does not mutate).
 */
export function replaceOptimisticEvent(
  events: CalendarEvent[],
  tempId: string,
  real: CalendarEvent,
): CalendarEvent[] {
  return events.map((e) => (e.canonical_event_id === tempId ? real : e));
}

/**
 * Remove a temporary optimistic event (rollback on failure).
 * Returns a new array (does not mutate).
 */
export function removeOptimisticEvent(
  events: CalendarEvent[],
  tempId: string,
): CalendarEvent[] {
  return events.filter((e) => e.canonical_event_id !== tempId);
}

// ---------------------------------------------------------------------------
// Optimistic edit helpers
// ---------------------------------------------------------------------------

/**
 * Apply an optimistic edit to an event in the events list.
 * Merges the update payload into the matching event.
 * Returns a new array (does not mutate).
 */
export function updateOptimisticEvent(
  events: CalendarEvent[],
  eventId: string,
  updates: UpdateEventPayload,
): CalendarEvent[] {
  return events.map((e) => {
    if (e.canonical_event_id !== eventId) return e;
    return {
      ...e,
      ...(updates.summary !== undefined && { summary: updates.summary }),
      ...(updates.start !== undefined && { start: updates.start }),
      ...(updates.end !== undefined && { end: updates.end }),
      ...(updates.description !== undefined && { description: updates.description }),
      ...(updates.location !== undefined && { location: updates.location }),
    };
  });
}

/**
 * Remove an event from the events list (optimistic delete).
 * Returns a new array (does not mutate).
 */
export function deleteOptimisticEvent(
  events: CalendarEvent[],
  eventId: string,
): CalendarEvent[] {
  return events.filter((e) => e.canonical_event_id !== eventId);
}

/**
 * Build an UpdateEventPayload from edited form values and the original event.
 * Only includes fields that actually changed.
 */
export function buildUpdatePayload(
  original: CalendarEvent,
  values: EventFormValues,
): UpdateEventPayload {
  const payload: UpdateEventPayload = {};

  const newSummary = values.title.trim();
  if (newSummary !== (original.summary ?? "")) {
    payload.summary = newSummary;
  }

  const newStart = `${values.startDate}T${values.startTime}:00`;
  if (newStart !== original.start) {
    payload.start = newStart;
  }

  const newEnd = `${values.endDate}T${values.endTime}:00`;
  if (newEnd !== original.end) {
    payload.end = newEnd;
  }

  const newDescription = values.description.trim() || undefined;
  if (newDescription !== (original.description ?? undefined)) {
    payload.description = newDescription ?? "";
  }

  const newLocation = values.location.trim() || undefined;
  if (newLocation !== (original.location ?? undefined)) {
    payload.location = newLocation ?? "";
  }

  return payload;
}

/**
 * Create form values pre-populated from an existing event for editing.
 */
export function createEditFormValues(event: CalendarEvent): EventFormValues {
  // Parse start/end to extract date and time parts
  const startDate = extractDatePart(event.start);
  const startTime = extractTimePart(event.start);
  const endDate = extractDatePart(event.end);
  const endTime = extractTimePart(event.end);

  return {
    title: event.summary ?? "",
    startDate,
    startTime,
    endDate,
    endTime,
    timezone: getLocalTimezone(),
    description: event.description ?? "",
    location: event.location ?? "",
  };
}

/**
 * Extract the date part (YYYY-MM-DD) from an ISO-ish datetime string.
 * Handles both "2026-02-14T09:00:00" and "2026-02-14T09:00:00Z" formats.
 */
function extractDatePart(datetime: string): string {
  // Take the part before 'T'
  const tIndex = datetime.indexOf("T");
  if (tIndex === -1) return datetime.slice(0, 10);
  return datetime.slice(0, tIndex);
}

/**
 * Extract the time part (HH:MM) from an ISO-ish datetime string.
 */
function extractTimePart(datetime: string): string {
  const tIndex = datetime.indexOf("T");
  if (tIndex === -1) return "00:00";
  // Take HH:MM after the T
  return datetime.slice(tIndex + 1, tIndex + 6);
}

// ---------------------------------------------------------------------------
// Date/time formatting helpers
// ---------------------------------------------------------------------------

/** Format a Date as "YYYY-MM-DD" in local time. */
function formatDateLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Format a Date as "HH:MM" in local time (24-hour). */
function formatTimeLocal(d: Date): string {
  const h = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${min}`;
}
