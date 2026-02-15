/**
 * EventDetail -- displays full details for a selected calendar event.
 *
 * Supports two modes:
 * 1. View mode (default): read-only display of event info + mirror badges
 * 2. Edit mode: inline editing of title, time, description, location
 *
 * Also supports delete with a confirmation dialog.
 *
 * Shows:
 * - Title, time range, description, location
 * - Origin account
 * - Mirror status per target account (ACTIVE=green, PENDING=yellow, ERROR=red)
 * - Version number and last update time
 * - Edit/Delete action buttons (when onSave/onDelete are provided)
 *
 * Rendered as a slide-over panel with a backdrop overlay.
 * Clicking the overlay or the close button dismisses it.
 *
 * Exported utilities (for unit testing):
 *   getMirrorStatusColor(status) -- returns hex color for a MirrorSyncStatus
 *   getMirrorStatusLabel(status) -- returns human-readable label
 *   MirrorStatusBadge            -- renders a single mirror's status
 */

import { useState, useCallback } from "react";
import type { CalendarEvent, EventMirror, MirrorSyncStatus, UpdateEventPayload } from "../lib/api";
import { formatTimeShort } from "../lib/calendar-utils";
import {
  validateEventForm,
  hasErrors,
  buildUpdatePayload,
  createEditFormValues,
  type EventFormValues,
  type EventFormErrors,
} from "../lib/event-form";
import { BriefingPanel } from "./BriefingPanel";
import type { EventBriefing, ExcuseOutput, ExcuseTone, TruthLevel } from "../lib/briefing";

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing)
// ---------------------------------------------------------------------------

const STATUS_COLORS: Record<MirrorSyncStatus, string> = {
  ACTIVE: "#22c55e",  // green-500
  PENDING: "#f59e0b", // amber-500
  ERROR: "#ef4444",   // red-500
};

const STATUS_LABELS: Record<MirrorSyncStatus, string> = {
  ACTIVE: "Active",
  PENDING: "Pending",
  ERROR: "Error",
};

/** Get the display color for a mirror sync status. */
export function getMirrorStatusColor(status: MirrorSyncStatus): string {
  return STATUS_COLORS[status];
}

/** Get the human-readable label for a mirror sync status. */
export function getMirrorStatusLabel(status: MirrorSyncStatus): string {
  return STATUS_LABELS[status];
}

// ---------------------------------------------------------------------------
// MirrorStatusBadge
// ---------------------------------------------------------------------------

export interface MirrorStatusBadgeProps {
  mirror: EventMirror;
}

