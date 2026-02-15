/**
 * Unit + integration tests for the ErrorRecovery page.
 *
 * Tests cover:
 * - Unit: error list rendering, retry button per mirror, batch retry button,
 *   error message display, loading/empty/error states
 * - Integration: component renders error list from mock journal data,
 *   click retry -> POST API called -> error removed from list on success,
 *   batch retry calls POST for each error,
 *   failed retry shows error message,
 *   success/failure feedback on retry
 *
 * Uses React Testing Library with fireEvent for click interactions.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, act, fireEvent } from "@testing-library/react";
import { ErrorRecovery, type ErrorRecoveryProps } from "./ErrorRecovery";
import type { ErrorMirror, RetryResult } from "../lib/error-recovery";

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

function makeErrorMirror(
  id: string,
  overrides: Partial<ErrorMirror> = {},
): ErrorMirror {
  return {
    mirror_id: id,
    canonical_event_id: `evt-${id}`,
    target_account_id: `acc-${id}`,
    target_account_email: `${id}@example.com`,
    error_message: `Sync failed for ${id}`,
    error_ts: "2026-02-14T12:00:00Z",
    event_summary: `Meeting ${id}`,
    ...overrides,
  };
}

const MOCK_ERRORS: ErrorMirror[] = [
  makeErrorMirror("m1", {
    error_message: "Google API rate limit exceeded",
    target_account_email: "work@gmail.com",
    event_summary: "Team standup",
  }),
  makeErrorMirror("m2", {
    error_message: "Calendar not found",
    target_account_email: "personal@gmail.com",
    event_summary: "Dentist appointment",
  }),
  makeErrorMirror("m3", {
    error_message: "Token expired",
    target_account_email: "work@gmail.com",
    event_summary: "Board meeting",
  }),
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockFetchErrors(errors: ErrorMirror[] = MOCK_ERRORS) {
  return vi.fn(async (): Promise<ErrorMirror[]> => errors);
}

function createFailingFetchErrors(message = "Network error") {
  return vi.fn(async (): Promise<ErrorMirror[]> => {
    throw new Error(message);
  });
}

function createMockRetryMirror(result: Partial<RetryResult> = {}) {
  return vi.fn(
    async (mirrorId: string): Promise<RetryResult> => ({
      mirror_id: mirrorId,
      success: true,
      ...result,
    }),
  );
}

function createFailingRetryMirror(message = "Retry failed") {
  return vi.fn(async (_mirrorId: string): Promise<RetryResult> => {
    throw new Error(message);
  });
}

/**
 * Render the ErrorRecovery component and wait for async fetch to complete.
 */
