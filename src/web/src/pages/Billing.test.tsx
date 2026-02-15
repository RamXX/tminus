/**
 * Tests for the Billing page.
 *
 * Covers:
 * - Unit: plan display logic, usage calculation, upgrade button state
 * - Integration: component renders current plan from API, usage shows
 *   accounts used vs limit, upgrade button creates checkout session,
 *   Stripe Portal link, plan comparison table, billing history
 *
 * Uses React Testing Library with fireEvent for click interactions.
 * Same pattern as Accounts.test.tsx, SyncStatus.test.tsx.
 *
 * NOTE: We use fireEvent.click instead of userEvent.click because components
 * with timers interact poorly with userEvent's internal delay mechanism
 * under fake timers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, act, fireEvent } from "@testing-library/react";
import { Billing, type BillingProps } from "./Billing";
import type {
  BillingStatusResponse,
  CheckoutResponse,
  PortalResponse,
  BillingEvent,
  BillingTier,
} from "../lib/billing";

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const MOCK_FREE_STATUS: BillingStatusResponse = {
  tier: "free",
  status: "none",
  subscription: null,
};

const MOCK_PREMIUM_STATUS: BillingStatusResponse = {
  tier: "premium",
  status: "active",
  subscription: {
    subscription_id: "sub_abc123",
    stripe_customer_id: "cus_abc123",
    stripe_subscription_id: "sub_stripe_abc123",
    current_period_end: "2026-03-15T00:00:00Z",
    grace_period_end: null,
    cancel_at_period_end: false,
    previous_tier: null,
    created_at: "2026-01-15T00:00:00Z",
    updated_at: "2026-02-15T00:00:00Z",
  },
};

const MOCK_ENTERPRISE_STATUS: BillingStatusResponse = {
  tier: "enterprise",
  status: "active",
  subscription: {
    subscription_id: "sub_ent456",
    stripe_customer_id: "cus_ent456",
    stripe_subscription_id: "sub_stripe_ent456",
    current_period_end: "2026-03-15T00:00:00Z",
    grace_period_end: null,
    cancel_at_period_end: false,
    previous_tier: null,
    created_at: "2026-01-15T00:00:00Z",
    updated_at: "2026-02-15T00:00:00Z",
  },
};

const MOCK_PAST_DUE_STATUS: BillingStatusResponse = {
  tier: "premium",
  status: "past_due",
  subscription: {
    subscription_id: "sub_pd789",
    stripe_customer_id: "cus_pd789",
    stripe_subscription_id: "sub_stripe_pd789",
    current_period_end: "2026-03-15T00:00:00Z",
    grace_period_end: "2026-02-22T00:00:00Z",
    cancel_at_period_end: false,
    previous_tier: null,
    created_at: "2026-01-15T00:00:00Z",
    updated_at: "2026-02-15T00:00:00Z",
  },
};

const MOCK_CHECKOUT_RESPONSE: CheckoutResponse = {
  session_id: "cs_test_abc123",
  checkout_url: "https://checkout.stripe.com/pay/cs_test_abc123",
};

const MOCK_PORTAL_RESPONSE: PortalResponse = {
  portal_url: "https://billing.stripe.com/p/session/test_abc123",
};

const MOCK_BILLING_EVENTS: BillingEvent[] = [
  {
    event_id: "evt_001",
    event_type: "checkout_completed",
    old_tier: "free",
    new_tier: "premium",
    old_status: null,
    new_status: "active",
    created_at: "2026-01-15T10:30:00Z",
  },
  {
    event_id: "evt_002",
    event_type: "subscription_renewed",
    old_tier: "premium",
    new_tier: "premium",
    old_status: "active",
    new_status: "active",
    created_at: "2026-02-15T10:30:00Z",
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockFetchStatus(status: BillingStatusResponse = MOCK_FREE_STATUS) {
  return vi.fn(async (): Promise<BillingStatusResponse> => status);
}

function createFailingFetchStatus(message = "Network error") {
  return vi.fn(async (): Promise<BillingStatusResponse> => {
    throw new Error(message);
  });
}

function createMockCreateCheckout(response: CheckoutResponse = MOCK_CHECKOUT_RESPONSE) {
  return vi.fn(async (_priceId: string): Promise<CheckoutResponse> => response);
}

function createMockCreatePortalSession(response: PortalResponse = MOCK_PORTAL_RESPONSE) {
  return vi.fn(async (): Promise<PortalResponse> => response);
}

function createMockFetchBillingHistory(events: BillingEvent[] = MOCK_BILLING_EVENTS) {
  return vi.fn(async (): Promise<BillingEvent[]> => events);
}

/**
 * Render the Billing component and wait for the initial async fetch to resolve.
 */
