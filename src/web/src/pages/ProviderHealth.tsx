/**
 * Provider Health Dashboard page.
 *
 * Displays connected accounts with real-time health status badges
 * (Synced/Syncing/Error/Stale), calendar counts, sync timestamps,
 * and expandable detail views with sync history and token info.
 *
 * Actions:
 * - Reconnect: triggers provider-specific re-auth via OAuth redirect
 * - Remove: disconnects account with confirmation dialog
 * - Expand: shows sync history, token info, and remediation guidance
 *
 * Props are injected for testability. In production, these are wired
 * to the API client with auth tokens in App.tsx.
 *
 * Design decisions:
 * - Provider-specific colors (Google=blue, Microsoft=purple, Apple=gray)
 *   per retro insight: hash-based assignment causes collisions.
 * - API response includes account_count + tier_limit per retro insight.
 * - Stale threshold is 1 hour (configurable) per AC6.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import type { AccountProvider } from "../lib/api";
import { buildOAuthStartUrl } from "../lib/accounts";
import {
  computeHealthBadge,
  badgeColor,
  badgeLabel,
  badgeSymbol,
  providerColor,
  getRemediationGuidance,
  formatRelativeTime,
  formatTokenExpiry,
  type AccountHealthData,
  type AccountsHealthResponse,
  type SyncHistoryResponse,
  type HealthBadge,
} from "../lib/provider-health";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ProviderHealthProps {
  /** Fetch accounts with health data. */
  fetchAccountsHealth: () => Promise<AccountsHealthResponse>;
  /** Fetch sync history for a specific account. */
  fetchSyncHistory: (accountId: string) => Promise<SyncHistoryResponse>;
  /** Trigger re-auth for an account. */
  reconnectAccount: (accountId: string) => Promise<void>;
  /** Remove/disconnect an account. */
  removeAccount: (accountId: string) => Promise<void>;
  /** Navigate to OAuth URL (for reconnect). Defaults to window.location.assign. */
  navigateToOAuth?: (url: string) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ProviderHealth({
  fetchAccountsHealth,
  fetchSyncHistory,
  reconnectAccount,
  removeAccount,
  navigateToOAuth = (url) => {
    window.location.assign(url);
  },
}: ProviderHealthProps) {
  const [accounts, setAccounts] = useState<AccountHealthData[]>([]);
  const [accountCount, setAccountCount] = useState(0);
  const [tierLimit, setTierLimit] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Expanded account state
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [syncHistory, setSyncHistory] = useState<SyncHistoryResponse | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  // Remove dialog state
  const [removeTarget, setRemoveTarget] = useState<AccountHealthData | null>(null);
  const [removing, setRemoving] = useState(false);

  // Status message
  const [statusMsg, setStatusMsg] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  const mountedRef = useRef(true);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showStatus = useCallback(
    (type: "success" | "error", text: string) => {
      if (statusTimerRef.current) {
        clearTimeout(statusTimerRef.current);
      }
      setStatusMsg({ type, text });
      statusTimerRef.current = setTimeout(() => {
        if (mountedRef.current) {
          setStatusMsg(null);
        }
        statusTimerRef.current = null;
      }, 4000);
    },
    [],
  );

  // Load accounts
  const loadAccounts = useCallback(async () => {
    try {
      const data = await fetchAccountsHealth();
      if (!mountedRef.current) return;
      setAccounts(data.accounts);
      setAccountCount(data.account_count);
      setTierLimit(data.tier_limit);
      setError(null);
      setLoading(false);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : "Unknown error");
      setLoading(false);
    }
  }, [fetchAccountsHealth]);

  useEffect(() => {
    mountedRef.current = true;
    loadAccounts();
    return () => {
      mountedRef.current = false;
      if (statusTimerRef.current) {
        clearTimeout(statusTimerRef.current);
      }
    };
  }, [loadAccounts]);

  // Expand account to show detail
  const handleExpand = useCallback(
    async (accountId: string) => {
      if (expandedId === accountId) {
        setExpandedId(null);
        setSyncHistory(null);
        return;
      }
      setExpandedId(accountId);
      setHistoryLoading(true);
      try {
        const history = await fetchSyncHistory(accountId);
        if (!mountedRef.current) return;
        setSyncHistory(history);
      } catch {
        // Silently fail -- sync history is not critical
      } finally {
        if (mountedRef.current) {
          setHistoryLoading(false);
        }
      }
    },
    [expandedId, fetchSyncHistory],
  );

  // Reconnect via OAuth
  const handleReconnect = useCallback(
    (provider: AccountProvider) => {
      const url = buildOAuthStartUrl(provider);
      navigateToOAuth(url);
    },
    [navigateToOAuth],
  );

  // Remove flow
  const handleRemoveClick = useCallback((account: AccountHealthData) => {
    setRemoveTarget(account);
  }, []);

  const handleRemoveCancel = useCallback(() => {
    setRemoveTarget(null);
  }, []);

  const handleRemoveConfirm = useCallback(async () => {
    if (!removeTarget) return;
    setRemoving(true);
    try {
      await removeAccount(removeTarget.account_id);
      if (!mountedRef.current) return;
      setAccounts((prev) =>
        prev.filter((a) => a.account_id !== removeTarget.account_id),
      );
      setAccountCount((prev) => prev - 1);
      setRemoveTarget(null);
      showStatus("success", `Account ${removeTarget.email} disconnected.`);
    } catch (err) {
      if (!mountedRef.current) return;
      showStatus(
        "error",
        `Failed to remove: ${err instanceof Error ? err.message : "Unknown error"}`,
      );
    } finally {
      if (mountedRef.current) {
        setRemoving(false);
      }
    }
  }, [removeTarget, removeAccount, showStatus]);

  // --- Loading state ---
  if (loading) {
    return (
      <div data-testid="health-loading" style={styles.container}>
        <h1 style={styles.title}>Provider Health</h1>
        <div style={styles.loading}>Loading account health...</div>
      </div>
    );
  }

  // --- Error state ---
  if (error) {
    return (
      <div data-testid="health-error" style={styles.container}>
        <h1 style={styles.title}>Provider Health</h1>
        <div style={styles.errorBox}>
          <p>Failed to load accounts: {error}</p>
          <button onClick={loadAccounts} style={styles.retryBtn} aria-label="Retry">
            Retry
          </button>
        </div>
      </div>
    );
  }

  // --- Empty state ---
  if (accounts.length === 0) {
    return (
      <div style={styles.container}>
        <h1 style={styles.title}>Provider Health</h1>
        <div data-testid="health-empty" style={styles.emptyState}>
          No accounts connected. Link a calendar account to get started.
        </div>
      </div>
    );
  }

  // --- Normal state ---
  return (
    <div style={styles.container}>
      <div style={styles.headerRow}>
        <h1 style={styles.title}>Provider Health</h1>
        <a href="#/calendar" style={styles.backLink}>
          Back to Calendar
        </a>
      </div>

      {/* Account counter (shows X of Y) */}
      <div data-testid="account-counter" style={styles.counter}>
        {accountCount} of {tierLimit} accounts connected
      </div>

      {/* Status message */}
      {statusMsg && (
        <div
          data-testid="health-status-msg"
          data-status-type={statusMsg.type}
          style={{
            ...styles.statusMessage,
            ...(statusMsg.type === "success"
              ? styles.statusSuccess
              : styles.statusError),
          }}
        >
          {statusMsg.text}
        </div>
      )}

      {/* Account list */}
      {accounts.map((account) => {
        const badge = computeHealthBadge(account);
        const isExpanded = expandedId === account.account_id;
        const guidance = account.error_message
          ? getRemediationGuidance(account.error_message)
          : null;

        return (
          <div
            key={account.account_id}
            data-testid={`health-row-${account.account_id}`}
            style={styles.accountCard}
          >
            {/* Account summary row */}
            <div style={styles.summaryRow}>
              {/* Provider indicator */}
              <div
                style={{
                  ...styles.providerIndicator,
                  backgroundColor: providerColor(account.provider),
                }}
                title={account.provider}
              />

              {/* Badge */}
              <span
                data-testid="health-badge"
                data-badge={badge}
                style={{
                  ...styles.badge,
                  color: badgeColor(badge),
                  borderColor: badgeColor(badge),
                }}
              >
                {badgeSymbol(badge)} {badgeLabel(badge)}
              </span>

              {/* Email */}
              <span style={styles.email}>{account.email}</span>

              {/* Calendar count */}
              <span data-testid="calendar-count" style={styles.calCount}>
                {account.calendar_count}
              </span>
              <span style={styles.calLabel}>calendars</span>

              {/* Calendar names */}
              <span data-testid="calendar-names" style={styles.calNames}>
                {account.calendar_names.join(", ")}
              </span>

              {/* Last sync */}
              <span data-testid="last-sync" style={styles.lastSync}>
                {formatRelativeTime(account.last_successful_sync)}
              </span>

              {/* Actions */}
              <div style={styles.actions}>
                <button
                  data-testid="reconnect-btn"
                  onClick={() => handleReconnect(account.provider)}
                  style={styles.reconnectBtn}
                >
                  Reconnect
                </button>
                <button
                  data-testid="remove-btn"
                  onClick={() => handleRemoveClick(account)}
                  style={styles.removeBtn}
                >
                  Remove
                </button>
                <button
                  data-testid="expand-btn"
                  onClick={() => handleExpand(account.account_id)}
                  style={styles.expandBtn}
                  aria-label={isExpanded ? "Collapse" : "Expand"}
                >
                  {isExpanded ? "\u25B2" : "\u25BC"}
                </button>
              </div>
            </div>

            {/* Remediation guidance (shown inline for error accounts) */}
            {guidance && (
              <div data-testid="remediation-guidance" style={styles.guidance}>
                {guidance}
              </div>
            )}

            {/* Expanded detail view */}
            {isExpanded && (
              <div data-testid="account-detail" style={styles.detailPanel}>
                {/* Token info */}
                <div style={styles.detailSection}>
                  <h3 style={styles.detailTitle}>Token Status</h3>
                  <span data-testid="token-expiry" style={styles.detailValue}>
                    {formatTokenExpiry(account.token_expires_at)}
                  </span>
                </div>

                {/* Sync history */}
                <div style={styles.detailSection}>
                  <h3 style={styles.detailTitle}>Sync History</h3>
                  {historyLoading ? (
                    <div style={styles.loading}>Loading history...</div>
                  ) : syncHistory ? (
                    <div data-testid="sync-history">
                      {syncHistory.events.map((event) => (
                        <div
                          key={event.id}
                          data-testid="sync-history-entry"
                          style={styles.historyEntry}
                        >
                          <span
                            data-testid="sync-entry-status"
                            data-status={event.status}
                            style={{
                              ...styles.historyStatus,
                              color:
                                event.status === "success"
                                  ? "#16a34a"
                                  : "#dc2626",
                            }}
                          >
                            {event.status === "success" ? "\u25CF" : "\u2716"}
                          </span>
                          <span style={styles.historyTime}>
                            {formatRelativeTime(event.timestamp)}
                          </span>
                          <span style={styles.historyCount}>
                            {event.event_count} events
                          </span>
                          {event.error_message && (
                            <span style={styles.historyError}>
                              {event.error_message}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={styles.loading}>No history available</div>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}

      {/* Remove confirmation dialog */}
      {removeTarget && (
        <div
          data-testid="remove-dialog"
          style={styles.dialogOverlay}
          role="dialog"
          aria-modal="true"
          aria-label="Confirm remove account"
        >
          <div style={styles.dialog}>
            <h2 style={styles.dialogTitle}>Remove Account</h2>
            <p style={styles.dialogText}>
              Are you sure you want to disconnect{" "}
              <strong>{removeTarget.email}</strong>?
            </p>
            <p style={styles.dialogWarning}>
              This will stop syncing events, revoke tokens, and clean up all
              stored credentials for this account.
            </p>
            <div style={styles.dialogActions}>
              <button
                data-testid="remove-cancel"
                onClick={handleRemoveCancel}
                style={styles.cancelBtn}
                disabled={removing}
              >
                Cancel
              </button>
              <button
                data-testid="remove-confirm"
                onClick={handleRemoveConfirm}
                style={styles.confirmRemoveBtn}
                disabled={removing}
              >
                {removing ? "Removing..." : "Remove"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline styles (consistent with existing page patterns)
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
  counter: {
    color: "#94a3b8",
    fontSize: "0.875rem",
    marginBottom: "1rem",
  },
  statusMessage: {
    padding: "0.5rem 1rem",
    borderRadius: "6px",
    fontSize: "0.875rem",
    fontWeight: 500,
    marginBottom: "1rem",
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
  accountCard: {
    backgroundColor: "#1e293b",
    borderRadius: "8px",
    padding: "0.75rem 1rem",
    marginBottom: "0.75rem",
    border: "1px solid #334155",
  },
  summaryRow: {
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
    flexWrap: "wrap" as const,
  },
  providerIndicator: {
    width: "8px",
    height: "32px",
    borderRadius: "4px",
    flexShrink: 0,
  },
  badge: {
    padding: "0.2rem 0.5rem",
    borderRadius: "12px",
    border: "1px solid",
    fontSize: "0.75rem",
    fontWeight: 600,
    whiteSpace: "nowrap" as const,
  },
  email: {
    color: "#e2e8f0",
    fontWeight: 500,
    fontSize: "0.9rem",
    minWidth: "160px",
  },
  calCount: {
    color: "#94a3b8",
    fontWeight: 600,
    fontSize: "0.85rem",
  },
  calLabel: {
    color: "#64748b",
    fontSize: "0.75rem",
  },
  calNames: {
    color: "#64748b",
    fontSize: "0.75rem",
    flex: 1,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  lastSync: {
    color: "#94a3b8",
    fontSize: "0.8rem",
    minWidth: "70px",
    textAlign: "right" as const,
  },
  actions: {
    display: "flex",
    gap: "0.5rem",
    marginLeft: "auto",
  },
  reconnectBtn: {
    padding: "0.3rem 0.6rem",
    borderRadius: "6px",
    border: "1px solid #3b82f6",
    background: "transparent",
    color: "#3b82f6",
    cursor: "pointer",
    fontSize: "0.75rem",
    fontWeight: 500,
  },
  removeBtn: {
    padding: "0.3rem 0.6rem",
    borderRadius: "6px",
    border: "1px solid #ef4444",
    background: "transparent",
    color: "#ef4444",
    cursor: "pointer",
    fontSize: "0.75rem",
  },
  expandBtn: {
    padding: "0.3rem 0.5rem",
    borderRadius: "6px",
    border: "1px solid #475569",
    background: "transparent",
    color: "#94a3b8",
    cursor: "pointer",
    fontSize: "0.75rem",
  },
  guidance: {
    marginTop: "0.5rem",
    padding: "0.5rem 0.75rem",
    backgroundColor: "#450a0a",
    borderRadius: "6px",
    color: "#fca5a5",
    fontSize: "0.8rem",
    borderLeft: "3px solid #dc2626",
  },
  detailPanel: {
    marginTop: "0.75rem",
    paddingTop: "0.75rem",
    borderTop: "1px solid #334155",
  },
  detailSection: {
    marginBottom: "0.75rem",
  },
  detailTitle: {
    fontSize: "0.8rem",
    fontWeight: 600,
    color: "#94a3b8",
    margin: "0 0 0.4rem 0",
    textTransform: "uppercase" as const,
    letterSpacing: "0.05em",
  },
  detailValue: {
    color: "#e2e8f0",
    fontSize: "0.85rem",
  },
  historyEntry: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    padding: "0.25rem 0",
    fontSize: "0.8rem",
  },
  historyStatus: {
    fontSize: "0.7rem",
  },
  historyTime: {
    color: "#94a3b8",
    minWidth: "60px",
  },
  historyCount: {
    color: "#e2e8f0",
  },
  historyError: {
    color: "#fca5a5",
    fontSize: "0.75rem",
    fontStyle: "italic",
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
  // Dialog styles
  dialogOverlay: {
    position: "fixed" as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0, 0, 0, 0.6)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
  },
  dialog: {
    backgroundColor: "#1e293b",
    borderRadius: "12px",
    padding: "1.5rem",
    maxWidth: "420px",
    width: "90%",
    border: "1px solid #334155",
  },
  dialogTitle: {
    fontSize: "1.1rem",
    fontWeight: 700,
    color: "#f1f5f9",
    margin: "0 0 0.75rem 0",
  },
  dialogText: {
    color: "#e2e8f0",
    fontSize: "0.9rem",
    margin: "0 0 0.5rem 0",
  },
  dialogWarning: {
    color: "#fbbf24",
    fontSize: "0.8rem",
    margin: "0 0 1rem 0",
  },
  dialogActions: {
    display: "flex",
    justifyContent: "flex-end",
    gap: "0.5rem",
  },
  cancelBtn: {
    padding: "0.5rem 1rem",
    borderRadius: "6px",
    border: "1px solid #475569",
    background: "transparent",
    color: "#94a3b8",
    cursor: "pointer",
    fontSize: "0.875rem",
  },
  confirmRemoveBtn: {
    padding: "0.5rem 1rem",
    borderRadius: "6px",
    border: "1px solid #ef4444",
    backgroundColor: "#7f1d1d",
    color: "#fca5a5",
    cursor: "pointer",
    fontSize: "0.875rem",
    fontWeight: 600,
  },
};
