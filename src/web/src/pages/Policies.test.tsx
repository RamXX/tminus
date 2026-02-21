/**
 * Integration tests for the Policies page component.
 *
 * Tests cover:
 * - Matrix renders with mock account/policy data
 * - Clicking cell cycles detail level (BUSY -> TITLE -> FULL -> BUSY)
 * - Clicking cell calls PUT API with correct arguments
 * - UI updates optimistically
 * - Rollback on API failure
 * - Visual feedback on save success/failure (status messages)
 * - Default BUSY level indicated with visual marker
 * - Loading, error, and empty states
 * - Self-edge cells show "--" (not clickable)
 *
 * Uses React Testing Library with userEvent for realistic interactions.
 *
 * Since Policies now uses useApi() internally, tests mock the
 * api-provider and auth modules instead of passing props.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Policies } from "./Policies";
import type {
  PolicyMatrixData,
  PolicyEdgeData,
  DetailLevel,
} from "../lib/policies";

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const MOCK_ACCOUNTS = [
  { account_id: "acc-work", email: "work@example.com" },
  { account_id: "acc-personal", email: "personal@example.com" },
  { account_id: "acc-side", email: "side@example.com" },
];

const MOCK_EDGES: PolicyEdgeData[] = [
  {
    policy_id: "pol-1",
    from_account_id: "acc-work",
    to_account_id: "acc-personal",
    detail_level: "TITLE",
  },
  {
    policy_id: "pol-2",
    from_account_id: "acc-personal",
    to_account_id: "acc-work",
    detail_level: "FULL",
  },
];

const MOCK_POLICY_DATA: PolicyMatrixData = {
  accounts: MOCK_ACCOUNTS,
  edges: MOCK_EDGES,
};

// ---------------------------------------------------------------------------
// Mock the API provider and auth
// ---------------------------------------------------------------------------

const mockFetchPolicies = vi.fn<() => Promise<PolicyMatrixData>>();
const mockUpdatePolicyEdge = vi.fn<(policyId: string, edge: { from_account_id: string; to_account_id: string; detail_level: DetailLevel }) => Promise<PolicyEdgeData>>();

const mockApiValue = {
  fetchPolicies: mockFetchPolicies,
  updatePolicyEdge: mockUpdatePolicyEdge,
};

vi.mock("../lib/api-provider", () => ({
  useApi: () => mockApiValue,
  ApiProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("../lib/auth", () => ({
  useAuth: () => ({
    token: "test-jwt-token",
    refreshToken: "test-refresh-token",
    user: { id: "user-1", email: "test@example.com" },
    login: vi.fn(),
    logout: vi.fn(),
  }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupMockResponse(data: PolicyMatrixData = MOCK_POLICY_DATA) {
  mockFetchPolicies.mockResolvedValue(data);
}

function setupFailingResponse(message = "Network error") {
  mockFetchPolicies.mockRejectedValue(new Error(message));
}

function setupMockUpdateEdge(response?: Partial<PolicyEdgeData>) {
  mockUpdatePolicyEdge.mockImplementation(
    async (
      policyId: string,
      edge: {
        from_account_id: string;
        to_account_id: string;
        detail_level: DetailLevel;
      },
    ): Promise<PolicyEdgeData> => ({
      policy_id: response?.policy_id ?? policyId,
      from_account_id: edge.from_account_id,
      to_account_id: edge.to_account_id,
      detail_level: edge.detail_level,
      ...response,
    }),
  );
}

function setupFailingUpdateEdge(message = "Save failed") {
  mockUpdatePolicyEdge.mockRejectedValue(new Error(message));
}

/**
 * Render the component and wait for the initial async fetch to complete.
 */
