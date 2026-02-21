/**
 * Consumer-grade Onboarding page.
 *
 * Guides non-technical users through connecting their calendar accounts.
 * This is the first thing a new user sees -- it must feel as simple as
 * signing up for any modern SaaS product.
 *
 * Flow:
 * 1. Welcome screen with three provider cards (Google, Microsoft, Apple)
 * 2. Google/Microsoft: click -> OAuth consent -> auto-return -> success
 * 3. Apple: click -> guided modal for app-specific password -> submit -> success
 * 4. After each connection: show account card with email, calendar count, sync status
 * 5. "Add another account" loops back to provider selection
 * 6. "Done" shows completion screen with summary and link to calendar view
 *
 * State machine:
 *   idle -> connecting (OAuth redirect) -> syncing -> complete
 *   idle -> apple-modal -> syncing -> complete
 *   complete -> idle (add another) -> ...
 *   complete -> finished (done)
 *   any -> error -> idle (try again)
 *
 * Design principles:
 * - Zero jargon: "Connect your calendar" not "Authorize OAuth scope"
 * - Progressive disclosure: show only what's needed at each step
 * - Instant feedback: loading states, success indicators, inline errors
 * - Recoverable: every error has a "Try again" or "Get help" action
 * - Provider-specific branding: deterministic colors per retro learning
 *
 * Uses useApi() and useAuth() for token-injected API calls and user context.
 * Uses useOnboardingCallbackId() for OAuth callback account ID extraction.
 * Renders outside AppShell (full-page layout) with its own styling.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { useApi } from "../lib/api-provider";
import { useAuth } from "../lib/auth";
import { useOnboardingCallbackId } from "../lib/route-helpers";
import {
  buildOnboardingOAuthUrl,
  isSyncComplete,
  isValidAppleAppPassword,
  isOAuthProvider,
  SYNC_POLL_INTERVAL_MS,
  PROVIDERS,
  PROVIDER_COLORS,
  PROVIDER_ICONS,
  APPLE_ID_SETTINGS_URL,
  type OnboardingSyncStatus,
  type ConnectedAccount,
} from "../lib/onboarding";
import {
  SESSION_POLL_INTERVAL_MS,
  type OnboardingSession,
} from "../lib/onboarding-session";
import {
  classifyOAuthError,
  createErrorTelemetryEvent,
  OnboardingError,
  type ClassifiedError,
  type ErrorTelemetryEvent,
} from "../lib/onboarding-errors";
import type { AccountProvider } from "../lib/api";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal event shape for display in the onboarding success state. */
export interface OnboardingEvent {
  canonical_event_id: string;
  summary?: string;
  start: string;
  end: string;
}

/** Props kept minimal -- only for testing overrides, not API injection. */
export interface OnboardingProps {
  /** Override the navigate function (for testing, prevents actual navigation). */
  navigateToOAuth?: (url: string) => void;
  /** Override the OAuth base URL (for local dev/testing). */
  oauthBaseUrl?: string;
  /** Callback error from OAuth redirect (e.g., "access_denied"). */
  callbackError?: string;
  /** Provider that produced the callback error. */
  callbackProvider?: AccountProvider;
  /** Callback for error telemetry events. */
  onErrorTelemetry?: (event: ErrorTelemetryEvent) => void;
}

/** Page-level view state (extends OnboardingState with multi-account views). */
type ViewState =
  | "idle"         // Showing provider cards
  | "connecting"   // OAuth redirect in progress
  | "apple-modal"  // Apple credential modal open
  | "syncing"      // Polling sync status for current account
  | "complete"     // Current account connected, showing success
  | "error"        // Error state with try again
  | "finished";    // All done, showing completion screen

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Onboarding({
  navigateToOAuth = (url) => {
    window.location.assign(url);
  },
  oauthBaseUrl = "https://oauth.tminus.ink",
  callbackError,
  callbackProvider,
  onErrorTelemetry,
}: OnboardingProps = {}) {
  const api = useApi();
  const { user } = useAuth();
  const callbackAccountId = useOnboardingCallbackId();

  // Guard: user must be authenticated (RequireAuth should handle this, but be safe)
  if (!user) return null;

  return (
    <OnboardingInner
      user={user}
      navigateToOAuth={navigateToOAuth}
      oauthBaseUrl={oauthBaseUrl}
      callbackAccountId={callbackAccountId}
      callbackError={callbackError}
      callbackProvider={callbackProvider}
      onErrorTelemetry={onErrorTelemetry}
    />
  );
}

