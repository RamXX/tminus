/**
 * OrgUsageDashboard component.
 *
 * Displays per-member usage statistics for an organization:
 * - Accounts used (number of linked calendar accounts)
 * - Features active (list of active feature names)
 * - Last sync timestamp
 *
 * Read-only for all users (admins and members alike).
 */

import type { MemberUsage } from "../lib/admin";
import { formatLastSync } from "../lib/admin";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface OrgUsageDashboardProps {
  /** Per-member usage data. */
  usage: MemberUsage[];
  /** Loading state. */
  loading: boolean;
  /** Error message, if any. */
  error: string | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function OrgUsageDashboard({
  usage,
  loading,
  error,
}: OrgUsageDashboardProps) {
  if (loading) {
    return (
      <div data-testid="usage-dashboard-loading" style={styles.card}>
        <h2 style={styles.sectionTitle}>Usage Dashboard</h2>
        <div style={styles.loading}>Loading usage data...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div data-testid="usage-dashboard-error" style={styles.card}>
        <h2 style={styles.sectionTitle}>Usage Dashboard</h2>
        <div style={styles.errorBox}>Failed to load usage data: {error}</div>
      </div>
    );
  }

  return (
    <div data-testid="usage-dashboard" style={styles.card}>
      <h2 style={styles.sectionTitle}>Usage Dashboard</h2>

      {usage.length === 0 ? (
        <div data-testid="usage-empty" style={styles.emptyState}>
          No usage data available.
        </div>
      ) : (
        <div data-testid="usage-table-container" style={styles.tableContainer}>
          <table data-testid="usage-table" style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Member</th>
                <th style={styles.th}>Role</th>
                <th style={styles.thCenter}>Accounts</th>
                <th style={styles.th}>Features Active</th>
                <th style={styles.th}>Last Sync</th>
              </tr>
            </thead>
            <tbody>
              {usage.map((u) => (
                <tr key={u.user_id} data-testid={`usage-row-${u.user_id}`}>
                  <td data-testid={`usage-email-${u.user_id}`} style={styles.td}>
                    {u.email}
                  </td>
                  <td data-testid={`usage-role-${u.user_id}`} style={styles.td}>
                    <span
                      style={{
                        ...styles.roleBadge,
                        backgroundColor: u.role === "admin" ? "#1e3a5f" : "#1e293b",
                        color: u.role === "admin" ? "#60a5fa" : "#94a3b8",
                      }}
                    >
                      {u.role}
                    </span>
                  </td>
                  <td
                    data-testid={`usage-accounts-${u.user_id}`}
                    style={styles.tdCenter}
                  >
                    {u.accounts_used}
                  </td>
                  <td
                    data-testid={`usage-features-${u.user_id}`}
                    style={styles.td}
                  >
                    {u.features_active.length > 0
                      ? u.features_active.join(", ")
                      : "None"}
                  </td>
                  <td
                    data-testid={`usage-sync-${u.user_id}`}
                    style={styles.td}
                  >
                    {formatLastSync(u.last_sync)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles: Record<string, React.CSSProperties> = {
  card: {
    backgroundColor: "#1e293b",
    borderRadius: "12px",
    padding: "1.5rem",
    border: "1px solid #334155",
    marginBottom: "2rem",
  },
  sectionTitle: {
    fontSize: "1.1rem",
    fontWeight: 700,
    color: "#f1f5f9",
    marginTop: 0,
    marginBottom: "1rem",
  },
  loading: {
    color: "#94a3b8",
    padding: "2rem",
    textAlign: "center" as const,
  },
  errorBox: {
    color: "#fca5a5",
    padding: "1rem",
    textAlign: "center" as const,
  },
  emptyState: {
    color: "#94a3b8",
    padding: "2rem",
    textAlign: "center" as const,
  },
  tableContainer: {
    overflowX: "auto" as const,
  },
  table: {
    width: "100%",
    borderCollapse: "collapse" as const,
    fontSize: "0.875rem",
  },
  th: {
    textAlign: "left" as const,
    padding: "0.75rem 1rem",
    borderBottom: "1px solid #334155",
    color: "#94a3b8",
    fontSize: "0.8rem",
    fontWeight: 600,
    textTransform: "uppercase" as const,
    letterSpacing: "0.05em",
  },
  thCenter: {
    textAlign: "center" as const,
    padding: "0.75rem 1rem",
    borderBottom: "1px solid #334155",
    color: "#94a3b8",
    fontSize: "0.8rem",
    fontWeight: 600,
    textTransform: "uppercase" as const,
    letterSpacing: "0.05em",
  },
  td: {
    padding: "0.75rem 1rem",
    borderBottom: "1px solid #1e293b",
    color: "#e2e8f0",
  },
  tdCenter: {
    padding: "0.75rem 1rem",
    borderBottom: "1px solid #1e293b",
    color: "#e2e8f0",
    textAlign: "center" as const,
  },
  roleBadge: {
    padding: "0.15rem 0.5rem",
    borderRadius: "4px",
    fontSize: "0.75rem",
    fontWeight: 600,
    textTransform: "uppercase" as const,
  },
};
