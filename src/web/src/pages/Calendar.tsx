/**
 * Calendar page.
 *
 * Minimal event list proving the data pipeline works:
 *   SPA -> /api/v1/events -> app-gateway proxy -> api-worker -> UserGraphDO
 *
 * Shows events in a simple list grouped by date.
 * Walking skeleton -- a richer calendar view comes in TM-nyj.2.
 */

import { useState, useEffect, useCallback } from "react";
import { useAuth } from "../lib/auth";
import { fetchEvents, ApiError } from "../lib/api";
import type { CalendarEvent } from "../lib/api";

export function Calendar() {
  const { token, user, logout } = useAuth();
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadEvents = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);

    try {
      // Fetch events for the next 30 days
      const now = new Date();
      const end = new Date(now);
      end.setDate(end.getDate() + 30);

      const data = await fetchEvents(token, {
        start: now.toISOString(),
        end: end.toISOString(),
      });
      setEvents(data ?? []);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 401) {
          // Token expired -- log out
          logout();
          return;
        }
        setError(err.message);
      } else {
        setError("Failed to load events. Please try again.");
      }
    } finally {
      setLoading(false);
    }
  }, [token, logout]);

  useEffect(() => {
    loadEvents();
  }, [loadEvents]);

  return (
    <div style={styles.container}>
      {/* Header */}
      <header style={styles.header}>
        <div>
          <h1 style={styles.title}>T-Minus Calendar</h1>
          <p style={styles.subtitle}>{user?.email ?? "Unknown user"}</p>
        </div>
        <div style={styles.headerActions}>
          <button onClick={loadEvents} style={styles.refreshBtn} disabled={loading}>
            Refresh
          </button>
          <button onClick={logout} style={styles.logoutBtn}>
            Sign Out
          </button>
        </div>
      </header>

      {/* Content */}
      <main style={styles.main}>
        {loading && (
          <p style={styles.loadingText}>Loading events...</p>
        )}

        {error && (
          <div style={styles.errorBox}>
            <p>{error}</p>
            <button onClick={loadEvents} style={styles.retryBtn}>
              Retry
            </button>
          </div>
        )}

        {!loading && !error && events.length === 0 && (
          <div style={styles.emptyState}>
            <p style={styles.emptyTitle}>No events found</p>
            <p style={styles.emptySubtitle}>
              Link a Google or Microsoft calendar account to see events here.
            </p>
          </div>
        )}

        {!loading && events.length > 0 && (
          <ul style={styles.eventList}>
            {events.map((event) => (
              <li key={event.canonical_event_id} style={styles.eventItem}>
                <div style={styles.eventTime}>
                  {formatTime(event.start)} - {formatTime(event.end)}
                </div>
                <div style={styles.eventSummary}>
                  {event.summary ?? "(No title)"}
                </div>
                <div style={styles.eventDate}>
                  {formatDate(event.start)}
                </div>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// Inline styles (walking skeleton)
// ---------------------------------------------------------------------------

const styles: Record<string, React.CSSProperties> = {
  container: {
    maxWidth: "800px",
    margin: "0 auto",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "1rem 0",
    borderBottom: "1px solid #334155",
    marginBottom: "1rem",
  },
  title: {
    fontSize: "1.5rem",
    fontWeight: 700,
    color: "#f1f5f9",
    margin: 0,
  },
  subtitle: {
    fontSize: "0.875rem",
    color: "#94a3b8",
    margin: 0,
  },
  headerActions: {
    display: "flex",
    gap: "0.5rem",
  },
  refreshBtn: {
    padding: "0.5rem 1rem",
    borderRadius: "6px",
    border: "1px solid #334155",
    background: "transparent",
    color: "#94a3b8",
    cursor: "pointer",
    fontSize: "0.875rem",
  },
  logoutBtn: {
    padding: "0.5rem 1rem",
    borderRadius: "6px",
    border: "1px solid #ef4444",
    background: "transparent",
    color: "#ef4444",
    cursor: "pointer",
    fontSize: "0.875rem",
  },
  main: {
    padding: "0.5rem 0",
  },
  loadingText: {
    color: "#94a3b8",
    textAlign: "center",
    padding: "2rem",
  },
  errorBox: {
    background: "#2d1b1b",
    border: "1px solid #7f1d1d",
    borderRadius: "8px",
    padding: "1rem",
    textAlign: "center",
    color: "#fca5a5",
  },
  retryBtn: {
    marginTop: "0.5rem",
    padding: "0.375rem 0.75rem",
    borderRadius: "4px",
    border: "none",
    background: "#3b82f6",
    color: "#fff",
    cursor: "pointer",
    fontSize: "0.875rem",
  },
  emptyState: {
    textAlign: "center",
    padding: "3rem 1rem",
    color: "#94a3b8",
  },
  emptyTitle: {
    fontSize: "1.125rem",
    fontWeight: 600,
    color: "#cbd5e1",
    marginBottom: "0.5rem",
  },
  emptySubtitle: {
    fontSize: "0.875rem",
    color: "#64748b",
  },
  eventList: {
    listStyle: "none",
    padding: 0,
    margin: 0,
  },
  eventItem: {
    display: "grid",
    gridTemplateColumns: "120px 1fr auto",
    alignItems: "center",
    gap: "1rem",
    padding: "0.75rem 0.5rem",
    borderBottom: "1px solid #1e293b",
  },
  eventTime: {
    fontSize: "0.875rem",
    color: "#3b82f6",
    fontWeight: 500,
    fontVariantNumeric: "tabular-nums",
  },
  eventSummary: {
    fontSize: "0.9375rem",
    color: "#e2e8f0",
  },
  eventDate: {
    fontSize: "0.75rem",
    color: "#64748b",
    textAlign: "right",
  },
};
