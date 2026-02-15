/**
 * Event creation form utilities.
 *
 * Pure functions for form validation, payload construction, and
 * optimistic update logic. No React dependencies -- easy to unit test.
 */
import type { CalendarEvent, CreateEventPayload } from "./api";

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
