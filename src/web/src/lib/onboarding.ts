/**
 * Onboarding flow helpers for the T-Minus SPA.
 *
 * Handles:
 * - OAuth URL construction with PKCE parameters for the onboarding flow
 * - Account sync status polling after OAuth connection
 * - Onboarding state machine (idle -> connecting -> syncing -> complete)
 * - Apple app-specific password validation
 * - Multi-account onboarding state management
 * - Provider-specific branding (deterministic colors, not hash-based)
 *
 * The onboarding flow:
 * 1. User sees provider cards (Google, Microsoft, Apple)
 * 2. Google/Microsoft: click -> OAuth redirect -> return with account_id -> poll sync
 * 3. Apple: click -> modal with app-specific password input -> submit -> poll sync
 * 4. After each account: show connected status + "Add another account" CTA
 * 5. When done: "You're all set" completion screen
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

/** Apple ID settings URL for generating app-specific passwords. */
export const APPLE_ID_SETTINGS_URL = "https://appleid.apple.com/account/manage";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Onboarding flow state for the overall page. */
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
  /** Number of calendars found (populated after sync). */
  calendar_count?: number;
  /** Health info from AccountDO (null if not yet available). */
  health: {
    lastSyncTs: string | null;
    lastSuccessTs: string | null;
    fullSyncNeeded: boolean;
  } | null;
}

/** A connected account displayed in the onboarding UI. */
export interface ConnectedAccount {
  account_id: string;
  email: string;
  provider: AccountProvider;
  calendar_count: number;
  sync_state: "syncing" | "synced" | "error";
  error_message?: string;
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
    enabled: true,
    description: "Connect your Microsoft 365 or Outlook calendar",
  },
  {
    id: "apple",
    label: "Apple Calendar",
    enabled: true,
    description: "Connect your iCloud calendar with an app-specific password",
  },
];

// ---------------------------------------------------------------------------
// Provider branding
// Per retro learning: use deterministic provider-specific colors, not hash-based.
// These match user mental models of each provider's branding.
// ---------------------------------------------------------------------------

/** Provider-specific brand colors for visual differentiation. */
export const PROVIDER_COLORS: Record<AccountProvider, string> = {
  google: "#4285F4",    // Google brand blue
  microsoft: "#7B2AE0", // Microsoft brand purple
  apple: "#555555",      // Apple brand dark gray
};

/** Provider-specific icons (SVG path data or single-character fallback). */
export const PROVIDER_ICONS: Record<AccountProvider, string> = {
  google: "G",
  microsoft: "M",
  apple: "A", // Could be replaced with SVG
};

// ---------------------------------------------------------------------------
// OAuth URL construction
// ---------------------------------------------------------------------------

/**
 * Build the OAuth start URL for the onboarding flow.
 *
 * Includes user_id and redirect_uri parameters so the OAuth worker
 * knows who is connecting and where to redirect after success.
 *
 * @param provider - Calendar provider ("google", "microsoft", or "apple")
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

// ---------------------------------------------------------------------------
// Apple app-specific password validation
// ---------------------------------------------------------------------------

/**
 * Validate an Apple app-specific password format.
 *
 * Apple app-specific passwords follow the format: xxxx-xxxx-xxxx-xxxx
 * where each group is 4 lowercase letters separated by hyphens.
 *
 * @param password - The app-specific password to validate
 * @returns true if the format is valid
 */
export function isValidAppleAppPassword(password: string): boolean {
  if (!password || typeof password !== "string") return false;
  // Accept with or without hyphens, case-insensitive
  const cleaned = password.replace(/-/g, "").toLowerCase();
  // Must be exactly 16 lowercase letters
  return /^[a-z]{16}$/.test(cleaned);
}

/**
 * Format an Apple app-specific password for display (masked).
 *
 * @param password - The raw password
 * @returns Masked version like "xxxx-****-****-****"
 */
export function maskApplePassword(password: string): string {
  const cleaned = password.replace(/-/g, "").toLowerCase();
  if (cleaned.length < 4) return "****-****-****-****";
  return `${cleaned.slice(0, 4)}-****-****-****`;
}

// ---------------------------------------------------------------------------
// Multi-account helpers
// ---------------------------------------------------------------------------

/**
 * Determine if a provider uses OAuth (browser redirect) or credentials (modal).
 */
export function isOAuthProvider(provider: AccountProvider): boolean {
  return provider === "google" || provider === "microsoft";
}

/**
 * Determine if a provider uses credential-based auth (Apple app-specific password).
 */
export function isCredentialProvider(provider: AccountProvider): boolean {
  return provider === "apple";
}

/**
 * Get the provider brand color.
 */
export function getProviderColor(provider: AccountProvider): string {
  return PROVIDER_COLORS[provider];
}

/**
 * Get the provider info by ID.
 */
export function getProviderInfo(provider: AccountProvider): ProviderInfo | undefined {
  return PROVIDERS.find((p) => p.id === provider);
}
