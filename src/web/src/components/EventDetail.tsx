/**
 * EventDetail -- displays full details for a selected calendar event.
 *
 * Shows:
 * - Title, time range, description, location
 * - Origin account
 * - Mirror status per target account (ACTIVE=green, PENDING=yellow, ERROR=red)
 * - Version number and last update time
 *
 * Rendered as a slide-over panel with a backdrop overlay.
 * Clicking the overlay or the close button dismisses it.
 *
 * Exported utilities (for unit testing):
 *   getMirrorStatusColor(status) -- returns hex color for a MirrorSyncStatus
 *   getMirrorStatusLabel(status) -- returns human-readable label
 *   MirrorStatusBadge            -- renders a single mirror's status
 */

import type { CalendarEvent, EventMirror, MirrorSyncStatus } from "../lib/api";
import { formatTimeShort } from "../lib/calendar-utils";

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
// EventDetail
// ---------------------------------------------------------------------------

export interface EventDetailProps {
  event: CalendarEvent;
  onClose: () => void;
}

/** Full event detail panel (modal/slide-over). */
export function EventDetail({ event, onClose }: EventDetailProps) {
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
        {/* Header: title + close button */}
        <div style={styles.header}>
          <h2 style={styles.title}>{event.summary ?? "(No title)"}</h2>
          <button
            onClick={onClose}
            style={styles.closeBtn}
            aria-label="Close"
          >
            X
          </button>
        </div>

        {/* Time */}
        <div style={styles.section} data-testid="event-detail-time">
          <span style={styles.sectionIcon}>T</span>
          <div>
            <div style={styles.timeDate}>{dateDisplay}</div>
            <div style={styles.timeRange}>
              {formatTimeShort(event.start)} - {formatTimeShort(event.end)}
            </div>
          </div>
        </div>

        {/* Description (only if present) */}
        {event.description && (
          <div style={styles.section} data-testid="event-detail-description">
            <span style={styles.sectionIcon}>D</span>
            <p style={styles.description}>{event.description}</p>
          </div>
        )}

        {/* Location (only if present) */}
        {event.location && (
          <div style={styles.section} data-testid="event-detail-location">
            <span style={styles.sectionIcon}>L</span>
            <span style={styles.locationText}>{event.location}</span>
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
};
