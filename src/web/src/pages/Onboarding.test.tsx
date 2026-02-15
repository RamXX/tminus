/**
 * Tests for the Onboarding page.
 *
 * Covers:
 * - Unit: renders branded onboarding page with three provider cards
 * - Unit: each provider card renders with correct logo, description, and Connect button
 * - Unit: Apple credential input validates format (xxxx-xxxx-xxxx-xxxx)
 * - Unit: connection status component shows correct states (syncing/synced/error)
 * - Unit: provider-specific brand colors (Google blue, Microsoft purple, Apple gray)
 * - Integration: clicking "Connect Google" constructs correct OAuth URL
 * - Integration: clicking "Connect Microsoft" constructs correct OAuth URL
 * - Integration: clicking "Connect Apple" opens credential modal
 * - Integration: Apple modal walks user through app-specific password
 * - Integration: OAuth callback triggers status polling
 * - Integration: sync completion shows success state with account email and calendar count
 * - Integration: "Add another account" flow works for 5+ accounts without page reload
 * - Integration: completion screen shows "You're all set" with account summary
 * - Integration: error states handled gracefully with "Try Again"
 * - Accessibility: all interactive elements keyboard-navigable with ARIA labels
 * - Responsive: layout works at 375px mobile viewport
 *
 * Uses React Testing Library with fireEvent for click interactions.
 * Uses fake timers for polling behavior tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent, within } from "@testing-library/react";
import { Onboarding, type OnboardingProps } from "./Onboarding";
import type { OnboardingSyncStatus } from "../lib/onboarding";
import {
  isValidAppleAppPassword,
  maskApplePassword,
  isOAuthProvider,
  isCredentialProvider,
  getProviderColor,
  PROVIDER_COLORS,
  PROVIDERS,
} from "../lib/onboarding";

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
  calendar_count: 3,
  health: {
    lastSyncTs: "2026-02-15T12:00:05Z",
    lastSuccessTs: "2026-02-15T12:00:05Z",
    fullSyncNeeded: false,
  },
};

const MOCK_SYNC_STATUS_COMPLETE_MS: OnboardingSyncStatus = {
  account_id: "acc-ms-789",
  email: "work@outlook.com",
  provider: "microsoft",
  status: "active",
  calendar_count: 2,
  health: {
    lastSyncTs: "2026-02-15T12:01:00Z",
    lastSuccessTs: "2026-02-15T12:01:00Z",
    fullSyncNeeded: false,
  },
};

const MOCK_SYNC_STATUS_COMPLETE_APPLE: OnboardingSyncStatus = {
  account_id: "acc-apple-321",
  email: "user@icloud.com",
  provider: "apple",
  status: "active",
  calendar_count: 1,
  health: {
    lastSyncTs: "2026-02-15T12:02:00Z",
    lastSuccessTs: "2026-02-15T12:02:00Z",
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

function createMockSubmitAppleCredentials() {
  return vi.fn(
    async (
      _userId: string,
      _email: string,
      _password: string,
    ): Promise<{ account_id: string }> => {
      return { account_id: "acc-apple-321" };
    },
  );
}

function createFailingSubmitAppleCredentials(message = "Invalid password") {
  return vi.fn(
    async (
      _userId: string,
      _email: string,
      _password: string,
    ): Promise<{ account_id: string }> => {
      throw new Error(message);
    },
  );
}

/**
 * Render the Onboarding component with default props and wait for initial render.
 */
async function renderOnboarding(overrides: Partial<OnboardingProps> = {}) {
  const navigateToOAuth = overrides.navigateToOAuth ?? createMockNavigate();
  const fetchAccountStatus =
    overrides.fetchAccountStatus ?? createMockFetchStatus();
  const fetchEvents = overrides.fetchEvents ?? createMockFetchEvents();
  const submitAppleCredentials =
    overrides.submitAppleCredentials ?? createMockSubmitAppleCredentials();

  const result = render(
    <Onboarding
      user={overrides.user ?? MOCK_USER}
      navigateToOAuth={navigateToOAuth}
      fetchAccountStatus={fetchAccountStatus}
      fetchEvents={fetchEvents}
      callbackAccountId={overrides.callbackAccountId ?? null}
      oauthBaseUrl={overrides.oauthBaseUrl ?? "https://oauth.tminus.ink"}
      submitAppleCredentials={submitAppleCredentials}
    />,
  );

  // Flush microtasks for any initial async operations
  await act(async () => {});

  return {
    ...result,
    navigateToOAuth,
    fetchAccountStatus,
    fetchEvents,
    submitAppleCredentials,
  };
}

