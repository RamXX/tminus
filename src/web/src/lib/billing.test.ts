/**
 * Unit tests for billing domain logic.
 *
 * Covers: tier comparison, usage calculation, upgrade button state,
 * plan definitions, display helpers, date formatting.
 */
import { describe, it, expect } from "vitest";
import {
  tierLabel,
  statusLabel,
  statusColor,
  compareTiers,
  isUpgrade,
  isDowngrade,
  usagePercentage,
  getAccountLimit,
  upgradeButtonState,
  nextTier,
  getPlanDefinition,
  formatEventType,
  formatBillingDate,
  ACCOUNT_LIMITS,
  PLANS,
  STRIPE_PRICE_IDS,
  type BillingTier,
  type BillingStatus,
} from "./billing";

// ---------------------------------------------------------------------------
// Unit Tests: Tier Comparison
// ---------------------------------------------------------------------------

describe("tier comparison", () => {
  it("compareTiers returns positive for upgrade", () => {
    expect(compareTiers("free", "premium")).toBeGreaterThan(0);
    expect(compareTiers("free", "enterprise")).toBeGreaterThan(0);
    expect(compareTiers("premium", "enterprise")).toBeGreaterThan(0);
  });

  it("compareTiers returns negative for downgrade", () => {
    expect(compareTiers("premium", "free")).toBeLessThan(0);
    expect(compareTiers("enterprise", "free")).toBeLessThan(0);
    expect(compareTiers("enterprise", "premium")).toBeLessThan(0);
  });

  it("compareTiers returns zero for same tier", () => {
    expect(compareTiers("free", "free")).toBe(0);
    expect(compareTiers("premium", "premium")).toBe(0);
    expect(compareTiers("enterprise", "enterprise")).toBe(0);
  });

  it("isUpgrade returns true for higher tier", () => {
    expect(isUpgrade("free", "premium")).toBe(true);
    expect(isUpgrade("free", "enterprise")).toBe(true);
    expect(isUpgrade("premium", "enterprise")).toBe(true);
  });

  it("isUpgrade returns false for same or lower tier", () => {
    expect(isUpgrade("premium", "free")).toBe(false);
    expect(isUpgrade("premium", "premium")).toBe(false);
    expect(isUpgrade("enterprise", "premium")).toBe(false);
  });

  it("isDowngrade returns true for lower tier", () => {
    expect(isDowngrade("premium", "free")).toBe(true);
    expect(isDowngrade("enterprise", "premium")).toBe(true);
    expect(isDowngrade("enterprise", "free")).toBe(true);
  });

  it("isDowngrade returns false for same or higher tier", () => {
    expect(isDowngrade("free", "premium")).toBe(false);
    expect(isDowngrade("free", "free")).toBe(false);
    expect(isDowngrade("premium", "enterprise")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unit Tests: Usage Calculation
// ---------------------------------------------------------------------------

describe("usage calculation", () => {
  it("usagePercentage returns correct percentage", () => {
    expect(usagePercentage(1, "free")).toBe(50); // 1/2 = 50%
    expect(usagePercentage(2, "free")).toBe(100); // 2/2 = 100%
    expect(usagePercentage(0, "free")).toBe(0); // 0/2 = 0%
  });

  it("usagePercentage caps at 100", () => {
    expect(usagePercentage(3, "free")).toBe(100); // 3/2 = 150% -> capped at 100
  });

  it("usagePercentage works for premium tier", () => {
    expect(usagePercentage(3, "premium")).toBe(60); // 3/5 = 60%
    expect(usagePercentage(5, "premium")).toBe(100); // 5/5 = 100%
  });

  it("usagePercentage works for enterprise tier", () => {
    expect(usagePercentage(7, "enterprise")).toBe(70); // 7/10 = 70%
    expect(usagePercentage(10, "enterprise")).toBe(100); // 10/10 = 100%
  });

  it("getAccountLimit returns correct limits", () => {
    expect(getAccountLimit("free")).toBe(2);
    expect(getAccountLimit("premium")).toBe(5);
    expect(getAccountLimit("enterprise")).toBe(10);
  });

  it("ACCOUNT_LIMITS matches expected values", () => {
    expect(ACCOUNT_LIMITS).toEqual({
      free: 2,
      premium: 5,
      enterprise: 10,
    });
  });
});

// ---------------------------------------------------------------------------
// Unit Tests: Upgrade Button State
// ---------------------------------------------------------------------------

describe("upgrade button state", () => {
  it('returns "upgrade" for free tier with active status', () => {
    expect(upgradeButtonState("free", "active")).toBe("upgrade");
  });

  it('returns "upgrade" for free tier with no subscription', () => {
    expect(upgradeButtonState("free", "none")).toBe("upgrade");
  });

  it('returns "upgrade" for premium tier with active status', () => {
    expect(upgradeButtonState("premium", "active")).toBe("upgrade");
  });

  it('returns "at_max" for enterprise tier', () => {
    expect(upgradeButtonState("enterprise", "active")).toBe("at_max");
  });

  it('returns "at_max" for enterprise with no subscription', () => {
    expect(upgradeButtonState("enterprise", "none")).toBe("at_max");
  });

  it('returns "disabled" for past_due status', () => {
    expect(upgradeButtonState("free", "past_due")).toBe("disabled");
    expect(upgradeButtonState("premium", "past_due")).toBe("disabled");
  });

  it('returns "disabled" for unpaid status', () => {
    expect(upgradeButtonState("free", "unpaid")).toBe("disabled");
    expect(upgradeButtonState("premium", "unpaid")).toBe("disabled");
  });

  it('returns "upgrade" for trialing status', () => {
    expect(upgradeButtonState("free", "trialing")).toBe("upgrade");
    expect(upgradeButtonState("premium", "trialing")).toBe("upgrade");
  });
});

// ---------------------------------------------------------------------------
// Unit Tests: Next Tier
// ---------------------------------------------------------------------------

describe("next tier", () => {
  it("returns premium for free", () => {
    expect(nextTier("free")).toBe("premium");
  });

  it("returns enterprise for premium", () => {
    expect(nextTier("premium")).toBe("enterprise");
  });

  it("returns null for enterprise (already at max)", () => {
    expect(nextTier("enterprise")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Unit Tests: Display Helpers
// ---------------------------------------------------------------------------

describe("display helpers", () => {
  it("tierLabel returns human-readable tier names", () => {
    expect(tierLabel("free")).toBe("Free");
    expect(tierLabel("premium")).toBe("Premium");
    expect(tierLabel("enterprise")).toBe("Enterprise");
  });

  it("statusLabel returns human-readable status names", () => {
    expect(statusLabel("active")).toBe("Active");
    expect(statusLabel("past_due")).toBe("Past Due");
    expect(statusLabel("cancelled")).toBe("Cancelled");
    expect(statusLabel("unpaid")).toBe("Unpaid");
    expect(statusLabel("trialing")).toBe("Trialing");
    expect(statusLabel("none")).toBe("No subscription");
  });

  it("statusColor returns correct colors for each status", () => {
    expect(statusColor("active")).toBe("#16a34a");
    expect(statusColor("past_due")).toBe("#ca8a04");
    expect(statusColor("cancelled")).toBe("#64748b");
    expect(statusColor("unpaid")).toBe("#dc2626");
    expect(statusColor("trialing")).toBe("#3b82f6");
    expect(statusColor("none")).toBe("#64748b");
  });
});

// ---------------------------------------------------------------------------
// Unit Tests: Plan Definitions
// ---------------------------------------------------------------------------

describe("plan definitions", () => {
  it("PLANS has exactly 3 tiers", () => {
    expect(PLANS).toHaveLength(3);
  });

  it("PLANS are in ascending order (free, premium, enterprise)", () => {
    expect(PLANS[0].tier).toBe("free");
    expect(PLANS[1].tier).toBe("premium");
    expect(PLANS[2].tier).toBe("enterprise");
  });

  it("each plan has name, price, accountLimit, and features", () => {
    for (const plan of PLANS) {
      expect(plan.name).toBeTruthy();
      expect(plan.price).toBeTruthy();
      expect(plan.accountLimit).toBeGreaterThan(0);
      expect(plan.features.length).toBeGreaterThan(0);
    }
  });

  it("plan account limits match ACCOUNT_LIMITS", () => {
    for (const plan of PLANS) {
      expect(plan.accountLimit).toBe(ACCOUNT_LIMITS[plan.tier]);
    }
  });

  it("getPlanDefinition returns correct plan", () => {
    const premiumPlan = getPlanDefinition("premium");
    expect(premiumPlan.tier).toBe("premium");
    expect(premiumPlan.name).toBe("Premium");
  });

  it("STRIPE_PRICE_IDS has premium and enterprise", () => {
    expect(STRIPE_PRICE_IDS.premium).toBe("price_premium_monthly");
    expect(STRIPE_PRICE_IDS.enterprise).toBe("price_enterprise_monthly");
  });
});

// ---------------------------------------------------------------------------
// Unit Tests: Billing Event Formatting
// ---------------------------------------------------------------------------

describe("billing event formatting", () => {
  it("formatEventType returns human-readable event labels", () => {
    expect(formatEventType("checkout_completed")).toBe("Subscription created");
    expect(formatEventType("subscription_upgraded")).toBe("Plan upgraded");
    expect(formatEventType("subscription_downgraded")).toBe("Plan downgraded");
    expect(formatEventType("payment_failed")).toBe("Payment failed");
    expect(formatEventType("payment_recovered")).toBe("Payment recovered");
  });

  it("formatEventType handles unknown event types gracefully", () => {
    expect(formatEventType("some_future_event")).toBe("some future event");
  });

  it("formatBillingDate formats ISO dates correctly", () => {
    const formatted = formatBillingDate("2026-02-15T12:00:00Z");
    expect(formatted).toContain("Feb");
    expect(formatted).toContain("15");
    expect(formatted).toContain("2026");
  });

  it("formatBillingDate handles invalid dates gracefully", () => {
    const result = formatBillingDate("not-a-date");
    // Should return the original string or a fallback
    expect(typeof result).toBe("string");
  });
});
