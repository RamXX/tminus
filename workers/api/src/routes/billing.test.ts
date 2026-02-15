/**
 * Unit tests for billing routes.
 *
 * Tests:
 * - Stripe webhook signature verification
 * - Tier resolution from price ID
 * - Checkout session creation logic (validation)
 * - Webhook event parsing and handling
 * - Billing status retrieval
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  verifyStripeWebhookSignature,
  resolveTierFromPrice,
  handleCheckoutCompleted,
  handleSubscriptionUpdated,
  handleSubscriptionDeleted,
  handlePaymentFailed,
  billingSuccessResponse,
  billingErrorResponse,
  getUserTier,
  upsertSubscription,
} from "./billing";
import type { StripeSubscription } from "./billing";

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

function createMockD1(rows: MockRow[] = []): D1Database {
  let insertedRows: MockRow[] = [];
  let lastUpdatedParams: unknown[] = [];

  return {
    prepare(sql: string) {
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
    exec: vi.fn(),
    batch: vi.fn(),
    dump: vi.fn(),
  } as unknown as D1Database & {
    _getInsertedRows(): MockRow[];
    _getLastUpdatedParams(): unknown[];
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

describe("Billing: handleSubscriptionUpdated", () => {
  it("updates subscription status and tier", async () => {
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

  it("sets tier to free on cancellation", async () => {
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

describe("Billing: handlePaymentFailed", () => {
  it("marks subscription as past_due", async () => {
    const db = createMockD1();
    const invoice = {
      id: "in_test_123",
      subscription: "sub_test_789",
    };

    const result = await handlePaymentFailed(db, invoice);
    expect(result.success).toBe(true);
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

    const body = await response.json() as { ok: boolean; error: { code: string; message: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("STRIPE_ERROR");
    expect(body.error.message).toBe("Payment failed");
  });
});
