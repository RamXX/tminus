/**
 * Tests for the Accounts management page.
 *
 * Covers:
 * - Unit: account list rendering, status indicators, unlink confirmation dialog,
 *   OAuth redirect URL construction
 * - Integration: component renders accounts from API, Link Account redirects to
 *   OAuth URL, Unlink flow (dialog -> confirm -> DELETE API called -> removed),
 *   OAuth callback handling, error/loading/empty states
 *
 * Uses React Testing Library with fireEvent for click interactions.
 *
 * NOTE: We use fireEvent.click instead of userEvent.click because this component
 * uses timers (status auto-clear via setTimeout) that interact poorly with
 * userEvent's internal delay mechanism under fake timers.
 * fireEvent dispatches events synchronously, avoiding the timer conflict.
 *
 * Since Accounts now uses useApi() + useAuth() internally, tests wrap the
 * component in AuthProvider + ApiProvider and mock the underlying API module.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, act, fireEvent } from "@testing-library/react";
import { Accounts } from "./Accounts";
import type { LinkedAccount, AccountScopesResponse, ScopeUpdateItem } from "../lib/api";
import {
  buildOAuthStartUrl,
  statusColor,
  statusLabel,
  statusSymbol,
  providerLabel,
  OAUTH_BASE_URL,
} from "../lib/accounts";

// ---------------------------------------------------------------------------
// Mock the API module -- all API calls go through the provider
// ---------------------------------------------------------------------------

const mockFetchAccounts = vi.fn<() => Promise<LinkedAccount[]>>().mockResolvedValue([]);
const mockUnlinkAccount = vi.fn<(accountId: string) => Promise<void>>().mockResolvedValue(undefined);
const mockFetchScopes = vi.fn<(accountId: string) => Promise<AccountScopesResponse>>().mockResolvedValue({ account_id: "", provider: "google", scopes: [] });
const mockUpdateScopes = vi.fn<(accountId: string, scopes: ScopeUpdateItem[]) => Promise<AccountScopesResponse>>().mockResolvedValue({ account_id: "", provider: "google", scopes: [] });
const mockFetchSyncStatus = vi.fn().mockResolvedValue({ accounts: [] });

// Mock useApi to return our test functions -- stable object reference to
// avoid re-renders from dependency array changes
const mockApiValue = {
  fetchAccounts: mockFetchAccounts,
  unlinkAccount: mockUnlinkAccount,
  fetchScopes: mockFetchScopes,
  updateScopes: mockUpdateScopes,
  fetchSyncStatus: mockFetchSyncStatus,
};

vi.mock("../lib/api-provider", () => ({
  useApi: () => mockApiValue,
  ApiProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// Mock useAuth to return a test user
vi.mock("../lib/auth", () => ({
  useAuth: () => ({
    token: "test-jwt-token",
    refreshToken: "test-refresh-token",
    user: { id: "usr_test_123", email: "test@example.com" },
    login: vi.fn(),
    logout: vi.fn(),
  }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// Mock navigateToOAuth from the accounts module to prevent actual navigation
const mockNavigateToOAuth = vi.fn();
vi.mock("../lib/accounts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/accounts")>();
  return {
    ...actual,
    navigateToOAuth: (...args: unknown[]) => mockNavigateToOAuth(...args),
  };
});

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const MOCK_ACCOUNTS: LinkedAccount[] = [
  {
    account_id: "acc-google-work",
    email: "work@gmail.com",
    provider: "google",
    status: "active",
  },
  {
    account_id: "acc-google-personal",
    email: "personal@gmail.com",
    provider: "google",
    status: "error",
  },
  {
    account_id: "acc-ms-outlook",
    email: "user@outlook.com",
    provider: "microsoft",
    status: "revoked",
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Render the Accounts component and wait for the initial async fetch to resolve.
 */
