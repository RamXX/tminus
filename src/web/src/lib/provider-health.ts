/**
 * Provider Health Dashboard -- types and pure functions.
 *
 * Computes account health status badges (Synced/Syncing/Error/Stale) with
 * provider-specific color theming and human-readable remediation guidance.
 *
 * Design decisions:
 * - Provider-specific colors (Google=blue, Microsoft=purple, Apple=gray) per
 *   retro insight: hash-based color assignment collides with small palettes.
 * - Stale threshold is configurable (default: 1 hour per AC6).
 * - Remediation guidance maps error types to human-readable instructions.
 * - API response includes account count + tier limit per retro insight.
 */

import type { AccountProvider } from "./api";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default stale threshold in milliseconds (1 hour, per AC6). */
export const DEFAULT_STALE_THRESHOLD_MS = 60 * 60 * 1000;

/** Auto-refresh interval for the health dashboard (15 seconds). */
export const HEALTH_REFRESH_INTERVAL_MS = 15 * 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Health status badge for an account. */
export type HealthBadge = "synced" | "syncing" | "error" | "stale";

/** A single sync history event. */
export interface SyncHistoryEvent {
  readonly id: string;
  readonly timestamp: string;
  readonly event_count: number;
  readonly status: "success" | "error";
  readonly error_message?: string;
}

/** Calendar info within an account. */
export interface CalendarInfo {
  readonly calendar_id: string;
  readonly name: string;
  readonly sync_status: "synced" | "syncing" | "error" | "stale";
}

/** Account health data from the API (enriched from GET /api/accounts). */
export interface AccountHealthData {
  readonly account_id: string;
  readonly email: string;
  readonly provider: AccountProvider;
  readonly status: string;
  readonly calendar_count: number;
  readonly calendar_names: string[];
  readonly last_successful_sync: string | null;
  readonly is_syncing: boolean;
  readonly error_message: string | null;
  readonly token_expires_at: string | null;
  readonly created_at: string;
}

/** Response from GET /api/accounts with health data. */
export interface AccountsHealthResponse {
  readonly accounts: AccountHealthData[];
  readonly account_count: number;
  readonly tier_limit: number;
}

/** Sync history response from GET /api/accounts/:id/sync-history. */
export interface SyncHistoryResponse {
  readonly account_id: string;
  readonly events: SyncHistoryEvent[];
}

// ---------------------------------------------------------------------------
// Provider-specific colors (per retro insight -- no hash-based assignment)
// ---------------------------------------------------------------------------

/** Provider-specific brand colors for account theming. */
const PROVIDER_COLORS: Record<AccountProvider, string> = {
  google: "#4285F4",    // Google blue
  microsoft: "#7B1FA2", // Microsoft purple
  apple: "#8E8E93",     // Apple gray
};

/** Get the brand color for a provider. */
export function providerColor(provider: AccountProvider): string {
  return PROVIDER_COLORS[provider] ?? "#64748b";
}

// ---------------------------------------------------------------------------
// Health badge computation
// ---------------------------------------------------------------------------

/** Badge color mapping -- deterministic per badge type, not per account. */
const BADGE_COLORS: Record<HealthBadge, string> = {
  synced: "#16a34a",  // green
  syncing: "#2563eb", // blue
  error: "#dc2626",   // red
  stale: "#ca8a04",   // yellow
};

/** Badge labels for display. */
const BADGE_LABELS: Record<HealthBadge, string> = {
  synced: "Synced",
  syncing: "Syncing",
  error: "Error",
  stale: "Stale",
};

/** Unicode symbols for badges. */
const BADGE_SYMBOLS: Record<HealthBadge, string> = {
  synced: "\u25CF",   // filled circle
  syncing: "\u21BB",  // clockwise open circle arrow
  error: "\u2716",    // heavy X
  stale: "\u25A0",    // square
};

/**
 * Compute the health badge for an account.
 *
 * Priority:
 * 1. error_message present -> "error"
 * 2. is_syncing is true -> "syncing"
 * 3. last_successful_sync is null -> "stale" (never synced)
 * 4. last_successful_sync older than staleThresholdMs -> "stale"
 * 5. Otherwise -> "synced"
 *
 * @param account - Account health data
 * @param now - Current time for staleness check (default: Date.now())
 * @param staleThresholdMs - Stale threshold in ms (default: 1 hour)
 */
