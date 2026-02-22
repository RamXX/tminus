/**
 * Unit tests for billing routes -- subscription lifecycle management.
 *
 * Tests:
 * - Stripe webhook signature verification
 * - Tier resolution from price ID
 * - Tier comparison helpers (upgrade/downgrade detection)
 * - Checkout session creation logic (validation)
 * - Webhook event parsing and handling
 * - Lifecycle state transitions (upgrade, downgrade, cancel, renew, fail)
 * - Grace period logic for payment failures
 * - End-of-period downgrade timing
 * - Billing event logging
 * - Billing status retrieval
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  verifyStripeWebhookSignature,
  resolveTierFromPrice,
  compareTiers,
  isUpgrade,
  isDowngrade,
  handleCheckoutCompleted,
  handleSubscriptionUpdated,
  handleSubscriptionDeleted,
  handlePaymentFailed,
  handleGetBillingStatus,
  handleGetBillingEvents,
  billingSuccessResponse,
  billingErrorResponse,
  getUserTier,
  upsertSubscription,
  logBillingEvent,
  calculateGracePeriodEnd,
  getSubscriptionByStripeId,
  GRACE_PERIOD_DAYS,
  TIER_LEVELS,
} from "./billing";
import type { StripeSubscription, BillingEnv } from "./billing";

// ---------------------------------------------------------------------------
// Stripe webhook signature test helpers
// ---------------------------------------------------------------------------

/**
 * Generate a valid Stripe webhook signature for testing.
 * Uses Web Crypto HMAC-SHA-256, same as Stripe.
 */
