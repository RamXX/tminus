/**
 * Unit tests for error-recovery pure logic and API functions.
 *
 * Tests cover:
 * - fetchErrorMirrors calls correct API endpoint
 * - retryMirror calls correct API endpoint with POST
 * - batchRetryMirrors aggregates results correctly
 * - batchRetryMirrors handles partial failures
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  fetchErrorMirrors,
  retryMirror,
  batchRetryMirrors,
  type ErrorMirror,
  type RetryResult,
} from "./error-recovery";

// ---------------------------------------------------------------------------
// Mock the apiFetch function
// ---------------------------------------------------------------------------

vi.mock("./api", () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from "./api";
const mockApiFetch = vi.mocked(apiFetch);

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

function makeErrorMirror(id: string, overrides: Partial<ErrorMirror> = {}): ErrorMirror {
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("error-recovery lib", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("fetchErrorMirrors", () => {
    it("calls apiFetch with correct path and token", async () => {
      const mockMirrors = [makeErrorMirror("m1")];
      mockApiFetch.mockResolvedValue(mockMirrors);

      const result = await fetchErrorMirrors("test-token");

      expect(mockApiFetch).toHaveBeenCalledTimes(1);
      expect(mockApiFetch).toHaveBeenCalledWith(
        "/v1/sync/journal?change_type=error",
        { token: "test-token" },
      );
      expect(result).toEqual(mockMirrors);
    });

    it("returns empty array when no errors", async () => {
      mockApiFetch.mockResolvedValue([]);

      const result = await fetchErrorMirrors("test-token");

      expect(result).toEqual([]);
    });

    it("propagates API errors", async () => {
      mockApiFetch.mockRejectedValue(new Error("API unavailable"));

      await expect(fetchErrorMirrors("test-token")).rejects.toThrow(
        "API unavailable",
      );
    });
  });

  describe("retryMirror", () => {
    it("calls apiFetch with correct path, method, and token", async () => {
      const mockResult: RetryResult = { mirror_id: "m1", success: true };
      mockApiFetch.mockResolvedValue(mockResult);

      const result = await retryMirror("test-token", "m1");

      expect(mockApiFetch).toHaveBeenCalledTimes(1);
      expect(mockApiFetch).toHaveBeenCalledWith("/v1/sync/retry/m1", {
        method: "POST",
        token: "test-token",
      });
      expect(result).toEqual(mockResult);
    });

    it("URL-encodes mirror ID with special characters", async () => {
      const mockResult: RetryResult = { mirror_id: "m/1", success: true };
      mockApiFetch.mockResolvedValue(mockResult);

      await retryMirror("test-token", "m/1");

      expect(mockApiFetch).toHaveBeenCalledWith("/v1/sync/retry/m%2F1", {
        method: "POST",
        token: "test-token",
      });
    });

    it("propagates API errors", async () => {
      mockApiFetch.mockRejectedValue(new Error("Retry failed"));

      await expect(retryMirror("test-token", "m1")).rejects.toThrow(
        "Retry failed",
      );
    });
  });

  describe("batchRetryMirrors", () => {
    it("retries all mirrors and returns summary on all success", async () => {
      const mirrors = [makeErrorMirror("m1"), makeErrorMirror("m2")];
      mockApiFetch.mockResolvedValue({ mirror_id: "x", success: true });

      const result = await batchRetryMirrors("test-token", mirrors);

      expect(result.total).toBe(2);
      expect(result.succeeded).toBe(2);
      expect(result.failed).toBe(0);
      expect(result.results).toHaveLength(2);
      expect(mockApiFetch).toHaveBeenCalledTimes(2);
    });

    it("handles partial failure correctly", async () => {
      const mirrors = [
        makeErrorMirror("m1"),
        makeErrorMirror("m2"),
        makeErrorMirror("m3"),
      ];

      // m1 succeeds, m2 fails, m3 succeeds
      mockApiFetch
        .mockResolvedValueOnce({ mirror_id: "m1", success: true })
        .mockRejectedValueOnce(new Error("Timeout"))
        .mockResolvedValueOnce({ mirror_id: "m3", success: true });

      const result = await batchRetryMirrors("test-token", mirrors);

      expect(result.total).toBe(3);
      expect(result.succeeded).toBe(2);
      expect(result.failed).toBe(1);
      expect(result.results[1]).toEqual({
        mirror_id: "m2",
        success: false,
        error: "Timeout",
      });
    });

    it("handles all failures correctly", async () => {
      const mirrors = [makeErrorMirror("m1"), makeErrorMirror("m2")];
      mockApiFetch.mockRejectedValue(new Error("Server down"));

      const result = await batchRetryMirrors("test-token", mirrors);

      expect(result.total).toBe(2);
      expect(result.succeeded).toBe(0);
      expect(result.failed).toBe(2);
    });

    it("returns empty result for empty input", async () => {
      const result = await batchRetryMirrors("test-token", []);

      expect(result.total).toBe(0);
      expect(result.succeeded).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.results).toEqual([]);
      expect(mockApiFetch).not.toHaveBeenCalled();
    });

    it("calls mirrors sequentially (not in parallel)", async () => {
      const callOrder: string[] = [];
      const mirrors = [makeErrorMirror("m1"), makeErrorMirror("m2")];

      mockApiFetch.mockImplementation(async (path: string) => {
        callOrder.push(path as string);
        return { mirror_id: "x", success: true };
      });

      await batchRetryMirrors("test-token", mirrors);

      expect(callOrder).toEqual([
        "/v1/sync/retry/m1",
        "/v1/sync/retry/m2",
      ]);
    });
  });
});
