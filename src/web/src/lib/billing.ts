/**
 * Billing domain logic for the T-Minus SPA.
 *
 * Pure functions for plan display, usage calculation, and tier comparison.
 * These are extracted from the component for testability and reuse.
 *
 * Tier hierarchy: free < premium < enterprise
 * Account limits: free=2, premium=5, enterprise=10
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Valid subscription tiers. Mirrors server-side SubscriptionTier. */
export type BillingTier = "free" | "premium" | "enterprise";

/** Billing subscription status. Mirrors server-side BillingSubscriptionStatus. */
export type BillingStatus = "active" | "past_due" | "cancelled" | "unpaid" | "trialing" | "none";

/** Subscription details returned by GET /v1/billing/status. */
export interface BillingSubscription {
  subscription_id: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  current_period_end: string | null;
  grace_period_end: string | null;
  cancel_at_period_end: boolean;
  previous_tier: BillingTier | null;
  created_at: string;
  updated_at: string;
}

/** Response shape from GET /v1/billing/status. */
export interface BillingStatusResponse {
  tier: BillingTier;
  status: BillingStatus;
  subscription: BillingSubscription | null;
}

/** Response shape from POST /v1/billing/checkout. */
export interface CheckoutResponse {
  session_id: string;
  checkout_url: string;
}

/** Response shape from POST /v1/billing/portal. */
export interface PortalResponse {
  portal_url: string;
}

/** Billing event for billing history display. */
export interface BillingEvent {
  event_id: string;
  event_type: string;
  old_tier: BillingTier | null;
  new_tier: BillingTier | null;
  old_status: BillingStatus | null;
  new_status: BillingStatus | null;
  created_at: string;
}