/** Renders a badge showing a mirror's target account and sync status. */
export function MirrorStatusBadge({ mirror }: MirrorStatusBadgeProps) {
  const color = getMirrorStatusColor(mirror.sync_status);
  const label = getMirrorStatusLabel(mirror.sync_status);
  const displayName = mirror.target_account_email ?? mirror.target_account_id;

  return (
    <div style={styles.mirrorBadge} data-testid="mirror-status-badge">
      <span style={styles.mirrorAccount}>{displayName}</span>
      <span style={styles.mirrorStatusGroup}>
        <span
          style={{ ...styles.mirrorStatusDot, backgroundColor: color }}
          data-testid="mirror-status-indicator"
        />
        <span style={{ ...styles.mirrorStatusText, color }}>{label}</span>
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DeleteConfirmDialog
// ---------------------------------------------------------------------------

interface DeleteConfirmDialogProps {
  onConfirm: () => void;
  onCancel: () => void;
  deleting: boolean;
}

/** Inline confirmation dialog for event deletion. */
function DeleteConfirmDialog({ onConfirm, onCancel, deleting }: DeleteConfirmDialogProps) {
  return (
    <div style={styles.deleteConfirm} data-testid="delete-confirm-dialog">
      <p style={styles.deleteConfirmText}>
        Are you sure you want to delete this event? This action cannot be undone.
      </p>
      <div style={styles.deleteConfirmActions}>
        <button
          type="button"
          onClick={onCancel}
          style={styles.cancelBtn}
          disabled={deleting}
          data-testid="delete-cancel-btn"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          style={styles.deleteConfirmBtn}
          disabled={deleting}
          data-testid="delete-confirm-btn"
        >
          {deleting ? "Deleting..." : "Delete"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// EventDetail
// ---------------------------------------------------------------------------

export interface EventDetailProps {
  event: CalendarEvent;
  onClose: () => void;
  /** Called when user saves edits. Receives the event ID and update payload. */
  onSave?: (eventId: string, payload: UpdateEventPayload) => void;
  /** Called when user confirms deletion. Receives the event ID. */
  onDelete?: (eventId: string) => void;
  /** True while save API call is in progress. */
  saving?: boolean;
  /** True while delete API call is in progress. */
  deleting?: boolean;
  /** Error message to display (from failed save/delete). */
  error?: string | null;
  /** Optional: fetch briefing data for context panel. When provided, shows BriefingPanel. */
  fetchBriefing?: (eventId: string) => Promise<EventBriefing>;
  /** Optional: generate excuse draft. Required with fetchBriefing. */
  generateExcuse?: (
    eventId: string,
    params: { tone: ExcuseTone; truth_level: TruthLevel },
  ) => Promise<ExcuseOutput>;
}

/** Full event detail panel (modal/slide-over) with edit and delete support. */
export function EventDetail({
  event,
  onClose,
  onSave,
  onDelete,
  saving = false,
  deleting = false,
  error = null,
  fetchBriefing,
  generateExcuse,
}: EventDetailProps) {
  const [editing, setEditing] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [formValues, setFormValues] = useState<EventFormValues>(() =>
    createEditFormValues(event),
  );
  const [formErrors, setFormErrors] = useState<EventFormErrors>({});

  const hasMirrors = event.mirrors && event.mirrors.length > 0;

  // Format date for display (e.g., "Saturday, February 14, 2026")
  const dateDisplay = (() => {
    try {
      const d = new Date(event.start);
      if (isNaN(d.getTime())) return "";
      return d.toLocaleDateString(undefined, {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
      });
    } catch {
      return "";
    }
  })();

  // Format updated_at for display
  const updatedAtDisplay = (() => {
    if (!event.updated_at) return null;
    try {
      const d = new Date(event.updated_at);
      if (isNaN(d.getTime())) return event.updated_at;
      return d.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
    } catch {
      return event.updated_at;
    }
  })();

  // Enter edit mode
  const handleEdit = useCallback(() => {
    setFormValues(createEditFormValues(event));
    setFormErrors({});
    setEditing(true);
  }, [event]);

  // Cancel editing -- return to view mode
  const handleCancelEdit = useCallback(() => {
    setEditing(false);
    setFormErrors({});
  }, []);

  // Save edits
  const handleSave = useCallback(() => {
    if (!onSave) return;

    const validationErrors = validateEventForm(formValues);
    if (hasErrors(validationErrors)) {
      setFormErrors(validationErrors);
      return;
    }

    const payload = buildUpdatePayload(event, formValues);

    // If nothing changed, just exit edit mode
    if (Object.keys(payload).length === 0) {
      setEditing(false);
      return;
    }

    onSave(event.canonical_event_id, payload);
    setEditing(false);
  }, [onSave, formValues, event]);

  // Update a form field
  const updateField = useCallback(
    (field: keyof EventFormValues, value: string) => {
      setFormValues((prev) => ({ ...prev, [field]: value }));
      // Clear field error on change
      setFormErrors((prev) => {
        if (!prev[field]) return prev;
        const next = { ...prev };
        delete next[field];
        return next;
      });
    },
    [],
  );

  // Delete handlers
  const handleDeleteClick = useCallback(() => {
    setShowDeleteConfirm(true);
  }, []);

  const handleDeleteCancel = useCallback(() => {
    setShowDeleteConfirm(false);
  }, []);

  const handleDeleteConfirm = useCallback(() => {
    if (!onDelete) return;
    onDelete(event.canonical_event_id);
  }, [onDelete, event.canonical_event_id]);

  const canEdit = !!onSave;
  const canDelete = !!onDelete;
  const isBusy = saving || deleting;

  return (
    // Overlay (backdrop) -- clicking it dismisses the panel
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
    <div
      style={styles.overlay}
      data-testid="event-detail-overlay"
      onClick={onClose}
    >
      {/* Panel -- stop propagation so clicking inside doesn't dismiss */}
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
      <div
        style={styles.panel}
        data-testid="event-detail-panel"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header: title + action buttons */}
        <div style={styles.header}>
          {editing ? (
            <input
              type="text"
              value={formValues.title}
              onChange={(e) => updateField("title", e.target.value)}
              style={{
                ...styles.editInput,
                ...styles.editTitleInput,
                ...(formErrors.title ? styles.inputError : {}),
              }}
              disabled={isBusy}
              data-testid="edit-title-input"
              autoFocus
            />
          ) : (
            <h2 style={styles.title}>{event.summary ?? "(No title)"}</h2>
          )}
          <div style={styles.headerActions}>
            {!editing && canEdit && (
              <button
                onClick={handleEdit}
                style={styles.editBtn}
                aria-label="Edit"
                disabled={isBusy}
                data-testid="edit-event-btn"
              >
                Edit
              </button>
            )}
            <button
              onClick={onClose}
              style={styles.closeBtn}
              aria-label="Close"
            >
              X
            </button>
          </div>
        </div>

        {/* Title validation error */}
        {editing && formErrors.title && (
          <span style={styles.fieldError} data-testid="edit-title-error">
            {formErrors.title}
          </span>
        )}

        {/* Error banner */}
        {error && (
          <div style={styles.errorBanner} data-testid="event-detail-error">
            {error}
          </div>
        )}

        {/* Time */}
        <div style={styles.section} data-testid="event-detail-time">
          <span style={styles.sectionIcon}>T</span>
          {editing ? (
            <div style={styles.editTimeContainer}>
              <div style={styles.editTimeRow}>
                <label htmlFor="edit-start-date" style={styles.editLabel}>Start</label>
                <div style={styles.dateTimeRow}>
                  <input
                    id="edit-start-date"
                    type="date"
                    value={formValues.startDate}
                    onChange={(e) => updateField("startDate", e.target.value)}
                    style={{ ...styles.editInput, ...styles.dateInput }}
                    disabled={isBusy}
                    data-testid="edit-start-date-input"
                  />
                  <input
                    id="edit-start-time"
                    type="time"
                    value={formValues.startTime}
                    onChange={(e) => updateField("startTime", e.target.value)}
                    style={{ ...styles.editInput, ...styles.timeInput }}
                    disabled={isBusy}
                    data-testid="edit-start-time-input"
                  />
                </div>
              </div>
              <div style={styles.editTimeRow}>
                <label htmlFor="edit-end-date" style={styles.editLabel}>End</label>
                <div style={styles.dateTimeRow}>
                  <input
                    id="edit-end-date"
                    type="date"
                    value={formValues.endDate}
                    onChange={(e) => updateField("endDate", e.target.value)}
                    style={{ ...styles.editInput, ...styles.dateInput }}
                    disabled={isBusy}
                    data-testid="edit-end-date-input"
                  />
                  <input
                    id="edit-end-time"
                    type="time"
                    value={formValues.endTime}
                    onChange={(e) => updateField("endTime", e.target.value)}
                    style={{ ...styles.editInput, ...styles.timeInput }}
                    disabled={isBusy}
                    data-testid="edit-end-time-input"
                  />
                </div>
              </div>
              {formErrors.endTime && (
                <span style={styles.fieldError} data-testid="edit-end-time-error">
                  {formErrors.endTime}
                </span>
              )}
            </div>
          ) : (
            <div>
              <div style={styles.timeDate}>{dateDisplay}</div>
              <div style={styles.timeRange}>
                {formatTimeShort(event.start)} - {formatTimeShort(event.end)}
              </div>
            </div>
          )}
        </div>

        {/* Description */}
        {editing ? (
          <div style={styles.section} data-testid="event-detail-description">
            <span style={styles.sectionIcon}>D</span>
            <textarea
              value={formValues.description}
              onChange={(e) => updateField("description", e.target.value)}
              style={{ ...styles.editInput, ...styles.editTextarea }}
              disabled={isBusy}
              placeholder="Add a description..."
              rows={3}
              data-testid="edit-description-input"
            />
          </div>
        ) : (
          event.description && (
            <div style={styles.section} data-testid="event-detail-description">
              <span style={styles.sectionIcon}>D</span>
              <p style={styles.description}>{event.description}</p>
            </div>
          )
        )}

        {/* Location */}
        {editing ? (
          <div style={styles.section} data-testid="event-detail-location">
            <span style={styles.sectionIcon}>L</span>
            <input
              type="text"
              value={formValues.location}
              onChange={(e) => updateField("location", e.target.value)}
              style={styles.editInput}
              disabled={isBusy}
              placeholder="Add a location..."
              data-testid="edit-location-input"
            />
          </div>
        ) : (
          event.location && (
            <div style={styles.section} data-testid="event-detail-location">
              <span style={styles.sectionIcon}>L</span>
              <span style={styles.locationText}>{event.location}</span>
            </div>
          )
        )}

        {/* Edit mode actions: Save / Cancel */}
        {editing && (
          <div style={styles.editActions} data-testid="edit-actions">
            <button
              type="button"
              onClick={handleCancelEdit}
              style={styles.cancelBtn}
              disabled={isBusy}
              data-testid="edit-cancel-btn"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              style={styles.saveBtn}
              disabled={isBusy}
              data-testid="edit-save-btn"
            >
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        )}

        {/* Origin account */}
        <div style={styles.section} data-testid="event-detail-origin">
          <span style={styles.sectionIcon}>O</span>
          <div>
            <span style={styles.sectionLabel}>Origin account</span>
            <span style={styles.originValue}>
              {event.origin_account_email ?? event.origin_account_id ?? "Unknown"}
            </span>
          </div>
        </div>

        {/* Mirror statuses */}
        <div style={styles.mirrorsSection}>
          <span style={styles.sectionLabel}>Mirror Status</span>
          {hasMirrors ? (
            <div style={styles.mirrorList}>
              {event.mirrors!.map((mirror) => (
                <MirrorStatusBadge
                  key={mirror.target_account_id}
                  mirror={mirror}
                />
              ))}
            </div>
          ) : (
            <p style={styles.noMirrors}>No mirrors configured</p>
          )}
        </div>

        {/* Meta: version + last updated */}
        <div style={styles.metaSection} data-testid="event-detail-meta">
          {event.version != null && (
            <span style={styles.metaItem}>v{event.version}</span>
          )}
          {updatedAtDisplay && (
            <span style={styles.metaItem}>Updated {updatedAtDisplay}</span>
          )}
          {event.version == null && !updatedAtDisplay && (
            <span style={styles.metaItem}>No version info</span>
          )}
        </div>

        {/* Context briefing panel */}
        {fetchBriefing && generateExcuse && !editing && (
          <BriefingPanel
            eventId={event.canonical_event_id}
            fetchBriefing={fetchBriefing}
            generateExcuse={generateExcuse}
          />
        )}

        {/* Delete button + confirmation dialog */}
        {canDelete && !editing && (
          <div style={styles.deleteSection}>
            {showDeleteConfirm ? (
              <DeleteConfirmDialog
                onConfirm={handleDeleteConfirm}
                onCancel={handleDeleteCancel}
                deleting={deleting}
              />
            ) : (
              <button
                type="button"
                onClick={handleDeleteClick}
                style={styles.deleteBtn}
                disabled={isBusy}
                data-testid="delete-event-btn"
              >
                Delete Event
              </button>
            )}
          </div>
        )}
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
    gap: "1rem",
  },

  // Header
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: "1rem",
  },
  headerActions: {
    display: "flex",
    gap: "0.5rem",
    flexShrink: 0,
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
  editBtn: {
    background: "transparent",
    border: "1px solid #3b82f6",
    borderRadius: "6px",
    color: "#3b82f6",
    fontSize: "0.875rem",
    fontWeight: 600,
    padding: "0.25rem 0.625rem",
    cursor: "pointer",
    flexShrink: 0,
  },

  // Sections
  section: {
    display: "flex",
    gap: "0.75rem",
    alignItems: "flex-start",
    padding: "0.5rem 0",
    borderBottom: "1px solid #1e293b",
  },
  sectionIcon: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "24px",
    height: "24px",
    borderRadius: "4px",
    backgroundColor: "#1e293b",
    color: "#64748b",
    fontSize: "0.75rem",
    fontWeight: 700,
    flexShrink: 0,
  },
  sectionLabel: {
    display: "block",
    fontSize: "0.75rem",
    fontWeight: 600,
    color: "#64748b",
    textTransform: "uppercase" as const,
    letterSpacing: "0.05em",
    marginBottom: "0.25rem",
  },

  // Time
  timeDate: {
    fontSize: "0.875rem",
    fontWeight: 500,
    color: "#e2e8f0",
  },
  timeRange: {
    fontSize: "0.8125rem",
    color: "#94a3b8",
    marginTop: "0.125rem",
  },

  // Description
  description: {
    margin: 0,
    fontSize: "0.875rem",
    color: "#cbd5e1",
    lineHeight: 1.5,
    whiteSpace: "pre-wrap" as const,
  },

  // Location
  locationText: {
    fontSize: "0.875rem",
    color: "#cbd5e1",
  },

  // Origin account
  originValue: {
    display: "block",
    fontSize: "0.875rem",
    color: "#e2e8f0",
    fontWeight: 500,
  },

  // Mirrors
  mirrorsSection: {
    padding: "0.75rem 0",
    borderBottom: "1px solid #1e293b",
  },
  mirrorList: {
    display: "flex",
    flexDirection: "column",
    gap: "0.5rem",
    marginTop: "0.5rem",
  },
  mirrorBadge: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "0.5rem 0.75rem",
    backgroundColor: "#1e293b",
    borderRadius: "6px",
  },
  mirrorAccount: {
    fontSize: "0.8125rem",
    color: "#e2e8f0",
    fontWeight: 500,
  },
  mirrorStatusGroup: {
    display: "flex",
    alignItems: "center",
    gap: "0.375rem",
  },
  mirrorStatusDot: {
    width: "8px",
    height: "8px",
    borderRadius: "50%",
    display: "inline-block",
  },
  mirrorStatusText: {
    fontSize: "0.75rem",
    fontWeight: 600,
    textTransform: "uppercase" as const,
    letterSpacing: "0.03em",
  },
  noMirrors: {
    margin: "0.5rem 0 0 0",
    fontSize: "0.8125rem",
    color: "#64748b",
    fontStyle: "italic",
  },

  // Meta
  metaSection: {
    display: "flex",
    gap: "1rem",
    flexWrap: "wrap",
    padding: "0.5rem 0",
  },
  metaItem: {
    fontSize: "0.75rem",
    color: "#64748b",
  },

  // Edit mode inputs
  editInput: {
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
  editTitleInput: {
    fontSize: "1.125rem",
    fontWeight: 600,
    flex: 1,
  },
  inputError: {
    borderColor: "#ef4444",
  },
  editTextarea: {
    resize: "vertical" as const,
    minHeight: "3rem",
    fontFamily: "inherit",
    flex: 1,
  },
  editTimeContainer: {
    display: "flex",
    flexDirection: "column",
    gap: "0.5rem",
    flex: 1,
  },
  editTimeRow: {
    display: "flex",
    flexDirection: "column",
    gap: "0.25rem",
  },
  editLabel: {
    fontSize: "0.75rem",
    fontWeight: 600,
    color: "#94a3b8",
    textTransform: "uppercase" as const,
    letterSpacing: "0.05em",
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
  fieldError: {
    fontSize: "0.75rem",
    color: "#ef4444",
  },

  // Edit actions
  editActions: {
    display: "flex",
    justifyContent: "flex-end",
    gap: "0.5rem",
    paddingTop: "0.5rem",
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
  saveBtn: {
    padding: "0.5rem 1rem",
    borderRadius: "6px",
    border: "none",
    background: "#3b82f6",
    color: "#ffffff",
    cursor: "pointer",
    fontSize: "0.875rem",
    fontWeight: 600,
  },

  // Error banner
  errorBanner: {
    padding: "0.75rem",
    borderRadius: "6px",
    backgroundColor: "#2d1b1b",
    border: "1px solid #7f1d1d",
    color: "#fca5a5",
    fontSize: "0.875rem",
  },

  // Delete
  deleteSection: {
    padding: "0.75rem 0",
    borderTop: "1px solid #1e293b",
  },
  deleteBtn: {
    width: "100%",
    padding: "0.5rem 1rem",
    borderRadius: "6px",
    border: "1px solid #7f1d1d",
    background: "transparent",
    color: "#ef4444",
    cursor: "pointer",
    fontSize: "0.875rem",
    fontWeight: 600,
  },
  deleteConfirm: {
    padding: "0.75rem",
    borderRadius: "6px",
    backgroundColor: "#2d1b1b",
    border: "1px solid #7f1d1d",
  },
  deleteConfirmText: {
    margin: "0 0 0.75rem 0",
    fontSize: "0.875rem",
    color: "#fca5a5",
    lineHeight: 1.5,
  },
  deleteConfirmActions: {
    display: "flex",
    justifyContent: "flex-end",
    gap: "0.5rem",
  },
  deleteConfirmBtn: {
    padding: "0.5rem 1rem",
    borderRadius: "6px",
    border: "none",
    background: "#ef4444",
    color: "#ffffff",
    cursor: "pointer",
    fontSize: "0.875rem",
    fontWeight: 600,
  },
};
