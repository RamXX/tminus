/**
 * E2E Navigation Test Suite.
 *
 * Exercises the full App component tree to verify:
 * 1. Sidebar navigation: clicking each link navigates to the correct route
 * 2. Page rendering: every authenticated page renders its primary content
 * 3. AppShell structure: sidebar present when authenticated, absent on login
 * 4. Responsive behavior: hamburger menu toggles mobile sidebar visibility
 * 5. Logout flow: clicking logout redirects to /login and removes sidebar
 * 6. Auth guards: unauthenticated users redirected from all protected routes
 *
 * Mock strategy: global fetch is intercepted to return minimal API responses
 * for every endpoint. This lets each page render its loaded state without
 * hitting real network calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, act, fireEvent } from "@testing-library/react";
import { App } from "./App";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NOW = new Date("2026-02-14T12:00:00Z").getTime();

const TEST_TOKEN = "test-jwt-token-nav-e2e";
const TEST_USER = { id: "user-001", email: "nav-test@example.com", tier: "pro" };

// Minimal mock data -- just enough for each page to render its loaded state

const MOCK_EVENTS = [
  {
    canonical_event_id: "evt-001",
    summary: "Team Standup",
    start: "2026-02-14T09:00:00Z",
    end: "2026-02-14T09:30:00Z",
    origin_account_id: "acc-work",
    origin_account_email: "work@example.com",
    status: "confirmed",
    version: 1,
    updated_at: "2026-02-14T08:00:00Z",
    mirrors: [],
  },
];

const MOCK_ACCOUNTS = [
  {
    account_id: "acc-work",
    email: "work@example.com",
    provider: "google" as const,
    status: "active" as const,
  },
];

const MOCK_ACCOUNTS_HEALTH_DATA = [
  {
    account_id: "acc-work",
    email: "work@example.com",
    provider: "google",
    status: "active",
    calendar_count: 3,
    calendar_names: ["Work"],
    last_successful_sync: new Date(NOW - 5 * 60 * 1000).toISOString(),
    is_syncing: false,
    error_message: null,
    token_expires_at: new Date(NOW + 60 * 60 * 1000).toISOString(),
    created_at: new Date(NOW - 7 * 24 * 60 * 60 * 1000).toISOString(),
  },
];

const MOCK_SYNC_STATUS = {
  accounts: [
    {
      account_id: "acc-work",
      email: "work@example.com",
      provider: "google",
      status: "active",
      last_sync_ts: new Date(NOW - 3 * 60 * 1000).toISOString(),
      channel_status: "active",
      pending_writes: 0,
      error_count: 0,
    },
  ],
};

const MOCK_POLICIES = [
  { policy_id: "pol-001", name: "Default Policy", is_default: 1 },
];

const MOCK_POLICY_DETAIL = {
  policy_id: "pol-001",
  edges: [
    {
      policy_id: "pol-001",
      from_account_id: "acc-work",
      to_account_id: "acc-personal",
      detail_level: "BUSY" as const,
      calendar_kind: "BUSY_OVERLAY" as const,
    },
  ],
};

const MOCK_ERROR_MIRRORS = [
  {
    mirror_id: "mirror-err-001",
    canonical_event_id: "evt-002",
    target_account_id: "acc-work",
    target_account_email: "work@example.com",
    error_message: "API rate limit exceeded",
    error_ts: "2026-02-14T11:55:00Z",
    event_summary: "Some Meeting",
  },
];

const MOCK_BILLING_STATUS = {
  tier: "pro",
  status: "active",
  accounts_used: 1,
  accounts_limit: 5,
  stripe_customer_id: "cus_test",
  current_period_end: "2026-03-14T00:00:00Z",
};

const MOCK_BILLING_EVENTS: unknown[] = [];

const MOCK_SCHEDULING_SESSIONS: unknown[] = [];

const MOCK_COMMITMENTS: unknown[] = [];

const MOCK_VIPS: unknown[] = [];

const MOCK_RELATIONSHIPS = [
  {
    id: "rel_01",
    name: "Sarah Chen",
    email: "sarah@example.com",
    category: "professional",
    city: "San Francisco",
    timezone: "America/Los_Angeles",
    frequency_days: 7,
    last_interaction: "2026-02-14T12:00:00Z",
    drift_level: "green",
    reliability_score: 95,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-02-14T12:00:00Z",
  },
];

const MOCK_RECONNECTION_SUGGESTIONS: unknown[] = [];
const MOCK_UPCOMING_MILESTONES: unknown[] = [];

const MOCK_DRIFT_ALERTS: unknown[] = [];

// ---------------------------------------------------------------------------
// Mock fetch handler
// ---------------------------------------------------------------------------

/**
 * Comprehensive route-based mock fetch. Returns minimal valid data for every
 * API endpoint that any page in the app may call during its initial render.
 */