async function renderAndWait() {
  render(<Policies />);
  // Flush microtasks so the async fetch resolves
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

/**
 * Flush all pending microtasks/promises so async state updates settle.
 * Use after user interactions that trigger async handlers.
 */
async function flushAsync() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Policies Page", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockFetchPolicies.mockReset();
    mockUpdatePolicyEdge.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -----------------------------------------------------------------------
  // Rendering
  // -----------------------------------------------------------------------

  describe("matrix rendering", () => {
    it("renders page title", async () => {
      setupMockResponse();
      await renderAndWait();
      expect(screen.getByText("Policy Management")).toBeInTheDocument();
    });

    it("renders the policy matrix table", async () => {
      setupMockResponse();
      await renderAndWait();
      expect(screen.getByTestId("policy-matrix")).toBeInTheDocument();
    });

    it("renders all account emails as column headers", async () => {
      setupMockResponse();
      await renderAndWait();
      const table = screen.getByTestId("policy-matrix");
      const headers = within(table).getAllByText(/example\.com/);
      // 3 accounts in columns + 3 accounts in rows = 6 occurrences
      expect(headers.length).toBe(6);
    });

    it("renders TITLE level for work->personal edge", async () => {
      setupMockResponse();
      await renderAndWait();
      const btn = screen.getByTestId("cell-btn-acc-work-acc-personal");
      expect(btn).toHaveAttribute("data-detail-level", "TITLE");
    });

    it("renders FULL level for personal->work edge", async () => {
      setupMockResponse();
      await renderAndWait();
      const btn = screen.getByTestId("cell-btn-acc-personal-acc-work");
      expect(btn).toHaveAttribute("data-detail-level", "FULL");
    });

    it("renders default BUSY for edges without explicit policy", async () => {
      setupMockResponse();
      await renderAndWait();
      // work -> side has no explicit edge, should default to BUSY
      const btn = screen.getByTestId("cell-btn-acc-work-acc-side");
      expect(btn).toHaveAttribute("data-detail-level", "BUSY");
      expect(btn).toHaveAttribute("data-is-default", "true");
    });

    it("renders self-edge cells with '--'", async () => {
      setupMockResponse();
      await renderAndWait();
      const selfCell = screen.getByTestId("cell-acc-work-acc-work");
      expect(selfCell.textContent).toBe("--");
    });

    it("renders legend with all detail levels", async () => {
      setupMockResponse();
      await renderAndWait();
      const legend = screen.getByTestId("policy-legend");
      expect(within(legend).getByText("BUSY")).toBeInTheDocument();
      expect(within(legend).getByText("TITLE")).toBeInTheDocument();
      expect(within(legend).getByText("FULL")).toBeInTheDocument();
    });

    it("renders default indicator in legend for BUSY", async () => {
      setupMockResponse();
      await renderAndWait();
      const legend = screen.getByTestId("policy-legend");
      expect(within(legend).getByText("(default)")).toBeInTheDocument();
    });
  });

  // -----------------------------------------------------------------------
  // Default BUSY highlighting
  // -----------------------------------------------------------------------

  describe("default BUSY highlighting", () => {
    it("marks cells without explicit policy as default", async () => {
      setupMockResponse();
      await renderAndWait();
      const btn = screen.getByTestId("cell-btn-acc-work-acc-side");
      expect(btn).toHaveAttribute("data-is-default", "true");
    });

    it("does NOT mark cells with explicit policy as default", async () => {
      setupMockResponse();
      await renderAndWait();
      const btn = screen.getByTestId("cell-btn-acc-work-acc-personal");
      expect(btn).toHaveAttribute("data-is-default", "false");
    });

    it("default cells show asterisk indicator", async () => {
      setupMockResponse();
      await renderAndWait();
      const btn = screen.getByTestId("cell-btn-acc-work-acc-side");
      // The button text should contain BUSY and *
      expect(btn.textContent).toContain("BUSY");
      expect(btn.textContent).toContain("*");
    });

    it("non-default cells do NOT show asterisk", async () => {
      setupMockResponse();
      await renderAndWait();
      const btn = screen.getByTestId("cell-btn-acc-work-acc-personal");
      expect(btn.textContent).toContain("TITLE");
      expect(btn.textContent).not.toContain("*");
    });
  });

  // -----------------------------------------------------------------------
  // Cell click interaction
  // -----------------------------------------------------------------------

  describe("cell click - detail level cycling", () => {
    it("clicking TITLE cell changes to FULL optimistically", async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      setupMockResponse();
      setupMockUpdateEdge();
      await renderAndWait();

      const btn = screen.getByTestId("cell-btn-acc-work-acc-personal");
      expect(btn).toHaveAttribute("data-detail-level", "TITLE");

      await user.click(btn);

      // Optimistic update should show FULL immediately
      expect(btn).toHaveAttribute("data-detail-level", "FULL");
    });

    it("clicking FULL cell changes to BUSY optimistically", async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      setupMockResponse();
      setupMockUpdateEdge();
      await renderAndWait();

      const btn = screen.getByTestId("cell-btn-acc-personal-acc-work");
      expect(btn).toHaveAttribute("data-detail-level", "FULL");

      await user.click(btn);

      expect(btn).toHaveAttribute("data-detail-level", "BUSY");
    });

    it("clicking default BUSY cell changes to TITLE optimistically", async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      setupMockResponse();
      setupMockUpdateEdge();
      await renderAndWait();

      const btn = screen.getByTestId("cell-btn-acc-work-acc-side");
      expect(btn).toHaveAttribute("data-detail-level", "BUSY");
      expect(btn).toHaveAttribute("data-is-default", "true");

      await user.click(btn);

      expect(btn).toHaveAttribute("data-detail-level", "TITLE");
      // After clicking, should no longer be marked as default
      expect(btn).toHaveAttribute("data-is-default", "false");
    });
  });

  // -----------------------------------------------------------------------
  // API calls
  // -----------------------------------------------------------------------

  describe("API interaction", () => {
    it("calls updatePolicyEdge with correct args on cell click", async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      setupMockResponse();
      setupMockUpdateEdge();
      await renderAndWait();

      const btn = screen.getByTestId("cell-btn-acc-work-acc-personal");
      await user.click(btn);
      await flushAsync();

      expect(mockUpdatePolicyEdge).toHaveBeenCalledTimes(1);
      expect(mockUpdatePolicyEdge).toHaveBeenCalledWith("pol-1", {
        from_account_id: "acc-work",
        to_account_id: "acc-personal",
        detail_level: "FULL", // TITLE -> FULL
      });
    });

    it("uses 'new' as policyId for edges without existing policy", async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      setupMockResponse();
      setupMockUpdateEdge({ policy_id: "pol-new-1" });
      await renderAndWait();

      // work -> side has no explicit edge (policyId is null)
      const btn = screen.getByTestId("cell-btn-acc-work-acc-side");
      await user.click(btn);
      await flushAsync();

      expect(mockUpdatePolicyEdge).toHaveBeenCalledWith("new", {
        from_account_id: "acc-work",
        to_account_id: "acc-side",
        detail_level: "TITLE", // BUSY -> TITLE
      });
    });

    it("updates policyId from server response after save", async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      setupMockResponse();
      setupMockUpdateEdge({ policy_id: "pol-server-123" });
      await renderAndWait();

      const btn = screen.getByTestId("cell-btn-acc-work-acc-side");
      await user.click(btn);
      await flushAsync(); // wait for first save to complete

      // The next click should use the server-provided policy_id
      await user.click(btn);
      await flushAsync(); // wait for second save to complete

      expect(mockUpdatePolicyEdge).toHaveBeenCalledTimes(2);
      // Second call should use the server-assigned policyId
      expect(mockUpdatePolicyEdge.mock.calls[1][0]).toBe("pol-server-123");
    });
  });

  // -----------------------------------------------------------------------
  // Save feedback
  // -----------------------------------------------------------------------

  describe("save feedback", () => {
    it("shows success message after successful save", async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      setupMockResponse();
      setupMockUpdateEdge();
      await renderAndWait();

      const btn = screen.getByTestId("cell-btn-acc-work-acc-personal");
      await user.click(btn);
      await flushAsync(); // wait for API call to resolve

      const status = screen.getByTestId("policy-status");
      expect(status).toHaveAttribute("data-status-type", "success");
      expect(status.textContent).toContain("Policy updated");
    });

    it("renders status as fixed overlay toast (no layout shift)", async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      setupMockResponse();
      setupMockUpdateEdge();
      await renderAndWait();

      const btn = screen.getByTestId("cell-btn-acc-work-acc-personal");
      await user.click(btn);
      await flushAsync();

      const status = screen.getByTestId("policy-status");
      expect(status).toHaveClass("fixed");
      expect(status).toHaveClass("pointer-events-none");
    });

    it("shows error message after failed save", async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      setupMockResponse();
      setupFailingUpdateEdge("Server error");
      await renderAndWait();

      const btn = screen.getByTestId("cell-btn-acc-work-acc-personal");
      await user.click(btn);
      await flushAsync(); // wait for API call to reject

      const status = screen.getByTestId("policy-status");
      expect(status).toHaveAttribute("data-status-type", "error");
      expect(status.textContent).toContain("Failed to update");
      expect(status.textContent).toContain("Server error");
    });

    it("rolls back detail level on save failure", async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      setupMockResponse();
      setupFailingUpdateEdge("Oops");
      await renderAndWait();

      const btn = screen.getByTestId("cell-btn-acc-work-acc-personal");
      // Was TITLE before click
      expect(btn).toHaveAttribute("data-detail-level", "TITLE");

      await user.click(btn);
      await flushAsync(); // wait for API call to reject and rollback

      // After error, should roll back to TITLE
      expect(btn).toHaveAttribute("data-detail-level", "TITLE");
    });

    it("rolls back isDefault flag on save failure for default cells", async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      setupMockResponse();
      setupFailingUpdateEdge("Oops");
      await renderAndWait();

      const btn = screen.getByTestId("cell-btn-acc-work-acc-side");
      expect(btn).toHaveAttribute("data-is-default", "true");

      await user.click(btn);
      await flushAsync(); // wait for API call to reject and rollback

      // Should roll back to default state
      expect(btn).toHaveAttribute("data-is-default", "true");
      expect(btn).toHaveAttribute("data-detail-level", "BUSY");
    });

    it("clears status message after 3 seconds", async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      setupMockResponse();
      setupMockUpdateEdge();
      await renderAndWait();

      const btn = screen.getByTestId("cell-btn-acc-work-acc-personal");
      await user.click(btn);
      await flushAsync(); // wait for API call to resolve

      expect(screen.getByTestId("policy-status")).toBeInTheDocument();

      // Advance 3 seconds for the status to clear
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });

      expect(screen.queryByTestId("policy-status")).not.toBeInTheDocument();
    });
  });

  // -----------------------------------------------------------------------
  // Loading state
  // -----------------------------------------------------------------------

  describe("loading state", () => {
    it("shows loading indicator while fetching", () => {
      mockFetchPolicies.mockReturnValue(new Promise(() => {}));
      render(<Policies />);

      expect(screen.getByTestId("policies-loading")).toBeInTheDocument();
      expect(screen.getByText("Loading policies...")).toBeInTheDocument();
    });
  });

  // -----------------------------------------------------------------------
  // Error state
  // -----------------------------------------------------------------------

  describe("error state", () => {
    it("shows error message on fetch failure", async () => {
      setupFailingResponse("API unavailable");
      await renderAndWait();

      expect(screen.getByTestId("policies-error")).toBeInTheDocument();
      expect(screen.getByText(/failed to load/i)).toBeInTheDocument();
      expect(screen.getByText(/API unavailable/)).toBeInTheDocument();
    });

    it("shows retry button on error", async () => {
      setupFailingResponse();
      await renderAndWait();

      expect(
        screen.getByRole("button", { name: /retry/i }),
      ).toBeInTheDocument();
    });

    it("retry button calls fetchPolicies again", async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      setupFailingResponse();
      await renderAndWait();

      expect(mockFetchPolicies).toHaveBeenCalledTimes(1);

      const retryBtn = screen.getByRole("button", { name: /retry/i });
      await user.click(retryBtn);

      expect(mockFetchPolicies).toHaveBeenCalledTimes(2);
    });
  });

  // -----------------------------------------------------------------------
  // Empty state
  // -----------------------------------------------------------------------

  describe("empty state", () => {
    it("shows message when no accounts configured", async () => {
      setupMockResponse({
        accounts: [],
        edges: [],
      });
      await renderAndWait();

      expect(screen.getByTestId("policies-empty")).toBeInTheDocument();
      expect(screen.getByText(/no accounts/i)).toBeInTheDocument();
    });

    it("shows message when only one account (need 2+ for matrix)", async () => {
      setupMockResponse({
        accounts: [{ account_id: "acc-solo", email: "solo@example.com" }],
        edges: [],
      });
      await renderAndWait();

      expect(screen.getByTestId("policies-empty")).toBeInTheDocument();
      expect(screen.getByText(/another account/i)).toBeInTheDocument();
    });
  });

  // -----------------------------------------------------------------------
  // Back link
  // -----------------------------------------------------------------------

  describe("navigation", () => {
    it("renders back to calendar link", async () => {
      setupMockResponse();
      await renderAndWait();
      const link = screen.getByText("Back to Calendar");
      expect(link).toHaveAttribute("href", "#/calendar");
    });
  });
});
