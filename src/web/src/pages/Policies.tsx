/**
 * Policy Management page.
 *
 * Displays a matrix of account-to-account projection rules.
 * Rows represent "from" accounts (event sources), columns represent
 * "to" accounts (projection targets), and cells show the detail level
 * (BUSY, TITLE, or FULL).
 *
 * Features:
 * - Matrix view of all policy edges
 * - Click cell to cycle detail level (BUSY -> TITLE -> FULL)
 * - Optimistic UI updates with rollback on failure
 * - Visual indicator for default BUSY level
 * - Save success/failure feedback via status messages
 * - Loading, error, and empty states
 *
 * The component accepts fetch/update functions as props for testability.
 * In production, these are wired to the API client with auth tokens.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import {
  buildMatrixCells,
  nextDetailLevel,
  DEFAULT_DETAIL_LEVEL,
  DETAIL_LEVELS,
  type PolicyMatrixData,
  type PolicyEdgeData,
  type MatrixCell,
  type DetailLevel,
  type PolicyAccount,
} from "../lib/policies";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface PoliciesProps {
  /** Fetch all policy data (accounts + edges). Injected for testability. */
  fetchPolicies: () => Promise<PolicyMatrixData>;
  /** Update a policy edge. Injected for testability. */
  updatePolicyEdge: (
    policyId: string,
    edge: {
      from_account_id: string;
      to_account_id: string;
      detail_level: DetailLevel;
    },
  ) => Promise<PolicyEdgeData>;
}

// ---------------------------------------------------------------------------
// Status message type
// ---------------------------------------------------------------------------