export function computeHealthBadge(
  account: AccountHealthData,
  now: number = Date.now(),
  staleThresholdMs: number = DEFAULT_STALE_THRESHOLD_MS,
): HealthBadge {
  // Error takes highest priority
  if (account.error_message) return "error";

  // Currently syncing
  if (account.is_syncing) return "syncing";

  // Never synced
  if (!account.last_successful_sync) return "stale";

  // Stale check
  const lastSync = new Date(account.last_successful_sync).getTime();
  if (now - lastSync > staleThresholdMs) return "stale";

  return "synced";
}

/** Get the display color for a health badge. */
export function badgeColor(badge: HealthBadge): string {
  return BADGE_COLORS[badge];
}

/** Get the display label for a health badge. */
export function badgeLabel(badge: HealthBadge): string {
  return BADGE_LABELS[badge];
}

/** Get the Unicode symbol for a health badge. */
export function badgeSymbol(badge: HealthBadge): string {
  return BADGE_SYMBOLS[badge];
}

// ---------------------------------------------------------------------------
// Remediation guidance (AC2: human-readable error messages)
// ---------------------------------------------------------------------------

/** Known error patterns and their remediation instructions. */
const REMEDIATION_MAP: Array<{ pattern: RegExp; guidance: string }> = [
  {
    pattern: /token.*expir|expir.*token|refresh.*fail/i,
    guidance:
      "Your authorization has expired. Click Reconnect to re-authorize with your provider.",
  },
  {
    pattern: /revok|access.*denied|permission/i,
    guidance:
      "Access was revoked or denied. Click Reconnect to grant calendar access again.",
  },
  {
    pattern: /rate.*limit|quota|429/i,
    guidance:
      "Your provider is rate-limiting requests. This usually resolves within a few minutes.",
  },
  {
    pattern: /network|timeout|connect|ECONNREFUSED/i,
    guidance:
      "A network error occurred. Check your connection and try again. If persistent, click Reconnect.",
  },
  {
    pattern: /calendar.*not.*found|404/i,
    guidance:
      "The calendar could not be found. It may have been deleted at the provider. Click Reconnect to re-sync.",
  },
];

/**
 * Get human-readable remediation guidance for an error message.
 *
 * Matches error_message against known patterns and returns specific guidance.
 * Falls back to a generic message if no pattern matches.
 */
export function getRemediationGuidance(errorMessage: string | null): string {
  if (!errorMessage) return "";

  for (const { pattern, guidance } of REMEDIATION_MAP) {
    if (pattern.test(errorMessage)) {
      return guidance;
    }
  }

  return "An unexpected error occurred. Try clicking Reconnect. If the issue persists, contact support.";
}

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

/**
 * Format an ISO timestamp as a relative time string.
 */
export function formatRelativeTime(
  isoTimestamp: string | null,
  now: number = Date.now(),
): string {
  if (!isoTimestamp) return "Never";

  try {
    const date = new Date(isoTimestamp);
    const diffMs = now - date.getTime();
    const diffMin = Math.floor(diffMs / 60_000);

    if (diffMin < 1) return "Just now";
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.floor(diffHr / 24);
    return `${diffDay}d ago`;
  } catch {
    return "Unknown";
  }
}

/**
 * Format token expiry as a human-readable string.
 * Does NOT expose the actual token value (AC2 security requirement).
 */
export function formatTokenExpiry(
  expiresAt: string | null,
  now: number = Date.now(),
): string {
  if (!expiresAt) return "No token info available";

  try {
    const expiry = new Date(expiresAt).getTime();
    const diffMs = expiry - now;

    if (diffMs <= 0) return "Expired";

    const diffMin = Math.floor(diffMs / 60_000);
    if (diffMin < 60) return `Expires in ${diffMin}m`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `Expires in ${diffHr}h`;
    const diffDay = Math.floor(diffHr / 24);
    return `Expires in ${diffDay}d`;
  } catch {
    return "Unknown";
  }
}
