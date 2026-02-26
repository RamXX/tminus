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
    <div
      className="flex items-center justify-between rounded-md bg-card px-3 py-2"
      data-testid="mirror-status-badge"
    >
      <span className="font-mono text-xs text-foreground">{displayName}</span>
      <span className="flex items-center gap-1.5">
        <span
          className="inline-block h-2 w-2 rounded-full"
          style={{ backgroundColor: color }}
          data-testid="mirror-status-indicator"
        />
        <span
          className="text-xs font-semibold uppercase tracking-wide"
          style={{ color }}
        >
          {label}
        </span>
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
    <div
      className="rounded-md border border-destructive/50 bg-destructive/10 p-3"
      data-testid="delete-confirm-dialog"
    >
      <p className="mb-3 mt-0 text-sm leading-relaxed text-destructive">
        Are you sure you want to delete this event? This action cannot be undone.
      </p>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="cursor-pointer rounded-md border border-border bg-transparent px-4 py-2 text-sm font-medium text-muted-foreground"
          disabled={deleting}
          data-testid="delete-cancel-btn"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="cursor-pointer rounded-md border-none bg-destructive px-4 py-2 text-sm font-semibold text-destructive-foreground"
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
      className="fixed inset-0 z-[1000] flex justify-end bg-black/50"
      data-testid="event-detail-overlay"
      onClick={onClose}
    >
      {/* Panel -- stop propagation so clicking inside doesn't dismiss */}
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
      <div
        className="flex w-full max-w-[420px] flex-col gap-4 overflow-y-auto border-l border-border bg-card p-6"
        data-testid="event-detail-panel"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header: title + action buttons */}
        <div className="flex items-start justify-between gap-4">
          {editing ? (
            <input
              type="text"
              value={formValues.title}
              onChange={(e) => updateField("title", e.target.value)}
              className={`flex-1 rounded-md border bg-background px-3 py-2 text-lg font-semibold text-foreground outline-none focus:ring-2 focus:ring-ring ${
                formErrors.title ? "border-destructive" : "border-border"
              }`}
              disabled={isBusy}
              data-testid="edit-title-input"
              autoFocus
            />
          ) : (
            <h2 className="m-0 text-lg font-bold leading-tight text-foreground">
              {event.summary ?? "(No title)"}
            </h2>
          )}
          <div className="flex shrink-0 gap-2">
            {!editing && canEdit && (
              <button
                onClick={handleEdit}
                className="shrink-0 cursor-pointer rounded-md border border-primary bg-transparent px-2.5 py-1 text-sm font-semibold text-primary"
                aria-label="Edit"
                disabled={isBusy}
                data-testid="edit-event-btn"
              >
                Edit
              </button>
            )}
            <button
              onClick={onClose}
              className="shrink-0 cursor-pointer rounded-md border border-border bg-transparent px-2.5 py-1 text-sm font-semibold text-muted-foreground"
              aria-label="Close"
            >
              X
            </button>
          </div>
        </div>

        {/* Title validation error */}
        {editing && formErrors.title && (
          <span className="text-xs text-destructive" data-testid="edit-title-error">
            {formErrors.title}
          </span>
        )}

        {/* Error banner */}
        {error && (
          <div
            className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive"
            data-testid="event-detail-error"
          >
            {error}
          </div>
        )}

        {/* Time */}
        <div
          className="flex items-start gap-3 border-b border-border py-2"
          data-testid="event-detail-time"
        >
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-card text-xs font-bold text-muted-foreground">
            T
          </span>
          {editing ? (
            <div className="flex flex-1 flex-col gap-2">
              <div className="flex flex-col gap-1">
                <label
                  htmlFor="edit-start-date"
                  className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
                >
                  Start
                </label>
                <div className="flex gap-2">
                  <input
                    id="edit-start-date"
                    type="date"
                    value={formValues.startDate}
                    onChange={(e) => updateField("startDate", e.target.value)}
                    className="flex-[2] rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
                    disabled={isBusy}
                    data-testid="edit-start-date-input"
                  />
                  <input
                    id="edit-start-time"
                    type="time"
                    value={formValues.startTime}
                    onChange={(e) => updateField("startTime", e.target.value)}
                    className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
                    disabled={isBusy}
                    data-testid="edit-start-time-input"
                  />
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <label
                  htmlFor="edit-end-date"
                  className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
                >
                  End
                </label>
                <div className="flex gap-2">
                  <input
                    id="edit-end-date"
                    type="date"
                    value={formValues.endDate}
                    onChange={(e) => updateField("endDate", e.target.value)}
                    className="flex-[2] rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
                    disabled={isBusy}
                    data-testid="edit-end-date-input"
                  />
                  <input
                    id="edit-end-time"
                    type="time"
                    value={formValues.endTime}
                    onChange={(e) => updateField("endTime", e.target.value)}
                    className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
                    disabled={isBusy}
                    data-testid="edit-end-time-input"
                  />
                </div>
              </div>
              {formErrors.endTime && (
                <span className="text-xs text-destructive" data-testid="edit-end-time-error">
                  {formErrors.endTime}
                </span>
              )}
            </div>
          ) : (
            <div>
              <div className="text-sm font-medium text-foreground">{dateDisplay}</div>
              <div className="mt-0.5 font-mono text-xs text-muted-foreground">
                {formatTimeShort(event.start)} - {formatTimeShort(event.end)}
              </div>
            </div>
          )}
        </div>

        {/* Description */}
        {editing ? (
          <div
            className="flex items-start gap-3 border-b border-border py-2"
            data-testid="event-detail-description"
          >
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-card text-xs font-bold text-muted-foreground">
              D
            </span>
            <textarea
              value={formValues.description}
              onChange={(e) => updateField("description", e.target.value)}
              className="min-h-[3rem] flex-1 resize-y rounded-md border border-border bg-background px-3 py-2 font-[inherit] text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
              disabled={isBusy}
              placeholder="Add a description..."
              rows={3}
              data-testid="edit-description-input"
            />
          </div>
        ) : (
          event.description && (
            <div
              className="flex items-start gap-3 border-b border-border py-2"
              data-testid="event-detail-description"
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-card text-xs font-bold text-muted-foreground">
                D
              </span>
              <p className="m-0 whitespace-pre-wrap text-sm leading-relaxed text-card-foreground">
                {event.description}
              </p>
            </div>
          )
        )}

        {/* Location */}
        {editing ? (
          <div
            className="flex items-start gap-3 border-b border-border py-2"
            data-testid="event-detail-location"
          >
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-card text-xs font-bold text-muted-foreground">
              L
            </span>
            <input
              type="text"
              value={formValues.location}
              onChange={(e) => updateField("location", e.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
              disabled={isBusy}
              placeholder="Add a location..."
              data-testid="edit-location-input"
            />
          </div>
        ) : (
          event.location && (
            <div
              className="flex items-start gap-3 border-b border-border py-2"
              data-testid="event-detail-location"
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-card text-xs font-bold text-muted-foreground">
                L
              </span>
              <span className="font-mono text-xs text-card-foreground">
                {event.location}
              </span>
            </div>
          )
        )}

        {/* Edit mode actions: Save / Cancel */}
        {editing && (
          <div className="flex justify-end gap-2 border-t border-border pt-2" data-testid="edit-actions">
            <button
              type="button"
              onClick={handleCancelEdit}
              className="cursor-pointer rounded-md border border-border bg-transparent px-4 py-2 text-sm font-medium text-muted-foreground"
              disabled={isBusy}
              data-testid="edit-cancel-btn"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              className="cursor-pointer rounded-md border-none bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
              disabled={isBusy}
              data-testid="edit-save-btn"
            >
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        )}

        {/* Origin account */}
        <div
          className="flex items-start gap-3 border-b border-border py-2"
          data-testid="event-detail-origin"
        >
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-card text-xs font-bold text-muted-foreground">
            O
          </span>
          <div>
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Origin account
            </span>
            <span className="block font-mono text-xs text-foreground">
              {event.origin_account_email ?? event.origin_account_id ?? "Unknown"}
            </span>
          </div>
        </div>

        {/* Mirror statuses */}
        <div className="border-b border-border py-3">
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Mirror Status
          </span>
          {hasMirrors ? (
            <div className="mt-2 flex flex-col gap-2">
              {event.mirrors!.map((mirror) => (
                <MirrorStatusBadge
                  key={mirror.target_account_id}
                  mirror={mirror}
                />
              ))}
            </div>
          ) : (
            <p className="mt-2 m-0 text-[13px] italic text-muted-foreground">
              No mirrors configured
            </p>
          )}
        </div>

        {/* Meta: version + last updated */}
        <div
          className="flex flex-wrap gap-4 py-2"
          data-testid="event-detail-meta"
        >
          {event.version != null && (
            <span className="font-mono text-xs text-muted-foreground">
              v{event.version}
            </span>
          )}
          {updatedAtDisplay && (
            <span className="font-mono text-xs text-muted-foreground">
              Updated {updatedAtDisplay}
            </span>
          )}
          {event.version == null && !updatedAtDisplay && (
            <span className="font-mono text-xs text-muted-foreground">
              No version info
            </span>
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
          <div className="border-t border-border pt-3">
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
                className="w-full cursor-pointer rounded-md border border-destructive/50 bg-transparent px-4 py-2 text-sm font-semibold text-destructive"
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