/** Plan definition for the comparison table. */
export interface PlanDefinition {
  tier: BillingTier;
  name: string;
  price: string;
  accountLimit: number;
  features: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Account limits per tier. Mirrors ACCOUNT_LIMITS from feature-gate.ts. */
export const ACCOUNT_LIMITS: Record<BillingTier, number> = {
  free: 2,
  premium: 5,
  enterprise: 10,
};

/** Tier numeric levels for comparison. */
const TIER_LEVELS: Record<BillingTier, number> = {
  free: 0,
  premium: 1,
  enterprise: 2,
};

/** Plan definitions for the comparison table (AC#5). */
export const PLANS: PlanDefinition[] = [
  {
    tier: "free",
    name: "Free",
    price: "$0/mo",
    accountLimit: 2,
    features: [
      "2 calendar accounts",
      "Event sync",
      "Sync status dashboard",
      "Basic policies",
    ],
  },
  {
    tier: "premium",
    name: "Premium",
    price: "$9/mo",
    accountLimit: 5,
    features: [
      "5 calendar accounts",
      "Everything in Free",
      "Scheduling constraints",
      "Buffer time rules",
      "MCP write access",
    ],
  },
  {
    tier: "enterprise",
    name: "Enterprise",
    price: "$29/mo",
    accountLimit: 10,
    features: [
      "10 calendar accounts",
      "Everything in Premium",
      "VIP contact management",
      "Commitment tracking",
      "Priority support",
    ],
  },
];

/** Stripe price IDs for each tier. Used when creating checkout sessions. */
export const STRIPE_PRICE_IDS: Record<Exclude<BillingTier, "free">, string> = {
  premium: "price_premium_monthly",
  enterprise: "price_enterprise_monthly",
};

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

/**
 * Get the human-readable label for a tier.
 */
export function tierLabel(tier: BillingTier): string {
  const labels: Record<BillingTier, string> = {
    free: "Free",
    premium: "Premium",
    enterprise: "Enterprise",
  };
  return labels[tier] ?? tier;
}

/**
 * Get the human-readable label for a billing status.
 */
export function statusLabel(status: BillingStatus): string {
  const labels: Record<BillingStatus, string> = {
    active: "Active",
    past_due: "Past Due",
    cancelled: "Cancelled",
    unpaid: "Unpaid",
    trialing: "Trialing",
    none: "No subscription",
  };
  return labels[status] ?? status;
}

/**
 * Get the color for a billing status indicator.
 */
export function statusColor(status: BillingStatus): string {
  const colors: Record<BillingStatus, string> = {
    active: "#16a34a",
    past_due: "#ca8a04",
    cancelled: "#64748b",
    unpaid: "#dc2626",
    trialing: "#3b82f6",
    none: "#64748b",
  };
  return colors[status] ?? "#64748b";
}

/**
 * Compare two tiers numerically.
 * Returns positive if newTier > oldTier (upgrade),
 * negative if newTier < oldTier (downgrade),
 * zero if equal.
 */
export function compareTiers(oldTier: BillingTier, newTier: BillingTier): number {
  return (TIER_LEVELS[newTier] ?? 0) - (TIER_LEVELS[oldTier] ?? 0);
}

/**
 * Determine if changing from currentTier to targetTier is an upgrade.
 */
export function isUpgrade(currentTier: BillingTier, targetTier: BillingTier): boolean {
  return compareTiers(currentTier, targetTier) > 0;
}

/**
 * Determine if changing from currentTier to targetTier is a downgrade.
 */
export function isDowngrade(currentTier: BillingTier, targetTier: BillingTier): boolean {
  return compareTiers(currentTier, targetTier) < 0;
}

/**
 * Calculate the usage percentage (accounts used / limit).
 * Returns a value between 0 and 100.
 */
export function usagePercentage(accountsUsed: number, tier: BillingTier): number {
  const limit = ACCOUNT_LIMITS[tier];
  if (limit === 0) return 100;
  return Math.min(100, Math.round((accountsUsed / limit) * 100));
}

/**
 * Get the account limit for a tier.
 */
export function getAccountLimit(tier: BillingTier): number {
  return ACCOUNT_LIMITS[tier];
}

/**
 * Determine the upgrade button state based on current tier and status.
 *
 * Returns:
 * - "upgrade" if the user can upgrade to a higher tier
 * - "at_max" if the user is already on the highest tier
 * - "disabled" if the subscription is in a non-upgradeable state (past_due, unpaid)
 */
export function upgradeButtonState(
  tier: BillingTier,
  status: BillingStatus,
): "upgrade" | "at_max" | "disabled" {
  // Can't upgrade if payment issues
  if (status === "past_due" || status === "unpaid") {
    return "disabled";
  }
  // Already at highest tier
  if (tier === "enterprise") {
    return "at_max";
  }
  return "upgrade";
}

/**
 * Get the next tier above the current one (for upgrade).
 * Returns null if already at the highest tier.
 */
export function nextTier(currentTier: BillingTier): BillingTier | null {
  if (currentTier === "free") return "premium";
  if (currentTier === "premium") return "enterprise";
  return null;
}

/**
 * Get the plan definition for a specific tier.
 */
export function getPlanDefinition(tier: BillingTier): PlanDefinition {
  return PLANS.find((p) => p.tier === tier) ?? PLANS[0];
}

/**
 * Format a billing event type for human display.
 */
export function formatEventType(eventType: string): string {
  const labels: Record<string, string> = {
    checkout_completed: "Subscription created",
    subscription_upgraded: "Plan upgraded",
    subscription_downgraded: "Plan downgraded",
    subscription_renewed: "Subscription renewed",
    subscription_cancelled: "Subscription cancelled",
    subscription_deleted: "Subscription ended",
    payment_failed: "Payment failed",
    payment_recovered: "Payment recovered",
    grace_period_started: "Grace period started",
    grace_period_expired: "Grace period expired",
  };
  return labels[eventType] ?? eventType.replace(/_/g, " ");
}

/**
 * Format a date string for billing display.
 * Uses a short date format: "Feb 15, 2026".
 */
export function formatBillingDate(isoDate: string): string {
  try {
    const date = new Date(isoDate);
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return isoDate;
  }
}
