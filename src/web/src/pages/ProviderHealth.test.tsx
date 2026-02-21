/**
 * Tests for the Provider Health Dashboard page.
 *
 * Covers:
 * - Unit: account list rendering with mixed health statuses, provider-specific
 *   colors, status badges, calendar counts, sync timestamps
 * - Unit: account detail expansion with sync history, token info, remediation
 * - Integration: fetch accounts with health data, reconnect flow, remove flow,
 *   sync history display, stale detection, error states
 *
 * Uses React Testing Library with fireEvent for click interactions.
 *
 * Since ProviderHealth now uses useApi() internally, tests mock the
 * api-provider and auth modules instead of passing props.
 *
 * NOTE: We use fireEvent.click instead of userEvent.click because this component
 * uses timers (auto-refresh) that interact poorly with userEvent's internal
 * delay mechanism under fake timers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, act, fireEvent } from "@testing-library/react";
import { ProviderHealth } from "./ProviderHealth";
import type { AccountHealthData, SyncHistoryEvent, AccountsHealthResponse, SyncHistoryResponse } from "../lib/provider-health";

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const NOW = new Date("2026-02-14T12:00:00Z").getTime();

const MOCK_ACCOUNTS: AccountHealthData[] = [
  {
    account_id: "acc-google-work",
    email: "work@gmail.com",
    provider: "google",
    status: "active",
    calendar_count: 3,
    calendar_names: ["Work", "Personal", "Shared"],
    last_successful_sync: new Date(NOW - 5 * 60 * 1000).toISOString(),
    is_syncing: false,
    error_message: null,
    token_expires_at: new Date(NOW + 60 * 60 * 1000).toISOString(),
    created_at: new Date(NOW - 7 * 24 * 60 * 60 * 1000).toISOString(),
  },
  {
    account_id: "acc-google-personal",
    email: "personal@gmail.com",
    provider: "google",
    status: "active",
    calendar_count: 2,
    calendar_names: ["Main", "Family"],
    last_successful_sync: new Date(NOW - 5 * 60 * 1000).toISOString(),
    is_syncing: true,
    error_message: null,
    token_expires_at: new Date(NOW + 2 * 60 * 60 * 1000).toISOString(),
    created_at: new Date(NOW - 3 * 24 * 60 * 60 * 1000).toISOString(),
  },
  {
    account_id: "acc-ms-outlook",
    email: "user@outlook.com",
    provider: "microsoft",
    status: "active",
    calendar_count: 1,
    calendar_names: ["Calendar"],
    last_successful_sync: null,
    is_syncing: false,
    error_message: "Token expired during refresh",
    token_expires_at: null,
    created_at: new Date(NOW - 14 * 24 * 60 * 60 * 1000).toISOString(),
  },
];

const MOCK_RESPONSE: AccountsHealthResponse = {
  accounts: MOCK_ACCOUNTS,
  account_count: 3,
  tier_limit: 5,
};

const MOCK_SYNC_HISTORY: SyncHistoryEvent[] = [
  { id: "sh-1", timestamp: new Date(NOW - 5 * 60 * 1000).toISOString(), event_count: 12, status: "success" },
  { id: "sh-2", timestamp: new Date(NOW - 35 * 60 * 1000).toISOString(), event_count: 8, status: "success" },
  { id: "sh-3", timestamp: new Date(NOW - 65 * 60 * 1000).toISOString(), event_count: 0, status: "error", error_message: "Rate limit" },
  { id: "sh-4", timestamp: new Date(NOW - 95 * 60 * 1000).toISOString(), event_count: 5, status: "success" },
  { id: "sh-5", timestamp: new Date(NOW - 125 * 60 * 1000).toISOString(), event_count: 3, status: "success" },
  { id: "sh-6", timestamp: new Date(NOW - 155 * 60 * 1000).toISOString(), event_count: 7, status: "success" },
  { id: "sh-7", timestamp: new Date(NOW - 185 * 60 * 1000).toISOString(), event_count: 2, status: "success" },
  { id: "sh-8", timestamp: new Date(NOW - 215 * 60 * 1000).toISOString(), event_count: 10, status: "success" },
  { id: "sh-9", timestamp: new Date(NOW - 245 * 60 * 1000).toISOString(), event_count: 4, status: "error", error_message: "Timeout" },
  { id: "sh-10", timestamp: new Date(NOW - 275 * 60 * 1000).toISOString(), event_count: 6, status: "success" },
];

// ---------------------------------------------------------------------------
// Mock the API provider and auth
// ---------------------------------------------------------------------------

const mockFetchAccountsHealth = vi.fn<() => Promise<AccountsHealthResponse>>();
const mockFetchSyncHistory = vi.fn<(accountId: string) => Promise<SyncHistoryResponse>>();
const mockReconnectAccount = vi.fn<(accountId: string) => Promise<void>>();
const mockRemoveAccount = vi.fn<(accountId: string) => Promise<void>>();

const mockApiValue = {
  fetchAccountsHealth: mockFetchAccountsHealth,
  fetchSyncHistory: mockFetchSyncHistory,
  reconnectAccount: mockReconnectAccount,
  removeAccount: mockRemoveAccount,
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

// Mock window.location.assign for reconnect flow
const mockLocationAssign = vi.fn();
Object.defineProperty(window, "location", {
  writable: true,
  value: { ...window.location, assign: mockLocationAssign },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupMockResponse(response: AccountsHealthResponse = MOCK_RESPONSE) {
  mockFetchAccountsHealth.mockResolvedValue(response);
}

function setupFailingResponse(message = "Network error") {
  mockFetchAccountsHealth.mockRejectedValue(new Error(message));
}

function setupMockSyncHistory(events: SyncHistoryEvent[] = MOCK_SYNC_HISTORY) {
  mockFetchSyncHistory.mockImplementation(
    async (accountId: string): Promise<SyncHistoryResponse> => ({
      account_id: accountId,
      events,
    }),
  );
}

async function renderAndWait() {
  render(<ProviderHealth />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ProviderHealth Dashboard", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    mockFetchAccountsHealth.mockReset();
    mockFetchSyncHistory.mockReset();
    mockReconnectAccount.mockReset();
    mockRemoveAccount.mockReset();
    mockLocationAssign.mockReset();
    // Set up default mocks
    setupMockSyncHistory();
    mockReconnectAccount.mockResolvedValue(undefined);
    mockRemoveAccount.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // =========================================================================
  // Unit: Account list rendering
  // =========================================================================

  describe("account list rendering", () => {
    it("renders all account emails", async () => {
      setupMockResponse();
      await renderAndWait();

      expect(screen.getByText("work@gmail.com")).toBeInTheDocument();
      expect(screen.getByText("personal@gmail.com")).toBeInTheDocument();
      expect(screen.getByText("user@outlook.com")).toBeInTheDocument();
    });

    it("shows calendar count for each account", async () => {
      setupMockResponse();
      await renderAndWait();

      const row = screen.getByTestId("health-row-acc-google-work");
      expect(within(row).getByTestId("calendar-count")).toHaveTextContent("3");
    });

    it("shows calendar names for each account", async () => {
      setupMockResponse();
      await renderAndWait();

      const row = screen.getByTestId("health-row-acc-google-work");
      expect(within(row).getByTestId("calendar-names")).toHaveTextContent("Work, Personal, Shared");
    });

    it("shows last sync time for each account", async () => {
      setupMockResponse();
      await renderAndWait();

      const row = screen.getByTestId("health-row-acc-google-work");
      expect(within(row).getByTestId("last-sync")).toHaveTextContent("5m ago");
    });

    it("shows 'Never' for accounts that have never synced", async () => {
      setupMockResponse();
      await renderAndWait();

      const row = screen.getByTestId("health-row-acc-ms-outlook");
      expect(within(row).getByTestId("last-sync")).toHaveTextContent("Never");
    });

    it("shows account count and tier limit", async () => {
      setupMockResponse();
      await renderAndWait();

      const counter = screen.getByTestId("account-counter");
      expect(counter).toHaveTextContent("3 of 5");
    });
  });

  // =========================================================================
  // Unit: Status badges
  // =========================================================================

  describe("status badges", () => {
    it("shows 'Synced' badge (green) for healthy account", async () => {
      setupMockResponse();
      await renderAndWait();

      const row = screen.getByTestId("health-row-acc-google-work");
      const badge = within(row).getByTestId("health-badge");
      expect(badge).toHaveAttribute("data-badge", "synced");
      expect(badge).toHaveTextContent("Synced");
    });

    it("shows 'Syncing' badge (blue pulse) for actively syncing account", async () => {
      setupMockResponse();
      await renderAndWait();

      const row = screen.getByTestId("health-row-acc-google-personal");
      const badge = within(row).getByTestId("health-badge");
      expect(badge).toHaveAttribute("data-badge", "syncing");
      expect(badge).toHaveTextContent("Syncing");
    });

    it("shows 'Error' badge (red) for error account", async () => {
      setupMockResponse();
      await renderAndWait();

      const row = screen.getByTestId("health-row-acc-ms-outlook");
      const badge = within(row).getByTestId("health-badge");
      expect(badge).toHaveAttribute("data-badge", "error");
      expect(badge).toHaveTextContent("Error");
    });

    it("shows 'Stale' badge (yellow) for stale account (>1 hour)", async () => {
      const staleResponse: AccountsHealthResponse = {
        accounts: [{
          ...MOCK_ACCOUNTS[0],
          account_id: "acc-stale",
          last_successful_sync: new Date(NOW - 2 * 60 * 60 * 1000).toISOString(), // 2 hours ago
        }],
        account_count: 1,
        tier_limit: 5,
      };
      setupMockResponse(staleResponse);
      await renderAndWait();

      const row = screen.getByTestId("health-row-acc-stale");
      const badge = within(row).getByTestId("health-badge");
      expect(badge).toHaveAttribute("data-badge", "stale");
      expect(badge).toHaveTextContent("Stale");
    });
  });

  // =========================================================================
  // Unit: Error remediation guidance (AC2)
  // =========================================================================

  describe("error remediation guidance", () => {
    it("shows human-readable remediation for token errors", async () => {
      setupMockResponse();
      await renderAndWait();

      const row = screen.getByTestId("health-row-acc-ms-outlook");
      const guidance = within(row).getByTestId("remediation-guidance");
      expect(guidance).toBeInTheDocument();
      expect(guidance.textContent).toContain("expired");
      expect(guidance.textContent).toContain("Reconnect");
    });

    it("does not show remediation for healthy accounts", async () => {
      setupMockResponse();
      await renderAndWait();

      const row = screen.getByTestId("health-row-acc-google-work");
      expect(within(row).queryByTestId("remediation-guidance")).not.toBeInTheDocument();
    });
  });

  // =========================================================================
  // Integration: Reconnect flow (AC3)
  // =========================================================================

  describe("reconnect flow", () => {
    it("shows reconnect button for error accounts", async () => {
      setupMockResponse();
      await renderAndWait();

      const row = screen.getByTestId("health-row-acc-ms-outlook");
      expect(within(row).getByTestId("reconnect-btn")).toBeInTheDocument();
    });

    it("reconnect triggers provider-specific re-auth flow", async () => {
      setupMockResponse();
      await renderAndWait();

      const row = screen.getByTestId("health-row-acc-ms-outlook");
      fireEvent.click(within(row).getByTestId("reconnect-btn"));

      expect(mockLocationAssign).toHaveBeenCalledTimes(1);
      expect(mockLocationAssign).toHaveBeenCalledWith(
        expect.stringContaining("microsoft"),
      );
    });

    it("reconnect button is also available on non-error accounts", async () => {
      setupMockResponse();
      await renderAndWait();

      const row = screen.getByTestId("health-row-acc-google-work");
      expect(within(row).getByTestId("reconnect-btn")).toBeInTheDocument();
    });
  });

  // =========================================================================
  // Integration: Remove account flow (AC4)
  // =========================================================================

  describe("remove account flow", () => {
    it("shows remove button for each account", async () => {
      setupMockResponse();
      await renderAndWait();

      const row = screen.getByTestId("health-row-acc-google-work");
      expect(within(row).getByTestId("remove-btn")).toBeInTheDocument();
    });

    it("shows confirmation dialog when remove is clicked", async () => {
      setupMockResponse();
      await renderAndWait();

      expect(screen.queryByTestId("remove-dialog")).not.toBeInTheDocument();

      const row = screen.getByTestId("health-row-acc-google-work");
      fireEvent.click(within(row).getByTestId("remove-btn"));

      expect(screen.getByTestId("remove-dialog")).toBeInTheDocument();
    });

    it("confirmation dialog shows account email", async () => {
      setupMockResponse();
      await renderAndWait();

      const row = screen.getByTestId("health-row-acc-google-work");
      fireEvent.click(within(row).getByTestId("remove-btn"));

      const dialog = screen.getByTestId("remove-dialog");
      expect(within(dialog).getByText(/work@gmail\.com/)).toBeInTheDocument();
    });

    it("confirm remove calls removeAccount with correct ID", async () => {
      setupMockResponse();
      await renderAndWait();

      const row = screen.getByTestId("health-row-acc-google-work");
      fireEvent.click(within(row).getByTestId("remove-btn"));
      fireEvent.click(screen.getByTestId("remove-confirm"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(mockRemoveAccount).toHaveBeenCalledTimes(1);
      expect(mockRemoveAccount).toHaveBeenCalledWith("acc-google-work");
    });

    it("account is removed from list after successful removal", async () => {
      setupMockResponse();
      await renderAndWait();

      expect(screen.getByText("work@gmail.com")).toBeInTheDocument();

      const row = screen.getByTestId("health-row-acc-google-work");
      fireEvent.click(within(row).getByTestId("remove-btn"));
      fireEvent.click(screen.getByTestId("remove-confirm"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.queryByText("work@gmail.com")).not.toBeInTheDocument();
    });

    it("cancel does not remove the account", async () => {
      setupMockResponse();
      await renderAndWait();

      const row = screen.getByTestId("health-row-acc-google-work");
      fireEvent.click(within(row).getByTestId("remove-btn"));
      fireEvent.click(screen.getByTestId("remove-cancel"));

      expect(mockRemoveAccount).not.toHaveBeenCalled();
      expect(screen.getByText("work@gmail.com")).toBeInTheDocument();
    });

    it("shows error message when remove fails", async () => {
      mockRemoveAccount.mockRejectedValue(new Error("Server error"));
      setupMockResponse();
      await renderAndWait();

      const row = screen.getByTestId("health-row-acc-google-work");
      fireEvent.click(within(row).getByTestId("remove-btn"));
      fireEvent.click(screen.getByTestId("remove-confirm"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      const status = screen.getByTestId("health-status-msg");
      expect(status).toHaveAttribute("data-status-type", "error");
      expect(status.textContent).toContain("Server error");
    });
  });

  // =========================================================================
  // Integration: Sync history (AC5)
  // =========================================================================

  describe("sync history", () => {
    it("shows sync history when account is expanded", async () => {
      setupMockResponse();
      await renderAndWait();

      // Expand the first account
      const row = screen.getByTestId("health-row-acc-google-work");
      fireEvent.click(within(row).getByTestId("expand-btn"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(mockFetchSyncHistory).toHaveBeenCalledWith("acc-google-work");
      expect(screen.getByTestId("sync-history")).toBeInTheDocument();
    });

    it("displays last 10 sync events with timestamps and event counts", async () => {
      setupMockResponse();
      await renderAndWait();

      // Expand the first account
      const row = screen.getByTestId("health-row-acc-google-work");
      fireEvent.click(within(row).getByTestId("expand-btn"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      const history = screen.getByTestId("sync-history");
      const entries = within(history).getAllByTestId("sync-history-entry");
      expect(entries.length).toBe(10);
    });

    it("shows event count for each sync history entry", async () => {
      setupMockResponse();
      await renderAndWait();

      const row = screen.getByTestId("health-row-acc-google-work");
      fireEvent.click(within(row).getByTestId("expand-btn"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      const history = screen.getByTestId("sync-history");
      const firstEntry = within(history).getAllByTestId("sync-history-entry")[0];
      expect(firstEntry).toHaveTextContent("12");
    });

    it("shows error indicator for failed sync entries", async () => {
      setupMockResponse();
      await renderAndWait();

      const row = screen.getByTestId("health-row-acc-google-work");
      fireEvent.click(within(row).getByTestId("expand-btn"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      const history = screen.getByTestId("sync-history");
      const entries = within(history).getAllByTestId("sync-history-entry");
      // Third entry (index 2) is the error one
      const errorEntry = entries[2];
      expect(within(errorEntry).getByTestId("sync-entry-status")).toHaveAttribute("data-status", "error");
    });
  });

  // =========================================================================
  // Integration: Token info display (AC2 -- without exposing tokens)
  // =========================================================================

  describe("token info in detail view", () => {
    it("shows token expiry info when account is expanded", async () => {
      setupMockResponse();
      await renderAndWait();

      const row = screen.getByTestId("health-row-acc-google-work");
      fireEvent.click(within(row).getByTestId("expand-btn"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      const detail = screen.getByTestId("account-detail");
      expect(within(detail).getByTestId("token-expiry")).toHaveTextContent("Expires in 1h");
    });

    it("shows 'Expired' for expired tokens", async () => {
      const expiredResponse: AccountsHealthResponse = {
        accounts: [{
          ...MOCK_ACCOUNTS[0],
          account_id: "acc-expired",
          token_expires_at: new Date(NOW - 5 * 60 * 1000).toISOString(),
        }],
        account_count: 1,
        tier_limit: 5,
      };
      setupMockResponse(expiredResponse);
      await renderAndWait();

      const row = screen.getByTestId("health-row-acc-expired");
      fireEvent.click(within(row).getByTestId("expand-btn"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      const detail = screen.getByTestId("account-detail");
      expect(within(detail).getByTestId("token-expiry")).toHaveTextContent("Expired");
    });
  });

  // =========================================================================
  // Integration: Loading, error, empty states
  // =========================================================================

  describe("loading state", () => {
    it("shows loading indicator while fetching", () => {
      mockFetchAccountsHealth.mockReturnValue(new Promise(() => {}));
      render(<ProviderHealth />);

      expect(screen.getByTestId("health-loading")).toBeInTheDocument();
    });
  });

  describe("error state", () => {
    it("shows error message on fetch failure", async () => {
      setupFailingResponse("API unavailable");
      await renderAndWait();

      expect(screen.getByTestId("health-error")).toBeInTheDocument();
      expect(screen.getByText(/api unavailable/i)).toBeInTheDocument();
    });

    it("shows retry button on error", async () => {
      setupFailingResponse();
      await renderAndWait();

      expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    });
  });

  describe("empty state", () => {
    it("shows empty message when no accounts", async () => {
      const emptyResponse: AccountsHealthResponse = {
        accounts: [],
        account_count: 0,
        tier_limit: 5,
      };
      setupMockResponse(emptyResponse);
      await renderAndWait();

      expect(screen.getByTestId("health-empty")).toBeInTheDocument();
    });
  });

  // =========================================================================
  // Performance (AC7): Dashboard loads quickly
  // =========================================================================

  describe("auto-refresh", () => {
    it("fetches data on mount", async () => {
      setupMockResponse();
      await renderAndWait();

      expect(mockFetchAccountsHealth).toHaveBeenCalledTimes(1);
    });
  });
});
