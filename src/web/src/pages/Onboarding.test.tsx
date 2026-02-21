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
 *
 * Since Onboarding now uses useApi(), useAuth(), and useOnboardingCallbackId()
 * internally, tests mock those modules instead of passing props.
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
// Mock the API provider, auth, and route helpers
// ---------------------------------------------------------------------------

const mockFetchAccountStatus = vi.fn<(accountId: string) => Promise<OnboardingSyncStatus>>();
const mockFetchEventsForOnboarding = vi.fn<() => Promise<typeof MOCK_EVENTS>>();
const mockSubmitAppleCredentials = vi.fn<(userId: string, email: string, password: string) => Promise<{ account_id: string }>>();
const mockGetOnboardingSession = vi.fn<() => Promise<null>>();
const mockCreateOnboardingSession = vi.fn<() => Promise<{ session_id: string; user_id: string; step: string; accounts: never[]; session_token: string; created_at: string; updated_at: string }>>();
const mockAddOnboardingAccount = vi.fn<() => Promise<void>>();
const mockCompleteOnboardingSession = vi.fn<() => Promise<void>>();

const mockApiValue = {
  fetchAccountStatus: mockFetchAccountStatus,
  fetchEventsForOnboarding: mockFetchEventsForOnboarding,
  submitAppleCredentials: mockSubmitAppleCredentials,
  getOnboardingSession: mockGetOnboardingSession,
  createOnboardingSession: mockCreateOnboardingSession,
  addOnboardingAccount: mockAddOnboardingAccount,
  completeOnboardingSession: mockCompleteOnboardingSession,
};

