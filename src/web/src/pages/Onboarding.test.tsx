/**
 * Tests for the Onboarding page.
 *
 * Covers:
 * - Unit: renders branded onboarding page with provider buttons
 * - Unit: Google button enabled, Microsoft and Apple buttons disabled/coming soon
 * - Unit: status polling displays correct sync state
 * - Integration: clicking "Connect Google" constructs correct OAuth URL
 * - Integration: OAuth callback triggers status polling
 * - Integration: sync completion shows success state with account email
 * - Integration: error states handled gracefully
 *
 * Uses React Testing Library with fireEvent for click interactions.
 * Uses fake timers for polling behavior tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent, within } from "@testing-library/react";
import { Onboarding, type OnboardingProps } from "./Onboarding";
import type { OnboardingSyncStatus } from "../lib/onboarding";

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const MOCK_USER = { id: "user-test-123", email: "test@example.com" };

const MOCK_SYNC_STATUS_PENDING: OnboardingSyncStatus = {
  account_id: "acc-google-456",
  email: "connected@gmail.com",
  provider: "google",
  status: "active",
  health: null,
};

const MOCK_SYNC_STATUS_SYNCING: OnboardingSyncStatus = {
  account_id: "acc-google-456",
  email: "connected@gmail.com",
  provider: "google",
  status: "active",
  health: {
    lastSyncTs: "2026-02-15T12:00:00Z",
    lastSuccessTs: null,
    fullSyncNeeded: true,
  },
};

const MOCK_SYNC_STATUS_COMPLETE: OnboardingSyncStatus = {
  account_id: "acc-google-456",
  email: "connected@gmail.com",
  provider: "google",
  status: "active",
  health: {
    lastSyncTs: "2026-02-15T12:00:05Z",
    lastSuccessTs: "2026-02-15T12:00:05Z",
    fullSyncNeeded: false,
  },
};

const MOCK_EVENTS = [
  {
    canonical_event_id: "evt-1",
    summary: "Team Standup",
    start: "2026-02-15T09:00:00Z",
    end: "2026-02-15T09:30:00Z",
  },
  {
    canonical_event_id: "evt-2",
    summary: "Lunch with Alice",
    start: "2026-02-15T12:00:00Z",
    end: "2026-02-15T13:00:00Z",
  },
  {
    canonical_event_id: "evt-3",
    summary: "Project Review",
    start: "2026-02-15T15:00:00Z",
    end: "2026-02-15T16:00:00Z",
  },
];

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockNavigate() {
  return vi.fn((_url: string) => {});
}

function createMockFetchStatus(
  sequence: OnboardingSyncStatus[] = [MOCK_SYNC_STATUS_COMPLETE],
) {
  let callIndex = 0;
  return vi.fn(async (_accountId: string): Promise<OnboardingSyncStatus> => {
    const status = sequence[Math.min(callIndex, sequence.length - 1)];
    callIndex++;
    return status;
  });
}

function createMockFetchEvents(events = MOCK_EVENTS) {
  return vi.fn(async (): Promise<typeof MOCK_EVENTS> => events);
}

function createFailingFetchStatus(message = "Network error") {
  return vi.fn(async (_accountId: string): Promise<OnboardingSyncStatus> => {
    throw new Error(message);
  });
}

/**
 * Render the Onboarding component with default props and wait for initial render.
 */
async function renderOnboarding(overrides: Partial<OnboardingProps> = {}) {
  const navigateToOAuth = overrides.navigateToOAuth ?? createMockNavigate();
  const fetchAccountStatus =
    overrides.fetchAccountStatus ?? createMockFetchStatus();
  const fetchEvents = overrides.fetchEvents ?? createMockFetchEvents();

  const result = render(
    <Onboarding
      user={overrides.user ?? MOCK_USER}
      navigateToOAuth={navigateToOAuth}
      fetchAccountStatus={fetchAccountStatus}
      fetchEvents={fetchEvents}
      callbackAccountId={overrides.callbackAccountId ?? null}
      oauthBaseUrl={overrides.oauthBaseUrl ?? "https://oauth.tminus.ink"}
    />,
  );

  // Flush microtasks for any initial async operations
  await act(async () => {});

  return {
    ...result,
    navigateToOAuth,
    fetchAccountStatus,
    fetchEvents,
  };
}

// ---------------------------------------------------------------------------
// Unit tests: initial render
// ---------------------------------------------------------------------------

