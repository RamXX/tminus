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
 * The component accepts fetch/action functions as props for testability.
 * In production, these are wired to the API client with auth tokens.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import type {
  BillingStatusResponse,
  BillingTier,
  BillingStatus,
  CheckoutResponse,
  PortalResponse,
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

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface BillingProps {
  /** Fetch current billing status. Injected for testability. */
  fetchBillingStatus: () => Promise<BillingStatusResponse>;
  /** Create a Stripe Checkout session. Returns checkout URL. */
  createCheckoutSession: (priceId: string) => Promise<CheckoutResponse>;
  /** Create a Stripe Customer Portal session. Returns portal URL. */
  createPortalSession: () => Promise<PortalResponse>;
  /** Fetch billing event history. */
  fetchBillingHistory: () => Promise<BillingEvent[]>;
  /** Number of accounts currently linked by the user. */
  accountsUsed: number;
  /**
   * Navigate to an external URL. Defaults to window.location.assign.
   * Injected for testability (prevents actual navigation in tests).
   */
  navigateToUrl?: (url: string) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Billing({
  fetchBillingStatus,
  createCheckoutSession,
  createPortalSession,
  fetchBillingHistory,
  accountsUsed,
  navigateToUrl = (url) => {
    window.location.assign(url);
  },
}: BillingProps) {
  const [billingStatus, setBillingStatus] = useState<BillingStatusResponse | null>(null);
  const [billingEvents, setBillingEvents] = useState<BillingEvent[]>([]);
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
      const status = await fetchBillingStatus();
      if (!mountedRef.current) return;
      setBillingStatus(status);
      setError(null);
      setLoading(false);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : "Unknown error");
      setLoading(false);
    }
  }, [fetchBillingStatus]);

  // Load billing history
  const loadBillingHistory = useCallback(async () => {
    try {
      const events = await fetchBillingHistory();
      if (!mountedRef.current) return;
      setBillingEvents(events);
    } catch {
      // Billing history is non-critical; silently ignore errors
    }
  }, [fetchBillingHistory]);

  // Initial load
  useEffect(() => {
    mountedRef.current = true;
    loadBillingStatus();
    loadBillingHistory();

    return () => {
      mountedRef.current = false;
      if (statusTimerRef.current) {
        clearTimeout(statusTimerRef.current);
      }
    };
  }, [loadBillingStatus, loadBillingHistory]);

  // Handle upgrade button click
  const handleUpgrade = useCallback(async () => {
    if (!billingStatus) return;

    const target = nextTier(billingStatus.tier);
    if (!target || target === "free") return;

    const priceId = STRIPE_PRICE_IDS[target];
    setUpgrading(true);

    try {
      const response = await createCheckoutSession(priceId);
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
  }, [billingStatus, createCheckoutSession, navigateToUrl, showStatus]);

  // Handle manage subscription button click
  const handleManageSubscription = useCallback(async () => {
    try {
      const response = await createPortalSession();
      if (!mountedRef.current) return;
      navigateToUrl(response.portal_url);
    } catch (err) {
      if (!mountedRef.current) return;
      showStatus(
        "error",
        `Failed to open billing portal: ${err instanceof Error ? err.message : "Unknown error"}`,
      );
    }
  }, [createPortalSession, navigateToUrl, showStatus]);

  // -- Loading state --
  if (loading) {
    return (
      <div data-testid="billing-loading" style={styles.container}>
        <h1 style={styles.title}>Billing</h1>
        <div style={styles.loading}>Loading billing information...</div>
      </div>
    );
  }

  // -- Error state --
  if (error) {
    return (
      <div data-testid="billing-error" style={styles.container}>
        <h1 style={styles.title}>Billing</h1>
        <div style={styles.errorBox}>
          <p>Failed to load billing information: {error}</p>
          <button
            onClick={loadBillingStatus}
            style={styles.retryBtn}
            aria-label="Retry"
          >
            Retry
          </button>
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
    <div style={styles.container}>
      <div style={styles.headerRow}>
        <h1 style={styles.title}>Billing</h1>
        <a href="#/calendar" style={styles.backLink}>
          Back to Calendar
        </a>
      </div>

      {/* Status message */}
      {statusMsg && (
        <div
          data-testid="billing-status-msg"
          style={{
            ...styles.statusMessage,
            ...(statusMsg.type === "success"
              ? styles.statusSuccess
              : styles.statusError),
          }}
        >
          {statusMsg.text}
        </div>
      )}

      {/* Grace period warning */}
      {status === "past_due" && billingStatus.subscription?.grace_period_end && (
        <div data-testid="grace-period-warning" style={styles.gracePeriodWarning}>
          Your payment is past due. You have a grace period until{" "}
          {formatBillingDate(billingStatus.subscription.grace_period_end)}.
          Please update your payment method to avoid losing access.
        </div>
      )}

      {/* Current Plan Card */}
      <div style={styles.planCard}>
        <div style={styles.planCardHeader}>
          <div>
            <div style={styles.planCardLabel}>Current Plan</div>
            <div data-testid="current-plan-name" style={styles.planCardTier}>
              {tierLabel(tier)}
            </div>
          </div>
          <div style={styles.planCardStatusBlock}>
            <div
              data-testid="subscription-status"
              style={{
                ...styles.planCardStatus,
                color: statusColor(status),
              }}
            >
              {statusLabel(status)}
            </div>
            {billingStatus.subscription?.current_period_end && (
              <div data-testid="period-end" style={styles.periodEnd}>
                Renews {formatBillingDate(billingStatus.subscription.current_period_end)}
              </div>
            )}
          </div>
        </div>

        {/* Usage bar */}
        <div style={styles.usageSection}>
          <div style={styles.usageHeader}>
            <span style={styles.usageLabel}>Accounts</span>
            <span data-testid="usage-display" style={styles.usageCount}>
              {accountsUsed} / {limit}
            </span>
          </div>
          <div style={styles.usageBarBg}>
            <div
              data-testid="usage-bar-fill"
              style={{
                ...styles.usageBarFill,
                width: `${usage}%`,
                backgroundColor: usage >= 100 ? "#dc2626" : usage >= 80 ? "#ca8a04" : "#3b82f6",
              }}
            />
          </div>
        </div>

        {/* Action buttons */}
        <div style={styles.actionRow}>
          {btnState !== "at_max" && (
            <button
              data-testid="upgrade-btn"
              onClick={handleUpgrade}
              disabled={btnState === "disabled" || upgrading}
              style={{
                ...styles.upgradeBtn,
                opacity: btnState === "disabled" || upgrading ? 0.5 : 1,
                cursor: btnState === "disabled" || upgrading ? "not-allowed" : "pointer",
              }}
            >
              {upgrading
                ? "Processing..."
                : `Upgrade to ${tierLabel(nextTier(tier) ?? tier)}`}
            </button>
          )}
          {hasPaidSubscription && (
            <button
              data-testid="manage-subscription-btn"
              onClick={handleManageSubscription}
              style={styles.manageBtn}
            >
              Manage Subscription
            </button>
          )}
        </div>
      </div>

      {/* Plan Comparison */}
      <div data-testid="plan-comparison" style={styles.comparisonSection}>
        <h2 style={styles.sectionTitle}>Compare Plans</h2>
        <div style={styles.planGrid}>
          {PLANS.map((plan) => (
            <div
              key={plan.tier}
              data-testid={`plan-card-${plan.tier}`}
              data-current={plan.tier === tier ? "true" : "false"}
              style={{
                ...styles.comparisonCard,
                ...(plan.tier === tier ? styles.comparisonCardCurrent : {}),
              }}
            >
              <div style={styles.comparisonCardName}>{plan.name}</div>
              <div style={styles.comparisonCardPrice}>{plan.price}</div>
              <ul style={styles.featureList}>
                {plan.features.map((feature, i) => (
                  <li key={i} style={styles.featureItem}>
                    {feature}
                  </li>
                ))}
              </ul>
              {plan.tier === tier && (
                <div style={styles.currentBadge}>Current Plan</div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Billing History */}
      {billingEvents.length > 0 && (
        <div data-testid="billing-history" style={styles.historySection}>
          <h2 style={styles.sectionTitle}>Billing History</h2>
          <div style={styles.historyList}>
            {billingEvents.map((event) => (
              <div
                key={event.event_id}
                data-testid={`billing-event-${event.event_id}`}
                style={styles.historyItem}
              >
                <div style={styles.historyEventType}>
                  {formatEventType(event.event_type)}
                </div>
                <div style={styles.historyEventDate}>
                  {formatBillingDate(event.created_at)}
                </div>
                {event.old_tier && event.new_tier && event.old_tier !== event.new_tier && (
                  <div style={styles.historyTierChange}>
                    {tierLabel(event.old_tier)} &rarr; {tierLabel(event.new_tier)}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline styles (consistent with Accounts.tsx / SyncStatus.tsx patterns)
// ---------------------------------------------------------------------------

const styles: Record<string, React.CSSProperties> = {
  container: {
    maxWidth: "1200px",
    margin: "0 auto",
  },
  headerRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: "1rem",
  },
  title: {
    fontSize: "1.5rem",
    fontWeight: 700,
    color: "#f1f5f9",
    margin: 0,
  },
  backLink: {
    color: "#94a3b8",
    fontSize: "0.875rem",
    textDecoration: "none",
  },
  loading: {
    color: "#94a3b8",
    padding: "2rem",
    textAlign: "center" as const,
  },
  errorBox: {
    color: "#fca5a5",
    padding: "2rem",
    textAlign: "center" as const,
  },
  retryBtn: {
    marginTop: "0.5rem",
    padding: "0.5rem 1rem",
    borderRadius: "6px",
    border: "1px solid #ef4444",
    background: "transparent",
    color: "#ef4444",
    cursor: "pointer",
    fontSize: "0.875rem",
  },
  statusMessage: {
    padding: "0.5rem 1rem",
    borderRadius: "6px",
    fontSize: "0.875rem",
    fontWeight: 500,
    marginBottom: "1rem",
  },
  statusSuccess: {
    backgroundColor: "#064e3b",
    color: "#6ee7b7",
    border: "1px solid #059669",
  },
  statusError: {
    backgroundColor: "#450a0a",
    color: "#fca5a5",
    border: "1px solid #dc2626",
  },
  gracePeriodWarning: {
    padding: "0.75rem 1rem",
    borderRadius: "6px",
    fontSize: "0.875rem",
    fontWeight: 500,
    marginBottom: "1rem",
    backgroundColor: "#451a03",
    color: "#fbbf24",
    border: "1px solid #ca8a04",
  },
  // Current plan card
  planCard: {
    backgroundColor: "#1e293b",
    borderRadius: "12px",
    padding: "1.5rem",
    border: "1px solid #334155",
    marginBottom: "2rem",
  },
  planCardHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: "1.5rem",
  },
  planCardLabel: {
    fontSize: "0.8rem",
    color: "#94a3b8",
    textTransform: "uppercase" as const,
    letterSpacing: "0.05em",
    marginBottom: "0.25rem",
  },
  planCardTier: {
    fontSize: "1.5rem",
    fontWeight: 700,
    color: "#f1f5f9",
  },
  planCardStatusBlock: {
    textAlign: "right" as const,
  },
  planCardStatus: {
    fontSize: "0.875rem",
    fontWeight: 600,
  },
  periodEnd: {
    fontSize: "0.75rem",
    color: "#94a3b8",
    marginTop: "0.25rem",
  },
  // Usage bar
  usageSection: {
    marginBottom: "1.5rem",
  },
  usageHeader: {
    display: "flex",
    justifyContent: "space-between",
    marginBottom: "0.5rem",
  },
  usageLabel: {
    fontSize: "0.8rem",
    color: "#94a3b8",
  },
  usageCount: {
    fontSize: "0.8rem",
    color: "#e2e8f0",
    fontWeight: 600,
  },
  usageBarBg: {
    width: "100%",
    height: "8px",
    backgroundColor: "#334155",
    borderRadius: "4px",
    overflow: "hidden" as const,
  },
  usageBarFill: {
    height: "100%",
    borderRadius: "4px",
    transition: "width 0.3s ease",
  },
  // Action buttons
  actionRow: {
    display: "flex",
    gap: "0.75rem",
    flexWrap: "wrap" as const,
  },
  upgradeBtn: {
    padding: "0.5rem 1.25rem",
    borderRadius: "6px",
    border: "none",
    backgroundColor: "#3b82f6",
    color: "#ffffff",
    cursor: "pointer",
    fontSize: "0.875rem",
    fontWeight: 600,
  },
  manageBtn: {
    padding: "0.5rem 1.25rem",
    borderRadius: "6px",
    border: "1px solid #475569",
    background: "transparent",
    color: "#94a3b8",
    cursor: "pointer",
    fontSize: "0.875rem",
  },
  // Plan comparison
  comparisonSection: {
    marginBottom: "2rem",
  },
  sectionTitle: {
    fontSize: "1.1rem",
    fontWeight: 700,
    color: "#f1f5f9",
    marginBottom: "1rem",
  },
  planGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(3, 1fr)",
    gap: "1rem",
  },
  comparisonCard: {
    backgroundColor: "#1e293b",
    borderRadius: "12px",
    padding: "1.25rem",
    border: "1px solid #334155",
    position: "relative" as const,
  },
  comparisonCardCurrent: {
    borderColor: "#3b82f6",
    boxShadow: "0 0 0 1px #3b82f6",
  },
  comparisonCardName: {
    fontSize: "1rem",
    fontWeight: 700,
    color: "#f1f5f9",
    marginBottom: "0.25rem",
  },
  comparisonCardPrice: {
    fontSize: "1.25rem",
    fontWeight: 700,
    color: "#3b82f6",
    marginBottom: "1rem",
  },
  featureList: {
    listStyle: "none",
    padding: 0,
    margin: 0,
  },
  featureItem: {
    fontSize: "0.8rem",
    color: "#cbd5e1",
    padding: "0.3rem 0",
    borderBottom: "1px solid #1e293b",
  },
  currentBadge: {
    marginTop: "0.75rem",
    padding: "0.25rem 0.5rem",
    backgroundColor: "#1e3a5f",
    color: "#93c5fd",
    borderRadius: "4px",
    fontSize: "0.7rem",
    fontWeight: 600,
    textAlign: "center" as const,
  },
  // Billing history
  historySection: {
    marginBottom: "2rem",
  },
  historyList: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "0.5rem",
  },
  historyItem: {
    display: "flex",
    alignItems: "center",
    gap: "1rem",
    padding: "0.75rem 1rem",
    backgroundColor: "#1e293b",
    borderRadius: "8px",
    border: "1px solid #334155",
  },
  historyEventType: {
    fontSize: "0.875rem",
    color: "#e2e8f0",
    fontWeight: 500,
    flex: 1,
  },
  historyEventDate: {
    fontSize: "0.8rem",
    color: "#94a3b8",
  },
  historyTierChange: {
    fontSize: "0.75rem",
    color: "#93c5fd",
    fontWeight: 500,
  },
};
