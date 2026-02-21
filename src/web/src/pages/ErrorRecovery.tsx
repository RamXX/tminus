/**
 * Error Recovery page.
 *
 * Displays mirrors in ERROR state with their error messages.
 * Provides per-mirror retry buttons and a batch "Retry All" button.
 * Shows success/failure feedback after retry operations.
 *
 * API integration:
 *   GET  /api/v1/sync/journal?change_type=error  -- fetch error mirrors
 *   POST /api/v1/sync/retry/:mirror_id           -- retry individual mirror
 *
 * Uses useApi() for token-injected API calls.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { useApi } from "../lib/api-provider";
import type { ErrorMirror, RetryResult } from "../lib/error-recovery";
import { Button } from "../components/ui/button";

// ---------------------------------------------------------------------------
// Status feedback type
// ---------------------------------------------------------------------------

interface StatusMessage {
  type: "success" | "error";
  text: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ErrorRecovery() {
  const api = useApi();

  const [errors, setErrors] = useState<ErrorMirror[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusMessage | null>(null);
  const [retryingIds, setRetryingIds] = useState<Set<string>>(new Set());
  const [batchRetrying, setBatchRetrying] = useState(false);

  // Track mount state to avoid state updates after unmount
  const mountedRef = useRef(true);

  // -------------------------------------------------------------------------
  // Fetch error mirrors
  // -------------------------------------------------------------------------

  const loadErrors = useCallback(async () => {
    try {
      const result = await api.fetchErrors();
      if (!mountedRef.current) return;
      setErrors(result);
      setFetchError(null);
      setLoading(false);
    } catch (err) {
      if (!mountedRef.current) return;
      setFetchError(err instanceof Error ? err.message : "Unknown error");
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    mountedRef.current = true;
    loadErrors();
    return () => {
      mountedRef.current = false;
    };
  }, [loadErrors]);

  // -------------------------------------------------------------------------
  // Single retry handler
  // -------------------------------------------------------------------------

  const handleRetry = useCallback(
    async (mirrorId: string) => {
      setRetryingIds((prev) => new Set(prev).add(mirrorId));
      setStatus(null);

      try {
        await api.retryMirror(mirrorId);

        if (!mountedRef.current) return;

        // Remove from list on success
        setErrors((prev) => prev.filter((e) => e.mirror_id !== mirrorId));
        setStatus({ type: "success", text: "Mirror retried successfully." });
      } catch (err) {
        if (!mountedRef.current) return;

        const message = err instanceof Error ? err.message : "Unknown error";
        setStatus({ type: "error", text: `Retry failed: ${message}` });
      } finally {
        if (mountedRef.current) {
          setRetryingIds((prev) => {
            const next = new Set(prev);
            next.delete(mirrorId);
            return next;
          });
        }
      }
    },
    [api],
  );

  // -------------------------------------------------------------------------
  // Batch retry handler
  // -------------------------------------------------------------------------

  const handleBatchRetry = useCallback(async () => {
    setBatchRetrying(true);
    setStatus(null);

    const currentErrors = [...errors];
    const succeededIds: string[] = [];
    const failedIds: string[] = [];

    for (const mirror of currentErrors) {
      try {
        await api.retryMirror(mirror.mirror_id);
        succeededIds.push(mirror.mirror_id);
      } catch {
        failedIds.push(mirror.mirror_id);
      }
    }

    if (!mountedRef.current) return;

    // Remove succeeded mirrors from list
    setErrors((prev) =>
      prev.filter((e) => !succeededIds.includes(e.mirror_id)),
    );

    if (failedIds.length === 0) {
      setStatus({
        type: "success",
        text: `${succeededIds.length} of ${currentErrors.length} retried successfully.`,
      });
    } else {
      setStatus({
        type: "error",
        text: `${succeededIds.length} succeeded, ${failedIds.length} failed.`,
      });
    }

    setBatchRetrying(false);
  }, [errors, api]);

  // -------------------------------------------------------------------------
  // Render: Loading
  // -------------------------------------------------------------------------

  if (loading) {
    return (
      <div data-testid="error-recovery-loading" className="mx-auto max-w-[1200px]">
        <h1 className="text-2xl font-bold text-foreground">Error Recovery</h1>
        <p className="text-muted-foreground text-center py-8">Loading error mirrors...</p>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Render: Fetch error
  // -------------------------------------------------------------------------

  if (fetchError) {
    return (
      <div data-testid="error-recovery-fetch-error" className="mx-auto max-w-[1200px]">
        <h1 className="text-2xl font-bold text-foreground">Error Recovery</h1>
        <div className="text-destructive text-center py-8">
          <p>Failed to load errors: {fetchError}</p>
          <Button
            onClick={loadErrors}
            variant="outline"
            className="mt-2 border-destructive text-destructive hover:bg-destructive/10"
            aria-label="Retry"
          >
            Retry
          </Button>
        </div>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Render: Empty state
  // -------------------------------------------------------------------------

  if (errors.length === 0 && !status) {
    return (
      <div data-testid="error-recovery-empty" className="mx-auto max-w-[1200px]">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-2xl font-bold text-foreground">Error Recovery</h1>
          <a href="#/sync-status" className="text-muted-foreground text-sm no-underline hover:text-foreground">
            Back to Sync Status
          </a>
        </div>
        <p className="text-muted-foreground text-center py-8">No errors found. All mirrors are healthy.</p>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Render: Error list
  // -------------------------------------------------------------------------

  return (
    <div className="mx-auto max-w-[1200px]">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold text-foreground">Error Recovery</h1>
        <a href="#/sync-status" className="text-muted-foreground text-sm no-underline hover:text-foreground">
          Back to Sync Status
        </a>
      </div>

      {/* Summary + batch retry */}
      <div className="flex items-center justify-between mb-4">
        <span data-testid="error-count-summary" className="text-destructive font-semibold text-sm">
          {errors.length} error{errors.length !== 1 ? "s" : ""}
        </span>
        {errors.length > 0 && (
          <Button
            data-testid="batch-retry-btn"
            onClick={handleBatchRetry}
            disabled={batchRetrying}
            variant="outline"
            className="border-orange-500 text-orange-500 hover:bg-orange-500/10 font-semibold"
          >
            {batchRetrying
              ? "Retrying..."
              : `Retry All (${errors.length})`}
          </Button>
        )}
      </div>

      {/* Status feedback */}
      {status && (
        <div
          data-testid="retry-status"
          data-status-type={status.type}
          className="px-4 py-3 rounded-lg border text-foreground text-sm mb-4"
          style={{
            backgroundColor:
              status.type === "success" ? "#052e16" : "#450a0a",
            borderColor:
              status.type === "success" ? "#16a34a" : "#dc2626",
          }}
        >
          {status.text}
        </div>
      )}

      {/* Error table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr>
              <th className="text-left px-3 py-2 border-b border-border text-muted-foreground font-semibold whitespace-nowrap">Event</th>
              <th className="text-left px-3 py-2 border-b border-border text-muted-foreground font-semibold whitespace-nowrap">Account</th>
              <th className="text-left px-3 py-2 border-b border-border text-muted-foreground font-semibold whitespace-nowrap">Error</th>
              <th className="text-left px-3 py-2 border-b border-border text-muted-foreground font-semibold whitespace-nowrap">Actions</th>
            </tr>
          </thead>
          <tbody>
            {errors.map((mirror) => (
              <tr
                key={mirror.mirror_id}
                data-testid={`error-row-${mirror.mirror_id}`}
                className="border-b border-border/50"
              >
                <td className="px-3 py-2 text-foreground">
                  {mirror.event_summary ?? mirror.canonical_event_id}
                </td>
                <td className="px-3 py-2 text-foreground">{mirror.target_account_email}</td>
                <td className="px-3 py-2">
                  <span data-testid="error-message" className="text-destructive text-xs">
                    {mirror.error_message}
                  </span>
                </td>
                <td className="px-3 py-2">
                  <Button
                    data-testid={`retry-btn-${mirror.mirror_id}`}
                    onClick={() => handleRetry(mirror.mirror_id)}
                    disabled={retryingIds.has(mirror.mirror_id) || batchRetrying}
                    variant="outline"
                    size="sm"
                    className="text-xs border-destructive text-destructive hover:bg-destructive/10"
                  >
                    {retryingIds.has(mirror.mirror_id) ? "Retrying..." : "Retry"}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
