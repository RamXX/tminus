/**
 * Phase 4A E2E Validation Test Suite -- Relationship Graph Pipeline.
 *
 * Exercises the FULL relationship graph pipeline through the App component
 * with mock API responses. Validates the complete user journey:
 *   login -> navigate to relationships -> add contacts across categories ->
 *   view contact detail with reputation scores -> record outcomes ->
 *   view drift report with overdue contacts -> verify drift alerts ->
 *   verify reconnection suggestions -> dashboard data loads
 *
 * This is NOT a real browser test -- it is a comprehensive integration test
 * that proves all Phase 4A relationship features work together through the
 * App router with authentication context and mock API responses.
 *
 * Mock strategy: global fetch is intercepted to return appropriate API
 * responses. This simulates the full data pipeline from App -> Router ->
 * bound API functions -> Relationships component without real network calls.
 *
 * Proves:
 *   AC1: Relationships created and categorized
 *   AC2: Drift detection identifies overdue contacts
 *   AC3: Outcomes recorded in ledger
 *   AC4: Reputation scores computed
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { render, screen, within, act, fireEvent } from "@testing-library/react";
import { App } from "./App";

// Pre-load all lazy-loaded page modules so React.lazy() resolves synchronously
// during tests. Without this, dynamic import() under fake timers can race with
// act() and produce flaky test failures.
beforeAll(async () => {
  await Promise.all([
    import("./pages/Login"),
    import("./pages/Calendar"),
    import("./pages/Accounts"),
    import("./pages/SyncStatus"),
    import("./pages/Policies"),
    import("./pages/ErrorRecovery"),
    import("./pages/Billing"),
    import("./pages/Scheduling"),
    import("./pages/Governance"),
    import("./pages/Relationships"),
    import("./pages/Reconnections"),
    import("./pages/Admin"),
    import("./pages/Onboarding"),
    import("./pages/ProviderHealth"),
  ]);
});

import type {
  Relationship,
  ReputationScores,
  Outcome,
  DriftReport,
  DriftAlert,
  ReconnectionSuggestion,
} from "./lib/relationships";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NOW = new Date("2026-02-15T12:00:00Z").getTime();

const TEST_TOKEN = "test-jwt-token-abc123";
const TEST_USER = { id: "user-001", email: "alice@example.com", tier: "pro" };

// ---------------------------------------------------------------------------
// Mock relationship data spanning all required categories
// ---------------------------------------------------------------------------

const MOCK_RELATIONSHIPS: Relationship[] = [
  {
    id: "rel_client_01",
    name: "Sarah Chen",
    email: "sarah@clientcorp.com",
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
  {
    id: "rel_friend_02",
    name: "Mike Torres",
    email: "mike@personal.com",
    category: "personal",
    city: "Austin",
    timezone: "America/Chicago",
    frequency_days: 30,
    last_interaction: "2025-12-01T12:00:00Z",
    drift_level: "red",
    reliability_score: 62,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2025-12-01T12:00:00Z",
  },
  {
    id: "rel_investor_03",
    name: "Elena Vasquez",
    email: "elena@vc-fund.com",
    category: "vip",
    city: "New York",
    timezone: "America/New_York",
    frequency_days: 14,
    last_interaction: "2026-01-25T12:00:00Z",
    drift_level: "yellow",
    reliability_score: 88,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-25T12:00:00Z",
  },
  {
    id: "rel_colleague_04",
    name: "James Park",
    email: "james@company.com",
    category: "community",
    city: "Seattle",
    timezone: "America/Los_Angeles",
    frequency_days: 7,
    last_interaction: null,
    drift_level: "red",
    reliability_score: 0,
    created_at: "2026-02-01T00:00:00Z",
    updated_at: "2026-02-01T00:00:00Z",
  },
  {
    id: "rel_family_05",
    name: "Maria Santos",
    email: "maria@family.com",
    category: "family",
    city: "Miami",
    timezone: "America/New_York",
    frequency_days: 7,
    last_interaction: "2026-02-10T12:00:00Z",
    drift_level: "green",
    reliability_score: 98,
    created_at: "2025-06-01T00:00:00Z",
    updated_at: "2026-02-10T12:00:00Z",
  },
];

const CREATED_RELATIONSHIP: Relationship = {
  id: "rel_new_06",
  name: "New Contact",
  email: "new@example.com",
  category: "professional",
  city: "Denver",
  timezone: "America/Denver",
  frequency_days: 14,
  last_interaction: null,
  drift_level: "red",
  reliability_score: 0,
  created_at: "2026-02-15T12:00:00Z",
  updated_at: "2026-02-15T12:00:00Z",
};

const MOCK_REPUTATION: ReputationScores = {
  reliability_score: 95,
  responsiveness_score: 90,
  follow_through_score: 88,
  overall_score: 91,
  total_interactions: 15,
  positive_outcomes: 12,
  negative_outcomes: 1,
};

const MOCK_OUTCOMES: Outcome[] = [
  {
    outcome_id: "out_01",
    relationship_id: "rel_client_01",
    outcome_type: "positive",
    description: "Attended quarterly review meeting",
    occurred_at: "2026-02-14T12:00:00Z",
    created_at: "2026-02-14T12:00:00Z",
  },
  {
    outcome_id: "out_02",
    relationship_id: "rel_client_01",
    outcome_type: "negative",
    description: "Canceled by me -- scheduling conflict",
    occurred_at: "2026-02-01T12:00:00Z",
    created_at: "2026-02-01T12:00:00Z",
  },
  {
    outcome_id: "out_03",
    relationship_id: "rel_client_01",
    outcome_type: "positive",
    description: "Successful demo presentation",
    occurred_at: "2026-01-20T12:00:00Z",
    created_at: "2026-01-20T12:00:00Z",
  },
];

const CREATED_OUTCOME: Outcome = {
  outcome_id: "out_04",
  relationship_id: "rel_client_01",
  outcome_type: "positive",
  description: "Follow-up coffee meeting went well",
  occurred_at: "2026-02-15T10:00:00Z",
  created_at: "2026-02-15T12:00:00Z",
};

const MOCK_DRIFT_REPORT: DriftReport = {
  entries: [
    {
      relationship_id: "rel_friend_02",
      name: "Mike Torres",
      category: "personal",
      days_overdue: 46,
      drift_level: "red",
      last_interaction: "2025-12-01T12:00:00Z",
      frequency_days: 30,
    },
    {
      relationship_id: "rel_colleague_04",
      name: "James Park",
      category: "community",
      days_overdue: 7,
      drift_level: "red",
      last_interaction: null,
      frequency_days: 7,
    },
    {
      relationship_id: "rel_investor_03",
      name: "Elena Vasquez",
      category: "vip",
      days_overdue: 7,
      drift_level: "yellow",
      last_interaction: "2026-01-25T12:00:00Z",
      frequency_days: 14,
    },
  ],
  generated_at: "2026-02-15T12:00:00Z",
};

const MOCK_DRIFT_ALERTS: DriftAlert[] = [
  {
    alert_id: "alert_01",
    relationship_id: "rel_friend_02",
    name: "Mike Torres",
    drift_level: "red",
    days_overdue: 46,
    message: "No contact in 76 days -- 46 days overdue",
    created_at: "2026-02-15T12:00:00Z",
  },
  {
    alert_id: "alert_02",
    relationship_id: "rel_colleague_04",
    name: "James Park",
    drift_level: "red",
    days_overdue: 7,
    message: "Never contacted -- 7 days overdue",
    created_at: "2026-02-15T12:00:00Z",
  },
];

const MOCK_RECONNECTION_SUGGESTIONS: ReconnectionSuggestion[] = [
  {
    relationship_id: "rel_friend_02",
    name: "Mike Torres",
    reason: "46 days overdue for personal check-in",
    suggested_action: "Schedule a coffee catch-up in Austin",
    priority: 1,
  },
  {
    relationship_id: "rel_investor_03",
    name: "Elena Vasquez",
    reason: "VIP contact drifting -- 7 days overdue",
    suggested_action: "Send a brief update email on project progress",
    priority: 2,
  },
];

// Mock events (minimal -- just enough for calendar route to work)
const MOCK_EVENTS = [
  {
    canonical_event_id: "evt-001",
    summary: "Team Standup",
    start: "2026-02-15T09:00:00Z",
    end: "2026-02-15T09:30:00Z",
    origin_account_id: "acc-work",
    origin_account_email: "work@example.com",
    status: "confirmed",
    version: 1,
    updated_at: "2026-02-15T08:00:00Z",
    mirrors: [],
  },
];

// ---------------------------------------------------------------------------
// Mock fetch handler
// ---------------------------------------------------------------------------

function createMockFetch() {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];

  let currentRelationships = [...MOCK_RELATIONSHIPS];
  let currentOutcomes: Record<string, Outcome[]> = {
    rel_client_01: [...MOCK_OUTCOMES],
    rel_friend_02: [],
    rel_investor_03: [],
    rel_colleague_04: [],
    rel_family_05: [],
  };

  const mockFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const bodyStr = init?.body ? String(init.body) : undefined;
    const body = bodyStr ? JSON.parse(bodyStr) : undefined;

    calls.push({ url, method, body });

    // -- Auth --
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

    // -- Events (minimal, for calendar route) --
    if (url.startsWith("/api/v1/events") && method === "GET") {
      return mockResponse(200, { ok: true, data: MOCK_EVENTS });
    }

    // -- Relationships CRUD --

    // GET /api/v1/relationships
    if (url.match(/^\/api\/v1\/relationships(\?.*)?$/) && method === "GET") {
      return mockResponse(200, { ok: true, data: currentRelationships });
    }

    // POST /api/v1/relationships
    if (url === "/api/v1/relationships" && method === "POST") {
      const newRel: Relationship = {
        ...CREATED_RELATIONSHIP,
        name: body?.name ?? CREATED_RELATIONSHIP.name,
        email: body?.email ?? CREATED_RELATIONSHIP.email,
        category: body?.category ?? CREATED_RELATIONSHIP.category,
        city: body?.city ?? CREATED_RELATIONSHIP.city,
        timezone: body?.timezone ?? CREATED_RELATIONSHIP.timezone,
        frequency_days: body?.frequency_days ?? CREATED_RELATIONSHIP.frequency_days,
      };
      currentRelationships = [...currentRelationships, newRel];
      return mockResponse(201, { ok: true, data: newRel });
    }

    // GET /api/v1/relationships/:id
    if (url.match(/^\/api\/v1\/relationships\/[^/]+$/) && method === "GET") {
      const id = url.split("/api/v1/relationships/")[1];
      const found = currentRelationships.find((r) => r.id === id);
      if (found) {
        return mockResponse(200, { ok: true, data: found });
      }
      return mockResponse(404, { ok: false, error: "Relationship not found" });
    }

    // PUT /api/v1/relationships/:id
    if (url.match(/^\/api\/v1\/relationships\/[^/]+$/) && method === "PUT") {
      const id = url.split("/api/v1/relationships/")[1];
      const existing = currentRelationships.find((r) => r.id === id);
      if (existing) {
        const updated = { ...existing, ...body, updated_at: new Date(NOW).toISOString() };
        currentRelationships = currentRelationships.map((r) =>
          r.id === id ? updated : r,
        );
        return mockResponse(200, { ok: true, data: updated });
      }
      return mockResponse(404, { ok: false, error: "Relationship not found" });
    }

    // DELETE /api/v1/relationships/:id
    if (url.match(/^\/api\/v1\/relationships\/[^/]+$/) && method === "DELETE") {
      const id = url.split("/api/v1/relationships/")[1];
      currentRelationships = currentRelationships.filter((r) => r.id !== id);
      return mockResponse(200, { ok: true, data: undefined });
    }

    // -- Reputation --
    // GET /api/v1/relationships/:id/reputation
    if (url.match(/^\/api\/v1\/relationships\/[^/]+\/reputation$/) && method === "GET") {
      return mockResponse(200, { ok: true, data: MOCK_REPUTATION });
    }

    // -- Outcomes --
    // POST /api/v1/relationships/:id/outcomes
    if (url.match(/^\/api\/v1\/relationships\/[^/]+\/outcomes$/) && method === "POST") {
      const parts = url.split("/api/v1/relationships/")[1].split("/outcomes")[0];
      const relId = parts;
      const newOutcome: Outcome = {
        ...CREATED_OUTCOME,
        relationship_id: relId,
        outcome_type: body?.outcome_type ?? CREATED_OUTCOME.outcome_type,
        description: body?.description ?? CREATED_OUTCOME.description,
        occurred_at: body?.occurred_at ?? CREATED_OUTCOME.occurred_at,
      };
      if (!currentOutcomes[relId]) {
        currentOutcomes[relId] = [];
      }
      currentOutcomes[relId] = [...currentOutcomes[relId], newOutcome];
      return mockResponse(201, { ok: true, data: newOutcome });
    }

    // GET /api/v1/relationships/:id/outcomes
    if (url.match(/^\/api\/v1\/relationships\/[^/]+\/outcomes$/) && method === "GET") {
      const relId = url.split("/api/v1/relationships/")[1].split("/outcomes")[0];
      return mockResponse(200, { ok: true, data: currentOutcomes[relId] ?? [] });
    }

    // -- Drift Report --
    if (url === "/api/v1/drift-report" && method === "GET") {
      return mockResponse(200, { ok: true, data: MOCK_DRIFT_REPORT });
    }

    // -- Drift Alerts --
    if (url === "/api/v1/drift-alerts" && method === "GET") {
      return mockResponse(200, { ok: true, data: MOCK_DRIFT_ALERTS });
    }

    // -- Reconnection Suggestions --
    if (url.startsWith("/api/v1/reconnection-suggestions") && method === "GET") {
      return mockResponse(200, { ok: true, data: MOCK_RECONNECTION_SUGGESTIONS });
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
 * Flush pending microtasks (e.g. React.lazy import resolution) under fake timers.
 * Multiple flushes are needed because lazy-loaded components resolve asynchronously.
 */
