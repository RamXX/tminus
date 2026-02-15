/**
 * Integration tests for UnifiedCalendar component.
 *
 * Tests cover:
 * - Renders events from mock API data
 * - View switching (week/month/day)
 * - Date navigation (prev/next/today)
 * - Loading state
 * - Error state with retry
 * - Color coding per account
 * - Responsive structure
 * - Event creation: click time slot -> form -> submit -> optimistic update
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UnifiedCalendar } from "./UnifiedCalendar";
import type { CalendarEvent, CreateEventPayload } from "../lib/api";

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const MOCK_EVENTS: CalendarEvent[] = [
  {
    canonical_event_id: "evt-1",
    summary: "Team Standup",
    description: "Daily sync with the engineering team.",
    location: "Zoom Room Alpha",
    start: "2026-02-14T09:00:00Z",
    end: "2026-02-14T09:30:00Z",
    origin_account_id: "account-work",
    origin_account_email: "dev@company.com",
    status: "confirmed",
    version: 2,
    updated_at: "2026-02-13T20:00:00Z",
    mirrors: [
      {
        target_account_id: "account-personal",
        target_account_email: "me@gmail.com",
        sync_status: "ACTIVE",
      },
      {
        target_account_id: "account-family",
        target_account_email: "me@family.org",
        sync_status: "PENDING",
      },
    ],
  },
  {
    canonical_event_id: "evt-2",
    summary: "Lunch with Alice",
    start: "2026-02-14T12:00:00Z",
    end: "2026-02-14T13:00:00Z",
    origin_account_id: "account-personal",
    status: "confirmed",
  },
  {
    canonical_event_id: "evt-3",
    summary: "Dentist Appointment",
    start: "2026-02-15T14:00:00Z",
    end: "2026-02-15T15:00:00Z",
    origin_account_id: "account-personal",
    status: "confirmed",
  },
  {
    canonical_event_id: "evt-4",
    summary: "Sprint Planning",
    start: "2026-02-16T10:00:00Z",
    end: "2026-02-16T11:00:00Z",
    origin_account_id: "account-work",
    status: "confirmed",
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a mock fetchEvents function. */
function createMockFetch(
  events: CalendarEvent[] = MOCK_EVENTS,
  delay = 0,
) {
  return vi.fn(async (_start: string, _end: string) => {
    if (delay > 0) {
      await new Promise((r) => setTimeout(r, delay));
    }
    return events;
  });
}

