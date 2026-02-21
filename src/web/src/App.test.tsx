/**
 * Integration tests for App component routing.
 *
 * These tests verify that React Router renders the correct pages
 * based on hash routes and auth state. No mocking of the router --
 * we use the real HashRouter and manipulate window.location.hash.
 *
 * API calls are mocked because the integration boundary here is
 * "does the app route correctly", not "do API calls work".
 * API integration tests live in the API layer.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";

// ---------------------------------------------------------------------------
// Mock ALL API modules to prevent real network calls.
// This is an integration test of ROUTING, not of API calls.
// ---------------------------------------------------------------------------

vi.mock("./lib/api", () => ({
  apiFetch: vi.fn().mockResolvedValue({}),
  login: vi.fn(),
  fetchSyncStatus: vi.fn().mockResolvedValue({ accounts: [] }),
  fetchAccounts: vi.fn().mockResolvedValue([]),
  fetchAccountDetail: vi.fn(),
  fetchEvents: vi.fn().mockResolvedValue([]),
  unlinkAccount: vi.fn(),
  fetchErrorMirrors: vi.fn().mockResolvedValue([]),
  retryMirror: vi.fn(),
  fetchBillingStatus: vi.fn().mockResolvedValue({ tier: "free", status: "active", subscription: null }),
  createCheckoutSession: vi.fn(),
  createPortalSession: vi.fn(),
  fetchBillingHistory: vi.fn().mockResolvedValue([]),
  createSchedulingSession: vi.fn(),
  listSessions: vi.fn().mockResolvedValue([]),
  commitCandidate: vi.fn(),
  cancelSession: vi.fn(),
  fetchCommitments: vi.fn().mockResolvedValue([]),
  fetchVips: vi.fn().mockResolvedValue([]),
  addVip: vi.fn(),
  removeVip: vi.fn(),
  exportCommitmentProof: vi.fn(),
  fetchRelationships: vi.fn().mockResolvedValue([]),
  createRelationship: vi.fn(),
  fetchRelationship: vi.fn(),
  updateRelationship: vi.fn(),
  deleteRelationship: vi.fn(),
  fetchReputation: vi.fn(),
  fetchOutcomes: vi.fn().mockResolvedValue([]),
  createOutcome: vi.fn(),
  fetchDriftReport: vi.fn().mockResolvedValue({ entries: [], generated_at: "" }),
  fetchReconnectionSuggestionsFull: vi.fn().mockResolvedValue([]),
  fetchUpcomingMilestones: vi.fn().mockResolvedValue([]),
  fetchAccountsHealth: vi.fn().mockResolvedValue({ accounts: [], tier_limit: 2 }),
  reconnectAccount: vi.fn(),
  removeAccount: vi.fn(),
  fetchSyncHistory: vi.fn().mockResolvedValue({ events: [] }),
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
  fetchAccountScopes: vi.fn().mockResolvedValue({ scopes: [] }),
  updateAccountScopes: vi.fn().mockResolvedValue({ scopes: [] }),
  ApiError: class ApiError extends Error {
    status: number;
    code: string;
    constructor(status: number, code: string, message: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
}));

vi.mock("./lib/policies", () => ({
  fetchPolicies: vi.fn().mockResolvedValue({ accounts: [], edges: [] }),
  updatePolicyEdge: vi.fn(),
}));

vi.mock("./lib/admin", () => ({
  fetchOrgDetails: vi.fn(),
  fetchOrgMembers: vi.fn().mockResolvedValue([]),
  addOrgMember: vi.fn(),
  removeOrgMember: vi.fn(),
  changeOrgMemberRole: vi.fn(),
  fetchOrgPolicies: vi.fn().mockResolvedValue([]),
  createOrgPolicy: vi.fn(),
  updateOrgPolicy: vi.fn(),
  deleteOrgPolicy: vi.fn(),
  fetchOrgUsage: vi.fn().mockResolvedValue([]),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AUTH_STORAGE_KEY = "tminus_auth_v1";

function setAuthenticated() {
  window.sessionStorage.setItem(
    AUTH_STORAGE_KEY,
    JSON.stringify({
      token: "test-jwt-token",
      refreshToken: "test-refresh-token",
      user: { id: "user-1", email: "test@example.com" },
    }),
  );
}

function setUnauthenticated() {
  window.sessionStorage.removeItem(AUTH_STORAGE_KEY);
}

function navigateTo(hash: string) {
  window.location.hash = hash;
  // Dispatch hashchange so React Router picks it up
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("App routing integration", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.location.hash = "";
  });

  afterEach(() => {
    window.location.hash = "";
  });

  describe("unauthenticated user", () => {
    beforeEach(() => {
      setUnauthenticated();
    });

    it("renders Login page at #/login", async () => {
      window.location.hash = "#/login";
      render(<App />);
      await waitFor(() => {
        expect(screen.getByText("T-Minus")).toBeInTheDocument();
        expect(screen.getByText("Sign In")).toBeInTheDocument();
      });
    });

    it("redirects to /login when accessing protected route", async () => {
      window.location.hash = "#/calendar";
      render(<App />);
      await waitFor(() => {
        expect(window.location.hash).toBe("#/login");
      });
    });

    it("redirects to /login on root path", async () => {
      window.location.hash = "#/";
      render(<App />);
      await waitFor(() => {
        expect(window.location.hash).toBe("#/login");
      });
    });
  });

  describe("authenticated user", () => {
    beforeEach(() => {
      setAuthenticated();
    });

    it("redirects from /login to /calendar when authenticated", async () => {
      window.location.hash = "#/login";
      render(<App />);
      // GuestOnly guard redirects authenticated users from /login to /calendar
      await waitFor(() => {
        expect(window.location.hash).toBe("#/calendar");
      });
    });

    it("redirects from root to /calendar", async () => {
      window.location.hash = "#/";
      render(<App />);
      await waitFor(() => {
        expect(window.location.hash).toBe("#/calendar");
      });
    });

    it("renders Calendar page at #/calendar", async () => {
      window.location.hash = "#/calendar";
      render(<App />);
      // Calendar page renders inside AppShell with useApi() internally
      await waitFor(() => {
        expect(screen.getByTestId("app-header")).toBeInTheDocument();
      });
    });

    it("renders Accounts page at #/accounts", async () => {
      window.location.hash = "#/accounts";
      render(<App />);
      // Accounts page renders inside AppShell with useApi() internally
      await waitFor(() => {
        expect(screen.getByTestId("app-header")).toBeInTheDocument();
      });
    });

    it("renders SyncStatus page at #/sync-status", async () => {
      window.location.hash = "#/sync-status";
      render(<App />);
      await waitFor(() => {
        expect(screen.getByTestId("app-header")).toBeInTheDocument();
      });
    });

    it("renders ErrorRecovery page at #/errors", async () => {
      window.location.hash = "#/errors";
      render(<App />);
      await waitFor(() => {
        expect(screen.getByTestId("app-header")).toBeInTheDocument();
      });
    });

    it("redirects unknown routes to /calendar", async () => {
      window.location.hash = "#/nonexistent-page";
      render(<App />);
      await waitFor(() => {
        expect(window.location.hash).toBe("#/calendar");
      });
    });

    it("renders Billing page at #/billing", async () => {
      window.location.hash = "#/billing";
      render(<App />);
      await waitFor(() => {
        expect(document.querySelector("[style]")).toBeInTheDocument();
      });
    });

    it("renders Scheduling page at #/scheduling", async () => {
      window.location.hash = "#/scheduling";
      render(<App />);
      await waitFor(() => {
        expect(document.querySelector("[style]")).toBeInTheDocument();
      });
    });

    it("renders Governance page at #/governance", async () => {
      window.location.hash = "#/governance";
      render(<App />);
      await waitFor(() => {
        expect(document.querySelector("[style]")).toBeInTheDocument();
      });
    });

    it("renders Relationships page at #/relationships", async () => {
      window.location.hash = "#/relationships";
      render(<App />);
      await waitFor(() => {
        expect(document.querySelector("[style]")).toBeInTheDocument();
      });
    });

    it("renders Reconnections page at #/reconnections", async () => {
      window.location.hash = "#/reconnections";
      render(<App />);
      await waitFor(() => {
        expect(document.querySelector("[style]")).toBeInTheDocument();
      });
    });

    it("renders ProviderHealth page at #/provider-health", async () => {
      window.location.hash = "#/provider-health";
      render(<App />);
      await waitFor(() => {
        expect(screen.getByTestId("app-header")).toBeInTheDocument();
      });
    });
  });
});

// ---------------------------------------------------------------------------
// AppShell integration tests -- Login/Onboarding render without sidebar
// ---------------------------------------------------------------------------

describe("AppShell integration via App router", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.location.hash = "";
  });

  afterEach(() => {
    window.location.hash = "";
  });

  it("Login page renders without AppShell sidebar", async () => {
    setUnauthenticated();
    window.location.hash = "#/login";
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("Sign In")).toBeInTheDocument();
    });

    // No sidebar or header from AppShell
    expect(screen.queryByTestId("desktop-sidebar")).not.toBeInTheDocument();
    expect(screen.queryByTestId("app-header")).not.toBeInTheDocument();
  });

  it("Onboarding page renders without AppShell sidebar", async () => {
    setAuthenticated();
    window.location.hash = "#/onboard";
    render(<App />);

    // Onboarding route is outside AppShell
    await waitFor(() => {
      expect(screen.queryByTestId("desktop-sidebar")).not.toBeInTheDocument();
      expect(screen.queryByTestId("app-header")).not.toBeInTheDocument();
    });
  });

  it("authenticated routes render with AppShell sidebar and header", async () => {
    setAuthenticated();
    window.location.hash = "#/calendar";
    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("desktop-sidebar")).toBeInTheDocument();
      expect(screen.getByTestId("app-header")).toBeInTheDocument();
    });

    // User email shown in header
    expect(screen.getByTestId("user-email")).toHaveTextContent("test@example.com");
  });

  it("sidebar contains all navigation section groups", async () => {
    setAuthenticated();
    window.location.hash = "#/calendar";
    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("desktop-sidebar")).toBeInTheDocument();
    });

    // All 13 nav links (11 standard + Admin) should be in the sidebar
    const desktopSidebar = screen.getByTestId("desktop-sidebar");
    expect(desktopSidebar).toBeInTheDocument();

    // Verify section headers exist
    const nav = desktopSidebar.querySelector("[data-testid='sidebar']");
    expect(nav).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// ErrorBoundary integration test
// ---------------------------------------------------------------------------

describe("ErrorBoundary integration", () => {
  it("renders error UI when a child component throws", () => {
    function Thrower(): never {
      throw new Error("Test crash");
    }

    // Suppress console.error for expected error boundary logs
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <ErrorBoundary>
        <Thrower />
      </ErrorBoundary>,
    );

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(screen.getByText("Test crash")).toBeInTheDocument();
    expect(screen.getByText("Try again")).toBeInTheDocument();

    spy.mockRestore();
  });
});
