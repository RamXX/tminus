/**
 * Integration tests for the SyncStatus dashboard page.
 *
 * Tests cover:
 * - Component renders with mock sync status data
 * - Auto-refresh polls API at 30s interval
 * - Status badges correct per state (green/yellow/red)
 * - Overall health banner
 * - Error handling and loading states
 *
 * Uses React Testing Library with fake timers.
 *
 * Since SyncStatus now uses useApi() internally, tests mock the
 * api-provider and auth modules instead of passing props.
 *
 * NOTE: When using fake timers with async components, we must use
 * vi.advanceTimersByTimeAsync() to flush both timers AND microtasks
 * (promises). Plain vi.advanceTimersByTime() does not flush promises,
 * causing async state updates to hang.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, act } from "@testing-library/react";
import { SyncStatus } from "./SyncStatus";
import type {
  SyncAccountStatus,
  SyncStatusResponse,
  UserGraphSyncHealth,
} from "../lib/sync-status";
import { REFRESH_INTERVAL_MS } from "../lib/sync-status";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NOW = new Date("2026-02-14T12:00:00Z").getTime();

// ---------------------------------------------------------------------------
// Mock the API provider
// ---------------------------------------------------------------------------

const mockFetchSyncStatus = vi.fn<() => Promise<SyncStatusResponse>>();

// Stable object reference to avoid infinite re-render loops from useCallback deps
const mockApiValue = {
  fetchSyncStatus: mockFetchSyncStatus,
};

vi.mock("../lib/api-provider", () => ({
  useApi: () => mockApiValue,
  ApiProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("../lib/auth", () => ({
  useAuth: () => ({
    token: "test-jwt-token",
    refreshToken: "test-refresh-token",
    user: { id: "user-1", email: "test@example.com" },
    login: vi.fn(),
    logout: vi.fn(),
  }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// ---------------------------------------------------------------------------
// Test data factory
// ---------------------------------------------------------------------------

function makeHealthyAccount(id: string, email: string): SyncAccountStatus {
  return {
    account_id: id,
    email,
    provider: "google",
    status: "active",
    last_sync_ts: new Date(NOW - 5 * 60 * 1000).toISOString(),
    channel_status: "active",
    pending_writes: 0,
    error_count: 0,
  };
}

const MOCK_ACCOUNTS: SyncAccountStatus[] = [
  {
    account_id: "acc-work",
    email: "work@example.com",
    provider: "google",
    status: "active",
    last_sync_ts: new Date(NOW - 5 * 60 * 1000).toISOString(), // 5 min ago -> healthy
    channel_status: "active",
    pending_writes: 2,
    error_count: 0,
  },
  {
    account_id: "acc-personal",
    email: "personal@example.com",
    provider: "google",
    status: "active",
    last_sync_ts: new Date(NOW - 20 * 60 * 1000).toISOString(), // 20 min ago
    channel_status: "expired", // -> degraded
    pending_writes: 0,
    error_count: 0,
  },
  {
    account_id: "acc-broken",
    email: "broken@example.com",
    provider: "google",
    status: "active",
    last_sync_ts: new Date(NOW - 10 * 60 * 1000).toISOString(),
    channel_status: "active",
    pending_writes: 0,
    error_count: 3, // -> error
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupMockResponse(
  accounts: SyncAccountStatus[] = MOCK_ACCOUNTS,
  userGraph: UserGraphSyncHealth | null = null,
) {
  mockFetchSyncStatus.mockResolvedValue({ accounts, user_graph: userGraph });
}

function setupFailingResponse(message = "Network error") {
  mockFetchSyncStatus.mockRejectedValue(new Error(message));
}

/**
 * Render the component and wait for the initial async fetch to complete.
 * With fake timers we must flush microtasks so the component can
 * process the resolved promise and update state.
 */
