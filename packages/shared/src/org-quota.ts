/**
 * Per-org quota management for domain-wide delegation (TM-9iu.5).
 *
 * Provides:
 * 1. Per-org quotas: max discovered users, max delegations, max API calls per day
 * 2. Quota tracking with daily/monthly reset
 * 3. Quota exceeded responses (429 with Retry-After header)
 * 4. Quota usage reporting (current vs limit)
 *
 * Design decisions:
 * - Quotas are stored per-org with a date-bucketed counter pattern
 * - Daily quotas reset at midnight UTC
 * - Monthly quotas reset on the 1st of each month UTC
 * - Quota checks are non-blocking: exceeding a quota returns 429 but does not
 *   break existing functionality (BR-4: graceful degradation)
 *
 * Business rules:
 * - BR-1: Rate limits are per-org, configurable by admin
 * - BR-4: Quota exceeded does not break existing functionality
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Quota types tracked per org. */
export type QuotaType = "discovered_users" | "delegations" | "api_calls_daily";

/** Per-org quota configuration. */
export interface OrgQuotaConfig {
  /** Maximum number of discovered users allowed. */
  maxDiscoveredUsers: number;
  /** Maximum number of delegations allowed. */
  maxDelegations: number;
  /** Maximum API calls per day. */
  maxApiCallsDaily: number;
}

/** Current usage for a single quota. */
export interface QuotaUsage {
  /** The quota type. */
  type: QuotaType;
  /** Current usage count. */
  current: number;
  /** Maximum allowed. */
  limit: number;
  /** Whether the quota is exceeded. */
  exceeded: boolean;
  /** When this quota period resets (ISO 8601). */
  resetsAt: string;
}

/** Full quota report for an org. */
export interface OrgQuotaReport {
  /** Organization ID. */
  orgId: string;
  /** Individual quota usages. */
  quotas: QuotaUsage[];
  /** Whether any quota is exceeded. */
  anyExceeded: boolean;
}

/** Result of a quota check. */
export interface QuotaCheckResult {
  /** Whether the operation is allowed. */
  allowed: boolean;
  /** The quota that was checked. */
  quotaType: QuotaType;
  /** Current usage after this check. */
  current: number;
  /** Maximum allowed. */
  limit: number;
  /** Seconds until the quota period resets. */
  retryAfter: number;
}

/** Interface for quota counter storage. */
export interface OrgQuotaStore {
  /** Get current usage for a quota. Returns 0 if not found. */
  getUsage(orgId: string, quotaType: QuotaType, periodKey: string): Promise<number>;
  /** Increment usage counter. Returns the new count. */
  incrementUsage(orgId: string, quotaType: QuotaType, periodKey: string): Promise<number>;
  /** Set usage to an absolute value (for non-counter quotas like discovered_users). */
  setUsage(orgId: string, quotaType: QuotaType, periodKey: string, value: number): Promise<void>;
  /** Get org quota configuration. Returns null if using defaults. */
  getOrgQuotaConfig(orgId: string): Promise<OrgQuotaConfig | null>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default quota configuration for new orgs. */
export const DEFAULT_ORG_QUOTAS: OrgQuotaConfig = {
  maxDiscoveredUsers: 500,
  maxDelegations: 10,
  maxApiCallsDaily: 10000,
} as const;

// ---------------------------------------------------------------------------
// Period key computation
// ---------------------------------------------------------------------------

/**
 * Compute the daily period key for quota tracking.
 * Format: YYYY-MM-DD (UTC)
 */
export function computeDailyPeriodKey(nowMs: number = Date.now()): string {
  const date = new Date(nowMs);
  return date.toISOString().split("T")[0];
}

/**
 * Compute the monthly period key for quota tracking.
 * Format: YYYY-MM (UTC)
 */
export function computeMonthlyPeriodKey(nowMs: number = Date.now()): string {
  const date = new Date(nowMs);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

/**
 * Compute when the daily period resets (next midnight UTC).
 * Returns an ISO 8601 timestamp.
 */
export function computeDailyResetTime(nowMs: number = Date.now()): string {
  const date = new Date(nowMs);
  const tomorrow = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() + 1,
    0, 0, 0, 0,
  ));
  return tomorrow.toISOString();
}

/**
 * Compute seconds until the daily period resets.
 */
export function computeDailyRetryAfter(nowMs: number = Date.now()): number {
  const resetTime = new Date(computeDailyResetTime(nowMs)).getTime();
  return Math.max(0, Math.ceil((resetTime - nowMs) / 1000));
}

/**
 * Get the period key for a given quota type.
 * - discovered_users and delegations use "lifetime" (no reset)
 * - api_calls_daily uses daily period key
 */
