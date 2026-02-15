/**
 * Tests for EventDetail component and MirrorStatusBadge.
 *
 * Unit tests:
 * - MirrorStatusBadge renders correct color per status (ACTIVE=green, PENDING=yellow, ERROR=red)
 * - Event detail formatting (time range, version, updated_at)
 *
 * Integration tests:
 * - Full component renders with mock event data including mirrors array
 * - Status badges show correct colors
 * - Handles missing optional fields (no description, no location)
 * - Close/dismiss behavior
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  EventDetail,
  MirrorStatusBadge,
  getMirrorStatusColor,
  getMirrorStatusLabel,
} from "./EventDetail";
import type { CalendarEvent, EventMirror } from "../lib/api";

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const FULL_EVENT: CalendarEvent = {
  canonical_event_id: "evt-detail-1",
  summary: "Architecture Review",
  description: "Review Q1 architecture decisions and plan Q2 roadmap.",
  location: "Conference Room B, Floor 3",
  start: "2026-02-14T14:00:00Z",
  end: "2026-02-14T15:30:00Z",
  origin_account_id: "account-work",
  origin_account_email: "alice@company.com",
  status: "confirmed",
  version: 3,
  updated_at: "2026-02-14T10:00:00Z",
  mirrors: [
    {
      target_account_id: "account-personal",
      target_account_email: "alice@gmail.com",
      sync_status: "ACTIVE",
    },
    {
      target_account_id: "account-family",
      target_account_email: "alice@family.org",
      sync_status: "PENDING",
    },
    {
      target_account_id: "account-old",
      target_account_email: "alice@legacy.co",
      sync_status: "ERROR",
      last_error: "Token expired",
    },
  ],
};

const MINIMAL_EVENT: CalendarEvent = {
  canonical_event_id: "evt-detail-2",
  summary: "Quick Sync",
  start: "2026-02-15T09:00:00Z",
  end: "2026-02-15T09:15:00Z",
};

const NO_TITLE_EVENT: CalendarEvent = {
  canonical_event_id: "evt-detail-3",
  start: "2026-02-15T11:00:00Z",
  end: "2026-02-15T11:30:00Z",
  origin_account_id: "account-work",
  mirrors: [],
};

// ---------------------------------------------------------------------------
// Unit tests: getMirrorStatusColor / getMirrorStatusLabel
// ---------------------------------------------------------------------------

describe("getMirrorStatusColor", () => {
  it("returns green for ACTIVE", () => {
    expect(getMirrorStatusColor("ACTIVE")).toBe("#22c55e");
  });

  it("returns yellow/amber for PENDING", () => {
    expect(getMirrorStatusColor("PENDING")).toBe("#f59e0b");
  });

  it("returns red for ERROR", () => {
    expect(getMirrorStatusColor("ERROR")).toBe("#ef4444");
  });
});

describe("getMirrorStatusLabel", () => {
  it("returns human-readable label for each status", () => {
    expect(getMirrorStatusLabel("ACTIVE")).toBe("Active");
    expect(getMirrorStatusLabel("PENDING")).toBe("Pending");
    expect(getMirrorStatusLabel("ERROR")).toBe("Error");
  });
});

// ---------------------------------------------------------------------------
// Unit tests: MirrorStatusBadge
// ---------------------------------------------------------------------------

describe("MirrorStatusBadge", () => {
  it("renders ACTIVE badge with green background", () => {
    const mirror: EventMirror = {
      target_account_id: "acc-1",
      target_account_email: "user@example.com",
      sync_status: "ACTIVE",
    };
    render(<MirrorStatusBadge mirror={mirror} />);

    const badge = screen.getByTestId("mirror-status-badge");
    expect(badge).toBeInTheDocument();
    // Should contain the account email
    expect(screen.getByText("user@example.com")).toBeInTheDocument();
    // Should show "Active" label
    expect(screen.getByText("Active")).toBeInTheDocument();
    // The status indicator should have green color
    const indicator = screen.getByTestId("mirror-status-indicator");
    expect(indicator.style.backgroundColor).toBe("rgb(34, 197, 94)");
  });

  it("renders PENDING badge with yellow/amber background", () => {
    const mirror: EventMirror = {
      target_account_id: "acc-2",
      target_account_email: "user2@example.com",
      sync_status: "PENDING",
    };
    render(<MirrorStatusBadge mirror={mirror} />);

    const indicator = screen.getByTestId("mirror-status-indicator");
    expect(indicator.style.backgroundColor).toBe("rgb(245, 158, 11)");
    expect(screen.getByText("Pending")).toBeInTheDocument();
  });

  it("renders ERROR badge with red background", () => {
    const mirror: EventMirror = {
      target_account_id: "acc-3",
      target_account_email: "user3@example.com",
      sync_status: "ERROR",
      last_error: "Token expired",
    };
    render(<MirrorStatusBadge mirror={mirror} />);

    const indicator = screen.getByTestId("mirror-status-indicator");
    expect(indicator.style.backgroundColor).toBe("rgb(239, 68, 68)");
    expect(screen.getByText("Error")).toBeInTheDocument();
  });

  it("falls back to account ID when email is not provided", () => {
    const mirror: EventMirror = {
      target_account_id: "acc-4",
      sync_status: "ACTIVE",
    };
    render(<MirrorStatusBadge mirror={mirror} />);

    expect(screen.getByText("acc-4")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Integration tests: EventDetail
// ---------------------------------------------------------------------------

describe("EventDetail", () => {
  const user = userEvent.setup();

  describe("full event rendering", () => {
    it("displays event title", () => {
      render(<EventDetail event={FULL_EVENT} onClose={vi.fn()} />);
      expect(screen.getByText("Architecture Review")).toBeInTheDocument();
    });

    it("displays event time range", () => {
      render(<EventDetail event={FULL_EVENT} onClose={vi.fn()} />);
      // Should show formatted start and end times
      const timeEl = screen.getByTestId("event-detail-time");
      expect(timeEl.textContent).toBeTruthy();
      // The time element should contain some time representation
      expect(timeEl.textContent!.length).toBeGreaterThan(0);
    });

    it("displays event description", () => {
      render(<EventDetail event={FULL_EVENT} onClose={vi.fn()} />);
      expect(
        screen.getByText(/Review Q1 architecture decisions/),
      ).toBeInTheDocument();
    });

    it("displays event location", () => {
      render(<EventDetail event={FULL_EVENT} onClose={vi.fn()} />);
      expect(
        screen.getByText("Conference Room B, Floor 3"),
      ).toBeInTheDocument();
    });

    it("displays origin account", () => {
      render(<EventDetail event={FULL_EVENT} onClose={vi.fn()} />);
      expect(screen.getByText("alice@company.com")).toBeInTheDocument();
    });

    it("displays version number", () => {
      render(<EventDetail event={FULL_EVENT} onClose={vi.fn()} />);
      expect(screen.getByText(/v3/)).toBeInTheDocument();
    });

    it("displays last update time", () => {
      render(<EventDetail event={FULL_EVENT} onClose={vi.fn()} />);
      const metaEl = screen.getByTestId("event-detail-meta");
      expect(metaEl.textContent).toBeTruthy();
    });

    it("renders mirror status badges for all mirrors", () => {
      render(<EventDetail event={FULL_EVENT} onClose={vi.fn()} />);
      const badges = screen.getAllByTestId("mirror-status-badge");
      expect(badges).toHaveLength(3);
    });

    it("shows correct status colors for each mirror", () => {
      render(<EventDetail event={FULL_EVENT} onClose={vi.fn()} />);
      const indicators = screen.getAllByTestId("mirror-status-indicator");
      expect(indicators).toHaveLength(3);

      // ACTIVE = green
      expect(indicators[0].style.backgroundColor).toBe("rgb(34, 197, 94)");
      // PENDING = yellow/amber
      expect(indicators[1].style.backgroundColor).toBe("rgb(245, 158, 11)");
      // ERROR = red
      expect(indicators[2].style.backgroundColor).toBe("rgb(239, 68, 68)");
    });

    it("shows mirror account emails", () => {
      render(<EventDetail event={FULL_EVENT} onClose={vi.fn()} />);
      expect(screen.getByText("alice@gmail.com")).toBeInTheDocument();
      expect(screen.getByText("alice@family.org")).toBeInTheDocument();
      expect(screen.getByText("alice@legacy.co")).toBeInTheDocument();
    });
  });

  describe("missing optional fields", () => {
    it("handles event with no description", () => {
      render(<EventDetail event={MINIMAL_EVENT} onClose={vi.fn()} />);
      expect(screen.getByText("Quick Sync")).toBeInTheDocument();
      // Description section should not be present
      expect(screen.queryByTestId("event-detail-description")).not.toBeInTheDocument();
    });

    it("handles event with no location", () => {
      render(<EventDetail event={MINIMAL_EVENT} onClose={vi.fn()} />);
      expect(screen.queryByTestId("event-detail-location")).not.toBeInTheDocument();
    });

    it("handles event with no mirrors", () => {
      render(<EventDetail event={MINIMAL_EVENT} onClose={vi.fn()} />);
      expect(screen.queryByTestId("mirror-status-badge")).not.toBeInTheDocument();
      // Should show a "no mirrors" message
      expect(screen.getByText(/no mirrors/i)).toBeInTheDocument();
    });

    it("handles event with empty mirrors array", () => {
      render(<EventDetail event={NO_TITLE_EVENT} onClose={vi.fn()} />);
      expect(screen.getByText(/no mirrors/i)).toBeInTheDocument();
    });

    it("shows fallback title when summary is missing", () => {
      render(<EventDetail event={NO_TITLE_EVENT} onClose={vi.fn()} />);
      expect(screen.getByText("(No title)")).toBeInTheDocument();
    });

    it("handles missing origin account gracefully", () => {
      render(<EventDetail event={MINIMAL_EVENT} onClose={vi.fn()} />);
      // Should show fallback text for unknown origin
      expect(screen.getByText(/unknown/i)).toBeInTheDocument();
    });

    it("handles missing version gracefully", () => {
      render(<EventDetail event={MINIMAL_EVENT} onClose={vi.fn()} />);
      // Should not crash; meta section should still render
      const metaEl = screen.getByTestId("event-detail-meta");
      expect(metaEl).toBeInTheDocument();
    });
  });

  describe("close/dismiss", () => {
    it("calls onClose when close button is clicked", async () => {
      const onClose = vi.fn();
      render(<EventDetail event={FULL_EVENT} onClose={onClose} />);

      const closeBtn = screen.getByRole("button", { name: /close/i });
      await user.click(closeBtn);

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("calls onClose when overlay/backdrop is clicked", async () => {
      const onClose = vi.fn();
      render(<EventDetail event={FULL_EVENT} onClose={onClose} />);

      const overlay = screen.getByTestId("event-detail-overlay");
      await user.click(overlay);

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("does NOT call onClose when clicking inside the panel", async () => {
      const onClose = vi.fn();
      render(<EventDetail event={FULL_EVENT} onClose={onClose} />);

      const panel = screen.getByTestId("event-detail-panel");
      await user.click(panel);

      expect(onClose).not.toHaveBeenCalled();
    });
  });
});
