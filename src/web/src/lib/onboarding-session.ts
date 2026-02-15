/**
 * Onboarding session management for multi-account connection flow.
 *
 * Handles:
 * - Session creation and serialization for server persistence
 * - Resume logic: detecting existing sessions and restoring state
 * - Idempotent account addition (same account re-connected updates, not duplicates)
 * - Cross-tab polling for consistent state
 * - OAuth state parameter embedding session ID for post-callback correlation
 * - Session completion on explicit user action
 *
 * Per retro learning: optional fields use undefined (not false) with
 * JSON key omission for unset values. This avoids ambiguity between
 * "explicitly false" and "unset".
 *
 * Business rules:
 * - BR-1: Session is per-user, stored in UserGraphDO
 * - BR-2: OAuth state parameter includes session ID
 * - BR-3: Session survives browser close (httpOnly cookie + server state)
 * - BR-4: Adding same account is idempotent (update, not duplicate)
 */

import type { AccountProvider } from "./api";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Polling interval for cross-tab session status checks (milliseconds). */
export const SESSION_POLL_INTERVAL_MS = 3000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Onboarding step in the session lifecycle. */
export type OnboardingStep = "welcome" | "connecting" | "complete";

/** Status of a connected account within the session. */
export type SessionAccountStatus = "connected" | "syncing" | "error";

/** A connected account entry within the onboarding session. */
export interface SessionAccount {
  account_id: string;
  provider: AccountProvider;
  email: string;
  status: SessionAccountStatus;
  /** Number of calendars found (populated after sync). */
  calendar_count?: number;
  connected_at: string;
}

/**
 * Onboarding session record.
 *
 * Persisted server-side in UserGraphDO. The session_token is stored
 * in an httpOnly cookie for browser persistence across closes.
 *
 * Optional fields use `field?: type` (not `field: type | false`)
 * per retro learning on unset-vs-explicitly-false ambiguity.
 */
export interface OnboardingSession {
  session_id: string;
  user_id: string;
  step: OnboardingStep;
  accounts: SessionAccount[];
  session_token: string;
  created_at: string;
  updated_at: string;
  /** Set when the user explicitly completes onboarding. */
  completed_at?: string;
}

// ---------------------------------------------------------------------------
// Session creation
// ---------------------------------------------------------------------------

/**
 * Create a new onboarding session record.
 *
 * @param sessionId - Pre-generated session ID (from server or generateId)
 * @param userId - The authenticated user's ID
 * @param sessionToken - Random token for httpOnly cookie
 * @returns A fresh OnboardingSession with welcome step and no accounts
 */
export function createOnboardingSession(
  sessionId: string,
  userId: string,
  sessionToken: string,
): OnboardingSession {
  const now = new Date().toISOString();
  return {
    session_id: sessionId,
    user_id: userId,
    step: "welcome",
    accounts: [],
    session_token: sessionToken,
    created_at: now,
    updated_at: now,
  };
}

// ---------------------------------------------------------------------------
// Account management (idempotent)
// ---------------------------------------------------------------------------

/**
 * Add or update an account in the session.
 *
 * BR-4: If the same account_id already exists, update it rather than
 * creating a duplicate. This handles the case where a user re-connects
 * the same Google account.
 *
 * @param session - Current session state
 * @param account - Account to add or update
 * @returns New session with the account added/updated and step set to "connecting"
 */
export function addAccountToSession(
  session: OnboardingSession,
  account: SessionAccount,
): OnboardingSession {
  const existingIndex = session.accounts.findIndex(
    (a) => a.account_id === account.account_id,
  );

  let accounts: SessionAccount[];
  if (existingIndex >= 0) {
    // Update existing (idempotent)
    accounts = session.accounts.map((a, i) =>
      i === existingIndex ? account : a,
    );
  } else {
    accounts = [...session.accounts, account];
  }

  return {
    ...session,
    accounts,
    step: "connecting",
    updated_at: new Date().toISOString(),
  };
}

/**
 * Update the status of a specific account in the session.
 *
 * @param session - Current session state
 * @param accountId - Account to update
 * @param status - New status
 * @param calendarCount - Optional calendar count (set after sync completes)
 * @returns New session with the account status updated
 */
