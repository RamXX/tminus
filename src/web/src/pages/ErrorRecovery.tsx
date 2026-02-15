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
 * The component accepts injected fetch/retry functions for testability.
 * In production, these are wired to the API client in App.tsx.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import type { ErrorMirror, RetryResult } from "../lib/error-recovery";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ErrorRecoveryProps {
  /** Fetch function that returns error mirrors. Injected for testability. */
  fetchErrors: () => Promise<ErrorMirror[]>;
  /** Retry a single mirror by ID. Injected for testability. */
  retryMirror: (mirrorId: string) => Promise<RetryResult>;
}

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

export function ErrorRecovery({ fetchErrors, retryMirror }: ErrorRecoveryProps) {
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
      const result = await fetchErrors();
      if (!mountedRef.current) return;
      setErrors(result);
      setFetchError(null);
      setLoading(false);
    } catch (err) {
      if (!mountedRef.current) return;
      setFetchError(err instanceof Error ? err.message : "Unknown error");
      setLoading(false);
    }
  }, [fetchErrors]);

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
        await retryMirror(mirrorId);

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
    [retryMirror],
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
        await retryMirror(mirror.mirror_id);
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
  }, [errors, retryMirror]);

  // -------------------------------------------------------------------------
  // Render: Loading
  // -------------------------------------------------------------------------

  if (loading) {
    return (
      <div data-testid="error-recovery-loading" style={styles.container}>
        <h1 style={styles.title}>Error Recovery</h1>
        <div style={styles.loading}>Loading error mirrors...</div>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Render: Fetch error
  // -------------------------------------------------------------------------

  if (fetchError) {
    return (
      <div data-testid="error-recovery-fetch-error" style={styles.container}>
        <h1 style={styles.title}>Error Recovery</h1>
        <div style={styles.errorBox}>
          <p>Failed to load errors: {fetchError}</p>
          <button
            onClick={loadErrors}
            style={styles.retryBtn}
            aria-label="Retry"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Render: Empty state
  // -------------------------------------------------------------------------

  if (errors.length === 0 && !status) {
    return (
      <div data-testid="error-recovery-empty" style={styles.container}>
        <div style={styles.headerRow}>
          <h1 style={styles.title}>Error Recovery</h1>
          <a href="#/sync-status" style={styles.backLink}>
            Back to Sync Status
          </a>
        </div>
        <div style={styles.emptyState}>No errors found. All mirrors are healthy.</div>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Render: Error list
  // -------------------------------------------------------------------------

  return (
    <div style={styles.container}>
      <div style={styles.headerRow}>
        <h1 style={styles.title}>Error Recovery</h1>
        <a href="#/sync-status" style={styles.backLink}>
          Back to Sync Status
        </a>
      </div>

      {/* Summary + batch retry */}
      <div style={styles.summaryRow}>
        <span data-testid="error-count-summary" style={styles.countText}>
          {errors.length} error{errors.length !== 1 ? "s" : ""}
        </span>
        {errors.length > 0 && (
          <button
            data-testid="batch-retry-btn"
            onClick={handleBatchRetry}
            disabled={batchRetrying}
            style={styles.batchRetryBtn}
          >
            {batchRetrying
              ? "Retrying..."
              : `Retry All (${errors.length})`}
          </button>
        )}
      </div>

      {/* Status feedback */}
      {status && (
        <div
          data-testid="retry-status"
          data-status-type={status.type}
          style={{
            ...styles.statusBox,
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
      <div style={styles.tableWrapper}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Event</th>
              <th style={styles.th}>Account</th>
              <th style={styles.th}>Error</th>
              <th style={styles.th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {errors.map((mirror) => (
              <tr
                key={mirror.mirror_id}
                data-testid={`error-row-${mirror.mirror_id}`}
                style={styles.tr}
              >
                <td style={styles.td}>
                  {mirror.event_summary ?? mirror.canonical_event_id}
                </td>
                <td style={styles.td}>{mirror.target_account_email}</td>
                <td style={styles.td}>
                  <span data-testid="error-message" style={styles.errorText}>
                    {mirror.error_message}
                  </span>
                </td>
                <td style={styles.td}>
                  <button
                    data-testid={`retry-btn-${mirror.mirror_id}`}
                    onClick={() => handleRetry(mirror.mirror_id)}
                    disabled={retryingIds.has(mirror.mirror_id) || batchRetrying}
                    style={styles.retryBtn}
                  >
                    {retryingIds.has(mirror.mirror_id) ? "Retrying..." : "Retry"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline styles (consistent with SyncStatus.tsx patterns)
// ---------------------------------------------------------------------------

const styles: Record<string, React.CSSProperties> = {
  container: {
    maxWidth: "1200px",
    margin: "0 auto",
  },
  headerRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: "1rem",
  },
  title: {
    fontSize: "1.5rem",
    fontWeight: 700,
    color: "#f1f5f9",
    margin: 0,
  },
  backLink: {
    color: "#94a3b8",
    fontSize: "0.875rem",
    textDecoration: "none",
  },
  summaryRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: "1rem",
  },
  countText: {
    color: "#fca5a5",
    fontWeight: 600,
    fontSize: "0.95rem",
  },
  batchRetryBtn: {
    padding: "0.5rem 1rem",
    borderRadius: "6px",
    border: "1px solid #f97316",
    background: "transparent",
    color: "#f97316",
    cursor: "pointer",
    fontSize: "0.875rem",
    fontWeight: 600,
  },
  statusBox: {
    padding: "0.75rem 1rem",
    borderRadius: "8px",
    border: "1px solid",
    color: "#e2e8f0",
    fontSize: "0.875rem",
    marginBottom: "1rem",
  },
  tableWrapper: {
    overflowX: "auto" as const,
  },
  table: {
    width: "100%",
    borderCollapse: "collapse" as const,
    fontSize: "0.875rem",
  },
  th: {
    textAlign: "left" as const,
    padding: "0.6rem 0.75rem",
    borderBottom: "1px solid #334155",
    color: "#94a3b8",
    fontWeight: 600,
    whiteSpace: "nowrap" as const,
  },
  tr: {
    borderBottom: "1px solid #1e293b",
  },
  td: {
    padding: "0.6rem 0.75rem",
    color: "#e2e8f0",
  },
  errorText: {
    color: "#fca5a5",
    fontSize: "0.8rem",
  },
  retryBtn: {
    padding: "0.35rem 0.75rem",
    borderRadius: "6px",
    border: "1px solid #ef4444",
    background: "transparent",
    color: "#ef4444",
    cursor: "pointer",
    fontSize: "0.8rem",
  },
  loading: {
    color: "#94a3b8",
    padding: "2rem",
    textAlign: "center" as const,
  },
  errorBox: {
    color: "#fca5a5",
    padding: "2rem",
    textAlign: "center" as const,
  },
  emptyState: {
    color: "#94a3b8",
    padding: "2rem",
    textAlign: "center" as const,
  },
};
