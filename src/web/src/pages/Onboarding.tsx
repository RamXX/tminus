/**
 * Onboarding page -- One-click Google Account Connection.
 *
 * Walking skeleton that proves the end-to-end onboarding flow:
 * 1. User sees branded "Connect your calendar" screen with provider buttons
 * 2. Clicking "Connect Google" initiates OAuth flow with PKCE
 * 3. On callback, renders success state with account name and calendar list
 * 4. Triggers initial sync automatically on successful connection
 * 5. Shows real-time sync progress (events appearing)
 *
 * State machine:
 *   idle -> connecting -> (browser redirects to OAuth) -> syncing -> complete
 *                                                         syncing -> error
 *
 * The component accepts injected fetch/navigate functions for testability.
 * In production, these are wired in App.tsx with auth tokens.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import {
  buildOnboardingOAuthUrl,
  isSyncComplete,
  SYNC_POLL_INTERVAL_MS,
  type OnboardingState,
  type OnboardingSyncStatus,
} from "../lib/onboarding";

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
   * Account ID from OAuth callback (null if not returning from OAuth).
   * When provided, the component enters syncing state and polls for status.
   */
  callbackAccountId: string | null;
  /**
   * Base URL for the OAuth worker. Defaults to production.
   * Overridable for local development and testing.
   */
  oauthBaseUrl?: string;
}

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
  callbackAccountId,
  oauthBaseUrl = "https://oauth.tminus.ink",
}: OnboardingProps) {
  const [state, setState] = useState<OnboardingState>(
    callbackAccountId ? "syncing" : "idle",
  );
  const [syncStatus, setSyncStatus] = useState<OnboardingSyncStatus | null>(
    null,
  );
  const [events, setEvents] = useState<OnboardingEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const syncCompleteRef = useRef(false);

  // -------------------------------------------------------------------------
  // OAuth initiation
  // -------------------------------------------------------------------------

  const handleConnectGoogle = useCallback(() => {
    setState("connecting");
    const redirectUri = `${window.location.origin}${window.location.pathname}#/onboard`;
    const url = buildOnboardingOAuthUrl("google", user.id, redirectUri, oauthBaseUrl);
    navigateToOAuth(url);
  }, [user.id, navigateToOAuth, oauthBaseUrl]);

  // -------------------------------------------------------------------------
  // Sync status polling
  // -------------------------------------------------------------------------

  const pollStatus = useCallback(
    async (accountId: string) => {
      try {
        const status = await fetchAccountStatus(accountId);
        setSyncStatus(status);

        if (isSyncComplete(status)) {
          syncCompleteRef.current = true;
          setState("complete");

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
        setError(
          err instanceof Error ? err.message : "Something went wrong",
        );
        setState("error");

        // Stop polling on error
        if (pollingRef.current) {
          clearInterval(pollingRef.current);
          pollingRef.current = null;
        }
      }
    },
    [fetchAccountStatus, fetchEvents],
  );

  // Start polling when we have a callback account ID
  useEffect(() => {
    if (!callbackAccountId) return;
    if (syncCompleteRef.current) return;

    // Initial poll immediately
    pollStatus(callbackAccountId);

    // Set up interval polling
    pollingRef.current = setInterval(() => {
      if (!syncCompleteRef.current) {
        pollStatus(callbackAccountId);
      }
    }, SYNC_POLL_INTERVAL_MS);

    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    };
  }, [callbackAccountId, pollStatus]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div
      style={{
        maxWidth: 600,
        margin: "0 auto",
        padding: "2rem",
        fontFamily: "system-ui, -apple-system, sans-serif",
      }}
    >
      {/* Branding */}
      <div style={{ textAlign: "center", marginBottom: "2rem" }}>
        <div
          style={{
            fontSize: "1.5rem",
            fontWeight: 700,
            letterSpacing: "-0.02em",
            color: "#1a1a2e",
          }}
        >
          T-Minus
        </div>
        <h1
          style={{
            fontSize: "1.75rem",
            fontWeight: 600,
            color: "#1a1a2e",
            margin: "0.5rem 0",
          }}
        >
          Connect Your Calendar
        </h1>
        <p style={{ color: "#64748b", fontSize: "0.95rem" }}>
          Link your calendar accounts to get started with intelligent scheduling
        </p>
      </div>

      {/* State-dependent content */}
      {state === "idle" && renderProviderButtons()}
      {state === "connecting" && renderConnecting()}
      {state === "syncing" && renderSyncing()}
      {state === "complete" && renderComplete()}
      {state === "error" && renderError()}
    </div>
  );

  // -------------------------------------------------------------------------
  // Render helpers
  // -------------------------------------------------------------------------

  function renderProviderButtons() {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
        {/* Google */}
        <button
          onClick={handleConnectGoogle}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.75rem",
            padding: "1rem 1.5rem",
            border: "1px solid #e2e8f0",
            borderRadius: "0.5rem",
            backgroundColor: "#fff",
            cursor: "pointer",
            fontSize: "1rem",
            transition: "border-color 0.15s",
          }}
        >
          <span style={{ fontSize: "1.5rem" }}>G</span>
          <div style={{ textAlign: "left" }}>
            <div style={{ fontWeight: 600 }}>Connect Google Calendar</div>
            <div style={{ fontSize: "0.85rem", color: "#64748b" }}>
              Connect your Google Workspace or personal Google Calendar
            </div>
          </div>
        </button>

        {/* Microsoft (coming soon) */}
        <button
          disabled
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.75rem",
            padding: "1rem 1.5rem",
            border: "1px solid #e2e8f0",
            borderRadius: "0.5rem",
            backgroundColor: "#f8fafc",
            cursor: "not-allowed",
            fontSize: "1rem",
            opacity: 0.6,
          }}
        >
          <span style={{ fontSize: "1.5rem" }}>M</span>
          <div style={{ textAlign: "left" }}>
            <div style={{ fontWeight: 600 }}>Microsoft Outlook</div>
            <div style={{ fontSize: "0.85rem", color: "#94a3b8" }}>
              Coming soon
            </div>
          </div>
        </button>

        {/* Apple (coming soon) */}
        <button
          disabled
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.75rem",
            padding: "1rem 1.5rem",
            border: "1px solid #e2e8f0",
            borderRadius: "0.5rem",
            backgroundColor: "#f8fafc",
            cursor: "not-allowed",
            fontSize: "1rem",
            opacity: 0.6,
          }}
        >
          <span style={{ fontSize: "1.5rem" }}>A</span>
          <div style={{ textAlign: "left" }}>
            <div style={{ fontWeight: 600 }}>Apple Calendar</div>
            <div style={{ fontSize: "0.85rem", color: "#94a3b8" }}>
              Coming soon
            </div>
          </div>
        </button>
      </div>
    );
  }

  function renderConnecting() {
    return (
      <div style={{ textAlign: "center", padding: "2rem" }}>
        <div style={{ fontSize: "1.25rem", marginBottom: "1rem" }}>
          Redirecting to Google...
        </div>
        <div style={{ color: "#64748b" }}>
          You will be asked to grant calendar access
        </div>
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
        <div
          style={{
            width: 40,
            height: 40,
            border: "3px solid #e2e8f0",
            borderTopColor: "#2563eb",
            borderRadius: "50%",
            margin: "0 auto",
            animation: "spin 1s linear infinite",
          }}
        />
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  function renderComplete() {
    return (
      <div>
        {/* Success banner */}
        <div
          style={{
            textAlign: "center",
            padding: "1.5rem",
            backgroundColor: "#f0fdf4",
            borderRadius: "0.5rem",
            marginBottom: "1.5rem",
          }}
        >
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
            <div style={{ color: "#64748b" }}>
              {syncStatus.email} -- Google Calendar
            </div>
          )}
        </div>

        {/* Events list */}
        {events.length > 0 && (
          <div>
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
      </div>
    );
  }

  function renderError() {
    return (
      <div
        style={{
          textAlign: "center",
          padding: "2rem",
          backgroundColor: "#fef2f2",
          borderRadius: "0.5rem",
        }}
      >
        <div
          style={{
            fontSize: "1.25rem",
            color: "#dc2626",
            marginBottom: "0.5rem",
          }}
        >
          Something went wrong
        </div>
        {error && (
          <div style={{ color: "#64748b", marginBottom: "1rem" }}>{error}</div>
        )}
        <button
          onClick={() => {
            setState("idle");
            setError(null);
            setSyncStatus(null);
          }}
          style={{
            padding: "0.5rem 1.5rem",
            border: "1px solid #e2e8f0",
            borderRadius: "0.375rem",
            backgroundColor: "#fff",
            cursor: "pointer",
          }}
        >
          Try Again
        </button>
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