interface StatusMessage {
  type: "success" | "error";
  text: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Policies({ fetchPolicies, updatePolicyEdge }: PoliciesProps) {
  const [accounts, setAccounts] = useState<PolicyAccount[]>([]);
  const [cells, setCells] = useState<MatrixCell[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusMessage | null>(null);
  const [saving, setSaving] = useState<string | null>(null); // "from:to" key of cell being saved

  const mountedRef = useRef(true);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear status message after delay
  const showStatus = useCallback((msg: StatusMessage) => {
    if (statusTimerRef.current) {
      clearTimeout(statusTimerRef.current);
    }
    setStatus(msg);
    statusTimerRef.current = setTimeout(() => {
      setStatus(null);
      statusTimerRef.current = null;
    }, 3000);
  }, []);

  const loadData = useCallback(async () => {
    try {
      const data = await fetchPolicies();
      if (!mountedRef.current) return;

      setAccounts([...data.accounts]);
      setCells(buildMatrixCells(data.accounts, data.edges));
      setError(null);
      setLoading(false);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : "Unknown error");
      setLoading(false);
    }
  }, [fetchPolicies]);

  useEffect(() => {
    mountedRef.current = true;
    loadData();

    return () => {
      mountedRef.current = false;
      if (statusTimerRef.current) {
        clearTimeout(statusTimerRef.current);
      }
    };
  }, [loadData]);

  /**
   * Handle clicking a matrix cell to cycle the detail level.
   *
   * Uses optimistic update: immediately update UI, then call API.
   * On failure, roll back to previous state.
   */
  const handleCellClick = useCallback(
    async (cell: MatrixCell) => {
      const cellKey = `${cell.fromAccountId}:${cell.toAccountId}`;
      const newLevel = nextDetailLevel(cell.detailLevel);
      const previousLevel = cell.detailLevel;
      const previousIsDefault = cell.isDefault;

      // Optimistic update
      setCells((prev) =>
        prev.map((c) =>
          c.fromAccountId === cell.fromAccountId &&
          c.toAccountId === cell.toAccountId
            ? { ...c, detailLevel: newLevel, isDefault: false }
            : c,
        ),
      );

      setSaving(cellKey);

      try {
        // Use existing policy_id or construct one for new edges
        const policyId = cell.policyId ?? "new";
        const result = await updatePolicyEdge(policyId, {
          from_account_id: cell.fromAccountId,
          to_account_id: cell.toAccountId,
          detail_level: newLevel,
        });

        if (!mountedRef.current) return;

        // Update with server-confirmed data (including any new policy_id)
        setCells((prev) =>
          prev.map((c) =>
            c.fromAccountId === cell.fromAccountId &&
            c.toAccountId === cell.toAccountId
              ? {
                  ...c,
                  policyId: result.policy_id,
                  detailLevel: result.detail_level,
                  isDefault: false,
                }
              : c,
          ),
        );

        showStatus({ type: "success", text: "Policy updated" });
      } catch (err) {
        if (!mountedRef.current) return;

        // Rollback on failure
        setCells((prev) =>
          prev.map((c) =>
            c.fromAccountId === cell.fromAccountId &&
            c.toAccountId === cell.toAccountId
              ? {
                  ...c,
                  detailLevel: previousLevel,
                  isDefault: previousIsDefault,
                }
              : c,
          ),
        );

        showStatus({
          type: "error",
          text: `Failed to update: ${err instanceof Error ? err.message : "Unknown error"}`,
        });
      } finally {
        if (mountedRef.current) {
          setSaving(null);
        }
      }
    },
    [updatePolicyEdge, showStatus],
  );

  // Loading state
  if (loading) {
    return (
      <div data-testid="policies-loading" style={styles.container}>
        <h1 style={styles.title}>Policy Management</h1>
        <div style={styles.loading}>Loading policies...</div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div data-testid="policies-error" style={styles.container}>
        <h1 style={styles.title}>Policy Management</h1>
        <div style={styles.errorBox}>
          <p>Failed to load policies: {error}</p>
          <button
            onClick={loadData}
            style={styles.retryBtn}
            aria-label="Retry"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  // Empty state (fewer than 2 accounts -- no cross-edges possible)
  if (accounts.length < 2) {
    return (
      <div data-testid="policies-empty" style={styles.container}>
        <h1 style={styles.title}>Policy Management</h1>
        <div style={styles.emptyState}>
          {accounts.length === 0
            ? "No accounts configured. Add at least two accounts to manage policies."
            : "Add another account to configure projection policies."}
        </div>
      </div>
    );
  }

  // Normal state: matrix
  return (
    <div style={styles.container}>
      <div style={styles.headerRow}>
        <h1 style={styles.title}>Policy Management</h1>
        <a href="#/calendar" style={styles.backLink}>
          Back to Calendar
        </a>
      </div>

      <p style={styles.description}>
        Configure how events project between accounts. Click a cell to change
        the detail level.
      </p>

      {/* Legend */}
      <div style={styles.legend} data-testid="policy-legend">
        {DETAIL_LEVELS.map((level) => (
          <span key={level} style={styles.legendItem}>
            <span
              style={{
                ...styles.levelBadge,
                ...LEVEL_STYLES[level],
              }}
            >
              {level}
            </span>
            {level === DEFAULT_DETAIL_LEVEL && (
              <span style={styles.defaultTag}>(default)</span>
            )}
          </span>
        ))}
      </div>

      {/* Status message */}
      {status && (
        <div
          data-testid="policy-status"
          data-status-type={status.type}
          role="status"
          aria-live="polite"
          style={{
            ...styles.statusMessage,
            ...(status.type === "success"
              ? styles.statusSuccess
              : styles.statusError),
          }}
        >
          {status.text}
        </div>
      )}

      {/* Matrix */}
      <div style={styles.tableWrapper}>
        <table style={styles.table} data-testid="policy-matrix">
          <thead>
            <tr>
              <th style={{ ...styles.th, ...styles.cornerCell }}>
                From \ To
              </th>
              {accounts.map((acc) => (
                <th key={acc.account_id} style={styles.th}>
                  {acc.email}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {accounts.map((fromAcc) => (
              <tr key={fromAcc.account_id}>
                <td style={styles.rowHeader}>{fromAcc.email}</td>
                {accounts.map((toAcc) => {
                  if (fromAcc.account_id === toAcc.account_id) {
                    return (
                      <td
                        key={toAcc.account_id}
                        style={styles.selfCell}
                        data-testid={`cell-${fromAcc.account_id}-${toAcc.account_id}`}
                      >
                        --
                      </td>
                    );
                  }

                  const cell = cells.find(
                    (c) =>
                      c.fromAccountId === fromAcc.account_id &&
                      c.toAccountId === toAcc.account_id,
                  );

                  if (!cell) return null;

                  const cellKey = `${cell.fromAccountId}:${cell.toAccountId}`;
                  const isSaving = saving === cellKey;

                  return (
                    <td
                      key={toAcc.account_id}
                      data-testid={`cell-${fromAcc.account_id}-${toAcc.account_id}`}
                      style={{
                        ...styles.matrixCell,
                        ...(cell.isDefault ? styles.defaultCell : {}),
                        ...(isSaving ? styles.savingCell : {}),
                      }}
                    >
                      <button
                        data-testid={`cell-btn-${fromAcc.account_id}-${toAcc.account_id}`}
                        data-detail-level={cell.detailLevel}
                        data-is-default={cell.isDefault}
                        onClick={() => handleCellClick(cell)}
                        disabled={isSaving}
                        style={{
                          ...styles.cellButton,
                          ...LEVEL_STYLES[cell.detailLevel],
                          ...(cell.isDefault ? styles.defaultBadge : {}),
                        }}
                        title={`${fromAcc.email} -> ${toAcc.email}: ${cell.detailLevel}${cell.isDefault ? " (default)" : ""}. Click to change.`}
                      >
                        {cell.detailLevel}
                        {cell.isDefault && (
                          <span style={styles.defaultIndicator}>*</span>
                        )}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Level-specific styles
// ---------------------------------------------------------------------------

const LEVEL_STYLES: Record<DetailLevel, React.CSSProperties> = {
  BUSY: {
    backgroundColor: "#1e3a5f",
    color: "#60a5fa",
    borderColor: "#2563eb",
  },
  TITLE: {
    backgroundColor: "#3b2f1e",
    color: "#fbbf24",
    borderColor: "#d97706",
  },
  FULL: {
    backgroundColor: "#1e3b2f",
    color: "#34d399",
    borderColor: "#059669",
  },
};

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
    marginBottom: "0.5rem",
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
  description: {
    color: "#94a3b8",
    fontSize: "0.875rem",
    marginBottom: "1rem",
  },
  legend: {
    display: "flex",
    gap: "1rem",
    marginBottom: "1rem",
    alignItems: "center",
  },
  legendItem: {
    display: "flex",
    alignItems: "center",
    gap: "0.25rem",
  },
  levelBadge: {
    display: "inline-block",
    padding: "0.2rem 0.5rem",
    borderRadius: "4px",
    fontSize: "0.75rem",
    fontWeight: 600,
    border: "1px solid",
  },
  defaultTag: {
    color: "#64748b",
    fontSize: "0.75rem",
    fontStyle: "italic",
  },
  statusMessage: {
    position: "fixed",
    top: "1rem",
    right: "1rem",
    left: "1rem",
    maxWidth: "420px",
    marginLeft: "auto",
    zIndex: 40,
    pointerEvents: "none",
    padding: "0.5rem 1rem",
    borderRadius: "6px",
    fontSize: "0.875rem",
    fontWeight: 500,
    boxShadow: "0 8px 20px rgba(2, 6, 23, 0.45)",
  },
  statusSuccess: {
    backgroundColor: "#064e3b",
    color: "#6ee7b7",
    border: "1px solid #059669",
  },
  statusError: {
    backgroundColor: "#450a0a",
    color: "#fca5a5",
    border: "1px solid #dc2626",
  },
  tableWrapper: {
    overflowX: "auto" as const,
  },
  table: {
    borderCollapse: "collapse" as const,
    fontSize: "0.875rem",
  },
  th: {
    textAlign: "center" as const,
    padding: "0.6rem 0.75rem",
    borderBottom: "1px solid #334155",
    color: "#94a3b8",
    fontWeight: 600,
    whiteSpace: "nowrap" as const,
    fontSize: "0.8rem",
  },
  cornerCell: {
    textAlign: "left" as const,
    color: "#64748b",
    fontStyle: "italic",
  },
  rowHeader: {
    padding: "0.6rem 0.75rem",
    color: "#94a3b8",
    fontWeight: 600,
    whiteSpace: "nowrap" as const,
    fontSize: "0.8rem",
    borderRight: "1px solid #334155",
  },
  selfCell: {
    textAlign: "center" as const,
    color: "#334155",
    padding: "0.6rem 0.75rem",
    backgroundColor: "#0f172a",
  },
  matrixCell: {
    textAlign: "center" as const,
    padding: "0.4rem",
  },
  defaultCell: {
    backgroundColor: "rgba(30, 58, 95, 0.15)",
  },
  savingCell: {
    opacity: 0.6,
  },
  cellButton: {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.15rem",
    padding: "0.35rem 0.65rem",
    borderRadius: "6px",
    borderWidth: "1px",
    borderStyle: "solid",
    cursor: "pointer",
    fontWeight: 600,
    fontSize: "0.75rem",
    transition: "opacity 0.15s",
    background: "transparent",
  },
  defaultBadge: {
    borderStyle: "dashed",
  },
  defaultIndicator: {
    fontSize: "0.6rem",
    verticalAlign: "super",
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
  retryBtn: {
    marginTop: "0.5rem",
    padding: "0.5rem 1rem",
    borderRadius: "6px",
    border: "1px solid #ef4444",
    background: "transparent",
    color: "#ef4444",
    cursor: "pointer",
    fontSize: "0.875rem",
  },
  emptyState: {
    color: "#94a3b8",
    padding: "2rem",
    textAlign: "center" as const,
  },
};
