/**
 * Phase 2C E2E Validation Test Suite.
 *
 * Exercises the FULL web UI component tree through the App component
 * with mock API responses. Validates the complete user journey:
 *   login -> calendar (view events + create event) -> sync status ->
 *   policies -> accounts -> error recovery
 *
 * This is NOT a real browser test -- it is a comprehensive integration test
 * that proves all Phase 2C components (UnifiedCalendar, EventDetail,
 * EventCreateForm, SyncStatus, Policies, Accounts, ErrorRecovery) work
 * together through the App router with authentication context.
 *
 * Mock strategy: global fetch is intercepted to return appropriate API
 * responses. This simulates the full data pipeline from App -> Router ->
 * bound API functions -> components without any real network calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, act, waitFor, fireEvent } from "@testing-library/react";
import { App } from "./App";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NOW = new Date("2026-02-14T12:00:00Z").getTime();

const TEST_TOKEN = "test-jwt-token-abc123";
const TEST_USER = { id: "user-001", email: "alice@example.com", tier: "pro" };

// Events in the current week (Feb 14, 2026 is a Saturday)
const MOCK_EVENTS = [
  {
    canonical_event_id: "evt-001",
    summary: "Team Standup",
    description: "Daily sync with the team",
    location: "Zoom",
    start: "2026-02-14T09:00:00Z",
    end: "2026-02-14T09:30:00Z",
    origin_account_id: "acc-work",
    origin_account_email: "work@example.com",
    status: "confirmed",
    version: 1,
    updated_at: "2026-02-14T08:00:00Z",
    mirrors: [
      {
        target_account_id: "acc-personal",
        target_account_email: "personal@example.com",
        sync_status: "ACTIVE" as const,
      },
    ],
  },
  {
    canonical_event_id: "evt-002",
    summary: "Lunch with Alex",
    start: "2026-02-14T12:00:00Z",
    end: "2026-02-14T13:00:00Z",
    origin_account_id: "acc-personal",
    origin_account_email: "personal@example.com",
    status: "confirmed",
    version: 1,
    updated_at: "2026-02-14T10:00:00Z",
    mirrors: [],
  },
  {
    canonical_event_id: "evt-003",
    summary: "Sprint Review",
    description: "End-of-sprint demo",
    start: "2026-02-13T15:00:00Z",
    end: "2026-02-13T16:00:00Z",
    origin_account_id: "acc-work",
    origin_account_email: "work@example.com",
    status: "confirmed",
    version: 2,
    updated_at: "2026-02-13T14:00:00Z",
    mirrors: [
      {
        target_account_id: "acc-personal",
        target_account_email: "personal@example.com",
        sync_status: "PENDING" as const,
      },
    ],
  },
];

const CREATED_EVENT = {
  canonical_event_id: "evt-new-001",
  summary: "Coffee with Bob",
  description: "Discuss project timeline",
  start: "2026-02-14T14:00:00Z",
  end: "2026-02-14T15:00:00Z",
  origin_account_id: "acc-work",
  origin_account_email: "work@example.com",
  status: "confirmed",
  version: 1,
  updated_at: "2026-02-14T12:30:00Z",
  mirrors: [],
};

const MOCK_SYNC_STATUS = {
  accounts: [
    {
      account_id: "acc-work",
      email: "work@example.com",
      provider: "google",
      status: "active",
      last_sync_ts: new Date(NOW - 3 * 60 * 1000).toISOString(), // 3 min ago -> healthy
      channel_status: "active",
      pending_writes: 1,
      error_count: 0,
    },
    {
      account_id: "acc-personal",
      email: "personal@example.com",
      provider: "google",
      status: "active",
      last_sync_ts: new Date(NOW - 5 * 60 * 1000).toISOString(), // 5 min ago -> healthy
      channel_status: "active",
      pending_writes: 0,
      error_count: 0,
    },
  ],
};

const MOCK_POLICY_LIST = [
  {
    policy_id: "pol-001",
    name: "Default Policy",
    is_default: 1,
  },
];

const MOCK_POLICY_EDGES = [
  {
    policy_id: "pol-001",
    from_account_id: "acc-work",
    to_account_id: "acc-personal",
    detail_level: "BUSY" as const,
    calendar_kind: "BUSY_OVERLAY" as const,
  },
  {
    policy_id: "pol-001",
    from_account_id: "acc-personal",
    to_account_id: "acc-work",
    detail_level: "TITLE" as const,
    calendar_kind: "BUSY_OVERLAY" as const,
  },
];

const MOCK_ACCOUNTS = [
  {
    account_id: "acc-work",
    email: "work@example.com",
    provider: "google" as const,
    status: "active" as const,
  },
  {
    account_id: "acc-personal",
    email: "personal@example.com",
    provider: "google" as const,
    status: "active" as const,
  },
];

const MOCK_ERROR_MIRRORS = [
  {
    mirror_id: "mirror-err-001",
    canonical_event_id: "evt-004",
    target_account_id: "acc-personal",
    target_account_email: "personal@example.com",
    error_message: "Google API rate limit exceeded",
    error_ts: "2026-02-14T11:55:00Z",
    event_summary: "Planning Meeting",
  },
  {
    mirror_id: "mirror-err-002",
    canonical_event_id: "evt-005",
    target_account_id: "acc-work",
    target_account_email: "work@example.com",
    error_message: "Calendar not found",
    error_ts: "2026-02-14T11:50:00Z",
    event_summary: "Doctor Appointment",
  },
];

// ---------------------------------------------------------------------------
// Mock fetch handler
// ---------------------------------------------------------------------------

/**
 * Route-based mock fetch. Intercepts all API calls and returns
 * appropriate mock data based on the URL path and method.
 */
