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
 * Uses useApi() for token-injected API calls.
 *
 * Design decisions:
 * - Provider-specific colors (Google=blue, Microsoft=purple, Apple=gray)
 *   per retro insight: hash-based assignment causes collisions.
 * - API response includes account_count + tier_limit per retro insight.
 * - Stale threshold is 1 hour (configurable) per AC6.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { useApi } from "../lib/api-provider";
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
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ProviderHealth() {
  const api = useApi();

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
      const data = await api.fetchAccountsHealth();
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
  }, [api]);

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
        const history = await api.fetchSyncHistory(accountId);
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
    [expandedId, api],
  );

  // Reconnect via OAuth
  const handleReconnect = useCallback(
    (provider: AccountProvider) => {
      const url = buildOAuthStartUrl(provider);
      window.location.assign(url);
    },
    [],
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
      await api.removeAccount(removeTarget.account_id);
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
  }, [removeTarget, api, showStatus]);

  // --- Loading state ---
  if (loading) {
    return (
      <div data-testid="health-loading" className="mx-auto max-w-[1200px]">
        <h1 className="text-2xl font-bold text-foreground">Provider Health</h1>
        <p className="text-muted-foreground text-center py-8">Loading account health...</p>
      </div>
    );
  }

  // --- Error state ---
  if (error) {
    return (
      <div data-testid="health-error" className="mx-auto max-w-[1200px]">
        <h1 className="text-2xl font-bold text-foreground">Provider Health</h1>
        <div className="text-destructive text-center py-8">
          <p>Failed to load accounts: {error}</p>
          <Button
            onClick={loadAccounts}
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

  // --- Empty state ---
  if (accounts.length === 0) {
    return (
      <div className="mx-auto max-w-[1200px]">
        <h1 className="text-2xl font-bold text-foreground">Provider Health</h1>
        <p data-testid="health-empty" className="text-muted-foreground text-center py-8">
          No accounts connected. Link a calendar account to get started.
        </p>
      </div>
    );
  }

  // --- Normal state ---
  return (
    <div className="mx-auto max-w-[1200px]">
      <div className="flex items-center justify-between mb-2">
        <h1 className="text-2xl font-bold text-foreground">Provider Health</h1>
        <a href="#/calendar" className="text-muted-foreground text-sm no-underline hover:text-foreground">
          Back to Calendar
        </a>
      </div>

      {/* Account counter (shows X of Y) */}
      <p data-testid="account-counter" className="text-muted-foreground text-sm mb-4">
        {accountCount} of {tierLimit} accounts connected
      </p>

      {/* Status message */}
      {statusMsg && (
        <div
          data-testid="health-status-msg"
          data-status-type={statusMsg.type}
          className="px-4 py-2 rounded-md text-sm font-medium mb-4"
          style={
            statusMsg.type === "success"
              ? { backgroundColor: "#064e3b", color: "#6ee7b7", border: "1px solid #059669" }
              : { backgroundColor: "#450a0a", color: "#fca5a5", border: "1px solid #dc2626" }
          }
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
          <Card
            key={account.account_id}
            data-testid={`health-row-${account.account_id}`}
            className="mb-3 p-3"
          >
            <CardContent className="p-0">
              {/* Account summary row */}
              <div className="flex items-center gap-3 flex-wrap">
                {/* Provider indicator -- dynamic color */}
                <div
                  className="w-2 h-8 rounded shrink-0"
                  style={{ backgroundColor: providerColor(account.provider) }}
                  title={account.provider}
                />

                {/* Badge -- dynamic color */}
                <span
                  data-testid="health-badge"
                  data-badge={badge}
                  className="px-2 py-0.5 rounded-full border text-xs font-semibold whitespace-nowrap"
                  style={{
                    color: badgeColor(badge),
                    borderColor: badgeColor(badge),
                  }}
                >
                  {badgeSymbol(badge)} {badgeLabel(badge)}
                </span>

                {/* Email */}
                <span className="text-foreground font-medium text-sm min-w-[160px]">
                  {account.email}
                </span>

                {/* Calendar count */}
                <span data-testid="calendar-count" className="text-muted-foreground font-semibold text-sm">
                  {account.calendar_count}
                </span>
                <span className="text-muted-foreground/60 text-xs">calendars</span>

                {/* Calendar names */}
                <span data-testid="calendar-names" className="text-muted-foreground/60 text-xs flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                  {account.calendar_names.join(", ")}
                </span>

                {/* Last sync */}
                <span data-testid="last-sync" className="text-muted-foreground text-xs min-w-[70px] text-right">
                  {formatRelativeTime(account.last_successful_sync)}
                </span>

                {/* Actions */}
                <div className="flex gap-2 ml-auto">
                  <Button
                    data-testid="reconnect-btn"
                    onClick={() => handleReconnect(account.provider)}
                    variant="outline"
                    size="sm"
                    className="text-xs border-blue-500 text-blue-500 hover:bg-blue-500/10"
                  >
                    Reconnect
                  </Button>
                  <Button
                    data-testid="remove-btn"
                    onClick={() => handleRemoveClick(account)}
                    variant="outline"
                    size="sm"
                    className="text-xs border-destructive text-destructive hover:bg-destructive/10"
                  >
                    Remove
                  </Button>
                  <Button
                    data-testid="expand-btn"
                    onClick={() => handleExpand(account.account_id)}
                    variant="outline"
                    size="sm"
                    className="text-xs"
                    aria-label={isExpanded ? "Collapse" : "Expand"}
                  >
                    {isExpanded ? "\u25B2" : "\u25BC"}
                  </Button>
                </div>
              </div>

              {/* Remediation guidance (shown inline for error accounts) */}
              {guidance && (
                <div
                  data-testid="remediation-guidance"
                  className="mt-2 px-3 py-2 rounded-md text-xs border-l-[3px]"
                  style={{
                    backgroundColor: "#450a0a",
                    color: "#fca5a5",
                    borderLeftColor: "#dc2626",
                  }}
                >
                  {guidance}
                </div>
              )}

              {/* Expanded detail view */}
              {isExpanded && (
                <div data-testid="account-detail" className="mt-3 pt-3 border-t border-border">
                  {/* Token info */}
                  <div className="mb-3">
                    <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">
                      Token Status
                    </h3>
                    <span data-testid="token-expiry" className="text-foreground text-sm">
                      {formatTokenExpiry(account.token_expires_at)}
                    </span>
                  </div>

                  {/* Sync history */}
                  <div className="mb-3">
                    <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">
                      Sync History
                    </h3>
                    {historyLoading ? (
                      <p className="text-muted-foreground text-center py-4">Loading history...</p>
                    ) : syncHistory ? (
                      <div data-testid="sync-history">
                        {syncHistory.events.map((event) => (
                          <div
                            key={event.id}
                            data-testid="sync-history-entry"
                            className="flex items-center gap-2 py-1 text-xs"
                          >
                            <span
                              data-testid="sync-entry-status"
                              data-status={event.status}
                              className="text-[0.7rem]"
                              style={{
                                color:
                                  event.status === "success"
                                    ? "#16a34a"
                                    : "#dc2626",
                              }}
                            >
                              {event.status === "success" ? "\u25CF" : "\u2716"}
                            </span>
                            <span className="text-muted-foreground min-w-[60px]">
                              {formatRelativeTime(event.timestamp)}
                            </span>
                            <span className="text-foreground">
                              {event.event_count} events
                            </span>
                            {event.error_message && (
                              <span className="text-destructive text-xs italic">
                                {event.error_message}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-muted-foreground text-center py-4">No history available</p>
                    )}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}

      {/* Remove confirmation dialog */}
      {removeTarget && (
        <div
          data-testid="remove-dialog"
          className="fixed inset-0 bg-black/60 flex items-center justify-center z-[1000]"
          role="dialog"
          aria-modal="true"
          aria-label="Confirm remove account"
        >
          <Card className="max-w-[420px] w-[90%] p-6">
            <h2 className="text-lg font-bold text-foreground mb-3">Remove Account</h2>
            <p className="text-foreground text-sm mb-2">
              Are you sure you want to disconnect{" "}
              <strong>{removeTarget.email}</strong>?
            </p>
            <p className="text-yellow-400 text-xs mb-4">
              This will stop syncing events, revoke tokens, and clean up all
              stored credentials for this account.
            </p>
            <div className="flex justify-end gap-2">
              <Button
                data-testid="remove-cancel"
                onClick={handleRemoveCancel}
                variant="outline"
                disabled={removing}
              >
                Cancel
              </Button>
              <Button
                data-testid="remove-confirm"
                onClick={handleRemoveConfirm}
                variant="destructive"
                disabled={removing}
              >
                {removing ? "Removing..." : "Remove"}
              </Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
