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
      style={styles.overlay}
      data-testid="event-create-overlay"
      onClick={onCancel}
    >
      {/* Panel -- stop propagation so clicking inside doesn't dismiss */}
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
      <div
        style={styles.panel}
        data-testid="event-create-panel"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={styles.header}>
          <h2 style={styles.title}>New Event</h2>
          <button
            onClick={onCancel}
            style={styles.closeBtn}
            aria-label="Cancel"
            type="button"
            disabled={submitting}
          >
            X
          </button>
        </div>

        {/* API error banner */}
        {error && (
          <div style={styles.errorBanner} data-testid="event-create-error">
            {error}
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleSubmit} data-testid="event-create-form">
          {/* Title */}
          <div style={styles.fieldGroup}>
            <label htmlFor="event-title" style={styles.label}>
              Title *
            </label>
            <input
              id="event-title"
              type="text"
              value={values.title}
              onChange={(e) => updateField("title", e.target.value)}
              style={{
                ...styles.input,
                ...(errors.title ? styles.inputError : {}),
              }}
              placeholder="Event title"
              disabled={submitting}
              autoFocus
              data-testid="event-title-input"
            />
            {errors.title && (
              <span style={styles.fieldError} data-testid="title-error">
                {errors.title}
              </span>
            )}
          </div>

          {/* Start date + time */}
          <div style={styles.fieldGroup}>
            <label htmlFor="event-start-date" style={styles.label}>
              Start
            </label>
            <div style={styles.dateTimeRow}>
              <input
                id="event-start-date"
                type="date"
                value={values.startDate}
                onChange={(e) => updateField("startDate", e.target.value)}
                style={{
                  ...styles.input,
                  ...styles.dateInput,
                  ...(errors.startDate ? styles.inputError : {}),
                }}
                disabled={submitting}
                data-testid="event-start-date-input"
              />
              <input
                id="event-start-time"
                type="time"
                value={values.startTime}
                onChange={(e) => updateField("startTime", e.target.value)}
                style={{
                  ...styles.input,
                  ...styles.timeInput,
                  ...(errors.startTime ? styles.inputError : {}),
                }}
                disabled={submitting}
                data-testid="event-start-time-input"
              />
            </div>
            {errors.startDate && (
              <span style={styles.fieldError}>{errors.startDate}</span>
            )}
            {errors.startTime && (
              <span style={styles.fieldError}>{errors.startTime}</span>
            )}
          </div>

          {/* End date + time */}
          <div style={styles.fieldGroup}>
            <label htmlFor="event-end-date" style={styles.label}>
              End
            </label>
            <div style={styles.dateTimeRow}>
              <input
                id="event-end-date"
                type="date"
                value={values.endDate}
                onChange={(e) => updateField("endDate", e.target.value)}
                style={{
                  ...styles.input,
                  ...styles.dateInput,
                  ...(errors.endDate ? styles.inputError : {}),
                }}
                disabled={submitting}
                data-testid="event-end-date-input"
              />
              <input
                id="event-end-time"
                type="time"
                value={values.endTime}
                onChange={(e) => updateField("endTime", e.target.value)}
                style={{
                  ...styles.input,
                  ...styles.timeInput,
                  ...(errors.endTime ? styles.inputError : {}),
                }}
                disabled={submitting}
                data-testid="event-end-time-input"
              />
            </div>
            {errors.endDate && (
              <span style={styles.fieldError}>{errors.endDate}</span>
            )}
            {errors.endTime && (
              <span style={styles.fieldError} data-testid="end-time-error">
                {errors.endTime}
              </span>
            )}
          </div>

          {/* Timezone */}
          <div style={styles.fieldGroup}>
            <label htmlFor="event-timezone" style={styles.label}>
              Timezone
            </label>
            <input
              id="event-timezone"
              type="text"
              value={values.timezone}
              onChange={(e) => updateField("timezone", e.target.value)}
              style={styles.input}
              placeholder="e.g. America/New_York"
              disabled={submitting}
              data-testid="event-timezone-input"
            />
          </div>

          {/* Description */}
          <div style={styles.fieldGroup}>
            <label htmlFor="event-description" style={styles.label}>
              Description
            </label>
            <textarea
              id="event-description"
              value={values.description}
              onChange={(e) => updateField("description", e.target.value)}
              style={{ ...styles.input, ...styles.textarea }}
              placeholder="Add a description..."
              disabled={submitting}
              rows={3}
              data-testid="event-description-input"
            />
          </div>

          {/* Location */}
          <div style={styles.fieldGroup}>
            <label htmlFor="event-location" style={styles.label}>
              Location
            </label>
            <input
              id="event-location"
              type="text"
              value={values.location}
              onChange={(e) => updateField("location", e.target.value)}
              style={styles.input}
              placeholder="Add a location..."
              disabled={submitting}
              data-testid="event-location-input"
            />
          </div>

          {/* Actions */}
          <div style={styles.actions}>
            <button
              type="button"
              onClick={onCancel}
              style={styles.cancelBtn}
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              style={styles.submitBtn}
              disabled={submitting}
              data-testid="event-create-submit"
            >
              {submitting ? "Creating..." : "Create Event"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline styles
// ---------------------------------------------------------------------------

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: "fixed",
    inset: 0,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    display: "flex",
    justifyContent: "flex-end",
    zIndex: 1000,
  },
  panel: {
    width: "100%",
    maxWidth: "420px",
    backgroundColor: "#0f172a",
    borderLeft: "1px solid #334155",
    overflowY: "auto",
    padding: "1.5rem",
    display: "flex",
    flexDirection: "column",
    gap: "0.75rem",
  },

  // Header
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: "1rem",
  },
  title: {
    margin: 0,
    fontSize: "1.25rem",
    fontWeight: 700,
    color: "#f1f5f9",
    lineHeight: 1.3,
  },
  closeBtn: {
    background: "transparent",
    border: "1px solid #334155",
    borderRadius: "6px",
    color: "#94a3b8",
    fontSize: "0.875rem",
    fontWeight: 600,
    padding: "0.25rem 0.625rem",
    cursor: "pointer",
    flexShrink: 0,
  },

  // Error
  errorBanner: {
    padding: "0.75rem",
    borderRadius: "6px",
    backgroundColor: "#2d1b1b",
    border: "1px solid #7f1d1d",
    color: "#fca5a5",
    fontSize: "0.875rem",
  },

  // Form fields
  fieldGroup: {
    display: "flex",
    flexDirection: "column",
    gap: "0.25rem",
    marginBottom: "0.5rem",
  },
  label: {
    fontSize: "0.75rem",
    fontWeight: 600,
    color: "#94a3b8",
    textTransform: "uppercase" as const,
    letterSpacing: "0.05em",
  },
  input: {
    padding: "0.5rem 0.75rem",
    borderRadius: "6px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#334155",
    backgroundColor: "#1e293b",
    color: "#e2e8f0",
    fontSize: "0.875rem",
    outline: "none",
    width: "100%",
    boxSizing: "border-box" as const,
  },
  inputError: {
    borderColor: "#ef4444",
  },
  dateTimeRow: {
    display: "flex",
    gap: "0.5rem",
  },
  dateInput: {
    flex: 2,
  },
  timeInput: {
    flex: 1,
  },
  textarea: {
    resize: "vertical" as const,
    minHeight: "3rem",
    fontFamily: "inherit",
  },
  fieldError: {
    fontSize: "0.75rem",
    color: "#ef4444",
  },

  // Actions
  actions: {
    display: "flex",
    justifyContent: "flex-end",
    gap: "0.5rem",
    marginTop: "0.75rem",
    paddingTop: "0.75rem",
    borderTop: "1px solid #1e293b",
  },
  cancelBtn: {
    padding: "0.5rem 1rem",
    borderRadius: "6px",
    border: "1px solid #334155",
    background: "transparent",
    color: "#94a3b8",
    cursor: "pointer",
    fontSize: "0.875rem",
    fontWeight: 500,
  },
  submitBtn: {
    padding: "0.5rem 1rem",
    borderRadius: "6px",
    border: "none",
    background: "#3b82f6",
    color: "#ffffff",
    cursor: "pointer",
    fontSize: "0.875rem",
    fontWeight: 600,
  },
};
