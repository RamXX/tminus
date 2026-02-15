/**
 * Error recovery types and pure logic for the Error Recovery UI.
 *
 * Provides types for error mirrors (mirrors in ERROR state) and
 * API functions for fetching error journal entries and retrying mirrors.
 *
 * Data sources:
 *   GET  /api/v1/sync/journal?change_type=error  -- error history
 *   POST /api/v1/sync/retry/:mirror_id           -- manual retry
 */

import { apiFetch } from "./api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A mirror in ERROR state, as returned from the journal endpoint. */
export interface ErrorMirror {
  mirror_id: string;
  canonical_event_id: string;
  target_account_id: string;
  target_account_email: string;
  error_message: string;
  /** ISO 8601 timestamp of when the error occurred. */
  error_ts: string;
  /** Optional event summary for display context. */
  event_summary?: string;
}

/** Result of a single retry operation. */
export interface RetryResult {
  mirror_id: string;
  success: boolean;
  error?: string;
}

/** Result of a batch retry operation. */
export interface BatchRetryResult {
  total: number;
  succeeded: number;
  failed: number;
  results: RetryResult[];
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/**
 * Fetch mirrors in ERROR state from the sync journal.
 * GET /api/v1/sync/journal?change_type=error
 */
export async function fetchErrorMirrors(
  token: string,
): Promise<ErrorMirror[]> {
  return apiFetch<ErrorMirror[]>("/v1/sync/journal?change_type=error", {
    token,
  });
}

/**
 * Retry a single mirror by ID.
 * POST /api/v1/sync/retry/:mirror_id
 */
export async function retryMirror(
  token: string,
  mirrorId: string,
): Promise<RetryResult> {
  return apiFetch<RetryResult>(
    `/v1/sync/retry/${encodeURIComponent(mirrorId)}`,
    {
      method: "POST",
      token,
    },
  );
}

/**
 * Retry all error mirrors in batch.
 *
 * Calls retryMirror for each mirror sequentially (to avoid overloading
 * the API) and collects results. Returns a summary.
 */
export async function batchRetryMirrors(
  token: string,
  mirrors: ErrorMirror[],
): Promise<BatchRetryResult> {
  const results: RetryResult[] = [];

  for (const mirror of mirrors) {
    try {
      const result = await retryMirror(token, mirror.mirror_id);
      results.push(result);
    } catch (err) {
      results.push({
        mirror_id: mirror.mirror_id,
        success: false,
        error: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }

  const succeeded = results.filter((r) => r.success).length;

  return {
    total: mirrors.length,
    succeeded,
    failed: mirrors.length - succeeded,
    results,
  };
}