// ---------------------------------------------------------------------------
// Inner component (after guards, receives user directly)
// ---------------------------------------------------------------------------

function OnboardingInner({
  user,
  navigateToOAuth,
  oauthBaseUrl,
  callbackAccountId,
  callbackError,
  callbackProvider,
  onErrorTelemetry,
}: {
  user: { id: string; email: string };
  navigateToOAuth: (url: string) => void;
  oauthBaseUrl: string;
  callbackAccountId: string | null;
  callbackError?: string;
  callbackProvider?: AccountProvider;
  onErrorTelemetry?: (event: ErrorTelemetryEvent) => void;
}) {
  const api = useApi();

  // View state management
  // If returning from OAuth with an error, go straight to error state
  const [viewState, setViewState] = useState<ViewState>(
    callbackError ? "error" : callbackAccountId ? "syncing" : "idle",
  );

  // Connected accounts list
  const [connectedAccounts, setConnectedAccounts] = useState<ConnectedAccount[]>([]);

  // Current sync state
  const [syncStatus, setSyncStatus] = useState<OnboardingSyncStatus | null>(null);
  const [currentAccountId, setCurrentAccountId] = useState<string | null>(
    callbackAccountId,
  );
  const [events, setEvents] = useState<OnboardingEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Classified error from error recovery system (TM-2o2.6)
  const [classifiedError, setClassifiedError] = useState<ClassifiedError | null>(
    callbackError && callbackProvider
      ? classifyOAuthError(callbackError, callbackProvider)
      : null,
  );
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const syncCompleteRef = useRef(false);
  // Consecutive failure counter for transient error auto-retry (TM-2o2.6 AC 4)
  const consecutiveFailuresRef = useRef(0);

  // Apple modal state
  const [appleEmail, setAppleEmail] = useState("");
  const [applePassword, setApplePassword] = useState("");
  const [appleError, setAppleError] = useState<string | null>(null);
  const [appleSubmitting, setAppleSubmitting] = useState(false);

  // Session management state
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  const sessionPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // -------------------------------------------------------------------------
  // Error telemetry for callback errors (TM-2o2.6 AC 6)
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (classifiedError && onErrorTelemetry) {
      const telemetry = createErrorTelemetryEvent(classifiedError);
      onErrorTelemetry(telemetry);
    }
  // Fire only once on mount when callback error is present
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -------------------------------------------------------------------------
  // Session initialization and resume (AC 1, AC 2)
  // -------------------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const session = await api.getOnboardingSession();
        if (cancelled) return;

        if (session) {
          setSessionId(session.session_id);

          // Resume: restore connected accounts
          if (session.accounts.length > 0 && session.step !== "complete") {
            const restored: ConnectedAccount[] = session.accounts.map((a) => ({
              account_id: a.account_id,
              email: a.email,
              provider: a.provider as AccountProvider,
              calendar_count: a.calendar_count ?? 0,
              sync_state: a.status === "connected" ? "synced" as const : a.status === "error" ? "error" as const : "syncing" as const,
            }));
            setConnectedAccounts(restored);
            // If not returning from OAuth, show idle (provider selection) so user can add more
            if (!callbackAccountId) {
              setViewState("idle");
            }
          } else if (session.step === "complete") {
            // Session already complete, redirect to calendar
            setViewState("finished");
          }
        } else if (!callbackAccountId) {
          // No existing session -- create one
          try {
            const newSession = await api.createOnboardingSession();
            if (!cancelled) {
              setSessionId(newSession.session_id);
            }
          } catch {
            // Non-fatal: session creation failure doesn't block onboarding
          }
        }
      } catch {
        // Non-fatal: session fetch failure doesn't block onboarding
      }
    })();

    return () => {
      cancelled = true;
    };
  // Run only on mount
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -------------------------------------------------------------------------
  // Cross-tab polling (AC 5)
  // -------------------------------------------------------------------------

  useEffect(() => {
    // Only poll when in idle/connecting states where another tab might add accounts
    if (viewState !== "idle" && viewState !== "connecting") return;

    sessionPollRef.current = setInterval(async () => {
      try {
        const session = await api.getOnboardingSession();
        if (!session) return;

        // Update connected accounts from server state
        if (session.accounts.length > connectedAccounts.length) {
          const restored: ConnectedAccount[] = session.accounts.map((a) => ({
            account_id: a.account_id,
            email: a.email,
            provider: a.provider as AccountProvider,
            calendar_count: a.calendar_count ?? 0,
            sync_state: a.status === "connected" ? "synced" as const : a.status === "error" ? "error" as const : "syncing" as const,
          }));
          setConnectedAccounts(restored);
        }

        // If another tab completed the session, reflect it
        if (session.step === "complete") {
          setViewState("finished");
        }
      } catch {
        // Non-fatal: polling failure is transient
      }
    }, SESSION_POLL_INTERVAL_MS);

    return () => {
      if (sessionPollRef.current) {
        clearInterval(sessionPollRef.current);
        sessionPollRef.current = null;
      }
    };
  }, [api, viewState, connectedAccounts.length]);

  // -------------------------------------------------------------------------
  // OAuth initiation (Google/Microsoft)
  // -------------------------------------------------------------------------

  const handleConnectOAuth = useCallback(
    (provider: AccountProvider) => {
      setViewState("connecting");
      const redirectUri = `${window.location.origin}${window.location.pathname}#/onboard`;
      // AC 3: Include session ID in OAuth URL for post-callback correlation
      const url = buildOnboardingOAuthUrl(provider, user.id, redirectUri, oauthBaseUrl, sessionId);
      navigateToOAuth(url);
    },
    [user.id, navigateToOAuth, oauthBaseUrl, sessionId],
  );

  // -------------------------------------------------------------------------
  // Apple credential submission
  // -------------------------------------------------------------------------

  const handleAppleSubmit = useCallback(async () => {
    // Validate
    if (!appleEmail.trim()) {
      setAppleError("Please enter your Apple ID email");
      return;
    }
    if (!isValidAppleAppPassword(applePassword)) {
      setAppleError(
        "Invalid password format. App-specific passwords are 16 letters in the format xxxx-xxxx-xxxx-xxxx",
      );
      return;
    }

    setAppleError(null);
    setAppleSubmitting(true);

    try {
      const result = await api.submitAppleCredentials(
        user.id,
        appleEmail,
        applePassword,
      );
      setCurrentAccountId(result.account_id);
      syncCompleteRef.current = false;
      setViewState("syncing");
    } catch (err) {
      // Use classified error message if available (OnboardingError)
      if (err instanceof OnboardingError) {
        setAppleError(err.classified.message);
        if (onErrorTelemetry) {
          onErrorTelemetry(createErrorTelemetryEvent(err.classified));
        }
      } else {
        setAppleError(
          err instanceof Error ? err.message : "Something went wrong",
        );
      }
    } finally {
      setAppleSubmitting(false);
    }
  }, [appleEmail, applePassword, api, user.id, onErrorTelemetry]);

  // -------------------------------------------------------------------------
  // Sync status polling
  // -------------------------------------------------------------------------

  const pollStatus = useCallback(
    async (accountId: string) => {
      try {
        const status = await api.fetchAccountStatus(accountId);
        // Success: reset consecutive failure counter
        consecutiveFailuresRef.current = 0;
        setSyncStatus(status);

        if (isSyncComplete(status)) {
          syncCompleteRef.current = true;

          // Add to connected accounts
          const connected: ConnectedAccount = {
            account_id: status.account_id,
            email: status.email,
            provider: status.provider,
            calendar_count: status.calendar_count ?? 0,
            sync_state: "synced",
          };
          setConnectedAccounts((prev) => {
            // Avoid duplicates (BR-4: idempotent)
            if (prev.some((a) => a.account_id === connected.account_id)) {
              return prev.map((a) =>
                a.account_id === connected.account_id ? connected : a,
              );
            }
            return [...prev, connected];
          });

          // Notify server session of the connected account (best-effort)
          api.addOnboardingAccount({
            account_id: status.account_id,
            provider: status.provider,
            email: status.email,
            calendar_count: status.calendar_count,
          }).catch(() => {
            // Non-fatal: server session update failure doesn't block UI
          });

          setViewState("complete");

          // Stop polling
          if (pollingRef.current) {
            clearInterval(pollingRef.current);
            pollingRef.current = null;
          }

          // Fetch events to display
          try {
            const evts = await api.fetchEventsForOnboarding();
            setEvents(evts as unknown as OnboardingEvent[]);
          } catch {
            // Non-fatal: events display is nice-to-have
          }
        }
      } catch (err) {
        consecutiveFailuresRef.current += 1;

        // TM-2o2.6 AC 4: Transient errors auto-retry silently up to 3 times.
        // Only OnboardingError with transient severity triggers silent retry.
        // Plain errors surface immediately for backward compatibility.
        const isTransient = err instanceof OnboardingError
          && err.classified.severity === "transient";

        if (isTransient && consecutiveFailuresRef.current <= 3) {
          // Silent retry: let the polling interval handle the next attempt
          return;
        }

        // All retries exhausted or persistent/unclassified error: surface to user
        if (err instanceof OnboardingError) {
          setClassifiedError(err.classified);
          setError(err.classified.message);
          if (onErrorTelemetry) {
            onErrorTelemetry(createErrorTelemetryEvent(err.classified, {
              retry_count: consecutiveFailuresRef.current - 1,
              recovered: false,
            }));
          }
        } else {
          const errorMessage = err instanceof Error ? err.message : "Something went wrong";
          setError(errorMessage);
          if (onErrorTelemetry) {
            onErrorTelemetry(createErrorTelemetryEvent(
              {
                code: "sync_polling_failure",
                message: errorMessage,
                severity: "persistent",
                recovery_action: "try_again",
                recovery_label: "Try again",
                provider: "google",
              },
              {
                retry_count: consecutiveFailuresRef.current - 1,
                recovered: false,
              },
            ));
          }
        }
        setViewState("error");

        // Stop polling on error
        if (pollingRef.current) {
          clearInterval(pollingRef.current);
          pollingRef.current = null;
        }
      }
    },
    [api, onErrorTelemetry],
  );

  // Start polling when we have an account to sync
  useEffect(() => {
    if (!currentAccountId) return;
    if (syncCompleteRef.current) return;
    if (viewState !== "syncing") return;

    // Initial poll immediately
    pollStatus(currentAccountId);

    // Set up interval polling
    pollingRef.current = setInterval(() => {
      if (!syncCompleteRef.current) {
        pollStatus(currentAccountId);
      }
    }, SYNC_POLL_INTERVAL_MS);

    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    };
  }, [currentAccountId, pollStatus, viewState]);

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  const handleAddAnother = useCallback(() => {
    setSyncStatus(null);
    setCurrentAccountId(null);
    syncCompleteRef.current = false;
    setError(null);
    setAppleEmail("");
    setApplePassword("");
    setAppleError(null);
    setViewState("idle");
  }, []);

  const handleDone = useCallback(() => {
    setViewState("finished");
    // AC 6: Mark session complete on explicit user action
    api.completeOnboardingSession().catch(() => {
      // Non-fatal: server completion failure doesn't block UI transition
    });
  }, [api]);

  const handleRetry = useCallback(() => {
    setError(null);
    setClassifiedError(null);
    setSyncStatus(null);
    setCurrentAccountId(null);
    syncCompleteRef.current = false;
    consecutiveFailuresRef.current = 0;
    setViewState("idle");
  }, []);

  const handleProviderClick = useCallback(
    (provider: AccountProvider) => {
      if (isOAuthProvider(provider)) {
        handleConnectOAuth(provider);
      } else {
        setViewState("apple-modal");
        setAppleEmail("");
        setApplePassword("");
        setAppleError(null);
      }
    },
    [handleConnectOAuth],
  );

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div
      className="max-w-[600px] w-full mx-auto px-4 py-6 font-sans box-border"
      data-testid="onboarding-container"
    >
      {/* Branding */}
      <div className="text-center mb-8">
        <div className="text-2xl font-bold tracking-tight text-[#1a1a2e]">T-Minus</div>
        <h1 className="text-3xl font-semibold text-[#1a1a2e] my-2">Connect Your Calendar</h1>
        <p className="text-slate-500 text-base m-0">
          Link your calendar accounts to get started with intelligent scheduling
        </p>
      </div>

      {/* Connected accounts summary (shown in multi-account flow) */}
      {connectedAccounts.length > 0 && viewState !== "finished" && (
        <div className="mb-6">
          {connectedAccounts.map((account) => (
            <div
              key={account.account_id}
              className="flex items-center gap-3 p-4 border border-slate-200 rounded-xl bg-white mb-3"
              style={{ borderLeft: `4px solid ${PROVIDER_COLORS[account.provider]}` }}
              data-testid={`connected-account-${account.account_id}`}
            >
              <div
                className="text-2xl font-bold w-10 h-10 flex items-center justify-center rounded-lg shrink-0"
                style={{
                  color: PROVIDER_COLORS[account.provider],
                  backgroundColor: `${PROVIDER_COLORS[account.provider]}15`,
                }}
              >
                {PROVIDER_ICONS[account.provider]}
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold">
                  {"\u2713"} {account.email}
                </div>
                <div className="text-sm text-slate-500">
                  {account.calendar_count}{" "}
                  {account.calendar_count === 1 ? "calendar" : "calendars"}{" "}
                  {"\u00B7"}{" "}
                  <span
                    className={
                      account.sync_state === "synced"
                        ? "text-green-600"
                        : account.sync_state === "error"
                          ? "text-red-600"
                          : "text-yellow-600"
                    }
                  >
                    {account.sync_state === "synced"
                      ? "Synced"
                      : account.sync_state === "error"
                        ? "Error"
                        : "Syncing..."}
                  </span>
                </div>
              </div>
            </div>
          ))}
          {viewState === "idle" && (
            <div className="text-center text-slate-500 text-sm mb-4">
              {connectedAccounts.length}{" "}
              {connectedAccounts.length === 1 ? "account" : "accounts"}{" "}
              connected
            </div>
          )}
        </div>
      )}

      {/* State-dependent content */}
      {viewState === "idle" && renderProviderCards()}
      {viewState === "connecting" && renderConnecting()}
      {viewState === "syncing" && renderSyncing()}
      {viewState === "complete" && renderComplete()}
      {viewState === "error" && renderError()}
      {viewState === "apple-modal" && renderAppleModal()}
      {viewState === "finished" && renderFinished()}

      {/* Spinner keyframes */}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );

  // -------------------------------------------------------------------------
  // Render helpers
  // -------------------------------------------------------------------------

  function renderProviderCards() {
    return (
      <div
        className="flex flex-col gap-4"
        data-testid="provider-cards"
      >
        {PROVIDERS.map((provider) => (
          <button
            key={provider.id}
            onClick={() => handleProviderClick(provider.id)}
            className="flex items-center gap-3 px-6 py-4 border border-slate-200 rounded-xl bg-white cursor-pointer text-base w-full text-left transition-colors hover:border-slate-300"
            style={{ borderLeft: `4px solid ${PROVIDER_COLORS[provider.id]}` }}
            aria-label={`Connect ${provider.label}`}
            data-testid={`provider-card-${provider.id}`}
          >
            <div
              className="text-2xl font-bold w-10 h-10 flex items-center justify-center rounded-lg shrink-0"
              style={{
                color: PROVIDER_COLORS[provider.id],
                backgroundColor: `${PROVIDER_COLORS[provider.id]}15`,
              }}
              data-testid={`provider-icon-${provider.id}`}
            >
              {PROVIDER_ICONS[provider.id]}
            </div>
            <div className="flex-1 min-w-0">
              <div className="font-semibold">Connect {provider.label}</div>
              <div className="text-sm text-slate-500">
                {provider.description}
              </div>
            </div>
          </button>
        ))}
      </div>
    );
  }

  function renderConnecting() {
    return (
      <div className="text-center p-8">
        <div className="text-xl mb-4">
          Redirecting to your calendar provider...
        </div>
        <div className="text-slate-500">
          You will be asked to grant calendar access
        </div>
        <div
          className="w-10 h-10 border-[3px] border-slate-200 border-t-blue-600 rounded-full mx-auto mt-6"
          style={{ animation: "spin 1s linear infinite" }}
        />
      </div>
    );
  }

  function renderSyncing() {
    return (
      <div className="text-center p-8">
        <div className="text-xl mb-4 text-blue-600">
          Syncing your calendar...
        </div>
        {syncStatus && (
          <div className="text-slate-500 mb-4">
            Connected as {syncStatus.email}
          </div>
        )}
        <div
          className="w-10 h-10 border-[3px] border-slate-200 border-t-blue-600 rounded-full mx-auto"
          style={{ animation: "spin 1s linear infinite" }}
        />
      </div>
    );
  }

  function renderComplete() {
    return (
      <div>
        {/* Success banner */}
        <div className="text-center p-6 bg-green-50 rounded-xl mb-6">
          <div className="text-2xl text-green-600 mb-2">
            {"\u2713"} Connected
          </div>
          {syncStatus && (
            <>
              <div className="text-gray-700 font-medium">
                {syncStatus.email}
              </div>
              <div className="text-slate-500 text-sm mt-1">
                {syncStatus.calendar_count ?? 0}{" "}
                {(syncStatus.calendar_count ?? 0) === 1
                  ? "calendar"
                  : "calendars"}{" "}
                found {"\u00B7"}{" "}
                <span className="text-green-600">Synced</span>
              </div>
            </>
          )}
        </div>

        {/* Events list */}
        {events.length > 0 && (
          <div className="mb-6">
            <h2 className="text-lg font-semibold mb-3">
              Your upcoming events
            </h2>
            <div className="flex flex-col gap-2">
              {events.map((evt) => (
                <div
                  key={evt.canonical_event_id}
                  className="px-4 py-3 border border-slate-200 rounded-md bg-white"
                >
                  <div className="font-medium">
                    {evt.summary ?? "(No title)"}
                  </div>
                  <div className="text-sm text-slate-500">
                    {formatEventTime(evt.start)} -- {formatEventTime(evt.end)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Progress + actions */}
        <div className="text-center text-slate-500 text-sm mb-4">
          {connectedAccounts.length}{" "}
          {connectedAccounts.length === 1 ? "account" : "accounts"} connected
        </div>

        <div className="flex flex-col gap-3 items-center">
          <Button
            onClick={handleAddAnother}
            aria-label="Add another account"
          >
            Add Another Account
          </Button>
          <Button
            variant="outline"
            onClick={handleDone}
            aria-label="Finish onboarding"
          >
            I{"'"}m Done
          </Button>
        </div>
      </div>
    );
  }

  function renderError() {
    // Use classified error if available, otherwise fall back to generic
    const displayMessage = classifiedError
      ? classifiedError.message
      : error ?? "Something went wrong";
    const recoveryLabel = classifiedError
      ? classifiedError.recovery_label
      : "Try Again";

    return (
      <div className="text-center p-8 bg-red-50 rounded-xl">
        <div className="text-xl text-red-600 mb-2">
          {classifiedError ? displayMessage : "Something went wrong"}
        </div>
        {!classifiedError && error && (
          <div className="text-slate-500 mb-4">{error}</div>
        )}
        <Button
          variant="outline"
          onClick={handleRetry}
          aria-label={recoveryLabel}
        >
          {recoveryLabel}
        </Button>
      </div>
    );
  }

  function renderAppleModal() {
    return (
      <div
        className="fixed inset-0 bg-black/40 flex items-center justify-center z-[100] p-4"
        onClick={(e) => {
          if (e.target === e.currentTarget) {
            setViewState("idle");
          }
        }}
      >
        <div
          role="dialog"
          aria-label="Connect Apple Calendar"
          className="bg-white rounded-2xl p-8 max-w-[480px] w-full max-h-[90vh] overflow-auto"
        >
          <h2 className="text-xl font-semibold mb-4 mt-0">
            Connect Apple Calendar
          </h2>

          <p className="text-slate-500 mb-6">
            Apple Calendar uses an app-specific password instead of a
            sign-in button. Follow these steps:
          </p>

          {/* Instructions */}
          <div className="bg-slate-50 rounded-lg p-4 mb-6 text-sm">
            <ol className="m-0 pl-5 text-gray-700">
              <li className="mb-2">
                Go to your{" "}
                <a
                  href={APPLE_ID_SETTINGS_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Apple ID settings"
                  className="text-blue-600 hover:underline"
                >
                  Apple ID settings
                </a>
              </li>
              <li className="mb-2">
                Navigate to Sign-In and Security, then App-Specific Passwords
              </li>
              <li>
                Generate a new password and paste it below
              </li>
            </ol>
          </div>

          {/* Form */}
          <div className="mb-4">
            <label
              htmlFor="apple-email"
              className="block text-sm font-medium text-gray-700 mb-2"
            >
              Apple ID Email
            </label>
            <input
              id="apple-email"
              type="email"
              value={appleEmail}
              onChange={(e) => setAppleEmail(e.target.value)}
              placeholder="your@icloud.com"
              className="w-full px-3 py-3 border border-slate-200 rounded-lg text-base box-border mt-1"
              autoComplete="email"
            />
          </div>

          <div className="mb-4">
            <label
              htmlFor="apple-password"
              className="block text-sm font-medium text-gray-700 mb-2"
            >
              App-Specific Password
            </label>
            <input
              id="apple-password"
              type="password"
              value={applePassword}
              onChange={(e) => setApplePassword(e.target.value)}
              placeholder="xxxx-xxxx-xxxx-xxxx"
              className="w-full px-3 py-3 border border-slate-200 rounded-lg text-base box-border mt-1"
              autoComplete="off"
            />
          </div>

          {/* Validation/submission errors */}
          {appleError && (
            <div className="text-red-600 text-sm mt-1">
              {appleError}
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-3 justify-end mt-6">
            <Button
              variant="outline"
              onClick={() => setViewState("idle")}
              aria-label="Cancel"
            >
              Cancel
            </Button>
            <Button
              onClick={handleAppleSubmit}
              disabled={appleSubmitting}
              className={appleSubmitting ? "opacity-60" : ""}
              aria-label="Connect"
            >
              {appleSubmitting ? "Connecting..." : "Connect"}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  function renderFinished() {
    return (
      <div className="text-center py-8">
        <div className="text-4xl mb-2 text-green-600">
          {"\u2713"}
        </div>
        <h2 className="text-2xl font-semibold text-[#1a1a2e] mb-2">
          You{"'"}re All Set!
        </h2>
        <p className="text-slate-500 mb-8">
          Your calendars are connected and syncing. Here{"'"}s a summary:
        </p>

        {/* Account summary */}
        <div className="mb-8 text-left">
          {connectedAccounts.map((account) => (
            <div
              key={account.account_id}
              className="flex items-center gap-3 p-4 border border-slate-200 rounded-xl bg-white mb-3"
              style={{ borderLeft: `4px solid ${PROVIDER_COLORS[account.provider]}` }}
            >
              <div
                className="text-2xl font-bold w-10 h-10 flex items-center justify-center rounded-lg shrink-0"
                style={{
                  color: PROVIDER_COLORS[account.provider],
                  backgroundColor: `${PROVIDER_COLORS[account.provider]}15`,
                }}
              >
                {PROVIDER_ICONS[account.provider]}
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold">{account.email}</div>
                <div className="text-sm text-slate-500">
                  {account.calendar_count}{" "}
                  {account.calendar_count === 1 ? "calendar" : "calendars"}{" "}
                  {"\u00B7"} Synced
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Link to calendar view */}
        <Button asChild>
          <a
            href="#/calendar"
            aria-label="Go to calendar"
            className="no-underline"
          >
            Go to Calendar
          </a>
        </Button>
      </div>
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatEventTime(isoString: string): string {
  try {
    return new Date(isoString).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return isoString;
  }
}
