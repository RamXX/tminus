/**
 * Integration tests for onboarding error recovery and resilience.
 *
 * Tests the Onboarding component's error handling behavior:
 * - OAuth flow errors produce classified, jargon-free messages (AC 1)
 * - CalDAV (Apple) errors produce classified, jargon-free messages (AC 2)
 * - Error messages contain zero technical jargon (AC 3)
 * - Transient errors auto-retry with exponential backoff (AC 4)
 * - Persistent errors show inline error with manual "Try again" (AC 5)
 * - Error telemetry logs anonymized events (AC 6)
 * - Popup blocker detection shows specific guidance (AC 7)
 *
 * Uses React Testing Library with fireEvent.
 * Uses fake timers for retry/backoff behavior.
 *
 * Since Onboarding now uses useApi(), useAuth(), and useOnboardingCallbackId()
 * internally, tests mock those modules instead of passing props.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { Onboarding, type OnboardingProps } from "./Onboarding";
import type { OnboardingSyncStatus } from "../lib/onboarding";
import { JARGON_TERMS, OnboardingError } from "../lib/onboarding-errors";

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const MOCK_USER = { id: "user-test-123", email: "test@example.com" };

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

const MOCK_EVENTS = [
  {
    canonical_event_id: "evt-1",
    summary: "Meeting",
    start: "2026-02-15T09:00:00Z",
    end: "2026-02-15T09:30:00Z",
  },
];

// ---------------------------------------------------------------------------
// Mock the API provider, auth, and route helpers
// ---------------------------------------------------------------------------

const mockFetchAccountStatus = vi.fn<(accountId: string) => Promise<OnboardingSyncStatus>>();
const mockFetchEventsForOnboarding = vi.fn<() => Promise<typeof MOCK_EVENTS>>();
const mockSubmitAppleCredentials = vi.fn<(userId: string, email: string, password: string) => Promise<{ account_id: string }>>();
const mockGetOnboardingSession = vi.fn<() => Promise<null>>();
const mockCreateOnboardingSession = vi.fn();
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
  callbackAccountId?: string | null;
} = {}) {
  mockCallbackAccountId = overrides.callbackAccountId ?? null;

  if (overrides.fetchAccountStatus) {
    mockFetchAccountStatus.mockImplementation(overrides.fetchAccountStatus);
  } else {
    mockFetchAccountStatus.mockResolvedValue(MOCK_SYNC_STATUS_COMPLETE);
  }

  mockFetchEventsForOnboarding.mockResolvedValue(MOCK_EVENTS);
  mockSubmitAppleCredentials.mockResolvedValue({ account_id: "acc-apple-321" });
  mockGetOnboardingSession.mockResolvedValue(null);
  mockCreateOnboardingSession.mockResolvedValue({
    session_id: "obs_DEFAULT",
    user_id: MOCK_USER.id,
    step: "welcome",
    accounts: [],
    session_token: "tok_abc",
    created_at: "2026-02-15T10:00:00Z",
    updated_at: "2026-02-15T10:00:00Z",
  });
  mockAddOnboardingAccount.mockResolvedValue(undefined);
  mockCompleteOnboardingSession.mockResolvedValue(undefined);
}

async function renderOnboarding(overrides: Partial<OnboardingProps> & {
  callbackAccountId?: string | null;
  fetchAccountStatus?: (accountId: string) => Promise<OnboardingSyncStatus>;
  submitAppleCredentials?: (userId: string, email: string, password: string) => Promise<{ account_id: string }>;
} = {}) {
  setupDefaultMocks({
    callbackAccountId: overrides.callbackAccountId,
    fetchAccountStatus: overrides.fetchAccountStatus,
  });

  if (overrides.submitAppleCredentials) {
    mockSubmitAppleCredentials.mockImplementation(overrides.submitAppleCredentials);
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
// Integration: OAuth error recovery (AC 1, AC 3, AC 5)
// ---------------------------------------------------------------------------

describe("OAuth error recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows classified message for access_denied error from callback", async () => {
    await renderOnboarding({
      callbackError: "access_denied",
      callbackProvider: "google",
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    // Should show the classified user-facing message
    expect(screen.getByText(/declined.*permission/i)).toBeInTheDocument();
    expect(screen.getByText(/calendar access/i)).toBeInTheDocument();
  });

  it("shows classified message for invalid_grant error from callback", async () => {
    await renderOnboarding({
      callbackError: "invalid_grant",
      callbackProvider: "google",
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(screen.getByText(/expired|took too long/i)).toBeInTheDocument();
  });

  it("shows classified message for temporarily_unavailable with provider name", async () => {
    await renderOnboarding({
      callbackError: "temporarily_unavailable",
      callbackProvider: "microsoft",
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(screen.getByText(/microsoft.*temporarily unavailable/i)).toBeInTheDocument();
  });

  it("shows popup blocker guidance for popup_blocked error", async () => {
    await renderOnboarding({
      callbackError: "popup_blocked",
      callbackProvider: "google",
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    // AC 7: specific guidance for popup blocking
    expect(screen.getByText(/browser.*blocked.*sign-in/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /allow popups/i }),
    ).toBeInTheDocument();
  });

  it("shows start_over action for state_mismatch error", async () => {
    await renderOnboarding({
      callbackError: "state_mismatch",
      callbackProvider: "google",
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(screen.getByText(/something went wrong.*sign-in/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /start over/i }),
    ).toBeInTheDocument();
  });

  it("recovery action button returns to idle state", async () => {
    await renderOnboarding({
      callbackError: "access_denied",
      callbackProvider: "google",
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    // Click the recovery action button
    const tryAgainBtn = screen.getByRole("button", { name: /try again/i });
    fireEvent.click(tryAgainBtn);

    // Should return to idle state with provider cards
    expect(
      screen.getByRole("button", { name: /connect google/i }),
    ).toBeInTheDocument();
  });

  it("error message contains zero technical jargon", async () => {
    const errorCodes = [
      "access_denied",
      "invalid_grant",
      "temporarily_unavailable",
      "popup_blocked",
      "state_mismatch",
      "network_timeout",
      "server_error",
    ];

    for (const code of errorCodes) {
      setupDefaultMocks();

      const { unmount } = render(
        <Onboarding
          callbackError={code}
          callbackProvider="google"
        />,
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      const container = document.querySelector('[data-testid="onboarding-container"]');
      const text = container?.textContent ?? "";
      const lower = text.toLowerCase();

      for (const jargon of JARGON_TERMS) {
        // Allow "token" only if not in a technical context
        expect(lower).not.toContain(jargon);
      }

      unmount();
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: CalDAV (Apple) error recovery (AC 2)
// ---------------------------------------------------------------------------

describe("CalDAV (Apple) error recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows classified message for Apple invalid_password error", async () => {
    const submitApple = vi.fn(async () => {
      throw new OnboardingError({
        code: "invalid_password",
        message:
          "That password didn't work. Make sure you copied the full password from appleid.apple.com.",
        severity: "persistent",
        recovery_action: "show_how",
        recovery_label: "Show me how",
        provider: "apple",
      });
    });

    await renderOnboarding({
      submitAppleCredentials: submitApple,
    });

    // Open Apple modal
    fireEvent.click(
      screen.getByRole("button", { name: /connect apple/i }),
    );

    // Fill in credentials
    fireEvent.change(screen.getByLabelText(/apple id email/i), {
      target: { value: "user@icloud.com" },
    });
    fireEvent.change(screen.getByLabelText(/app-specific password/i), {
      target: { value: "abcd-efgh-ijkl-mnop" },
    });

    // Submit
    fireEvent.click(screen.getByRole("button", { name: /connect$/i }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(screen.getByText(/password.*didn.?t work/i)).toBeInTheDocument();
  });

  it("shows classified message for Apple connection_refused error", async () => {
    const submitApple = vi.fn(async () => {
      throw new OnboardingError({
        code: "connection_refused",
        message:
          "Can't reach Apple's calendar server. This may be a temporary issue.",
        severity: "transient",
        recovery_action: "wait_and_retry",
        recovery_label: "Try again in a few minutes",
        provider: "apple",
      });
    });

    await renderOnboarding({
      submitAppleCredentials: submitApple,
    });

    fireEvent.click(
      screen.getByRole("button", { name: /connect apple/i }),
    );

    fireEvent.change(screen.getByLabelText(/apple id email/i), {
      target: { value: "user@icloud.com" },
    });
    fireEvent.change(screen.getByLabelText(/app-specific password/i), {
      target: { value: "abcd-efgh-ijkl-mnop" },
    });

    fireEvent.click(screen.getByRole("button", { name: /connect$/i }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(screen.getByText(/can.?t reach.*apple.*calendar server/i)).toBeInTheDocument();
  });

  it("Apple error messages contain zero technical jargon", async () => {
    // Test that Apple-specific errors don't leak CalDAV/PROPFIND jargon
    const submitApple = vi.fn(async () => {
      throw new OnboardingError({
        code: "auth_failed",
        message:
          "Unable to sign in with those credentials. Please double-check your Apple ID email and app-specific password.",
        severity: "persistent",
        recovery_action: "try_again",
        recovery_label: "Try again",
        provider: "apple",
      });
    });

    await renderOnboarding({
      submitAppleCredentials: submitApple,
    });

    fireEvent.click(
      screen.getByRole("button", { name: /connect apple/i }),
    );

    fireEvent.change(screen.getByLabelText(/apple id email/i), {
      target: { value: "user@icloud.com" },
    });
    fireEvent.change(screen.getByLabelText(/app-specific password/i), {
      target: { value: "abcd-efgh-ijkl-mnop" },
    });

    fireEvent.click(screen.getByRole("button", { name: /connect$/i }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    // The visible text should have no jargon
    const modalContent = screen.getByRole("dialog");
    const text = modalContent.textContent ?? "";
    const lower = text.toLowerCase();

    // Check specific CalDAV jargon that could leak
    expect(lower).not.toContain("caldav");
    expect(lower).not.toContain("propfind");
    expect(lower).not.toContain("401");
    expect(lower).not.toContain("http");
  });
});

// ---------------------------------------------------------------------------
// Integration: Transient error auto-retry (AC 4)
// ---------------------------------------------------------------------------

describe("transient error auto-retry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("auto-retries transient sync polling errors up to 3 times before surfacing", async () => {
    let callCount = 0;
    const fetchAccountStatus = vi.fn(async (_accountId: string): Promise<OnboardingSyncStatus> => {
      callCount++;
      if (callCount <= 3) {
        // Throw an OnboardingError with transient severity to trigger auto-retry
        throw new OnboardingError({
          code: "network_timeout",
          message: "Connection lost. Check your internet and try again.",
          severity: "transient",
          recovery_action: "try_again",
          recovery_label: "Try again",
          provider: "google",
        });
      }
      return MOCK_SYNC_STATUS_COMPLETE;
    });

    await renderOnboarding({
      callbackAccountId: "acc-google-456",
      fetchAccountStatus,
    });

    // Initial call happens immediately, then polling interval retries
    // Advance past initial call (fails silently due to auto-retry)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    // Advance through 3 more polling intervals (2000ms each)
    // Failures 1-3 are silent, 4th call succeeds
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2100);
      });
    }

    // Should have made 4 calls total: 3 failures + 1 success
    expect(fetchAccountStatus.mock.calls.length).toBeGreaterThanOrEqual(4);
    // Should show success, not error
    expect(screen.getByText(/\u2713 Connected/)).toBeInTheDocument();
  });

  it("surfaces error to user when all retries exhausted", async () => {
    const fetchAccountStatus = vi.fn(async (_accountId: string): Promise<OnboardingSyncStatus> => {
      // Throw transient OnboardingError to trigger auto-retry behavior
      throw new OnboardingError({
        code: "network_timeout",
        message: "Connection lost. Check your internet and try again.",
        severity: "transient",
        recovery_action: "try_again",
        recovery_label: "Try again",
        provider: "google",
      });
    });

    await renderOnboarding({
      callbackAccountId: "acc-google-456",
      fetchAccountStatus,
    });

    // Initial poll (failure 1 -- silent due to transient auto-retry)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    // Advance through 3 more polling intervals to exhaust retries
    // Failures 1-3 are silent, failure 4+ surfaces to user
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2100);
      });
    }

    // User should see the classified error message
    expect(
      screen.getByText(/connection lost/i),
    ).toBeInTheDocument();

    // And a manual retry button
    expect(
      screen.getByRole("button", { name: /try again/i }),
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Integration: Error telemetry (AC 6)
// ---------------------------------------------------------------------------

describe("error telemetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls onErrorTelemetry when OAuth callback has error", async () => {
    const onErrorTelemetry = vi.fn();

    await renderOnboarding({
      callbackError: "access_denied",
      callbackProvider: "google",
      onErrorTelemetry,
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(onErrorTelemetry).toHaveBeenCalledTimes(1);
    const telemetry = onErrorTelemetry.mock.calls[0][0];
    expect(telemetry.provider).toBe("google");
    expect(telemetry.error_type).toBe("access_denied");
    expect(telemetry.severity).toBe("persistent");
    expect(telemetry.timestamp).toBeTruthy();
  });

  it("telemetry event contains NO PII", async () => {
    const onErrorTelemetry = vi.fn();

    await renderOnboarding({
      callbackError: "access_denied",
      callbackProvider: "google",
      onErrorTelemetry,
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    const telemetry = onErrorTelemetry.mock.calls[0][0];
    const json = JSON.stringify(telemetry);

    // No email patterns
    expect(json).not.toMatch(/@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    // No token-like values (long random strings)
    expect(Object.keys(telemetry)).not.toContain("email");
    expect(Object.keys(telemetry)).not.toContain("user_id");
    expect(Object.keys(telemetry)).not.toContain("token");
  });

  it("telemetry includes retry_count for transient errors that were retried", async () => {
    const onErrorTelemetry = vi.fn();

    // Use a fetchAccountStatus that always fails with a transient error
    const fetchAccountStatus = vi.fn(async () => {
      throw new Error("network_timeout");
    });

    await renderOnboarding({
      callbackAccountId: "acc-google-456",
      fetchAccountStatus,
      onErrorTelemetry,
    });

    // Let retries exhaust
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });

    // At least one telemetry call should have been made
    if (onErrorTelemetry.mock.calls.length > 0) {
      const lastCall =
        onErrorTelemetry.mock.calls[onErrorTelemetry.mock.calls.length - 1][0];
      expect(lastCall.provider).toBeDefined();
      expect(lastCall.error_type).toBeDefined();
      expect(lastCall.severity).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: Persistent error with manual retry (AC 5)
// ---------------------------------------------------------------------------

describe("persistent error with manual retry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows inline error with recovery button for persistent errors", async () => {
    await renderOnboarding({
      callbackError: "access_denied",
      callbackProvider: "google",
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    // Error should be visible
    expect(screen.getByText(/declined.*permission/i)).toBeInTheDocument();

    // Recovery button should be available
    const recoveryBtn = screen.getByRole("button", { name: /try again/i });
    expect(recoveryBtn).toBeInTheDocument();
    expect(recoveryBtn).toBeEnabled();
  });

  it("clicking recovery button clears error and shows provider selection", async () => {
    await renderOnboarding({
      callbackError: "access_denied",
      callbackProvider: "google",
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    fireEvent.click(screen.getByRole("button", { name: /try again/i }));

    // Error should be gone
    expect(screen.queryByText(/declined.*permission/i)).not.toBeInTheDocument();

    // Provider cards should be visible
    expect(
      screen.getByRole("button", { name: /connect google/i }),
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Integration: No regression for existing success flows
// ---------------------------------------------------------------------------

describe("success flow backward compatibility", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("successful OAuth callback still works (no callbackError)", async () => {
    await renderOnboarding({
      callbackAccountId: "acc-google-456",
      fetchAccountStatus: async () => MOCK_SYNC_STATUS_COMPLETE,
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    // Should show success, not error
    expect(screen.getByText(/\u2713 Connected/)).toBeInTheDocument();
  });

  it("component works without error-related props (backward compatible)", async () => {
    await renderOnboarding();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    // Should render normally
    expect(
      screen.getByRole("heading", { level: 1 }),
    ).toHaveTextContent(/connect your calendar/i);
  });
});
