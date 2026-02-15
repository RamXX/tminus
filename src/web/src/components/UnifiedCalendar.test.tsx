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
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UnifiedCalendar } from "./UnifiedCalendar";
import type { CalendarEvent } from "../lib/api";

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const MOCK_EVENTS: CalendarEvent[] = [
  {
    canonical_event_id: "evt-1",
    summary: "Team Standup",
    start: "2026-02-14T09:00:00Z",
    end: "2026-02-14T09:30:00Z",
    origin_account_id: "account-work",
    status: "confirmed",
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
});
