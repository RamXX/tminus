/**
 * Feature gate middleware for the T-Minus API.
 *
 * Enforces tier-based access control across API and MCP:
 *   - Account limits per tier (free: 2, premium: 5, enterprise: 10)
 *   - Feature gating (scheduling/constraints: Premium+, VIP/commitments: Enterprise)
 *   - Uses canonical API envelope from shared.ts (error + error_code) with upgrade URL
 *
 * Tier hierarchy: free < premium < enterprise
 *   - "free" users can access "free" features only
 *   - "premium" users can access "free" + "premium" features
 *   - "enterprise" users can access all features
 *
 * Usage:
 *   const denied = await enforceFeatureGate(userId, "premium", env.DB);
 *   if (denied) return denied;
 *
 *   const limited = await enforceAccountLimit(userId, env.DB);
 *   if (limited) return limited;
 */

import { getUserTier } from "../routes/billing";
import { apiErrorResponse } from "../routes/shared";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Subscription tiers in ascending order of access. */
export type FeatureTier = "free" | "premium" | "enterprise";

/** Map of tier to numeric level for comparison. */
const TIER_LEVELS: Record<FeatureTier, number> = {
  free: 0,
  premium: 1,
  enterprise: 2,
};

// ---------------------------------------------------------------------------
// Tier limits
// ---------------------------------------------------------------------------

/** Maximum number of linked accounts per tier. */
export const ACCOUNT_LIMITS: Record<FeatureTier, number> = {
  free: 2,
  premium: 5,
  enterprise: 10,
};

/**
 * Features and the minimum tier required to access them.
 *
 * Used for documentation and programmatic lookup. The enforceFeatureGate
 * function accepts a FeatureTier directly, so callers can also pass
 * the tier requirement inline.
 */
export const FEATURE_TIERS: Record<string, FeatureTier> = {
  // Free tier features
  "accounts.list": "free",
  "accounts.get": "free",
  "events.list": "free",
  "events.get": "free",
  "sync.status": "free",

  // Premium tier features
  "scheduling": "premium",
  "constraints": "premium",
  "constraints.create": "premium",
  "constraints.update": "premium",
  "constraints.delete": "premium",
  "mcp.write": "premium",

  // Enterprise tier features
  "vip": "enterprise",
  "commitments": "enterprise",
  "priority_support": "enterprise",
  "organizations": "enterprise",
};

/** Base URL for upgrade checkout page. */
const UPGRADE_URL = "https://app.tminus.ink/billing/upgrade";

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/**
 * Check if a tier meets the minimum required tier.
 *
 * Pure function -- no I/O. Useful for testing and composing with
 * other checks.
 *
 * @param userTier - The user's current subscription tier.
 * @param requiredTier - The minimum tier needed for the feature.
 * @returns true if access is allowed.
 */
export function isTierSufficient(
  userTier: FeatureTier,
  requiredTier: FeatureTier,
): boolean {
  return TIER_LEVELS[userTier] >= TIER_LEVELS[requiredTier];
}

/**
 * Check feature gate for a user by looking up their subscription
 * tier in D1 and comparing against the required tier.
 *
 * @param userId - The authenticated user's ID.
 * @param requiredTier - The minimum tier needed for this feature.
 * @param db - D1 database binding.
 * @returns true if the user may access the feature.
 */
export async function checkFeatureGate(
  userId: string,
  requiredTier: FeatureTier,
  db: D1Database,
): Promise<boolean> {
  // Free features are always accessible
  if (requiredTier === "free") return true;

  const userTier = await getUserTier(db, userId);
  return isTierSufficient(userTier, requiredTier);
}

/**
 * Get the account count for a user from D1.
 *
 * Counts active (non-revoked) accounts only.
 *
 * @param db - D1 database binding.
 * @param userId - The user ID to count accounts for.
 * @returns The number of active accounts.
 */
export async function getAccountCount(
  db: D1Database,
  userId: string,
): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COUNT(*) as count FROM accounts WHERE user_id = ?1 AND status != 'revoked'",
    )
    .bind(userId)
    .first<{ count: number }>();

  return row?.count ?? 0;
}

/**
 * Check if a user can link another account based on their tier limit.
 *
 * @param userId - The user ID.
 * @param db - D1 database binding.
 * @returns Object with allowed flag and relevant details.
 */