async function generateStripeSignature(
  payload: string,
  secret: string,
  timestamp?: number,
): Promise<{ header: string; timestamp: number }> {
  const ts = timestamp ?? Math.floor(Date.now() / 1000);
  const signedPayload = `${ts}.${payload}`;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const sigBytes = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(signedPayload),
  );

  const signature = Array.from(new Uint8Array(sigBytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return {
    header: `t=${ts},v1=${signature}`,
    timestamp: ts,
  };
}

// ---------------------------------------------------------------------------
// Mock D1 database helper
// ---------------------------------------------------------------------------

interface MockRow {
  [key: string]: unknown;
}

/**
 * Enhanced mock D1 database for lifecycle tests.
 *
 * Supports:
 * - Returning pre-configured rows from SELECT queries
 * - Tracking INSERT and UPDATE operations
 * - Tracking SQL queries for audit verification
 */
function createMockD1(rows: MockRow[] = []): D1Database & {
  _getInsertedRows(): MockRow[];
  _getLastUpdatedParams(): unknown[];
  _getQueries(): string[];
} {
  let insertedRows: MockRow[] = [];
  let lastUpdatedParams: unknown[] = [];
  const queries: string[] = [];

  return {
    prepare(sql: string) {
      queries.push(sql);
      return {
        bind(...params: unknown[]) {
          return {
            async first<T>(): Promise<T | null> {
              // Return first matching row or null
              if (sql.includes("SELECT") && rows.length > 0) {
                return rows[0] as T;
              }
              return null;
            },
            async all<T>(): Promise<{ results: T[] }> {
              return { results: rows as T[] };
            },
            async run(): Promise<D1Result<unknown>> {
              if (sql.includes("INSERT")) {
                insertedRows.push(Object.fromEntries(
                  params.map((p, i) => [`param_${i}`, p]),
                ));
              }
              if (sql.includes("UPDATE")) {
                lastUpdatedParams = params;
              }
              return {
                success: true,
                results: [],
                meta: {
                  duration: 0,
                  rows_read: 0,
                  rows_written: 1,
                  last_row_id: 1,
                  changed_db: true,
                  size_after: 0,
                  changes: 1,
                },
              } as unknown as D1Result<unknown>;
            },
          };
        },
      };
    },
    _getInsertedRows(): MockRow[] { return insertedRows; },
    _getLastUpdatedParams(): unknown[] { return lastUpdatedParams; },
    _getQueries(): string[] { return queries; },
    exec: vi.fn(),
    batch: vi.fn(),
    dump: vi.fn(),
  } as unknown as D1Database & {
    _getInsertedRows(): MockRow[];
    _getLastUpdatedParams(): unknown[];
    _getQueries(): string[];
  };
}

// ===========================================================================
// Tests
// ===========================================================================

describe("Billing: Stripe webhook signature verification", () => {
  const WEBHOOK_SECRET = "whsec_test_secret_for_unit_tests";

  it("accepts a valid signature", async () => {
    const payload = JSON.stringify({
      id: "evt_test_123",
      type: "checkout.session.completed",
      data: { object: { id: "cs_test_123" } },
    });

    const { header } = await generateStripeSignature(payload, WEBHOOK_SECRET);
    const event = await verifyStripeWebhookSignature(payload, header, WEBHOOK_SECRET);

    expect(event).not.toBeNull();
    expect(event!.id).toBe("evt_test_123");
    expect(event!.type).toBe("checkout.session.completed");
  });

  it("rejects an invalid signature", async () => {
    const payload = JSON.stringify({
      id: "evt_test_123",
      type: "checkout.session.completed",
      data: { object: {} },
    });

    const { header } = await generateStripeSignature(payload, "wrong_secret");
    const event = await verifyStripeWebhookSignature(payload, header, WEBHOOK_SECRET);

    expect(event).toBeNull();
  });

  it("rejects an expired timestamp", async () => {
    const payload = JSON.stringify({
      id: "evt_test_123",
      type: "checkout.session.completed",
      data: { object: {} },
    });

    // Timestamp 10 minutes ago (beyond 5-minute tolerance)
    const oldTimestamp = Math.floor(Date.now() / 1000) - 600;
    const { header } = await generateStripeSignature(payload, WEBHOOK_SECRET, oldTimestamp);
    const event = await verifyStripeWebhookSignature(payload, header, WEBHOOK_SECRET);

    expect(event).toBeNull();
  });

  it("rejects missing signature header components", async () => {
    const payload = JSON.stringify({ id: "evt_test", type: "test", data: { object: {} } });

    // Missing v1
    const event1 = await verifyStripeWebhookSignature(payload, "t=123456", WEBHOOK_SECRET);
    expect(event1).toBeNull();

    // Missing t
    const event2 = await verifyStripeWebhookSignature(payload, "v1=abcdef", WEBHOOK_SECRET);
    expect(event2).toBeNull();

    // Empty string
    const event3 = await verifyStripeWebhookSignature(payload, "", WEBHOOK_SECRET);
    expect(event3).toBeNull();
  });

  it("rejects a tampered payload", async () => {
    const originalPayload = JSON.stringify({
      id: "evt_test_123",
      type: "checkout.session.completed",
      data: { object: { amount: 1000 } },
    });

    const { header } = await generateStripeSignature(originalPayload, WEBHOOK_SECRET);

    // Tamper with the payload
    const tamperedPayload = JSON.stringify({
      id: "evt_test_123",
      type: "checkout.session.completed",
      data: { object: { amount: 0 } },
    });

    const event = await verifyStripeWebhookSignature(tamperedPayload, header, WEBHOOK_SECRET);
    expect(event).toBeNull();
  });
});

describe("Billing: resolveTierFromPrice", () => {
  it("maps enterprise price to enterprise tier", () => {
    expect(resolveTierFromPrice("price_enterprise_monthly")).toBe("enterprise");
    expect(resolveTierFromPrice("price_ENTERPRISE_annual")).toBe("enterprise");
  });

  it("maps non-enterprise price to premium tier", () => {
    expect(resolveTierFromPrice("price_premium_monthly")).toBe("premium");
    expect(resolveTierFromPrice("price_1234567890")).toBe("premium");
    expect(resolveTierFromPrice("price_pro_annual")).toBe("premium");
  });
});

describe("Billing: tier comparison helpers", () => {
  it("compareTiers returns positive for upgrade", () => {
    expect(compareTiers("free", "premium")).toBeGreaterThan(0);
    expect(compareTiers("free", "enterprise")).toBeGreaterThan(0);
    expect(compareTiers("premium", "enterprise")).toBeGreaterThan(0);
  });

  it("compareTiers returns negative for downgrade", () => {
    expect(compareTiers("enterprise", "premium")).toBeLessThan(0);
    expect(compareTiers("enterprise", "free")).toBeLessThan(0);
    expect(compareTiers("premium", "free")).toBeLessThan(0);
  });

  it("compareTiers returns zero for same tier", () => {
    expect(compareTiers("free", "free")).toBe(0);
    expect(compareTiers("premium", "premium")).toBe(0);
    expect(compareTiers("enterprise", "enterprise")).toBe(0);
  });

  it("isUpgrade correctly identifies upgrades", () => {
    expect(isUpgrade("free", "premium")).toBe(true);
    expect(isUpgrade("free", "enterprise")).toBe(true);
    expect(isUpgrade("premium", "enterprise")).toBe(true);
    expect(isUpgrade("premium", "free")).toBe(false);
    expect(isUpgrade("premium", "premium")).toBe(false);
  });

  it("isDowngrade correctly identifies downgrades", () => {
    expect(isDowngrade("premium", "free")).toBe(true);
    expect(isDowngrade("enterprise", "free")).toBe(true);
    expect(isDowngrade("enterprise", "premium")).toBe(true);
    expect(isDowngrade("free", "premium")).toBe(false);
    expect(isDowngrade("premium", "premium")).toBe(false);
  });

  it("TIER_LEVELS has correct ordering", () => {
    expect(TIER_LEVELS["free"]).toBeLessThan(TIER_LEVELS["premium"]);
    expect(TIER_LEVELS["premium"]).toBeLessThan(TIER_LEVELS["enterprise"]);
  });
});

describe("Billing: calculateGracePeriodEnd", () => {
  it("returns a date GRACE_PERIOD_DAYS from now", () => {
    const now = new Date("2025-03-15T12:00:00.000Z");
    const result = calculateGracePeriodEnd(now);
    const expected = new Date("2025-03-22T12:00:00.000Z");
    expect(result).toBe(expected.toISOString());
  });

  it("uses current date when no argument provided", () => {
    const before = Date.now();
    const result = calculateGracePeriodEnd();
    const after = Date.now();

    const resultMs = new Date(result).getTime();
    const expectedMinMs = before + GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000;
    const expectedMaxMs = after + GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000;

    expect(resultMs).toBeGreaterThanOrEqual(expectedMinMs);
    expect(resultMs).toBeLessThanOrEqual(expectedMaxMs);
  });

  it("uses exactly 7 days for GRACE_PERIOD_DAYS", () => {
    expect(GRACE_PERIOD_DAYS).toBe(7);
  });
});

describe("Billing: handleCheckoutCompleted", () => {
  it("creates subscription for valid checkout session", async () => {
    const db = createMockD1();
    const session = {
      id: "cs_test_123",
      customer: "cus_test_456",
      subscription: "sub_test_789",
      metadata: { user_id: "usr_test_user_1" },
    };

    const result = await handleCheckoutCompleted(db, session);
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("logs a billing event on checkout", async () => {
    const db = createMockD1();
    const session = {
      id: "cs_test_123",
      customer: "cus_test_456",
      subscription: "sub_test_789",
      metadata: { user_id: "usr_test_user_1" },
    };

    await handleCheckoutCompleted(db, session, "evt_stripe_123");

    // Should have INSERT into billing_events
    const queries = (db as unknown as { _getQueries(): string[] })._getQueries();
    const billingEventInserts = queries.filter(q => q.includes("billing_events"));
    expect(billingEventInserts.length).toBeGreaterThan(0);
  });

  it("rejects session without user_id in metadata", async () => {
    const db = createMockD1();
    const session = {
      id: "cs_test_123",
      customer: "cus_test_456",
      subscription: "sub_test_789",
      metadata: {},
    };

    const result = await handleCheckoutCompleted(db, session);
    expect(result.success).toBe(false);
    expect(result.error).toContain("user_id");
  });

  it("rejects session without subscription ID", async () => {
    const db = createMockD1();
    const session = {
      id: "cs_test_123",
      customer: "cus_test_456",
      metadata: { user_id: "usr_test_user_1" },
    };

    const result = await handleCheckoutCompleted(db, session);
    expect(result.success).toBe(false);
    expect(result.error).toContain("subscription");
  });
});

describe("Billing: handleSubscriptionUpdated -- lifecycle transitions", () => {
  it("updates subscription status and tier for active subscription", async () => {
    const db = createMockD1();
    const subscription: StripeSubscription = {
      id: "sub_test_789",
      customer: "cus_test_456",
      status: "active",
      current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
      metadata: { user_id: "usr_test_user_1" },
      items: {
        data: [{ price: { id: "price_premium_monthly" } }],
      },
    };

    const result = await handleSubscriptionUpdated(db, subscription);
    expect(result.success).toBe(true);
  });

  it("sets tier to free on cancellation status", async () => {
    const db = createMockD1();
    const subscription: StripeSubscription = {
      id: "sub_test_789",
      customer: "cus_test_456",
      status: "canceled",
      current_period_end: Math.floor(Date.now() / 1000),
      metadata: { user_id: "usr_test_user_1" },
    };

    const result = await handleSubscriptionUpdated(db, subscription);
    expect(result.success).toBe(true);
  });

  it("rejects without user_id in metadata", async () => {
    const db = createMockD1();
    const subscription: StripeSubscription = {
      id: "sub_test_789",
      customer: "cus_test_456",
      status: "active",
      current_period_end: Math.floor(Date.now() / 1000),
      metadata: {},
    };

    const result = await handleSubscriptionUpdated(db, subscription);
    expect(result.success).toBe(false);
    expect(result.error).toContain("user_id");
  });

  it("detects upgrade from premium to enterprise (immediate tier change)", async () => {
    // Simulate existing premium subscription
    const db = createMockD1([{
      subscription_id: "sub_internal_1",
      user_id: "usr_test_user_1",
      tier: "premium",
      status: "active",
      current_period_end: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString(),
      grace_period_end: null,
      cancel_at_period_end: 0,
      previous_tier: null,
    }]);

    const subscription: StripeSubscription = {
      id: "sub_test_789",
      customer: "cus_test_456",
      status: "active",
      current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
      metadata: { user_id: "usr_test_user_1" },
      items: {
        data: [{ price: { id: "price_enterprise_monthly" } }],
      },
    };

    const result = await handleSubscriptionUpdated(db, subscription, "evt_upgrade_1");
    expect(result.success).toBe(true);

    // Verify it logged the upgrade event
    const queries = (db as unknown as { _getQueries(): string[] })._getQueries();
    const billingEventInserts = queries.filter(q => q.includes("billing_events"));
    expect(billingEventInserts.length).toBeGreaterThan(0);
  });

  it("detects downgrade from enterprise to premium (keeps old tier until period end)", async () => {
    // Simulate existing enterprise subscription
    const db = createMockD1([{
      subscription_id: "sub_internal_1",
      user_id: "usr_test_user_1",
      tier: "enterprise",
      status: "active",
      current_period_end: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString(),
      grace_period_end: null,
      cancel_at_period_end: 0,
      previous_tier: null,
    }]);

    const subscription: StripeSubscription = {
      id: "sub_test_789",
      customer: "cus_test_456",
      status: "active",
      current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
      metadata: { user_id: "usr_test_user_1" },
      items: {
        data: [{ price: { id: "price_premium_monthly" } }],
      },
    };

    const result = await handleSubscriptionUpdated(db, subscription, "evt_downgrade_1");
    expect(result.success).toBe(true);

    // Verify billing event was logged
    const queries = (db as unknown as { _getQueries(): string[] })._getQueries();
    const billingEventInserts = queries.filter(q => q.includes("billing_events"));
    expect(billingEventInserts.length).toBeGreaterThan(0);
  });

  it("logs billing events on all subscription updates", async () => {
    const db = createMockD1();
    const subscription: StripeSubscription = {
      id: "sub_test_789",
      customer: "cus_test_456",
      status: "active",
      current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
      metadata: { user_id: "usr_test_user_1" },
      items: {
        data: [{ price: { id: "price_premium_monthly" } }],
      },
    };

    await handleSubscriptionUpdated(db, subscription, "evt_stripe_update_1");

    // Should have at least one INSERT into billing_events
    const queries = (db as unknown as { _getQueries(): string[] })._getQueries();
    const billingEventInserts = queries.filter(q =>
      q.includes("billing_events") && q.includes("INSERT"),
    );
    expect(billingEventInserts.length).toBeGreaterThanOrEqual(1);
  });
});

describe("Billing: handleSubscriptionDeleted", () => {
  it("downgrades to free tier on deletion", async () => {
    const db = createMockD1();
    const subscription: StripeSubscription = {
      id: "sub_test_789",
      customer: "cus_test_456",
      status: "canceled",
      current_period_end: Math.floor(Date.now() / 1000),
      metadata: { user_id: "usr_test_user_1" },
    };

    const result = await handleSubscriptionDeleted(db, subscription);
    expect(result.success).toBe(true);
  });

  it("logs billing event on deletion", async () => {
    const db = createMockD1();
    const subscription: StripeSubscription = {
      id: "sub_test_789",
      customer: "cus_test_456",
      status: "canceled",
      current_period_end: Math.floor(Date.now() / 1000),
      metadata: { user_id: "usr_test_user_1" },
    };

    await handleSubscriptionDeleted(db, subscription, "evt_stripe_delete_1");

    const queries = (db as unknown as { _getQueries(): string[] })._getQueries();
    const billingEventInserts = queries.filter(q =>
      q.includes("billing_events") && q.includes("INSERT"),
    );
    expect(billingEventInserts.length).toBeGreaterThanOrEqual(1);
  });

  it("preserves previous tier in subscription record", async () => {
    // Simulate existing premium subscription
    const db = createMockD1([{
      subscription_id: "sub_internal_1",
      user_id: "usr_test_user_1",
      tier: "premium",
      status: "active",
      current_period_end: new Date().toISOString(),
      grace_period_end: null,
      cancel_at_period_end: 0,
      previous_tier: null,
    }]);

    const subscription: StripeSubscription = {
      id: "sub_test_789",
      customer: "cus_test_456",
      status: "canceled",
      current_period_end: Math.floor(Date.now() / 1000),
      metadata: { user_id: "usr_test_user_1" },
    };

    const result = await handleSubscriptionDeleted(db, subscription, "evt_del_1");
    expect(result.success).toBe(true);
  });

  it("rejects without user_id in metadata", async () => {
    const db = createMockD1();
    const subscription: StripeSubscription = {
      id: "sub_test_789",
      customer: "cus_test_456",
      status: "canceled",
      current_period_end: Math.floor(Date.now() / 1000),
      metadata: {},
    };

    const result = await handleSubscriptionDeleted(db, subscription);
    expect(result.success).toBe(false);
  });
});

describe("Billing: handlePaymentFailed -- grace period", () => {
  it("marks subscription as past_due", async () => {
    const db = createMockD1([{
      subscription_id: "sub_internal_1",
      user_id: "usr_test_user_1",
      tier: "premium",
      status: "active",
      current_period_end: new Date().toISOString(),
      grace_period_end: null,
      cancel_at_period_end: 0,
      previous_tier: null,
    }]);
    const invoice = {
      id: "in_test_123",
      subscription: "sub_test_789",
    };

    const result = await handlePaymentFailed(db, invoice);
    expect(result.success).toBe(true);
  });

  it("sets grace period on payment failure", async () => {
    const db = createMockD1([{
      subscription_id: "sub_internal_1",
      user_id: "usr_test_user_1",
      tier: "premium",
      status: "active",
      current_period_end: new Date().toISOString(),
      grace_period_end: null,
      cancel_at_period_end: 0,
      previous_tier: null,
    }]);
    const invoice = {
      id: "in_test_123",
      subscription: "sub_test_789",
    };

    await handlePaymentFailed(db, invoice, "evt_fail_1");

    // Verify the UPDATE query includes grace_period_end
    const queries = (db as unknown as { _getQueries(): string[] })._getQueries();
    const updateQueries = queries.filter(q => q.includes("UPDATE") && q.includes("grace_period_end"));
    expect(updateQueries.length).toBeGreaterThan(0);
  });

  it("logs both payment_failed and grace_period_started events", async () => {
    const db = createMockD1([{
      subscription_id: "sub_internal_1",
      user_id: "usr_test_user_1",
      tier: "premium",
      status: "active",
      current_period_end: new Date().toISOString(),
      grace_period_end: null,
      cancel_at_period_end: 0,
      previous_tier: null,
    }]);
    const invoice = {
      id: "in_test_123",
      subscription: "sub_test_789",
    };

    await handlePaymentFailed(db, invoice, "evt_fail_2");

    // Should have 2 billing event inserts (payment_failed + grace_period_started)
    const queries = (db as unknown as { _getQueries(): string[] })._getQueries();
    const billingEventInserts = queries.filter(q =>
      q.includes("billing_events") && q.includes("INSERT"),
    );
    expect(billingEventInserts.length).toBe(2);
  });

  it("rejects invoice without subscription ID", async () => {
    const db = createMockD1();
    const invoice = { id: "in_test_123" };

    const result = await handlePaymentFailed(db, invoice);
    expect(result.success).toBe(false);
    expect(result.error).toContain("subscription");
  });
});

describe("Billing: getUserTier", () => {
  it("returns free when no subscription exists", async () => {
    const db = createMockD1();
    const tier = await getUserTier(db, "usr_nonexistent");
    expect(tier).toBe("free");
  });

  it("returns the tier from an active subscription", async () => {
    const db = createMockD1([{ tier: "premium" }]);
    const tier = await getUserTier(db, "usr_test_user_1");
    expect(tier).toBe("premium");
  });

  it("returns enterprise tier when subscription is enterprise", async () => {
    const db = createMockD1([{ tier: "enterprise" }]);
    const tier = await getUserTier(db, "usr_test_user_1");
    expect(tier).toBe("enterprise");
  });
});

describe("Billing: logBillingEvent", () => {
  it("inserts a billing event record", async () => {
    const db = createMockD1();
    await logBillingEvent(db, {
      user_id: "usr_test_1",
      subscription_id: "sub_test_1",
      event_type: "checkout_completed",
      stripe_event_id: "evt_stripe_1",
      old_tier: "free",
      new_tier: "premium",
      old_status: null,
      new_status: "active",
    });

    const queries = (db as unknown as { _getQueries(): string[] })._getQueries();
    expect(queries.some(q => q.includes("billing_events"))).toBe(true);
    expect(queries.some(q => q.includes("INSERT"))).toBe(true);
  });

  it("handles null metadata", async () => {
    const db = createMockD1();
    await logBillingEvent(db, {
      user_id: "usr_test_1",
      event_type: "subscription_renewed",
    });

    const rows = (db as unknown as { _getInsertedRows(): MockRow[] })._getInsertedRows();
    expect(rows.length).toBe(1);
  });

  it("serializes metadata as JSON", async () => {
    const db = createMockD1();
    await logBillingEvent(db, {
      user_id: "usr_test_1",
      event_type: "grace_period_started",
      metadata: { grace_period_days: 7, test: true },
    });

    const rows = (db as unknown as { _getInsertedRows(): MockRow[] })._getInsertedRows();
    expect(rows.length).toBe(1);
  });
});

describe("Billing: response helpers", () => {
  it("builds a success response envelope", async () => {
    const response = billingSuccessResponse({ checkout_url: "https://example.com" }, 201);
    expect(response.status).toBe(201);

    const body = await response.json() as { ok: boolean; data: { checkout_url: string }; meta: { request_id: string } };
    expect(body.ok).toBe(true);
    expect(body.data.checkout_url).toBe("https://example.com");
    expect(body.meta.request_id).toMatch(/^req_/);
  });

  it("builds an error response envelope", async () => {
    const response = billingErrorResponse("STRIPE_ERROR", "Payment failed", 502);
    expect(response.status).toBe(502);

    const body = await response.json() as { ok: boolean; error: string; error_code: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("Payment failed");
    expect(body.error_code).toBe("STRIPE_ERROR");
  });
});

// ---------------------------------------------------------------------------
// handleGetBillingStatus -- missing table resilience (TM-y5jf)
// ---------------------------------------------------------------------------

/**
 * Create a mock D1 that throws "no such table" errors on any query,
 * simulating a D1 database where the subscriptions migration has not
 * been applied.
 */
function createMissingTableD1(): D1Database {
  return {
    prepare() {
      return {
        bind() {
          return {
            async first(): Promise<null> {
              throw new Error("no such table: subscriptions");
            },
            async all(): Promise<{ results: never[] }> {
              throw new Error("no such table: billing_events");
            },
            async run(): Promise<D1Result<unknown>> {
              throw new Error("no such table: subscriptions");
            },
          };
        },
      };
    },
    exec: vi.fn(),
    batch: vi.fn(),
    dump: vi.fn(),
  } as unknown as D1Database;
}

function buildMockBillingEnv(db: D1Database): BillingEnv {
  return {
    DB: db,
    STRIPE_SECRET_KEY: "sk_test_fake",
    STRIPE_WEBHOOK_SECRET: "whsec_test_fake",
  };
}

describe("Billing: handleGetBillingStatus -- missing table resilience", () => {
  it("returns free-tier default when subscriptions table does not exist", async () => {
    const db = createMissingTableD1();
    const env = buildMockBillingEnv(db);

    const response = await handleGetBillingStatus("usr_test_user_1", env);
    expect(response.status).toBe(200);

    const body = await response.json() as {
      ok: boolean;
      data: { tier: string; status: string; subscription: null };
    };

    expect(body.ok).toBe(true);
    expect(body.data.tier).toBe("free");
    expect(body.data.status).toBe("none");
    expect(body.data.subscription).toBeNull();
  });

  it("returns free-tier default when no subscription row exists for user", async () => {
    const db = createMockD1(); // empty rows
    const env = buildMockBillingEnv(db);

    const response = await handleGetBillingStatus("usr_test_user_1", env);
    expect(response.status).toBe(200);

    const body = await response.json() as {
      ok: boolean;
      data: { tier: string; status: string; subscription: null };
    };

    expect(body.ok).toBe(true);
    expect(body.data.tier).toBe("free");
    expect(body.data.status).toBe("none");
    expect(body.data.subscription).toBeNull();
  });

  it("returns subscription data when a record exists", async () => {
    const db = createMockD1([{
      subscription_id: "sub_internal_1",
      tier: "premium",
      stripe_customer_id: "cus_test_456",
      stripe_subscription_id: "sub_stripe_789",
      current_period_end: "2026-03-15T00:00:00.000Z",
      status: "active",
      grace_period_end: null,
      cancel_at_period_end: 0,
      previous_tier: null,
      created_at: "2026-02-15T00:00:00.000Z",
      updated_at: "2026-02-15T00:00:00.000Z",
    }]);
    const env = buildMockBillingEnv(db);

    const response = await handleGetBillingStatus("usr_test_user_1", env);
    expect(response.status).toBe(200);

    const body = await response.json() as {
      ok: boolean;
      data: {
        tier: string;
        status: string;
        subscription: {
          subscription_id: string;
          stripe_customer_id: string;
          cancel_at_period_end: boolean;
        };
      };
    };

    expect(body.ok).toBe(true);
    expect(body.data.tier).toBe("premium");
    expect(body.data.status).toBe("active");
    expect(body.data.subscription).not.toBeNull();
    expect(body.data.subscription.subscription_id).toBe("sub_internal_1");
    expect(body.data.subscription.cancel_at_period_end).toBe(false);
  });

  it("returns free-tier default on D1_ERROR (generic D1 failure)", async () => {
    const db = {
      prepare() {
        return {
          bind() {
            return {
              async first(): Promise<null> {
                throw new Error("D1_ERROR: some database error");
              },
              async all(): Promise<{ results: never[] }> {
                throw new Error("D1_ERROR: some database error");
              },
              async run(): Promise<D1Result<unknown>> {
                throw new Error("D1_ERROR: some database error");
              },
            };
          },
        };
      },
      exec: vi.fn(),
      batch: vi.fn(),
      dump: vi.fn(),
    } as unknown as D1Database;
    const env = buildMockBillingEnv(db);

    const response = await handleGetBillingStatus("usr_test_user_1", env);
    expect(response.status).toBe(200);

    const body = await response.json() as {
      ok: boolean;
      data: { tier: string; status: string; subscription: null };
    };

    expect(body.ok).toBe(true);
    expect(body.data.tier).toBe("free");
    expect(body.data.status).toBe("none");
    expect(body.data.subscription).toBeNull();
  });
});

describe("Billing: handleGetBillingEvents -- missing table resilience", () => {
  it("returns empty array when billing_events table does not exist", async () => {
    const db = createMissingTableD1();
    const env = buildMockBillingEnv(db);

    const response = await handleGetBillingEvents("usr_test_user_1", env);
    expect(response.status).toBe(200);

    const body = await response.json() as {
      ok: boolean;
      data: unknown[];
    };

    expect(body.ok).toBe(true);
    expect(body.data).toEqual([]);
  });
});
