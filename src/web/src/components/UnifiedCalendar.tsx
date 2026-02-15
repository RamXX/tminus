/**
 * UnifiedCalendar -- read-only unified calendar view.
 *
 * Shows events from all accounts in a single calendar with week, month,
 * and day views. Events are color-coded by origin account.
 *
 * This is a custom CSS grid calendar. No FullCalendar dependency.
 *
 * Props:
 *   fetchEvents(start, end) -> Promise<CalendarEvent[]>
 *     The caller provides the fetch function, making this component testable
 *     without mocking global fetch or the API module.
 */

import { useState, useEffect, useCallback, useMemo } from "react";
import type { CalendarEvent } from "../lib/api";
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UnifiedCalendarProps {
  /** Fetch events for a date range. Returns CalendarEvent[]. */
  fetchEvents: (start: string, end: string) => Promise<CalendarEvent[]>;
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
  initialDate,
  initialView = "week",
}: UnifiedCalendarProps) {
  const [currentDate, setCurrentDate] = useState(initialDate ?? new Date());
  const [view, setView] = useState<CalendarViewType>(initialView);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
    <div style={styles.container}>
      {/* Toolbar: navigation + view switch */}
      <div style={styles.toolbar}>
        <div style={styles.navGroup}>
          <button
            onClick={navigateToday}
            style={styles.navBtn}
            aria-label="Today"
          >
            Today
          </button>
          <button
            onClick={navigatePrev}
            style={styles.navBtn}
            aria-label="Previous"
          >
            Prev
          </button>
          <button
            onClick={navigateNext}
            style={styles.navBtn}
            aria-label="Next"
          >
            Next
          </button>
          <span style={styles.dateHeader} data-testid="calendar-date-header">
            {dateHeaderText}
          </span>
        </div>
        <div style={styles.viewGroup}>
          {(["day", "week", "month"] as CalendarViewType[]).map((v) => (
            <button
              key={v}
              onClick={() => changeView(v)}
              style={
                view === v
                  ? { ...styles.viewBtn, ...styles.viewBtnActive }
                  : styles.viewBtn
              }
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
        <div style={styles.loadingContainer} data-testid="calendar-loading">
          <div style={styles.loadingSkeleton}>
            {[1, 2, 3].map((i) => (
              <div key={i} style={styles.skeletonRow} />
            ))}
          </div>
          <p style={styles.loadingText}>Loading events...</p>
        </div>
      )}

      {/* Error state */}
      {!loading && error && (
        <div style={styles.errorContainer}>
          <p style={styles.errorText}>Failed to load events</p>
          <button
            onClick={loadEvents}
            style={styles.retryBtn}
            aria-label="Retry"
          >
            Retry
          </button>
        </div>
      )}

      {/* Calendar content */}
      {!loading && !error && (
        <>
          {events.length === 0 ? (
            <div style={styles.emptyState}>
              <p style={styles.emptyTitle}>No events in this period</p>
              <p style={styles.emptySubtitle}>
                Try a different date range or link more calendar accounts.
              </p>
            </div>
          ) : (
            <CalendarBody
              view={view}
              events={events}
              range={range}
              currentDate={currentDate}
            />
          )}
        </>
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
}: {
  view: CalendarViewType;
  events: CalendarEvent[];
  range: DateRange;
  currentDate: Date;
}) {
  switch (view) {
    case "week":
      return <WeekView events={events} range={range} />;
    case "month":
      return (
        <MonthView events={events} currentDate={currentDate} range={range} />
      );
    case "day":
      return <DayView events={events} currentDate={currentDate} />;
  }
}

// ---------------------------------------------------------------------------
// WeekView
// ---------------------------------------------------------------------------

function WeekView({
  events,
  range,
}: {
  events: CalendarEvent[];
  range: DateRange;
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
    <div style={styles.weekGrid}>
      {/* Day headers */}
      {days.map((day, i) => {
        const key = formatDateKey(day);
        const dayEvents = grouped[key] ?? [];
        const today = isToday(day);

        return (
          <div key={i} style={styles.weekDay}>
            <div
              style={{
                ...styles.weekDayHeader,
                ...(today ? styles.todayHeader : {}),
              }}
            >
              <span style={styles.weekDayName}>
                {day.toLocaleDateString(undefined, { weekday: "short" })}
              </span>
              <span
                style={{
                  ...styles.weekDayNumber,
                  ...(today ? styles.todayNumber : {}),
                }}
              >
                {day.getDate()}
              </span>
            </div>
            <div style={styles.weekDayEvents}>
              {dayEvents.map((evt) => (
                <EventChip key={evt.canonical_event_id} event={evt} />
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
}: {
  events: CalendarEvent[];
  currentDate: Date;
  range: DateRange;
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
      <div style={styles.monthHeaderRow}>
        {dayNames.map((name) => (
          <div key={name} style={styles.monthHeaderCell}>
            {name}
          </div>
        ))}
      </div>
      {/* Weeks */}
      {weeks.map((week, wi) => (
        <div key={wi} style={styles.monthWeekRow}>
          {week.map((day, di) => {
            const key = formatDateKey(day);
            const dayEvents = grouped[key] ?? [];
            const inMonth = day.getMonth() === currentDate.getMonth();
            const today = isToday(day);

            return (
              <div
                key={di}
                style={{
                  ...styles.monthCell,
                  ...(inMonth ? {} : styles.monthCellOutside),
                }}
              >
                <span
                  style={{
                    ...styles.monthCellDay,
                    ...(today ? styles.todayNumber : {}),
                  }}
                >
                  {day.getDate()}
                </span>
                <div style={styles.monthCellEvents}>
                  {dayEvents.slice(0, 3).map((evt) => (
                    <EventDot key={evt.canonical_event_id} event={evt} />
                  ))}
                  {dayEvents.length > 3 && (
                    <span style={styles.moreEvents}>
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
}: {
  events: CalendarEvent[];
  currentDate: Date;
}) {
  const grouped = useMemo(() => groupEventsByDate(events), [events]);
  const key = formatDateKey(currentDate);
  const dayEvents = grouped[key] ?? [];

  return (
    <div style={styles.dayContainer}>
      <div style={styles.dayHeader}>
        <span style={styles.dayHeaderDate}>
          {formatDateHeader(currentDate)}
        </span>
      </div>
      {dayEvents.length === 0 ? (
        <p style={styles.dayEmpty}>No events today</p>
      ) : (
        <div style={styles.dayEventList}>
          {dayEvents.map((evt) => (
            <EventCard key={evt.canonical_event_id} event={evt} />
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
function EventChip({ event }: { event: CalendarEvent }) {
  const color = getAccountColor(event.origin_account_id);
  return (
    <div style={styles.eventChip}>
      <span
        style={{ ...styles.colorIndicator, backgroundColor: color }}
        data-testid="event-color-indicator"
      />
      <span style={styles.eventChipTime}>
        {formatTimeShort(event.start)}
      </span>
      <span style={styles.eventChipTitle}>
        {event.summary ?? "(No title)"}
      </span>
    </div>
  );
}

/** Small dot + title for month view (compact). */
function EventDot({ event }: { event: CalendarEvent }) {
  const color = getAccountColor(event.origin_account_id);
  return (
    <div style={styles.eventDot}>
      <span
        style={{ ...styles.dotIndicator, backgroundColor: color }}
        data-testid="event-color-indicator"
      />
      <span style={styles.eventDotTitle}>
        {event.summary ?? "(No title)"}
      </span>
    </div>
  );
}

/** Full event card for day view. */
function EventCard({ event }: { event: CalendarEvent }) {
  const color = getAccountColor(event.origin_account_id);
  return (
    <div style={{ ...styles.eventCard, borderLeftColor: color } as React.CSSProperties}>
      <span
        style={{ ...styles.cardColorBar, backgroundColor: color }}
        data-testid="event-color-indicator"
      />
      <div style={styles.eventCardContent}>
        <div style={styles.eventCardTitle}>
          {event.summary ?? "(No title)"}
        </div>
        <div style={styles.eventCardTime}>
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

// ---------------------------------------------------------------------------
// Inline styles
// ---------------------------------------------------------------------------

const styles: Record<string, React.CSSProperties> = {
  container: {
    width: "100%",
  },

  // Toolbar
  toolbar: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "0.75rem 0",
    marginBottom: "0.75rem",
    flexWrap: "wrap",
    gap: "0.5rem",
  },
  navGroup: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    flexWrap: "wrap",
  },
  navBtn: {
    padding: "0.375rem 0.75rem",
    borderRadius: "6px",
    border: "1px solid #334155",
    background: "transparent",
    color: "#cbd5e1",
    cursor: "pointer",
    fontSize: "0.8125rem",
    fontWeight: 500,
  },
  dateHeader: {
    fontSize: "1.125rem",
    fontWeight: 600,
    color: "#f1f5f9",
    marginLeft: "0.5rem",
  },
  viewGroup: {
    display: "flex",
    gap: "0.25rem",
  },
  viewBtn: {
    padding: "0.375rem 0.75rem",
    borderRadius: "6px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#334155",
    background: "transparent",
    color: "#94a3b8",
    cursor: "pointer",
    fontSize: "0.8125rem",
    fontWeight: 500,
    transition: "background 0.15s, color 0.15s",
  },
  viewBtnActive: {
    background: "#1e40af",
    color: "#ffffff",
    borderColor: "#1e40af",
  },

  // Loading
  loadingContainer: {
    padding: "2rem",
    textAlign: "center",
  },
  loadingSkeleton: {
    display: "flex",
    flexDirection: "column",
    gap: "0.75rem",
    marginBottom: "1rem",
  },
  skeletonRow: {
    height: "2rem",
    borderRadius: "4px",
    background: "#1e293b",
    animation: "pulse 1.5s ease-in-out infinite",
  },
  loadingText: {
    color: "#64748b",
    fontSize: "0.875rem",
  },

  // Error
  errorContainer: {
    background: "#2d1b1b",
    border: "1px solid #7f1d1d",
    borderRadius: "8px",
    padding: "1.5rem",
    textAlign: "center",
  },
  errorText: {
    color: "#fca5a5",
    fontSize: "0.9375rem",
    marginBottom: "0.75rem",
  },
  retryBtn: {
    padding: "0.5rem 1rem",
    borderRadius: "6px",
    border: "none",
    background: "#3b82f6",
    color: "#ffffff",
    cursor: "pointer",
    fontSize: "0.875rem",
    fontWeight: 500,
  },

  // Empty state
  emptyState: {
    textAlign: "center",
    padding: "3rem 1rem",
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

  // Week view
  weekGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(7, 1fr)",
    gap: "1px",
    background: "#1e293b",
    borderRadius: "8px",
    overflow: "hidden",
  },
  weekDay: {
    background: "#0f172a",
    minHeight: "120px",
  },
  weekDayHeader: {
    padding: "0.5rem",
    textAlign: "center",
    borderBottom: "1px solid #1e293b",
  },
  todayHeader: {
    background: "rgba(30, 64, 175, 0.15)",
  },
  weekDayName: {
    display: "block",
    fontSize: "0.75rem",
    color: "#64748b",
    textTransform: "uppercase" as const,
    fontWeight: 600,
    letterSpacing: "0.05em",
  },
  weekDayNumber: {
    display: "inline-block",
    fontSize: "1rem",
    fontWeight: 600,
    color: "#cbd5e1",
    padding: "0.125rem 0.375rem",
    borderRadius: "9999px",
    lineHeight: "1.5",
  },
  todayNumber: {
    background: "#1e40af",
    color: "#ffffff",
  },
  weekDayEvents: {
    padding: "0.25rem",
    display: "flex",
    flexDirection: "column",
    gap: "0.125rem",
  },

  // Month view
  monthHeaderRow: {
    display: "grid",
    gridTemplateColumns: "repeat(7, 1fr)",
    gap: "1px",
    marginBottom: "1px",
  },
  monthHeaderCell: {
    padding: "0.5rem",
    textAlign: "center",
    fontSize: "0.75rem",
    color: "#64748b",
    fontWeight: 600,
    textTransform: "uppercase" as const,
    letterSpacing: "0.05em",
  },
  monthWeekRow: {
    display: "grid",
    gridTemplateColumns: "repeat(7, 1fr)",
    gap: "1px",
    marginBottom: "1px",
  },
  monthCell: {
    background: "#0f172a",
    minHeight: "80px",
    padding: "0.25rem",
    borderRadius: "2px",
  },
  monthCellOutside: {
    opacity: 0.4,
  },
  monthCellDay: {
    display: "inline-block",
    fontSize: "0.8125rem",
    fontWeight: 500,
    color: "#94a3b8",
    padding: "0.125rem 0.375rem",
    borderRadius: "9999px",
    marginBottom: "0.125rem",
  },
  monthCellEvents: {
    display: "flex",
    flexDirection: "column",
    gap: "0.0625rem",
  },
  moreEvents: {
    fontSize: "0.6875rem",
    color: "#64748b",
    paddingLeft: "0.25rem",
  },

  // Day view
  dayContainer: {
    background: "#0f172a",
    borderRadius: "8px",
    border: "1px solid #1e293b",
    overflow: "hidden",
  },
  dayHeader: {
    padding: "1rem",
    borderBottom: "1px solid #1e293b",
  },
  dayHeaderDate: {
    fontSize: "1.125rem",
    fontWeight: 600,
    color: "#e2e8f0",
  },
  dayEmpty: {
    color: "#64748b",
    textAlign: "center",
    padding: "2rem",
    fontSize: "0.875rem",
  },
  dayEventList: {
    display: "flex",
    flexDirection: "column",
    gap: "0.5rem",
    padding: "0.75rem",
  },

  // Event chip (week view)
  eventChip: {
    display: "flex",
    alignItems: "center",
    gap: "0.25rem",
    padding: "0.125rem 0.25rem",
    borderRadius: "3px",
    fontSize: "0.6875rem",
    overflow: "hidden",
    whiteSpace: "nowrap" as const,
  },
  colorIndicator: {
    width: "6px",
    height: "6px",
    borderRadius: "50%",
    flexShrink: 0,
    display: "inline-block",
  },
  eventChipTime: {
    color: "#64748b",
    flexShrink: 0,
  },
  eventChipTitle: {
    color: "#cbd5e1",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },

  // Event dot (month view)
  eventDot: {
    display: "flex",
    alignItems: "center",
    gap: "0.1875rem",
    fontSize: "0.625rem",
    overflow: "hidden",
    whiteSpace: "nowrap" as const,
  },
  dotIndicator: {
    width: "5px",
    height: "5px",
    borderRadius: "50%",
    flexShrink: 0,
    display: "inline-block",
  },
  eventDotTitle: {
    color: "#94a3b8",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },

  // Event card (day view)
  eventCard: {
    display: "flex",
    alignItems: "stretch",
    gap: "0.75rem",
    padding: "0.75rem",
    background: "#1e293b",
    borderRadius: "6px",
    borderLeftWidth: "3px",
    borderLeftStyle: "solid",
    borderLeftColor: "transparent",
  },
  cardColorBar: {
    width: "4px",
    borderRadius: "2px",
    flexShrink: 0,
    display: "none", // We use borderLeft instead, but keep for testid
  },
  eventCardContent: {
    flex: 1,
    minWidth: 0,
  },
  eventCardTitle: {
    fontSize: "0.9375rem",
    fontWeight: 500,
    color: "#e2e8f0",
    marginBottom: "0.25rem",
  },
  eventCardTime: {
    fontSize: "0.8125rem",
    color: "#64748b",
  },
};