async function renderAndWait(overrides: Partial<ErrorRecoveryProps> = {}) {
  const fetchErrors = overrides.fetchErrors ?? createMockFetchErrors();
  const retryMirror = overrides.retryMirror ?? createMockRetryMirror();

  const result = render(
    <ErrorRecovery fetchErrors={fetchErrors} retryMirror={retryMirror} />,
  );

  // Flush microtasks so the async fetch resolves
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });

  return { ...result, fetchErrors, retryMirror };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ErrorRecovery Page", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-02-14T12:00:00Z").getTime() });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // =========================================================================
  // Unit Tests: Error List Rendering
  // =========================================================================

  describe("error list rendering", () => {
    it("renders page title", async () => {
      await renderAndWait();

      expect(screen.getByText("Error Recovery")).toBeInTheDocument();
    });

    it("renders all error mirrors in the list", async () => {
      await renderAndWait();

      expect(screen.getByTestId("error-row-m1")).toBeInTheDocument();
      expect(screen.getByTestId("error-row-m2")).toBeInTheDocument();
      expect(screen.getByTestId("error-row-m3")).toBeInTheDocument();
    });

    it("shows target account email for each error", async () => {
      await renderAndWait();

      const row1 = screen.getByTestId("error-row-m1");
      expect(within(row1).getByText("work@gmail.com")).toBeInTheDocument();

      const row2 = screen.getByTestId("error-row-m2");
      expect(
        within(row2).getByText("personal@gmail.com"),
      ).toBeInTheDocument();
    });

    it("shows error message for each mirror", async () => {
      await renderAndWait();

      const row1 = screen.getByTestId("error-row-m1");
      expect(
        within(row1).getByTestId("error-message"),
      ).toHaveTextContent("Google API rate limit exceeded");

      const row2 = screen.getByTestId("error-row-m2");
      expect(
        within(row2).getByTestId("error-message"),
      ).toHaveTextContent("Calendar not found");
    });

    it("shows event summary for each mirror", async () => {
      await renderAndWait();

      const row1 = screen.getByTestId("error-row-m1");
      expect(within(row1).getByText("Team standup")).toBeInTheDocument();
    });

    it("renders a retry button for each error mirror", async () => {
      await renderAndWait();

      expect(screen.getByTestId("retry-btn-m1")).toBeInTheDocument();
      expect(screen.getByTestId("retry-btn-m2")).toBeInTheDocument();
      expect(screen.getByTestId("retry-btn-m3")).toBeInTheDocument();
    });

    it("renders batch retry all button", async () => {
      await renderAndWait();

      expect(screen.getByTestId("batch-retry-btn")).toBeInTheDocument();
    });

    it("batch retry button shows error count", async () => {
      await renderAndWait();

      const btn = screen.getByTestId("batch-retry-btn");
      expect(btn.textContent).toContain("3");
    });

    it("renders error count summary", async () => {
      await renderAndWait();

      const summary = screen.getByTestId("error-count-summary");
      expect(summary.textContent).toContain("3");
    });
  });

  // =========================================================================
  // Unit Tests: Loading / Empty / Error States
  // =========================================================================

  describe("loading state", () => {
    it("shows loading indicator while fetching", () => {
      const fetchErrors = vi.fn(
        (): Promise<ErrorMirror[]> => new Promise(() => {}),
      );
      render(
        <ErrorRecovery
          fetchErrors={fetchErrors}
          retryMirror={createMockRetryMirror()}
        />,
      );

      expect(screen.getByTestId("error-recovery-loading")).toBeInTheDocument();
    });
  });

  describe("empty state", () => {
    it("shows 'no errors' message when list is empty", async () => {
      await renderAndWait({ fetchErrors: createMockFetchErrors([]) });

      expect(screen.getByTestId("error-recovery-empty")).toBeInTheDocument();
      expect(screen.getByText(/no errors/i)).toBeInTheDocument();
    });

    it("does not show batch retry button when empty", async () => {
      await renderAndWait({ fetchErrors: createMockFetchErrors([]) });

      expect(screen.queryByTestId("batch-retry-btn")).not.toBeInTheDocument();
    });
  });

  describe("fetch error state", () => {
    it("shows error message on fetch failure", async () => {
      await renderAndWait({
        fetchErrors: createFailingFetchErrors("API unavailable"),
      });

      expect(
        screen.getByTestId("error-recovery-fetch-error"),
      ).toBeInTheDocument();
      expect(screen.getByText(/api unavailable/i)).toBeInTheDocument();
    });

    it("shows retry button on fetch failure", async () => {
      await renderAndWait({ fetchErrors: createFailingFetchErrors() });

      expect(
        screen.getByRole("button", { name: /retry/i }),
      ).toBeInTheDocument();
    });
  });

  // =========================================================================
  // Integration Tests: Single Retry
  // =========================================================================

  describe("integration: single mirror retry", () => {
    it("calls retryMirror with correct mirror ID on click", async () => {
      const retryMirror = createMockRetryMirror();
      await renderAndWait({ retryMirror });

      fireEvent.click(screen.getByTestId("retry-btn-m1"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(retryMirror).toHaveBeenCalledTimes(1);
      expect(retryMirror).toHaveBeenCalledWith("m1");
    });

    it("removes mirror from list on successful retry", async () => {
      const retryMirror = createMockRetryMirror();
      await renderAndWait({ retryMirror });

      // m1 is in the list
      expect(screen.getByTestId("error-row-m1")).toBeInTheDocument();

      fireEvent.click(screen.getByTestId("retry-btn-m1"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      // m1 should be removed
      expect(screen.queryByTestId("error-row-m1")).not.toBeInTheDocument();

      // Others remain
      expect(screen.getByTestId("error-row-m2")).toBeInTheDocument();
      expect(screen.getByTestId("error-row-m3")).toBeInTheDocument();
    });

    it("shows success feedback after successful retry", async () => {
      const retryMirror = createMockRetryMirror();
      await renderAndWait({ retryMirror });

      fireEvent.click(screen.getByTestId("retry-btn-m1"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      const status = screen.getByTestId("retry-status");
      expect(status).toHaveAttribute("data-status-type", "success");
      expect(status.textContent).toMatch(/retried successfully/i);
    });

    it("shows error feedback when retry fails (exception)", async () => {
      const retryMirror = createFailingRetryMirror("Server error");
      await renderAndWait({ retryMirror });

      fireEvent.click(screen.getByTestId("retry-btn-m1"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      const status = screen.getByTestId("retry-status");
      expect(status).toHaveAttribute("data-status-type", "error");
      expect(status.textContent).toMatch(/server error/i);
    });

    it("mirror stays in list when retry fails", async () => {
      const retryMirror = createFailingRetryMirror("Server error");
      await renderAndWait({ retryMirror });

      fireEvent.click(screen.getByTestId("retry-btn-m1"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      // m1 should still be in the list
      expect(screen.getByTestId("error-row-m1")).toBeInTheDocument();
    });

    it("disables retry button while retrying", async () => {
      // Use a retry that never resolves
      const retryMirror = vi.fn(
        (_mirrorId: string): Promise<RetryResult> => new Promise(() => {}),
      );
      await renderAndWait({ retryMirror });

      fireEvent.click(screen.getByTestId("retry-btn-m1"));

      const btn = screen.getByTestId("retry-btn-m1");
      expect(btn).toBeDisabled();
    });

    it("updates error count after successful retry", async () => {
      const retryMirror = createMockRetryMirror();
      await renderAndWait({ retryMirror });

      // Initially 3 errors
      expect(screen.getByTestId("error-count-summary").textContent).toContain("3");

      fireEvent.click(screen.getByTestId("retry-btn-m1"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      // Now 2 errors
      expect(screen.getByTestId("error-count-summary").textContent).toContain("2");
    });
  });

  // =========================================================================
  // Integration Tests: Batch Retry
  // =========================================================================

  describe("integration: batch retry all", () => {
    it("calls retryMirror for each error mirror", async () => {
      const retryMirror = createMockRetryMirror();
      await renderAndWait({ retryMirror });

      fireEvent.click(screen.getByTestId("batch-retry-btn"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(retryMirror).toHaveBeenCalledTimes(3);
      expect(retryMirror).toHaveBeenCalledWith("m1");
      expect(retryMirror).toHaveBeenCalledWith("m2");
      expect(retryMirror).toHaveBeenCalledWith("m3");
    });

    it("removes all mirrors on full batch success", async () => {
      const retryMirror = createMockRetryMirror();
      await renderAndWait({ retryMirror });

      fireEvent.click(screen.getByTestId("batch-retry-btn"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.queryByTestId("error-row-m1")).not.toBeInTheDocument();
      expect(screen.queryByTestId("error-row-m2")).not.toBeInTheDocument();
      expect(screen.queryByTestId("error-row-m3")).not.toBeInTheDocument();
    });

    it("shows success feedback for batch retry", async () => {
      const retryMirror = createMockRetryMirror();
      await renderAndWait({ retryMirror });

      fireEvent.click(screen.getByTestId("batch-retry-btn"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      const status = screen.getByTestId("retry-status");
      expect(status).toHaveAttribute("data-status-type", "success");
      expect(status.textContent).toMatch(/3.*retried/i);
    });

    it("keeps failed mirrors in list on partial batch failure", async () => {
      // m1 succeeds, m2 fails, m3 succeeds
      const retryMirror = vi.fn(async (mirrorId: string): Promise<RetryResult> => {
        if (mirrorId === "m2") {
          throw new Error("Calendar not found");
        }
        return { mirror_id: mirrorId, success: true };
      });
      await renderAndWait({ retryMirror });

      fireEvent.click(screen.getByTestId("batch-retry-btn"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      // m1 and m3 removed, m2 remains
      expect(screen.queryByTestId("error-row-m1")).not.toBeInTheDocument();
      expect(screen.getByTestId("error-row-m2")).toBeInTheDocument();
      expect(screen.queryByTestId("error-row-m3")).not.toBeInTheDocument();
    });

    it("shows partial failure feedback", async () => {
      const retryMirror = vi.fn(async (mirrorId: string): Promise<RetryResult> => {
        if (mirrorId === "m2") {
          throw new Error("Calendar not found");
        }
        return { mirror_id: mirrorId, success: true };
      });
      await renderAndWait({ retryMirror });

      fireEvent.click(screen.getByTestId("batch-retry-btn"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      const status = screen.getByTestId("retry-status");
      expect(status).toHaveAttribute("data-status-type", "error");
      // Should mention both succeeded and failed counts
      expect(status.textContent).toMatch(/2.*succeeded/i);
      expect(status.textContent).toMatch(/1.*failed/i);
    });

    it("disables batch retry button while retrying", async () => {
      const retryMirror = vi.fn(
        (_mirrorId: string): Promise<RetryResult> => new Promise(() => {}),
      );
      await renderAndWait({ retryMirror });

      fireEvent.click(screen.getByTestId("batch-retry-btn"));

      const btn = screen.getByTestId("batch-retry-btn");
      expect(btn).toBeDisabled();
    });
  });

  // =========================================================================
  // Integration Tests: Navigation
  // =========================================================================

  describe("navigation", () => {
    it("has a link back to sync status", async () => {
      await renderAndWait();

      const link = screen.getByText(/back to sync status/i);
      expect(link).toBeInTheDocument();
      expect(link.closest("a")).toHaveAttribute("href", "#/sync-status");
    });
  });
});