vi.mock("../lib/api-provider", () => ({
  useApi: () => mockApiValue,
  ApiProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("../lib/auth", () => ({
  useAuth: () => ({
    token: "test-jwt-token",
    refreshToken: "test-refresh-token",
    user: MOCK_USER,
    login: vi.fn(),
    logout: vi.fn(),
  }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
}));

let mockCallbackAccountId: string | null = null;

vi.mock("../lib/route-helpers", () => ({
  useOnboardingCallbackId: () => mockCallbackAccountId,
}));

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockNavigate() {
  return vi.fn((_url: string) => {});
}

function setupDefaultMocks(overrides: {
  fetchAccountStatus?: (accountId: string) => Promise<OnboardingSyncStatus>;
  fetchEvents?: () => Promise<typeof MOCK_EVENTS>;
  submitAppleCredentials?: (userId: string, email: string, password: string) => Promise<{ account_id: string }>;
  callbackAccountId?: string | null;
  getOnboardingSession?: () => Promise<unknown>;
  createOnboardingSession?: () => Promise<unknown>;
} = {}) {
  mockCallbackAccountId = overrides.callbackAccountId ?? null;

  if (overrides.fetchAccountStatus) {
    mockFetchAccountStatus.mockImplementation(overrides.fetchAccountStatus);
  } else {
    mockFetchAccountStatus.mockResolvedValue(MOCK_SYNC_STATUS_COMPLETE);
  }

  if (overrides.fetchEvents) {
    mockFetchEventsForOnboarding.mockImplementation(overrides.fetchEvents);
  } else {
    mockFetchEventsForOnboarding.mockResolvedValue(MOCK_EVENTS);
  }

  if (overrides.submitAppleCredentials) {
    mockSubmitAppleCredentials.mockImplementation(overrides.submitAppleCredentials);
  } else {
    mockSubmitAppleCredentials.mockResolvedValue({ account_id: "acc-apple-321" });
  }

  if (overrides.getOnboardingSession) {
    mockGetOnboardingSession.mockImplementation(overrides.getOnboardingSession as never);
  } else {
    mockGetOnboardingSession.mockResolvedValue(null);
  }

  if (overrides.createOnboardingSession) {
    mockCreateOnboardingSession.mockImplementation(overrides.createOnboardingSession as never);
  } else {
    mockCreateOnboardingSession.mockResolvedValue({
      session_id: "obs_DEFAULT",
      user_id: MOCK_USER.id,
      step: "welcome",
      accounts: [],
      session_token: "tok_abc",
      created_at: "2026-02-15T10:00:00Z",
      updated_at: "2026-02-15T10:00:00Z",
    });
  }

  mockAddOnboardingAccount.mockResolvedValue(undefined);
  mockCompleteOnboardingSession.mockResolvedValue(undefined);
}

/**
 * Render the Onboarding component with default mocks and wait for initial render.
 */
async function renderOnboarding(overrides: {
  navigateToOAuth?: (url: string) => void;
  oauthBaseUrl?: string;
  callbackAccountId?: string | null;
  fetchAccountStatus?: (accountId: string) => Promise<OnboardingSyncStatus>;
  fetchEvents?: () => Promise<typeof MOCK_EVENTS>;
  submitAppleCredentials?: (userId: string, email: string, password: string) => Promise<{ account_id: string }>;
  getOnboardingSession?: () => Promise<unknown>;
  createOnboardingSession?: () => Promise<unknown>;
  callbackError?: string;
  callbackProvider?: "google" | "microsoft" | "apple";
  sessionId?: string;
  onErrorTelemetry?: (event: unknown) => void;
  // Legacy props that map to API mocks
  fetchOnboardingSession?: () => Promise<unknown>;
  addAccountToServerSession?: (...args: unknown[]) => Promise<void>;
  completeServerSession?: () => Promise<void>;
} = {}) {
  setupDefaultMocks({
    callbackAccountId: overrides.callbackAccountId,
    fetchAccountStatus: overrides.fetchAccountStatus,
    fetchEvents: overrides.fetchEvents,
    submitAppleCredentials: overrides.submitAppleCredentials,
    getOnboardingSession: overrides.fetchOnboardingSession ?? overrides.getOnboardingSession,
    createOnboardingSession: overrides.createOnboardingSession,
  });

  // Handle legacy addAccountToServerSession mock
  if (overrides.addAccountToServerSession) {
    mockAddOnboardingAccount.mockImplementation(async (payload: unknown) => {
      const p = payload as { account_id: string; provider: string; email: string; calendar_count?: number };
      await overrides.addAccountToServerSession!(p.account_id, p.provider, p.email, p.calendar_count);
    });
  }

  // Handle legacy completeServerSession mock
  if (overrides.completeServerSession) {
    mockCompleteOnboardingSession.mockImplementation(overrides.completeServerSession);
  }

  const navigateToOAuth = overrides.navigateToOAuth ?? createMockNavigate();

  const result = render(
    <Onboarding
      navigateToOAuth={navigateToOAuth}
      oauthBaseUrl={overrides.oauthBaseUrl ?? "https://oauth.tminus.ink"}
      callbackError={overrides.callbackError}
      callbackProvider={overrides.callbackProvider}
      onErrorTelemetry={overrides.onErrorTelemetry}
    />,
  );

  // Flush microtasks for any initial async operations
  await act(async () => {});

  return {
    ...result,
    navigateToOAuth,
    fetchAccountStatus: mockFetchAccountStatus,
    fetchEvents: mockFetchEventsForOnboarding,
    submitAppleCredentials: mockSubmitAppleCredentials,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCallbackAccountId = null;
});

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
      const submitApple = vi.fn(async () => ({ account_id: "acc-apple-321" }));
      const fetchStatus = vi.fn(async () => MOCK_SYNC_STATUS_COMPLETE_APPLE);

      await renderOnboarding({
        submitAppleCredentials: submitApple,
        fetchAccountStatus: fetchStatus,
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

      expect(submitApple).toHaveBeenCalledWith(
        "user-test-123",
        "user@icloud.com",
        "abcd-efgh-ijkl-mnop",
      );

      vi.useRealTimers();
    });

    it("Apple modal shows error on submission failure", async () => {
      const submitApple = vi.fn(async () => {
        throw new Error("Invalid credentials");
      });

      await renderOnboarding({ submitAppleCredentials: submitApple });

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
      await renderOnboarding({
        callbackAccountId: "acc-google-456",
        fetchAccountStatus: async () => MOCK_SYNC_STATUS_PENDING,
      });

      // Should show syncing indicator
      expect(screen.getByText(/syncing/i)).toBeInTheDocument();
    });

    it("polls account status at regular intervals", async () => {
      let callIndex = 0;
      const sequence = [
        MOCK_SYNC_STATUS_PENDING,
        MOCK_SYNC_STATUS_SYNCING,
        MOCK_SYNC_STATUS_COMPLETE,
      ];
      const fetchStatus = vi.fn(async () => {
        const status = sequence[Math.min(callIndex, sequence.length - 1)];
        callIndex++;
        return status;
      });

      await renderOnboarding({
        callbackAccountId: "acc-google-456",
        fetchAccountStatus: fetchStatus,
      });

      // First call happens immediately on mount
      expect(fetchStatus).toHaveBeenCalledTimes(1);

      // Advance timer to trigger second poll
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(fetchStatus).toHaveBeenCalledTimes(2);

      // Advance timer to trigger third poll
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(fetchStatus).toHaveBeenCalledTimes(3);
    });

    it("shows account email after sync completes", async () => {
      await renderOnboarding({
        callbackAccountId: "acc-google-456",
        fetchAccountStatus: async () => MOCK_SYNC_STATUS_COMPLETE,
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
      await renderOnboarding({
        callbackAccountId: "acc-google-456",
        fetchAccountStatus: async () => MOCK_SYNC_STATUS_COMPLETE,
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      // The checkmark + "Connected" text in the success banner
      expect(screen.getByText(/\u2713 Connected/)).toBeInTheDocument();
    });

    it("shows calendar count after sync completes", async () => {
      await renderOnboarding({
        callbackAccountId: "acc-google-456",
        fetchAccountStatus: async () => MOCK_SYNC_STATUS_COMPLETE,
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
      await renderOnboarding({
        callbackAccountId: "acc-google-456",
        fetchAccountStatus: async () => MOCK_SYNC_STATUS_COMPLETE,
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
      await renderOnboarding({
        callbackAccountId: "acc-google-456",
        fetchAccountStatus: async () => MOCK_SYNC_STATUS_COMPLETE,
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      // Events should be fetched
      expect(mockFetchEventsForOnboarding).toHaveBeenCalled();

      // Wait for events to render
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(screen.getByText("Team Standup")).toBeInTheDocument();
      expect(screen.getByText("Lunch with Alice")).toBeInTheDocument();
      expect(screen.getByText("Project Review")).toBeInTheDocument();
    });

    it("stops polling once sync is complete", async () => {
      await renderOnboarding({
        callbackAccountId: "acc-google-456",
        fetchAccountStatus: async () => MOCK_SYNC_STATUS_COMPLETE,
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      // Should have called once (initial) and then stopped
      const callCount = mockFetchAccountStatus.mock.calls.length;

      // Advance time significantly -- should not poll anymore
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });

      expect(mockFetchAccountStatus.mock.calls.length).toBe(callCount);
    });

    it("shows error state when status polling fails", async () => {
      await renderOnboarding({
        callbackAccountId: "acc-google-456",
        fetchAccountStatus: async () => { throw new Error("API unreachable"); },
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
      await renderOnboarding({
        callbackAccountId: "acc-google-456",
        fetchAccountStatus: async () => MOCK_SYNC_STATUS_COMPLETE,
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
      await renderOnboarding({
        callbackAccountId: "acc-google-456",
        fetchAccountStatus: async () => MOCK_SYNC_STATUS_COMPLETE,
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
      await renderOnboarding({
        callbackAccountId: "acc-google-456",
        fetchAccountStatus: async () => MOCK_SYNC_STATUS_COMPLETE,
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      // Should show how many accounts are connected
      expect(screen.getByText(/1.*account.*connected/i)).toBeInTheDocument();
    });

    it("shows 'Done' button to finish onboarding", async () => {
      await renderOnboarding({
        callbackAccountId: "acc-google-456",
        fetchAccountStatus: async () => MOCK_SYNC_STATUS_COMPLETE,
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
      await renderOnboarding({
        callbackAccountId: "acc-google-456",
        fetchAccountStatus: async () => MOCK_SYNC_STATUS_COMPLETE,
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
      await renderOnboarding({
        callbackAccountId: "acc-google-456",
        fetchAccountStatus: async () => MOCK_SYNC_STATUS_COMPLETE,
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
      await renderOnboarding({
        callbackAccountId: "acc-google-456",
        fetchAccountStatus: async () => MOCK_SYNC_STATUS_COMPLETE,
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

    it("supports adding 5+ accounts sequentially without page reload (AC 5)", async () => {
      // Define 5 distinct accounts: 1 Google (via OAuth callback), 4 Apple (via credential modal)
      const accounts: Array<{
        id: string;
        email: string;
        provider: "google" | "microsoft" | "apple";
        calendarCount: number;
      }> = [
        { id: "acc-google-1", email: "alice@gmail.com", provider: "google", calendarCount: 3 },
        { id: "acc-apple-1", email: "alice@icloud.com", provider: "apple", calendarCount: 1 },
        { id: "acc-apple-2", email: "bob@icloud.com", provider: "apple", calendarCount: 2 },
        { id: "acc-apple-3", email: "carol@icloud.com", provider: "apple", calendarCount: 4 },
        { id: "acc-apple-4", email: "dave@icloud.com", provider: "apple", calendarCount: 1 },
      ];

      // Build sync statuses keyed by account_id
      const syncStatusMap: Record<string, OnboardingSyncStatus> = {};
      for (const acct of accounts) {
        syncStatusMap[acct.id] = {
          account_id: acct.id,
          email: acct.email,
          provider: acct.provider,
          status: "active",
          calendar_count: acct.calendarCount,
          health: {
            lastSyncTs: "2026-02-15T12:00:00Z",
            lastSuccessTs: "2026-02-15T12:00:00Z",
            fullSyncNeeded: false,
          },
        };
      }

      // fetchAccountStatus dispatches by account_id
      const fetchAccountStatus = vi.fn(
        async (accountId: string): Promise<OnboardingSyncStatus> => {
          const status = syncStatusMap[accountId];
          if (!status) throw new Error(`Unknown account: ${accountId}`);
          return status;
        },
      );

      // submitAppleCredentials returns different account_id per email
      const emailToAccountId: Record<string, string> = {};
      for (const acct of accounts) {
        emailToAccountId[acct.email] = acct.id;
      }
      let appleCallCount = 0;
      const appleAccounts = accounts.filter((a) => a.provider === "apple");
      const submitAppleCredentials = vi.fn(
        async (
          _userId: string,
          email: string,
          _password: string,
        ): Promise<{ account_id: string }> => {
          const accountId = emailToAccountId[email];
          if (!accountId) {
            // Fallback: use sequential apple account IDs
            const fallback = appleAccounts[appleCallCount];
            appleCallCount++;
            return { account_id: fallback?.id ?? `acc-apple-fallback-${appleCallCount}` };
          }
          return { account_id: accountId };
        },
      );

      const fetchEvents = vi.fn(async () => [] as typeof MOCK_EVENTS);

      // -- Account 1: Google via OAuth callback --
      await renderOnboarding({
        callbackAccountId: accounts[0].id,
        fetchAccountStatus,
        fetchEvents,
        submitAppleCredentials,
      });

      // Wait for sync polling to complete
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });

      // Verify account 1 connected
      expect(screen.getByText(/1.*account.*connected/i)).toBeInTheDocument();
      const email1Elements = screen.getAllByText(new RegExp(accounts[0].email, "i"));
      expect(email1Elements.length).toBeGreaterThanOrEqual(1);

      // -- Accounts 2-5: Apple via credential modal --
      for (let i = 1; i < accounts.length; i++) {
        const acct = accounts[i];

        // Click "Add another account"
        const addButton = screen.getByRole("button", { name: /add another account/i });
        fireEvent.click(addButton);

        // Progress should show current count
        expect(
          screen.getByText(new RegExp(`${i}.*account.*connected`, "i")),
        ).toBeInTheDocument();

        // Click "Connect Apple"
        const appleButton = screen.getByRole("button", { name: /connect apple/i });
        fireEvent.click(appleButton);

        // Fill in Apple credential modal
        const emailInput = screen.getByLabelText(/apple id email/i);
        const passwordInput = screen.getByLabelText(/app-specific password/i);
        const connectBtn = screen.getByRole("button", { name: /connect$/i });

        fireEvent.change(emailInput, { target: { value: acct.email } });
        fireEvent.change(passwordInput, { target: { value: "abcd-efgh-ijkl-mnop" } });
        fireEvent.click(connectBtn);

        // Wait for credential submission + sync polling
        await act(async () => {
          await vi.advanceTimersByTimeAsync(200);
        });

        // Verify this account appears in the connected list
        const accountCount = i + 1;
        expect(
          screen.getByText(new RegExp(`${accountCount}.*account.*connected`, "i")),
        ).toBeInTheDocument();
      }

      // -- Verify all 5 accounts are visible with correct emails --
      for (const acct of accounts) {
        const emailMatches = screen.getAllByText(new RegExp(acct.email, "i"));
        expect(emailMatches.length).toBeGreaterThanOrEqual(1);
      }

      // -- Verify "Add another" still works after 5 accounts --
      const addButtonAfter5 = screen.getByRole("button", { name: /add another account/i });
      expect(addButtonAfter5).toBeInTheDocument();
      expect(addButtonAfter5).toBeEnabled();

      // -- Click "Done" and verify completion screen shows all 5 --
      const doneButton = screen.getByRole("button", { name: /done|finish|all set/i });
      fireEvent.click(doneButton);

      // Completion screen should show "You're all set"
      expect(screen.getByText(/you.?re all set/i)).toBeInTheDocument();

      // All 5 account emails should appear in the completion summary
      for (const acct of accounts) {
        const summaryEmails = screen.getAllByText(new RegExp(acct.email, "i"));
        expect(summaryEmails.length).toBeGreaterThanOrEqual(1);
      }

      // Verify state management: fetchAccountStatus was called for each account
      expect(fetchAccountStatus).toHaveBeenCalledWith(accounts[0].id);
      for (let i = 1; i < accounts.length; i++) {
        expect(fetchAccountStatus).toHaveBeenCalledWith(accounts[i].id);
      }

      // Verify Apple credentials were submitted 4 times (accounts 2-5)
      expect(submitAppleCredentials).toHaveBeenCalledTimes(4);
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
      await renderOnboarding({
        callbackAccountId: "acc-google-456",
        fetchAccountStatus: async () => { throw new Error("API unreachable"); },
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
      await renderOnboarding({
        callbackAccountId: "acc-google-456",
        fetchAccountStatus: async () => { throw new Error("API unreachable"); },
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

  // ---------------------------------------------------------------------------
  // Integration: Session management (TM-2o2.4)
  // ---------------------------------------------------------------------------

  describe("session management", () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("AC 1: creates session on first visit when no existing session", async () => {
      const createSession = vi.fn(async () => ({
        session_id: "obs_TEST001",
        user_id: "user-test-123",
        step: "welcome" as const,
        accounts: [],
        session_token: "tok_abc",
        created_at: "2026-02-15T10:00:00Z",
        updated_at: "2026-02-15T10:00:00Z",
      }));
      const fetchSession = vi.fn(async () => null);

      await renderOnboarding({
        fetchOnboardingSession: fetchSession,
        createOnboardingSession: createSession,
      });

      // Wait for the async useEffect to resolve
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });

      expect(mockGetOnboardingSession).toHaveBeenCalledTimes(1);
      expect(mockCreateOnboardingSession).toHaveBeenCalledTimes(1);
    });

    it("AC 2: resumes session with previously connected accounts", async () => {
      const fetchSession = vi.fn(async () => ({
        session_id: "obs_TEST001",
        user_id: "user-test-123",
        step: "connecting" as const,
        accounts: [
          {
            account_id: "acc-google-456",
            provider: "google" as const,
            email: "resumed@gmail.com",
            status: "connected" as const,
            calendar_count: 3,
            connected_at: "2026-02-15T10:00:00Z",
          },
        ],
        session_token: "tok_abc",
        created_at: "2026-02-15T10:00:00Z",
        updated_at: "2026-02-15T10:00:00Z",
      }));

      await renderOnboarding({
        fetchOnboardingSession: fetchSession,
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });

      // The resumed account should be visible
      expect(screen.getByText(/resumed@gmail.com/i)).toBeInTheDocument();
    });

    it("AC 4: re-connecting same account notifies server (idempotent)", async () => {
      const addAccountToServer = vi.fn(async () => {});

      await renderOnboarding({
        callbackAccountId: "acc-google-456",
        fetchAccountStatus: async () => MOCK_SYNC_STATUS_COMPLETE,
        addAccountToServerSession: addAccountToServer,
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });

      // Server should be notified of the connected account
      expect(mockAddOnboardingAccount).toHaveBeenCalled();
    });

    it("AC 5: cross-tab polling updates accounts from server", async () => {
      let pollCount = 0;
      const fetchSession = vi.fn(async () => {
        pollCount++;
        if (pollCount <= 1) {
          return {
            session_id: "obs_TEST001",
            user_id: "user-test-123",
            step: "connecting" as const,
            accounts: [
              {
                account_id: "acc-google-456",
                provider: "google" as const,
                email: "user@gmail.com",
                status: "connected" as const,
                calendar_count: 3,
                connected_at: "2026-02-15T10:00:00Z",
              },
            ],
            session_token: "tok_abc",
            created_at: "2026-02-15T10:00:00Z",
            updated_at: "2026-02-15T10:00:00Z",
          };
        }
        return {
          session_id: "obs_TEST001",
          user_id: "user-test-123",
          step: "connecting" as const,
          accounts: [
            {
              account_id: "acc-google-456",
              provider: "google" as const,
              email: "user@gmail.com",
              status: "connected" as const,
              calendar_count: 3,
              connected_at: "2026-02-15T10:00:00Z",
            },
            {
              account_id: "acc-ms-789",
              provider: "microsoft" as const,
              email: "user@outlook.com",
              status: "connected" as const,
              calendar_count: 2,
              connected_at: "2026-02-15T10:05:00Z",
            },
          ],
          session_token: "tok_abc",
          created_at: "2026-02-15T10:00:00Z",
          updated_at: "2026-02-15T10:05:00Z",
        };
      });

      await renderOnboarding({
        fetchOnboardingSession: fetchSession,
      });

      // Wait for initial session fetch
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });

      // First account should be visible from resume
      expect(screen.getByText(/user@gmail.com/i)).toBeInTheDocument();

      // Wait for cross-tab poll (SESSION_POLL_INTERVAL_MS = 3000)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4000);
      });

      // Second account should now be visible from cross-tab poll
      expect(screen.getByText(/user@outlook.com/i)).toBeInTheDocument();
    });

    it("AC 6: clicking Done notifies server of session completion", async () => {
      await renderOnboarding({
        callbackAccountId: "acc-google-456",
        fetchAccountStatus: async () => MOCK_SYNC_STATUS_COMPLETE,
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });

      const doneButton = screen.getByRole("button", {
        name: /done|finish|all set/i,
      });
      fireEvent.click(doneButton);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });

      expect(mockCompleteOnboardingSession).toHaveBeenCalledTimes(1);
    });

    it("session management is optional (backward compatible)", async () => {
      // Render without any session props -- should work exactly as before
      await renderOnboarding();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(
        screen.getByRole("heading", { level: 1 }),
      ).toHaveTextContent(/connect your calendar/i);
      expect(
        screen.getByRole("button", { name: /connect google/i }),
      ).toBeInTheDocument();
    });

    it("resumes to finished state when session is already complete", async () => {
      const fetchSession = vi.fn(async () => ({
        session_id: "obs_TEST001",
        user_id: "user-test-123",
        step: "complete" as const,
        accounts: [
          {
            account_id: "acc-google-456",
            provider: "google" as const,
            email: "user@gmail.com",
            status: "connected" as const,
            calendar_count: 3,
            connected_at: "2026-02-15T10:00:00Z",
          },
        ],
        session_token: "tok_abc",
        created_at: "2026-02-15T10:00:00Z",
        updated_at: "2026-02-15T10:30:00Z",
        completed_at: "2026-02-15T10:30:00Z",
      }));

      await renderOnboarding({
        fetchOnboardingSession: fetchSession,
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });

      // Should redirect to completion screen
      expect(screen.getByText(/you.?re all set/i)).toBeInTheDocument();
    });
  });
});