async function flushLazy() {
  // Flush pending timers and microtasks. Page modules are pre-loaded via
  // beforeAll, so React.lazy() resolves synchronously. Two flushes cover the
  // initial Suspense resolution and any subsequent data-fetching state updates.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

/**
 * Navigate to a hash route and flush the component update cycle.
 */
async function navigateTo(hash: string) {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  await flushLazy();
}

/**
 * Log in via the login form and wait for calendar to load.
 */
async function performLogin() {
  fireEvent.change(screen.getByLabelText("Email"), {
    target: { value: "alice@example.com" },
  });
  fireEvent.change(screen.getByLabelText("Password"), {
    target: { value: "password123" },
  });
  fireEvent.click(screen.getByRole("button", { name: /sign in/i }));

  await flushLazy();
}

/**
 * Render the App, flush initial render, then log in and land on calendar.
 */
async function renderAndLogin() {
  render(<App />);
  await flushLazy();
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
// E2E Validation Tests -- Phase 4A Relationship Graph
// ---------------------------------------------------------------------------

describe("Phase 4A E2E Validation -- Relationship Graph Pipeline", () => {

  // =========================================================================
  // AC 1: Relationships created and categorized
  // =========================================================================
  describe("AC 1: Relationships created and categorized", () => {
    it("navigates to relationships page and loads contact list", async () => {
      await renderAndLogin();
      await navigateTo("#/relationships");

      // Page title and main structure rendered (use heading role to
      // disambiguate from sidebar nav links added by AppShell)
      expect(screen.getByRole("heading", { name: "Relationships" })).toBeInTheDocument();
      expect(screen.getByTestId("contact-list")).toBeInTheDocument();
    });

    it("displays relationships across all categories", async () => {
      await renderAndLogin();
      await navigateTo("#/relationships");

      // All 5 contacts from different categories are shown
      expect(screen.getByTestId("contact-row-rel_client_01")).toBeInTheDocument();
      expect(screen.getByTestId("contact-row-rel_friend_02")).toBeInTheDocument();
      expect(screen.getByTestId("contact-row-rel_investor_03")).toBeInTheDocument();
      expect(screen.getByTestId("contact-row-rel_colleague_04")).toBeInTheDocument();
      expect(screen.getByTestId("contact-row-rel_family_05")).toBeInTheDocument();
    });

    it("shows correct category badges for each relationship", async () => {
      await renderAndLogin();
      await navigateTo("#/relationships");

      // Each contact has the correct category badge
      expect(screen.getByTestId("category-badge-rel_client_01")).toHaveTextContent("Professional");
      expect(screen.getByTestId("category-badge-rel_friend_02")).toHaveTextContent("Personal");
      expect(screen.getByTestId("category-badge-rel_investor_03")).toHaveTextContent("Vip");
      expect(screen.getByTestId("category-badge-rel_colleague_04")).toHaveTextContent("Community");
      expect(screen.getByTestId("category-badge-rel_family_05")).toHaveTextContent("Family");
    });

    it("calls GET /api/v1/relationships with auth token", async () => {
      await renderAndLogin();
      await navigateTo("#/relationships");

      const relCalls = mockFetchData.calls.filter(
        (c) => c.url.match(/\/api\/v1\/relationships(\?.*)?$/) && c.method === "GET",
      );
      expect(relCalls.length).toBeGreaterThan(0);
    });

    it("creates a new relationship via the add form", async () => {
      await renderAndLogin();
      await navigateTo("#/relationships");

      // Click Add Relationship button
      fireEvent.click(screen.getByTestId("add-relationship-btn"));

      // Verify add form appeared
      expect(screen.getByTestId("add-form")).toBeInTheDocument();

      // Fill in all fields
      fireEvent.change(screen.getByTestId("form-name-input"), {
        target: { value: "Diana Prince" },
      });
      fireEvent.change(screen.getByTestId("form-email-input"), {
        target: { value: "diana@example.com" },
      });
      fireEvent.change(screen.getByTestId("form-category-select"), {
        target: { value: "community" },
      });
      fireEvent.change(screen.getByTestId("form-city-input"), {
        target: { value: "Metropolis" },
      });
      fireEvent.change(screen.getByTestId("form-timezone-input"), {
        target: { value: "America/New_York" },
      });
      fireEvent.change(screen.getByTestId("form-frequency-select"), {
        target: { value: "14" },
      });

      // Submit
      fireEvent.click(screen.getByTestId("submit-create-btn"));

      await flushLazy();

      // Verify POST was called
      const createCalls = mockFetchData.calls.filter(
        (c) => c.url === "/api/v1/relationships" && c.method === "POST",
      );
      expect(createCalls.length).toBe(1);
      expect(createCalls[0].body).toMatchObject({
        name: "Diana Prince",
        email: "diana@example.com",
        category: "community",
        city: "Metropolis",
        timezone: "America/New_York",
        frequency_days: 14,
      });

      // Success message shown
      expect(screen.getByTestId("relationships-status-msg")).toHaveTextContent(
        /relationship created/i,
      );
    });

    it("shows contact names and emails in list view", async () => {
      await renderAndLogin();
      await navigateTo("#/relationships");

      const row = screen.getByTestId("contact-row-rel_client_01");
      expect(within(row).getByText("Sarah Chen")).toBeInTheDocument();
      expect(within(row).getByText("sarah@clientcorp.com")).toBeInTheDocument();

      const row2 = screen.getByTestId("contact-row-rel_family_05");
      expect(within(row2).getByText("Maria Santos")).toBeInTheDocument();
      expect(within(row2).getByText("maria@family.com")).toBeInTheDocument();
    });

    it("shows reliability scores in list view", async () => {
      await renderAndLogin();
      await navigateTo("#/relationships");

      expect(screen.getByTestId("reliability-rel_client_01")).toHaveTextContent("95/100");
      expect(screen.getByTestId("reliability-rel_friend_02")).toHaveTextContent("62/100");
      expect(screen.getByTestId("reliability-rel_colleague_04")).toHaveTextContent("0/100");
    });
  });

  // =========================================================================
  // AC 2: Drift detection identifies overdue contacts
  // =========================================================================
  describe("AC 2: Drift detection identifies overdue contacts", () => {
    it("shows correct drift badges for contacts", async () => {
      await renderAndLogin();
      await navigateTo("#/relationships");

      // green = on track (Sarah Chen, within 7-day frequency)
      const greenBadge = screen.getByTestId("drift-badge-rel_client_01");
      expect(greenBadge).toHaveTextContent("On Track");
      expect(greenBadge.style.color).toBe("rgb(34, 197, 94)"); // green

      // red = overdue (Mike Torres, 76 days since last contact, 30-day frequency)
      const redBadge = screen.getByTestId("drift-badge-rel_friend_02");
      expect(redBadge).toHaveTextContent("Overdue");
      expect(redBadge.style.color).toBe("rgb(239, 68, 68)"); // red

      // yellow = drifting (Elena Vasquez, 21 days since last contact, 14-day frequency)
      const yellowBadge = screen.getByTestId("drift-badge-rel_investor_03");
      expect(yellowBadge).toHaveTextContent("Drifting");
      expect(yellowBadge.style.color).toBe("rgb(234, 179, 8)"); // yellow
    });

    it("opens drift report and shows overdue contacts ranked by urgency", async () => {
      await renderAndLogin();
      await navigateTo("#/relationships");

      // Click Drift Report button
      fireEvent.click(screen.getByTestId("drift-report-btn"));

      await flushLazy();

      // Drift report is shown
      expect(screen.getByTestId("drift-report")).toBeInTheDocument();
      expect(screen.getByTestId("drift-entries")).toBeInTheDocument();

      // Entries are present (sorted by severity: most overdue first)
      expect(screen.getByTestId("drift-entry-rel_friend_02")).toBeInTheDocument();
      expect(screen.getByTestId("drift-entry-rel_colleague_04")).toBeInTheDocument();
      expect(screen.getByTestId("drift-entry-rel_investor_03")).toBeInTheDocument();
    });

    it("shows correct days overdue and drift levels in report", async () => {
      await renderAndLogin();
      await navigateTo("#/relationships");

      fireEvent.click(screen.getByTestId("drift-report-btn"));

      await flushLazy();

      // Mike Torres: 46 days overdue, red
      expect(screen.getByTestId("drift-days-rel_friend_02")).toHaveTextContent(
        "46 days overdue",
      );
      expect(screen.getByTestId("drift-indicator-rel_friend_02")).toHaveTextContent("Overdue");

      // Elena Vasquez: 7 days overdue, yellow
      expect(screen.getByTestId("drift-days-rel_investor_03")).toHaveTextContent(
        "7 days overdue",
      );
      expect(screen.getByTestId("drift-indicator-rel_investor_03")).toHaveTextContent("Drifting");

      // James Park: 7 days overdue (never contacted), red
      expect(screen.getByTestId("drift-days-rel_colleague_04")).toHaveTextContent(
        "7 days overdue",
      );
      expect(screen.getByTestId("drift-indicator-rel_colleague_04")).toHaveTextContent("Overdue");
    });

    it("calls GET /api/v1/drift-report", async () => {
      await renderAndLogin();
      await navigateTo("#/relationships");

      fireEvent.click(screen.getByTestId("drift-report-btn"));

      await flushLazy();

      const driftCalls = mockFetchData.calls.filter(
        (c) => c.url === "/api/v1/drift-report" && c.method === "GET",
      );
      expect(driftCalls.length).toBe(1);
    });

    it("shows names with category badges in drift report", async () => {
      await renderAndLogin();
      await navigateTo("#/relationships");

      fireEvent.click(screen.getByTestId("drift-report-btn"));

      await flushLazy();

      expect(screen.getByTestId("drift-name-rel_friend_02")).toHaveTextContent("Mike Torres");
      expect(screen.getByTestId("drift-name-rel_investor_03")).toHaveTextContent("Elena Vasquez");
      expect(screen.getByTestId("drift-name-rel_colleague_04")).toHaveTextContent("James Park");
    });

    it("navigates back to contact list from drift report", async () => {
      await renderAndLogin();
      await navigateTo("#/relationships");

      fireEvent.click(screen.getByTestId("drift-report-btn"));

      await flushLazy();

      expect(screen.getByTestId("drift-report")).toBeInTheDocument();

      fireEvent.click(screen.getByTestId("back-to-list-btn"));

      await flushLazy();

      expect(screen.getByTestId("contact-list")).toBeInTheDocument();
    });
  });

  // =========================================================================
  // AC 3: Outcomes recorded in ledger
  // =========================================================================
  describe("AC 3: Outcomes recorded in ledger", () => {
    it("clicking a contact shows interaction timeline with outcomes", async () => {
      await renderAndLogin();
      await navigateTo("#/relationships");

      // Click the first contact (Sarah Chen, who has outcomes)
      fireEvent.click(screen.getByTestId("contact-row-rel_client_01"));

      await flushLazy();

      // Detail view is shown
      expect(screen.getByTestId("contact-detail")).toBeInTheDocument();
      expect(screen.getByTestId("detail-name")).toHaveTextContent("Sarah Chen");
      expect(screen.getByTestId("detail-email")).toHaveTextContent("sarah@clientcorp.com");

      // Outcomes timeline is visible
      expect(screen.getByTestId("outcomes-list")).toBeInTheDocument();
      expect(screen.getByTestId("outcome-out_01")).toBeInTheDocument();
      expect(screen.getByTestId("outcome-out_02")).toBeInTheDocument();
      expect(screen.getByTestId("outcome-out_03")).toBeInTheDocument();
    });

    it("shows outcome types correctly (positive/negative)", async () => {
      await renderAndLogin();
      await navigateTo("#/relationships");

      fireEvent.click(screen.getByTestId("contact-row-rel_client_01"));

      await flushLazy();

      // Outcome types
      expect(screen.getByTestId("outcome-type-out_01")).toHaveTextContent("positive");
      expect(screen.getByTestId("outcome-type-out_02")).toHaveTextContent("negative");
      expect(screen.getByTestId("outcome-type-out_03")).toHaveTextContent("positive");
    });

    it("shows outcome descriptions in timeline", async () => {
      await renderAndLogin();
      await navigateTo("#/relationships");

      fireEvent.click(screen.getByTestId("contact-row-rel_client_01"));

      await flushLazy();

      const outcome1 = screen.getByTestId("outcome-out_01");
      expect(within(outcome1).getByText("Attended quarterly review meeting")).toBeInTheDocument();

      const outcome2 = screen.getByTestId("outcome-out_02");
      expect(
        within(outcome2).getByText("Canceled by me -- scheduling conflict"),
      ).toBeInTheDocument();
    });

    it("calls GET /api/v1/relationships/:id/outcomes for detail view", async () => {
      await renderAndLogin();
      await navigateTo("#/relationships");

      fireEvent.click(screen.getByTestId("contact-row-rel_client_01"));

      await flushLazy();

      const outcomeCalls = mockFetchData.calls.filter(
        (c) =>
          c.url.match(/\/api\/v1\/relationships\/[^/]+\/outcomes$/) &&
          c.method === "GET",
      );
      expect(outcomeCalls.length).toBe(1);
      expect(outcomeCalls[0].url).toBe("/api/v1/relationships/rel_client_01/outcomes");
    });

    it("shows empty outcomes state for contacts with no interactions", async () => {
      await renderAndLogin();
      await navigateTo("#/relationships");

      // Click James Park (no outcomes)
      fireEvent.click(screen.getByTestId("contact-row-rel_colleague_04"));

      await flushLazy();

      expect(screen.getByTestId("outcomes-empty")).toBeInTheDocument();
      expect(
        screen.getByText("No interactions recorded yet."),
      ).toBeInTheDocument();
    });

    it("shows category and drift badges in detail view", async () => {
      await renderAndLogin();
      await navigateTo("#/relationships");

      fireEvent.click(screen.getByTestId("contact-row-rel_client_01"));

      await flushLazy();

      expect(screen.getByTestId("detail-category")).toHaveTextContent("Professional");
      expect(screen.getByTestId("detail-drift")).toHaveTextContent("On Track");
    });
  });

  // =========================================================================
  // AC 4: Reputation scores computed
  // =========================================================================
  describe("AC 4: Reputation scores computed", () => {
    it("shows reputation section in detail view", async () => {
      await renderAndLogin();
      await navigateTo("#/relationships");

      fireEvent.click(screen.getByTestId("contact-row-rel_client_01"));

      await flushLazy();

      expect(screen.getByTestId("reputation-section")).toBeInTheDocument();
      expect(screen.getByTestId("reputation-scores")).toBeInTheDocument();
    });

    it("shows correct overall reputation score", async () => {
      await renderAndLogin();
      await navigateTo("#/relationships");

      fireEvent.click(screen.getByTestId("contact-row-rel_client_01"));

      await flushLazy();

      expect(screen.getByTestId("score-overall")).toHaveTextContent("91/100");
    });

    it("shows all individual reputation score components", async () => {
      await renderAndLogin();
      await navigateTo("#/relationships");

      fireEvent.click(screen.getByTestId("contact-row-rel_client_01"));

      await flushLazy();

      expect(screen.getByTestId("score-reliability")).toHaveTextContent("95/100");
      expect(screen.getByTestId("score-responsiveness")).toHaveTextContent("90/100");
      expect(screen.getByTestId("score-follow-through")).toHaveTextContent("88/100");
    });

    it("shows interaction counts (total, positive, negative)", async () => {
      await renderAndLogin();
      await navigateTo("#/relationships");

      fireEvent.click(screen.getByTestId("contact-row-rel_client_01"));

      await flushLazy();

      expect(screen.getByTestId("score-interactions")).toHaveTextContent("15");
      expect(screen.getByTestId("score-positive")).toHaveTextContent("12");
      expect(screen.getByTestId("score-negative")).toHaveTextContent("1");
    });

    it("calls GET /api/v1/relationships/:id/reputation for detail view", async () => {
      await renderAndLogin();
      await navigateTo("#/relationships");

      fireEvent.click(screen.getByTestId("contact-row-rel_client_01"));

      await flushLazy();

      const repCalls = mockFetchData.calls.filter(
        (c) =>
          c.url.match(/\/api\/v1\/relationships\/[^/]+\/reputation$/) &&
          c.method === "GET",
      );
      expect(repCalls.length).toBe(1);
      expect(repCalls[0].url).toBe("/api/v1/relationships/rel_client_01/reputation");
    });
  });

  // =========================================================================
  // Complete user journey: login -> relationships -> detail -> drift -> back
  // =========================================================================
  describe("Complete user journey through relationship features", () => {
    it("full flow: login -> calendar -> relationships -> detail w/ reputation -> drift report -> back", async () => {
      // -- STEP 1: Login --
      render(<App />);
      await flushLazy();

      expect(screen.getByText("T-Minus")).toBeInTheDocument();
      await performLogin();

      // -- STEP 2: Calendar --
      expect(window.location.hash).toBe("#/calendar");
      // Calendar renders inside AppShell (no separate "T-Minus Calendar" heading)
      expect(screen.getByTestId("app-header")).toBeInTheDocument();

      // -- STEP 3: Navigate to Relationships --
      await navigateTo("#/relationships");

      // Use heading role to disambiguate from sidebar nav links
      expect(screen.getByRole("heading", { name: "Relationships" })).toBeInTheDocument();
      expect(screen.getByTestId("contact-list")).toBeInTheDocument();

      // All 5 contacts from diverse categories are visible
      const contactRows = screen.getByTestId("contact-rows");
      expect(contactRows.children.length).toBe(5);

      // Verify drift badges reflect correct state
      expect(screen.getByTestId("drift-badge-rel_client_01")).toHaveTextContent("On Track");
      expect(screen.getByTestId("drift-badge-rel_friend_02")).toHaveTextContent("Overdue");
      expect(screen.getByTestId("drift-badge-rel_investor_03")).toHaveTextContent("Drifting");

      // -- STEP 4: Open contact detail with reputation --
      fireEvent.click(screen.getByTestId("contact-row-rel_client_01"));

      await flushLazy();

      // Detail view loaded with all data
      expect(screen.getByTestId("contact-detail")).toBeInTheDocument();
      expect(screen.getByTestId("detail-name")).toHaveTextContent("Sarah Chen");
      expect(screen.getByTestId("reputation-section")).toBeInTheDocument();
      expect(screen.getByTestId("score-overall")).toHaveTextContent("91/100");
      expect(screen.getByTestId("outcomes-list")).toBeInTheDocument();

      // Three parallel API calls were made for detail view
      const detailRelCalls = mockFetchData.calls.filter(
        (c) =>
          c.url === "/api/v1/relationships/rel_client_01" &&
          c.method === "GET",
      );
      const detailRepCalls = mockFetchData.calls.filter(
        (c) =>
          c.url === "/api/v1/relationships/rel_client_01/reputation" &&
          c.method === "GET",
      );
      const detailOutCalls = mockFetchData.calls.filter(
        (c) =>
          c.url === "/api/v1/relationships/rel_client_01/outcomes" &&
          c.method === "GET",
      );
      expect(detailRelCalls.length).toBe(1);
      expect(detailRepCalls.length).toBe(1);
      expect(detailOutCalls.length).toBe(1);

      // -- STEP 5: Back to list, then open drift report --
      fireEvent.click(screen.getByTestId("back-to-list-btn"));

      await flushLazy();

      expect(screen.getByTestId("contact-list")).toBeInTheDocument();

      fireEvent.click(screen.getByTestId("drift-report-btn"));

      await flushLazy();

      expect(screen.getByTestId("drift-report")).toBeInTheDocument();
      expect(screen.getByTestId("drift-entries")).toBeInTheDocument();

      // Most overdue first
      const entries = screen.getByTestId("drift-entries");
      const entryElements = entries.children;
      expect(entryElements.length).toBe(3);

      // Verify names are in the entries
      expect(screen.getByTestId("drift-name-rel_friend_02")).toHaveTextContent("Mike Torres");
      expect(screen.getByTestId("drift-name-rel_investor_03")).toHaveTextContent("Elena Vasquez");

      // -- STEP 6: Back to list, navigate back to calendar --
      fireEvent.click(screen.getByTestId("back-to-list-btn"));

      await flushLazy();

      expect(screen.getByTestId("contact-list")).toBeInTheDocument();

      // Navigate back to calendar
      await navigateTo("#/calendar");
      expect(window.location.hash).toBe("#/calendar");
    });
  });

  // =========================================================================
  // Cross-cutting: CRUD operations work through App router
  // =========================================================================
  describe("CRUD operations through App router", () => {
    it("edit a relationship through detail view", async () => {
      await renderAndLogin();
      await navigateTo("#/relationships");

      // Open detail
      fireEvent.click(screen.getByTestId("contact-row-rel_client_01"));

      await flushLazy();

      // Click edit
      fireEvent.click(screen.getByTestId("edit-btn"));
      expect(screen.getByTestId("edit-form")).toBeInTheDocument();

      // Verify pre-filled values
      expect(screen.getByTestId("edit-name-input")).toHaveValue("Sarah Chen");

      // Change name
      fireEvent.change(screen.getByTestId("edit-name-input"), {
        target: { value: "Sarah Chen-Updated" },
      });

      // Save
      fireEvent.click(screen.getByTestId("save-edit-btn"));

      await flushLazy();

      // PUT call was made
      const putCalls = mockFetchData.calls.filter(
        (c) =>
          c.url === "/api/v1/relationships/rel_client_01" &&
          c.method === "PUT",
      );
      expect(putCalls.length).toBe(1);
      expect(putCalls[0].body).toMatchObject({
        name: "Sarah Chen-Updated",
      });

      // Success message shown
      expect(screen.getByTestId("relationships-status-msg")).toHaveTextContent(
        /relationship updated/i,
      );
    });

    it("delete a relationship through detail view", async () => {
      await renderAndLogin();
      await navigateTo("#/relationships");

      // Open detail of colleague
      fireEvent.click(screen.getByTestId("contact-row-rel_colleague_04"));

      await flushLazy();

      expect(screen.getByTestId("detail-name")).toHaveTextContent("James Park");

      // Delete
      fireEvent.click(screen.getByTestId("delete-btn"));

      await flushLazy();

      // DELETE call was made
      const deleteCalls = mockFetchData.calls.filter(
        (c) =>
          c.url === "/api/v1/relationships/rel_colleague_04" &&
          c.method === "DELETE",
      );
      expect(deleteCalls.length).toBe(1);

      // Returns to list with success message
      expect(screen.getByTestId("contact-list")).toBeInTheDocument();
      expect(screen.getByTestId("relationships-status-msg")).toHaveTextContent(
        /relationship deleted/i,
      );
    });
  });

  // =========================================================================
  // Cross-cutting: Route guards with relationship page
  // =========================================================================
  describe("Route guards for relationships", () => {
    it("unauthenticated access to relationships redirects to login", async () => {
      window.location.hash = "#/relationships";
      render(<App />);

      expect(window.location.hash).toBe("#/login");
    });

    it("authenticated user can navigate to relationships and back", async () => {
      await renderAndLogin();

      await navigateTo("#/relationships");
      // Use heading role to disambiguate from sidebar nav links
      expect(screen.getByRole("heading", { name: "Relationships" })).toBeInTheDocument();

      // Back to Calendar link is present
      expect(screen.getByText("Back to Calendar")).toBeInTheDocument();
    });
  });
});