function createMockFetch() {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];

  /**
   * Controls the shape of the /api/v1/accounts response.
   *
   * Both fetchAccounts() (Accounts page) and fetchAccountsHealth()
   * (ProviderHealth page) call the same URL /api/v1/accounts via apiFetch().
   * But they expect different response shapes:
   *   - "list": returns LinkedAccount[] (for Accounts page)
   *   - "health": returns {accounts, account_count, tier_limit} (for ProviderHealth)
   *
   * Tests set this before navigating to the appropriate page.
   */
  let accountsMode: "list" | "health" = "list";

  const setAccountsMode = (mode: "list" | "health") => {
    accountsMode = mode;
  };

  const mockFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const bodyStr = init?.body ? String(init.body) : undefined;
    const body = bodyStr ? (() => { try { return JSON.parse(bodyStr); } catch { return undefined; } })() : undefined;

    calls.push({ url, method, body });

    // -- Auth --
    if (url === "/api/v1/auth/login" && method === "POST") {
      if (body?.email === "nav-test@example.com" && body?.password === "password123") {
        return mockResponse(200, {
          ok: true,
          data: {
            user: TEST_USER,
            access_token: TEST_TOKEN,
            refresh_token: "refresh-token-nav",
          },
        });
      }
      return mockResponse(401, {
        ok: false,
        error: { code: "AUTH_FAILED", message: "Invalid credentials" },
      });
    }

    // -- Events --
    if (url.match(/^\/api\/v1\/events\/[^/]+\/briefing$/) && method === "GET") {
      return mockResponse(200, {
        ok: true,
        data: {
          event_id: "evt-001",
          event_title: "Team Standup",
          event_start: "2026-02-14T09:00:00Z",
          topics: [],
          participants: [],
          computed_at: new Date(NOW).toISOString(),
        },
      });
    }
    if (url.startsWith("/api/v1/events") && method === "GET") {
      return mockResponse(200, { ok: true, data: MOCK_EVENTS });
    }

    // -- Accounts --
    // Returns different shapes depending on accountsMode (see comment above).
    if (url === "/api/v1/accounts" && method === "GET") {
      if (accountsMode === "health") {
        return mockResponse(200, {
          ok: true,
          data: {
            accounts: MOCK_ACCOUNTS_HEALTH_DATA,
            account_count: MOCK_ACCOUNTS_HEALTH_DATA.length,
            tier_limit: 5,
          },
        });
      }
      return mockResponse(200, { ok: true, data: MOCK_ACCOUNTS });
    }

    // -- Sync status --
    if (url === "/api/v1/sync/status" && method === "GET") {
      return mockResponse(200, { ok: true, data: MOCK_SYNC_STATUS });
    }

    // -- Policies --
    if (url === "/api/v1/policies" && method === "GET") {
      return mockResponse(200, { ok: true, data: MOCK_POLICIES });
    }
    if (url.match(/^\/api\/v1\/policies\/[^/]+$/) && method === "GET") {
      return mockResponse(200, { ok: true, data: MOCK_POLICY_DETAIL });
    }

    // -- Error recovery --
    if (url.includes("/api/v1/sync/journal") && method === "GET") {
      return mockResponse(200, { ok: true, data: MOCK_ERROR_MIRRORS });
    }

    // -- Billing --
    if (url === "/api/v1/billing/status" && method === "GET") {
      return mockResponse(200, { ok: true, data: MOCK_BILLING_STATUS });
    }
    if (url === "/api/v1/billing/events" && method === "GET") {
      return mockResponse(200, { ok: true, data: MOCK_BILLING_EVENTS });
    }

    // -- Scheduling --
    if (url === "/api/v1/scheduling/sessions" && method === "GET") {
      return mockResponse(200, { ok: true, data: MOCK_SCHEDULING_SESSIONS });
    }

    // -- Governance --
    if (url === "/api/v1/commitments" && method === "GET") {
      return mockResponse(200, { ok: true, data: MOCK_COMMITMENTS });
    }
    if (url === "/api/v1/vips" && method === "GET") {
      return mockResponse(200, { ok: true, data: MOCK_VIPS });
    }

    // -- Relationships --
    if (url.match(/^\/api\/v1\/relationships(\?.*)?$/) && method === "GET") {
      return mockResponse(200, { ok: true, data: MOCK_RELATIONSHIPS });
    }

    // -- Reconnections --
    if (url.startsWith("/api/v1/reconnection-suggestions") && method === "GET") {
      return mockResponse(200, { ok: true, data: MOCK_RECONNECTION_SUGGESTIONS });
    }
    if (url.startsWith("/api/v1/milestones") && method === "GET") {
      return mockResponse(200, { ok: true, data: MOCK_UPCOMING_MILESTONES });
    }

    // -- Drift alerts --
    if (url === "/api/v1/drift-alerts" && method === "GET") {
      return mockResponse(200, { ok: true, data: MOCK_DRIFT_ALERTS });
    }

    // -- Drift report --
    if (url === "/api/v1/drift-report" && method === "GET") {
      return mockResponse(200, { ok: true, data: { entries: [], generated_at: new Date(NOW).toISOString() } });
    }

    // Fallback
    return mockResponse(404, { ok: false, error: `Not found: ${method} ${url}` });
  });

  return { mockFetch, calls, setAccountsMode };
}

function mockResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: new Headers(),
    redirected: false,
    statusText: status === 200 ? "OK" : "Error",
    type: "basic" as ResponseType,
    url: "",
    clone: () => mockResponse(status, body),
    body: null,
    bodyUsed: false,
    arrayBuffer: async () => new ArrayBuffer(0),
    blob: async () => new Blob(),
    formData: async () => new FormData(),
    text: async () => JSON.stringify(body),
    bytes: async () => new Uint8Array(),
  } as Response;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Navigate to a hash route and flush the component update cycle.
 */
async function navigateTo(hash: string) {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

/**
 * Log in via the login form and wait for redirect to calendar.
 */
async function performLogin() {
  fireEvent.change(screen.getByLabelText("Email"), {
    target: { value: "nav-test@example.com" },
  });
  fireEvent.change(screen.getByLabelText("Password"), {
    target: { value: "password123" },
  });
  fireEvent.click(screen.getByRole("button", { name: /sign in/i }));

  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

/**
 * Render the App, flush initial render, then log in and land on calendar.
 */
async function renderAndLogin() {
  render(<App />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  await performLogin();
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let mockFetchData: ReturnType<typeof createMockFetch>;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  window.location.hash = "#/login";
  mockFetchData = createMockFetch();
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetchData.mockFetch;
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
  window.location.hash = "";
});

// ---------------------------------------------------------------------------
// E2E Navigation Tests
// ---------------------------------------------------------------------------

describe("E2E Navigation -- AppShell, sidebar, and page rendering", () => {

  // =========================================================================
  // AC 1: AppShell structure after login
  // =========================================================================
  describe("AC 1: AppShell renders with sidebar navigation after login", () => {
    it("shows desktop sidebar with navigation after login", async () => {
      await renderAndLogin();

      const sidebar = screen.getByTestId("desktop-sidebar");
      expect(sidebar).toBeInTheDocument();
    });

    it("shows app header with user email and logout button", async () => {
      await renderAndLogin();

      const header = screen.getByTestId("app-header");
      expect(header).toBeInTheDocument();

      expect(screen.getByTestId("user-email")).toHaveTextContent("nav-test@example.com");
      expect(screen.getByTestId("logout-button")).toBeInTheDocument();
    });

    it("shows hamburger button in header for mobile viewports", async () => {
      await renderAndLogin();

      // The hamburger button is always rendered but hidden via CSS on desktop.
      // We verify it exists in the DOM.
      const hamburger = screen.getByTestId("hamburger-button");
      expect(hamburger).toBeInTheDocument();
    });

    it("login page renders WITHOUT desktop sidebar", async () => {
      render(<App />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      // On login page, no AppShell is rendered
      expect(screen.queryByTestId("desktop-sidebar")).not.toBeInTheDocument();
      expect(screen.queryByTestId("app-header")).not.toBeInTheDocument();
      expect(screen.getByLabelText("Email")).toBeInTheDocument();
    });

    it("sidebar contains all navigation group labels", async () => {
      await renderAndLogin();

      const sidebar = screen.getByTestId("desktop-sidebar");
      expect(within(sidebar).getByText("Core")).toBeInTheDocument();
      expect(within(sidebar).getByText("Configuration")).toBeInTheDocument();
      expect(within(sidebar).getByText("Business")).toBeInTheDocument();
    });

    it("sidebar contains all expected navigation links", async () => {
      await renderAndLogin();

      const sidebar = screen.getByTestId("desktop-sidebar");

      // Core group
      expect(within(sidebar).getByText("Calendar")).toBeInTheDocument();
      expect(within(sidebar).getByText("Accounts")).toBeInTheDocument();
      expect(within(sidebar).getByText("Sync Status")).toBeInTheDocument();

      // Configuration group
      expect(within(sidebar).getByText("Policies")).toBeInTheDocument();
      expect(within(sidebar).getByText("Provider Health")).toBeInTheDocument();
      expect(within(sidebar).getByText("Error Recovery")).toBeInTheDocument();

      // Business group
      expect(within(sidebar).getByText("Scheduling")).toBeInTheDocument();
      expect(within(sidebar).getByText("Governance")).toBeInTheDocument();
      expect(within(sidebar).getByText("Relationships")).toBeInTheDocument();
      expect(within(sidebar).getByText("Reconnections")).toBeInTheDocument();
      expect(within(sidebar).getByText("Billing")).toBeInTheDocument();
    });
  });

  // =========================================================================
  // AC 2: Sidebar navigation works for all routes
  // =========================================================================
  describe("AC 2: Clicking sidebar links navigates to correct pages", () => {
    it("sidebar Calendar link navigates to /calendar", async () => {
      await renderAndLogin();
      await navigateTo("#/accounts"); // Start on a different page

      const sidebar = screen.getByTestId("desktop-sidebar");
      fireEvent.click(within(sidebar).getByText("Calendar"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(window.location.hash).toBe("#/calendar");
    });

    it("sidebar Accounts link navigates to /accounts", async () => {
      await renderAndLogin();

      const sidebar = screen.getByTestId("desktop-sidebar");
      fireEvent.click(within(sidebar).getByText("Accounts"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(window.location.hash).toBe("#/accounts");
      expect(screen.getByRole("heading", { name: "Accounts" })).toBeInTheDocument();
    });

    it("sidebar Sync Status link navigates to /sync-status", async () => {
      await renderAndLogin();

      const sidebar = screen.getByTestId("desktop-sidebar");
      fireEvent.click(within(sidebar).getByText("Sync Status"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(window.location.hash).toBe("#/sync-status");
      expect(screen.getByRole("heading", { name: "Sync Status" })).toBeInTheDocument();
    });

    it("sidebar Policies link navigates to /policies", async () => {
      await renderAndLogin();

      const sidebar = screen.getByTestId("desktop-sidebar");
      fireEvent.click(within(sidebar).getByText("Policies"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(window.location.hash).toBe("#/policies");
    });

    it("sidebar Provider Health link navigates to /provider-health", async () => {
      await renderAndLogin();
      mockFetchData.setAccountsMode("health");

      const sidebar = screen.getByTestId("desktop-sidebar");
      fireEvent.click(within(sidebar).getByText("Provider Health"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(window.location.hash).toBe("#/provider-health");
      expect(screen.getByRole("heading", { name: "Provider Health" })).toBeInTheDocument();
    });

    it("sidebar Error Recovery link navigates to /errors", async () => {
      await renderAndLogin();

      const sidebar = screen.getByTestId("desktop-sidebar");
      fireEvent.click(within(sidebar).getByText("Error Recovery"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(window.location.hash).toBe("#/errors");
      expect(screen.getByRole("heading", { name: "Error Recovery" })).toBeInTheDocument();
    });

    it("sidebar Scheduling link navigates to /scheduling", async () => {
      await renderAndLogin();

      const sidebar = screen.getByTestId("desktop-sidebar");
      fireEvent.click(within(sidebar).getByText("Scheduling"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(window.location.hash).toBe("#/scheduling");
      expect(screen.getByRole("heading", { name: "Scheduling" })).toBeInTheDocument();
    });

    it("sidebar Governance link navigates to /governance", async () => {
      await renderAndLogin();

      const sidebar = screen.getByTestId("desktop-sidebar");
      fireEvent.click(within(sidebar).getByText("Governance"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(window.location.hash).toBe("#/governance");
      expect(screen.getByRole("heading", { name: "Governance Dashboard" })).toBeInTheDocument();
    });

    it("sidebar Relationships link navigates to /relationships", async () => {
      await renderAndLogin();

      const sidebar = screen.getByTestId("desktop-sidebar");
      fireEvent.click(within(sidebar).getByText("Relationships"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(window.location.hash).toBe("#/relationships");
      expect(screen.getByRole("heading", { name: "Relationships" })).toBeInTheDocument();
    });

    it("sidebar Reconnections link navigates to /reconnections", async () => {
      await renderAndLogin();

      const sidebar = screen.getByTestId("desktop-sidebar");
      fireEvent.click(within(sidebar).getByText("Reconnections"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(window.location.hash).toBe("#/reconnections");
      expect(screen.getByRole("heading", { name: "Reconnections" })).toBeInTheDocument();
    });

    it("sidebar Billing link navigates to /billing", async () => {
      await renderAndLogin();

      const sidebar = screen.getByTestId("desktop-sidebar");
      fireEvent.click(within(sidebar).getByText("Billing"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(window.location.hash).toBe("#/billing");
      expect(screen.getByRole("heading", { name: "Billing" })).toBeInTheDocument();
    });
  });

  // =========================================================================
  // AC 3: Each page renders its primary content (not just blank)
  // =========================================================================
  describe("AC 3: Each page renders its primary content", () => {
    it("Calendar page shows event content", async () => {
      await renderAndLogin();

      expect(window.location.hash).toBe("#/calendar");
      expect(screen.getByText("Team Standup")).toBeInTheDocument();
    });

    it("Accounts page shows accounts table", async () => {
      await renderAndLogin();
      await navigateTo("#/accounts");

      expect(screen.getByRole("heading", { name: "Accounts" })).toBeInTheDocument();
      expect(screen.getByTestId("accounts-table")).toBeInTheDocument();
    });

    it("Sync Status page shows health banner", async () => {
      await renderAndLogin();
      await navigateTo("#/sync-status");

      expect(screen.getByRole("heading", { name: "Sync Status" })).toBeInTheDocument();
      expect(screen.getByTestId("overall-health-banner")).toBeInTheDocument();
    });

    it("Policies page shows policy management heading", async () => {
      await renderAndLogin();
      await navigateTo("#/policies");

      expect(screen.getByText("Policy Management")).toBeInTheDocument();
    });

    it("Provider Health page shows health heading", async () => {
      await renderAndLogin();
      mockFetchData.setAccountsMode("health");
      await navigateTo("#/provider-health");

      expect(screen.getByRole("heading", { name: "Provider Health" })).toBeInTheDocument();
    });

    it("Error Recovery page shows error heading", async () => {
      await renderAndLogin();
      await navigateTo("#/errors");

      expect(screen.getByRole("heading", { name: "Error Recovery" })).toBeInTheDocument();
    });

    it("Scheduling page shows scheduling heading", async () => {
      await renderAndLogin();
      await navigateTo("#/scheduling");

      expect(screen.getByRole("heading", { name: "Scheduling" })).toBeInTheDocument();
    });

    it("Governance page shows dashboard heading", async () => {
      await renderAndLogin();
      await navigateTo("#/governance");

      expect(screen.getByRole("heading", { name: "Governance Dashboard" })).toBeInTheDocument();
    });

    it("Relationships page shows contacts heading", async () => {
      await renderAndLogin();
      await navigateTo("#/relationships");

      expect(screen.getByRole("heading", { name: "Relationships" })).toBeInTheDocument();
    });

    it("Reconnections page shows heading", async () => {
      await renderAndLogin();
      await navigateTo("#/reconnections");

      expect(screen.getByRole("heading", { name: "Reconnections" })).toBeInTheDocument();
    });

    it("Billing page shows billing heading", async () => {
      await renderAndLogin();
      await navigateTo("#/billing");

      expect(screen.getByRole("heading", { name: "Billing" })).toBeInTheDocument();
    });
  });

  // =========================================================================
  // AC 4: Sequential navigation through ALL sidebar routes
  // =========================================================================
  describe("AC 4: Sequential navigation through all sidebar routes", () => {
    it("navigates through all 11 sidebar routes sequentially, each rendering content", async () => {
      await renderAndLogin();

      // The sidebar has 11 links organized in 3 groups.
      // Navigate to each one via sidebar click and verify the route + heading.

      const sidebarRoutes: Array<{
        label: string;
        hash: string;
        heading: string;
      }> = [
        { label: "Calendar", hash: "#/calendar", heading: "Calendar" },
        { label: "Accounts", hash: "#/accounts", heading: "Accounts" },
        { label: "Sync Status", hash: "#/sync-status", heading: "Sync Status" },
        { label: "Policies", hash: "#/policies", heading: "Policy Management" },
        { label: "Provider Health", hash: "#/provider-health", heading: "Provider Health" },
        { label: "Error Recovery", hash: "#/errors", heading: "Error Recovery" },
        { label: "Scheduling", hash: "#/scheduling", heading: "Scheduling" },
        { label: "Governance", hash: "#/governance", heading: "Governance Dashboard" },
        { label: "Relationships", hash: "#/relationships", heading: "Relationships" },
        { label: "Reconnections", hash: "#/reconnections", heading: "Reconnections" },
        { label: "Billing", hash: "#/billing", heading: "Billing" },
      ];

      for (const route of sidebarRoutes) {
        // Toggle accounts response shape for ProviderHealth vs other pages.
        // Both fetchAccounts() and fetchAccountsHealth() call /api/v1/accounts
        // but expect different response shapes.
        if (route.label === "Provider Health") {
          mockFetchData.setAccountsMode("health");
        } else {
          mockFetchData.setAccountsMode("list");
        }

        const sidebar = screen.getByTestId("desktop-sidebar");
        fireEvent.click(within(sidebar).getByText(route.label));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });

        expect(window.location.hash).toBe(route.hash);

        // Calendar page does not render its own h1; it shows events instead.
        // All other pages render an h1 heading.
        if (route.label === "Calendar") {
          expect(screen.getByText("Team Standup")).toBeInTheDocument();
        } else {
          expect(
            screen.getByRole("heading", { name: route.heading }),
          ).toBeInTheDocument();
        }

        // AppShell is always present during navigation
        expect(screen.getByTestId("app-header")).toBeInTheDocument();
        expect(screen.getByTestId("desktop-sidebar")).toBeInTheDocument();
      }
    });
  });

  // =========================================================================
  // AC 5: Responsive -- hamburger menu toggles mobile sidebar
  // =========================================================================
  describe("AC 5: Responsive mobile sidebar behavior", () => {
    it("hamburger button exists in the header", async () => {
      await renderAndLogin();

      expect(screen.getByTestId("hamburger-button")).toBeInTheDocument();
    });

    it("clicking hamburger toggles mobile sidebar open", async () => {
      await renderAndLogin();

      // Mobile sidebar starts with -translate-x-full (off-screen)
      const mobileSidebar = screen.getByTestId("mobile-sidebar");
      expect(mobileSidebar.className).toContain("-translate-x-full");

      // Click hamburger to open
      fireEvent.click(screen.getByTestId("hamburger-button"));

      // After click, mobile sidebar should have translate-x-0 (on-screen)
      expect(mobileSidebar.className).toContain("translate-x-0");
      expect(mobileSidebar.className).not.toContain("-translate-x-full");
    });

    it("clicking hamburger again closes mobile sidebar", async () => {
      await renderAndLogin();

      const mobileSidebar = screen.getByTestId("mobile-sidebar");

      // Open
      fireEvent.click(screen.getByTestId("hamburger-button"));
      expect(mobileSidebar.className).toContain("translate-x-0");

      // Close
      fireEvent.click(screen.getByTestId("hamburger-button"));
      expect(mobileSidebar.className).toContain("-translate-x-full");
    });

    it("mobile overlay appears when sidebar is open", async () => {
      await renderAndLogin();

      // No overlay initially
      expect(screen.queryByTestId("mobile-overlay")).not.toBeInTheDocument();

      // Open hamburger
      fireEvent.click(screen.getByTestId("hamburger-button"));

      // Overlay should appear
      expect(screen.getByTestId("mobile-overlay")).toBeInTheDocument();
    });

    it("clicking overlay closes mobile sidebar", async () => {
      await renderAndLogin();

      // Open
      fireEvent.click(screen.getByTestId("hamburger-button"));
      expect(screen.getByTestId("mobile-overlay")).toBeInTheDocument();

      // Click overlay to close
      fireEvent.click(screen.getByTestId("mobile-overlay"));

      const mobileSidebar = screen.getByTestId("mobile-sidebar");
      expect(mobileSidebar.className).toContain("-translate-x-full");
      expect(screen.queryByTestId("mobile-overlay")).not.toBeInTheDocument();
    });

    it("mobile sidebar contains all navigation links", async () => {
      await renderAndLogin();

      fireEvent.click(screen.getByTestId("hamburger-button"));

      const mobileSidebar = screen.getByTestId("mobile-sidebar");
      expect(within(mobileSidebar).getByText("Calendar")).toBeInTheDocument();
      expect(within(mobileSidebar).getByText("Accounts")).toBeInTheDocument();
      expect(within(mobileSidebar).getByText("Sync Status")).toBeInTheDocument();
      expect(within(mobileSidebar).getByText("Policies")).toBeInTheDocument();
      expect(within(mobileSidebar).getByText("Provider Health")).toBeInTheDocument();
      expect(within(mobileSidebar).getByText("Error Recovery")).toBeInTheDocument();
      expect(within(mobileSidebar).getByText("Scheduling")).toBeInTheDocument();
      expect(within(mobileSidebar).getByText("Governance")).toBeInTheDocument();
      expect(within(mobileSidebar).getByText("Relationships")).toBeInTheDocument();
      expect(within(mobileSidebar).getByText("Reconnections")).toBeInTheDocument();
      expect(within(mobileSidebar).getByText("Billing")).toBeInTheDocument();
    });

    it("navigating via mobile sidebar closes the menu", async () => {
      await renderAndLogin();

      // Open mobile sidebar
      fireEvent.click(screen.getByTestId("hamburger-button"));
      const mobileSidebar = screen.getByTestId("mobile-sidebar");
      expect(mobileSidebar.className).toContain("translate-x-0");

      // Click a nav link in the mobile sidebar
      fireEvent.click(within(mobileSidebar).getByText("Accounts"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      // Sidebar should close after navigation
      expect(mobileSidebar.className).toContain("-translate-x-full");
      expect(window.location.hash).toBe("#/accounts");
    });
  });

  // =========================================================================
  // AC 6: Logout flow
  // =========================================================================
  describe("AC 6: Logout redirects to login and removes sidebar", () => {
    it("clicking logout returns to login and removes AppShell", async () => {
      await renderAndLogin();

      // Verify we are authenticated with AppShell
      expect(screen.getByTestId("app-header")).toBeInTheDocument();
      expect(screen.getByTestId("desktop-sidebar")).toBeInTheDocument();

      // Click logout
      fireEvent.click(screen.getByTestId("logout-button"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      // Should be on login page
      expect(window.location.hash).toBe("#/login");

      // AppShell should be gone
      expect(screen.queryByTestId("desktop-sidebar")).not.toBeInTheDocument();
      expect(screen.queryByTestId("app-header")).not.toBeInTheDocument();

      // Login form should be visible
      expect(screen.getByLabelText("Email")).toBeInTheDocument();
    });
  });

  // =========================================================================
  // AC 7: Auth guards -- unauthenticated users redirected for all routes
  // =========================================================================
  describe("AC 7: Auth guards redirect unauthenticated users", () => {
    const protectedRoutes = [
      "#/calendar",
      "#/accounts",
      "#/sync-status",
      "#/policies",
      "#/provider-health",
      "#/errors",
      "#/scheduling",
      "#/governance",
      "#/relationships",
      "#/reconnections",
      "#/billing",
    ];

    for (const route of protectedRoutes) {
      it(`redirects unauthenticated access to ${route} to login`, async () => {
        window.location.hash = route;
        const { unmount } = render(<App />);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });

        expect(window.location.hash).toBe("#/login");
        unmount();
      });
    }

    it("authenticated user accessing /login redirects to /calendar", async () => {
      await renderAndLogin();

      await navigateTo("#/login");

      expect(window.location.hash).toBe("#/calendar");
    });

    it("unknown route redirects to /calendar when authenticated", async () => {
      await renderAndLogin();

      await navigateTo("#/totally-nonexistent");

      expect(window.location.hash).toBe("#/calendar");
    });
  });
});