describe("Onboarding page", () => {
  describe("initial render (idle state)", () => {
    it("renders branded onboarding heading", async () => {
      await renderOnboarding();

      expect(
        screen.getByRole("heading", { level: 1 }),
      ).toHaveTextContent(/connect your calendar/i);
    });

    it("renders T-Minus branding", async () => {
      await renderOnboarding();

      expect(screen.getByText(/t-minus/i)).toBeInTheDocument();
    });

    it("renders Connect Google button", async () => {
      await renderOnboarding();

      const googleButton = screen.getByRole("button", {
        name: /connect google/i,
      });
      expect(googleButton).toBeInTheDocument();
      expect(googleButton).toBeEnabled();
    });

    it("renders Microsoft button as disabled (coming soon)", async () => {
      await renderOnboarding();

      const msButton = screen.getByRole("button", {
        name: /microsoft/i,
      });
      expect(msButton).toBeInTheDocument();
      expect(msButton).toBeDisabled();
    });

    it("renders Apple button as disabled (coming soon)", async () => {
      await renderOnboarding();

      const appleButton = screen.getByRole("button", {
        name: /apple/i,
      });
      expect(appleButton).toBeInTheDocument();
      expect(appleButton).toBeDisabled();
    });

    it("shows provider descriptions", async () => {
      await renderOnboarding();

      expect(screen.getByText(/google workspace/i)).toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // Integration: OAuth flow initiation
  // ---------------------------------------------------------------------------

  describe("OAuth flow initiation", () => {
    it("clicking Connect Google navigates to OAuth URL with correct params", async () => {
      const navigateToOAuth = createMockNavigate();
      await renderOnboarding({ navigateToOAuth });

      const googleButton = screen.getByRole("button", {
        name: /connect google/i,
      });
      fireEvent.click(googleButton);

      expect(navigateToOAuth).toHaveBeenCalledTimes(1);
      const url = new URL(navigateToOAuth.mock.calls[0][0]);
      expect(url.pathname).toBe("/oauth/google/start");
      expect(url.searchParams.get("user_id")).toBe("user-test-123");
      expect(url.searchParams.has("redirect_uri")).toBe(true);
    });

    it("uses custom oauthBaseUrl when provided", async () => {
      const navigateToOAuth = createMockNavigate();
      await renderOnboarding({
        navigateToOAuth,
        oauthBaseUrl: "http://localhost:8787",
      });

      fireEvent.click(
        screen.getByRole("button", { name: /connect google/i }),
      );

      const url = new URL(navigateToOAuth.mock.calls[0][0]);
      expect(url.origin).toBe("http://localhost:8787");
    });
  });

  // ---------------------------------------------------------------------------
  // Integration: OAuth callback and sync polling
  // ---------------------------------------------------------------------------

  describe("OAuth callback and sync polling", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("shows syncing state when callbackAccountId is provided", async () => {
      const fetchAccountStatus = createMockFetchStatus([
        MOCK_SYNC_STATUS_PENDING,
      ]);

      await renderOnboarding({
        callbackAccountId: "acc-google-456",
        fetchAccountStatus,
      });

      // Should show syncing indicator
      expect(screen.getByText(/syncing/i)).toBeInTheDocument();
    });

    it("polls account status at regular intervals", async () => {
      const fetchAccountStatus = createMockFetchStatus([
        MOCK_SYNC_STATUS_PENDING,
        MOCK_SYNC_STATUS_SYNCING,
        MOCK_SYNC_STATUS_COMPLETE,
      ]);

      await renderOnboarding({
        callbackAccountId: "acc-google-456",
        fetchAccountStatus,
      });

      // First call happens immediately on mount
      expect(fetchAccountStatus).toHaveBeenCalledTimes(1);

      // Advance timer to trigger second poll
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(fetchAccountStatus).toHaveBeenCalledTimes(2);

      // Advance timer to trigger third poll
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(fetchAccountStatus).toHaveBeenCalledTimes(3);
    });

    it("shows account email after sync completes", async () => {
      const fetchAccountStatus = createMockFetchStatus([
        MOCK_SYNC_STATUS_COMPLETE,
      ]);
      const fetchEvents = createMockFetchEvents();

      await renderOnboarding({
        callbackAccountId: "acc-google-456",
        fetchAccountStatus,
        fetchEvents,
      });

      // Wait for status to be fetched and processed
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(screen.getByText(/connected@gmail.com/i)).toBeInTheDocument();
    });

    it("shows connected status after sync completes", async () => {
      const fetchAccountStatus = createMockFetchStatus([
        MOCK_SYNC_STATUS_COMPLETE,
      ]);
      const fetchEvents = createMockFetchEvents();

      await renderOnboarding({
        callbackAccountId: "acc-google-456",
        fetchAccountStatus,
        fetchEvents,
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      // The checkmark + "Connected" text in the success banner
      expect(screen.getByText(/\u2713 Connected/)).toBeInTheDocument();
    });

    it("fetches and displays events after sync completes", async () => {
      const fetchAccountStatus = createMockFetchStatus([
        MOCK_SYNC_STATUS_COMPLETE,
      ]);
      const fetchEvents = createMockFetchEvents();

      await renderOnboarding({
        callbackAccountId: "acc-google-456",
        fetchAccountStatus,
        fetchEvents,
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      // Events should be fetched
      expect(fetchEvents).toHaveBeenCalled();

      // Wait for events to render
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(screen.getByText("Team Standup")).toBeInTheDocument();
      expect(screen.getByText("Lunch with Alice")).toBeInTheDocument();
      expect(screen.getByText("Project Review")).toBeInTheDocument();
    });

    it("stops polling once sync is complete", async () => {
      const fetchAccountStatus = createMockFetchStatus([
        MOCK_SYNC_STATUS_COMPLETE,
      ]);

      await renderOnboarding({
        callbackAccountId: "acc-google-456",
        fetchAccountStatus,
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      // Should have called once (initial) and then stopped
      const callCount = fetchAccountStatus.mock.calls.length;

      // Advance time significantly -- should not poll anymore
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });

      expect(fetchAccountStatus.mock.calls.length).toBe(callCount);
    });

    it("shows error state when status polling fails", async () => {
      const fetchAccountStatus = createFailingFetchStatus("API unreachable");

      await renderOnboarding({
        callbackAccountId: "acc-google-456",
        fetchAccountStatus,
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(screen.getByText(/error|failed|something went wrong/i)).toBeInTheDocument();
    });
  });
});
