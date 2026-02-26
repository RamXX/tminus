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
 * Uses useApi() for token-injected API calls.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { useApi } from "../lib/api-provider";
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
import { Button } from "../components/ui/button";

// ---------------------------------------------------------------------------
// Status message type
// ---------------------------------------------------------------------------

interface StatusMessage {
  type: "success" | "error";
  text: string;
}

// ---------------------------------------------------------------------------
// Level-specific Tailwind classes (semantic tokens from Settlement Monitor theme)
// ---------------------------------------------------------------------------

const LEVEL_CLASSES: Record<DetailLevel, string> = {
  BUSY: "bg-primary/20 text-primary border-primary/50",
  TITLE: "bg-warning/20 text-warning border-warning/50",
  FULL: "bg-success/20 text-success border-success/50",
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Policies() {
  const api = useApi();

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
      const data = await api.fetchPolicies();
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
  }, [api]);

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
        const result = await api.updatePolicyEdge(policyId, {
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
    [api, showStatus],
  );

  // Loading state
  if (loading) {
    return (
      <div data-testid="policies-loading" className="mx-auto max-w-[1200px]">
        <h1 className="text-2xl font-bold text-foreground">Policy Management</h1>
        <p className="text-muted-foreground text-center py-8">Loading policies...</p>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div data-testid="policies-error" className="mx-auto max-w-[1200px]">
        <h1 className="text-2xl font-bold text-foreground">Policy Management</h1>
        <div className="text-destructive text-center py-8">
          <p>Failed to load policies: {error}</p>
          <Button
            onClick={loadData}
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

  // Empty state (fewer than 2 accounts -- no cross-edges possible)
  if (accounts.length < 2) {
    return (
      <div data-testid="policies-empty" className="mx-auto max-w-[1200px]">
        <h1 className="text-2xl font-bold text-foreground">Policy Management</h1>
        <p className="text-muted-foreground text-center py-8">
          {accounts.length === 0
            ? "No accounts configured. Add at least two accounts to manage policies."
            : "Add another account to configure projection policies."}
        </p>
      </div>
    );
  }

  // Normal state: matrix
  return (
    <div className="mx-auto max-w-[1200px]">
      <div className="flex items-center justify-between mb-2">
        <h1 className="text-2xl font-bold text-foreground">Policy Management</h1>
        <a href="#/calendar" className="text-muted-foreground text-sm no-underline hover:text-foreground">
          Back to Calendar
        </a>
      </div>

      <p className="text-muted-foreground text-sm mb-4">
        Configure how events project between accounts. Click a cell to change
        the detail level.
      </p>

      {/* Legend */}
      <div className="flex gap-4 mb-4 items-center" data-testid="policy-legend">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Levels:</span>
        {DETAIL_LEVELS.map((level) => (
          <span key={level} className="flex items-center gap-1">
            <span
              className={`inline-block px-2 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wider border ${LEVEL_CLASSES[level]}`}
            >
              {level}
            </span>
            {level === DEFAULT_DETAIL_LEVEL && (
              <span className="text-muted-foreground text-xs italic">(default)</span>
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
          className={`fixed top-4 right-4 left-4 max-w-[420px] ml-auto z-40 pointer-events-none px-4 py-2 rounded-md text-sm font-medium shadow-lg border ${
            status.type === "success"
              ? "bg-success/20 text-success border-success/50"
              : "bg-destructive/20 text-destructive border-destructive/50"
          }`}
        >
          {status.text}
        </div>
      )}

      {/* Matrix */}
      <div className="overflow-x-auto">
        <table className="text-sm border-collapse" data-testid="policy-matrix">
          <thead>
            <tr>
              <th className="text-left px-3 py-2 border-b border-border text-[11px] font-semibold uppercase tracking-wider text-muted-foreground whitespace-nowrap italic">
                From \ To
              </th>
              {accounts.map((acc) => (
                <th key={acc.account_id} className="text-center px-3 py-2 border-b border-border text-muted-foreground whitespace-nowrap">
                  <span className="font-mono text-xs">{acc.email}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {accounts.map((fromAcc) => (
              <tr key={fromAcc.account_id}>
                <td className="px-3 py-2 text-muted-foreground whitespace-nowrap border-r border-border">
                  <span className="font-mono text-xs">{fromAcc.email}</span>
                </td>
                {accounts.map((toAcc) => {
                  if (fromAcc.account_id === toAcc.account_id) {
                    return (
                      <td
                        key={toAcc.account_id}
                        className="text-center px-3 py-2 text-muted-foreground/30 bg-card"
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
                      className={`text-center p-1 bg-card border border-border hover:bg-surface-elevated transition-colors ${cell.isDefault ? "bg-muted/30" : ""} ${isSaving ? "opacity-60" : ""}`}
                    >
                      <button
                        data-testid={`cell-btn-${fromAcc.account_id}-${toAcc.account_id}`}
                        data-detail-level={cell.detailLevel}
                        data-is-default={cell.isDefault}
                        onClick={() => handleCellClick(cell)}
                        disabled={isSaving}
                        className={`inline-flex items-center gap-0.5 px-2.5 py-1 rounded-md border cursor-pointer text-[9px] font-semibold uppercase tracking-wider transition-opacity ${cell.isDefault ? "border-dashed" : "border-solid"} ${LEVEL_CLASSES[cell.detailLevel]}`}
                        title={`${fromAcc.email} -> ${toAcc.email}: ${cell.detailLevel}${cell.isDefault ? " (default)" : ""}. Click to change.`}
                      >
                        {cell.detailLevel}
                        {cell.isDefault && (
                          <span className="text-[0.6rem] align-super">*</span>
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