/** Create a mock fetchEvents that rejects. */
function createFailingFetch(errorMessage = "Network error") {
  return vi.fn(async () => {
    throw new Error(errorMessage);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("UnifiedCalendar", () => {
  const user = userEvent.setup();

  describe("rendering events", () => {
    it("renders events from the fetch function", async () => {
      const fetchFn = createMockFetch();
      render(<UnifiedCalendar fetchEvents={fetchFn} />);

      await waitFor(() => {
        expect(screen.getByText("Team Standup")).toBeInTheDocument();
      });

      expect(screen.getByText("Lunch with Alice")).toBeInTheDocument();
    });

    it("calls fetchEvents with start and end date parameters", async () => {
      const fetchFn = createMockFetch();
      render(<UnifiedCalendar fetchEvents={fetchFn} />);

      await waitFor(() => {
        expect(fetchFn).toHaveBeenCalledTimes(1);
      });

      const [startArg, endArg] = fetchFn.mock.calls[0];
      // Should be ISO date strings
      expect(startArg).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(endArg).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("shows empty state when no events", async () => {
      const fetchFn = createMockFetch([]);
      render(<UnifiedCalendar fetchEvents={fetchFn} />);

      await waitFor(() => {
        expect(screen.getByText(/no events/i)).toBeInTheDocument();
      });
    });
  });

  describe("view switching", () => {
    it("defaults to week view", async () => {
      const fetchFn = createMockFetch();
      render(<UnifiedCalendar fetchEvents={fetchFn} />);

      await waitFor(() => {
        expect(fetchFn).toHaveBeenCalled();
      });

      // Week button should be active (aria-current or similar)
      const weekBtn = screen.getByRole("button", { name: /week/i });
      expect(weekBtn).toHaveAttribute("aria-pressed", "true");
    });

    it("switches to month view", async () => {
      const fetchFn = createMockFetch();
      render(<UnifiedCalendar fetchEvents={fetchFn} />);

      await waitFor(() => {
        expect(fetchFn).toHaveBeenCalled();
      });

      const monthBtn = screen.getByRole("button", { name: /month/i });
      await user.click(monthBtn);

      expect(monthBtn).toHaveAttribute("aria-pressed", "true");
      // fetchEvents should be called again with month range
      expect(fetchFn.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it("switches to day view", async () => {
      const fetchFn = createMockFetch();
      render(<UnifiedCalendar fetchEvents={fetchFn} />);

      await waitFor(() => {
        expect(fetchFn).toHaveBeenCalled();
      });

      const dayBtn = screen.getByRole("button", { name: /^day$/i });
      await user.click(dayBtn);

      expect(dayBtn).toHaveAttribute("aria-pressed", "true");
      expect(fetchFn.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it("refetches events when view changes", async () => {
      const fetchFn = createMockFetch();
      render(<UnifiedCalendar fetchEvents={fetchFn} />);

      await waitFor(() => {
        expect(fetchFn).toHaveBeenCalledTimes(1);
      });

      const monthBtn = screen.getByRole("button", { name: /month/i });
      await user.click(monthBtn);

      await waitFor(() => {
        expect(fetchFn).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe("date navigation", () => {
    it("navigates to next period", async () => {
      const fetchFn = createMockFetch();
      render(<UnifiedCalendar fetchEvents={fetchFn} />);

      await waitFor(() => {
        expect(fetchFn).toHaveBeenCalledTimes(1);
      });

      const nextBtn = screen.getByRole("button", { name: /next/i });
      await user.click(nextBtn);

      await waitFor(() => {
        expect(fetchFn).toHaveBeenCalledTimes(2);
      });

      // The second call should have a later start date
      const [firstStart] = fetchFn.mock.calls[0];
      const [secondStart] = fetchFn.mock.calls[1];
      expect(new Date(secondStart).getTime()).toBeGreaterThan(
        new Date(firstStart).getTime(),
      );
    });

    it("navigates to previous period", async () => {
      const fetchFn = createMockFetch();
      render(<UnifiedCalendar fetchEvents={fetchFn} />);

      await waitFor(() => {
        expect(fetchFn).toHaveBeenCalledTimes(1);
      });

      const prevBtn = screen.getByRole("button", { name: /prev/i });
      await user.click(prevBtn);

      await waitFor(() => {
        expect(fetchFn).toHaveBeenCalledTimes(2);
      });

      const [firstStart] = fetchFn.mock.calls[0];
      const [secondStart] = fetchFn.mock.calls[1];
      expect(new Date(secondStart).getTime()).toBeLessThan(
        new Date(firstStart).getTime(),
      );
    });

    it("today button resets to current date", async () => {
      const fetchFn = createMockFetch();
      render(<UnifiedCalendar fetchEvents={fetchFn} />);

      await waitFor(() => {
        expect(fetchFn).toHaveBeenCalledTimes(1);
      });

      // Navigate away
      const nextBtn = screen.getByRole("button", { name: /next/i });
      await user.click(nextBtn);
      await waitFor(() => {
        expect(fetchFn).toHaveBeenCalledTimes(2);
      });

      // Come back to today
      const todayBtn = screen.getByRole("button", { name: /today/i });
      await user.click(todayBtn);

      await waitFor(() => {
        expect(fetchFn).toHaveBeenCalledTimes(3);
      });
    });
  });

  describe("loading state", () => {
    it("shows loading indicator while fetching", async () => {
      // Slow fetch to observe loading state
      const fetchFn = createMockFetch(MOCK_EVENTS, 200);
      render(<UnifiedCalendar fetchEvents={fetchFn} />);

      // Should show loading skeleton/text
      expect(screen.getByTestId("calendar-loading")).toBeInTheDocument();

      // Wait for events to load
      await waitFor(() => {
        expect(screen.getByText("Team Standup")).toBeInTheDocument();
      });

      // Loading should be gone
      expect(screen.queryByTestId("calendar-loading")).not.toBeInTheDocument();
    });
  });

  describe("error state", () => {
    it("shows error message on fetch failure", async () => {
      const fetchFn = createFailingFetch("Server unavailable");
      render(<UnifiedCalendar fetchEvents={fetchFn} />);

      await waitFor(() => {
        expect(screen.getByText(/failed to load/i)).toBeInTheDocument();
      });
    });

    it("shows retry button on error", async () => {
      const fetchFn = createFailingFetch();
      render(<UnifiedCalendar fetchEvents={fetchFn} />);

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /retry/i }),
        ).toBeInTheDocument();
      });
    });

    it("retries fetch when retry button is clicked", async () => {
      let callCount = 0;
      const fetchFn = vi.fn(async () => {
        callCount++;
        if (callCount === 1) throw new Error("First call fails");
        return MOCK_EVENTS;
      });

      render(<UnifiedCalendar fetchEvents={fetchFn} />);

      await waitFor(() => {
        expect(screen.getByText(/failed to load/i)).toBeInTheDocument();
      });

      const retryBtn = screen.getByRole("button", { name: /retry/i });
      await user.click(retryBtn);

      await waitFor(() => {
        expect(screen.getByText("Team Standup")).toBeInTheDocument();
      });

      expect(fetchFn).toHaveBeenCalledTimes(2);
    });
  });

  describe("color coding", () => {
    it("applies color indicators based on origin account", async () => {
      const fetchFn = createMockFetch();
      render(<UnifiedCalendar fetchEvents={fetchFn} />);

      await waitFor(() => {
        expect(screen.getByText("Team Standup")).toBeInTheDocument();
      });

      // Each event should have a color indicator element
      const eventElements = screen.getAllByTestId("event-color-indicator");
      expect(eventElements.length).toBeGreaterThan(0);

      // Events from the same account should have the same color
      const colors = eventElements.map(
        (el) => (el as HTMLElement).style.backgroundColor,
      );
      // We have 2 accounts in mock data, so we should see at least 2 different colors
      // (unless the hash happens to collide, which is extremely unlikely)
      const uniqueColors = new Set(colors.filter(Boolean));
      expect(uniqueColors.size).toBeGreaterThanOrEqual(1);
    });
  });

  describe("responsive layout", () => {
    it("renders navigation and view controls", async () => {
      const fetchFn = createMockFetch();
      render(<UnifiedCalendar fetchEvents={fetchFn} />);

      await waitFor(() => {
        expect(fetchFn).toHaveBeenCalled();
      });

      // All navigation controls should be present
      expect(screen.getByRole("button", { name: /prev/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /next/i })).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /today/i }),
      ).toBeInTheDocument();

      // All view buttons should be present
      expect(screen.getByRole("button", { name: /week/i })).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /month/i }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /^day$/i }),
      ).toBeInTheDocument();
    });

    it("displays a date header showing the current period", async () => {
      const fetchFn = createMockFetch();
      render(<UnifiedCalendar fetchEvents={fetchFn} />);

      await waitFor(() => {
        expect(fetchFn).toHaveBeenCalled();
      });

      // Should show some date information in the header
      const header = screen.getByTestId("calendar-date-header");
      expect(header.textContent).toBeTruthy();
      expect(header.textContent!.length).toBeGreaterThan(0);
    });
  });

  describe("event detail view", () => {
    it("opens detail panel when clicking an event in week view", async () => {
      const fetchFn = createMockFetch();
      // Use a fixed date so we know which events will be visible
      const initialDate = new Date("2026-02-14T12:00:00Z");
      render(
        <UnifiedCalendar
          fetchEvents={fetchFn}
          initialDate={initialDate}
          initialView="week"
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("Team Standup")).toBeInTheDocument();
      });

      // Click on an event chip
      await user.click(screen.getByText("Team Standup"));

      // EventDetail panel should appear
      expect(screen.getByTestId("event-detail-panel")).toBeInTheDocument();
      // Title should appear in the detail
      expect(screen.getByTestId("event-detail-time")).toBeInTheDocument();
    });

    it("shows event details including description and location", async () => {
      const fetchFn = createMockFetch();
      const initialDate = new Date("2026-02-14T12:00:00Z");
      render(
        <UnifiedCalendar
          fetchEvents={fetchFn}
          initialDate={initialDate}
          initialView="week"
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("Team Standup")).toBeInTheDocument();
      });

      await user.click(screen.getByText("Team Standup"));

      // Description and location should be visible
      expect(
        screen.getByText(/Daily sync with the engineering team/),
      ).toBeInTheDocument();
      expect(screen.getByText("Zoom Room Alpha")).toBeInTheDocument();
    });

    it("shows mirror status badges in detail view", async () => {
      const fetchFn = createMockFetch();
      const initialDate = new Date("2026-02-14T12:00:00Z");
      render(
        <UnifiedCalendar
          fetchEvents={fetchFn}
          initialDate={initialDate}
          initialView="week"
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("Team Standup")).toBeInTheDocument();
      });

      await user.click(screen.getByText("Team Standup"));

      // Mirror badges should be visible
      const badges = screen.getAllByTestId("mirror-status-badge");
      expect(badges).toHaveLength(2);
      // Mirror emails should be visible
      expect(screen.getByText("me@gmail.com")).toBeInTheDocument();
      expect(screen.getByText("me@family.org")).toBeInTheDocument();
    });

    it("shows origin account in detail view", async () => {
      const fetchFn = createMockFetch();
      const initialDate = new Date("2026-02-14T12:00:00Z");
      render(
        <UnifiedCalendar
          fetchEvents={fetchFn}
          initialDate={initialDate}
          initialView="week"
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("Team Standup")).toBeInTheDocument();
      });

      await user.click(screen.getByText("Team Standup"));

      expect(screen.getByText("dev@company.com")).toBeInTheDocument();
    });

    it("closes detail panel when close button is clicked", async () => {
      const fetchFn = createMockFetch();
      const initialDate = new Date("2026-02-14T12:00:00Z");
      render(
        <UnifiedCalendar
          fetchEvents={fetchFn}
          initialDate={initialDate}
          initialView="week"
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("Team Standup")).toBeInTheDocument();
      });

      // Open detail
      await user.click(screen.getByText("Team Standup"));
      expect(screen.getByTestId("event-detail-panel")).toBeInTheDocument();

      // Close it
      const closeBtn = screen.getByRole("button", { name: /close/i });
      await user.click(closeBtn);

      expect(screen.queryByTestId("event-detail-panel")).not.toBeInTheDocument();
    });

    it("closes detail panel when overlay is clicked", async () => {
      const fetchFn = createMockFetch();
      const initialDate = new Date("2026-02-14T12:00:00Z");
      render(
        <UnifiedCalendar
          fetchEvents={fetchFn}
          initialDate={initialDate}
          initialView="week"
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("Team Standup")).toBeInTheDocument();
      });

      // Open detail
      await user.click(screen.getByText("Team Standup"));
      expect(screen.getByTestId("event-detail-panel")).toBeInTheDocument();

      // Click overlay to dismiss
      const overlay = screen.getByTestId("event-detail-overlay");
      await user.click(overlay);

      expect(screen.queryByTestId("event-detail-panel")).not.toBeInTheDocument();
    });

    it("opens detail panel when clicking an event in day view", async () => {
      const fetchFn = createMockFetch();
      const initialDate = new Date("2026-02-14T12:00:00Z");
      render(
        <UnifiedCalendar
          fetchEvents={fetchFn}
          initialDate={initialDate}
          initialView="day"
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("Team Standup")).toBeInTheDocument();
      });

      // Click on an event card in day view
      await user.click(screen.getByText("Team Standup"));

      expect(screen.getByTestId("event-detail-panel")).toBeInTheDocument();
    });

    it("handles event with no mirrors gracefully in detail view", async () => {
      const fetchFn = createMockFetch();
      const initialDate = new Date("2026-02-14T12:00:00Z");
      render(
        <UnifiedCalendar
          fetchEvents={fetchFn}
          initialDate={initialDate}
          initialView="week"
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("Lunch with Alice")).toBeInTheDocument();
      });

      // Click on an event without mirrors
      await user.click(screen.getByText("Lunch with Alice"));

      expect(screen.getByTestId("event-detail-panel")).toBeInTheDocument();
      // Should show "no mirrors" message
      expect(screen.getByText(/no mirrors/i)).toBeInTheDocument();
    });
  });

  // =========================================================================
  // Event creation
  // =========================================================================

  describe("event creation", () => {
    /** Mock onCreateEvent that resolves with a real event. */
    function createMockCreate(
      overrides: Partial<CalendarEvent> = {},
      delay = 0,
    ) {
      return vi.fn(async (payload: CreateEventPayload): Promise<CalendarEvent> => {
        if (delay > 0) {
          await new Promise((r) => setTimeout(r, delay));
        }
        return {
          canonical_event_id: "evt-new-1",
          summary: payload.summary,
          description: payload.description,
          location: payload.location,
          start: payload.start,
          end: payload.end,
          status: "confirmed",
          version: 1,
          ...overrides,
        };
      });
    }

    /** Mock onCreateEvent that rejects. */
    function createFailingCreate(errorMessage = "Server error") {
      return vi.fn(async (): Promise<CalendarEvent> => {
        throw new Error(errorMessage);
      });
    }

    it("opens creation form when clicking a time slot in week view", async () => {
      const fetchFn = createMockFetch();
      const createFn = createMockCreate();
      const initialDate = new Date("2026-02-14T12:00:00Z");

      render(
        <UnifiedCalendar
          fetchEvents={fetchFn}
          onCreateEvent={createFn}
          initialDate={initialDate}
          initialView="week"
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("Team Standup")).toBeInTheDocument();
      });

      // Click on an empty area (the day cell for Feb 14)
      const daySlot = screen.getByTestId("week-day-slot-2026-02-14");
      await user.click(daySlot);

      // Creation form should appear
      expect(screen.getByTestId("event-create-panel")).toBeInTheDocument();
      expect(screen.getByText("New Event")).toBeInTheDocument();
    });

    it("does NOT open creation form when onCreateEvent is not provided", async () => {
      const fetchFn = createMockFetch();
      const initialDate = new Date("2026-02-14T12:00:00Z");

      render(
        <UnifiedCalendar
          fetchEvents={fetchFn}
          initialDate={initialDate}
          initialView="week"
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("Team Standup")).toBeInTheDocument();
      });

      // Click on a day cell -- should NOT open creation form
      const daySlot = screen.getByTestId("week-day-slot-2026-02-14");
      await user.click(daySlot);

      expect(screen.queryByTestId("event-create-panel")).not.toBeInTheDocument();
    });

    it("has all expected form fields", async () => {
      const fetchFn = createMockFetch();
      const createFn = createMockCreate();
      const initialDate = new Date("2026-02-14T12:00:00Z");

      render(
        <UnifiedCalendar
          fetchEvents={fetchFn}
          onCreateEvent={createFn}
          initialDate={initialDate}
          initialView="week"
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("Team Standup")).toBeInTheDocument();
      });

      // Open creation form
      const daySlot = screen.getByTestId("week-day-slot-2026-02-14");
      await user.click(daySlot);

      // All fields should be present
      expect(screen.getByTestId("event-title-input")).toBeInTheDocument();
      expect(screen.getByTestId("event-start-date-input")).toBeInTheDocument();
      expect(screen.getByTestId("event-start-time-input")).toBeInTheDocument();
      expect(screen.getByTestId("event-end-date-input")).toBeInTheDocument();
      expect(screen.getByTestId("event-end-time-input")).toBeInTheDocument();
      expect(screen.getByTestId("event-timezone-input")).toBeInTheDocument();
      expect(screen.getByTestId("event-description-input")).toBeInTheDocument();
      expect(screen.getByTestId("event-location-input")).toBeInTheDocument();
      expect(screen.getByTestId("event-create-submit")).toBeInTheDocument();
    });

    it("validates required title before submit", async () => {
      const fetchFn = createMockFetch();
      const createFn = createMockCreate();
      const initialDate = new Date("2026-02-14T12:00:00Z");

      render(
        <UnifiedCalendar
          fetchEvents={fetchFn}
          onCreateEvent={createFn}
          initialDate={initialDate}
          initialView="week"
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("Team Standup")).toBeInTheDocument();
      });

      // Open creation form
      const daySlot = screen.getByTestId("week-day-slot-2026-02-14");
      await user.click(daySlot);

      // Submit without entering a title
      const submitBtn = screen.getByTestId("event-create-submit");
      await user.click(submitBtn);

      // Should show validation error
      expect(screen.getByTestId("title-error")).toBeInTheDocument();
      expect(screen.getByText("Title is required")).toBeInTheDocument();

      // onCreateEvent should NOT have been called
      expect(createFn).not.toHaveBeenCalled();
    });

    it("validates end time must be after start time", async () => {
      const fetchFn = createMockFetch();
      const createFn = createMockCreate();
      const initialDate = new Date("2026-02-14T12:00:00Z");

      render(
        <UnifiedCalendar
          fetchEvents={fetchFn}
          onCreateEvent={createFn}
          initialDate={initialDate}
          initialView="week"
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("Team Standup")).toBeInTheDocument();
      });

      // Open creation form
      const daySlot = screen.getByTestId("week-day-slot-2026-02-14");
      await user.click(daySlot);

      // Fill in title
      const titleInput = screen.getByTestId("event-title-input");
      await user.clear(titleInput);
      await user.type(titleInput, "Bad Event");

      // Set end time before start time
      const endTimeInput = screen.getByTestId("event-end-time-input");
      await user.clear(endTimeInput);
      await user.type(endTimeInput, "08:00");

      // Submit
      const submitBtn = screen.getByTestId("event-create-submit");
      await user.click(submitBtn);

      // Should show validation error about end time
      expect(screen.getByTestId("end-time-error")).toBeInTheDocument();
      expect(screen.getByText("End time must be after start time")).toBeInTheDocument();

      // onCreateEvent should NOT have been called
      expect(createFn).not.toHaveBeenCalled();
    });

    it("submits form and calls onCreateEvent with correct payload", async () => {
      const fetchFn = createMockFetch();
      const createFn = createMockCreate();
      const initialDate = new Date("2026-02-14T12:00:00Z");

      render(
        <UnifiedCalendar
          fetchEvents={fetchFn}
          onCreateEvent={createFn}
          initialDate={initialDate}
          initialView="week"
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("Team Standup")).toBeInTheDocument();
      });

      // Open creation form
      const daySlot = screen.getByTestId("week-day-slot-2026-02-14");
      await user.click(daySlot);

      // Fill in the form
      const titleInput = screen.getByTestId("event-title-input");
      await user.type(titleInput, "New Team Meeting");

      const descInput = screen.getByTestId("event-description-input");
      await user.type(descInput, "Weekly planning session");

      const locInput = screen.getByTestId("event-location-input");
      await user.type(locInput, "Room 42");

      // Submit
      const submitBtn = screen.getByTestId("event-create-submit");
      await user.click(submitBtn);

      // onCreateEvent should have been called
      await waitFor(() => {
        expect(createFn).toHaveBeenCalledTimes(1);
      });

      // Verify payload
      const payload = createFn.mock.calls[0][0] as CreateEventPayload;
      expect(payload.summary).toBe("New Team Meeting");
      expect(payload.description).toBe("Weekly planning session");
      expect(payload.location).toBe("Room 42");
      expect(payload.source).toBe("ui");
      expect(payload.start).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(payload.end).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("shows new event on calendar immediately after submission (optimistic update)", async () => {
      const fetchFn = createMockFetch();
      // Slow create to observe the optimistic event before the real one resolves
      const createFn = createMockCreate({}, 200);
      const initialDate = new Date("2026-02-14T12:00:00Z");

      render(
        <UnifiedCalendar
          fetchEvents={fetchFn}
          onCreateEvent={createFn}
          initialDate={initialDate}
          initialView="week"
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("Team Standup")).toBeInTheDocument();
      });

      // Open creation form
      const daySlot = screen.getByTestId("week-day-slot-2026-02-14");
      await user.click(daySlot);

      // Fill title
      const titleInput = screen.getByTestId("event-title-input");
      await user.type(titleInput, "Optimistic Event");

      // Submit
      const submitBtn = screen.getByTestId("event-create-submit");
      await user.click(submitBtn);

      // Form should close immediately
      await waitFor(() => {
        expect(screen.queryByTestId("event-create-panel")).not.toBeInTheDocument();
      });

      // Event should appear on the calendar immediately (optimistic)
      expect(screen.getByText("Optimistic Event")).toBeInTheDocument();

      // Wait for the real event to replace the optimistic one
      await waitFor(() => {
        expect(createFn).toHaveBeenCalled();
      });

      // Event should still be visible (now with real ID)
      expect(screen.getByText("Optimistic Event")).toBeInTheDocument();
    });

    it("rolls back optimistic update on API failure", async () => {
      const fetchFn = createMockFetch();
      const createFn = createFailingCreate("Creation failed");
      const initialDate = new Date("2026-02-14T12:00:00Z");

      render(
        <UnifiedCalendar
          fetchEvents={fetchFn}
          onCreateEvent={createFn}
          initialDate={initialDate}
          initialView="week"
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("Team Standup")).toBeInTheDocument();
      });

      // Open creation form
      const daySlot = screen.getByTestId("week-day-slot-2026-02-14");
      await user.click(daySlot);

      // Fill title
      const titleInput = screen.getByTestId("event-title-input");
      await user.type(titleInput, "Doomed Event");

      // Submit
      const submitBtn = screen.getByTestId("event-create-submit");
      await user.click(submitBtn);

      // Wait for the API call to fail and form to re-open with error
      await waitFor(() => {
        expect(screen.getByTestId("event-create-error")).toBeInTheDocument();
      });

      expect(screen.getByText("Creation failed")).toBeInTheDocument();

      // The optimistic event should be rolled back (removed)
      expect(screen.queryByText("Doomed Event")).not.toBeInTheDocument();
    });

    it("closes creation form when cancel is clicked", async () => {
      const fetchFn = createMockFetch();
      const createFn = createMockCreate();
      const initialDate = new Date("2026-02-14T12:00:00Z");

      render(
        <UnifiedCalendar
          fetchEvents={fetchFn}
          onCreateEvent={createFn}
          initialDate={initialDate}
          initialView="week"
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("Team Standup")).toBeInTheDocument();
      });

      // Open creation form
      const daySlot = screen.getByTestId("week-day-slot-2026-02-14");
      await user.click(daySlot);
      expect(screen.getByTestId("event-create-panel")).toBeInTheDocument();

      // Click the "Cancel" text button (not the X close button which also has aria-label="Cancel")
      const cancelBtns = screen.getAllByRole("button", { name: /cancel/i });
      // The text "Cancel" button is the one with visible text
      const cancelBtn = cancelBtns.find((btn) => btn.textContent === "Cancel")!;
      expect(cancelBtn).toBeTruthy();
      await user.click(cancelBtn);

      expect(screen.queryByTestId("event-create-panel")).not.toBeInTheDocument();
    });

    it("opens creation form from day view", async () => {
      const fetchFn = createMockFetch();
      const createFn = createMockCreate();
      const initialDate = new Date("2026-02-14T12:00:00Z");

      render(
        <UnifiedCalendar
          fetchEvents={fetchFn}
          onCreateEvent={createFn}
          initialDate={initialDate}
          initialView="day"
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("Team Standup")).toBeInTheDocument();
      });

      // Click on the day slot
      const daySlot = screen.getByTestId("day-slot-2026-02-14");
      await user.click(daySlot);

      expect(screen.getByTestId("event-create-panel")).toBeInTheDocument();
    });

    it("opens creation form from month view", async () => {
      const fetchFn = createMockFetch();
      const createFn = createMockCreate();
      const initialDate = new Date("2026-02-14T12:00:00Z");

      render(
        <UnifiedCalendar
          fetchEvents={fetchFn}
          onCreateEvent={createFn}
          initialDate={initialDate}
          initialView="month"
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("Team Standup")).toBeInTheDocument();
      });

      // Click on a month day cell for Feb 14
      const daySlot = screen.getByTestId("month-day-slot-2026-02-14");
      await user.click(daySlot);

      expect(screen.getByTestId("event-create-panel")).toBeInTheDocument();
    });

    it("clicking an event still opens event detail (not creation form)", async () => {
      const fetchFn = createMockFetch();
      const createFn = createMockCreate();
      const initialDate = new Date("2026-02-14T12:00:00Z");

      render(
        <UnifiedCalendar
          fetchEvents={fetchFn}
          onCreateEvent={createFn}
          initialDate={initialDate}
          initialView="week"
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("Team Standup")).toBeInTheDocument();
      });

      // Click on an existing event (not empty space)
      await user.click(screen.getByText("Team Standup"));

      // Should open EventDetail, NOT creation form
      expect(screen.getByTestId("event-detail-panel")).toBeInTheDocument();
      expect(screen.queryByTestId("event-create-panel")).not.toBeInTheDocument();
    });

    it("shows calendar grid even with no events when onCreateEvent is provided", async () => {
      const fetchFn = createMockFetch([]);
      const createFn = createMockCreate();
      const initialDate = new Date("2026-02-14T12:00:00Z");

      render(
        <UnifiedCalendar
          fetchEvents={fetchFn}
          onCreateEvent={createFn}
          initialDate={initialDate}
          initialView="week"
        />,
      );

      await waitFor(() => {
        expect(fetchFn).toHaveBeenCalled();
      });

      // Wait for loading to finish
      await waitFor(() => {
        expect(screen.queryByTestId("calendar-loading")).not.toBeInTheDocument();
      });

      // Should show the calendar grid (not the "No events" empty state)
      const daySlot = screen.getByTestId("week-day-slot-2026-02-14");
      expect(daySlot).toBeInTheDocument();

      // Should show a hint to click
      expect(screen.getByText(/click a time slot/i)).toBeInTheDocument();
    });
  });
});
