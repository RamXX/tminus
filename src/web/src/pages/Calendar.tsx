/**
 * Calendar page.
 *
 * Hosts the UnifiedCalendar component with authentication wiring.
 * Uses useApi() for token-injected API calls and useAuth() for user context.
 *
 * Also integrates the UpgradePromptBanner (TM-d17.4) which shows
 * contextual upgrade nudges to ICS-only users when relevant triggers fire.
 *
 * Data pipeline:
 *   UnifiedCalendar -> fetchEvents(start, end) -> useApi().fetchEventsFull -> /api/v1/events
 *   -> app-gateway proxy -> api-worker -> UserGraphDO
 */

import { useCallback, useState, useMemo } from "react";
import { useAuth } from "../lib/auth";
import { useApi } from "../lib/api-provider";
import { ApiError } from "../lib/api";
import type { CalendarEvent, CreateEventPayload, UpdateEventPayload } from "../lib/api";
import type { ExcuseTone, TruthLevel } from "../lib/briefing";
import { UnifiedCalendar } from "../components/UnifiedCalendar";
import { UpgradePromptBanner } from "../components/UpgradePromptBanner";
import { UpgradePromptManager } from "../lib/upgrade-prompts";
import type { PromptTriggerResult, EngagementMetrics, FeedContext } from "../lib/upgrade-prompts";

export function Calendar() {
  const { user, logout } = useAuth();
  const api = useApi();

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
   * API provider's token-based functions. Also handles 401 -> logout.
   */
  const fetchCalendarEvents = useCallback(
    async (start: string, end: string): Promise<CalendarEvent[]> => {
      try {
        return await api.fetchEventsFull({ start, end });
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          logout();
          return [];
        }
        throw err;
      }
    },
    [api, logout],
  );

  /** Create a new event via the API. */
  const handleCreateEvent = useCallback(
    async (payload: CreateEventPayload): Promise<CalendarEvent> => {
      try {
        return await api.createEvent(payload);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          logout();
        }
        throw err;
      }
    },
    [api, logout],
  );

  /** Update an existing event via the API. */
  const handleUpdateEvent = useCallback(
    async (eventId: string, payload: UpdateEventPayload): Promise<CalendarEvent> => {
      try {
        return await api.updateEvent(eventId, payload);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          logout();
        }
        throw err;
      }
    },
    [api, logout],
  );

  /** Delete an event via the API. */
  const handleDeleteEvent = useCallback(
    async (eventId: string): Promise<void> => {
      try {
        await api.deleteEvent(eventId);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          logout();
        }
        throw err;
      }
    },
    [api, logout],
  );

  /** Fetch pre-meeting context briefing for an event. */
  const handleFetchBriefing = useCallback(
    async (eventId: string) => {
      try {
        return await api.fetchEventBriefing(eventId);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          logout();
        }
        throw err;
      }
    },
    [api, logout],
  );

  /** Generate an excuse draft for an event. */
  const handleGenerateExcuse = useCallback(
    async (
      eventId: string,
      params: { tone: ExcuseTone; truth_level: TruthLevel },
    ) => {
      try {
        return await api.generateExcuse(eventId, params);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          logout();
        }
        throw err;
      }
    },
    [api, logout],
  );

  return (
    <div className="mx-auto max-w-[1200px] bg-background">
      {/* Upgrade prompt banner (TM-d17.4) */}
      <UpgradePromptBanner
        prompt={activePrompt}
        onDismiss={handlePromptDismiss}
        onUpgrade={handlePromptUpgrade}
        onPermanentDismiss={handlePermanentDismiss}
      />

      {/* Calendar */}
      <main className="py-2">
        <h1 className="text-lg font-semibold tracking-tight text-foreground sr-only">Calendar</h1>
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
