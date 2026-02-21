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
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, act, fireEvent } from "@testing-library/react";
import { Accounts, type AccountsProps } from "./Accounts";
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

function createMockFetch(accounts: LinkedAccount[] = MOCK_ACCOUNTS) {
  return vi.fn(async (): Promise<LinkedAccount[]> => accounts);
}

function createFailingFetch(message = "Network error") {
  return vi.fn(async (): Promise<LinkedAccount[]> => {
    throw new Error(message);
  });
}

function createMockUnlink() {
  return vi.fn(async (_accountId: string): Promise<void> => {});
}

function createFailingUnlink(message = "Unlink failed") {
  return vi.fn(async (_accountId: string): Promise<void> => {
    throw new Error(message);
  });
}

function createMockNavigate() {
  return vi.fn((_url: string) => {});
}

/**
 * Render the Accounts component and wait for the initial async fetch to resolve.
 */
async function renderAndWait(overrides: Partial<AccountsProps> = {}) {
  const fetchAccounts = overrides.fetchAccounts ?? createMockFetch();
  const unlinkAccount = overrides.unlinkAccount ?? createMockUnlink();
  const navigateToOAuth = overrides.navigateToOAuth ?? createMockNavigate();
  const fetchScopes = overrides.fetchScopes;
  const updateScopes = overrides.updateScopes;
  const currentUserId = overrides.currentUserId ?? "usr_test_123";

  const result = render(
    <Accounts
      currentUserId={currentUserId}
      fetchAccounts={fetchAccounts}
      unlinkAccount={unlinkAccount}
      navigateToOAuth={navigateToOAuth}
      fetchScopes={fetchScopes}
      updateScopes={updateScopes}
    />,
  );

  // Flush microtasks so async fetch resolves
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });

  return { ...result, fetchAccounts, unlinkAccount, navigateToOAuth, fetchScopes, updateScopes };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Accounts Page", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-02-14T12:00:00Z").getTime() });
    // Reset hash to clean state
    window.location.hash = "#/accounts";
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
      const fetchAccounts = createMockFetch();
      await renderAndWait({ fetchAccounts });

      expect(fetchAccounts).toHaveBeenCalledTimes(1);
    });

    it("renders fetched accounts in the table", async () => {
      const fetchAccounts = createMockFetch();
      await renderAndWait({ fetchAccounts });

      const table = screen.getByTestId("accounts-table");
      expect(within(table).getByText("work@gmail.com")).toBeInTheDocument();
      expect(
        within(table).getByText("personal@gmail.com"),
      ).toBeInTheDocument();
      expect(within(table).getByText("user@outlook.com")).toBeInTheDocument();
    });

    it("shows empty state when API returns no accounts", async () => {
      const fetchAccounts = createMockFetch([]);
      await renderAndWait({ fetchAccounts });

      expect(screen.getByTestId("accounts-empty")).toBeInTheDocument();
      expect(screen.getByText(/no accounts linked/i)).toBeInTheDocument();
    });

    it("shows loading state before fetch completes", () => {
      const fetchAccounts = vi.fn(
        (): Promise<LinkedAccount[]> => new Promise(() => {}),
      );
      render(
        <Accounts
          currentUserId="usr_test_123"
          fetchAccounts={fetchAccounts}
          unlinkAccount={createMockUnlink()}
          navigateToOAuth={createMockNavigate()}
        />,
      );

      expect(screen.getByTestId("accounts-loading")).toBeInTheDocument();
    });

    it("shows error state when fetch fails", async () => {
      const fetchAccounts = createFailingFetch("API unavailable");
      await renderAndWait({ fetchAccounts });

      expect(screen.getByTestId("accounts-error")).toBeInTheDocument();
      expect(screen.getByText(/api unavailable/i)).toBeInTheDocument();
    });

    it("shows retry button on error", async () => {
      const fetchAccounts = createFailingFetch();
      await renderAndWait({ fetchAccounts });

      expect(
        screen.getByRole("button", { name: /retry/i }),
      ).toBeInTheDocument();
    });

    it("retry button refetches accounts", async () => {
      const fetchAccounts = createFailingFetch();
      await renderAndWait({ fetchAccounts });

      expect(fetchAccounts).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByRole("button", { name: /retry/i }));

      // Flush microtasks
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(fetchAccounts).toHaveBeenCalledTimes(2);
    });
  });

  // =========================================================================
  // Integration Tests: Link Account -> OAuth Redirect
  // =========================================================================

  describe("integration: link account OAuth flow", () => {
    it("Link Google Account redirects to Google OAuth URL", async () => {
      const navigateToOAuth = createMockNavigate();
      await renderAndWait({ navigateToOAuth });

      fireEvent.click(screen.getByTestId("link-google"));

      expect(navigateToOAuth).toHaveBeenCalledTimes(1);
      expect(navigateToOAuth).toHaveBeenCalledWith(
        "https://oauth.tminus.ink/oauth/google/start?user_id=usr_test_123&redirect_uri=https%3A%2F%2Fapp.tminus.ink%2F%23%2Faccounts%3Flinked%3Dtrue",
      );
    });

    it("Link Microsoft Account redirects to Microsoft OAuth URL", async () => {
      const navigateToOAuth = createMockNavigate();
      await renderAndWait({ navigateToOAuth });

      fireEvent.click(screen.getByTestId("link-microsoft"));

      expect(navigateToOAuth).toHaveBeenCalledTimes(1);
      expect(navigateToOAuth).toHaveBeenCalledWith(
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
      const fetchAccounts = createMockFetch([]);
      await renderAndWait({ fetchAccounts });

      expect(screen.getByTestId("link-google")).toBeInTheDocument();
      expect(screen.getByTestId("link-microsoft")).toBeInTheDocument();
    });
  });

  // =========================================================================
  // Integration Tests: Unlink Account Flow
  // =========================================================================

  describe("integration: unlink account flow", () => {
    it("confirm unlink calls unlinkAccount with correct ID", async () => {
      const unlinkAccount = createMockUnlink();
      await renderAndWait({ unlinkAccount });

      // Click unlink on first account
      fireEvent.click(screen.getByTestId("unlink-btn-acc-google-work"));

      // Confirm in dialog
      fireEvent.click(screen.getByTestId("unlink-confirm"));

      // Wait for async unlink to complete
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(unlinkAccount).toHaveBeenCalledTimes(1);
      expect(unlinkAccount).toHaveBeenCalledWith("acc-google-work");
    });

    it("account is removed from list after successful unlink", async () => {
      const unlinkAccount = createMockUnlink();
      await renderAndWait({ unlinkAccount });

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
      const unlinkAccount = createFailingUnlink("Server error");
      await renderAndWait({ unlinkAccount });

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
      const unlinkAccount = createFailingUnlink("Server error");
      await renderAndWait({ unlinkAccount });

      fireEvent.click(screen.getByTestId("unlink-btn-acc-google-work"));
      fireEvent.click(screen.getByTestId("unlink-confirm"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      // Account should still be in the table (email also appears in the dialog)
      const table = screen.getByTestId("accounts-table");
      expect(within(table).getByText("work@gmail.com")).toBeInTheDocument();
    });

    it("cancel does NOT call unlinkAccount", async () => {
      const unlinkAccount = createMockUnlink();
      await renderAndWait({ unlinkAccount });

      fireEvent.click(screen.getByTestId("unlink-btn-acc-google-work"));
      fireEvent.click(screen.getByTestId("unlink-cancel"));

      expect(unlinkAccount).not.toHaveBeenCalled();
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
      const fetchAccounts = createMockFetch([pendingAccount]);
      await renderAndWait({ fetchAccounts });

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

    function createMockFetchScopes() {
      return vi.fn(
        async (_accountId: string): Promise<AccountScopesResponse> =>
          MOCK_SCOPES_RESPONSE,
      );
    }

    function createMockUpdateScopes() {
      return vi.fn(
        async (
          _accountId: string,
          _scopes: ScopeUpdateItem[],
        ): Promise<AccountScopesResponse> => MOCK_SCOPES_RESPONSE,
      );
    }

    it("shows Scopes button when fetchScopes is provided", async () => {
      const fetchScopes = createMockFetchScopes();
      await renderAndWait({ fetchScopes });

      // There should be a Scopes button for each account row
      const scopeBtn = screen.getByTestId("scopes-btn-acc-google-work");
      expect(scopeBtn).toBeInTheDocument();
      expect(scopeBtn.textContent).toBe("Scopes");
    });

    it("does NOT show Scopes button when fetchScopes is not provided", async () => {
      await renderAndWait(); // no fetchScopes

      const scopeBtn = screen.queryByTestId("scopes-btn-acc-google-work");
      expect(scopeBtn).not.toBeInTheDocument();
    });

    it("opens scope dialog when Scopes button is clicked", async () => {
      const fetchScopes = createMockFetchScopes();
      await renderAndWait({ fetchScopes });

      const scopeBtn = screen.getByTestId("scopes-btn-acc-google-work");

      await act(async () => {
        fireEvent.click(scopeBtn);
        await vi.advanceTimersByTimeAsync(0);
      });

      const dialog = screen.getByTestId("scopes-dialog");
      expect(dialog).toBeInTheDocument();
      expect(fetchScopes).toHaveBeenCalledWith("acc-google-work");
    });

    it("renders scope rows with capability metadata", async () => {
      const fetchScopes = createMockFetchScopes();
      await renderAndWait({ fetchScopes });

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
      const fetchScopes = createMockFetchScopes();
      await renderAndWait({ fetchScopes });

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
      const fetchScopes = createMockFetchScopes();
      const updateScopes = createMockUpdateScopes();
      await renderAndWait({ fetchScopes, updateScopes });

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
      const fetchScopes = createMockFetchScopes();
      const updateScopes = createMockUpdateScopes();
      await renderAndWait({ fetchScopes, updateScopes });

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

      expect(updateScopes).toHaveBeenCalledWith("acc-google-work", [
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
      const fetchScopes = createMockFetchScopes();
      await renderAndWait({ fetchScopes });

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
      const fetchScopes = vi.fn(async () => {
        throw new Error("Scope fetch failed");
      });
      await renderAndWait({ fetchScopes });

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
      const fetchScopes = createMockFetchScopes();
      await renderAndWait({ fetchScopes });

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
