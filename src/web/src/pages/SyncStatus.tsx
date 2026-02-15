/**
 * Sync Status Dashboard page.
 *
 * Displays per-account sync health with green/yellow/red indicators.
 * Shows: account email, provider, status, last_sync_ts, channel_status,
 * pending_writes, error count.
 *
 * Features:
 * - Overall health banner at top (worst-of-all health)
 * - Auto-refreshes every 30 seconds
 * - Loading, error, and empty states
 *
 * The component accepts a fetchSyncStatus prop for testability.
 * In production, this is wired to the API client.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import {
  computeAllAccountHealth,
  computeOverallHealth,
  healthToColor,
  healthLabel,
  REFRESH_INTERVAL_MS,
  type SyncStatusResponse,
  type AccountHealth,
  type HealthState,
} from "../lib/sync-status";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface SyncStatusProps {
  /** Fetch function that returns sync status data. Injected for testability. */
  fetchSyncStatus: () => Promise<SyncStatusResponse>;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SyncStatus({ fetchSyncStatus }: SyncStatusProps) {
  const [accounts, setAccounts] = useState<AccountHealth[]>([]);
  const [overallHealth, setOverallHealth] = useState<HealthState>("healthy");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Track whether component is mounted to avoid state updates after unmount
  const mountedRef = useRef(true);

  const loadData = useCallback(async () => {
    try {
      const response = await fetchSyncStatus();
      if (!mountedRef.current) return;

      const enriched = computeAllAccountHealth(response.accounts);
      const overall = computeOverallHealth(enriched);

      setAccounts(enriched);
      setOverallHealth(overall);
      setError(null);
      setLoading(false);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : "Unknown error");
      setLoading(false);
    }
  }, [fetchSyncStatus]);

  // Initial fetch + auto-refresh
  useEffect(() => {
    mountedRef.current = true;
    loadData();

    const timer = setInterval(() => {
      loadData();
    }, REFRESH_INTERVAL_MS);

    return () => {
      mountedRef.current = false;
      clearInterval(timer);
    };
  }, [loadData]);

  // Loading state
  if (loading) {
    return (
      <div data-testid="sync-status-loading" style={styles.container}>
        <h1 style={styles.title}>Sync Status</h1>
        <div style={styles.loading}>Loading sync status...</div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div data-testid="sync-status-error" style={styles.container}>
        <h1 style={styles.title}>Sync Status</h1>
        <div style={styles.errorBox}>
          <p>Failed to load sync status: {error}</p>
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

  // Empty state
  if (accounts.length === 0) {
    return (
      <div style={styles.container}>
        <h1 style={styles.title}>Sync Status</h1>
        <div style={styles.emptyState}>No accounts configured.</div>
      </div>
    );
  }

  // Normal state
  return (
    <div style={styles.container}>
      <div style={styles.headerRow}>
        <h1 style={styles.title}>Sync Status</h1>
        <a href="#/calendar" style={styles.backLink}>
          Back to Calendar
        </a>
      </div>

      {/* Overall health banner */}
      <div
        data-testid="overall-health-banner"
        data-health={overallHealth}
        data-color={healthToColor(overallHealth)}
        style={{
          ...styles.banner,
          backgroundColor: COLOR_MAP[healthToColor(overallHealth)],
        }}
      >
        <span style={styles.bannerDot}>
          {HEALTH_SYMBOL[overallHealth]}
        </span>
        <span>Overall: {healthLabel(overallHealth)}</span>
      </div>

      {/* Account table */}
      <div style={styles.tableWrapper}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Status</th>
              <th style={styles.th}>Email</th>
              <th style={styles.th}>Provider</th>
              <th style={styles.th}>Last Sync</th>
              <th style={styles.th}>Channel</th>
              <th style={styles.th}>Pending</th>
              <th style={styles.th}>Errors</th>
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
                    data-testid="health-indicator"
                    data-health={account.health}
                    data-color={account.color}
                    style={{
                      ...styles.healthDot,
                      backgroundColor: COLOR_MAP[account.color],
                    }}
                    title={healthLabel(account.health)}
                  />
                </td>
                <td style={styles.td}>{account.email}</td>
                <td style={styles.td}>{account.provider}</td>
                <td style={styles.td}>
                  <span data-testid="last-sync-time">
                    {account.last_sync_ts
                      ? formatRelativeTime(account.last_sync_ts)
                      : "Never"}
                  </span>
                </td>
                <td style={styles.td}>
                  <span data-testid="channel-status">
                    {account.channel_status}
                  </span>
                </td>
                <td style={styles.td}>
                  <span data-testid="pending-writes">
                    {account.pending_writes}
                  </span>
                </td>
                <td style={styles.td}>
                  <span
                    data-testid="error-count"
                    style={
                      account.error_count > 0
                        ? styles.errorBadge
                        : undefined
                    }
                  >
                    {account.error_count}
                  </span>
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
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format an ISO timestamp as a human-readable relative time string.
 * Falls back to the raw ISO string if parsing fails.
 */
function formatRelativeTime(isoTimestamp: string): string {
  try {
    const date = new Date(isoTimestamp);
    const diffMs = Date.now() - date.getTime();
    const diffMin = Math.floor(diffMs / 60_000);

    if (diffMin < 1) return "Just now";
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.floor(diffHr / 24);
    return `${diffDay}d ago`;
  } catch {
    return isoTimestamp;
  }
}

// ---------------------------------------------------------------------------
// Color mapping & symbols
// ---------------------------------------------------------------------------

const COLOR_MAP: Record<string, string> = {
  green: "#16a34a",
  yellow: "#ca8a04",
  red: "#dc2626",
};

const HEALTH_SYMBOL: Record<HealthState, string> = {
  healthy: "\u25CF", // filled circle
  degraded: "\u25B2", // triangle
  stale: "\u25A0", // square
  error: "\u2716", // heavy X
};

// ---------------------------------------------------------------------------
// Inline styles (consistent with existing Calendar.tsx patterns)
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
  banner: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    padding: "0.75rem 1rem",
    borderRadius: "8px",
    color: "#fff",
    fontWeight: 600,
    fontSize: "0.95rem",
    marginBottom: "1.5rem",
  },
  bannerDot: {
    fontSize: "1.1rem",
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
  healthDot: {
    display: "inline-block",
    width: "12px",
    height: "12px",
    borderRadius: "50%",
  },
  errorBadge: {
    color: "#fca5a5",
    fontWeight: 700,
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
