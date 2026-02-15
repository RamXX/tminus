/**
 * Calendar page.
 *
 * Hosts the UnifiedCalendar component with authentication wiring.
 * The page provides the header (user info, logout) and passes a bound
 * fetchEvents function to the calendar.
 *
 * Also integrates the UpgradePromptBanner (TM-d17.4) which shows
 * contextual upgrade nudges to ICS-only users when relevant triggers fire.
 *
 * Data pipeline:
 *   UnifiedCalendar -> fetchEvents(start, end) -> apiFetch -> /api/v1/events
 *   -> app-gateway proxy -> api-worker -> UserGraphDO
 */

import { useCallback, useState, useMemo } from "react";
import { useAuth } from "../lib/auth";
import { fetchEvents, createEvent, updateEvent, deleteEvent, fetchEventBriefing, generateExcuse, ApiError } from "../lib/api";
import type { CalendarEvent, CreateEventPayload, UpdateEventPayload } from "../lib/api";
import type { ExcuseTone, TruthLevel } from "../lib/briefing";
import { UnifiedCalendar } from "../components/UnifiedCalendar";
import { UpgradePromptBanner } from "../components/UpgradePromptBanner";
import { UpgradePromptManager } from "../lib/upgrade-prompts";
import type { PromptTriggerResult, EngagementMetrics, FeedContext } from "../lib/upgrade-prompts";

export function Calendar() {
  const { token, user, logout } = useAuth();

  // -------------------------------------------------------------------------
  // Upgrade prompt state (TM-d17.4)
  // -------------------------------------------------------------------------

  // Singleton manager survives re-renders but resets on unmount (new session)
  const promptManager = useMemo(
    () => new UpgradePromptManager(window.localStorage),
    [],
  );

  // The active prompt to display (null = no banner)
  const [activePrompt, setActivePrompt] = useState<PromptTriggerResult | null>(null);

  /**
   * Evaluate upgrade prompts with current engagement and context.
   * Called by child components or effects when context changes.
   */
  const evaluateUpgradePrompt = useCallback(
    (metrics: EngagementMetrics, context: FeedContext) => {
      const prompt = promptManager.evaluate(metrics, context);
      setActivePrompt(prompt);
      if (prompt) {
        promptManager.markSessionPromptShown(prompt.type);
      }
    },
    [promptManager],
  );

  /** Handle "Not now" dismissal -- suppresses this prompt type for 7 days. */
  const handlePromptDismiss = useCallback(() => {
    if (activePrompt) {
      promptManager.dismiss(activePrompt.type);
      setActivePrompt(null);
    }
  }, [activePrompt, promptManager]);

  /** Handle permanent dismissal -- disables all upgrade prompts via settings. */
  const handlePermanentDismiss = useCallback(() => {
    promptManager.setPermanentlyDismissed(true);
    setActivePrompt(null);
  }, [promptManager]);

  /** Handle "Upgrade" click -- navigate to onboarding for the provider. */
  const handlePromptUpgrade = useCallback(
    (provider?: string) => {
      // Navigate to onboarding page (Phase 6A flow)
      if (provider) {
        window.location.hash = `#/onboard?provider=${encodeURIComponent(provider)}`;
      } else {
        window.location.hash = "#/onboard";
      }
    },
    [],
  );

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

  /** Fetch pre-meeting context briefing for an event. */
  const handleFetchBriefing = useCallback(
    async (eventId: string) => {
      if (!token) throw new Error("Not authenticated");
      try {
        return await fetchEventBriefing(token, eventId);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          logout();
        }
        throw err;
      }
    },
    [token, logout],
  );

  /** Generate an excuse draft for an event. */
  const handleGenerateExcuse = useCallback(
    async (
      eventId: string,
      params: { tone: ExcuseTone; truth_level: TruthLevel },
    ) => {
      if (!token) throw new Error("Not authenticated");
      try {
        return await generateExcuse(token, eventId, params);
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

      {/* Upgrade prompt banner (TM-d17.4) */}
      <UpgradePromptBanner
        prompt={activePrompt}
        onDismiss={handlePromptDismiss}
        onUpgrade={handlePromptUpgrade}
        onPermanentDismiss={handlePermanentDismiss}
      />

      {/* Calendar */}
      <main style={styles.main}>
        <UnifiedCalendar
          fetchEvents={fetchCalendarEvents}
          onCreateEvent={handleCreateEvent}
          onUpdateEvent={handleUpdateEvent}
          onDeleteEvent={handleDeleteEvent}
          fetchBriefing={handleFetchBriefing}
          generateExcuse={handleGenerateExcuse}
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
