/**
 * Billing page.
 *
 * Displays current plan, usage (accounts used/limit), upgrade/downgrade
 * buttons, billing history, and Stripe Customer Portal link for payment
 * management.
 *
 * Features:
 * - Current plan display with status indicator
 * - Account usage bar (used / limit)
 * - Upgrade button that starts Stripe Checkout
 * - Manage Subscription button that opens Stripe Customer Portal
 * - Plan comparison table (Free, Premium, Enterprise)
 * - Billing history timeline
 * - Grace period warning for past_due subscriptions
 * - Loading, error, and retry states
 *
 * Uses useApi() for token-injected API calls (migrated from prop-passing).
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { useApi } from "../lib/api-provider";
import type {
  BillingStatusResponse,
  BillingEvent,
} from "../lib/billing";
import {
  tierLabel,
  statusLabel,
  statusColor,
  usagePercentage,
  getAccountLimit,
  upgradeButtonState,
  nextTier,
  formatEventType,
  formatBillingDate,
  PLANS,
  STRIPE_PRICE_IDS,
} from "../lib/billing";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Billing({
  navigateToUrl = (url: string) => {
    window.location.assign(url);
  },
}: {
  navigateToUrl?: (url: string) => void;
} = {}) {
  const api = useApi();

  const [billingStatus, setBillingStatus] = useState<BillingStatusResponse | null>(null);
  const [billingEvents, setBillingEvents] = useState<BillingEvent[]>([]);
  const [accountsUsed, setAccountsUsed] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [upgrading, setUpgrading] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  const mountedRef = useRef(true);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Show a temporary status message that auto-clears after 4 seconds
  const showStatus = useCallback(
    (type: "success" | "error", text: string) => {
      if (statusTimerRef.current) {
        clearTimeout(statusTimerRef.current);
      }
      setStatusMsg({ type, text });
      statusTimerRef.current = setTimeout(() => {
        if (mountedRef.current) {
          setStatusMsg(null);
        }
        statusTimerRef.current = null;
      }, 4000);
    },
    [],
  );

  // Load billing status from the API
  const loadBillingStatus = useCallback(async () => {
    try {
      setLoading(true);
      const status = await api.fetchBillingStatus();
      if (!mountedRef.current) return;
      setBillingStatus(status);
      setError(null);
      setLoading(false);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : "Unknown error");
      setLoading(false);
    }
  }, [api]);

  // Load billing history
  const loadBillingHistory = useCallback(async () => {
    try {
      const events = await api.fetchBillingHistory();
      if (!mountedRef.current) return;
      setBillingEvents(events);
    } catch {
      // Billing history is non-critical; silently ignore errors
    }
  }, [api]);

  // Load accounts count for usage display
  const loadAccountsCount = useCallback(async () => {
    try {
      const accounts = await api.fetchAccounts();
      if (!mountedRef.current) return;
      setAccountsUsed(accounts.length);
    } catch {
      // Non-critical -- defaults to 0
    }
  }, [api]);

  // Initial load
  useEffect(() => {
    mountedRef.current = true;
    loadBillingStatus();
    loadBillingHistory();
    loadAccountsCount();

    return () => {
      mountedRef.current = false;
      if (statusTimerRef.current) {
        clearTimeout(statusTimerRef.current);
      }
    };
  }, [loadBillingStatus, loadBillingHistory, loadAccountsCount]);

  // Handle upgrade button click
  const handleUpgrade = useCallback(async () => {
    if (!billingStatus) return;

    const target = nextTier(billingStatus.tier);
    if (!target || target === "free") return;

    const priceId = STRIPE_PRICE_IDS[target];
    setUpgrading(true);

    try {
      const response = await api.createCheckoutSession(priceId);
      if (!mountedRef.current) return;
      navigateToUrl(response.checkout_url);
    } catch (err) {
      if (!mountedRef.current) return;
      showStatus(
        "error",
        `Failed to start checkout: ${err instanceof Error ? err.message : "Unknown error"}`,
      );
    } finally {
      if (mountedRef.current) {
        setUpgrading(false);
      }
    }
  }, [billingStatus, api, navigateToUrl, showStatus]);

  // Handle manage subscription button click
  const handleManageSubscription = useCallback(async () => {
    try {
      const response = await api.createPortalSession();
      if (!mountedRef.current) return;
      navigateToUrl(response.portal_url);
    } catch (err) {
      if (!mountedRef.current) return;
      showStatus(
        "error",
        `Failed to open billing portal: ${err instanceof Error ? err.message : "Unknown error"}`,
      );
    }
  }, [api, navigateToUrl, showStatus]);

  // -- Loading state --
  if (loading) {
    return (
      <div data-testid="billing-loading" className="mx-auto max-w-[1200px]">
        <h1 className="text-2xl font-bold text-foreground">Billing</h1>
        <p className="text-muted-foreground text-center py-8">Loading billing information...</p>
      </div>
    );
  }

  // -- Error state --
  if (error) {
    return (
      <div data-testid="billing-error" className="mx-auto max-w-[1200px]">
        <h1 className="text-2xl font-bold text-foreground">Billing</h1>
        <div className="text-destructive text-center py-8">
          <p>Failed to load billing information: {error}</p>
          <Button
            onClick={loadBillingStatus}
            variant="outline"
            className="mt-2 border-destructive text-destructive hover:bg-destructive/10"
            aria-label="Retry"
          >
            Retry
          </Button>
        </div>
      </div>
    );
  }

  // Should not happen after loading completes, but guard anyway
  if (!billingStatus) return null;

  const tier = billingStatus.tier;
  const status = billingStatus.status;
  const limit = getAccountLimit(tier);
  const usage = usagePercentage(accountsUsed, tier);
  const btnState = upgradeButtonState(tier, status);
  const hasPaidSubscription = tier !== "free" && status !== "none";

  return (
    <div className="mx-auto max-w-[1200px]">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold text-foreground">Billing</h1>
        <a href="#/calendar" className="text-muted-foreground text-sm no-underline hover:text-foreground">
          Back to Calendar
        </a>
      </div>

      {/* Status message */}
      {statusMsg && (
        <div
          data-testid="billing-status-msg"
          className={`px-4 py-2 rounded-md text-sm font-medium mb-4 border ${
            statusMsg.type === "success"
              ? "bg-emerald-950 text-emerald-300 border-emerald-600"
              : "bg-red-950 text-red-300 border-red-700"
          }`}
        >
          {statusMsg.text}
        </div>
      )}

      {/* Grace period warning */}
      {status === "past_due" && billingStatus.subscription?.grace_period_end && (
        <div
          data-testid="grace-period-warning"
          className="px-4 py-3 rounded-md text-sm font-medium mb-4 bg-amber-950 text-amber-300 border border-amber-600"
        >
          Your payment is past due. You have a grace period until{" "}
          {formatBillingDate(billingStatus.subscription.grace_period_end)}.
          Please update your payment method to avoid losing access.
        </div>
      )}

      {/* Current Plan Card */}
      <Card className="mb-6">
        <CardContent className="p-6">
          <div className="flex justify-between items-start mb-6">
            <div>
              <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Current Plan</div>
              <div data-testid="current-plan-name" className="text-2xl font-bold text-foreground">
                {tierLabel(tier)}
              </div>
            </div>
            <div className="text-right">
              <div
                data-testid="subscription-status"
                className="text-sm font-semibold"
                style={{ color: statusColor(status) }}
              >
                {statusLabel(status)}
              </div>
              {billingStatus.subscription?.current_period_end && (
                <div data-testid="period-end" className="text-xs text-muted-foreground mt-1">
                  Renews {formatBillingDate(billingStatus.subscription.current_period_end)}
                </div>
              )}
            </div>
          </div>

          {/* Usage bar */}
          <div className="mb-6">
            <div className="flex justify-between mb-2">
              <span className="text-xs text-muted-foreground">Accounts</span>
              <span data-testid="usage-display" className="text-xs text-foreground font-semibold">
                {accountsUsed} / {limit}
              </span>
            </div>
            <div className="w-full h-2 bg-muted rounded overflow-hidden">
              <div
                data-testid="usage-bar-fill"
                className="h-full rounded transition-all duration-300"
                style={{
                  width: `${usage}%`,
                  backgroundColor: usage >= 100 ? "#dc2626" : usage >= 80 ? "#ca8a04" : "#3b82f6",
                }}
              />
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex gap-3 flex-wrap">
            {btnState !== "at_max" && (
              <Button
                data-testid="upgrade-btn"
                onClick={handleUpgrade}
                disabled={btnState === "disabled" || upgrading}
              >
                {upgrading
                  ? "Processing..."
                  : `Upgrade to ${tierLabel(nextTier(tier) ?? tier)}`}
              </Button>
            )}
            {hasPaidSubscription && (
              <Button
                data-testid="manage-subscription-btn"
                onClick={handleManageSubscription}
                variant="outline"
              >
                Manage Subscription
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Plan Comparison */}
      <div data-testid="plan-comparison" className="mb-6">
        <h2 className="text-lg font-bold text-foreground mb-4">Compare Plans</h2>
        <div className="grid grid-cols-3 gap-4">
          {PLANS.map((plan) => (
            <Card
              key={plan.tier}
              data-testid={`plan-card-${plan.tier}`}
              data-current={plan.tier === tier ? "true" : "false"}
              className={`relative ${
                plan.tier === tier ? "border-primary ring-1 ring-primary" : ""
              }`}
            >
              <CardContent className="p-5">
                <div className="text-base font-bold text-foreground mb-1">{plan.name}</div>
                <div className="text-xl font-bold text-primary mb-4">{plan.price}</div>
                <ul className="list-none p-0 m-0">
                  {plan.features.map((feature, i) => (
                    <li key={i} className="text-xs text-muted-foreground py-1 border-b border-border last:border-0">
                      {feature}
                    </li>
                  ))}
                </ul>
                {plan.tier === tier && (
                  <Badge className="mt-3" variant="secondary">
                    Current Plan
                  </Badge>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      {/* Billing History */}
      {billingEvents.length > 0 && (
        <div data-testid="billing-history" className="mb-6">
          <h2 className="text-lg font-bold text-foreground mb-4">Billing History</h2>
          <div className="flex flex-col gap-2">
            {billingEvents.map((event) => (
              <Card
                key={event.event_id}
                data-testid={`billing-event-${event.event_id}`}
              >
                <CardContent className="p-4 flex items-center gap-4">
                  <div className="text-sm text-foreground font-medium flex-1">
                    {formatEventType(event.event_type)}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {formatBillingDate(event.created_at)}
                  </div>
                  {event.old_tier && event.new_tier && event.old_tier !== event.new_tier && (
                    <div className="text-xs text-primary font-medium">
                      {tierLabel(event.old_tier)} &rarr; {tierLabel(event.new_tier)}
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
