/**
 * Tests for BriefingPanel, ParticipantCard, ActionButtons, and ExcuseModal.
 *
 * Unit tests:
 * - ParticipantCard renders name, category badge, last interaction, reputation, drift
 * - ActionButtons renders Generate Excuse and Propose Reschedule buttons
 * - ExcuseModal renders tone selector, truth level selector, copy button
 *
 * Component integration tests:
 * - BriefingPanel loading state
 * - BriefingPanel renders participant cards from briefing data
 * - BriefingPanel shows topics
 * - Generate Excuse button opens ExcuseModal
 * - ExcuseModal tone/truth selectors update state
 * - Copy button copies draft to clipboard
 * - ExcuseModal close button dismisses modal
 * - Responsive layout
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { render, screen, within, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BriefingPanel } from "./BriefingPanel";
import {
  computeDriftIndicator,
  type EventBriefing,
  type ExcuseOutput,
} from "../lib/briefing";

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const MOCK_BRIEFING: EventBriefing = {
  event_id: "evt-1",
  event_title: "Architecture Review",
  event_start: "2026-02-15T14:00:00Z",
  topics: ["review", "architecture"],
  participants: [
    {
      participant_hash: "p1",
      display_name: "Alice Johnson",
      category: "colleague",
      last_interaction_ts: "2026-02-10T12:00:00Z",
      last_interaction_summary: "5 days ago",
      reputation_score: 0.92,
      mutual_connections_count: 3,
    },
    {
      participant_hash: "p2",
      display_name: "Bob Smith",
      category: "client",
      last_interaction_ts: "2025-12-01T12:00:00Z",
      last_interaction_summary: "2 months ago",
      reputation_score: 0.65,
      mutual_connections_count: 1,
    },
    {
      participant_hash: "p3",
      display_name: null,
      category: "acquaintance",
      last_interaction_ts: null,
      last_interaction_summary: null,
      reputation_score: 0.4,
      mutual_connections_count: 0,
    },
  ],
  computed_at: "2026-02-15T13:00:00Z",
};

const MOCK_EXCUSE: ExcuseOutput = {
  draft_message:
    "I regret to inform you that I will be unable to attend due to a prior commitment. I sincerely apologize.",
  is_draft: true,
  tone: "formal",
  truth_level: "full",
};

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

function createMockFetchBriefing(data: EventBriefing | null = MOCK_BRIEFING) {
  return vi.fn().mockResolvedValue(data);
}

function createMockGenerateExcuse(data: ExcuseOutput = MOCK_EXCUSE) {
  return vi.fn().mockResolvedValue(data);
}

// ---------------------------------------------------------------------------
// ParticipantCard (tested through BriefingPanel)
// ---------------------------------------------------------------------------

describe("BriefingPanel", () => {
  const user = userEvent.setup();

  describe("loading state", () => {
    it("shows loading indicator while fetching briefing", async () => {
      // Use a promise that never resolves to keep loading state
      const fetchBriefing = vi.fn(
        () => new Promise<EventBriefing>(() => {}),
      );

      render(
        <BriefingPanel
          eventId="evt-1"
          fetchBriefing={fetchBriefing}
          generateExcuse={createMockGenerateExcuse()}
        />,
      );

      expect(screen.getByTestId("briefing-loading")).toBeInTheDocument();
    });

    it("calls fetchBriefing with the event ID", async () => {
      const fetchBriefing = createMockFetchBriefing();

      render(
        <BriefingPanel
          eventId="evt-1"
          fetchBriefing={fetchBriefing}
          generateExcuse={createMockGenerateExcuse()}
        />,
      );

      expect(fetchBriefing).toHaveBeenCalledWith("evt-1");

      // Wait for the async fetch to resolve and flush the resulting state
      // updates, preventing act() warnings from state updates after test ends.
      await waitFor(() => {
        expect(screen.getByTestId("briefing-panel")).toBeInTheDocument();
      });
    });
  });

  describe("briefing content", () => {
    it("renders panel header", async () => {
      render(
        <BriefingPanel
          eventId="evt-1"
          fetchBriefing={createMockFetchBriefing()}
          generateExcuse={createMockGenerateExcuse()}
        />,
      );

      await waitFor(() => {
        expect(screen.getByTestId("briefing-panel")).toBeInTheDocument();
      });

      expect(screen.getByText("Context Briefing")).toBeInTheDocument();
    });

    it("renders topics from briefing data", async () => {
      render(
        <BriefingPanel
          eventId="evt-1"
          fetchBriefing={createMockFetchBriefing()}
          generateExcuse={createMockGenerateExcuse()}
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("review")).toBeInTheDocument();
      });
      expect(screen.getByText("architecture")).toBeInTheDocument();
    });

    it("renders participant cards for each participant", async () => {
      render(
        <BriefingPanel
          eventId="evt-1"
          fetchBriefing={createMockFetchBriefing()}
          generateExcuse={createMockGenerateExcuse()}
        />,
      );

      await waitFor(() => {
        expect(screen.getAllByTestId("participant-card")).toHaveLength(3);
      });
    });
  });

  describe("participant card content", () => {
    it("shows participant name", async () => {
      render(
        <BriefingPanel
          eventId="evt-1"
          fetchBriefing={createMockFetchBriefing()}
          generateExcuse={createMockGenerateExcuse()}
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("Alice Johnson")).toBeInTheDocument();
      });
      expect(screen.getByText("Bob Smith")).toBeInTheDocument();
    });

    it("shows fallback for null display name", async () => {
      render(
        <BriefingPanel
          eventId="evt-1"
          fetchBriefing={createMockFetchBriefing()}
          generateExcuse={createMockGenerateExcuse()}
        />,
      );

      await waitFor(() => {
        // The third participant has null display_name, rendered as "Unknown"
        // in the participant name slot. "Unknown" also appears in drift indicator.
        // We check by looking at participant cards specifically.
        const cards = screen.getAllByTestId("participant-card");
        expect(cards[2]).toHaveTextContent("Unknown");
      });
    });

    it("shows category badge", async () => {
      render(
        <BriefingPanel
          eventId="evt-1"
          fetchBriefing={createMockFetchBriefing()}
          generateExcuse={createMockGenerateExcuse()}
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("Colleague")).toBeInTheDocument();
      });
      expect(screen.getByText("Client")).toBeInTheDocument();
      expect(screen.getByText("Acquaintance")).toBeInTheDocument();
    });

    it("shows last interaction summary", async () => {
      render(
        <BriefingPanel
          eventId="evt-1"
          fetchBriefing={createMockFetchBriefing()}
          generateExcuse={createMockGenerateExcuse()}
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("5 days ago")).toBeInTheDocument();
      });
      expect(screen.getByText("2 months ago")).toBeInTheDocument();
    });

    it("shows reputation score", async () => {
      render(
        <BriefingPanel
          eventId="evt-1"
          fetchBriefing={createMockFetchBriefing()}
          generateExcuse={createMockGenerateExcuse()}
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("92")).toBeInTheDocument();
      });
    });

    it("shows drift indicator", async () => {
      const expectedLabel = computeDriftIndicator(
        MOCK_BRIEFING.participants[0].last_interaction_ts,
      ).label;

      render(
        <BriefingPanel
          eventId="evt-1"
          fetchBriefing={createMockFetchBriefing()}
          generateExcuse={createMockGenerateExcuse()}
        />,
      );

      await waitFor(() => {
        expect(screen.getByText(expectedLabel)).toBeInTheDocument();
      });
    });
  });

  describe("action buttons", () => {
    it("renders Generate Excuse button", async () => {
      render(
        <BriefingPanel
          eventId="evt-1"
          fetchBriefing={createMockFetchBriefing()}
          generateExcuse={createMockGenerateExcuse()}
        />,
      );

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /generate excuse/i }),
        ).toBeInTheDocument();
      });
    });

    it("renders Propose Reschedule button", async () => {
      render(
        <BriefingPanel
          eventId="evt-1"
          fetchBriefing={createMockFetchBriefing()}
          generateExcuse={createMockGenerateExcuse()}
        />,
      );

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /propose reschedule/i }),
        ).toBeInTheDocument();
      });
    });
  });

  describe("excuse modal", () => {
    it("opens when Generate Excuse is clicked", async () => {
      render(
        <BriefingPanel
          eventId="evt-1"
          fetchBriefing={createMockFetchBriefing()}
          generateExcuse={createMockGenerateExcuse()}
        />,
      );

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /generate excuse/i }),
        ).toBeInTheDocument();
      });

      await user.click(
        screen.getByRole("button", { name: /generate excuse/i }),
      );

      expect(screen.getByTestId("excuse-modal")).toBeInTheDocument();
    });

    it("shows tone selector with all options", async () => {
      render(
        <BriefingPanel
          eventId="evt-1"
          fetchBriefing={createMockFetchBriefing()}
          generateExcuse={createMockGenerateExcuse()}
        />,
      );

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /generate excuse/i }),
        ).toBeInTheDocument();
      });

      await user.click(
        screen.getByRole("button", { name: /generate excuse/i }),
      );

      const modal = screen.getByTestId("excuse-modal");
      expect(within(modal).getByTestId("tone-selector")).toBeInTheDocument();

      // All three tones should be available
      expect(within(modal).getByText("Formal")).toBeInTheDocument();
      expect(within(modal).getByText("Casual")).toBeInTheDocument();
      expect(within(modal).getByText("Apologetic")).toBeInTheDocument();
    });

    it("shows truth level selector with all options", async () => {
      render(
        <BriefingPanel
          eventId="evt-1"
          fetchBriefing={createMockFetchBriefing()}
          generateExcuse={createMockGenerateExcuse()}
        />,
      );

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /generate excuse/i }),
        ).toBeInTheDocument();
      });

      await user.click(
        screen.getByRole("button", { name: /generate excuse/i }),
      );

      const modal = screen.getByTestId("excuse-modal");
      expect(
        within(modal).getByTestId("truth-level-selector"),
      ).toBeInTheDocument();

      expect(within(modal).getByText("Full Truth")).toBeInTheDocument();
      expect(within(modal).getByText("Vague")).toBeInTheDocument();
      expect(within(modal).getByText("White Lie")).toBeInTheDocument();
    });

    it("calls generateExcuse with selected tone and truth level", async () => {
      const generateExcuse = createMockGenerateExcuse();

      render(
        <BriefingPanel
          eventId="evt-1"
          fetchBriefing={createMockFetchBriefing()}
          generateExcuse={generateExcuse}
        />,
      );

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /generate excuse/i }),
        ).toBeInTheDocument();
      });

      await user.click(
        screen.getByRole("button", { name: /generate excuse/i }),
      );

      // Click "Generate" button in the modal to generate the excuse
      await user.click(
        screen.getByRole("button", { name: /^generate$/i }),
      );

      expect(generateExcuse).toHaveBeenCalledWith(
        "evt-1",
        expect.objectContaining({
          tone: expect.any(String),
          truth_level: expect.any(String),
        }),
      );
    });

    it("displays generated draft message", async () => {
      render(
        <BriefingPanel
          eventId="evt-1"
          fetchBriefing={createMockFetchBriefing()}
          generateExcuse={createMockGenerateExcuse()}
        />,
      );

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /generate excuse/i }),
        ).toBeInTheDocument();
      });

      await user.click(
        screen.getByRole("button", { name: /generate excuse/i }),
      );

      await user.click(
        screen.getByRole("button", { name: /^generate$/i }),
      );

      await waitFor(() => {
        expect(
          screen.getByTestId("excuse-draft"),
        ).toBeInTheDocument();
      });

      expect(screen.getByTestId("excuse-draft").textContent).toContain(
        "I regret to inform you",
      );
    });

    it("shows copy button after draft is generated", async () => {
      render(
        <BriefingPanel
          eventId="evt-1"
          fetchBriefing={createMockFetchBriefing()}
          generateExcuse={createMockGenerateExcuse()}
        />,
      );

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /generate excuse/i }),
        ).toBeInTheDocument();
      });

      await user.click(
        screen.getByRole("button", { name: /generate excuse/i }),
      );

      await user.click(
        screen.getByRole("button", { name: /^generate$/i }),
      );

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /copy/i }),
        ).toBeInTheDocument();
      });
    });

    it("copies draft to clipboard when copy button is clicked", async () => {
      // Mock clipboard API using defineProperty since navigator.clipboard is getter-only
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText },
        writable: true,
        configurable: true,
      });

      render(
        <BriefingPanel
          eventId="evt-1"
          fetchBriefing={createMockFetchBriefing()}
          generateExcuse={createMockGenerateExcuse()}
        />,
      );

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /generate excuse/i }),
        ).toBeInTheDocument();
      });

      await user.click(
        screen.getByRole("button", { name: /generate excuse/i }),
      );

      await user.click(
        screen.getByRole("button", { name: /^generate$/i }),
      );

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /copy/i }),
        ).toBeInTheDocument();
      });

      await user.click(screen.getByRole("button", { name: /copy/i }));

      expect(writeText).toHaveBeenCalledWith(
        expect.stringContaining("I regret to inform you"),
      );
    });

    it("closes modal when close button is clicked", async () => {
      render(
        <BriefingPanel
          eventId="evt-1"
          fetchBriefing={createMockFetchBriefing()}
          generateExcuse={createMockGenerateExcuse()}
        />,
      );

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /generate excuse/i }),
        ).toBeInTheDocument();
      });

      await user.click(
        screen.getByRole("button", { name: /generate excuse/i }),
      );

      expect(screen.getByTestId("excuse-modal")).toBeInTheDocument();

      // Close the modal
      await user.click(
        within(screen.getByTestId("excuse-modal")).getByRole("button", {
          name: /close/i,
        }),
      );

      expect(screen.queryByTestId("excuse-modal")).not.toBeInTheDocument();
    });

    it("changes tone selection", async () => {
      const generateExcuse = createMockGenerateExcuse();

      render(
        <BriefingPanel
          eventId="evt-1"
          fetchBriefing={createMockFetchBriefing()}
          generateExcuse={generateExcuse}
        />,
      );

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /generate excuse/i }),
        ).toBeInTheDocument();
      });

      await user.click(
        screen.getByRole("button", { name: /generate excuse/i }),
      );

      // Select casual tone
      await user.click(screen.getByText("Casual"));

      // Generate with new tone
      await user.click(
        screen.getByRole("button", { name: /^generate$/i }),
      );

      expect(generateExcuse).toHaveBeenCalledWith(
        "evt-1",
        expect.objectContaining({ tone: "casual" }),
      );
    });

    it("changes truth level selection", async () => {
      const generateExcuse = createMockGenerateExcuse();

      render(
        <BriefingPanel
          eventId="evt-1"
          fetchBriefing={createMockFetchBriefing()}
          generateExcuse={generateExcuse}
        />,
      );

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /generate excuse/i }),
        ).toBeInTheDocument();
      });

      await user.click(
        screen.getByRole("button", { name: /generate excuse/i }),
      );

      // Select "White Lie" truth level
      await user.click(screen.getByText("White Lie"));

      // Generate
      await user.click(
        screen.getByRole("button", { name: /^generate$/i }),
      );

      expect(generateExcuse).toHaveBeenCalledWith(
        "evt-1",
        expect.objectContaining({ truth_level: "white_lie" }),
      );
    });
  });

  describe("error handling", () => {
    it("shows error message when briefing fetch fails", async () => {
      const fetchBriefing = vi.fn().mockRejectedValue(new Error("Network error"));

      render(
        <BriefingPanel
          eventId="evt-1"
          fetchBriefing={fetchBriefing}
          generateExcuse={createMockGenerateExcuse()}
        />,
      );

      await waitFor(() => {
        expect(screen.getByTestId("briefing-error")).toBeInTheDocument();
      });
    });

    it("shows error when excuse generation fails", async () => {
      const generateExcuse = vi
        .fn()
        .mockRejectedValue(new Error("AI unavailable"));

      render(
        <BriefingPanel
          eventId="evt-1"
          fetchBriefing={createMockFetchBriefing()}
          generateExcuse={generateExcuse}
        />,
      );

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /generate excuse/i }),
        ).toBeInTheDocument();
      });

      await user.click(
        screen.getByRole("button", { name: /generate excuse/i }),
      );

      await user.click(
        screen.getByRole("button", { name: /^generate$/i }),
      );

      await waitFor(() => {
        expect(screen.getByTestId("excuse-error")).toBeInTheDocument();
      });
    });
  });

  describe("empty state", () => {
    it("shows empty message when no participants", async () => {
      const emptyBriefing: EventBriefing = {
        event_id: "evt-1",
        event_title: "Solo Work",
        event_start: "2026-02-15T14:00:00Z",
        topics: [],
        participants: [],
        computed_at: "2026-02-15T13:00:00Z",
      };

      render(
        <BriefingPanel
          eventId="evt-1"
          fetchBriefing={createMockFetchBriefing(emptyBriefing)}
          generateExcuse={createMockGenerateExcuse()}
        />,
      );

      await waitFor(() => {
        expect(screen.getByText(/no participant/i)).toBeInTheDocument();
      });
    });
  });

  describe("responsive layout", () => {
    it("renders with responsive container styles", async () => {
      render(
        <BriefingPanel
          eventId="evt-1"
          fetchBriefing={createMockFetchBriefing()}
          generateExcuse={createMockGenerateExcuse()}
        />,
      );

      await waitFor(() => {
        expect(screen.getByTestId("briefing-panel")).toBeInTheDocument();
      });

      const panel = screen.getByTestId("briefing-panel");
      // Panel should have w-full class for responsive behavior
      expect(panel.className).toContain("w-full");
    });
  });
});
