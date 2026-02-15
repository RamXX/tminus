/**
 * Onboarding flow helpers for the T-Minus SPA.
 *
 * Handles:
 * - OAuth URL construction with PKCE parameters for the onboarding flow
 * - Account sync status polling after OAuth connection
 * - Onboarding state machine (idle -> connecting -> syncing -> complete)
 *
 * The onboarding flow:
 * 1. User clicks "Connect Google" on the onboarding page
 * 2. Browser redirects to oauth worker with user_id and redirect_uri
 * 3. OAuth worker handles the full PKCE flow with Google
 * 4. On success, OAuth worker redirects back to the onboarding page with account_id
 * 5. Onboarding page polls /v1/accounts/:id for sync status
 * 6. Once sync completes, events are shown to the user
 */

import type { AccountProvider } from "./api";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Base URL for the OAuth worker. */
export const OAUTH_BASE_URL = "https://oauth.tminus.ink";

/** Polling interval for sync status checks (milliseconds). */
export const SYNC_POLL_INTERVAL_MS = 2000;

/** Maximum polling duration before giving up (milliseconds). */
export const SYNC_POLL_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Onboarding flow state. */
export type OnboardingState =
  | "idle"          // Initial state: showing provider buttons
  | "connecting"    // User clicked a provider, redirecting to OAuth
  | "syncing"       // OAuth complete, initial sync in progress
  | "complete"      // Sync done, events visible
  | "error";        // Something went wrong

/** Account status returned from sync polling. */
export interface OnboardingSyncStatus {
  /** Account identifier. */
  account_id: string;
  /** Account email from the provider. */
  email: string;
  /** Provider type. */
  provider: AccountProvider;
  /** D1 account status. */
  status: string;
  /** Health info from AccountDO (null if not yet available). */
  health: {
    lastSyncTs: string | null;
    lastSuccessTs: string | null;
    fullSyncNeeded: boolean;
  } | null;
}

/** Supported calendar providers for onboarding. */
export interface ProviderInfo {
  id: AccountProvider;
  label: string;
  enabled: boolean;
  description: string;
}

// ---------------------------------------------------------------------------
// Provider definitions
// ---------------------------------------------------------------------------

/** Available calendar providers for the onboarding page. */
export const PROVIDERS: ProviderInfo[] = [
  {
    id: "google",
    label: "Google Calendar",
    enabled: true,
    description: "Connect your Google Workspace or personal Google Calendar",
  },
  {
    id: "microsoft",
    label: "Microsoft Outlook",
    enabled: false,
    description: "Coming soon -- Connect your Microsoft 365 or Outlook calendar",
  },
];

// ---------------------------------------------------------------------------
// OAuth URL construction
// ---------------------------------------------------------------------------

/**
 * Build the OAuth start URL for the onboarding flow.
 *
 * Includes user_id and redirect_uri parameters so the OAuth worker
 * knows who is connecting and where to redirect after success.
 *
 * @param provider - Calendar provider ("google" or "microsoft")
 * @param userId - The authenticated user's ID
 * @param redirectUri - Where to return after OAuth completes (onboarding page URL)
 * @param oauthBaseUrl - Base URL for the OAuth worker (injectable for testing)
 * @returns Full URL to redirect the browser to
 */
export function buildOnboardingOAuthUrl(
  provider: AccountProvider,
  userId: string,
  redirectUri: string,
  oauthBaseUrl: string = OAUTH_BASE_URL,
): string {
  const url = new URL(`/oauth/${provider}/start`, oauthBaseUrl);
  url.searchParams.set("user_id", userId);
  url.searchParams.set("redirect_uri", redirectUri);
  return url.toString();
}

/**
 * Parse the OAuth callback return URL for account_id.
 *
 * After OAuth completes, the OAuth worker redirects back to the onboarding
 * page with account_id as a query parameter. This function extracts it.
 *
 * @param urlString - The current page URL (window.location.href)
 * @returns Object with account_id if present, or null
 */
export function parseOAuthCallback(urlString: string): {
  accountId: string | null;
  reactivated: boolean;
} {
  try {
    // The redirect_uri is the hash-based URL, so account_id is in the hash query
    // e.g., https://app.tminus.ink/#/onboard?account_id=acc-123
    const url = new URL(urlString);
    const hash = url.hash; // e.g., "#/onboard?account_id=acc-123"
    if (!hash) return { accountId: null, reactivated: false };

    const queryStart = hash.indexOf("?");
    if (queryStart === -1) return { accountId: null, reactivated: false };

    const params = new URLSearchParams(hash.slice(queryStart + 1));
    return {
      accountId: params.get("account_id"),
      reactivated: params.get("reactivated") === "true",
    };
  } catch {
    return { accountId: null, reactivated: false };
  }
}

/**
 * Determine if an initial sync has completed based on account status.
 *
 * The sync is considered complete when:
 * - Account status is "active"
 * - Health info is available
 * - lastSuccessTs is set (meaning at least one successful sync has occurred)
 *
 * @param status - The account sync status from the API
 * @returns true if the initial sync is complete
 */
export function isSyncComplete(status: OnboardingSyncStatus): boolean {
  if (status.status !== "active") return false;
  if (!status.health) return false;
  if (!status.health.lastSuccessTs) return false;
  return true;
}