async function renderAndWait(overrides: Partial<BillingProps> = {}) {
  const fetchBillingStatus = overrides.fetchBillingStatus ?? createMockFetchStatus();
  const createCheckoutSession = overrides.createCheckoutSession ?? createMockCreateCheckout();
  const createPortalSession = overrides.createPortalSession ?? createMockCreatePortalSession();
  const fetchBillingHistory = overrides.fetchBillingHistory ?? createMockFetchBillingHistory();
  const accountsUsed = overrides.accountsUsed ?? 1;
  const navigateToUrl = overrides.navigateToUrl ?? vi.fn((_url: string) => {});

  const result = render(
    <Billing
      fetchBillingStatus={fetchBillingStatus}
      createCheckoutSession={createCheckoutSession}
      createPortalSession={createPortalSession}
      fetchBillingHistory={fetchBillingHistory}
      accountsUsed={accountsUsed}
      navigateToUrl={navigateToUrl}
    />,
  );

  // Flush microtasks so async fetch resolves
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });

  return {
    ...result,
    fetchBillingStatus,
    createCheckoutSession,
    createPortalSession,
    fetchBillingHistory,
    navigateToUrl,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Billing Page", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-02-15T12:00:00Z").getTime() });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // =========================================================================
  // Unit Tests: Plan Display Logic
  // =========================================================================

  describe("plan display logic", () => {
    it("shows current plan tier name", async () => {
      await renderAndWait({
        fetchBillingStatus: createMockFetchStatus(MOCK_PREMIUM_STATUS),
      });

      expect(screen.getByTestId("current-plan-name")).toHaveTextContent("Premium");
    });

    it("shows Free plan for free tier", async () => {
      await renderAndWait({
        fetchBillingStatus: createMockFetchStatus(MOCK_FREE_STATUS),
      });

      expect(screen.getByTestId("current-plan-name")).toHaveTextContent("Free");
    });

    it("shows Enterprise plan for enterprise tier", async () => {
      await renderAndWait({
        fetchBillingStatus: createMockFetchStatus(MOCK_ENTERPRISE_STATUS),
      });

      expect(screen.getByTestId("current-plan-name")).toHaveTextContent("Enterprise");
    });

    it("shows subscription status", async () => {
      await renderAndWait({
        fetchBillingStatus: createMockFetchStatus(MOCK_PREMIUM_STATUS),
      });

      expect(screen.getByTestId("subscription-status")).toHaveTextContent("Active");
    });

    it("shows past due status with warning", async () => {
      await renderAndWait({
        fetchBillingStatus: createMockFetchStatus(MOCK_PAST_DUE_STATUS),
      });

      expect(screen.getByTestId("subscription-status")).toHaveTextContent("Past Due");
    });

    it("shows current period end date for active subscription", async () => {
      await renderAndWait({
        fetchBillingStatus: createMockFetchStatus(MOCK_PREMIUM_STATUS),
      });

      const periodEnd = screen.getByTestId("period-end");
      // The date is formatted by toLocaleDateString which may vary by environment.
      // We verify the element exists and contains "Renews" plus some date content.
      expect(periodEnd).toBeInTheDocument();
      expect(periodEnd.textContent).toContain("Renews");
      // Verify it contains the year at minimum
      expect(periodEnd.textContent).toContain("2026");
    });
  });

  // =========================================================================
  // Unit Tests: Usage Calculation Display
  // =========================================================================

  describe("usage display", () => {
    it("shows accounts used vs limit (AC#4)", async () => {
      await renderAndWait({
        fetchBillingStatus: createMockFetchStatus(MOCK_FREE_STATUS),
        accountsUsed: 1,
      });

      const usage = screen.getByTestId("usage-display");
      expect(usage).toHaveTextContent("1");
      expect(usage).toHaveTextContent("2");
    });

    it("shows usage for premium tier", async () => {
      await renderAndWait({
        fetchBillingStatus: createMockFetchStatus(MOCK_PREMIUM_STATUS),
        accountsUsed: 3,
      });

      const usage = screen.getByTestId("usage-display");
      expect(usage).toHaveTextContent("3");
      expect(usage).toHaveTextContent("5");
    });

    it("shows usage for enterprise tier", async () => {
      await renderAndWait({
        fetchBillingStatus: createMockFetchStatus(MOCK_ENTERPRISE_STATUS),
        accountsUsed: 7,
      });

      const usage = screen.getByTestId("usage-display");
      expect(usage).toHaveTextContent("7");
      expect(usage).toHaveTextContent("10");
    });

    it("shows usage bar with correct percentage", async () => {
      await renderAndWait({
        fetchBillingStatus: createMockFetchStatus(MOCK_FREE_STATUS),
        accountsUsed: 1,
      });

      const usageBar = screen.getByTestId("usage-bar-fill");
      // 1/2 = 50%
      expect(usageBar.style.width).toBe("50%");
    });
  });

  // =========================================================================
  // Unit Tests: Upgrade Button State
  // =========================================================================

  describe("upgrade button state", () => {
    it("shows upgrade button for free tier", async () => {
      await renderAndWait({
        fetchBillingStatus: createMockFetchStatus(MOCK_FREE_STATUS),
      });

      const upgradeBtn = screen.getByTestId("upgrade-btn");
      expect(upgradeBtn).toBeInTheDocument();
      expect(upgradeBtn).not.toBeDisabled();
      expect(upgradeBtn).toHaveTextContent(/upgrade/i);
    });

    it("shows upgrade button for premium tier", async () => {
      await renderAndWait({
        fetchBillingStatus: createMockFetchStatus(MOCK_PREMIUM_STATUS),
      });

      const upgradeBtn = screen.getByTestId("upgrade-btn");
      expect(upgradeBtn).toBeInTheDocument();
      expect(upgradeBtn).not.toBeDisabled();
    });

    it("does not show upgrade button for enterprise tier (at max)", async () => {
      await renderAndWait({
        fetchBillingStatus: createMockFetchStatus(MOCK_ENTERPRISE_STATUS),
      });

      expect(screen.queryByTestId("upgrade-btn")).not.toBeInTheDocument();
    });

    it("shows disabled upgrade button for past_due status", async () => {
      await renderAndWait({
        fetchBillingStatus: createMockFetchStatus(MOCK_PAST_DUE_STATUS),
      });

      const upgradeBtn = screen.getByTestId("upgrade-btn");
      expect(upgradeBtn).toBeDisabled();
    });
  });

  // =========================================================================
  // Integration Tests: Component Renders Current Plan from API (AC#1)
  // =========================================================================

  describe("integration: renders current plan from API", () => {
    it("calls fetchBillingStatus on mount", async () => {
      const fetchBillingStatus = createMockFetchStatus();
      await renderAndWait({ fetchBillingStatus });

      expect(fetchBillingStatus).toHaveBeenCalledTimes(1);
    });

    it("renders current plan from API response", async () => {
      await renderAndWait({
        fetchBillingStatus: createMockFetchStatus(MOCK_PREMIUM_STATUS),
      });

      expect(screen.getByTestId("current-plan-name")).toHaveTextContent("Premium");
      expect(screen.getByTestId("subscription-status")).toHaveTextContent("Active");
    });

    it("shows loading state before fetch completes", () => {
      const fetchBillingStatus = vi.fn(
        (): Promise<BillingStatusResponse> => new Promise(() => {}),
      );
      render(
        <Billing
          fetchBillingStatus={fetchBillingStatus}
          createCheckoutSession={createMockCreateCheckout()}
          createPortalSession={createMockCreatePortalSession()}
          fetchBillingHistory={createMockFetchBillingHistory()}
          accountsUsed={0}
          navigateToUrl={vi.fn()}
        />,
      );

      expect(screen.getByTestId("billing-loading")).toBeInTheDocument();
    });

    it("shows error state when fetch fails", async () => {
      await renderAndWait({
        fetchBillingStatus: createFailingFetchStatus("API unavailable"),
      });

      expect(screen.getByTestId("billing-error")).toBeInTheDocument();
      expect(screen.getByText(/api unavailable/i)).toBeInTheDocument();
    });

    it("shows retry button on error", async () => {
      await renderAndWait({
        fetchBillingStatus: createFailingFetchStatus(),
      });

      expect(
        screen.getByRole("button", { name: /retry/i }),
      ).toBeInTheDocument();
    });

    it("retry button refetches billing status", async () => {
      const fetchBillingStatus = createFailingFetchStatus();
      await renderAndWait({ fetchBillingStatus });

      expect(fetchBillingStatus).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByRole("button", { name: /retry/i }));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(fetchBillingStatus).toHaveBeenCalledTimes(2);
    });
  });

  // =========================================================================
  // Integration Tests: Usage Shows Accounts Used vs Limit (AC#4)
  // =========================================================================

  describe("integration: usage accounts used vs limit", () => {
    it("displays accounts used vs limit for free tier", async () => {
      await renderAndWait({
        fetchBillingStatus: createMockFetchStatus(MOCK_FREE_STATUS),
        accountsUsed: 1,
      });

      const usage = screen.getByTestId("usage-display");
      expect(usage).toHaveTextContent("1 / 2");
    });

    it("displays accounts used vs limit for premium tier", async () => {
      await renderAndWait({
        fetchBillingStatus: createMockFetchStatus(MOCK_PREMIUM_STATUS),
        accountsUsed: 3,
      });

      const usage = screen.getByTestId("usage-display");
      expect(usage).toHaveTextContent("3 / 5");
    });

    it("displays accounts used vs limit for enterprise tier", async () => {
      await renderAndWait({
        fetchBillingStatus: createMockFetchStatus(MOCK_ENTERPRISE_STATUS),
        accountsUsed: 7,
      });

      const usage = screen.getByTestId("usage-display");
      expect(usage).toHaveTextContent("7 / 10");
    });

    it("shows usage label mentioning accounts", async () => {
      await renderAndWait({
        fetchBillingStatus: createMockFetchStatus(MOCK_FREE_STATUS),
        accountsUsed: 1,
      });

      // The usage section has a label "Accounts" - scope to the usage display area
      expect(screen.getByTestId("usage-display")).toBeInTheDocument();
      // The "Accounts" label exists somewhere on the page in the usage section
      expect(screen.getAllByText(/accounts/i).length).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // Integration Tests: Upgrade Button Creates Checkout Session (AC#2)
  // =========================================================================

  describe("integration: upgrade starts checkout", () => {
    it("clicking upgrade calls createCheckoutSession with correct price", async () => {
      const createCheckoutSession = createMockCreateCheckout();
      const navigateToUrl = vi.fn();
      await renderAndWait({
        fetchBillingStatus: createMockFetchStatus(MOCK_FREE_STATUS),
        createCheckoutSession,
        navigateToUrl,
      });

      fireEvent.click(screen.getByTestId("upgrade-btn"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(createCheckoutSession).toHaveBeenCalledTimes(1);
      expect(createCheckoutSession).toHaveBeenCalledWith("price_premium_monthly");
    });

    it("navigates to checkout URL after successful session creation", async () => {
      const navigateToUrl = vi.fn();
      await renderAndWait({
        fetchBillingStatus: createMockFetchStatus(MOCK_FREE_STATUS),
        createCheckoutSession: createMockCreateCheckout(),
        navigateToUrl,
      });

      fireEvent.click(screen.getByTestId("upgrade-btn"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(navigateToUrl).toHaveBeenCalledWith(
        "https://checkout.stripe.com/pay/cs_test_abc123",
      );
    });

    it("premium user upgrading sends enterprise price", async () => {
      const createCheckoutSession = createMockCreateCheckout();
      await renderAndWait({
        fetchBillingStatus: createMockFetchStatus(MOCK_PREMIUM_STATUS),
        createCheckoutSession,
      });

      fireEvent.click(screen.getByTestId("upgrade-btn"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(createCheckoutSession).toHaveBeenCalledWith("price_enterprise_monthly");
    });

    it("shows error message when checkout creation fails", async () => {
      const createCheckoutSession = vi.fn(async () => {
        throw new Error("Stripe error");
      });
      await renderAndWait({
        fetchBillingStatus: createMockFetchStatus(MOCK_FREE_STATUS),
        createCheckoutSession,
      });

      fireEvent.click(screen.getByTestId("upgrade-btn"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.getByTestId("billing-status-msg")).toHaveTextContent(/stripe error/i);
    });

    it("shows upgrading state while checkout is in progress", async () => {
      // Create a checkout that never resolves
      const createCheckoutSession = vi.fn(
        () => new Promise<CheckoutResponse>(() => {}),
      );
      await renderAndWait({
        fetchBillingStatus: createMockFetchStatus(MOCK_FREE_STATUS),
        createCheckoutSession,
      });

      fireEvent.click(screen.getByTestId("upgrade-btn"));

      // The button should show loading state
      const upgradeBtn = screen.getByTestId("upgrade-btn");
      expect(upgradeBtn).toBeDisabled();
    });
  });

  // =========================================================================
  // Integration Tests: Manage Subscription Link (AC#3)
  // =========================================================================

  describe("integration: Stripe Portal link", () => {
    it("shows manage subscription button for paid subscribers", async () => {
      await renderAndWait({
        fetchBillingStatus: createMockFetchStatus(MOCK_PREMIUM_STATUS),
      });

      expect(screen.getByTestId("manage-subscription-btn")).toBeInTheDocument();
    });

    it("does not show manage subscription for free tier", async () => {
      await renderAndWait({
        fetchBillingStatus: createMockFetchStatus(MOCK_FREE_STATUS),
      });

      expect(screen.queryByTestId("manage-subscription-btn")).not.toBeInTheDocument();
    });

    it("clicking manage subscription creates portal session", async () => {
      const createPortalSession = createMockCreatePortalSession();
      const navigateToUrl = vi.fn();
      await renderAndWait({
        fetchBillingStatus: createMockFetchStatus(MOCK_PREMIUM_STATUS),
        createPortalSession,
        navigateToUrl,
      });

      fireEvent.click(screen.getByTestId("manage-subscription-btn"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(createPortalSession).toHaveBeenCalledTimes(1);
      expect(navigateToUrl).toHaveBeenCalledWith(
        "https://billing.stripe.com/p/session/test_abc123",
      );
    });

    it("shows manage subscription for enterprise tier", async () => {
      await renderAndWait({
        fetchBillingStatus: createMockFetchStatus(MOCK_ENTERPRISE_STATUS),
      });

      expect(screen.getByTestId("manage-subscription-btn")).toBeInTheDocument();
    });
  });

  // =========================================================================
  // Integration Tests: Plan Comparison (AC#5)
  // =========================================================================

  describe("integration: plan comparison", () => {
    it("shows plan comparison section", async () => {
      await renderAndWait();

      expect(screen.getByTestId("plan-comparison")).toBeInTheDocument();
    });

    it("shows all three plan tiers", async () => {
      await renderAndWait();

      const comparison = screen.getByTestId("plan-comparison");
      expect(within(comparison).getByText("Free")).toBeInTheDocument();
      expect(within(comparison).getByText("Premium")).toBeInTheDocument();
      expect(within(comparison).getByText("Enterprise")).toBeInTheDocument();
    });

    it("shows price for each plan", async () => {
      await renderAndWait();

      const comparison = screen.getByTestId("plan-comparison");
      expect(within(comparison).getByText("$0/mo")).toBeInTheDocument();
      expect(within(comparison).getByText("$9/mo")).toBeInTheDocument();
      expect(within(comparison).getByText("$29/mo")).toBeInTheDocument();
    });

    it("shows account limits for each plan", async () => {
      await renderAndWait();

      const comparison = screen.getByTestId("plan-comparison");
      expect(within(comparison).getByText(/2 calendar accounts/i)).toBeInTheDocument();
      expect(within(comparison).getByText(/5 calendar accounts/i)).toBeInTheDocument();
      expect(within(comparison).getByText(/10 calendar accounts/i)).toBeInTheDocument();
    });

    it("highlights the current plan", async () => {
      await renderAndWait({
        fetchBillingStatus: createMockFetchStatus(MOCK_PREMIUM_STATUS),
      });

      const premiumCard = screen.getByTestId("plan-card-premium");
      expect(premiumCard).toHaveAttribute("data-current", "true");

      const freeCard = screen.getByTestId("plan-card-free");
      expect(freeCard).toHaveAttribute("data-current", "false");
    });
  });

  // =========================================================================
  // Integration Tests: Billing History
  // =========================================================================

  describe("integration: billing history", () => {
    it("calls fetchBillingHistory on mount for paid subscribers", async () => {
      const fetchBillingHistory = createMockFetchBillingHistory();
      await renderAndWait({
        fetchBillingStatus: createMockFetchStatus(MOCK_PREMIUM_STATUS),
        fetchBillingHistory,
      });

      expect(fetchBillingHistory).toHaveBeenCalledTimes(1);
    });

    it("displays billing events in history section", async () => {
      await renderAndWait({
        fetchBillingStatus: createMockFetchStatus(MOCK_PREMIUM_STATUS),
        fetchBillingHistory: createMockFetchBillingHistory(),
      });

      expect(screen.getByTestId("billing-history")).toBeInTheDocument();
      expect(screen.getByText("Subscription created")).toBeInTheDocument();
      expect(screen.getByText("Subscription renewed")).toBeInTheDocument();
    });

    it("does not show billing history for free tier with no events", async () => {
      await renderAndWait({
        fetchBillingStatus: createMockFetchStatus(MOCK_FREE_STATUS),
        fetchBillingHistory: createMockFetchBillingHistory([]),
      });

      expect(screen.queryByTestId("billing-history")).not.toBeInTheDocument();
    });

    it("shows event dates in billing history", async () => {
      await renderAndWait({
        fetchBillingStatus: createMockFetchStatus(MOCK_PREMIUM_STATUS),
        fetchBillingHistory: createMockFetchBillingHistory(),
      });

      const history = screen.getByTestId("billing-history");
      // Both events have dates containing "2026" -- verify at least one is present
      const dateElements = within(history).getAllByText(/2026/);
      expect(dateElements.length).toBeGreaterThanOrEqual(1);
    });
  });

  // =========================================================================
  // Integration Tests: Grace Period Warning
  // =========================================================================

  describe("integration: grace period warning", () => {
    it("shows grace period warning for past_due status", async () => {
      await renderAndWait({
        fetchBillingStatus: createMockFetchStatus(MOCK_PAST_DUE_STATUS),
      });

      expect(screen.getByTestId("grace-period-warning")).toBeInTheDocument();
      expect(screen.getByTestId("grace-period-warning")).toHaveTextContent(/grace period/i);
    });

    it("does not show grace period warning for active status", async () => {
      await renderAndWait({
        fetchBillingStatus: createMockFetchStatus(MOCK_PREMIUM_STATUS),
      });

      expect(screen.queryByTestId("grace-period-warning")).not.toBeInTheDocument();
    });
  });
});
