/**
 * Sync status types and pure logic for the Sync Status Dashboard.
 *
 * Provides health computation functions that map raw per-account sync data
 * to health states (healthy/degraded/stale/error) with corresponding colors.
 *
 * Data source: GET /api/v1/sync/status
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Health state for a single account or overall system. */
export type HealthState = "healthy" | "degraded" | "stale" | "error";

/** Color associated with each health state. */
export type HealthColor = "green" | "yellow" | "red";

/** Raw per-account sync status from the API. */
export interface SyncAccountStatus {
  account_id: string;
  email: string;
  provider: string;
  status: string; // "active", "paused", "revoked", etc.
  last_sync_ts: string | null; // ISO 8601 timestamp or null if never synced
  channel_status: string; // "active", "expired", "error"
  pending_writes: number;
  error_count: number;
}

/** API response envelope for sync status. */
export interface SyncStatusResponse {
  accounts: SyncAccountStatus[];
}

/** Computed health for a single account. */
export interface AccountHealth {
  account_id: string;
  email: string;
  provider: string;
  status: string;
  last_sync_ts: string | null;
  channel_status: string;
  pending_writes: number;
  error_count: number;
  health: HealthState;
  color: HealthColor;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Threshold in milliseconds to consider a live channel "idle" (24h). */
export const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/** Auto-refresh interval in milliseconds (30 seconds). */
export const REFRESH_INTERVAL_MS = 30 * 1000;

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

/**
 * Map a HealthState to its display color.
 *
 * - healthy -> green
 * - degraded -> yellow
 * - stale -> red
 * - error -> red
 */
export function healthToColor(state: HealthState): HealthColor {
  switch (state) {
    case "healthy":
      return "green";
    case "degraded":
      return "yellow";
    case "stale":
    case "error":
      return "red";
  }
}

/**
 * Compute health state for a single account.
 *
 * Priority (highest to lowest):
 *   1. error_count > 0 -> "error"
 *   2. status is "revoked" or channel_status is "error" -> "error"
 *   3. pending_writes > 10 or channel_status is "expired" -> "degraded"
 *   4. active channel with no errors -> "healthy" (or "degraded" if idle/invalid timestamp)
 *   5. non-active channel without sync timestamp -> "stale"
 *   6. non-active channel older than STALE_THRESHOLD_MS -> "stale"
 *   7. Otherwise -> "degraded"
 *
 * @param account - raw account status from API
 * @param now - current time for staleness check (default: Date.now())
 */
export function computeAccountHealth(
  account: SyncAccountStatus,
  now: number = Date.now(),
): HealthState {
  const channelStatus = account.channel_status.toLowerCase();

  // Error conditions
  if (account.error_count > 0) return "error";
  if (account.status === "revoked") return "error";
  if (channelStatus === "error") return "error";

  // Degraded conditions
  if (channelStatus === "expired") return "degraded";
  if (account.pending_writes > 10) return "degraded";

  // A live channel with no errors means sync is operational.
  if (channelStatus === "active") {
    if (!account.last_sync_ts) return "healthy";
    const lastSync = new Date(account.last_sync_ts).getTime();
    if (Number.isNaN(lastSync)) return "degraded";
    if (now - lastSync > STALE_THRESHOLD_MS) return "degraded";
    return "healthy";
  }

  // Non-active channels use staleness checks.
  if (!account.last_sync_ts) return "stale";
  const lastSync = new Date(account.last_sync_ts).getTime();
  if (Number.isNaN(lastSync)) return "stale";
  if (now - lastSync > STALE_THRESHOLD_MS) return "stale";

  return "degraded";
}

/**
 * Enrich raw account statuses with computed health and color.
 */
export function computeAllAccountHealth(
  accounts: SyncAccountStatus[],
  now: number = Date.now(),
): AccountHealth[] {
  return accounts.map((account) => {
    const health = computeAccountHealth(account, now);
    return {
      ...account,
      health,
      color: healthToColor(health),
    };
  });
}

/**
 * Compute overall system health from individual account healths.
 *
 * Returns the worst health state across all accounts.
 * Priority: error > stale > degraded > healthy.
 * If no accounts, returns "healthy".
 */
export function computeOverallHealth(accounts: AccountHealth[]): HealthState {
  if (accounts.length === 0) return "healthy";

  const priority: Record<HealthState, number> = {
    healthy: 0,
    degraded: 1,
    stale: 2,
    error: 3,
  };

  let worst: HealthState = "healthy";
  for (const account of accounts) {
    if (priority[account.health] > priority[worst]) {
      worst = account.health;
    }
  }
  return worst;
}

/**
 * Human-readable label for a health state.
 */
export function healthLabel(state: HealthState): string {
  switch (state) {
    case "healthy":
      return "Healthy";
    case "degraded":
      return "Degraded";
    case "stale":
      return "Stale";
    case "error":
      return "Error";
  }
}
