/**
 * UnifiedCalendar -- unified calendar view with event creation.
 *
 * Shows events from all accounts in a single calendar with week, month,
 * and day views. Events are color-coded by origin account.
 * Click empty time slots to create new events.
 *
 * This is a custom CSS grid calendar. No FullCalendar dependency.
 *
 * Props:
 *   fetchEvents(start, end) -> Promise<CalendarEvent[]>
 *     The caller provides the fetch function, making this component testable
 *     without mocking global fetch or the API module.
 *   onCreateEvent(payload) -> Promise<CalendarEvent>
 *     Optional. Called when the user submits the event creation form.
 *     Returns the created CalendarEvent from the API. When provided,
 *     clicking empty time slots opens the creation form.
 */

import { useState, useEffect, useCallback, useMemo } from "react";
import type { CalendarEvent, CreateEventPayload, UpdateEventPayload } from "../lib/api";
import type { EventBriefing, ExcuseOutput, ExcuseTone, TruthLevel } from "../lib/briefing";
import {
  getAccountColor,
  getDateRangeForView,
  getWeekRange,
  getMonthRange,
  getDayRange,
  groupEventsByDate,
  formatTimeShort,
  formatDateHeader,
  getHoursInDay,
  isToday,
  isSameDay,
  type CalendarViewType,
  type DateRange,
} from "../lib/calendar-utils";
import {
  createOptimisticEvent,
  addOptimisticEvent,
  replaceOptimisticEvent,
  removeOptimisticEvent,
  updateOptimisticEvent,
  deleteOptimisticEvent,
} from "../lib/event-form";
import { EventDetail } from "./EventDetail";
import { EventCreateForm } from "./EventCreateForm";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UnifiedCalendarProps {
  /** Fetch events for a date range. Returns CalendarEvent[]. */
  fetchEvents: (start: string, end: string) => Promise<CalendarEvent[]>;
  /** Optional. Create a new event. Returns the created CalendarEvent. */
  onCreateEvent?: (payload: CreateEventPayload) => Promise<CalendarEvent>;
  /** Optional. Update an existing event. Returns the updated CalendarEvent. */
  onUpdateEvent?: (eventId: string, payload: UpdateEventPayload) => Promise<CalendarEvent>;
  /** Optional. Delete an event by ID. */
  onDeleteEvent?: (eventId: string) => Promise<void>;
  /** Optional. Fetch pre-meeting context briefing for an event. */
  fetchBriefing?: (eventId: string) => Promise<EventBriefing>;
  /** Optional. Generate an excuse draft for an event. */
  generateExcuse?: (
    eventId: string,
    params: { tone: ExcuseTone; truth_level: TruthLevel },
  ) => Promise<ExcuseOutput>;
  /** Initial date to display. Defaults to today. */
  initialDate?: Date;
  /** Initial view. Defaults to "week". */
  initialView?: CalendarViewType;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function UnifiedCalendar({
  fetchEvents,
  onCreateEvent,
  onUpdateEvent,
  onDeleteEvent,
  fetchBriefing,
  generateExcuse,
  initialDate,
  initialView = "week",
}: UnifiedCalendarProps) {
  const [currentDate, setCurrentDate] = useState(initialDate ?? new Date());
  const [view, setView] = useState<CalendarViewType>(initialView);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);

  // Event creation state
  const [createDate, setCreateDate] = useState<Date | null>(null);
  const [createSubmitting, setCreateSubmitting] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Event edit/delete state
  const [editSaving, setEditSaving] = useState(false);
  const [editDeleting, setEditDeleting] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const handleEventClick = useCallback((event: CalendarEvent) => {
    setSelectedEvent(event);
    setEditError(null);
  }, []);

  const handleCloseDetail = useCallback(() => {
    setSelectedEvent(null);
    setEditError(null);
  }, []);

  // Save edits with optimistic update
  const handleSaveEvent = useCallback(
    async (eventId: string, payload: UpdateEventPayload) => {
      if (!onUpdateEvent || !selectedEvent) return;

      setEditSaving(true);
      setEditError(null);

      // Snapshot for rollback
      const snapshot = [...events];

      // Optimistic update
      setEvents((prev) => updateOptimisticEvent(prev, eventId, payload));

      // Update selectedEvent optimistically so the panel shows the new values
      setSelectedEvent((prev) => {
        if (!prev || prev.canonical_event_id !== eventId) return prev;
        return {
          ...prev,
          ...(payload.summary !== undefined && { summary: payload.summary }),
          ...(payload.start !== undefined && { start: payload.start }),
          ...(payload.end !== undefined && { end: payload.end }),
          ...(payload.description !== undefined && { description: payload.description }),
          ...(payload.location !== undefined && { location: payload.location }),
        };
      });

      try {
        const updated = await onUpdateEvent(eventId, payload);
        // Replace optimistic with real from API
        setEvents((prev) =>
          prev.map((e) => (e.canonical_event_id === eventId ? updated : e)),
        );
        setSelectedEvent(updated);
      } catch (err) {
        // Rollback
        setEvents(snapshot);
        setSelectedEvent(selectedEvent);
        setEditError(
          err instanceof Error ? err.message : "Failed to save changes",
        );
      } finally {
        setEditSaving(false);
      }
    },
    [onUpdateEvent, selectedEvent, events],
  );

  // Delete with optimistic removal
  const handleDeleteEvent = useCallback(
    async (eventId: string) => {
      if (!onDeleteEvent) return;

      setEditDeleting(true);
      setEditError(null);

      // Snapshot for rollback
      const snapshot = [...events];

      // Optimistic removal
      setEvents((prev) => deleteOptimisticEvent(prev, eventId));

      try {
        await onDeleteEvent(eventId);
        // Success -- close the detail panel
        setSelectedEvent(null);
      } catch (err) {
        // Rollback
        setEvents(snapshot);
        setEditError(
          err instanceof Error ? err.message : "Failed to delete event",
        );
      } finally {
        setEditDeleting(false);
      }
    },
    [onDeleteEvent, events],
  );

  // Time slot click handler -- opens creation form
  const handleTimeSlotClick = useCallback(
    (date: Date) => {
      if (!onCreateEvent) return;
      setCreateDate(date);
      setCreateError(null);
    },
    [onCreateEvent],
  );

  // Cancel creation form
  const handleCancelCreate = useCallback(() => {
    setCreateDate(null);
    setCreateError(null);
    setCreateSubmitting(false);
  }, []);

  // Submit creation form with optimistic update
  const handleSubmitCreate = useCallback(
    async (payload: CreateEventPayload) => {
      if (!onCreateEvent) return;

      setCreateSubmitting(true);
      setCreateError(null);

      // Optimistic: add a temp event immediately
      const optimistic = createOptimisticEvent(payload);
      setEvents((prev) => addOptimisticEvent(prev, optimistic));

      // Close form immediately (optimistic)
      setCreateDate(null);

      try {
        const real = await onCreateEvent(payload);
        // Replace temp with real event
        setEvents((prev) =>
          replaceOptimisticEvent(prev, optimistic.canonical_event_id, real),
        );
      } catch (err) {
        // Rollback: remove optimistic event
        setEvents((prev) =>
          removeOptimisticEvent(prev, optimistic.canonical_event_id),
        );
        // Re-open form with error
        setCreateDate(new Date(`${payload.start}`));
        setCreateError(
          err instanceof Error ? err.message : "Failed to create event",
        );
      } finally {
        setCreateSubmitting(false);
      }
    },
    [onCreateEvent],
  );

  // Compute the date range for the current view
  const range = useMemo(
    () => getDateRangeForView(currentDate, view),
    [currentDate, view],
  );

  // Fetch events whenever range changes
  const loadEvents = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchEvents(
        range.start.toISOString(),
        range.end.toISOString(),
      );
      setEvents(data ?? []);
    } catch (err) {
      setError(
        err instanceof Error ? "Failed to load events" : "Failed to load events",
      );
    } finally {
      setLoading(false);
    }
  }, [fetchEvents, range]);

  useEffect(() => {
    loadEvents();
  }, [loadEvents]);

  // Navigation handlers
  const navigatePrev = useCallback(() => {
    setCurrentDate((d) => {
      const next = new Date(d);
      switch (view) {
        case "week":
          next.setDate(next.getDate() - 7);
          break;
        case "month":
          next.setMonth(next.getMonth() - 1);
          break;
        case "day":
          next.setDate(next.getDate() - 1);
          break;
      }
      return next;
    });
  }, [view]);

  const navigateNext = useCallback(() => {
    setCurrentDate((d) => {
      const next = new Date(d);
      switch (view) {
        case "week":
          next.setDate(next.getDate() + 7);
          break;
        case "month":
          next.setMonth(next.getMonth() + 1);
          break;
        case "day":
          next.setDate(next.getDate() + 1);
          break;
      }
      return next;
    });
  }, [view]);

  const navigateToday = useCallback(() => {
    setCurrentDate(new Date());
  }, []);

  const changeView = useCallback((newView: CalendarViewType) => {
    setView(newView);
  }, []);

  // Date header text
  const dateHeaderText = useMemo(() => {
    switch (view) {
      case "week": {
        const s = range.start.toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
        });
        const e = range.end.toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
          year: "numeric",
        });
        return `${s} - ${e}`;
      }
      case "month":
        return currentDate.toLocaleDateString(undefined, {
          month: "long",
          year: "numeric",
        });
      case "day":
        return currentDate.toLocaleDateString(undefined, {
          weekday: "long",
          month: "long",
          day: "numeric",
          year: "numeric",
        });
    }
  }, [view, currentDate, range]);

  return (
    <div className="w-full">
      {/* Toolbar: navigation + view switch */}
      <div className="flex justify-between items-center py-3 mb-3 flex-wrap gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={navigateToday}
            className="px-3 py-1.5 rounded-md border border-border bg-transparent text-muted-foreground cursor-pointer text-[0.8125rem] font-medium hover:bg-card/50"
            aria-label="Today"
          >
            Today
          </button>
          <button
            onClick={navigatePrev}
            className="px-3 py-1.5 rounded-md border border-border bg-transparent text-muted-foreground cursor-pointer text-[0.8125rem] font-medium hover:bg-card/50"
            aria-label="Previous"
          >
            Prev
          </button>
          <button
            onClick={navigateNext}
            className="px-3 py-1.5 rounded-md border border-border bg-transparent text-muted-foreground cursor-pointer text-[0.8125rem] font-medium hover:bg-card/50"
            aria-label="Next"
          >
            Next
          </button>
          <span className="font-mono text-xs text-muted-foreground ml-2" data-testid="calendar-date-header">
            {dateHeaderText}
          </span>
        </div>
        <div className="flex gap-1">
          {(["day", "week", "month"] as CalendarViewType[]).map((v) => (
            <button
              key={v}
              onClick={() => changeView(v)}
              className={`px-3 py-1.5 rounded-md border cursor-pointer text-[0.8125rem] font-medium transition-colors ${
                view === v
                  ? "bg-primary/15 text-primary border-primary/30"
                  : "border-border bg-transparent text-muted-foreground hover:bg-card/50"
              }`}
              aria-pressed={view === v}
              aria-label={v.charAt(0).toUpperCase() + v.slice(1)}
            >
              {v.charAt(0).toUpperCase() + v.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Loading state */}
      {loading && (
        <div className="p-8 text-center" data-testid="calendar-loading">
          <div className="flex flex-col gap-3 mb-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-8 rounded bg-card animate-pulse" />
            ))}
          </div>
          <p className="text-muted-foreground text-sm">Loading events...</p>
        </div>
      )}

      {/* Error state */}
      {!loading && error && (
        <div className="bg-destructive/10 border border-destructive/30 rounded-lg p-6 text-center">
          <p className="text-destructive text-[0.9375rem] mb-3">Failed to load events</p>
          <button
            onClick={loadEvents}
            className="px-4 py-2 rounded-md border-none bg-primary text-primary-foreground cursor-pointer text-sm font-medium"
            aria-label="Retry"
          >
            Retry
          </button>
        </div>
      )}

      {/* Calendar content */}
      {!loading && !error && (
        <>
          {events.length === 0 && !onCreateEvent ? (
            <div className="text-center py-12 px-4">
              <p className="text-lg font-semibold text-foreground mb-2">No events in this period</p>
              <p className="text-sm text-muted-foreground">
                Try a different date range or link more calendar accounts.
              </p>
            </div>
          ) : (
            <CalendarBody
              view={view}
              events={events}
              range={range}
              currentDate={currentDate}
              onEventClick={handleEventClick}
              onTimeSlotClick={onCreateEvent ? handleTimeSlotClick : undefined}
            />
          )}
          {events.length === 0 && onCreateEvent && (
            <p className="text-center p-4 text-[0.8125rem] text-muted-foreground">Click a time slot to create an event.</p>
          )}
        </>
      )}

      {/* Event detail panel */}
      {selectedEvent && (
        <EventDetail
          event={selectedEvent}
          onClose={handleCloseDetail}
          onSave={onUpdateEvent ? handleSaveEvent : undefined}
          onDelete={onDeleteEvent ? handleDeleteEvent : undefined}
          saving={editSaving}
          deleting={editDeleting}
          error={editError}
          fetchBriefing={fetchBriefing}
          generateExcuse={generateExcuse}
        />
      )}

      {/* Event creation form */}
      {createDate && (
        <EventCreateForm
          initialDate={createDate}
          onSubmit={handleSubmitCreate}
          onCancel={handleCancelCreate}
          submitting={createSubmitting}
          error={createError}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CalendarBody -- renders the appropriate view
// ---------------------------------------------------------------------------

function CalendarBody({
  view,
  events,
  range,
  currentDate,
  onEventClick,
  onTimeSlotClick,
}: {
  view: CalendarViewType;
  events: CalendarEvent[];
  range: DateRange;
  currentDate: Date;
  onEventClick: (event: CalendarEvent) => void;
  onTimeSlotClick?: (date: Date) => void;
}) {
  switch (view) {
    case "week":
      return <WeekView events={events} range={range} onEventClick={onEventClick} onTimeSlotClick={onTimeSlotClick} />;
    case "month":
      return (
        <MonthView events={events} currentDate={currentDate} range={range} onEventClick={onEventClick} onTimeSlotClick={onTimeSlotClick} />
      );
    case "day":
      return <DayView events={events} currentDate={currentDate} onEventClick={onEventClick} onTimeSlotClick={onTimeSlotClick} />;
  }
}

// ---------------------------------------------------------------------------
// WeekView
// ---------------------------------------------------------------------------

function WeekView({
  events,
  range,
  onEventClick,
  onTimeSlotClick,
}: {
  events: CalendarEvent[];
  range: DateRange;
  onEventClick: (event: CalendarEvent) => void;
  onTimeSlotClick?: (date: Date) => void;
}) {
  // Generate the 7 days of the week
  const days = useMemo(() => {
    const result: Date[] = [];
    const d = new Date(range.start);
    for (let i = 0; i < 7; i++) {
      result.push(new Date(d));
      d.setDate(d.getDate() + 1);
    }
    return result;
  }, [range]);

  const grouped = useMemo(() => groupEventsByDate(events), [events]);

  return (
    <div className="grid grid-cols-7 gap-px bg-border rounded-lg overflow-hidden">
      {/* Day headers */}
      {days.map((day, i) => {
        const key = formatDateKey(day);
        const dayEvents = grouped[key] ?? [];
        const today = isToday(day);

        const handleSlotClick = onTimeSlotClick
          ? () => {
              // Default to 9 AM on the clicked day
              const slotDate = new Date(day);
              slotDate.setHours(9, 0, 0, 0);
              onTimeSlotClick(slotDate);
            }
          : undefined;

        return (
          <div
            key={i}
            className={`bg-background min-h-[120px] hover:bg-card/50 ${onTimeSlotClick ? "cursor-pointer" : ""}`}
            onClick={handleSlotClick}
            data-testid={`week-day-slot-${formatDateKey(day)}`}
            role={onTimeSlotClick ? "button" : undefined}
            tabIndex={onTimeSlotClick ? 0 : undefined}
            onKeyDown={
              onTimeSlotClick
                ? (e) => { if (e.key === "Enter" || e.key === " ") handleSlotClick?.(); }
                : undefined
            }
          >
            <div
              className={`p-2 text-center border-b border-border ${today ? "bg-primary/15" : ""}`}
            >
              <span className={`block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground ${today ? "border-b-2 border-primary pb-0.5" : ""}`}>
                {day.toLocaleDateString(undefined, { weekday: "short" })}
              </span>
              <span
                className={`inline-block font-mono text-xs px-1.5 py-0.5 rounded-full leading-normal ${
                  today
                    ? "text-primary font-bold"
                    : "text-foreground"
                }`}
              >
                {day.getDate()}
              </span>
            </div>
            <div className="p-1 flex flex-col gap-0.5">
              {dayEvents.map((evt) => (
                <EventChip key={evt.canonical_event_id} event={evt} onClick={onEventClick} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// MonthView
// ---------------------------------------------------------------------------

function MonthView({
  events,
  currentDate,
  range,
  onEventClick,
  onTimeSlotClick,
}: {
  events: CalendarEvent[];
  currentDate: Date;
  range: DateRange;
  onEventClick: (event: CalendarEvent) => void;
  onTimeSlotClick?: (date: Date) => void;
}) {
  const grouped = useMemo(() => groupEventsByDate(events), [events]);

  // Build a grid of weeks. Pad the first week to start on Sunday
  // and pad the last week to end on Saturday.
  const weeks = useMemo(() => {
    const result: Date[][] = [];
    // Start from the Sunday of the week containing the 1st
    const firstDay = new Date(range.start);
    const startPad = new Date(firstDay);
    startPad.setDate(startPad.getDate() - startPad.getDay());

    let current = new Date(startPad);
    let currentWeek: Date[] = [];

    // Generate at most 6 weeks (42 days)
    for (let i = 0; i < 42; i++) {
      currentWeek.push(new Date(current));
      if (currentWeek.length === 7) {
        result.push(currentWeek);
        currentWeek = [];
        // Stop if we've passed the month end and completed the week
        if (current.getMonth() !== currentDate.getMonth() && i > 6) break;
      }
      current.setDate(current.getDate() + 1);
    }
    if (currentWeek.length > 0) {
      // Pad last week
      while (currentWeek.length < 7) {
        currentWeek.push(new Date(current));
        current.setDate(current.getDate() + 1);
      }
      result.push(currentWeek);
    }

    return result;
  }, [range, currentDate]);

  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  return (
    <div>
      {/* Day-of-week headers */}
      <div className="grid grid-cols-7 gap-px mb-px">
        {dayNames.map((name) => (
          <div key={name} className="p-2 text-center text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {name}
          </div>
        ))}
      </div>
      {/* Weeks */}
      {weeks.map((week, wi) => (
        <div key={wi} className="grid grid-cols-7 gap-px mb-px">
          {week.map((day, di) => {
            const key = formatDateKey(day);
            const dayEvents = grouped[key] ?? [];
            const inMonth = day.getMonth() === currentDate.getMonth();
            const today = isToday(day);

            const handleMonthSlotClick = onTimeSlotClick
              ? () => {
                  const slotDate = new Date(day);
                  slotDate.setHours(9, 0, 0, 0);
                  onTimeSlotClick(slotDate);
                }
              : undefined;

            return (
              <div
                key={di}
                className={`bg-background min-h-[80px] p-1 rounded-sm hover:bg-card/50 ${!inMonth ? "opacity-40" : ""} ${onTimeSlotClick ? "cursor-pointer" : ""}`}
                onClick={handleMonthSlotClick}
                data-testid={`month-day-slot-${formatDateKey(day)}`}
                role={onTimeSlotClick ? "button" : undefined}
                tabIndex={onTimeSlotClick ? 0 : undefined}
                onKeyDown={
                  onTimeSlotClick
                    ? (e) => { if (e.key === "Enter" || e.key === " ") handleMonthSlotClick?.(); }
                    : undefined
                }
              >
                <span
                  className={`inline-block font-mono text-xs px-1.5 py-0.5 rounded-full mb-0.5 ${
                    today
                      ? "text-primary font-bold"
                      : "text-muted-foreground"
                  }`}
                >
                  {day.getDate()}
                </span>
                <div className="flex flex-col gap-px">
                  {dayEvents.slice(0, 3).map((evt) => (
                    <EventDot key={evt.canonical_event_id} event={evt} onClick={onEventClick} />
                  ))}
                  {dayEvents.length > 3 && (
                    <span className="text-[0.6875rem] text-muted-foreground pl-1">
                      +{dayEvents.length - 3}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DayView
// ---------------------------------------------------------------------------

function DayView({
  events,
  currentDate,
  onEventClick,
  onTimeSlotClick,
}: {
  events: CalendarEvent[];
  currentDate: Date;
  onEventClick: (event: CalendarEvent) => void;
  onTimeSlotClick?: (date: Date) => void;
}) {
  const grouped = useMemo(() => groupEventsByDate(events), [events]);
  const key = formatDateKey(currentDate);
  const dayEvents = grouped[key] ?? [];

  const handleDaySlotClick = onTimeSlotClick
    ? () => {
        const slotDate = new Date(currentDate);
        slotDate.setHours(9, 0, 0, 0);
        onTimeSlotClick(slotDate);
      }
    : undefined;

  return (
    <div
      className={`bg-background rounded-lg border border-border overflow-hidden hover:bg-card/50 ${onTimeSlotClick ? "cursor-pointer" : ""}`}
      onClick={handleDaySlotClick}
      data-testid={`day-slot-${formatDateKey(currentDate)}`}
      role={onTimeSlotClick ? "button" : undefined}
      tabIndex={onTimeSlotClick ? 0 : undefined}
      onKeyDown={
        onTimeSlotClick
          ? (e) => { if (e.key === "Enter" || e.key === " ") handleDaySlotClick?.(); }
          : undefined
      }
    >
      <div className="p-4 border-b border-border">
        <span className="text-lg font-semibold text-foreground">
          {formatDateHeader(currentDate)}
        </span>
      </div>
      {dayEvents.length === 0 ? (
        <p className="text-muted-foreground text-center p-8 text-sm">No events today</p>
      ) : (
        <div className="flex flex-col gap-2 p-3">
          {dayEvents.map((evt) => (
            <EventCard key={evt.canonical_event_id} event={evt} onClick={onEventClick} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Event rendering sub-components
// ---------------------------------------------------------------------------

/** Compact event chip for week view. */
function EventChip({ event, onClick }: { event: CalendarEvent; onClick: (event: CalendarEvent) => void }) {
  const color = getAccountColor(event.origin_account_id);
  return (
    <div
      className="flex items-center gap-1 rounded-sm px-2 py-1 text-xs truncate cursor-pointer border-l-2"
      style={{ borderLeftColor: color, backgroundColor: hexToRgba(color, 0.15) }}
      onClick={(e) => { e.stopPropagation(); onClick(event); }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); onClick(event); } }}
      data-testid={`event-chip-${event.canonical_event_id}`}
    >
      <span
        className="w-1.5 h-1.5 rounded-full shrink-0 inline-block"
        style={{ backgroundColor: color }}
        data-testid="event-color-indicator"
      />
      <span className="font-mono text-xs text-muted-foreground shrink-0">
        {formatTimeShort(event.start)}
      </span>
      <span className="font-sans text-foreground overflow-hidden text-ellipsis">
        {event.summary ?? "(No title)"}
      </span>
    </div>
  );
}

/** Small dot + title for month view (compact). */
function EventDot({ event, onClick }: { event: CalendarEvent; onClick: (event: CalendarEvent) => void }) {
  const color = getAccountColor(event.origin_account_id);
  return (
    <div
      className="flex items-center gap-[3px] text-[0.625rem] overflow-hidden whitespace-nowrap cursor-pointer"
      onClick={(e) => { e.stopPropagation(); onClick(event); }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); onClick(event); } }}
      data-testid={`event-dot-${event.canonical_event_id}`}
    >
      <span
        className="w-[5px] h-[5px] rounded-full shrink-0 inline-block"
        style={{ backgroundColor: color }}
        data-testid="event-color-indicator"
      />
      <span className="font-sans text-muted-foreground overflow-hidden text-ellipsis">
        {event.summary ?? "(No title)"}
      </span>
    </div>
  );
}

/** Full event card for day view. */
function EventCard({ event, onClick }: { event: CalendarEvent; onClick: (event: CalendarEvent) => void }) {
  const color = getAccountColor(event.origin_account_id);
  return (
    <div
      className="flex items-stretch gap-3 rounded-sm px-2 py-1 text-xs truncate cursor-pointer border-l-2"
      style={{ borderLeftColor: color, backgroundColor: hexToRgba(color, 0.15) }}
      onClick={(e) => { e.stopPropagation(); onClick(event); }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); onClick(event); } }}
      data-testid={`event-card-${event.canonical_event_id}`}
    >
      <span
        className="w-1 rounded-sm shrink-0 hidden"
        style={{ backgroundColor: color }}
        data-testid="event-color-indicator"
      />
      <div className="flex-1 min-w-0">
        <div className="font-sans text-[0.9375rem] font-medium text-foreground mb-1">
          {event.summary ?? "(No title)"}
        </div>
        <div className="font-mono text-xs text-muted-foreground">
          {formatTimeShort(event.start)} - {formatTimeShort(event.end)}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format a Date to a YYYY-MM-DD key string for grouping. */
function formatDateKey(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Convert a hex color to rgba with the given alpha. */
function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
