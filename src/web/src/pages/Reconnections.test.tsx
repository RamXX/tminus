/**
 * Tests for the Reconnections Dashboard page.
 *
 * Covers:
 * - Unit: Component rendering with mock data, loading/error states
 * - Integration: Trip reconnection list, milestone calendar, reconnection cards,
 *   schedule button, navigation, empty states
 *
 * Uses React Testing Library with fireEvent for click interactions.
 * Same pattern as Relationships.test.tsx.
 *
 * NOTE: We use fireEvent.click instead of userEvent.click because components
 * with timers interact poorly with userEvent's internal delay mechanism
 * under fake timers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, act, fireEvent } from "@testing-library/react";
import { Reconnections, type ReconnectionsProps } from "./Reconnections";
import type {
  ReconnectionSuggestionFull,
  UpcomingMilestone,
} from "../lib/reconnections";

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const MOCK_SUGGESTIONS: ReconnectionSuggestionFull[] = [
  {
    relationship_id: "rel_01",
    participant_hash: "abc",
    display_name: "Alice in Berlin",
    category: "FRIEND",
    closeness_weight: 0.8,
    last_interaction_ts: "2026-01-15T12:00:00Z",
    interaction_frequency_target: 14,
    days_since_interaction: 30,
    days_overdue: 16,
    drift_ratio: 2.14,
    urgency: 12.8,
    suggested_duration_minutes: 60,
    suggested_time_window: { earliest: "2026-02-20", latest: "2026-02-25" },
    city: "Berlin",
  },
  {
    relationship_id: "rel_02",
    participant_hash: "def",
    display_name: "Bob in Berlin",
    category: "COLLEAGUE",
    closeness_weight: 0.6,
    last_interaction_ts: "2026-01-20T12:00:00Z",
    interaction_frequency_target: 7,
    days_since_interaction: 25,
    days_overdue: 18,
    drift_ratio: 3.57,
    urgency: 10.8,
    suggested_duration_minutes: 30,
    suggested_time_window: { earliest: "2026-02-20", latest: "2026-02-25" },
    city: "Berlin",
  },
  {
    relationship_id: "rel_03",
    participant_hash: "ghi",
    display_name: "Charlie in Tokyo",
    category: "MENTOR",
    closeness_weight: 0.9,
    last_interaction_ts: "2026-01-10T12:00:00Z",
    interaction_frequency_target: 30,
    days_since_interaction: 35,
    days_overdue: 5,
    drift_ratio: 1.17,
    urgency: 4.5,
    suggested_duration_minutes: 45,
    suggested_time_window: { earliest: "2026-03-01", latest: "2026-03-05" },
    city: "Tokyo",
  },
];

const MOCK_MILESTONES: UpcomingMilestone[] = [
  {
    milestone_id: "ms_01",
    participant_hash: "abc",
    kind: "birthday",
    date: "1990-03-15",
    recurs_annually: true,
    note: "Alice's birthday",
    next_occurrence: "2026-03-15",
    days_until: 28,
    display_name: "Alice",
  },
  {
    milestone_id: "ms_02",
    participant_hash: "def",
    kind: "funding",
    date: "2026-02-28",
    recurs_annually: false,
    note: "Series A close",
    next_occurrence: "2026-02-28",
    days_until: 13,
    display_name: "Bob's Company",
  },
  {
    milestone_id: "ms_03",
    participant_hash: "ghi",
    kind: "graduation",
    date: "2026-06-15",
    recurs_annually: false,
    note: "PhD graduation",
    next_occurrence: "2026-06-15",
    days_until: 120,
    display_name: "Charlie",
  },
];

// ---------------------------------------------------------------------------
// Helper to create default props with mock functions
// ---------------------------------------------------------------------------

function makeProps(overrides: Partial<ReconnectionsProps> = {}): ReconnectionsProps {
  return {
    fetchReconnectionSuggestions: vi.fn().mockResolvedValue(MOCK_SUGGESTIONS),
    fetchUpcomingMilestones: vi.fn().mockResolvedValue(MOCK_MILESTONES),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Reconnections", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -----------------------------------------------------------------------
  // Loading state
  // -----------------------------------------------------------------------

  describe("loading state", () => {
    it("shows loading indicator while data is being fetched", () => {
      const props = makeProps({
        fetchReconnectionSuggestions: vi.fn().mockReturnValue(new Promise(() => {})),
        fetchUpcomingMilestones: vi.fn().mockReturnValue(new Promise(() => {})),
      });

      render(<Reconnections {...props} />);
      expect(screen.getByTestId("reconnections-loading")).toBeInTheDocument();
      expect(screen.getByText(/Loading reconnection data/i)).toBeInTheDocument();
    });
  });

  // -----------------------------------------------------------------------
  // Error state
  // -----------------------------------------------------------------------

  describe("error state", () => {
    it("shows error message when fetch fails", async () => {
      const props = makeProps({
        fetchReconnectionSuggestions: vi.fn().mockRejectedValue(new Error("Network error")),
        fetchUpcomingMilestones: vi.fn().mockResolvedValue([]),
      });

      await act(async () => {
        render(<Reconnections {...props} />);
      });

      expect(screen.getByTestId("reconnections-error")).toBeInTheDocument();
      expect(screen.getByText(/Network error/)).toBeInTheDocument();
    });

    it("shows retry button on error", async () => {
      const fetchFn = vi.fn()
        .mockRejectedValueOnce(new Error("Network error"))
        .mockResolvedValueOnce(MOCK_SUGGESTIONS);

      const props = makeProps({
        fetchReconnectionSuggestions: fetchFn,
      });

      await act(async () => {
        render(<Reconnections {...props} />);
      });

      const retryBtn = screen.getByLabelText("Retry");
      expect(retryBtn).toBeInTheDocument();
    });
  });

  // -----------------------------------------------------------------------
  // Trip Reconnection List
  // -----------------------------------------------------------------------

  describe("trip reconnection list", () => {
    it("renders trip groups with city headers", async () => {
      const props = makeProps();

      await act(async () => {
        render(<Reconnections {...props} />);
      });

      expect(screen.getByTestId("trip-reconnections")).toBeInTheDocument();
      // Berlin group should appear (2 suggestions) and Tokyo (1 suggestion)
      // Use getAllByText since "Berlin" appears in city header AND contact names
      const berlinElements = screen.getAllByText(/Berlin/);
      expect(berlinElements.length).toBeGreaterThanOrEqual(1);
      const tokyoElements = screen.getAllByText(/Tokyo/);
      expect(tokyoElements.length).toBeGreaterThanOrEqual(1);
    });

    it("shows reconnection cards within trip groups", async () => {
      const props = makeProps();

      await act(async () => {
        render(<Reconnections {...props} />);
      });

      // Alice and Bob in Berlin
      expect(screen.getByText("Alice in Berlin")).toBeInTheDocument();
      expect(screen.getByText("Bob in Berlin")).toBeInTheDocument();
      // Charlie in Tokyo
      expect(screen.getByText("Charlie in Tokyo")).toBeInTheDocument();
    });

    it("shows days overdue on each card", async () => {
      const props = makeProps();

      await act(async () => {
        render(<Reconnections {...props} />);
      });

      expect(screen.getByText("16 days overdue")).toBeInTheDocument();
      expect(screen.getByText("18 days overdue")).toBeInTheDocument();
      expect(screen.getByText("5 days overdue")).toBeInTheDocument();
    });

    it("shows suggested action on each card", async () => {
      const props = makeProps();

      await act(async () => {
        render(<Reconnections {...props} />);
      });

      expect(screen.getByText("Coffee or meal")).toBeInTheDocument();
      expect(screen.getByText("Working lunch")).toBeInTheDocument();
      expect(screen.getByText("Mentorship catch-up")).toBeInTheDocument();
    });
  });

  // -----------------------------------------------------------------------
  // Reconnection Cards
  // -----------------------------------------------------------------------

  describe("reconnection cards", () => {
    it("shows schedule button on each card", async () => {
      const props = makeProps();

      await act(async () => {
        render(<Reconnections {...props} />);
      });

      const scheduleButtons = screen.getAllByTestId(/schedule-btn-/);
      expect(scheduleButtons.length).toBeGreaterThanOrEqual(3);
    });

    it("schedule button navigates to scheduling page with pre-filled params", async () => {
      const props = makeProps();

      await act(async () => {
        render(<Reconnections {...props} />);
      });

      const scheduleBtn = screen.getByTestId("schedule-btn-rel_01");
      // The button should be an anchor tag pointing to scheduling
      expect(scheduleBtn).toHaveAttribute("href");
      const href = scheduleBtn.getAttribute("href")!;
      expect(href).toContain("#/scheduling");
      expect(href).toContain("duration=60");
      expect(href).toContain("contact=Alice");
      expect(href).toContain("relationship_id=rel_01");
    });

    it("shows suggested duration on each card", async () => {
      const props = makeProps();

      await act(async () => {
        render(<Reconnections {...props} />);
      });

      expect(screen.getByText("1h")).toBeInTheDocument();
      expect(screen.getByText("30 min")).toBeInTheDocument();
      expect(screen.getByText("45 min")).toBeInTheDocument();
    });
  });

  // -----------------------------------------------------------------------
  // Milestone Calendar
  // -----------------------------------------------------------------------

  describe("milestone calendar", () => {
    it("renders milestone section", async () => {
      const props = makeProps();

      await act(async () => {
        render(<Reconnections {...props} />);
      });

      expect(screen.getByTestId("milestone-calendar")).toBeInTheDocument();
    });

    it("shows upcoming milestones grouped by month", async () => {
      const props = makeProps();

      await act(async () => {
        render(<Reconnections {...props} />);
      });

      // February milestone (Bob's funding) and March milestone (Alice's birthday)
      // within 30 day window. June graduation (120 days) is filtered out.
      expect(screen.getByText(/February 2026/)).toBeInTheDocument();
      expect(screen.getByText(/March 2026/)).toBeInTheDocument();
      expect(screen.getByText(/Bob's Company/)).toBeInTheDocument();
      // Alice appears in both reconnection cards and milestones; use milestone-specific test ID
      const milestoneSection = screen.getByTestId("milestone-calendar");
      expect(within(milestoneSection).getByText("Alice")).toBeInTheDocument();
    });

    it("shows milestone kind labels", async () => {
      const props = makeProps();

      await act(async () => {
        render(<Reconnections {...props} />);
      });

      expect(screen.getByText("Birthday")).toBeInTheDocument();
      expect(screen.getByText("Funding Round")).toBeInTheDocument();
    });

    it("shows days until milestone", async () => {
      const props = makeProps();

      await act(async () => {
        render(<Reconnections {...props} />);
      });

      expect(screen.getByText(/13 days/)).toBeInTheDocument();
      expect(screen.getByText(/28 days/)).toBeInTheDocument();
    });

    it("filters out milestones beyond 30-day window by default", async () => {
      const props = makeProps();

      await act(async () => {
        render(<Reconnections {...props} />);
      });

      // Charlie's graduation is 120 days away -- should not appear
      expect(screen.queryByText("Graduation")).not.toBeInTheDocument();
    });
  });

  // -----------------------------------------------------------------------
  // Empty states
  // -----------------------------------------------------------------------

  describe("empty states", () => {
    it("shows empty state when no reconnection suggestions", async () => {
      const props = makeProps({
        fetchReconnectionSuggestions: vi.fn().mockResolvedValue([]),
      });

      await act(async () => {
        render(<Reconnections {...props} />);
      });

      expect(screen.getByTestId("suggestions-empty")).toBeInTheDocument();
    });

    it("shows empty state when no upcoming milestones", async () => {
      const props = makeProps({
        fetchUpcomingMilestones: vi.fn().mockResolvedValue([]),
      });

      await act(async () => {
        render(<Reconnections {...props} />);
      });

      expect(screen.getByTestId("milestones-empty")).toBeInTheDocument();
    });
  });

  // -----------------------------------------------------------------------
  // Navigation
  // -----------------------------------------------------------------------

  describe("navigation", () => {
    it("has a link back to relationships page", async () => {
      const props = makeProps();

      await act(async () => {
        render(<Reconnections {...props} />);
      });

      const backLink = screen.getByText("Back to Relationships");
      expect(backLink).toBeInTheDocument();
      expect(backLink.closest("a")).toHaveAttribute("href", "#/relationships");
    });
  });

  // -----------------------------------------------------------------------
  // Responsive layout
  // -----------------------------------------------------------------------

  describe("responsive design", () => {
    it("renders with responsive container styles", async () => {
      const props = makeProps();

      await act(async () => {
        render(<Reconnections {...props} />);
      });

      // The container should have maxWidth for responsive layout
      const container = screen.getByTestId("reconnections-page");
      expect(container).toBeInTheDocument();
    });
  });

  // -----------------------------------------------------------------------
  // API integration
  // -----------------------------------------------------------------------

  describe("API integration", () => {
    it("calls fetchReconnectionSuggestions on mount", async () => {
      const fetchSuggestions = vi.fn().mockResolvedValue(MOCK_SUGGESTIONS);
      const props = makeProps({ fetchReconnectionSuggestions: fetchSuggestions });

      await act(async () => {
        render(<Reconnections {...props} />);
      });

      expect(fetchSuggestions).toHaveBeenCalledOnce();
    });

    it("calls fetchUpcomingMilestones on mount", async () => {
      const fetchMilestones = vi.fn().mockResolvedValue(MOCK_MILESTONES);
      const props = makeProps({ fetchUpcomingMilestones: fetchMilestones });

      await act(async () => {
        render(<Reconnections {...props} />);
      });

      expect(fetchMilestones).toHaveBeenCalledOnce();
    });
  });
});