export function updateAccountStatus(
  session: OnboardingSession,
  accountId: string,
  status: SessionAccountStatus,
  calendarCount?: number,
): OnboardingSession {
  const accounts = session.accounts.map((a) =>
    a.account_id === accountId
      ? {
          ...a,
          status,
          ...(calendarCount !== undefined ? { calendar_count: calendarCount } : {}),
        }
      : a,
  );

  return {
    ...session,
    accounts,
    updated_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Session completion
// ---------------------------------------------------------------------------

/**
 * Mark the session as complete.
 *
 * AC 6: Session marked complete on explicit user action (not auto-timeout).
 *
 * @param session - Current session state
 * @returns New session with step="complete" and completed_at set
 */
export function completeSession(
  session: OnboardingSession,
): OnboardingSession {
  const now = new Date().toISOString();
  return {
    ...session,
    step: "complete",
    completed_at: now,
    updated_at: now,
  };
}

// ---------------------------------------------------------------------------
// Resume logic
// ---------------------------------------------------------------------------

/**
 * Determine the view state to show based on an existing session.
 *
 * AC 2: Resuming shows all previously connected accounts with correct status.
 *
 * @param session - Existing session from the server (or null if none)
 * @returns What the UI should do: "fresh" (start new), "resume" (show accounts),
 *          or "redirect" (session complete, go to calendar)
 */
export function determineResumeAction(
  session: OnboardingSession | null,
): "fresh" | "resume" | "redirect" {
  if (!session) return "fresh";
  if (session.step === "complete" || session.completed_at) return "redirect";
  if (session.accounts.length > 0) return "resume";
  return "fresh";
}

// ---------------------------------------------------------------------------
// OAuth state parameter
// ---------------------------------------------------------------------------

/**
 * Build an OAuth state parameter that includes the session ID.
 *
 * AC 3: OAuth state parameter includes session ID for post-callback correlation.
 *
 * The state parameter is a JSON-encoded string containing:
 * - session_id: For correlating the callback with the onboarding session
 * - nonce: Random value for CSRF protection
 *
 * @param sessionId - The onboarding session ID
 * @param nonce - Random CSRF protection value
 * @returns URL-safe state parameter string
 */
export function buildOAuthStateWithSession(
  sessionId: string,
  nonce: string,
): string {
  return btoa(JSON.stringify({ session_id: sessionId, nonce }));
}

/**
 * Parse the OAuth state parameter to extract the session ID.
 *
 * @param state - The state parameter from the OAuth callback
 * @returns Parsed session ID and nonce, or null if invalid
 */
export function parseOAuthState(
  state: string,
): { session_id: string; nonce: string } | null {
  try {
    const decoded = JSON.parse(atob(state));
    if (
      typeof decoded === "object" &&
      decoded !== null &&
      typeof decoded.session_id === "string" &&
      typeof decoded.nonce === "string"
    ) {
      return { session_id: decoded.session_id, nonce: decoded.nonce };
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Serialization (for persistence)
// ---------------------------------------------------------------------------

/**
 * Serialize a session to JSON for persistence.
 *
 * Per retro learning: optional fields with undefined are omitted from
 * JSON.stringify output, keeping the serialized form clean.
 */
export function serializeSession(session: OnboardingSession): string {
  return JSON.stringify(session);
}

/**
 * Deserialize a session from JSON.
 *
 * @param json - JSON string from persistence layer
 * @returns Parsed session, or null if invalid
 */
export function deserializeSession(json: string): OnboardingSession | null {
  try {
    const parsed = JSON.parse(json);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof parsed.session_id === "string" &&
      typeof parsed.user_id === "string" &&
      typeof parsed.step === "string" &&
      Array.isArray(parsed.accounts) &&
      typeof parsed.session_token === "string" &&
      typeof parsed.created_at === "string" &&
      typeof parsed.updated_at === "string"
    ) {
      return parsed as OnboardingSession;
    }
    return null;
  } catch {
    return null;
  }
}