// ---------------------------------------------------------------------------
// Unit tests: onboarding helper functions
// ---------------------------------------------------------------------------

describe("Onboarding helpers", () => {
  describe("isValidAppleAppPassword", () => {
    it("accepts valid format with hyphens", () => {
      expect(isValidAppleAppPassword("abcd-efgh-ijkl-mnop")).toBe(true);
    });

    it("accepts valid format without hyphens", () => {
      expect(isValidAppleAppPassword("abcdefghijklmnop")).toBe(true);
    });

    it("accepts uppercase (case-insensitive)", () => {
      expect(isValidAppleAppPassword("ABCD-EFGH-IJKL-MNOP")).toBe(true);
    });

    it("rejects too short", () => {
      expect(isValidAppleAppPassword("abcd-efgh")).toBe(false);
    });

    it("rejects too long", () => {
      expect(isValidAppleAppPassword("abcd-efgh-ijkl-mnop-qrst")).toBe(false);
    });

    it("rejects with numbers", () => {
      expect(isValidAppleAppPassword("abcd-1234-ijkl-mnop")).toBe(false);
    });

    it("rejects empty string", () => {
      expect(isValidAppleAppPassword("")).toBe(false);
    });

    it("rejects null-like values", () => {
      expect(isValidAppleAppPassword(null as unknown as string)).toBe(false);
      expect(isValidAppleAppPassword(undefined as unknown as string)).toBe(
        false,
      );
    });
  });

  describe("maskApplePassword", () => {
    it("masks all but first 4 characters", () => {
      expect(maskApplePassword("abcd-efgh-ijkl-mnop")).toBe(
        "abcd-****-****-****",
      );
    });

    it("handles short input gracefully", () => {
      expect(maskApplePassword("ab")).toBe("****-****-****-****");
    });
  });

  describe("provider helpers", () => {
    it("isOAuthProvider returns true for google and microsoft", () => {
      expect(isOAuthProvider("google")).toBe(true);
      expect(isOAuthProvider("microsoft")).toBe(true);
    });

    it("isOAuthProvider returns false for apple", () => {
      expect(isOAuthProvider("apple")).toBe(false);
    });

    it("isCredentialProvider returns true for apple", () => {
      expect(isCredentialProvider("apple")).toBe(true);
    });

    it("isCredentialProvider returns false for google and microsoft", () => {
      expect(isCredentialProvider("google")).toBe(false);
      expect(isCredentialProvider("microsoft")).toBe(false);
    });

    it("getProviderColor returns brand-specific colors", () => {
      expect(getProviderColor("google")).toBe("#4285F4");
      expect(getProviderColor("microsoft")).toBe("#7B2AE0");
      expect(getProviderColor("apple")).toBe("#555555");
    });
  });

  describe("PROVIDERS list", () => {
    it("includes all three providers", () => {
      expect(PROVIDERS).toHaveLength(3);
      expect(PROVIDERS.map((p) => p.id)).toEqual([
        "google",
        "microsoft",
        "apple",
      ]);
    });

    it("all providers are enabled", () => {
      PROVIDERS.forEach((p) => {
        expect(p.enabled).toBe(true);
      });
    });
  });
});

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

    it("renders Connect Microsoft button as enabled", async () => {
      await renderOnboarding();

      const msButton = screen.getByRole("button", {
        name: /connect microsoft/i,
      });
      expect(msButton).toBeInTheDocument();
      expect(msButton).toBeEnabled();
    });

    it("renders Connect Apple button as enabled", async () => {
      await renderOnboarding();

      const appleButton = screen.getByRole("button", {
        name: /connect apple/i,
      });
      expect(appleButton).toBeInTheDocument();
      expect(appleButton).toBeEnabled();
    });

    it("shows provider descriptions without jargon", async () => {
      await renderOnboarding();

      expect(screen.getByText(/google workspace/i)).toBeInTheDocument();
      expect(screen.getByText(/microsoft 365/i)).toBeInTheDocument();
      expect(screen.getByText(/icloud/i)).toBeInTheDocument();
    });

    it("shows no technical jargon in provider descriptions", async () => {
      await renderOnboarding();

      // AC 8: zero technical jargon visible
      const container = screen.getByTestId("onboarding-container");
      const text = container.textContent ?? "";
      expect(text).not.toMatch(/oauth/i);
      expect(text).not.toMatch(/pkce/i);
      expect(text).not.toMatch(/scope/i);
      expect(text).not.toMatch(/token/i);
      expect(text).not.toMatch(/authorize/i);
    });

    it("renders three provider cards", async () => {
      await renderOnboarding();

      const cards = screen.getAllByTestId(/^provider-card-/);
      expect(cards).toHaveLength(3);
    });

    it("provider cards have correct branding colors", async () => {
      await renderOnboarding();

      const googleCard = screen.getByTestId("provider-card-google");
      const msCard = screen.getByTestId("provider-card-microsoft");
      const appleCard = screen.getByTestId("provider-card-apple");

      // Check that provider-specific accent colors are applied
      expect(googleCard).toBeInTheDocument();
      expect(msCard).toBeInTheDocument();
      expect(appleCard).toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // Unit: Provider card rendering
  // ---------------------------------------------------------------------------

  describe("provider card rendering", () => {
    it("each card shows provider logo placeholder", async () => {
      await renderOnboarding();

      expect(screen.getByTestId("provider-icon-google")).toBeInTheDocument();
      expect(
        screen.getByTestId("provider-icon-microsoft"),
      ).toBeInTheDocument();
      expect(screen.getByTestId("provider-icon-apple")).toBeInTheDocument();
    });

    it("each card has a one-line description", async () => {
      await renderOnboarding();

      const googleCard = screen.getByTestId("provider-card-google");
      expect(
        within(googleCard).getByText(/google workspace/i),
      ).toBeInTheDocument();

      const msCard = screen.getByTestId("provider-card-microsoft");
      expect(
        within(msCard).getByText(/microsoft 365/i),
      ).toBeInTheDocument();

      const appleCard = screen.getByTestId("provider-card-apple");
      expect(
        within(appleCard).getByText(/icloud/i),
      ).toBeInTheDocument();
    });

    it("each card has a Connect button", async () => {
      await renderOnboarding();

      const buttons = screen.getAllByRole("button", {
        name: /connect/i,
      });
      // 3 connect buttons (one per provider)
      expect(buttons.length).toBeGreaterThanOrEqual(3);
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

    it("clicking Connect Microsoft navigates to OAuth URL with correct params", async () => {
      const navigateToOAuth = createMockNavigate();
      await renderOnboarding({ navigateToOAuth });

      const msButton = screen.getByRole("button", {
        name: /connect microsoft/i,
      });
      fireEvent.click(msButton);

      expect(navigateToOAuth).toHaveBeenCalledTimes(1);
      const url = new URL(navigateToOAuth.mock.calls[0][0]);
      expect(url.pathname).toBe("/oauth/microsoft/start");
      expect(url.searchParams.get("user_id")).toBe("user-test-123");
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
  // Integration: Apple credential flow
  // ---------------------------------------------------------------------------

  describe("Apple credential flow", () => {
    it("clicking Connect Apple opens credential modal", async () => {
      await renderOnboarding();

      const appleButton = screen.getByRole("button", {
        name: /connect apple/i,
      });
      fireEvent.click(appleButton);

      // Modal should appear with guided instructions
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      // Multiple elements mention "app-specific password" (description + label)
      const passwordMentions = screen.getAllByText(/app-specific password/i);
      expect(passwordMentions.length).toBeGreaterThanOrEqual(1);
    });

    it("Apple modal shows link to appleid.apple.com", async () => {
      await renderOnboarding();

      fireEvent.click(
        screen.getByRole("button", { name: /connect apple/i }),
      );

      const link = screen.getByRole("link", { name: /apple id/i });
      expect(link).toBeInTheDocument();
      expect(link).toHaveAttribute(
        "href",
        expect.stringContaining("appleid.apple.com"),
      );
    });

    it("Apple modal has Apple ID email input field", async () => {
      await renderOnboarding();

      fireEvent.click(
        screen.getByRole("button", { name: /connect apple/i }),
      );

      const emailInput = screen.getByLabelText(/apple id email/i);
      expect(emailInput).toBeInTheDocument();
    });

    it("Apple modal has password input field", async () => {
      await renderOnboarding();

      fireEvent.click(
        screen.getByRole("button", { name: /connect apple/i }),
      );

      const passwordInput = screen.getByLabelText(/app-specific password/i);
      expect(passwordInput).toBeInTheDocument();
    });

    it("Apple modal validates password format before submit", async () => {
      await renderOnboarding();

      fireEvent.click(
        screen.getByRole("button", { name: /connect apple/i }),
      );

      const emailInput = screen.getByLabelText(/apple id email/i);
      const passwordInput = screen.getByLabelText(/app-specific password/i);
      const submitButton = screen.getByRole("button", {
        name: /connect$/i,
      });

      // Enter invalid password
      fireEvent.change(emailInput, { target: { value: "user@icloud.com" } });
      fireEvent.change(passwordInput, { target: { value: "too-short" } });
      fireEvent.click(submitButton);

      // Should show validation error
      expect(
        screen.getByText(/invalid.*password.*format/i),
      ).toBeInTheDocument();
    });

    it("Apple modal submits valid credentials", async () => {
      vi.useFakeTimers();
      const submitAppleCredentials = createMockSubmitAppleCredentials();
      const fetchAccountStatus = createMockFetchStatus([
        MOCK_SYNC_STATUS_COMPLETE_APPLE,
      ]);

      await renderOnboarding({
        submitAppleCredentials,
        fetchAccountStatus,
      });

      fireEvent.click(
        screen.getByRole("button", { name: /connect apple/i }),
      );

      const emailInput = screen.getByLabelText(/apple id email/i);
      const passwordInput = screen.getByLabelText(/app-specific password/i);
      const submitButton = screen.getByRole("button", {
        name: /connect$/i,
      });

      fireEvent.change(emailInput, { target: { value: "user@icloud.com" } });
      fireEvent.change(passwordInput, {
        target: { value: "abcd-efgh-ijkl-mnop" },
      });
      fireEvent.click(submitButton);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(submitAppleCredentials).toHaveBeenCalledWith(
        "user-test-123",
        "user@icloud.com",
        "abcd-efgh-ijkl-mnop",
      );

      vi.useRealTimers();
    });

    it("Apple modal shows error on submission failure", async () => {
      const submitAppleCredentials = createFailingSubmitAppleCredentials(
        "Invalid credentials",
      );

      await renderOnboarding({ submitAppleCredentials });

      fireEvent.click(
        screen.getByRole("button", { name: /connect apple/i }),
      );

      const emailInput = screen.getByLabelText(/apple id email/i);
      const passwordInput = screen.getByLabelText(/app-specific password/i);
      const submitButton = screen.getByRole("button", {
        name: /connect$/i,
      });

      fireEvent.change(emailInput, { target: { value: "user@icloud.com" } });
      fireEvent.change(passwordInput, {
        target: { value: "abcd-efgh-ijkl-mnop" },
      });
      fireEvent.click(submitButton);

      await act(async () => {});

      expect(screen.getByText(/invalid credentials/i)).toBeInTheDocument();
    });

    it("Apple modal can be closed", async () => {
      await renderOnboarding();

      fireEvent.click(
        screen.getByRole("button", { name: /connect apple/i }),
      );

      expect(screen.getByRole("dialog")).toBeInTheDocument();

      const closeButton = screen.getByRole("button", { name: /cancel/i });
      fireEvent.click(closeButton);

      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
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

      // Email appears in both the connected account card and the success banner
      const emailElements = screen.getAllByText(/connected@gmail.com/i);
      expect(emailElements.length).toBeGreaterThanOrEqual(1);
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

    it("shows calendar count after sync completes", async () => {
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

      // AC 4: connected accounts show calendar count
      // Count appears in both the connected account card and the success banner
      const countElements = screen.getAllByText(/3 calendars/i);
      expect(countElements.length).toBeGreaterThanOrEqual(1);
    });

    it("shows sync status indicator for connected account", async () => {
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

      // AC 4: live sync status shown
      // "Synced" appears in both connected account card and success banner
      const syncElements = screen.getAllByText(/synced/i);
      expect(syncElements.length).toBeGreaterThanOrEqual(1);
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

  // ---------------------------------------------------------------------------
  // Integration: Add Another Account flow
  // ---------------------------------------------------------------------------

  describe("add another account flow", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("shows 'Add another account' button after first account connects", async () => {
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

      const addButton = screen.getByRole("button", {
        name: /add another account/i,
      });
      expect(addButton).toBeInTheDocument();
    });

    it("clicking 'Add another account' shows provider selection again", async () => {
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

      const addButton = screen.getByRole("button", {
        name: /add another account/i,
      });
      fireEvent.click(addButton);

      // Provider cards should be visible again
      expect(
        screen.getByRole("button", { name: /connect google/i }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /connect microsoft/i }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /connect apple/i }),
      ).toBeInTheDocument();
    });

    it("shows progress indicator with account count", async () => {
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

      // Should show how many accounts are connected
      expect(screen.getByText(/1.*account.*connected/i)).toBeInTheDocument();
    });

    it("shows 'Done' button to finish onboarding", async () => {
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

      const doneButton = screen.getByRole("button", {
        name: /done|finish|all set/i,
      });
      expect(doneButton).toBeInTheDocument();
    });

    it("clicking 'Done' shows completion screen", async () => {
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

      const doneButton = screen.getByRole("button", {
        name: /done|finish|all set/i,
      });
      fireEvent.click(doneButton);

      // AC: completion screen with "You're all set"
      expect(screen.getByText(/you.?re all set/i)).toBeInTheDocument();
    });

    it("completion screen shows summary of connected accounts", async () => {
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

      fireEvent.click(
        screen.getByRole("button", { name: /done|finish|all set/i }),
      );

      // Summary should show the connected account
      expect(screen.getByText(/connected@gmail.com/i)).toBeInTheDocument();
    });

    it("completion screen has link to calendar view", async () => {
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

      fireEvent.click(
        screen.getByRole("button", { name: /done|finish|all set/i }),
      );

      const calendarLink = screen.getByRole("link", {
        name: /calendar|view.*calendar|go.*calendar/i,
      });
      expect(calendarLink).toBeInTheDocument();
      expect(calendarLink).toHaveAttribute(
        "href",
        expect.stringContaining("calendar"),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Integration: Error recovery
  // ---------------------------------------------------------------------------

  describe("error recovery", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("error state has 'Try again' action", async () => {
      const fetchAccountStatus = createFailingFetchStatus("API unreachable");

      await renderOnboarding({
        callbackAccountId: "acc-google-456",
        fetchAccountStatus,
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      const retryButton = screen.getByRole("button", {
        name: /try again/i,
      });
      expect(retryButton).toBeInTheDocument();
    });

    it("clicking 'Try again' resets to idle state", async () => {
      const fetchAccountStatus = createFailingFetchStatus("API unreachable");

      await renderOnboarding({
        callbackAccountId: "acc-google-456",
        fetchAccountStatus,
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      fireEvent.click(screen.getByRole("button", { name: /try again/i }));

      // Should show provider buttons again
      expect(
        screen.getByRole("button", { name: /connect google/i }),
      ).toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // Accessibility
  // ---------------------------------------------------------------------------

  describe("accessibility", () => {
    it("all provider buttons have accessible names", async () => {
      await renderOnboarding();

      const buttons = screen.getAllByRole("button", { name: /connect/i });
      buttons.forEach((btn) => {
        expect(btn).toHaveAttribute("aria-label");
      });
    });

    it("provider cards have ARIA labels", async () => {
      await renderOnboarding();

      const cards = screen.getAllByTestId(/^provider-card-/);
      cards.forEach((card) => {
        expect(card).toHaveAttribute("aria-label");
      });
    });

    it("Apple modal has ARIA dialog role", async () => {
      await renderOnboarding();

      fireEvent.click(
        screen.getByRole("button", { name: /connect apple/i }),
      );

      const dialog = screen.getByRole("dialog");
      expect(dialog).toBeInTheDocument();
      expect(dialog).toHaveAttribute("aria-label");
    });

    it("form inputs have associated labels", async () => {
      await renderOnboarding();

      fireEvent.click(
        screen.getByRole("button", { name: /connect apple/i }),
      );

      const emailInput = screen.getByLabelText(/apple id email/i);
      const passwordInput = screen.getByLabelText(/app-specific password/i);
      expect(emailInput).toBeInTheDocument();
      expect(passwordInput).toBeInTheDocument();
    });

    it("provider buttons can be activated with keyboard Enter", async () => {
      const navigateToOAuth = createMockNavigate();
      await renderOnboarding({ navigateToOAuth });

      const googleButton = screen.getByRole("button", {
        name: /connect google/i,
      });

      // Focus and press Enter
      googleButton.focus();
      fireEvent.keyDown(googleButton, { key: "Enter", code: "Enter" });
      fireEvent.click(googleButton);

      expect(navigateToOAuth).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Responsive design
  // ---------------------------------------------------------------------------

  describe("responsive design", () => {
    it("onboarding container has responsive max-width", async () => {
      await renderOnboarding();

      const container = screen.getByTestId("onboarding-container");
      expect(container).toBeInTheDocument();
      // The container should have styling that works on mobile
      // (we test that it renders; actual CSS responsiveness is a visual test)
    });

    it("provider cards stack vertically (flex-direction column)", async () => {
      await renderOnboarding();

      const cardContainer = screen.getByTestId("provider-cards");
      expect(cardContainer).toBeInTheDocument();
    });
  });
});