export async function checkAccountLimit(
  userId: string,
  db: D1Database,
): Promise<{
  allowed: boolean;
  currentCount: number;
  limit: number;
  tier: FeatureTier;
}> {
  const tier = await getUserTier(db, userId);
  const currentCount = await getAccountCount(db, userId);
  const limit = ACCOUNT_LIMITS[tier];

  return {
    allowed: currentCount < limit,
    currentCount,
    limit,
    tier,
  };
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

/**
 * Build a 403 TIER_REQUIRED response for feature gate denial.
 *
 * Uses the canonical API envelope format from shared.ts:
 *   - error: human-readable message (string)
 *   - error_code: "TIER_REQUIRED" (string)
 *   - required_tier: the tier needed
 *   - upgrade_url: direct link to upgrade checkout
 *
 * @param requiredTier - The minimum tier needed for the feature.
 * @param currentTier - The user's current tier (optional, for client display).
 * @returns 403 Response with TIER_REQUIRED error.
 */
export function tierRequiredResponse(
  requiredTier: FeatureTier,
  currentTier?: FeatureTier,
): Response {
  return apiErrorResponse(
    "TIER_REQUIRED",
    `This feature requires a ${requiredTier} subscription. Please upgrade to access it.`,
    403,
    {
      required_tier: requiredTier,
      ...(currentTier !== undefined ? { current_tier: currentTier } : {}),
      upgrade_url: `${UPGRADE_URL}?tier=${requiredTier}`,
    },
  );
}

/**
 * Build a 403 TIER_REQUIRED response specifically for account limit denial.
 *
 * Uses the canonical API envelope format from shared.ts.
 * Includes the current account count and limit in the response so clients
 * can display usage information.
 *
 * @param tier - The user's current tier.
 * @param currentCount - Number of accounts the user currently has.
 * @param limit - Maximum accounts allowed for their tier.
 * @returns 403 Response with TIER_REQUIRED error and usage details.
 */
export function accountLimitResponse(
  tier: FeatureTier,
  currentCount: number,
  limit: number,
): Response {
  // Determine the next tier for upgrade
  const nextTier: FeatureTier = tier === "free" ? "premium" : "enterprise";
  const nextLimit = ACCOUNT_LIMITS[nextTier];

  return apiErrorResponse(
    "TIER_REQUIRED",
    `Account limit reached. Your ${tier} plan allows ${limit} accounts (you have ${currentCount}). Upgrade to ${nextTier} for up to ${nextLimit} accounts.`,
    403,
    {
      required_tier: nextTier,
      current_tier: tier,
      upgrade_url: `${UPGRADE_URL}?tier=${nextTier}`,
      usage: {
        accounts: currentCount,
        limit,
      },
    },
  );
}

/**
 * Build a 403 response for feature gate denial.
 *
 * @deprecated Use tierRequiredResponse() instead for new code.
 * Kept for backward compatibility with existing callers.
 */
export function featureGateResponse(requiredTier: FeatureTier): Response {
  return tierRequiredResponse(requiredTier);
}

/**
 * Convenience function that combines the gate check and error response.
 *
 * Returns null if access is allowed, or a 403 Response if denied.
 * Callers can use:
 *
 *   const denied = await enforceFeatureGate(userId, "premium", env.DB);
 *   if (denied) return denied;
 *
 * @param userId - The authenticated user's ID.
 * @param requiredTier - The minimum tier needed.
 * @param db - D1 database binding.
 * @returns null if allowed, or a 403 Response if denied.
 */
export async function enforceFeatureGate(
  userId: string,
  requiredTier: FeatureTier,
  db: D1Database,
): Promise<Response | null> {
  // Free features are always accessible
  if (requiredTier === "free") return null;

  const userTier = await getUserTier(db, userId);
  if (isTierSufficient(userTier, requiredTier)) return null;

  return tierRequiredResponse(requiredTier, userTier);
}

/**
 * Convenience function that checks account limits and returns a 403 if exceeded.
 *
 * Returns null if the user can link another account, or a 403 Response if at limit.
 * Callers can use:
 *
 *   const limited = await enforceAccountLimit(userId, env.DB);
 *   if (limited) return limited;
 *
 * @param userId - The authenticated user's ID.
 * @param db - D1 database binding.
 * @returns null if allowed, or a 403 Response if at account limit.
 */
export async function enforceAccountLimit(
  userId: string,
  db: D1Database,
): Promise<Response | null> {
  const result = await checkAccountLimit(userId, db);
  if (result.allowed) return null;
  return accountLimitResponse(result.tier, result.currentCount, result.limit);
}