export function getPeriodKeyForQuota(
  quotaType: QuotaType,
  nowMs: number = Date.now(),
): string {
  switch (quotaType) {
    case "api_calls_daily":
      return computeDailyPeriodKey(nowMs);
    case "discovered_users":
    case "delegations":
      // These are absolute counts, not periodic
      return "lifetime";
  }
}

/**
 * Get the reset time for a given quota type.
 */
export function getResetTimeForQuota(
  quotaType: QuotaType,
  nowMs: number = Date.now(),
): string {
  switch (quotaType) {
    case "api_calls_daily":
      return computeDailyResetTime(nowMs);
    case "discovered_users":
    case "delegations":
      // These don't reset -- return far future
      return "9999-12-31T23:59:59.999Z";
  }
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/**
 * Get the quota limit for a specific quota type from config.
 */
export function getQuotaLimit(
  config: OrgQuotaConfig,
  quotaType: QuotaType,
): number {
  switch (quotaType) {
    case "discovered_users":
      return config.maxDiscoveredUsers;
    case "delegations":
      return config.maxDelegations;
    case "api_calls_daily":
      return config.maxApiCallsDaily;
  }
}

/**
 * Check if a quota allows an operation.
 *
 * For counter-based quotas (api_calls_daily), this increments the counter.
 * For absolute quotas (discovered_users, delegations), it only checks.
 *
 * @param store - Quota storage
 * @param orgId - Organization identifier
 * @param quotaType - Which quota to check
 * @param config - Per-org quota configuration (uses defaults if not provided)
 * @param nowMs - Current time in milliseconds (for testing)
 * @returns QuotaCheckResult indicating whether the operation is allowed
 */
export async function checkQuota(
  store: OrgQuotaStore,
  orgId: string,
  quotaType: QuotaType,
  config?: OrgQuotaConfig,
  nowMs: number = Date.now(),
): Promise<QuotaCheckResult> {
  const effectiveConfig = config ?? (await store.getOrgQuotaConfig(orgId)) ?? DEFAULT_ORG_QUOTAS;
  const limit = getQuotaLimit(effectiveConfig, quotaType);
  const periodKey = getPeriodKeyForQuota(quotaType, nowMs);

  const current = await store.getUsage(orgId, quotaType, periodKey);

  if (current >= limit) {
    const retryAfter = quotaType === "api_calls_daily"
      ? computeDailyRetryAfter(nowMs)
      : 0;

    return {
      allowed: false,
      quotaType,
      current,
      limit,
      retryAfter,
    };
  }

  // For counter-based quotas, increment
  let newCount = current;
  if (quotaType === "api_calls_daily") {
    newCount = await store.incrementUsage(orgId, quotaType, periodKey);
  }

  return {
    allowed: true,
    quotaType,
    current: newCount,
    limit,
    retryAfter: 0,
  };
}

/**
 * Get the full quota usage report for an org.
 */
export async function getQuotaReport(
  store: OrgQuotaStore,
  orgId: string,
  config?: OrgQuotaConfig,
  nowMs: number = Date.now(),
): Promise<OrgQuotaReport> {
  const effectiveConfig = config ?? (await store.getOrgQuotaConfig(orgId)) ?? DEFAULT_ORG_QUOTAS;
  const quotaTypes: QuotaType[] = ["discovered_users", "delegations", "api_calls_daily"];

  const quotas: QuotaUsage[] = [];
  let anyExceeded = false;

  for (const quotaType of quotaTypes) {
    const periodKey = getPeriodKeyForQuota(quotaType, nowMs);
    const current = await store.getUsage(orgId, quotaType, periodKey);
    const limit = getQuotaLimit(effectiveConfig, quotaType);
    const exceeded = current >= limit;
    if (exceeded) anyExceeded = true;

    quotas.push({
      type: quotaType,
      current,
      limit,
      exceeded,
      resetsAt: getResetTimeForQuota(quotaType, nowMs),
    });
  }

  return { orgId, quotas, anyExceeded };
}

/**
 * Build a 429 response for quota exceeded.
 */
export function buildQuotaExceededResponse(result: QuotaCheckResult): Response {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (result.retryAfter > 0) {
    headers["Retry-After"] = String(result.retryAfter);
  }

  const body = JSON.stringify({
    ok: false,
    error: {
      code: "QUOTA_EXCEEDED",
      message: `Quota exceeded for ${result.quotaType}. Current: ${result.current}, Limit: ${result.limit}.`,
    },
    meta: {
      request_id: `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      retry_after: result.retryAfter,
      quota_type: result.quotaType,
      current: result.current,
      limit: result.limit,
    },
  });

  return new Response(body, {
    status: 429,
    headers,
  });
}
