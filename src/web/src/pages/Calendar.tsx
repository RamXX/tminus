/**
 * Calendar page.
 *
 * Hosts the UnifiedCalendar component with authentication wiring.
 * The page provides the header (user info, logout) and passes a bound
 * fetchEvents function to the calendar.
 *
 * Data pipeline:
 *   UnifiedCalendar -> fetchEvents(start, end) -> apiFetch -> /api/v1/events
 *   -> app-gateway proxy -> api-worker -> UserGraphDO
 */

import { useCallback } from "react";
import { useAuth } from "../lib/auth";
import { fetchEvents, createEvent, updateEvent, deleteEvent, ApiError } from "../lib/api";
import type { CalendarEvent, CreateEventPayload, UpdateEventPayload } from "../lib/api";
import { UnifiedCalendar } from "../components/UnifiedCalendar";

export function Calendar() {
  const { token, user, logout } = useAuth();

  /**
   * Adapter between UnifiedCalendar's (start, end) signature and the
   * API client's token-based signature. Also handles 401 -> logout.
   */
  const fetchCalendarEvents = useCallback(
    async (start: string, end: string): Promise<CalendarEvent[]> => {
      if (!token) return [];
      try {
        return await fetchEvents(token, { start, end });
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          logout();
          return [];
        }
        throw err;
      }
    },
    [token, logout],
  );

  /** Create a new event via the API. */
  const handleCreateEvent = useCallback(
    async (payload: CreateEventPayload): Promise<CalendarEvent> => {
      if (!token) throw new Error("Not authenticated");
      try {
        return await createEvent(token, payload);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          logout();
        }
        throw err;
      }
    },
    [token, logout],
  );

  /** Update an existing event via the API. */
  const handleUpdateEvent = useCallback(
    async (eventId: string, payload: UpdateEventPayload): Promise<CalendarEvent> => {
      if (!token) throw new Error("Not authenticated");
      try {
        return await updateEvent(token, eventId, payload);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          logout();
        }
        throw err;
      }
    },
    [token, logout],
  );

  /** Delete an event via the API. */
  const handleDeleteEvent = useCallback(
    async (eventId: string): Promise<void> => {
      if (!token) throw new Error("Not authenticated");
      try {
        await deleteEvent(token, eventId);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          logout();
        }
        throw err;
      }
    },
    [token, logout],
  );

  return (
    <div style={styles.container}>
      {/* Header */}
      <header style={styles.header}>
        <div>
          <h1 style={styles.title}>T-Minus Calendar</h1>
          <p style={styles.subtitle}>{user?.email ?? "Unknown user"}</p>
        </div>
        <div style={styles.headerActions}>
          <a href="#/accounts" style={styles.navLink}>
            Accounts
          </a>
          <a href="#/policies" style={styles.navLink}>
            Policies
          </a>
          <a href="#/sync-status" style={styles.navLink}>
            Sync Status
          </a>
          <button onClick={logout} style={styles.logoutBtn}>
            Sign Out
          </button>
        </div>
      </header>

      {/* Calendar */}
      <main style={styles.main}>
        <UnifiedCalendar
          fetchEvents={fetchCalendarEvents}
          onCreateEvent={handleCreateEvent}
          onUpdateEvent={handleUpdateEvent}
          onDeleteEvent={handleDeleteEvent}
        />
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline styles
// ---------------------------------------------------------------------------

const styles: Record<string, React.CSSProperties> = {
  container: {
    maxWidth: "1200px",
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
  navLink: {
    padding: "0.5rem 1rem",
    borderRadius: "6px",
    border: "1px solid #334155",
    background: "transparent",
    color: "#94a3b8",
    cursor: "pointer",
    fontSize: "0.875rem",
    textDecoration: "none",
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
};
