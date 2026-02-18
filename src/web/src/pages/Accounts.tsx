/**
 * Account Management page.
 *
 * Displays linked calendar accounts with status indicators.
 * Allows linking new Google/Microsoft accounts (via OAuth redirect to
 * oauth.tminus.ink) and unlinking existing accounts with a confirmation dialog.
 *
 * Features:
 * - List accounts with email, provider, and status
 * - Link new Google account (redirects to OAuth worker)
 * - Link new Microsoft account (redirects to OAuth worker)
 * - Unlink account with confirmation dialog
 * - Loading, error, and empty states
 * - OAuth callback handling (shows success message on return)
 *
 * The component accepts fetch/unlink functions as props for testability.
 * In production, these are wired to the API client with auth tokens.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import type { LinkedAccount, AccountProvider } from "../lib/api";
import {
  buildOAuthStartUrl,
  statusColor,
  statusLabel,
  statusSymbol,
  providerLabel,
} from "../lib/accounts";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface AccountsProps {
  /** Authenticated user ID for OAuth start URLs. */
  currentUserId: string;
  /** Fetch linked accounts. Injected for testability. */
  fetchAccounts: () => Promise<LinkedAccount[]>;
  /** Unlink an account by ID. Injected for testability. */
  unlinkAccount: (accountId: string) => Promise<void>;
  /**
   * Navigate to an OAuth URL. Defaults to window.location.assign.
   * Injected for testability (prevents actual navigation in tests).
   */
  navigateToOAuth?: (url: string) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Accounts({
  currentUserId,
  fetchAccounts,
  unlinkAccount,
  navigateToOAuth = (url) => {
    window.location.assign(url);
  },
}: AccountsProps) {
  const [accounts, setAccounts] = useState<LinkedAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unlinkTarget, setUnlinkTarget] = useState<LinkedAccount | null>(null);
  const [unlinking, setUnlinking] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  const mountedRef = useRef(true);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Show a temporary status message that auto-clears after 4 seconds
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

  // Load accounts from the API
  const loadAccounts = useCallback(async () => {
    try {
      const data = await fetchAccounts();
      if (!mountedRef.current) return;
      setAccounts(data);
      setError(null);
      setLoading(false);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : "Unknown error");
      setLoading(false);
    }
  }, [fetchAccounts]);

  // Initial load + check for OAuth callback
  useEffect(() => {
    mountedRef.current = true;
    loadAccounts();

    // Check URL for OAuth callback indicators.
    // OAuth callback may return params in URL search (?account_id=...)
    // while route information lives in hash (#/accounts?linked=true).
    const url = new URL(window.location.href);
    const linkedAccountId = url.searchParams.get("account_id");
    const linkedEmail = url.searchParams.get("email");
    const hash = window.location.hash;
    if (linkedAccountId) {
      showStatus(
        "success",
        linkedEmail
          ? `Account linked successfully: ${linkedEmail}`
          : "Account linked successfully.",
      );
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}#/accounts`,
      );
    } else if (hash.includes("error=")) {
      const match = hash.match(/error=([^&]*)/);
      const errorMsg = match ? decodeURIComponent(match[1]) : "Unknown error";
      showStatus("error", `Failed to link account: ${errorMsg}`);
      window.location.hash = "#/accounts";
    } else if (hash.includes("linked=true")) {
      showStatus("success", "Account linked successfully.");
      window.location.hash = "#/accounts";
    }

    return () => {
      mountedRef.current = false;
      if (statusTimerRef.current) {
        clearTimeout(statusTimerRef.current);
      }
    };
  }, [loadAccounts, showStatus]);

  // Handle clicking "Link Account" for a provider
  const handleLinkAccount = useCallback(
    (provider: AccountProvider) => {
      if (!currentUserId) {
        showStatus("error", "Session expired. Please sign in again.");
        return;
      }
      const url = buildOAuthStartUrl(provider, currentUserId);
      navigateToOAuth(url);
    },
    [currentUserId, navigateToOAuth, showStatus],
  );

  // Handle clicking "Unlink" on an account -- show confirmation dialog
  const handleUnlinkClick = useCallback((account: LinkedAccount) => {
    setUnlinkTarget(account);
  }, []);

  // Cancel unlink dialog
  const handleUnlinkCancel = useCallback(() => {
    setUnlinkTarget(null);
  }, []);

  // Confirm unlink -- call API, remove from list
  const handleUnlinkConfirm = useCallback(async () => {
    if (!unlinkTarget) return;

    setUnlinking(true);
    try {
      await unlinkAccount(unlinkTarget.account_id);
      if (!mountedRef.current) return;

      // Remove account from local state
      setAccounts((prev) =>
        prev.filter((a) => a.account_id !== unlinkTarget.account_id),
      );
      setUnlinkTarget(null);
      showStatus("success", `Account ${unlinkTarget.email} unlinked.`);
    } catch (err) {
      if (!mountedRef.current) return;
      showStatus(
        "error",
        `Failed to unlink: ${err instanceof Error ? err.message : "Unknown error"}`,
      );
    } finally {
      if (mountedRef.current) {
        setUnlinking(false);
      }
    }
  }, [unlinkTarget, unlinkAccount, showStatus]);

  // -- Loading state --
  if (loading) {
    return (
      <div data-testid="accounts-loading" style={styles.container}>
        <h1 style={styles.title}>Accounts</h1>
        <div style={styles.loading}>Loading accounts...</div>
      </div>
    );
  }

  // -- Error state --
  if (error) {
    return (
      <div data-testid="accounts-error" style={styles.container}>
        <h1 style={styles.title}>Accounts</h1>
        <div style={styles.errorBox}>
          <p>Failed to load accounts: {error}</p>
          <button
            onClick={loadAccounts}
            style={styles.retryBtn}
            aria-label="Retry"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  // -- Normal state --
  return (
    <div style={styles.container}>
      <div style={styles.headerRow}>
        <h1 style={styles.title}>Accounts</h1>
        <a href="#/calendar" style={styles.backLink}>
          Back to Calendar
        </a>
      </div>

      {/* Status message */}
      {statusMsg && (
        <div
          data-testid="accounts-status"
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

      {/* Link account buttons */}
      <div style={styles.linkSection} data-testid="link-account-section">
        <span style={styles.linkLabel}>Link new account:</span>
        <button
          data-testid="link-google"
          onClick={() => handleLinkAccount("google")}
          style={styles.linkBtn}
        >
          Link Google Account
        </button>
        <button
          data-testid="link-microsoft"
          onClick={() => handleLinkAccount("microsoft")}
          style={styles.linkBtn}
        >
          Link Microsoft Account
        </button>
      </div>

      {/* Account list */}
      {accounts.length === 0 ? (
        <div style={styles.emptyState} data-testid="accounts-empty">
          No accounts linked yet. Link a Google or Microsoft account to get
          started.
        </div>
      ) : (
        <div style={styles.tableWrapper}>
          <table style={styles.table} data-testid="accounts-table">
            <thead>
              <tr>
                <th style={styles.th}>Status</th>
                <th style={styles.th}>Email</th>
                <th style={styles.th}>Provider</th>
                <th style={styles.th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((account) => (
                <tr
                  key={account.account_id}
                  data-testid={`account-row-${account.account_id}`}
                  style={styles.tr}
                >
                  <td style={styles.td}>
                    <span
                      data-testid="account-status-indicator"
                      data-status={account.status}
                      style={{
                        ...styles.statusDot,
                        color: statusColor(account.status),
                      }}
                      title={statusLabel(account.status)}
                    >
                      {statusSymbol(account.status)}
                    </span>
                    <span
                      data-testid="account-status-label"
                      style={{
                        marginLeft: "0.5rem",
                        color: statusColor(account.status),
                        fontSize: "0.8rem",
                      }}
                    >
                      {statusLabel(account.status)}
                    </span>
                  </td>
                  <td style={styles.td} data-testid="account-email">
                    {account.email}
                  </td>
                  <td style={styles.td} data-testid="account-provider">
                    {providerLabel(account.provider)}
                  </td>
                  <td style={styles.td}>
                    <button
                      data-testid={`unlink-btn-${account.account_id}`}
                      onClick={() => handleUnlinkClick(account)}
                      style={styles.unlinkBtn}
                    >
                      Unlink
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Unlink confirmation dialog */}
      {unlinkTarget && (
        <div
          data-testid="unlink-dialog"
          style={styles.dialogOverlay}
          role="dialog"
          aria-modal="true"
          aria-label="Confirm unlink account"
        >
          <div style={styles.dialog}>
            <h2 style={styles.dialogTitle}>Unlink Account</h2>
            <p style={styles.dialogText}>
              Are you sure you want to unlink{" "}
              <strong>{unlinkTarget.email}</strong> (
              {providerLabel(unlinkTarget.provider)})?
            </p>
            <p style={styles.dialogWarning}>
              This will stop syncing events for this account. Existing mirrored
              events will remain but no longer update.
            </p>
            <div style={styles.dialogActions}>
              <button
                data-testid="unlink-cancel"
                onClick={handleUnlinkCancel}
                style={styles.cancelBtn}
                disabled={unlinking}
              >
                Cancel
              </button>
              <button
                data-testid="unlink-confirm"
                onClick={handleUnlinkConfirm}
                style={styles.confirmUnlinkBtn}
                disabled={unlinking}
              >
                {unlinking ? "Unlinking..." : "Unlink"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline styles (consistent with SyncStatus.tsx / Policies.tsx patterns)
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
  linkSection: {
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
    marginBottom: "1.5rem",
    flexWrap: "wrap" as const,
  },
  linkLabel: {
    color: "#94a3b8",
    fontSize: "0.875rem",
  },
  linkBtn: {
    padding: "0.5rem 1rem",
    borderRadius: "6px",
    border: "1px solid #3b82f6",
    background: "transparent",
    color: "#3b82f6",
    cursor: "pointer",
    fontSize: "0.875rem",
    fontWeight: 500,
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
    whiteSpace: "nowrap" as const,
  },
  statusDot: {
    fontSize: "0.875rem",
  },
  unlinkBtn: {
    padding: "0.35rem 0.75rem",
    borderRadius: "6px",
    border: "1px solid #ef4444",
    background: "transparent",
    color: "#ef4444",
    cursor: "pointer",
    fontSize: "0.8rem",
  },
  emptyState: {
    color: "#94a3b8",
    padding: "2rem",
    textAlign: "center" as const,
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
  confirmUnlinkBtn: {
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