async function renderAndWaitForData() {
  render(<SyncStatus />);
  // Flush microtasks so the async fetch resolves and state updates
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SyncStatus Dashboard", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    mockFetchSyncStatus.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("rendering accounts", () => {
    it("renders all account emails", async () => {
      setupMockResponse();
      await renderAndWaitForData();

      expect(screen.getByText("work@example.com")).toBeInTheDocument();
      expect(screen.getByText("personal@example.com")).toBeInTheDocument();
      expect(screen.getByText("broken@example.com")).toBeInTheDocument();
    });

    it("renders provider for each account", async () => {
      setupMockResponse();
      await renderAndWaitForData();

      const providerLabels = screen.getAllByText("google");
      expect(providerLabels.length).toBe(3);
    });

    it("renders last sync time for each account", async () => {
      setupMockResponse();
      await renderAndWaitForData();

      const timeElements = screen.getAllByTestId("last-sync-time");
      expect(timeElements.length).toBe(3);
    });

    it("renders channel status for each account", async () => {
      setupMockResponse();
      await renderAndWaitForData();

      const channelElements = screen.getAllByTestId("channel-status");
      expect(channelElements.length).toBe(3);
    });

    it("renders error count for each account", async () => {
      setupMockResponse();
      await renderAndWaitForData();

      const errorElements = screen.getAllByTestId("error-count");
      expect(errorElements.length).toBe(3);

      const brokenRow = screen.getByTestId("account-row-acc-broken");
      const errorBadge = within(brokenRow).getByTestId("error-count");
      expect(errorBadge.textContent).toContain("3");
    });

    it("renders pending writes for each account", async () => {
      setupMockResponse();
      await renderAndWaitForData();

      const workRow = screen.getByTestId("account-row-acc-work");
      const pendingEl = within(workRow).getByTestId("pending-writes");
      expect(pendingEl.textContent).toContain("2");
    });
  });

  describe("health color coding", () => {
    it("shows green indicator for healthy account", async () => {
      setupMockResponse();
      await renderAndWaitForData();

      const workRow = screen.getByTestId("account-row-acc-work");
      const indicator = within(workRow).getByTestId("health-indicator");
      expect(indicator).toHaveAttribute("data-health", "healthy");
      expect(indicator).toHaveAttribute("data-color", "green");
    });

    it("shows yellow indicator for degraded account", async () => {
      setupMockResponse();
      await renderAndWaitForData();

      const personalRow = screen.getByTestId("account-row-acc-personal");
      const indicator = within(personalRow).getByTestId("health-indicator");
      expect(indicator).toHaveAttribute("data-health", "degraded");
      expect(indicator).toHaveAttribute("data-color", "yellow");
    });

    it("shows red indicator for error account", async () => {
      setupMockResponse();
      await renderAndWaitForData();

      const brokenRow = screen.getByTestId("account-row-acc-broken");
      const indicator = within(brokenRow).getByTestId("health-indicator");
      expect(indicator).toHaveAttribute("data-health", "error");
      expect(indicator).toHaveAttribute("data-color", "red");
    });

    it("shows red indicator for stale account when channel is not active", async () => {
      const staleAccount: SyncAccountStatus = {
        account_id: "acc-stale",
        email: "stale@example.com",
        provider: "google",
        status: "active",
        last_sync_ts: null,
        channel_status: "missing",
        pending_writes: 0,
        error_count: 0,
      };
      setupMockResponse([staleAccount]);
      await renderAndWaitForData();

      const row = screen.getByTestId("account-row-acc-stale");
      const indicator = within(row).getByTestId("health-indicator");
      expect(indicator).toHaveAttribute("data-health", "stale");
      expect(indicator).toHaveAttribute("data-color", "red");
    });
  });

  describe("overall health banner", () => {
    it("shows healthy banner when all accounts healthy", async () => {
      const healthyAccounts: SyncAccountStatus[] = [
        makeHealthyAccount("acc-a", "a@test.com"),
        makeHealthyAccount("acc-b", "b@test.com"),
      ];
      setupMockResponse(healthyAccounts);
      await renderAndWaitForData();

      const banner = screen.getByTestId("overall-health-banner");
      expect(banner).toHaveAttribute("data-health", "healthy");
    });

    it("shows error banner when any account has errors", async () => {
      setupMockResponse();
      await renderAndWaitForData();

      const banner = screen.getByTestId("overall-health-banner");
      expect(banner).toHaveAttribute("data-health", "error");
    });

    it("shows degraded banner when worst is degraded (no errors)", async () => {
      const accounts: SyncAccountStatus[] = [
        makeHealthyAccount("acc-a", "a@test.com"),
        {
          ...makeHealthyAccount("acc-b", "b@test.com"),
          channel_status: "expired",
        },
      ];
      setupMockResponse(accounts);
      await renderAndWaitForData();

      const banner = screen.getByTestId("overall-health-banner");
      expect(banner).toHaveAttribute("data-health", "degraded");
    });

    it("banner contains health label text", async () => {
      setupMockResponse();
      await renderAndWaitForData();

      const banner = screen.getByTestId("overall-health-banner");
      expect(banner.textContent).toContain("Error");
    });

    it("reflects user graph errors even when account rows are healthy", async () => {
      const healthyAccounts: SyncAccountStatus[] = [
        makeHealthyAccount("acc-a", "a@test.com"),
        makeHealthyAccount("acc-b", "b@test.com"),
      ];
      const userGraph: UserGraphSyncHealth = {
        total_events: 12,
        total_mirrors: 24,
        active_mirrors: 20,
        pending_mirrors: 0,
        deleting_mirrors: 0,
        error_mirrors: 4,
        last_activity_ts: new Date(NOW).toISOString(),
      };
      setupMockResponse(healthyAccounts, userGraph);
      await renderAndWaitForData();

      const banner = screen.getByTestId("overall-health-banner");
      expect(banner).toHaveAttribute("data-health", "error");
      expect(screen.getByTestId("user-graph-health")).toHaveTextContent("4 errors");
    });
  });

  describe("auto-refresh", () => {
    it("fetches data on mount", async () => {
      setupMockResponse();
      await renderAndWaitForData();

      expect(mockFetchSyncStatus).toHaveBeenCalledTimes(1);
    });

    it("auto-refreshes every 30 seconds", async () => {
      setupMockResponse();
      await renderAndWaitForData();

      expect(mockFetchSyncStatus).toHaveBeenCalledTimes(1);

      // Advance 30 seconds and flush microtasks
      await act(async () => {
        await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS);
      });

      expect(mockFetchSyncStatus).toHaveBeenCalledTimes(2);

      // Advance another 30 seconds
      await act(async () => {
        await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS);
      });

      expect(mockFetchSyncStatus).toHaveBeenCalledTimes(3);
    });

    it("does not refresh before 30 seconds", async () => {
      setupMockResponse();
      await renderAndWaitForData();

      expect(mockFetchSyncStatus).toHaveBeenCalledTimes(1);

      // Advance 29 seconds -- should NOT trigger a refresh
      await act(async () => {
        await vi.advanceTimersByTimeAsync(29_000);
      });

      expect(mockFetchSyncStatus).toHaveBeenCalledTimes(1);
    });

    it("cleans up timer on unmount", async () => {
      setupMockResponse();
      const { unmount } = render(<SyncStatus />);

      // Flush initial fetch
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(mockFetchSyncStatus).toHaveBeenCalledTimes(1);

      unmount();

      // Advance time -- should NOT trigger fetch since unmounted
      await act(async () => {
        await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS * 3);
      });

      expect(mockFetchSyncStatus).toHaveBeenCalledTimes(1);
    });
  });

  describe("loading state", () => {
    it("shows loading indicator while fetching", () => {
      mockFetchSyncStatus.mockReturnValue(new Promise(() => {}));
      render(<SyncStatus />);

      expect(screen.getByTestId("sync-status-loading")).toBeInTheDocument();
    });
  });

  describe("error state", () => {
    it("shows error message on fetch failure", async () => {
      setupFailingResponse("API unavailable");
      await renderAndWaitForData();

      expect(screen.getByTestId("sync-status-error")).toBeInTheDocument();
      expect(screen.getByText(/failed to load/i)).toBeInTheDocument();
    });

    it("shows retry button on error", async () => {
      setupFailingResponse();
      await renderAndWaitForData();

      expect(
        screen.getByRole("button", { name: /retry/i }),
      ).toBeInTheDocument();
    });
  });

  describe("empty state", () => {
    it("shows message when no accounts configured", async () => {
      setupMockResponse([]);
      await renderAndWaitForData();

      expect(screen.getByText(/no accounts/i)).toBeInTheDocument();
    });
  });
});
