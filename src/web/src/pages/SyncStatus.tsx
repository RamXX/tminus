/**
 * Sync Status Dashboard page.
 *
 * Displays per-account sync health with green/yellow/red indicators.
 * Shows: account email, provider, status, last_sync_ts, channel_status,
 * pending_writes, error count.
 *
 * Features:
 * - Overall health banner at top (worst-of-all health)
 * - User graph mirror engine health card
 * - Auto-refreshes every 30 seconds
 * - Loading, error, and empty states
 *
 * Uses useApi() for token-injected API calls.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { useApi } from "../lib/api-provider";
import {
  computeAllAccountHealth,
  computeOverallHealth,
  computeUserGraphHealth,
  healthToColor,
  healthLabel,
  REFRESH_INTERVAL_MS,
  type AccountHealth,
  type UserGraphSyncHealth,
  type HealthState,
} from "../lib/sync-status";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { Badge } from "../components/ui/badge";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SyncStatus() {
  const api = useApi();

  const [accounts, setAccounts] = useState<AccountHealth[]>([]);
  const [userGraph, setUserGraph] = useState<UserGraphSyncHealth | null>(null);
  const [overallHealth, setOverallHealth] = useState<HealthState>("healthy");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Track whether component is mounted to avoid state updates after unmount
  const mountedRef = useRef(true);

  const loadData = useCallback(async () => {
    try {
      const response = await api.fetchSyncStatus();
      if (!mountedRef.current) return;

      const enriched = computeAllAccountHealth(response.accounts);
      const overall = computeOverallHealth(enriched, response.user_graph ?? null);

      setAccounts(enriched);
      setUserGraph(response.user_graph ?? null);
      setOverallHealth(overall);
      setError(null);
      setLoading(false);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : "Unknown error");
      setLoading(false);
    }
  }, [api]);

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
      <div data-testid="sync-status-loading" className="mx-auto max-w-[1200px]">
        <h1 className="text-2xl font-bold text-foreground mb-4">Sync Status</h1>
        <p className="text-muted-foreground text-center py-8">Loading sync status...</p>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div data-testid="sync-status-error" className="mx-auto max-w-[1200px]">
        <h1 className="text-2xl font-bold text-foreground mb-4">Sync Status</h1>
        <div className="text-destructive text-center py-8">
          <p>Failed to load sync status: {error}</p>
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

  // Empty state
  if (accounts.length === 0) {
    return (
      <div className="mx-auto max-w-[1200px]">
        <h1 className="text-2xl font-bold text-foreground mb-4">Sync Status</h1>
        <p className="text-muted-foreground text-center py-8">No accounts configured.</p>
      </div>
    );
  }

  // Normal state
  return (
    <div className="mx-auto max-w-[1200px]">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold text-foreground">Sync Status</h1>
      </div>

      {/* Overall health banner */}
      <div
        data-testid="overall-health-banner"
        data-health={overallHealth}
        data-color={healthToColor(overallHealth)}
        className="flex items-center gap-2 px-4 py-3 rounded-lg text-white font-semibold text-sm mb-6"
        style={{ backgroundColor: COLOR_MAP[healthToColor(overallHealth)] }}
      >
        <span className="text-lg">
          {HEALTH_SYMBOL[overallHealth]}
        </span>
        <span>Overall: {healthLabel(overallHealth)}</span>
      </div>

      {userGraph && (
        <Card
          data-testid="user-graph-health"
          data-health={computeUserGraphHealth(userGraph)}
          className="mb-4"
        >
          <CardContent className="py-3 px-4 text-sm text-muted-foreground">
            <strong className="text-foreground">Mirror Engine:</strong>{" "}
            {userGraph.pending_mirrors} pending, {userGraph.error_mirrors} errors,{" "}
            {userGraph.active_mirrors} active
          </CardContent>
        </Card>
      )}

      {/* Account table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr>
              <th className="text-left px-3 py-2 border-b border-border text-muted-foreground font-semibold whitespace-nowrap">Status</th>
              <th className="text-left px-3 py-2 border-b border-border text-muted-foreground font-semibold whitespace-nowrap">Email</th>
              <th className="text-left px-3 py-2 border-b border-border text-muted-foreground font-semibold whitespace-nowrap">Provider</th>
              <th className="text-left px-3 py-2 border-b border-border text-muted-foreground font-semibold whitespace-nowrap">Last Sync</th>
              <th className="text-left px-3 py-2 border-b border-border text-muted-foreground font-semibold whitespace-nowrap">Channel</th>
              <th className="text-left px-3 py-2 border-b border-border text-muted-foreground font-semibold whitespace-nowrap">Pending</th>
              <th className="text-left px-3 py-2 border-b border-border text-muted-foreground font-semibold whitespace-nowrap">Errors</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((account) => (
              <tr
                key={account.account_id}
                data-testid={`account-row-${account.account_id}`}
                className="border-b border-border/50"
              >
                <td className="px-3 py-2 text-foreground whitespace-nowrap">
                  <span
                    data-testid="health-indicator"
                    data-health={account.health}
                    data-color={account.color}
                    className="inline-block w-3 h-3 rounded-full"
                    style={{ backgroundColor: COLOR_MAP[account.color] }}
                    title={healthLabel(account.health)}
                  />
                </td>
                <td className="px-3 py-2 text-foreground whitespace-nowrap">{account.email}</td>
                <td className="px-3 py-2 text-foreground whitespace-nowrap">{account.provider}</td>
                <td className="px-3 py-2 text-foreground whitespace-nowrap">
                  <span data-testid="last-sync-time">
                    {account.last_sync_ts
                      ? formatRelativeTime(account.last_sync_ts)
                      : "Never"}
                  </span>
                </td>
                <td className="px-3 py-2 text-foreground whitespace-nowrap">
                  <span data-testid="channel-status">
                    {account.channel_status}
                  </span>
                </td>
                <td className="px-3 py-2 text-foreground whitespace-nowrap">
                  <span data-testid="pending-writes">
                    {account.pending_writes}
                  </span>
                </td>
                <td className="px-3 py-2 text-foreground whitespace-nowrap">
                  <span
                    data-testid="error-count"
                    className={account.error_count > 0 ? "text-red-300 font-bold" : ""}
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