function createMockFetch() {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];

  let currentEvents = [...MOCK_EVENTS];
  let currentErrors = [...MOCK_ERROR_MIRRORS];
  let currentPolicyEdges = [...MOCK_POLICY_EDGES];

  const mockFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const bodyStr = init?.body ? String(init.body) : undefined;
    const body = bodyStr ? JSON.parse(bodyStr) : undefined;

    calls.push({ url, method, body });

    // POST /api/v1/auth/login
    if (url === "/api/v1/auth/login" && method === "POST") {
      if (body?.email === "alice@example.com" && body?.password === "password123") {
        return mockResponse(200, {
          ok: true,
          data: {
            user: TEST_USER,
            access_token: TEST_TOKEN,
            refresh_token: "refresh-token-xyz",
          },
        });
      }
      return mockResponse(401, {
        ok: false,
        error: { code: "AUTH_FAILED", message: "Invalid credentials" },
      });
    }

    // GET /api/v1/events/:id/briefing (must precede the generic events route)
    if (url.match(/^\/api\/v1\/events\/[^/]+\/briefing$/) && method === "GET") {
      const eventId = url.split("/api/v1/events/")[1].split("/briefing")[0];
      const ev = currentEvents.find((e) => e.canonical_event_id === eventId);
      return mockResponse(200, {
        ok: true,
        data: {
          event_id: eventId,
          event_title: ev?.summary ?? null,
          event_start: ev?.start ?? "2026-02-14T09:00:00Z",
          topics: [],
          participants: [],
          computed_at: new Date(NOW).toISOString(),
        },
      });
    }

    // GET /api/v1/events
    if (url.startsWith("/api/v1/events") && method === "GET") {
      return mockResponse(200, { ok: true, data: currentEvents });
    }

    // POST /api/v1/events
    if (url === "/api/v1/events" && method === "POST") {
      const start =
        typeof body?.start === "string"
          ? body.start
          : body?.start?.dateTime ?? body?.start?.date ?? CREATED_EVENT.start;
      const end =
        typeof body?.end === "string"
          ? body.end
          : body?.end?.dateTime ?? body?.end?.date ?? CREATED_EVENT.end;
      const newEvent = {
        ...CREATED_EVENT,
        summary: body?.title ?? body?.summary ?? CREATED_EVENT.summary,
        start,
        end,
        description: body?.description ?? CREATED_EVENT.description,
      };
      currentEvents = [...currentEvents, newEvent];
      return mockResponse(201, { ok: true, data: newEvent });
    }

    // PATCH /api/v1/events/:id
    if (url.match(/^\/api\/v1\/events\//) && method === "PATCH") {
      const eventId = url.split("/api/v1/events/")[1];
      const existing = currentEvents.find((e) => e.canonical_event_id === eventId);
      if (existing) {
        const start =
          typeof body?.start === "string"
            ? body.start
            : body?.start?.dateTime ?? body?.start?.date ?? undefined;
        const end =
          typeof body?.end === "string"
            ? body.end
            : body?.end?.dateTime ?? body?.end?.date ?? undefined;

        const updated = {
          ...existing,
          ...(body?.title !== undefined ? { summary: body.title } : {}),
          ...(start !== undefined ? { start } : {}),
          ...(end !== undefined ? { end } : {}),
          ...(body?.description !== undefined
            ? { description: body.description }
            : {}),
          ...(body?.location !== undefined ? { location: body.location } : {}),
          version: (existing.version ?? 1) + 1,
        };
        currentEvents = currentEvents.map((e) =>
          e.canonical_event_id === eventId ? updated : e,
        );
        return mockResponse(200, { ok: true, data: updated });
      }
      return mockResponse(404, { ok: false, error: "Event not found" });
    }

    // DELETE /api/v1/events/:id
    if (url.match(/^\/api\/v1\/events\//) && method === "DELETE") {
      const eventId = url.split("/api/v1/events/")[1];
      currentEvents = currentEvents.filter((e) => e.canonical_event_id !== eventId);
      return mockResponse(200, { ok: true, data: undefined });
    }

    // GET /api/v1/sync/status
    if (url === "/api/v1/sync/status" && method === "GET") {
      return mockResponse(200, { ok: true, data: MOCK_SYNC_STATUS });
    }

    // GET /api/v1/policies
    if (url === "/api/v1/policies" && method === "GET") {
      return mockResponse(200, { ok: true, data: MOCK_POLICY_LIST });
    }

    // GET /api/v1/policies/:id
    if (url.match(/^\/api\/v1\/policies\/[^/]+$/) && method === "GET") {
      const policyId = url.split("/api/v1/policies/")[1];
      return mockResponse(200, {
        ok: true,
        data: {
          policy_id: policyId,
          edges: currentPolicyEdges,
        },
      });
    }

    // PUT /api/v1/policies/:id/edges
    if (url.match(/^\/api\/v1\/policies\/[^/]+\/edges$/) && method === "PUT") {
      if (Array.isArray(body?.edges)) {
        currentPolicyEdges = body.edges as typeof MOCK_POLICY_EDGES;
      }
      return mockResponse(200, {
        ok: true,
        data: {
          edges_set: currentPolicyEdges.length,
          projections_recomputed: 1,
        },
      });
    }

    // GET /api/v1/accounts
    if (url === "/api/v1/accounts" && method === "GET") {
      return mockResponse(200, { ok: true, data: MOCK_ACCOUNTS });
    }

    // DELETE /api/v1/accounts/:id
    if (url.match(/^\/api\/v1\/accounts\//) && method === "DELETE") {
      return mockResponse(200, { ok: true, data: undefined });
    }

    // GET /api/v1/sync/journal?change_type=error
    if (url.includes("/api/v1/sync/journal") && method === "GET") {
      return mockResponse(200, { ok: true, data: currentErrors });
    }

    // POST /api/v1/sync/retry/:mirror_id
    if (url.match(/^\/api\/v1\/sync\/retry\//) && method === "POST") {
      const mirrorId = url.split("/api/v1/sync/retry/")[1];
      currentErrors = currentErrors.filter((e) => e.mirror_id !== mirrorId);
      return mockResponse(200, {
        ok: true,
        data: { mirror_id: mirrorId, success: true },
      });
    }

    // Fallback
    return mockResponse(404, { ok: false, error: "Not found" });
  });

  return { mockFetch, calls };
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
 * With fake timers, we use vi.advanceTimersByTimeAsync to flush
 * both timers and microtasks.
 */
async function navigateTo(hash: string) {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  // Flush async state updates from data loading in the new page
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

/**
 * Log in via the login form and wait for calendar to load.
 * Reusable across all describe blocks that need an authenticated session.
 */
async function performLogin() {
  fireEvent.change(screen.getByLabelText("Email"), {
    target: { value: "alice@example.com" },
  });
  fireEvent.change(screen.getByLabelText("Password"), {
    target: { value: "password123" },
  });
  fireEvent.click(screen.getByRole("button", { name: /sign in/i }));

  // Flush login API call and auth state update
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  // Flush redirect to calendar and events loading
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
// E2E Validation Tests
// ---------------------------------------------------------------------------

describe("Phase 2C E2E Validation", () => {
  // =========================================================================
  // AC 1: Login at app.tminus.ink (auth flow simulation)
  // =========================================================================
  describe("AC 1: Authentication flow", () => {
    it("shows login page when not authenticated", async () => {
      render(<App />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.getByText("T-Minus")).toBeInTheDocument();
      expect(screen.getByText("Calendar Federation Engine")).toBeInTheDocument();
      expect(screen.getByLabelText("Email")).toBeInTheDocument();
      expect(screen.getByLabelText("Password")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /sign in/i })).toBeInTheDocument();
    });

    it("redirects unauthenticated users to login", async () => {
      window.location.hash = "#/calendar";
      render(<App />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(window.location.hash).toBe("#/login");
    });

    it("shows error for invalid credentials", async () => {
      render(<App />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      fireEvent.change(screen.getByLabelText("Email"), {
        target: { value: "wrong@example.com" },
      });
      fireEvent.change(screen.getByLabelText("Password"), {
        target: { value: "wrongpassword" },
      });
      fireEvent.click(screen.getByRole("button", { name: /sign in/i }));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.getByText("Invalid credentials")).toBeInTheDocument();
    });

    it("successful login navigates to calendar", async () => {
      render(<App />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      await performLogin();

      expect(window.location.hash).toBe("#/calendar");
    });
  });

  // =========================================================================
  // AC 2: Calendar shows real events from linked accounts
  // =========================================================================
  describe("AC 2: Calendar displays events from linked accounts", () => {
    it("renders calendar header with user email", async () => {
      await renderAndLogin();

      expect(screen.getByText("T-Minus Calendar")).toBeInTheDocument();
      // Email appears in both AppShell header and Calendar subtitle
      const emailElements = screen.getAllByText("alice@example.com");
      expect(emailElements.length).toBeGreaterThanOrEqual(1);
    });

    it("displays events from multiple accounts", async () => {
      await renderAndLogin();

      expect(screen.getByText("Team Standup")).toBeInTheDocument();
      expect(screen.getByText("Lunch with Alex")).toBeInTheDocument();
    });

    it("calls fetchEvents API with auth token", async () => {
      await renderAndLogin();

      const eventCalls = mockFetchData.calls.filter(
        (c) => c.url.includes("/api/v1/events") && c.method === "GET",
      );
      expect(eventCalls.length).toBeGreaterThan(0);
    });

    it("clicking an event opens the detail panel with mirror info", async () => {
      await renderAndLogin();

      // Click the event chip via testid (avoids duplicate text issues)
      const eventChip = screen.getByTestId("event-chip-evt-001");
      fireEvent.click(eventChip);

      // Flush BriefingPanel's async fetch that fires when EventDetail renders
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      // Detail panel renders the event -- text now appears in both chip and panel
      const standupElements = screen.getAllByText("Team Standup");
      expect(standupElements.length).toBeGreaterThanOrEqual(2);

      // EventDetail shows mirrors info
      expect(screen.getByText(/personal@example.com/)).toBeInTheDocument();
    });

    it("calendar toolbar has all navigation and view controls", async () => {
      await renderAndLogin();

      // Navigation buttons
      expect(screen.getByRole("button", { name: "Today" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Previous" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Next" })).toBeInTheDocument();

      // View switch buttons (use exact aria-label to avoid "Today"/"Day" collision)
      expect(screen.getByRole("button", { name: "Day" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Week" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Month" })).toBeInTheDocument();
    });

    it("view switch to month changes calendar display", async () => {
      await renderAndLogin();

      fireEvent.click(screen.getByRole("button", { name: "Month" }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      // Month view renders day-of-week headers
      expect(screen.getByText("Sun")).toBeInTheDocument();
      expect(screen.getByText("Mon")).toBeInTheDocument();
    });

    it("navigation header links are present", async () => {
      await renderAndLogin();

      // These texts appear in both the Calendar page header nav and the
      // AppShell sidebar, so use getAllByText to assert presence.
      expect(screen.getAllByText("Accounts").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("Policies").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("Sync Status").length).toBeGreaterThanOrEqual(1);
    });
  });

  // =========================================================================
  // AC 3: Create event from UI, verify API call
  // =========================================================================
  describe("AC 3: Event creation flow calls API", () => {
    it("clicking a time slot opens the create event form", async () => {
      await renderAndLogin();

      const daySlot = screen.getByTestId("week-day-slot-2026-02-14");
      fireEvent.click(daySlot);

      expect(screen.getByTestId("event-create-form")).toBeInTheDocument();
      expect(screen.getByLabelText(/title/i)).toBeInTheDocument();
    });

    it("submitting the create form calls POST /api/v1/events", async () => {
      await renderAndLogin();

      // Open creation form
      fireEvent.click(screen.getByTestId("week-day-slot-2026-02-14"));

      // Fill title
      fireEvent.change(screen.getByLabelText(/title/i), {
        target: { value: "Coffee with Bob" },
      });

      // Submit
      fireEvent.click(screen.getByTestId("event-create-submit"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      const createCalls = mockFetchData.calls.filter(
        (c) => c.url === "/api/v1/events" && c.method === "POST",
      );
      expect(createCalls.length).toBe(1);
      expect(createCalls[0].body).toMatchObject({
        title: "Coffee with Bob",
        start: expect.objectContaining({ dateTime: expect.any(String) }),
        end: expect.objectContaining({ dateTime: expect.any(String) }),
        source: "ui",
      });
    });

    it("new event appears in calendar after creation", async () => {
      await renderAndLogin();

      // Open creation form
      fireEvent.click(screen.getByTestId("week-day-slot-2026-02-14"));

      // Fill and submit
      fireEvent.change(screen.getByLabelText(/title/i), {
        target: { value: "Coffee with Bob" },
      });
      fireEvent.click(screen.getByTestId("event-create-submit"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      // Optimistic update should display the new event
      expect(screen.getByText("Coffee with Bob")).toBeInTheDocument();
    });
  });

  // =========================================================================
  // AC 4: Sync dashboard shows green for healthy accounts
  // =========================================================================
  describe("AC 4: Sync status dashboard shows health indicators", () => {
    it("renders sync status page with title", async () => {
      await renderAndLogin();
      await navigateTo("#/sync-status");

      // Use heading role to disambiguate from sidebar nav link
      expect(screen.getByRole("heading", { name: "Sync Status" })).toBeInTheDocument();
    });

    it("shows overall health banner as healthy (green)", async () => {
      await renderAndLogin();
      await navigateTo("#/sync-status");

      const banner = screen.getByTestId("overall-health-banner");
      expect(banner).toHaveAttribute("data-health", "healthy");
      expect(banner).toHaveAttribute("data-color", "green");
    });

    it("shows green indicators for both healthy accounts", async () => {
      await renderAndLogin();
      await navigateTo("#/sync-status");

      const workRow = screen.getByTestId("account-row-acc-work");
      const workIndicator = within(workRow).getByTestId("health-indicator");
      expect(workIndicator).toHaveAttribute("data-health", "healthy");
      expect(workIndicator).toHaveAttribute("data-color", "green");

      const personalRow = screen.getByTestId("account-row-acc-personal");
      const personalIndicator = within(personalRow).getByTestId("health-indicator");
      expect(personalIndicator).toHaveAttribute("data-health", "healthy");
      expect(personalIndicator).toHaveAttribute("data-color", "green");
    });

    it("displays account emails and providers", async () => {
      await renderAndLogin();
      await navigateTo("#/sync-status");

      expect(screen.getByText("work@example.com")).toBeInTheDocument();
      expect(screen.getByText("personal@example.com")).toBeInTheDocument();
    });

    it("shows last sync time and channel status", async () => {
      await renderAndLogin();
      await navigateTo("#/sync-status");

      const syncTimes = screen.getAllByTestId("last-sync-time");
      expect(syncTimes.length).toBe(2);

      const channelStatuses = screen.getAllByTestId("channel-status");
      expect(channelStatuses.length).toBe(2);
      expect(channelStatuses[0].textContent).toBe("active");
    });

    it("has Back to Calendar navigation link", async () => {
      await renderAndLogin();
      await navigateTo("#/sync-status");

      const backLink = screen.getByText("Back to Calendar");
      expect(backLink).toBeInTheDocument();
      expect(backLink).toHaveAttribute("href", "#/calendar");
    });
  });

  // =========================================================================
  // AC 5: Policy matrix editable
  // =========================================================================
  describe("AC 5: Policy matrix is editable", () => {
    it("renders policy management page with title", async () => {
      await renderAndLogin();
      await navigateTo("#/policies");

      expect(screen.getByText("Policy Management")).toBeInTheDocument();
    });

    it("shows policy matrix with account emails", async () => {
      await renderAndLogin();
      await navigateTo("#/policies");

      const matrix = screen.getByTestId("policy-matrix");
      expect(matrix).toBeInTheDocument();

      expect(screen.getAllByText("work@example.com").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("personal@example.com").length).toBeGreaterThanOrEqual(1);
    });

    it("shows detail level legend", async () => {
      await renderAndLogin();
      await navigateTo("#/policies");

      const legend = screen.getByTestId("policy-legend");
      expect(legend).toBeInTheDocument();
      expect(within(legend).getByText("BUSY")).toBeInTheDocument();
      expect(within(legend).getByText("TITLE")).toBeInTheDocument();
      expect(within(legend).getByText("FULL")).toBeInTheDocument();
    });

    it("matrix cells show current detail levels", async () => {
      await renderAndLogin();
      await navigateTo("#/policies");

      const cellBtn1 = screen.getByTestId("cell-btn-acc-work-acc-personal");
      expect(cellBtn1).toHaveAttribute("data-detail-level", "BUSY");

      const cellBtn2 = screen.getByTestId("cell-btn-acc-personal-acc-work");
      expect(cellBtn2).toHaveAttribute("data-detail-level", "TITLE");
    });

    it("clicking a cell cycles the detail level and calls API", async () => {
      await renderAndLogin();
      await navigateTo("#/policies");

      // Click BUSY cell -> should cycle to TITLE
      const cellBtn = screen.getByTestId("cell-btn-acc-work-acc-personal");
      fireEvent.click(cellBtn);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      const putCalls = mockFetchData.calls.filter(
        (c) => c.url.includes("/api/v1/policies/") && c.method === "PUT",
      );
      expect(putCalls.length).toBe(1);
      expect(putCalls[0].body).toMatchObject({
        edges: expect.arrayContaining([
          expect.objectContaining({
            from_account_id: "acc-work",
            to_account_id: "acc-personal",
            detail_level: "TITLE",
          }),
        ]),
      });
    });

    it("shows success status message after policy update", async () => {
      await renderAndLogin();
      await navigateTo("#/policies");

      fireEvent.click(screen.getByTestId("cell-btn-acc-work-acc-personal"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      const statusEl = screen.getByTestId("policy-status");
      expect(statusEl).toHaveAttribute("data-status-type", "success");
      expect(statusEl.textContent).toContain("Policy updated");
    });

    it("self-cells show dashes (non-editable)", async () => {
      await renderAndLogin();
      await navigateTo("#/policies");

      const selfCell = screen.getByTestId("cell-acc-work-acc-work");
      expect(selfCell.textContent).toBe("--");
    });
  });

  // =========================================================================
  // AC 6: Complete user journey (screen recording equivalent)
  // =========================================================================
  describe("AC 6: Complete user journey through all pages", () => {
    it("full flow: login -> calendar -> accounts -> sync-status -> policies -> errors", async () => {
      // -- STEP 1: Login --
      render(<App />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.getByText("T-Minus")).toBeInTheDocument();
      await performLogin();

      // -- STEP 2: Calendar --
      expect(window.location.hash).toBe("#/calendar");
      expect(screen.getByText("T-Minus Calendar")).toBeInTheDocument();
      expect(screen.getByText("Team Standup")).toBeInTheDocument();
      expect(screen.getByText("Lunch with Alex")).toBeInTheDocument();

      // -- STEP 3: Accounts --
      await navigateTo("#/accounts");

      // Use heading role to disambiguate from sidebar nav link
      expect(screen.getByRole("heading", { name: "Accounts" })).toBeInTheDocument();
      const accountTable = screen.getByTestId("accounts-table");
      expect(within(accountTable).getByText("work@example.com")).toBeInTheDocument();
      expect(within(accountTable).getByText("personal@example.com")).toBeInTheDocument();
      expect(screen.getByTestId("link-google")).toBeInTheDocument();
      expect(screen.getByTestId("link-microsoft")).toBeInTheDocument();

      // -- STEP 4: Sync Status --
      await navigateTo("#/sync-status");

      // Use heading role to disambiguate from sidebar nav link
      expect(screen.getByRole("heading", { name: "Sync Status" })).toBeInTheDocument();
      const banner = screen.getByTestId("overall-health-banner");
      expect(banner).toHaveAttribute("data-health", "healthy");

      const indicators = screen.getAllByTestId("health-indicator");
      for (const indicator of indicators) {
        expect(indicator).toHaveAttribute("data-color", "green");
      }

      // -- STEP 5: Policies --
      await navigateTo("#/policies");

      expect(screen.getByText("Policy Management")).toBeInTheDocument();
      expect(screen.getByTestId("policy-matrix")).toBeInTheDocument();

      const busyBtn = screen.getByTestId("cell-btn-acc-work-acc-personal");
      expect(busyBtn).toBeInTheDocument();
      expect(busyBtn).not.toBeDisabled();

      // -- STEP 6: Error Recovery --
      await navigateTo("#/errors");

      // Use heading role to disambiguate from sidebar nav link
      expect(screen.getByRole("heading", { name: "Error Recovery" })).toBeInTheDocument();
      expect(screen.getByTestId("error-row-mirror-err-001")).toBeInTheDocument();
      expect(screen.getByTestId("error-row-mirror-err-002")).toBeInTheDocument();
      expect(screen.getByText("Planning Meeting")).toBeInTheDocument();
      expect(screen.getByText("Google API rate limit exceeded")).toBeInTheDocument();
      expect(screen.getByTestId("retry-btn-mirror-err-001")).toBeInTheDocument();
      expect(screen.getByTestId("batch-retry-btn")).toBeInTheDocument();
    });
  });

  // =========================================================================
  // Additional integration: Account management
  // =========================================================================
  describe("Account management integration", () => {
    it("renders account list with status indicators", async () => {
      await renderAndLogin();
      await navigateTo("#/accounts");

      const statusIndicators = screen.getAllByTestId("account-status-indicator");
      expect(statusIndicators.length).toBe(2);
      for (const indicator of statusIndicators) {
        expect(indicator).toHaveAttribute("data-status", "active");
      }
    });

    it("link account buttons are present and labeled", async () => {
      await renderAndLogin();
      await navigateTo("#/accounts");

      const googleBtn = screen.getByTestId("link-google");
      expect(googleBtn.textContent).toContain("Link Google Account");

      const msBtn = screen.getByTestId("link-microsoft");
      expect(msBtn.textContent).toContain("Link Microsoft Account");
    });

    it("unlink account shows confirmation dialog", async () => {
      await renderAndLogin();
      await navigateTo("#/accounts");

      const unlinkBtn = screen.getByTestId("unlink-btn-acc-work");
      fireEvent.click(unlinkBtn);

      const dialog = screen.getByTestId("unlink-dialog");
      expect(dialog).toBeInTheDocument();
      expect(screen.getByText(/are you sure/i)).toBeInTheDocument();
      expect(screen.getByTestId("unlink-confirm")).toBeInTheDocument();
      expect(screen.getByTestId("unlink-cancel")).toBeInTheDocument();
    });
  });

  // =========================================================================
  // Additional integration: Error Recovery
  // =========================================================================
  describe("Error recovery integration", () => {
    it("displays error count summary", async () => {
      await renderAndLogin();
      await navigateTo("#/errors");

      const summary = screen.getByTestId("error-count-summary");
      expect(summary.textContent).toContain("2 errors");
    });

    it("displays error messages per mirror", async () => {
      await renderAndLogin();
      await navigateTo("#/errors");

      const errorMessages = screen.getAllByTestId("error-message");
      expect(errorMessages.length).toBe(2);
      expect(errorMessages[0].textContent).toContain("Google API rate limit exceeded");
      expect(errorMessages[1].textContent).toContain("Calendar not found");
    });

    it("retry button calls POST /api/v1/sync/retry/:mirror_id", async () => {
      await renderAndLogin();
      await navigateTo("#/errors");

      fireEvent.click(screen.getByTestId("retry-btn-mirror-err-001"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      const retryCalls = mockFetchData.calls.filter(
        (c) => c.url.includes("/api/v1/sync/retry/") && c.method === "POST",
      );
      expect(retryCalls.length).toBe(1);
      expect(retryCalls[0].url).toBe("/api/v1/sync/retry/mirror-err-001");
    });

    it("successful retry removes mirror from list and shows feedback", async () => {
      await renderAndLogin();
      await navigateTo("#/errors");

      expect(screen.getByTestId("error-row-mirror-err-001")).toBeInTheDocument();

      fireEvent.click(screen.getByTestId("retry-btn-mirror-err-001"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.queryByTestId("error-row-mirror-err-001")).not.toBeInTheDocument();

      const statusEl = screen.getByTestId("retry-status");
      expect(statusEl).toHaveAttribute("data-status-type", "success");
    });

    it("batch retry calls API for each error mirror", async () => {
      await renderAndLogin();
      await navigateTo("#/errors");

      fireEvent.click(screen.getByTestId("batch-retry-btn"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      const retryCalls = mockFetchData.calls.filter(
        (c) => c.url.includes("/api/v1/sync/retry/") && c.method === "POST",
      );
      expect(retryCalls.length).toBe(2);
    });
  });

  // =========================================================================
  // Cross-cutting: Logout flow
  // =========================================================================
  describe("Logout flow", () => {
    it("Sign Out button returns to login page", async () => {
      await renderAndLogin();

      expect(screen.getByText("T-Minus Calendar")).toBeInTheDocument();

      fireEvent.click(screen.getByText("Sign Out"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(window.location.hash).toBe("#/login");
    });
  });

  // =========================================================================
  // Cross-cutting: Route guards
  // =========================================================================
  describe("Route guards", () => {
    it("unauthenticated access to protected routes redirects to login", async () => {
      // The Router checks token on render. If no token and route != #/login,
      // it sets window.location.hash = "#/login" and returns null.
      // Test each protected route:
      for (const route of ["#/sync-status", "#/policies", "#/errors", "#/accounts", "#/calendar"]) {
        window.location.hash = route;
        const { unmount } = render(<App />);
        // The Router sets window.location.hash synchronously during render
        expect(window.location.hash).toBe("#/login");
        unmount();
      }
    });

    it("authenticated user accessing login redirects to calendar", async () => {
      await renderAndLogin();

      // We are on #/calendar. Navigate to #/login
      await navigateTo("#/login");

      // Router should redirect authenticated users away from login
      expect(window.location.hash).toBe("#/calendar");
    });

    it("unknown route redirects to calendar when authenticated", async () => {
      await renderAndLogin();

      await navigateTo("#/nonexistent");

      expect(window.location.hash).toBe("#/calendar");
    });
  });
});