async function renderAndWait(
  overrides: {
    accounts?: LinkedAccount[];
    fetchError?: string;
  } = {},
) {
  if (overrides.fetchError) {
    mockFetchAccounts.mockRejectedValueOnce(new Error(overrides.fetchError));
  } else {
    mockFetchAccounts.mockResolvedValueOnce(overrides.accounts ?? MOCK_ACCOUNTS);
  }

  const result = render(<Accounts />);

  // Flush microtasks so async fetch resolves
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });

  return result;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Accounts Page", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-02-14T12:00:00Z").getTime() });
    // Reset hash to clean state
    window.location.hash = "#/accounts";
    mockFetchAccounts.mockReset().mockResolvedValue([]);
    mockUnlinkAccount.mockReset().mockResolvedValue(undefined);
    mockFetchScopes.mockReset().mockResolvedValue({ account_id: "", provider: "google", scopes: [] });
    mockUpdateScopes.mockReset().mockResolvedValue({ account_id: "", provider: "google", scopes: [] });
    mockNavigateToOAuth.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    window.location.hash = "";
  });

  // =========================================================================
  // Unit Tests: Account List Rendering
  // =========================================================================

  describe("account list rendering", () => {
    it("renders all account emails in the list", async () => {
      await renderAndWait();

      expect(screen.getByText("work@gmail.com")).toBeInTheDocument();
      expect(screen.getByText("personal@gmail.com")).toBeInTheDocument();
      expect(screen.getByText("user@outlook.com")).toBeInTheDocument();
    });

    it("renders provider labels for each account", async () => {
      await renderAndWait();

      // Two Google accounts and one Microsoft
      const providerCells = screen.getAllByTestId("account-provider");
      const labels = providerCells.map((el) => el.textContent);
      expect(labels).toContain("Google");
      expect(labels).toContain("Microsoft");
    });

    it("renders status indicator for each account", async () => {
      await renderAndWait();

      const indicators = screen.getAllByTestId("account-status-indicator");
      expect(indicators.length).toBe(3);
    });

    it("shows correct status for active account", async () => {
      await renderAndWait();

      const workRow = screen.getByTestId("account-row-acc-google-work");
      const indicator = within(workRow).getByTestId(
        "account-status-indicator",
      );
      expect(indicator).toHaveAttribute("data-status", "active");

      const label = within(workRow).getByTestId("account-status-label");
      expect(label.textContent).toBe("Active");
    });

    it("shows correct status for error account", async () => {
      await renderAndWait();

      const personalRow = screen.getByTestId(
        "account-row-acc-google-personal",
      );
      const indicator = within(personalRow).getByTestId(
        "account-status-indicator",
      );
      expect(indicator).toHaveAttribute("data-status", "error");

      const label = within(personalRow).getByTestId("account-status-label");
      expect(label.textContent).toBe("Error");
    });

    it("shows correct status for revoked account", async () => {
      await renderAndWait();

      const msRow = screen.getByTestId("account-row-acc-ms-outlook");
      const indicator = within(msRow).getByTestId("account-status-indicator");
      expect(indicator).toHaveAttribute("data-status", "revoked");

      const label = within(msRow).getByTestId("account-status-label");
      expect(label.textContent).toBe("Revoked");
    });

    it("renders an unlink button for each account", async () => {
      await renderAndWait();

      expect(
        screen.getByTestId("unlink-btn-acc-google-work"),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId("unlink-btn-acc-google-personal"),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId("unlink-btn-acc-ms-outlook"),
      ).toBeInTheDocument();
    });

    it("renders accounts table with correct headers", async () => {
      await renderAndWait();

      const table = screen.getByTestId("accounts-table");
      expect(within(table).getByText("Status")).toBeInTheDocument();
      expect(within(table).getByText("Email")).toBeInTheDocument();
      expect(within(table).getByText("Provider")).toBeInTheDocument();
      expect(within(table).getByText("Actions")).toBeInTheDocument();
    });
  });

  // =========================================================================
  // Unit Tests: OAuth Redirect URL Construction
  // =========================================================================

  describe("OAuth URL construction", () => {
    it("builds correct Google OAuth start URL", () => {
      const url = buildOAuthStartUrl("google", "usr_test_123");
      expect(url).toBe(
        "https://oauth.tminus.ink/oauth/google/start?user_id=usr_test_123&redirect_uri=https%3A%2F%2Fapp.tminus.ink%2F%23%2Faccounts%3Flinked%3Dtrue",
      );
    });

    it("builds correct Microsoft OAuth start URL", () => {
      const url = buildOAuthStartUrl("microsoft", "usr_test_123");
      expect(url).toBe(
        "https://oauth.tminus.ink/oauth/microsoft/start?user_id=usr_test_123&redirect_uri=https%3A%2F%2Fapp.tminus.ink%2F%23%2Faccounts%3Flinked%3Dtrue",
      );
    });

    it("OAuth base URL is oauth.tminus.ink", () => {
      expect(OAUTH_BASE_URL).toBe("https://oauth.tminus.ink");
    });
  });

  // =========================================================================
  // Unit Tests: Status Display Helpers
  // =========================================================================

  describe("status display helpers", () => {
    it("statusColor returns green for active", () => {
      expect(statusColor("active")).toBe("#16a34a");
    });

    it("statusColor returns red for error", () => {
      expect(statusColor("error")).toBe("#dc2626");
    });

    it("statusColor returns gray for revoked", () => {
      expect(statusColor("revoked")).toBe("#64748b");
    });

    it("statusColor returns yellow for pending", () => {
      expect(statusColor("pending")).toBe("#ca8a04");
    });

    it("statusLabel returns human-readable labels", () => {
      expect(statusLabel("active")).toBe("Active");
      expect(statusLabel("error")).toBe("Error");
      expect(statusLabel("revoked")).toBe("Revoked");
      expect(statusLabel("pending")).toBe("Pending");
    });

    it("statusSymbol returns Unicode symbols", () => {
      expect(statusSymbol("active")).toBe("\u25CF");
      expect(statusSymbol("error")).toBe("\u2716");
    });

    it("providerLabel returns formatted provider names", () => {
      expect(providerLabel("google")).toBe("Google");
      expect(providerLabel("microsoft")).toBe("Microsoft");
    });
  });

  // =========================================================================
  // Unit Tests: Unlink Confirmation Dialog
  // =========================================================================

  describe("unlink confirmation dialog", () => {
    it("shows dialog when unlink button is clicked", async () => {
      await renderAndWait();

      // No dialog initially
      expect(screen.queryByTestId("unlink-dialog")).not.toBeInTheDocument();

      // Click unlink on first account
      fireEvent.click(screen.getByTestId("unlink-btn-acc-google-work"));

      // Dialog appears
      expect(screen.getByTestId("unlink-dialog")).toBeInTheDocument();
    });

    it("dialog shows the account email being unlinked", async () => {
      await renderAndWait();

      fireEvent.click(screen.getByTestId("unlink-btn-acc-google-work"));

      const dialog = screen.getByTestId("unlink-dialog");
      expect(within(dialog).getByText(/work@gmail\.com/)).toBeInTheDocument();
    });

    it("dialog shows the provider being unlinked", async () => {
      await renderAndWait();

      fireEvent.click(screen.getByTestId("unlink-btn-acc-ms-outlook"));

      const dialog = screen.getByTestId("unlink-dialog");
      expect(within(dialog).getByText(/Microsoft/)).toBeInTheDocument();
    });

    it("dialog has Cancel and Unlink buttons", async () => {
      await renderAndWait();

      fireEvent.click(screen.getByTestId("unlink-btn-acc-google-work"));

      expect(screen.getByTestId("unlink-cancel")).toBeInTheDocument();
      expect(screen.getByTestId("unlink-confirm")).toBeInTheDocument();
    });

    it("Cancel button closes the dialog", async () => {
      await renderAndWait();

      fireEvent.click(screen.getByTestId("unlink-btn-acc-google-work"));
      expect(screen.getByTestId("unlink-dialog")).toBeInTheDocument();

      fireEvent.click(screen.getByTestId("unlink-cancel"));
      expect(screen.queryByTestId("unlink-dialog")).not.toBeInTheDocument();
    });

    it("dialog has role=dialog and aria-modal=true", async () => {
      await renderAndWait();

      fireEvent.click(screen.getByTestId("unlink-btn-acc-google-work"));

      const dialog = screen.getByRole("dialog");
      expect(dialog).toHaveAttribute("aria-modal", "true");
    });

    it("dialog includes a warning about consequences", async () => {
      await renderAndWait();

      fireEvent.click(screen.getByTestId("unlink-btn-acc-google-work"));

      const dialog = screen.getByTestId("unlink-dialog");
      expect(
        within(dialog).getByText(/stop syncing/i),
      ).toBeInTheDocument();
    });
  });

  // =========================================================================
  // Integration Tests: Component Renders Accounts from API
  // =========================================================================

  describe("integration: fetch accounts from API", () => {
    it("calls fetchAccounts on mount", async () => {
      await renderAndWait();

      expect(mockFetchAccounts).toHaveBeenCalledTimes(1);
    });

    it("renders fetched accounts in the table", async () => {
      await renderAndWait();

      const table = screen.getByTestId("accounts-table");
      expect(within(table).getByText("work@gmail.com")).toBeInTheDocument();
      expect(
        within(table).getByText("personal@gmail.com"),
      ).toBeInTheDocument();
      expect(within(table).getByText("user@outlook.com")).toBeInTheDocument();
    });

    it("shows empty state when API returns no accounts", async () => {
      await renderAndWait({ accounts: [] });

      expect(screen.getByTestId("accounts-empty")).toBeInTheDocument();
      expect(screen.getByText(/no accounts linked/i)).toBeInTheDocument();
    });

    it("shows loading state before fetch completes", () => {
      mockFetchAccounts.mockReturnValue(new Promise(() => {}));
      render(<Accounts />);

      expect(screen.getByTestId("accounts-loading")).toBeInTheDocument();
    });

    it("shows error state when fetch fails", async () => {
      await renderAndWait({ fetchError: "API unavailable" });

      expect(screen.getByTestId("accounts-error")).toBeInTheDocument();
      expect(screen.getByText(/api unavailable/i)).toBeInTheDocument();
    });

    it("shows retry button on error", async () => {
      await renderAndWait({ fetchError: "Network error" });

      expect(
        screen.getByRole("button", { name: /retry/i }),
      ).toBeInTheDocument();
    });

    it("retry button refetches accounts", async () => {
      await renderAndWait({ fetchError: "Network error" });

      expect(mockFetchAccounts).toHaveBeenCalledTimes(1);

      // Set up success response for retry
      mockFetchAccounts.mockResolvedValueOnce(MOCK_ACCOUNTS);
      fireEvent.click(screen.getByRole("button", { name: /retry/i }));

      // Flush microtasks
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(mockFetchAccounts).toHaveBeenCalledTimes(2);
    });
  });

  // =========================================================================
  // Integration Tests: Link Account -> OAuth Redirect
  // =========================================================================

  describe("integration: link account OAuth flow", () => {
    it("Link Google Account redirects to Google OAuth URL", async () => {
      await renderAndWait();

      fireEvent.click(screen.getByTestId("link-google"));

      expect(mockNavigateToOAuth).toHaveBeenCalledTimes(1);
      expect(mockNavigateToOAuth).toHaveBeenCalledWith(
        "https://oauth.tminus.ink/oauth/google/start?user_id=usr_test_123&redirect_uri=https%3A%2F%2Fapp.tminus.ink%2F%23%2Faccounts%3Flinked%3Dtrue",
      );
    });

    it("Link Microsoft Account redirects to Microsoft OAuth URL", async () => {
      await renderAndWait();

      fireEvent.click(screen.getByTestId("link-microsoft"));

      expect(mockNavigateToOAuth).toHaveBeenCalledTimes(1);
      expect(mockNavigateToOAuth).toHaveBeenCalledWith(
        "https://oauth.tminus.ink/oauth/microsoft/start?user_id=usr_test_123&redirect_uri=https%3A%2F%2Fapp.tminus.ink%2F%23%2Faccounts%3Flinked%3Dtrue",
      );
    });

    it("both link buttons are visible", async () => {
      await renderAndWait();

      const section = screen.getByTestId("link-account-section");
      expect(
        within(section).getByText("Link Google Account"),
      ).toBeInTheDocument();
      expect(
        within(section).getByText("Link Microsoft Account"),
      ).toBeInTheDocument();
    });

    it("link buttons are present even when no accounts exist", async () => {
      await renderAndWait({ accounts: [] });

      expect(screen.getByTestId("link-google")).toBeInTheDocument();
      expect(screen.getByTestId("link-microsoft")).toBeInTheDocument();
    });
  });

  // =========================================================================
  // Integration Tests: Unlink Account Flow
  // =========================================================================

  describe("integration: unlink account flow", () => {
    it("confirm unlink calls unlinkAccount with correct ID", async () => {
      await renderAndWait();

      // Click unlink on first account
      fireEvent.click(screen.getByTestId("unlink-btn-acc-google-work"));

      // Confirm in dialog
      fireEvent.click(screen.getByTestId("unlink-confirm"));

      // Wait for async unlink to complete
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(mockUnlinkAccount).toHaveBeenCalledTimes(1);
      expect(mockUnlinkAccount).toHaveBeenCalledWith("acc-google-work");
    });

    it("account is removed from list after successful unlink", async () => {
      await renderAndWait();

      // Verify account is in the list
      expect(screen.getByText("work@gmail.com")).toBeInTheDocument();

      // Unlink the account
      fireEvent.click(screen.getByTestId("unlink-btn-acc-google-work"));
      fireEvent.click(screen.getByTestId("unlink-confirm"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      // Account should be removed
      expect(screen.queryByText("work@gmail.com")).not.toBeInTheDocument();

      // Other accounts should remain
      expect(screen.getByText("personal@gmail.com")).toBeInTheDocument();
      expect(screen.getByText("user@outlook.com")).toBeInTheDocument();
    });

    it("dialog closes after successful unlink", async () => {
      await renderAndWait();

      fireEvent.click(screen.getByTestId("unlink-btn-acc-google-work"));
      expect(screen.getByTestId("unlink-dialog")).toBeInTheDocument();

      fireEvent.click(screen.getByTestId("unlink-confirm"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.queryByTestId("unlink-dialog")).not.toBeInTheDocument();
    });

    it("shows success message after unlink", async () => {
      await renderAndWait();

      fireEvent.click(screen.getByTestId("unlink-btn-acc-google-work"));
      fireEvent.click(screen.getByTestId("unlink-confirm"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      const status = screen.getByTestId("accounts-status");
      expect(status).toHaveAttribute("data-status-type", "success");
      expect(status.textContent).toContain("unlinked");
    });

    it("shows error message when unlink fails", async () => {
      mockUnlinkAccount.mockRejectedValueOnce(new Error("Server error"));
      await renderAndWait();

      fireEvent.click(screen.getByTestId("unlink-btn-acc-google-work"));
      fireEvent.click(screen.getByTestId("unlink-confirm"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      const status = screen.getByTestId("accounts-status");
      expect(status).toHaveAttribute("data-status-type", "error");
      expect(status.textContent).toContain("Server error");
    });

    it("account remains in list when unlink fails", async () => {
      mockUnlinkAccount.mockRejectedValueOnce(new Error("Server error"));
      await renderAndWait();

      fireEvent.click(screen.getByTestId("unlink-btn-acc-google-work"));
      fireEvent.click(screen.getByTestId("unlink-confirm"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      // Account should still be in the table
      const table = screen.getByTestId("accounts-table");
      expect(within(table).getByText("work@gmail.com")).toBeInTheDocument();
    });

    it("cancel does NOT call unlinkAccount", async () => {
      await renderAndWait();

      fireEvent.click(screen.getByTestId("unlink-btn-acc-google-work"));
      fireEvent.click(screen.getByTestId("unlink-cancel"));

      expect(mockUnlinkAccount).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Integration Tests: OAuth Callback Redirect Handling
  // =========================================================================

  describe("integration: OAuth callback handling", () => {
    it("shows success message on linked=true callback", async () => {
      window.location.hash = "#/accounts?linked=true";

      await renderAndWait();

      const status = screen.getByTestId("accounts-status");
      expect(status).toHaveAttribute("data-status-type", "success");
      expect(status.textContent).toContain("linked successfully");
    });

    it("shows error message on error callback", async () => {
      window.location.hash = "#/accounts?error=access_denied";

      await renderAndWait();

      const status = screen.getByTestId("accounts-status");
      expect(status).toHaveAttribute("data-status-type", "error");
      expect(status.textContent).toContain("access_denied");
    });

    it("status message auto-clears after 4 seconds", async () => {
      window.location.hash = "#/accounts?linked=true";

      await renderAndWait();

      // Status visible initially
      expect(screen.getByTestId("accounts-status")).toBeInTheDocument();

      // Advance past auto-clear timeout
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4100);
      });

      expect(screen.queryByTestId("accounts-status")).not.toBeInTheDocument();
    });
  });

  // =========================================================================
  // Integration Tests: Pending account status
  // =========================================================================

  describe("integration: pending account status", () => {
    it("renders pending status correctly", async () => {
      const pendingAccount: LinkedAccount = {
        account_id: "acc-pending",
        email: "pending@gmail.com",
        provider: "google",
        status: "pending",
      };
      await renderAndWait({ accounts: [pendingAccount] });

      const row = screen.getByTestId("account-row-acc-pending");
      const indicator = within(row).getByTestId("account-status-indicator");
      expect(indicator).toHaveAttribute("data-status", "pending");

      const label = within(row).getByTestId("account-status-label");
      expect(label.textContent).toBe("Pending");
    });
  });

  // -----------------------------------------------------------------------
  // Calendar scope management (TM-8gfd.2)
  // -----------------------------------------------------------------------

  describe("Calendar Scope Management", () => {
    const MOCK_SCOPES_RESPONSE: AccountScopesResponse = {
      account_id: "acc-google-work",
      provider: "google",
      scopes: [
        {
          scope_id: "cal_01",
          provider_calendar_id: "primary",
          display_name: "Main Calendar",
          calendar_role: "owner",
          access_level: "owner",
          capabilities: ["read", "write"],
          enabled: true,
          sync_enabled: true,
          recommended: true,
        },
        {
          scope_id: "cal_02",
          provider_calendar_id: "shared-team@group.calendar.google.com",
          display_name: "Team Calendar",
          calendar_role: "editor",
          access_level: "editor",
          capabilities: ["read", "write"],
          enabled: true,
          sync_enabled: false,
          recommended: false,
        },
        {
          scope_id: "cal_03",
          provider_calendar_id: "holidays@calendar.google.com",
          display_name: "Holidays",
          calendar_role: "reader",
          access_level: "readonly",
          capabilities: ["read"],
          enabled: false,
          sync_enabled: false,
          recommended: false,
        },
      ],
    };

    it("shows Scopes button for each account", async () => {
      await renderAndWait();

      // There should be a Scopes button for each account row
      const scopeBtn = screen.getByTestId("scopes-btn-acc-google-work");
      expect(scopeBtn).toBeInTheDocument();
      expect(scopeBtn.textContent).toBe("Scopes");
    });

    it("opens scope dialog when Scopes button is clicked", async () => {
      mockFetchScopes.mockResolvedValueOnce(MOCK_SCOPES_RESPONSE);
      await renderAndWait();

      const scopeBtn = screen.getByTestId("scopes-btn-acc-google-work");

      await act(async () => {
        fireEvent.click(scopeBtn);
        await vi.advanceTimersByTimeAsync(0);
      });

      const dialog = screen.getByTestId("scopes-dialog");
      expect(dialog).toBeInTheDocument();
      expect(mockFetchScopes).toHaveBeenCalledWith("acc-google-work");
    });

    it("renders scope rows with capability metadata", async () => {
      mockFetchScopes.mockResolvedValueOnce(MOCK_SCOPES_RESPONSE);
      await renderAndWait();

      await act(async () => {
        fireEvent.click(screen.getByTestId("scopes-btn-acc-google-work"));
        await vi.advanceTimersByTimeAsync(0);
      });

      // Verify all scope rows are rendered
      expect(screen.getByTestId("scope-row-primary")).toBeInTheDocument();
      expect(
        screen.getByTestId(
          "scope-row-shared-team@group.calendar.google.com",
        ),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId("scope-row-holidays@calendar.google.com"),
      ).toBeInTheDocument();

      // Verify primary shows recommended
      const primaryRow = screen.getByTestId("scope-row-primary");
      expect(primaryRow.textContent).toContain("Main Calendar");
      expect(primaryRow.textContent).toContain("(recommended)");
      expect(primaryRow.textContent).toContain("read, write");
    });

    it("disables sync checkbox for read-only calendars", async () => {
      mockFetchScopes.mockResolvedValueOnce(MOCK_SCOPES_RESPONSE);
      await renderAndWait();

      await act(async () => {
        fireEvent.click(screen.getByTestId("scopes-btn-acc-google-work"));
        await vi.advanceTimersByTimeAsync(0);
      });

      // Holidays calendar is readonly -- sync checkbox should be disabled
      const syncCheckbox = screen.getByTestId(
        "scope-sync-holidays@calendar.google.com",
      ) as HTMLInputElement;
      expect(syncCheckbox.disabled).toBe(true);

      // Primary calendar is owner -- sync checkbox should be enabled
      const primarySync = screen.getByTestId(
        "scope-sync-primary",
      ) as HTMLInputElement;
      expect(primarySync.disabled).toBe(false);
    });

    it("shows Save button only when changes are pending", async () => {
      mockFetchScopes.mockResolvedValueOnce(MOCK_SCOPES_RESPONSE);
      await renderAndWait();

      await act(async () => {
        fireEvent.click(screen.getByTestId("scopes-btn-acc-google-work"));
        await vi.advanceTimersByTimeAsync(0);
      });

      // No save button yet -- no changes
      expect(screen.queryByTestId("scopes-save")).not.toBeInTheDocument();
      // Close button should say "Close"
      expect(screen.getByTestId("scopes-cancel").textContent).toBe("Close");

      // Toggle a scope
      await act(async () => {
        const enabledCheckbox = screen.getByTestId(
          "scope-enabled-holidays@calendar.google.com",
        );
        fireEvent.click(enabledCheckbox);
      });

      // Save button should now appear
      expect(screen.getByTestId("scopes-save")).toBeInTheDocument();
      // Cancel button should say "Cancel"
      expect(screen.getByTestId("scopes-cancel").textContent).toBe("Cancel");
    });

    it("calls updateScopes and shows success message on save", async () => {
      mockFetchScopes.mockResolvedValueOnce(MOCK_SCOPES_RESPONSE);
      mockUpdateScopes.mockResolvedValueOnce(MOCK_SCOPES_RESPONSE);
      await renderAndWait();

      await act(async () => {
        fireEvent.click(screen.getByTestId("scopes-btn-acc-google-work"));
        await vi.advanceTimersByTimeAsync(0);
      });

      // Toggle sync for team calendar
      await act(async () => {
        fireEvent.click(
          screen.getByTestId(
            "scope-sync-shared-team@group.calendar.google.com",
          ),
        );
      });

      // Click save
      await act(async () => {
        fireEvent.click(screen.getByTestId("scopes-save"));
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(mockUpdateScopes).toHaveBeenCalledWith("acc-google-work", [
        {
          provider_calendar_id: "shared-team@group.calendar.google.com",
          sync_enabled: true,
        },
      ]);

      // Success message should appear
      const statusEl = screen.getByTestId("accounts-status");
      expect(statusEl.textContent).toContain("Calendar scopes updated");
    });

    it("closes scope dialog on cancel", async () => {
      mockFetchScopes.mockResolvedValueOnce(MOCK_SCOPES_RESPONSE);
      await renderAndWait();

      await act(async () => {
        fireEvent.click(screen.getByTestId("scopes-btn-acc-google-work"));
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.getByTestId("scopes-dialog")).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByTestId("scopes-cancel"));
      });

      expect(screen.queryByTestId("scopes-dialog")).not.toBeInTheDocument();
    });

    it("shows error message when scope fetch fails", async () => {
      mockFetchScopes.mockRejectedValueOnce(new Error("Scope fetch failed"));
      await renderAndWait();

      await act(async () => {
        fireEvent.click(screen.getByTestId("scopes-btn-acc-google-work"));
        await vi.advanceTimersByTimeAsync(0);
      });

      // Dialog should NOT be open (fetch failed)
      expect(screen.queryByTestId("scopes-dialog")).not.toBeInTheDocument();

      // Error status should be shown
      const statusEl = screen.getByTestId("accounts-status");
      expect(statusEl.textContent).toContain("Failed to load scopes");
    });

    it("scope dialog contains optional/skippable messaging", async () => {
      mockFetchScopes.mockResolvedValueOnce(MOCK_SCOPES_RESPONSE);
      await renderAndWait();

      await act(async () => {
        fireEvent.click(screen.getByTestId("scopes-btn-acc-google-work"));
        await vi.advanceTimersByTimeAsync(0);
      });

      const dialog = screen.getByTestId("scopes-dialog");
      // Verify the dialog mentions scope tuning is optional
      expect(dialog.textContent).toContain("optional");
    });
  });
});
