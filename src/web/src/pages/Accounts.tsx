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
 * - Calendar scope management per account
 * - Loading, error, and empty states
 * - OAuth callback handling (shows success message on return)
 *
 * Uses useApi() for token-injected API calls and useAuth() for user context.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { useAuth } from "../lib/auth";
import { useApi } from "../lib/api-provider";
import type {
  LinkedAccount,
  AccountProvider,
  CalendarScope,
  ScopeUpdateItem,
} from "../lib/api";
import {
  buildOAuthStartUrl,
  navigateToOAuth,
  statusLabel,
  providerLabel,
} from "../lib/accounts";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Accounts() {
  const { user } = useAuth();
  const api = useApi();

  const currentUserId = user?.id ?? "";

  const [accounts, setAccounts] = useState<LinkedAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unlinkTarget, setUnlinkTarget] = useState<LinkedAccount | null>(null);
  const [unlinking, setUnlinking] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  // Scope management state
  const [scopeTarget, setScopeTarget] = useState<LinkedAccount | null>(null);
  const [scopes, setScopes] = useState<CalendarScope[]>([]);
  const [scopeLoading, setScopeLoading] = useState(false);
  const [scopeSaving, setScopeSaving] = useState(false);
  const [pendingScopeChanges, setPendingScopeChanges] = useState<Map<string, ScopeUpdateItem>>(
    new Map(),
  );

  // Federation settings state
  const [cascadeToOrigin, setCascadeToOrigin] = useState(false);
  const [cascadeLoading, setCascadeLoading] = useState(true);
  const [cascadeSaving, setCascadeSaving] = useState(false);

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
      const data = await api.fetchAccounts();
      if (!mountedRef.current) return;
      setAccounts(data);
      setError(null);
      setLoading(false);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : "Unknown error");
      setLoading(false);
    }
  }, [api]);

  // Load cascade_to_origin setting
  useEffect(() => {
    let cancelled = false;
    api.fetchSetting("cascade_to_origin").then((res) => {
      if (!cancelled) {
        setCascadeToOrigin(res.value === "true");
        setCascadeLoading(false);
      }
    }).catch(() => {
      if (!cancelled) setCascadeLoading(false);
    });
    return () => { cancelled = true; };
  }, [api]);

  const handleCascadeToggle = useCallback(async () => {
    const newValue = !cascadeToOrigin;
    setCascadeSaving(true);
    try {
      await api.updateSetting("cascade_to_origin", newValue ? "true" : "false");
      if (!mountedRef.current) return;
      setCascadeToOrigin(newValue);
      showStatus("success", newValue
        ? "Origin cascade enabled -- deletes will propagate to source events."
        : "Origin cascade disabled -- only managed mirrors will be deleted.");
    } catch (err) {
      if (!mountedRef.current) return;
      showStatus("error", `Failed to save setting: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      if (mountedRef.current) setCascadeSaving(false);
    }
  }, [cascadeToOrigin, api, showStatus]);

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
    [currentUserId, showStatus],
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
      await api.unlinkAccount(unlinkTarget.account_id);
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
  }, [unlinkTarget, api, showStatus]);

  // -- Scope management handlers --

  const handleManageScopes = useCallback(
    async (account: LinkedAccount) => {
      setScopeTarget(account);
      setScopeLoading(true);
      setPendingScopeChanges(new Map());
      try {
        const data = await api.fetchScopes(account.account_id);
        if (!mountedRef.current) return;
        setScopes(data.scopes);
      } catch (err) {
        if (!mountedRef.current) return;
        showStatus(
          "error",
          `Failed to load scopes: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
        setScopeTarget(null);
      } finally {
        if (mountedRef.current) setScopeLoading(false);
      }
    },
    [api, showStatus],
  );

  const handleScopeToggle = useCallback(
    (providerCalendarId: string, field: "enabled" | "sync_enabled", value: boolean) => {
      setPendingScopeChanges((prev) => {
        const next = new Map(prev);
        const existing = next.get(providerCalendarId) ?? { provider_calendar_id: providerCalendarId };
        next.set(providerCalendarId, { ...existing, [field]: value });
        return next;
      });
      // Also update the visual state immediately
      setScopes((prev) =>
        prev.map((s) =>
          s.provider_calendar_id === providerCalendarId
            ? { ...s, [field]: value }
            : s,
        ),
      );
    },
    [],
  );

  const handleScopePreset = useCallback(
    (preset: "primary_only" | "all_writable") => {
      if (scopes.length === 0) return;

      if (preset === "primary_only") {
        const writableScopes = scopes.filter((scope) =>
          scope.capabilities.includes("write"),
        );
        const selected =
          writableScopes.find((scope) => scope.calendar_role === "primary") ??
          writableScopes.find((scope) => scope.recommended) ??
          writableScopes[0];

        if (!selected) {
          showStatus("error", "No writable calendars are available for sync.");
          return;
        }

        for (const scope of scopes) {
          const shouldSync = scope.provider_calendar_id === selected.provider_calendar_id;
          if (scope.sync_enabled !== shouldSync) {
            handleScopeToggle(scope.provider_calendar_id, "sync_enabled", shouldSync);
          }
        }
        return;
      }

      for (const scope of scopes) {
        const shouldSync = scope.capabilities.includes("write");
        if (scope.sync_enabled !== shouldSync) {
          handleScopeToggle(scope.provider_calendar_id, "sync_enabled", shouldSync);
        }
      }
    },
    [scopes, handleScopeToggle, showStatus],
  );

  const handleScopesSave = useCallback(async () => {
    if (!scopeTarget || pendingScopeChanges.size === 0) return;
    setScopeSaving(true);
    try {
      const changes = Array.from(pendingScopeChanges.values());
      const data = await api.updateScopes(scopeTarget.account_id, changes);
      if (!mountedRef.current) return;
      setScopes(data.scopes);
      setPendingScopeChanges(new Map());
      showStatus("success", "Calendar scopes updated.");
    } catch (err) {
      if (!mountedRef.current) return;
      showStatus(
        "error",
        `Failed to save scopes: ${err instanceof Error ? err.message : "Unknown error"}`,
      );
    } finally {
      if (mountedRef.current) setScopeSaving(false);
    }
  }, [api, scopeTarget, pendingScopeChanges, showStatus]);

  const handleScopesClose = useCallback(() => {
    setScopeTarget(null);
    setScopes([]);
    setPendingScopeChanges(new Map());
  }, []);

  // -- Loading state --
  if (loading) {
    return (
      <div data-testid="accounts-loading" className="mx-auto max-w-[1200px]">
        <h1 className="text-2xl font-bold text-foreground mb-4">Accounts</h1>
        <p className="text-muted-foreground text-center py-8">Loading accounts...</p>
      </div>
    );
  }

  // -- Error state --
  if (error) {
    return (
      <div data-testid="accounts-error" className="mx-auto max-w-[1200px]">
        <h1 className="text-2xl font-bold text-foreground mb-4">Accounts</h1>
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

  // -- Normal state --
  return (
    <div className="mx-auto max-w-[1200px]">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold text-foreground">Accounts</h1>
      </div>

      {/* Status message */}
      {statusMsg && (
        <div
          data-testid="accounts-status"
          data-status-type={statusMsg.type}
          className={`px-4 py-2 rounded-md text-sm font-medium mb-4 ${
            statusMsg.type === "success"
              ? "bg-success/10 text-success border border-success/40"
              : "bg-destructive/10 text-destructive border border-destructive/40"
          }`}
        >
          {statusMsg.text}
        </div>
      )}

      {/* Link account buttons */}
      <div className="flex items-center gap-3 mb-6 flex-wrap" data-testid="link-account-section">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Link new account:</span>
        <Button
          data-testid="link-google"
          onClick={() => handleLinkAccount("google")}
          variant="default"
          size="sm"
        >
          Link Google Account
        </Button>
        <Button
          data-testid="link-microsoft"
          onClick={() => handleLinkAccount("microsoft")}
          variant="default"
          size="sm"
        >
          Link Microsoft Account
        </Button>
      </div>

      {/* Account list */}
      {accounts.length === 0 ? (
        <div className="text-muted-foreground text-center py-8" data-testid="accounts-empty">
          No accounts linked yet. Link a Google or Microsoft account to get
          started.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse" data-testid="accounts-table">
            <thead>
              <tr>
                <th className="text-left px-3 py-2 border-b border-border text-[11px] font-semibold uppercase tracking-wider text-muted-foreground whitespace-nowrap">Status</th>
                <th className="text-left px-3 py-2 border-b border-border text-[11px] font-semibold uppercase tracking-wider text-muted-foreground whitespace-nowrap">Email</th>
                <th className="text-left px-3 py-2 border-b border-border text-[11px] font-semibold uppercase tracking-wider text-muted-foreground whitespace-nowrap">Provider</th>
                <th className="text-left px-3 py-2 border-b border-border text-[11px] font-semibold uppercase tracking-wider text-muted-foreground whitespace-nowrap">Actions</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((account) => (
                <tr
                  key={account.account_id}
                  data-testid={`account-row-${account.account_id}`}
                  className="border-b border-border/50 bg-card"
                >
                  <td className="px-3 py-2 whitespace-nowrap">
                    <span className="inline-flex items-center gap-2">
                      <span
                        data-testid="account-status-indicator"
                        data-status={account.status}
                        title={statusLabel(account.status)}
                        className={`inline-block h-2 w-2 rounded-full animate-glow ${
                          account.status === "active"
                            ? "bg-success text-success"
                            : account.status === "pending"
                              ? "bg-warning text-warning"
                              : account.status === "error"
                                ? "bg-destructive text-destructive"
                                : "bg-muted-foreground text-muted-foreground"
                        }`}
                      />
                      <span
                        data-testid="account-status-label"
                        className="text-xs text-muted-foreground"
                      >
                        {statusLabel(account.status)}
                      </span>
                    </span>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap font-mono text-xs text-muted-foreground" data-testid="account-email">
                    {account.email}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap" data-testid="account-provider">
                    <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {providerLabel(account.provider)}
                    </span>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <Button
                      data-testid={`scopes-btn-${account.account_id}`}
                      onClick={() => handleManageScopes(account)}
                      variant="outline"
                      size="sm"
                      className="mr-2 h-8 text-xs"
                    >
                      Scopes
                    </Button>
                    <Button
                      data-testid={`unlink-btn-${account.account_id}`}
                      onClick={() => handleUnlinkClick(account)}
                      variant="outline"
                      size="sm"
                      className="border-destructive text-destructive hover:bg-destructive/10 h-8 text-xs"
                    >
                      Unlink
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Federation settings */}
      <Card className="mt-6" data-testid="federation-settings">
        <CardHeader>
          <CardTitle className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Federation Settings</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <label
            className="flex items-center gap-3 cursor-pointer"
            data-testid="cascade-to-origin-toggle"
          >
            <input
              type="checkbox"
              checked={cascadeToOrigin}
              disabled={cascadeLoading || cascadeSaving}
              onChange={handleCascadeToggle}
              className="h-4 w-4 rounded border-border accent-primary"
            />
            <div className="flex flex-col">
              <span className="text-sm font-medium text-foreground">
                Cascade deletes to origin events
                {cascadeSaving && <span className="ml-2 text-xs text-muted-foreground">(saving...)</span>}
              </span>
              <span className="text-xs text-muted-foreground">
                When enabled, deleting an event in T-Minus also deletes the original
                event in the source calendar. When disabled, only managed mirror copies
                are removed.
              </span>
            </div>
          </label>
        </CardContent>
      </Card>

      {/* Unlink confirmation dialog */}
      {unlinkTarget && (
        <div
          data-testid="unlink-dialog"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          role="dialog"
          aria-modal="true"
          aria-label="Confirm unlink account"
        >
          <Card className="w-[90%] max-w-[420px]">
            <CardHeader>
              <CardTitle className="text-lg">Unlink Account</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-foreground">
                Are you sure you want to unlink{" "}
                <strong>{unlinkTarget.email}</strong> (
                {providerLabel(unlinkTarget.provider)})?
              </p>
              <p className="text-xs text-warning">
                This will stop syncing events for this account. Existing mirrored
                events will remain but no longer update.
              </p>
              <div className="flex justify-end gap-2 pt-2">
                <Button
                  data-testid="unlink-cancel"
                  onClick={handleUnlinkCancel}
                  variant="outline"
                  size="sm"
                  disabled={unlinking}
                >
                  Cancel
                </Button>
                <Button
                  data-testid="unlink-confirm"
                  onClick={handleUnlinkConfirm}
                  variant="destructive"
                  size="sm"
                  disabled={unlinking}
                >
                  {unlinking ? "Unlinking..." : "Unlink"}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Calendar scope management dialog */}
      {scopeTarget && (
        <div
          data-testid="scopes-dialog"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          role="dialog"
          aria-modal="true"
          aria-label="Manage calendar scopes"
        >
          <Card className="w-[90%] max-w-[560px]">
            <CardHeader>
              <CardTitle className="text-lg">
                Calendar Scopes -- {scopeTarget.email}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-foreground">
                Select which calendars to include in synchronization.
                Recommended calendars are marked below. Defaults use one
                calendar; scope tuning is optional and you can opt into more
                at any time.
              </p>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  data-testid="scopes-preset-primary-only"
                  variant="outline"
                  size="sm"
                  disabled={scopeLoading || scopeSaving || scopes.length === 0}
                  onClick={() => handleScopePreset("primary_only")}
                >
                  Recommended Only (1)
                </Button>
                <Button
                  data-testid="scopes-preset-all-writable"
                  variant="outline"
                  size="sm"
                  disabled={scopeLoading || scopeSaving || scopes.length === 0}
                  onClick={() => handleScopePreset("all_writable")}
                >
                  Enable All Writable
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Presets stage changes locally. Click Save Changes to apply.
              </p>

              {scopeLoading ? (
                <div className="text-muted-foreground text-center py-8" data-testid="scopes-loading">
                  Loading calendars...
                </div>
              ) : scopes.length === 0 ? (
                <div className="text-muted-foreground text-center py-8" data-testid="scopes-empty">
                  No calendars found for this account.
                </div>
              ) : (
                <div data-testid="scopes-list" className="mb-4">
                  {scopes.map((scope) => (
                    <div
                      key={scope.scope_id}
                      data-testid={`scope-row-${scope.provider_calendar_id}`}
                      className="flex items-center justify-between px-3 py-2 border-b border-border/50"
                    >
                      <div className="flex flex-col gap-0.5 flex-1">
                        <span className="font-mono text-xs text-foreground">
                          {scope.display_name || scope.provider_calendar_id}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {scope.access_level}
                          {scope.recommended ? " (recommended)" : ""}
                          {" -- "}
                          {scope.capabilities.join(", ")}
                        </span>
                      </div>
                      <div className="flex items-center gap-4">
                        <label className="text-muted-foreground text-xs flex items-center gap-1 cursor-pointer">
                          <input
                            type="checkbox"
                            data-testid={`scope-enabled-${scope.provider_calendar_id}`}
                            checked={scope.enabled}
                            onChange={(e) =>
                              handleScopeToggle(
                                scope.provider_calendar_id,
                                "enabled",
                                e.target.checked,
                              )
                            }
                          />
                          Enabled
                        </label>
                        <label className="text-muted-foreground text-xs flex items-center gap-1 cursor-pointer">
                          <input
                            type="checkbox"
                            data-testid={`scope-sync-${scope.provider_calendar_id}`}
                            checked={scope.sync_enabled}
                            disabled={!scope.capabilities.includes("write") && !scope.sync_enabled}
                            title={
                              scope.capabilities.includes("write")
                                ? "Enable sync for this calendar"
                                : scope.sync_enabled
                                  ? "Read-only calendar: you can disable sync, but cannot re-enable it here"
                                  : "Sync requires write capability"
                            }
                            onChange={(e) =>
                              handleScopeToggle(
                                scope.provider_calendar_id,
                                "sync_enabled",
                                e.target.checked,
                              )
                            }
                          />
                          Sync
                        </label>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <Button
                  data-testid="scopes-cancel"
                  onClick={handleScopesClose}
                  variant="outline"
                  size="sm"
                  disabled={scopeSaving}
                >
                  {pendingScopeChanges.size === 0 ? "Close" : "Cancel"}
                </Button>
                {pendingScopeChanges.size > 0 && (
                  <Button
                    data-testid="scopes-save"
                    onClick={handleScopesSave}
                    variant="default"
                    size="sm"
                    disabled={scopeSaving}
                  >
                    {scopeSaving ? "Saving..." : "Save Changes"}
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
