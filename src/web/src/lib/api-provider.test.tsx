/**
 * Tests for ApiProvider and useApi hook.
 *
 * Unit tests (mocks OK):
 * - ApiProvider renders children
 * - useApi() throws when used outside provider
 * - useApi() provides all expected API function groups
 * - API functions throw "Not authenticated" when no token
 * - API functions call underlying API with token when authenticated
 *
 * Token refresh tests:
 * - decodeJwtPayload parses valid JWT
 * - decodeJwtPayload returns null for malformed tokens
 * - getTokenRefreshDelay calculates correct delay
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { ApiProvider, useApi } from "./api-provider";
import { AuthProvider } from "./auth";
import { decodeJwtPayload, getTokenRefreshDelay } from "./auth";

// ---------------------------------------------------------------------------
// Mock the API modules to avoid real fetch calls
// ---------------------------------------------------------------------------

vi.mock("./api", () => ({
  apiFetch: vi.fn(),
  fetchSyncStatus: vi.fn(),
  fetchAccounts: vi.fn().mockResolvedValue([]),
  fetchAccountDetail: vi.fn(),
  fetchEvents: vi.fn().mockResolvedValue([]),
  unlinkAccount: vi.fn(),
  fetchErrorMirrors: vi.fn(),
  retryMirror: vi.fn(),
  fetchBillingStatus: vi.fn(),
  createCheckoutSession: vi.fn(),
  createPortalSession: vi.fn(),
  fetchBillingHistory: vi.fn(),
  createSchedulingSession: vi.fn(),
  listSessions: vi.fn(),
  commitCandidate: vi.fn(),
  cancelSession: vi.fn(),
  fetchCommitments: vi.fn(),
  fetchVips: vi.fn(),
  addVip: vi.fn(),
  removeVip: vi.fn(),
  exportCommitmentProof: vi.fn(),
  fetchRelationships: vi.fn(),
  createRelationship: vi.fn(),
  fetchRelationship: vi.fn(),
  updateRelationship: vi.fn(),
  deleteRelationship: vi.fn(),
  fetchReputation: vi.fn(),
  fetchOutcomes: vi.fn(),
  createOutcome: vi.fn(),
  fetchDriftReport: vi.fn(),
  fetchReconnectionSuggestionsFull: vi.fn(),
  fetchUpcomingMilestones: vi.fn(),
  fetchAccountsHealth: vi.fn(),
  reconnectAccount: vi.fn(),
  removeAccount: vi.fn(),
  fetchSyncHistory: vi.fn(),
  fetchEventBriefing: vi.fn(),
  generateExcuse: vi.fn(),
  createEvent: vi.fn(),
  updateEvent: vi.fn(),
  deleteEvent: vi.fn(),
  createOnboardingSession: vi.fn(),
  getOnboardingSession: vi.fn(),
  getOnboardingStatus: vi.fn(),
  addOnboardingAccount: vi.fn(),
  completeOnboardingSession: vi.fn(),
}));

vi.mock("./policies", () => ({
  fetchPolicies: vi.fn(),
  updatePolicyEdge: vi.fn(),
}));

vi.mock("./admin", () => ({
  fetchOrgDetails: vi.fn(),
  fetchOrgMembers: vi.fn(),
  addOrgMember: vi.fn(),
  removeOrgMember: vi.fn(),
  changeOrgMemberRole: vi.fn(),
  fetchOrgPolicies: vi.fn(),
  createOrgPolicy: vi.fn(),
  updateOrgPolicy: vi.fn(),
  deleteOrgPolicy: vi.fn(),
  fetchOrgUsage: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AUTH_STORAGE_KEY = "tminus_auth_v1";

function setAuthState(token: string | null, refreshToken: string | null = "refresh-tok") {
  if (token) {
    window.sessionStorage.setItem(
      AUTH_STORAGE_KEY,
      JSON.stringify({
        token,
        refreshToken,
        user: { id: "user-1", email: "test@example.com" },
      }),
    );
  } else {
    window.sessionStorage.removeItem(AUTH_STORAGE_KEY);
  }
}

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <AuthProvider>
      <ApiProvider>{children}</ApiProvider>
    </AuthProvider>
  );
}

function UnauthenticatedWrapper({ children }: { children: ReactNode }) {
  return (
    <AuthProvider>
      <ApiProvider>{children}</ApiProvider>
    </AuthProvider>
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ApiProvider", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it("renders children", () => {
    render(
      <Wrapper>
        <div data-testid="child">Hello</div>
      </Wrapper>,
    );
    expect(screen.getByTestId("child")).toHaveTextContent("Hello");
  });

  it("useApi() throws when used outside ApiProvider", () => {
    // Suppress console.error for expected error
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    function BadComponent() {
      useApi();
      return null;
    }
    expect(() => render(<BadComponent />)).toThrow(
      "useApi must be used within ApiProvider",
    );
    spy.mockRestore();
  });

  describe("when authenticated", () => {
    beforeEach(() => {
      setAuthState("test-jwt-token");
    });

    it("provides all expected API function groups", () => {
      function Inspector() {
        const api = useApi();
        return (
          <div>
            <span data-testid="has-fetchSyncStatus">{String(typeof api.fetchSyncStatus === "function")}</span>
            <span data-testid="has-fetchAccounts">{String(typeof api.fetchAccounts === "function")}</span>
            <span data-testid="has-fetchPolicies">{String(typeof api.fetchPolicies === "function")}</span>
            <span data-testid="has-fetchErrors">{String(typeof api.fetchErrors === "function")}</span>
            <span data-testid="has-fetchBillingStatus">{String(typeof api.fetchBillingStatus === "function")}</span>
            <span data-testid="has-listSessions">{String(typeof api.listSessions === "function")}</span>
            <span data-testid="has-fetchCommitments">{String(typeof api.fetchCommitments === "function")}</span>
            <span data-testid="has-fetchRelationships">{String(typeof api.fetchRelationships === "function")}</span>
            <span data-testid="has-fetchReconnectionSuggestions">{String(typeof api.fetchReconnectionSuggestions === "function")}</span>
            <span data-testid="has-fetchOrgDetails">{String(typeof api.fetchOrgDetails === "function")}</span>
            <span data-testid="has-fetchAccountStatus">{String(typeof api.fetchAccountStatus === "function")}</span>
            <span data-testid="has-fetchAccountsHealth">{String(typeof api.fetchAccountsHealth === "function")}</span>
            <span data-testid="has-fetchEventsFull">{String(typeof api.fetchEventsFull === "function")}</span>
          </div>
        );
      }

      render(
        <Wrapper>
          <Inspector />
        </Wrapper>,
      );

      const groups = [
        "fetchSyncStatus", "fetchAccounts", "fetchPolicies", "fetchErrors",
        "fetchBillingStatus", "listSessions", "fetchCommitments",
        "fetchRelationships", "fetchReconnectionSuggestions", "fetchOrgDetails",
        "fetchAccountStatus", "fetchAccountsHealth", "fetchEventsFull",
      ];

      for (const name of groups) {
        expect(screen.getByTestId(`has-${name}`)).toHaveTextContent("true");
      }
    });

    it("API functions are callable", async () => {
      const { fetchAccounts } = await import("./api");
      (fetchAccounts as ReturnType<typeof vi.fn>).mockResolvedValue([
        { account_id: "acc-1", email: "test@test.com", provider: "google", status: "active" },
      ]);

      let api: ReturnType<typeof useApi>;
      function Capture() {
        api = useApi();
        return null;
      }

      render(
        <Wrapper>
          <Capture />
        </Wrapper>,
      );

      const result = await api!.fetchAccounts();
      expect(result).toHaveLength(1);
      expect(result[0].account_id).toBe("acc-1");
    });
  });

  describe("when NOT authenticated", () => {
    beforeEach(() => {
      setAuthState(null);
    });

    it("API functions throw 'Not authenticated'", () => {
      let api: ReturnType<typeof useApi>;
      function Capture() {
        api = useApi();
        return null;
      }

      render(
        <UnauthenticatedWrapper>
          <Capture />
        </UnauthenticatedWrapper>,
      );

      // requireToken() throws synchronously before the async API call,
      // so the returned promise is rejected immediately.
      expect(() => api!.fetchAccounts()).toThrow("Not authenticated");
      expect(() => api!.fetchSyncStatus()).toThrow("Not authenticated");
      expect(() => api!.fetchBillingStatus()).toThrow("Not authenticated");
    });
  });
});

// ---------------------------------------------------------------------------
// Token refresh helpers (unit tests)
// ---------------------------------------------------------------------------

describe("decodeJwtPayload", () => {
  it("decodes a valid JWT payload", () => {
    // Create a JWT with payload { "sub": "user-1", "exp": 1700000000, "iat": 1699990000 }
    const payload = btoa(JSON.stringify({ sub: "user-1", exp: 1700000000, iat: 1699990000 }));
    const token = `header.${payload}.signature`;
    const result = decodeJwtPayload(token);
    expect(result).toEqual({ sub: "user-1", exp: 1700000000, iat: 1699990000 });
  });

  it("returns null for malformed token (not 3 parts)", () => {
    expect(decodeJwtPayload("not-a-jwt")).toBeNull();
    expect(decodeJwtPayload("two.parts")).toBeNull();
  });

  it("returns null for invalid base64", () => {
    expect(decodeJwtPayload("a.!!!.c")).toBeNull();
  });

  it("handles base64url encoding (- and _)", () => {
    // Payload with characters that differ between base64 and base64url
    const payload = { test: "a+b/c" };
    const base64 = btoa(JSON.stringify(payload));
    const base64url = base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const token = `header.${base64url}.signature`;
    const result = decodeJwtPayload(token);
    expect(result).toEqual(payload);
  });
});

describe("getTokenRefreshDelay", () => {
  it("calculates delay based on exp and iat", () => {
    const now = Math.floor(Date.now() / 1000);
    const iat = now - 100; // issued 100 seconds ago
    const exp = now + 900; // expires in 900 seconds (total lifetime 1000s)
    const payload = btoa(JSON.stringify({ exp, iat }));
    const token = `h.${payload}.s`;

    const delay = getTokenRefreshDelay(token);
    expect(delay).not.toBeNull();

    // Expected refresh at: iat + 1000 * 0.8 = iat + 800
    // Delay from now: (iat + 800) - now = (now - 100 + 800) - now = 700 seconds
    // Allow margin for timing differences during test execution
    expect(delay).not.toBeNull();
    const delaySec = delay! / 1000;
    expect(delaySec).toBeGreaterThan(698);
    expect(delaySec).toBeLessThan(702);
  });

  it("returns minimum delay for near-expiry tokens", () => {
    const now = Math.floor(Date.now() / 1000);
    const iat = now - 990;
    const exp = now + 1; // expires in 1 second
    const payload = btoa(JSON.stringify({ exp, iat }));
    const token = `h.${payload}.s`;

    const delay = getTokenRefreshDelay(token);
    expect(delay).toBe(1000); // MIN_REFRESH_DELAY_MS
  });

  it("returns null for malformed token", () => {
    expect(getTokenRefreshDelay("not-a-jwt")).toBeNull();
  });

  it("uses fallback when no exp claim", () => {
    const payload = btoa(JSON.stringify({ sub: "user-1" }));
    const token = `h.${payload}.s`;

    const delay = getTokenRefreshDelay(token);
    // FALLBACK_TOKEN_LIFETIME_MS * 0.8 = 15 * 60 * 1000 * 0.8 = 720000
    expect(delay).toBe(720000);
  });
});
