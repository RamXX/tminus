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
 * The component accepts injected fetch/navigate functions for testability.
 * In production, these are wired in App.tsx with auth tokens.
 */

import { useState, useEffect, useCallback, useRef } from "react";
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

export interface OnboardingProps {
  /** Current authenticated user. */
  user: { id: string; email: string };
  /**
   * Navigate to an OAuth URL. Defaults to window.location.assign.
   * Injected for testability (prevents actual navigation in tests).
   */
  navigateToOAuth?: (url: string) => void;
  /**
   * Fetch account status for sync polling.
   * Called with account_id, returns the account's sync status.
   */
  fetchAccountStatus: (accountId: string) => Promise<OnboardingSyncStatus>;
  /**
   * Fetch calendar events after sync completes.
   * Returns the user's events for display.
   */
  fetchEvents: () => Promise<OnboardingEvent[]>;
  /**
   * Submit Apple app-specific credentials.
   * Returns the created account_id for sync polling.
   */
  submitAppleCredentials?: (
    userId: string,
    email: string,
    password: string,
  ) => Promise<{ account_id: string }>;
  /**
   * Account ID from OAuth callback (null if not returning from OAuth).
   * When provided, the component enters syncing state and polls for status.
   */
  callbackAccountId: string | null;
  /**
   * Base URL for the OAuth worker. Defaults to production.
   * Overridable for local development and testing.
   */
  oauthBaseUrl?: string;
  /**
   * Fetch the current onboarding session from the server.
   * Used for resume flow (AC 1, AC 2) and cross-tab polling (AC 5).
   * When provided, enables server-side session management.
   */
  fetchOnboardingSession?: () => Promise<OnboardingSession | null>;
  /**
   * Create a new onboarding session on the server.
   * Returns the created session.
   */
  createOnboardingSession?: () => Promise<OnboardingSession>;
  /**
   * Notify the server that an account was added to the session.
   * BR-4: Idempotent -- re-connecting same account updates, not duplicates.
   */
  addAccountToServerSession?: (
    accountId: string,
    provider: string,
    email: string,
    calendarCount?: number,
  ) => Promise<void>;
  /**
   * Notify the server that onboarding is complete.
   * AC 6: Session marked complete on explicit user action.
   */
  completeServerSession?: () => Promise<void>;
  /**
   * Current onboarding session ID for OAuth state correlation.
   * AC 3: OAuth state parameter includes session ID.
   */
  sessionId?: string;
  /**
   * Error code from OAuth callback (e.g., "access_denied", "state_mismatch").
   * When provided, the component enters error state with a classified message.
   * TM-2o2.6: Error recovery and resilience.
   */
  callbackError?: string;
  /**
   * Provider that produced the callback error.
   * Used to generate provider-specific error messages.
   */
  callbackProvider?: AccountProvider;
  /**
   * Callback for error telemetry events.
   * Called with anonymized error events (no PII) for server-side logging.
   * BR-4: Error telemetry is anonymized.
   */
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
// Styles (responsive, mobile-first)
// ---------------------------------------------------------------------------

const styles = {
  container: {
    maxWidth: 600,
    width: "100%",
    margin: "0 auto",
    padding: "1.5rem 1rem",
    fontFamily: "system-ui, -apple-system, sans-serif",
    boxSizing: "border-box" as const,
  },
  branding: {
    textAlign: "center" as const,
    marginBottom: "2rem",
  },
  brandName: {
    fontSize: "1.5rem",
    fontWeight: 700,
    letterSpacing: "-0.02em",
    color: "#1a1a2e",
  },
  heading: {
    fontSize: "1.75rem",
    fontWeight: 600,
    color: "#1a1a2e",
    margin: "0.5rem 0",
  },
  subtitle: {
    color: "#64748b",
    fontSize: "0.95rem",
    margin: 0,
  },
  cardContainer: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "1rem",
  },
  providerCard: (color: string) => ({
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
    padding: "1rem 1.5rem",
    border: "1px solid #e2e8f0",
    borderRadius: "0.75rem",
    backgroundColor: "#fff",
    cursor: "pointer",
    fontSize: "1rem",
    transition: "border-color 0.15s, box-shadow 0.15s",
    borderLeft: `4px solid ${color}`,
    width: "100%",
    textAlign: "left" as const,
  }),
  providerIcon: (color: string) => ({
    fontSize: "1.5rem",
    fontWeight: 700,
    color,
    width: 40,
    height: 40,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "0.5rem",
    backgroundColor: `${color}15`,
    flexShrink: 0,
  }),
  connectButton: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "0.75rem 2rem",
    border: "none",
    borderRadius: "0.5rem",
    backgroundColor: "#2563eb",
    color: "#fff",
    fontSize: "1rem",
    fontWeight: 600,
    cursor: "pointer",
    marginTop: "1rem",
  },
  secondaryButton: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "0.75rem 2rem",
    border: "1px solid #e2e8f0",
    borderRadius: "0.5rem",
    backgroundColor: "#fff",
    color: "#1a1a2e",
    fontSize: "1rem",
    fontWeight: 500,
    cursor: "pointer",
  },
  connectedCard: (color: string) => ({
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
    padding: "1rem 1.5rem",
    border: "1px solid #e2e8f0",
    borderRadius: "0.75rem",
    backgroundColor: "#fff",
    borderLeft: `4px solid ${color}`,
    marginBottom: "0.75rem",
  }),
  successBanner: {
    textAlign: "center" as const,
    padding: "1.5rem",
    backgroundColor: "#f0fdf4",
    borderRadius: "0.75rem",
    marginBottom: "1.5rem",
  },
  errorBanner: {
    textAlign: "center" as const,
    padding: "2rem",
    backgroundColor: "#fef2f2",
    borderRadius: "0.75rem",
  },
  progressText: {
    textAlign: "center" as const,
    color: "#64748b",
    fontSize: "0.9rem",
    marginBottom: "1rem",
  },
  modal: {
    overlay: {
      position: "fixed" as const,
      inset: 0,
      backgroundColor: "rgba(0,0,0,0.4)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      zIndex: 100,
      padding: "1rem",
    },
    content: {
      backgroundColor: "#fff",
      borderRadius: "1rem",
      padding: "2rem",
      maxWidth: 480,
      width: "100%",
      maxHeight: "90vh",
      overflow: "auto" as const,
    },
  },
  input: {
    width: "100%",
    padding: "0.75rem",
    border: "1px solid #e2e8f0",
    borderRadius: "0.5rem",
    fontSize: "1rem",
    boxSizing: "border-box" as const,
    marginTop: "0.25rem",
  },
  label: {
    display: "block",
    fontSize: "0.9rem",
    fontWeight: 500,
    color: "#374151",
    marginBottom: "0.5rem",
  },
  validationError: {
    color: "#dc2626",
    fontSize: "0.85rem",
    marginTop: "0.25rem",
  },
  completionScreen: {
    textAlign: "center" as const,
    padding: "2rem 0",
  },
  spinner: {
    width: 40,
    height: 40,
    border: "3px solid #e2e8f0",
    borderTopColor: "#2563eb",
    borderRadius: "50%",
    margin: "0 auto",
    animation: "spin 1s linear infinite",
  },
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Onboarding({
  user,
  navigateToOAuth = (url) => {
    window.location.assign(url);
  },
  fetchAccountStatus,
  fetchEvents,
  submitAppleCredentials,
  callbackAccountId,
  oauthBaseUrl = "https://oauth.tminus.ink",
  fetchOnboardingSession,
  createOnboardingSession: createSession,
  addAccountToServerSession,
  completeServerSession,
  sessionId: initialSessionId,
  callbackError,
  callbackProvider,
  onErrorTelemetry,
}: OnboardingProps) {
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
  const [sessionId, setSessionId] = useState<string | undefined>(initialSessionId);
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
    if (!fetchOnboardingSession) return;

    let cancelled = false;
    (async () => {
      try {
        const session = await fetchOnboardingSession();
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
        } else if (createSession && !callbackAccountId) {
          // No existing session -- create one
          try {
            const newSession = await createSession();
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
    if (!fetchOnboardingSession) return;
    // Only poll when in idle/connecting states where another tab might add accounts
    if (viewState !== "idle" && viewState !== "connecting") return;

    sessionPollRef.current = setInterval(async () => {
      try {
        const session = await fetchOnboardingSession();
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
  }, [fetchOnboardingSession, viewState, connectedAccounts.length]);

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
    if (!submitAppleCredentials) {
      setAppleError("Apple Calendar connection is not configured");
      return;
    }

    setAppleError(null);
    setAppleSubmitting(true);

    try {
      const result = await submitAppleCredentials(
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
  }, [appleEmail, applePassword, submitAppleCredentials, user.id, onErrorTelemetry]);

  // -------------------------------------------------------------------------
  // Sync status polling
  // -------------------------------------------------------------------------

  const pollStatus = useCallback(
    async (accountId: string) => {
      try {
        const status = await fetchAccountStatus(accountId);
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
          if (addAccountToServerSession) {
            addAccountToServerSession(
              status.account_id,
              status.provider,
              status.email,
              status.calendar_count,
            ).catch(() => {
              // Non-fatal: server session update failure doesn't block UI
            });
          }

          setViewState("complete");

          // Stop polling
          if (pollingRef.current) {
            clearInterval(pollingRef.current);
            pollingRef.current = null;
          }

          // Fetch events to display
          try {
            const evts = await fetchEvents();
            setEvents(evts);
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
    [fetchAccountStatus, fetchEvents, onErrorTelemetry],
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
    if (completeServerSession) {
      completeServerSession().catch(() => {
        // Non-fatal: server completion failure doesn't block UI transition
      });
    }
  }, [completeServerSession]);

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
      style={styles.container}
      data-testid="onboarding-container"
    >
      {/* Branding */}
      <div style={styles.branding}>
        <div style={styles.brandName}>T-Minus</div>
        <h1 style={styles.heading}>Connect Your Calendar</h1>
        <p style={styles.subtitle}>
          Link your calendar accounts to get started with intelligent scheduling
        </p>
      </div>

      {/* Connected accounts summary (shown in multi-account flow) */}
      {connectedAccounts.length > 0 && viewState !== "finished" && (
        <div style={{ marginBottom: "1.5rem" }}>
          {connectedAccounts.map((account) => (
            <div
              key={account.account_id}
              style={styles.connectedCard(PROVIDER_COLORS[account.provider])}
              data-testid={`connected-account-${account.account_id}`}
            >
              <div
                style={styles.providerIcon(PROVIDER_COLORS[account.provider])}
              >
                {PROVIDER_ICONS[account.provider]}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>
                  {"\u2713"} {account.email}
                </div>
                <div style={{ fontSize: "0.85rem", color: "#64748b" }}>
                  {account.calendar_count}{" "}
                  {account.calendar_count === 1 ? "calendar" : "calendars"}{" "}
                  {"\u00B7"}{" "}
                  <span
                    style={{
                      color:
                        account.sync_state === "synced"
                          ? "#16a34a"
                          : account.sync_state === "error"
                            ? "#dc2626"
                            : "#ca8a04",
                    }}
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
            <div style={styles.progressText}>
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
        style={styles.cardContainer}
        data-testid="provider-cards"
      >
        {PROVIDERS.map((provider) => (
          <button
            key={provider.id}
            onClick={() => handleProviderClick(provider.id)}
            style={styles.providerCard(PROVIDER_COLORS[provider.id])}
            aria-label={`Connect ${provider.label}`}
            data-testid={`provider-card-${provider.id}`}
          >
            <div
              style={styles.providerIcon(PROVIDER_COLORS[provider.id])}
              data-testid={`provider-icon-${provider.id}`}
            >
              {PROVIDER_ICONS[provider.id]}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>Connect {provider.label}</div>
              <div style={{ fontSize: "0.85rem", color: "#64748b" }}>
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
      <div style={{ textAlign: "center", padding: "2rem" }}>
        <div style={{ fontSize: "1.25rem", marginBottom: "1rem" }}>
          Redirecting to your calendar provider...
        </div>
        <div style={{ color: "#64748b" }}>
          You will be asked to grant calendar access
        </div>
        <div style={{ ...styles.spinner, marginTop: "1.5rem" }} />
      </div>
    );
  }

  function renderSyncing() {
    return (
      <div style={{ textAlign: "center", padding: "2rem" }}>
        <div
          style={{
            fontSize: "1.25rem",
            marginBottom: "1rem",
            color: "#2563eb",
          }}
        >
          Syncing your calendar...
        </div>
        {syncStatus && (
          <div style={{ color: "#64748b", marginBottom: "1rem" }}>
            Connected as {syncStatus.email}
          </div>
        )}
        <div style={styles.spinner} />
      </div>
    );
  }

  function renderComplete() {
    return (
      <div>
        {/* Success banner */}
        <div style={styles.successBanner}>
          <div
            style={{
              fontSize: "1.5rem",
              color: "#16a34a",
              marginBottom: "0.5rem",
            }}
          >
            {"\u2713"} Connected
          </div>
          {syncStatus && (
            <>
              <div style={{ color: "#374151", fontWeight: 500 }}>
                {syncStatus.email}
              </div>
              <div style={{ color: "#64748b", fontSize: "0.9rem", marginTop: "0.25rem" }}>
                {syncStatus.calendar_count ?? 0}{" "}
                {(syncStatus.calendar_count ?? 0) === 1
                  ? "calendar"
                  : "calendars"}{" "}
                found {"\u00B7"}{" "}
                <span style={{ color: "#16a34a" }}>Synced</span>
              </div>
            </>
          )}
        </div>

        {/* Events list */}
        {events.length > 0 && (
          <div style={{ marginBottom: "1.5rem" }}>
            <h2
              style={{
                fontSize: "1.1rem",
                fontWeight: 600,
                marginBottom: "0.75rem",
              }}
            >
              Your upcoming events
            </h2>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "0.5rem",
              }}
            >
              {events.map((evt) => (
                <div
                  key={evt.canonical_event_id}
                  style={{
                    padding: "0.75rem 1rem",
                    border: "1px solid #e2e8f0",
                    borderRadius: "0.375rem",
                    backgroundColor: "#fff",
                  }}
                >
                  <div style={{ fontWeight: 500 }}>
                    {evt.summary ?? "(No title)"}
                  </div>
                  <div style={{ fontSize: "0.85rem", color: "#64748b" }}>
                    {formatEventTime(evt.start)} -- {formatEventTime(evt.end)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Progress + actions */}
        <div style={styles.progressText}>
          {connectedAccounts.length}{" "}
          {connectedAccounts.length === 1 ? "account" : "accounts"} connected
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "0.75rem",
            alignItems: "center",
          }}
        >
          <button
            onClick={handleAddAnother}
            style={styles.connectButton}
            aria-label="Add another account"
          >
            Add Another Account
          </button>
          <button
            onClick={handleDone}
            style={styles.secondaryButton}
            aria-label="Finish onboarding"
          >
            I{"'"}m Done
          </button>
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
      <div style={styles.errorBanner}>
        <div
          style={{
            fontSize: "1.25rem",
            color: "#dc2626",
            marginBottom: "0.5rem",
          }}
        >
          {classifiedError ? displayMessage : "Something went wrong"}
        </div>
        {!classifiedError && error && (
          <div style={{ color: "#64748b", marginBottom: "1rem" }}>{error}</div>
        )}
        <button
          onClick={handleRetry}
          style={styles.secondaryButton}
          aria-label={recoveryLabel}
        >
          {recoveryLabel}
        </button>
      </div>
    );
  }

  function renderAppleModal() {
    return (
      <div
        style={styles.modal.overlay}
        onClick={(e) => {
          if (e.target === e.currentTarget) {
            setViewState("idle");
          }
        }}
      >
        <div
          role="dialog"
          aria-label="Connect Apple Calendar"
          style={styles.modal.content}
        >
          <h2
            style={{
              fontSize: "1.25rem",
              fontWeight: 600,
              marginBottom: "1rem",
              margin: 0,
            }}
          >
            Connect Apple Calendar
          </h2>

          <p style={{ color: "#64748b", marginBottom: "1.5rem" }}>
            Apple Calendar uses an app-specific password instead of a
            sign-in button. Follow these steps:
          </p>

          {/* Instructions */}
          <div
            style={{
              backgroundColor: "#f8fafc",
              borderRadius: "0.5rem",
              padding: "1rem",
              marginBottom: "1.5rem",
              fontSize: "0.9rem",
            }}
          >
            <ol
              style={{
                margin: 0,
                paddingLeft: "1.25rem",
                color: "#374151",
              }}
            >
              <li style={{ marginBottom: "0.5rem" }}>
                Go to your{" "}
                <a
                  href={APPLE_ID_SETTINGS_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Apple ID settings"
                  style={{ color: "#2563eb" }}
                >
                  Apple ID settings
                </a>
              </li>
              <li style={{ marginBottom: "0.5rem" }}>
                Navigate to Sign-In and Security, then App-Specific Passwords
              </li>
              <li>
                Generate a new password and paste it below
              </li>
            </ol>
          </div>

          {/* Form */}
          <div style={{ marginBottom: "1rem" }}>
            <label
              htmlFor="apple-email"
              style={styles.label}
            >
              Apple ID Email
            </label>
            <input
              id="apple-email"
              type="email"
              value={appleEmail}
              onChange={(e) => setAppleEmail(e.target.value)}
              placeholder="your@icloud.com"
              style={styles.input}
              autoComplete="email"
            />
          </div>

          <div style={{ marginBottom: "1rem" }}>
            <label
              htmlFor="apple-password"
              style={styles.label}
            >
              App-Specific Password
            </label>
            <input
              id="apple-password"
              type="password"
              value={applePassword}
              onChange={(e) => setApplePassword(e.target.value)}
              placeholder="xxxx-xxxx-xxxx-xxxx"
              style={styles.input}
              autoComplete="off"
            />
          </div>

          {/* Validation/submission errors */}
          {appleError && (
            <div style={styles.validationError}>
              {appleError}
            </div>
          )}

          {/* Actions */}
          <div
            style={{
              display: "flex",
              gap: "0.75rem",
              justifyContent: "flex-end",
              marginTop: "1.5rem",
            }}
          >
            <button
              onClick={() => setViewState("idle")}
              style={styles.secondaryButton}
              aria-label="Cancel"
            >
              Cancel
            </button>
            <button
              onClick={handleAppleSubmit}
              disabled={appleSubmitting}
              style={{
                ...styles.connectButton,
                marginTop: 0,
                opacity: appleSubmitting ? 0.6 : 1,
              }}
              aria-label="Connect"
            >
              {appleSubmitting ? "Connecting..." : "Connect"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  function renderFinished() {
    return (
      <div style={styles.completionScreen}>
        <div
          style={{
            fontSize: "2rem",
            marginBottom: "0.5rem",
            color: "#16a34a",
          }}
        >
          {"\u2713"}
        </div>
        <h2
          style={{
            fontSize: "1.5rem",
            fontWeight: 600,
            color: "#1a1a2e",
            marginBottom: "0.5rem",
          }}
        >
          You{"'"}re All Set!
        </h2>
        <p style={{ color: "#64748b", marginBottom: "2rem" }}>
          Your calendars are connected and syncing. Here{"'"}s a summary:
        </p>

        {/* Account summary */}
        <div style={{ marginBottom: "2rem", textAlign: "left" }}>
          {connectedAccounts.map((account) => (
            <div
              key={account.account_id}
              style={styles.connectedCard(PROVIDER_COLORS[account.provider])}
            >
              <div
                style={styles.providerIcon(PROVIDER_COLORS[account.provider])}
              >
                {PROVIDER_ICONS[account.provider]}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{account.email}</div>
                <div style={{ fontSize: "0.85rem", color: "#64748b" }}>
                  {account.calendar_count}{" "}
                  {account.calendar_count === 1 ? "calendar" : "calendars"}{" "}
                  {"\u00B7"} Synced
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Link to calendar view */}
        <a
          href="#/calendar"
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "0.75rem 2rem",
            border: "none",
            borderRadius: "0.5rem",
            backgroundColor: "#2563eb",
            color: "#fff",
            fontSize: "1rem",
            fontWeight: 600,
            textDecoration: "none",
          }}
          aria-label="Go to calendar"
        >
          Go to Calendar
        </a>
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
