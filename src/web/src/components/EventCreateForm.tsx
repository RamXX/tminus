/**
 * EventCreateForm -- modal form for creating a new calendar event.
 *
 * Opens as a slide-over panel (consistent with EventDetail).
 * Fields: title (required), start/end date+time, timezone, description, location.
 * Validates before submit. Calls onSubmit with the validated CreateEventPayload.
 *
 * Props:
 *   initialDate - pre-fill start/end from this date (clicked time slot)
 *   onSubmit(payload) - called with the validated payload
 *   onCancel() - close form without creating
 *   submitting - true while API call is in flight (disables form)
 *   error - error message to display (e.g. from API failure)
 */

import { useState, useCallback } from "react";
import type { CreateEventPayload } from "../lib/api";
import {
  validateEventForm,
  hasErrors,
  buildCreatePayload,
  createDefaultFormValues,
  type EventFormValues,
  type EventFormErrors,
} from "../lib/event-form";
import { Button } from "./ui/button";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EventCreateFormProps {
  /** Date to pre-fill the form from (the clicked time slot). */
  initialDate: Date;
  /** Called with validated payload when form is submitted. */
  onSubmit: (payload: CreateEventPayload) => void;
  /** Called when the user cancels (close button or overlay click). */
  onCancel: () => void;
  /** True while the API call is in progress. Disables form. */
  submitting?: boolean;
  /** Error message to display (e.g. from failed API call). */
  error?: string | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function EventCreateForm({
  initialDate,
  onSubmit,
  onCancel,
  submitting = false,
  error = null,
}: EventCreateFormProps) {
  const [values, setValues] = useState<EventFormValues>(
    () => createDefaultFormValues(initialDate),
  );
  const [errors, setErrors] = useState<EventFormErrors>({});

  const updateField = useCallback(
    (field: keyof EventFormValues, value: string) => {
      setValues((prev) => ({ ...prev, [field]: value }));
      // Clear field error on change
      setErrors((prev) => {
        if (!prev[field]) return prev;
        const next = { ...prev };
        delete next[field];
        return next;
      });
    },
    [],
  );

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const validationErrors = validateEventForm(values);
      if (hasErrors(validationErrors)) {
        setErrors(validationErrors);
        return;
      }
      const payload = buildCreatePayload(values);
      onSubmit(payload);
    },
    [values, onSubmit],
  );

  return (
    // Overlay backdrop -- clicking dismisses
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
    <div
      className="fixed inset-0 z-[1000] flex justify-end bg-black/50"
      data-testid="event-create-overlay"
      onClick={onCancel}
    >
      {/* Panel -- stop propagation so clicking inside doesn't dismiss */}
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
      <div
        className="flex w-full max-w-[420px] flex-col gap-3 overflow-y-auto border-l border-border bg-card p-6"
        data-testid="event-create-panel"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <h2 className="m-0 text-lg font-bold leading-tight text-foreground">
            New Event
          </h2>
          <button
            onClick={onCancel}
            className="shrink-0 cursor-pointer rounded-md border border-border bg-transparent px-2.5 py-1 text-sm font-semibold text-muted-foreground"
            aria-label="Cancel"
            type="button"
            disabled={submitting}
          >
            X
          </button>
        </div>

        {/* API error banner */}
        {error && (
          <div
            className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive"
            data-testid="event-create-error"
          >
            {error}
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleSubmit} data-testid="event-create-form">
          {/* Title */}
          <div className="mb-2 flex flex-col gap-1">
            <label
              htmlFor="event-title"
              className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
            >
              Title *
            </label>
            <input
              id="event-title"
              type="text"
              value={values.title}
              onChange={(e) => updateField("title", e.target.value)}
              className={`w-full rounded-md border bg-background px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring ${
                errors.title ? "border-destructive" : "border-border"
              }`}
              placeholder="Event title"
              disabled={submitting}
              autoFocus
              data-testid="event-title-input"
            />
            {errors.title && (
              <span className="text-xs text-destructive" data-testid="title-error">
                {errors.title}
              </span>
            )}
          </div>

          {/* Start date + time */}
          <div className="mb-2 flex flex-col gap-1">
            <label
              htmlFor="event-start-date"
              className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
            >
              Start
            </label>
            <div className="flex gap-2">
              <input
                id="event-start-date"
                type="date"
                value={values.startDate}
                onChange={(e) => updateField("startDate", e.target.value)}
                className={`flex-[2] rounded-md border bg-background px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring ${
                  errors.startDate ? "border-destructive" : "border-border"
                }`}
                disabled={submitting}
                data-testid="event-start-date-input"
              />
              <input
                id="event-start-time"
                type="time"
                value={values.startTime}
                onChange={(e) => updateField("startTime", e.target.value)}
                className={`flex-1 rounded-md border bg-background px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring ${
                  errors.startTime ? "border-destructive" : "border-border"
                }`}
                disabled={submitting}
                data-testid="event-start-time-input"
              />
            </div>
            {errors.startDate && (
              <span className="text-xs text-destructive">{errors.startDate}</span>
            )}
            {errors.startTime && (
              <span className="text-xs text-destructive">{errors.startTime}</span>
            )}
          </div>

          {/* End date + time */}
          <div className="mb-2 flex flex-col gap-1">
            <label
              htmlFor="event-end-date"
              className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
            >
              End
            </label>
            <div className="flex gap-2">
              <input
                id="event-end-date"
                type="date"
                value={values.endDate}
                onChange={(e) => updateField("endDate", e.target.value)}
                className={`flex-[2] rounded-md border bg-background px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring ${
                  errors.endDate ? "border-destructive" : "border-border"
                }`}
                disabled={submitting}
                data-testid="event-end-date-input"
              />
              <input
                id="event-end-time"
                type="time"
                value={values.endTime}
                onChange={(e) => updateField("endTime", e.target.value)}
                className={`flex-1 rounded-md border bg-background px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring ${
                  errors.endTime ? "border-destructive" : "border-border"
                }`}
                disabled={submitting}
                data-testid="event-end-time-input"
              />
            </div>
            {errors.endDate && (
              <span className="text-xs text-destructive">{errors.endDate}</span>
            )}
            {errors.endTime && (
              <span className="text-xs text-destructive" data-testid="end-time-error">
                {errors.endTime}
              </span>
            )}
          </div>

          {/* Timezone */}
          <div className="mb-2 flex flex-col gap-1">
            <label
              htmlFor="event-timezone"
              className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
            >
              Timezone
            </label>
            <input
              id="event-timezone"
              type="text"
              value={values.timezone}
              onChange={(e) => updateField("timezone", e.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="e.g. America/New_York"
              disabled={submitting}
              data-testid="event-timezone-input"
            />
          </div>

          {/* Description */}
          <div className="mb-2 flex flex-col gap-1">
            <label
              htmlFor="event-description"
              className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
            >
              Description
            </label>
            <textarea
              id="event-description"
              value={values.description}
              onChange={(e) => updateField("description", e.target.value)}
              className="min-h-[3rem] w-full resize-y rounded-md border border-border bg-background px-3 py-2.5 font-[inherit] text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="Add a description..."
              disabled={submitting}
              rows={3}
              data-testid="event-description-input"
            />
          </div>

          {/* Location */}
          <div className="mb-2 flex flex-col gap-1">
            <label
              htmlFor="event-location"
              className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
            >
              Location
            </label>
            <input
              id="event-location"
              type="text"
              value={values.location}
              onChange={(e) => updateField("location", e.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="Add a location..."
              disabled={submitting}
              data-testid="event-location-input"
            />
          </div>

          {/* Actions */}
          <div className="mt-3 flex justify-end gap-2 border-t border-border pt-3">
            <Button
              type="button"
              variant="ghost"
              onClick={onCancel}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={submitting}
              data-testid="event-create-submit"
            >
              {submitting ? "Creating..." : "Create Event"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
