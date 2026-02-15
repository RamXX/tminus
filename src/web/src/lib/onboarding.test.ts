/**
 * Unit tests for onboarding helpers.
 *
 * Covers:
 * - OAuth URL construction with user_id, redirect_uri, and custom base URL
 * - OAuth callback URL parsing (extracting account_id from hash-based URL)
 * - Sync completion detection logic
 * - Provider definitions (Google enabled, Microsoft disabled)
 */
import { describe, it, expect } from "vitest";
import {
  buildOnboardingOAuthUrl,
  parseOAuthCallback,
  isSyncComplete,
  PROVIDERS,
  OAUTH_BASE_URL,
  SYNC_POLL_INTERVAL_MS,
  SYNC_POLL_TIMEOUT_MS,
  type OnboardingSyncStatus,
} from "./onboarding";

// ---------------------------------------------------------------------------
// buildOnboardingOAuthUrl
// ---------------------------------------------------------------------------

describe("buildOnboardingOAuthUrl", () => {
  it("builds correct Google OAuth URL with user_id and redirect_uri", () => {
    const url = buildOnboardingOAuthUrl(
      "google",
      "user-abc",
      "https://app.tminus.ink/#/onboard",
    );

    const parsed = new URL(url);
    expect(parsed.origin).toBe(OAUTH_BASE_URL);
    expect(parsed.pathname).toBe("/oauth/google/start");
    expect(parsed.searchParams.get("user_id")).toBe("user-abc");
    expect(parsed.searchParams.get("redirect_uri")).toBe(
      "https://app.tminus.ink/#/onboard",
    );
  });

  it("builds correct Microsoft OAuth URL", () => {
    const url = buildOnboardingOAuthUrl(
      "microsoft",
      "user-xyz",
      "https://app.tminus.ink/#/onboard",
    );

    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/oauth/microsoft/start");
    expect(parsed.searchParams.get("user_id")).toBe("user-xyz");
  });

  it("supports custom OAuth base URL for testing", () => {
    const url = buildOnboardingOAuthUrl(
      "google",
      "user-test",
      "http://localhost:3000/#/onboard",
      "http://localhost:8787",
    );

    const parsed = new URL(url);
    expect(parsed.origin).toBe("http://localhost:8787");
    expect(parsed.pathname).toBe("/oauth/google/start");
  });
});

// ---------------------------------------------------------------------------
// parseOAuthCallback
// ---------------------------------------------------------------------------

describe("parseOAuthCallback", () => {
  it("extracts account_id from hash-based callback URL", () => {
    const result = parseOAuthCallback(
      "https://app.tminus.ink/#/onboard?account_id=acc-google-123",
    );
    expect(result.accountId).toBe("acc-google-123");
    expect(result.reactivated).toBe(false);
  });

  it("extracts reactivated flag", () => {
    const result = parseOAuthCallback(
      "https://app.tminus.ink/#/onboard?account_id=acc-123&reactivated=true",
    );
    expect(result.accountId).toBe("acc-123");
    expect(result.reactivated).toBe(true);
  });

  it("returns null for URL without account_id", () => {
    const result = parseOAuthCallback("https://app.tminus.ink/#/onboard");
    expect(result.accountId).toBeNull();
  });

  it("returns null for URL without hash", () => {
    const result = parseOAuthCallback("https://app.tminus.ink/");
    expect(result.accountId).toBeNull();
  });

  it("returns null for invalid URL", () => {
    const result = parseOAuthCallback("not-a-url");
    expect(result.accountId).toBeNull();
  });

  it("handles hash with only path, no query params", () => {
    const result = parseOAuthCallback("https://app.tminus.ink/#/onboard");
    expect(result.accountId).toBeNull();
    expect(result.reactivated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isSyncComplete
// ---------------------------------------------------------------------------

describe("isSyncComplete", () => {
  const baseStatus: OnboardingSyncStatus = {
    account_id: "acc-123",
    email: "user@gmail.com",
    provider: "google",
    status: "active",
    health: {
      lastSyncTs: "2026-02-15T12:00:00Z",
      lastSuccessTs: "2026-02-15T12:00:00Z",
      fullSyncNeeded: false,
    },
  };

  it("returns true when account is active with successful sync", () => {
    expect(isSyncComplete(baseStatus)).toBe(true);
  });

  it("returns false when account status is not active", () => {
    expect(isSyncComplete({ ...baseStatus, status: "pending" })).toBe(false);
  });

  it("returns false when health info is null", () => {
    expect(isSyncComplete({ ...baseStatus, health: null })).toBe(false);
  });

  it("returns false when lastSuccessTs is null (sync not yet completed)", () => {
    expect(
      isSyncComplete({
        ...baseStatus,
        health: {
          lastSyncTs: "2026-02-15T12:00:00Z",
          lastSuccessTs: null,
          fullSyncNeeded: true,
        },
      }),
    ).toBe(false);
  });

  it("returns false when status is error even with health data", () => {
    expect(isSyncComplete({ ...baseStatus, status: "error" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PROVIDERS constant
// ---------------------------------------------------------------------------

describe("PROVIDERS", () => {
  it("includes Google as enabled", () => {
    const google = PROVIDERS.find((p) => p.id === "google");
    expect(google).toBeDefined();
    expect(google!.enabled).toBe(true);
    expect(google!.label).toBe("Google Calendar");
  });

  it("includes Microsoft as disabled (coming soon)", () => {
    const microsoft = PROVIDERS.find((p) => p.id === "microsoft");
    expect(microsoft).toBeDefined();
    expect(microsoft!.enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("constants", () => {
  it("has reasonable polling interval (1-10 seconds)", () => {
    expect(SYNC_POLL_INTERVAL_MS).toBeGreaterThanOrEqual(1000);
    expect(SYNC_POLL_INTERVAL_MS).toBeLessThanOrEqual(10_000);
  });

  it("has reasonable polling timeout (30-120 seconds)", () => {
    expect(SYNC_POLL_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
    expect(SYNC_POLL_TIMEOUT_MS).toBeLessThanOrEqual(120_000);
  });
});
