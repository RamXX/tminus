/**
 * Feature gate middleware for the T-Minus API.
 *
 * Checks the user's subscription tier before allowing access to
 * tier-restricted endpoints. The tier is determined by looking up
 * the user's active subscription in D1.
 *
 * Usage pattern:
 *   if (!await checkFeatureGate(userId, "premium", env.DB)) {
 *     return forbiddenResponse();
 *   }
 *
 * Tier hierarchy: free < premium < enterprise
 *   - "free" users can access "free" features only
 *   - "premium" users can access "free" + "premium" features
 *   - "enterprise" users can access all features
 */

import { getUserTier } from "../routes/billing";

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

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

/**
 * Build a 403 response for feature gate denial.
 *
 * Follows the T-Minus API envelope format and includes the
 * required tier so clients can prompt the user to upgrade.
 */
export function featureGateResponse(requiredTier: FeatureTier): Response {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return new Response(
    JSON.stringify({
      ok: false,
      error: {
        code: "FEATURE_GATE",
        message: `This feature requires a ${requiredTier} subscription. Please upgrade to access it.`,
      },
      required_tier: requiredTier,
      meta: {
        request_id: `req_${ts}_${rand}`,
        timestamp: new Date().toISOString(),
      },
    }),
    { status: 403, headers: { "Content-Type": "application/json" } },
  );
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
  const allowed = await checkFeatureGate(userId, requiredTier, db);
  if (allowed) return null;
  return featureGateResponse(requiredTier);
}
