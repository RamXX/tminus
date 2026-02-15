/**
 * Account management helpers for the T-Minus SPA.
 *
 * Handles OAuth URL construction and account status display logic.
 * OAuth flow: SPA redirects browser to oauth.tminus.ink, which handles
 * the provider OAuth dance, then redirects back to app.tminus.ink/#/accounts.
 */

import type { AccountProvider, AccountStatus } from "./api";

// ---------------------------------------------------------------------------
// OAuth URL construction
// ---------------------------------------------------------------------------

/** Base URL for the OAuth worker. */
export const OAUTH_BASE_URL = "https://oauth.tminus.ink";

/** Callback URL after OAuth completes (app returns to accounts page). */
export const OAUTH_CALLBACK_RETURN_URL = "https://app.tminus.ink/#/accounts";

/**
 * Build the full OAuth start URL for a given provider.
 *
 * The OAuth worker handles the full OAuth 2.0 flow:
 * 1. SPA redirects to oauth.tminus.ink/oauth/{provider}/start
 * 2. OAuth worker redirects to provider consent screen
 * 3. Provider callback hits oauth.tminus.ink/oauth/{provider}/callback
 * 4. OAuth worker redirects back to app.tminus.ink/#/accounts
 *
 * @param provider - "google" or "microsoft"
 * @returns Full URL to redirect the browser to
 */
export function buildOAuthStartUrl(provider: AccountProvider): string {
  return `${OAUTH_BASE_URL}/oauth/${provider}/start`;
}

// ---------------------------------------------------------------------------
// Status display helpers
// ---------------------------------------------------------------------------

/** Status indicator color mapping. */
const STATUS_COLORS: Record<AccountStatus, string> = {
  active: "#16a34a",   // green
  pending: "#ca8a04",  // yellow
  error: "#dc2626",    // red
  revoked: "#64748b",  // gray
};

/** Human-readable status labels. */
const STATUS_LABELS: Record<AccountStatus, string> = {
  active: "Active",
  pending: "Pending",
  error: "Error",
  revoked: "Revoked",
};

/** Unicode symbols for status indicators. */
const STATUS_SYMBOLS: Record<AccountStatus, string> = {
  active: "\u25CF",   // filled circle
  pending: "\u25CB",  // empty circle
  error: "\u2716",    // heavy X
  revoked: "\u25A0",  // square
};

/** Provider display labels. */
const PROVIDER_LABELS: Record<AccountProvider, string> = {
  google: "Google",
  microsoft: "Microsoft",
};

/**
 * Get the display color for an account status.
 */
export function statusColor(status: AccountStatus): string {
  return STATUS_COLORS[status] ?? STATUS_COLORS.error;
}

/**
 * Get the human-readable label for an account status.
 */
export function statusLabel(status: AccountStatus): string {
  return STATUS_LABELS[status] ?? "Unknown";
}

/**
 * Get the Unicode symbol for an account status.
 */
export function statusSymbol(status: AccountStatus): string {
  return STATUS_SYMBOLS[status] ?? "\u003F"; // question mark fallback
}

/**
 * Get the display label for a provider.
 */
export function providerLabel(provider: AccountProvider): string {
  return PROVIDER_LABELS[provider] ?? provider;
}
