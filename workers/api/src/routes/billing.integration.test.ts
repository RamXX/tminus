/**
 * Integration tests for billing routes -- subscription lifecycle management.
 *
 * Tests the FULL Stripe billing flow against real D1 (via better-sqlite3):
 * 1. Create checkout session -> verify session URL returned
 * 2. Simulate webhook checkout.session.completed -> verify tier updated in D1
 * 3. Verify feature gate blocks free user and allows premium user
 * 4. Subscription lifecycle: upgrade, downgrade, cancel, renew, payment failure
 * 5. Grace period on payment failure
 * 6. All events logged to billing_events audit table
 * 7. Billing status endpoint includes lifecycle fields
 *
 * External Stripe API calls are mocked at the fetch level.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import {
  MIGRATION_0001_INITIAL_SCHEMA,
  MIGRATION_0004_AUTH_FIELDS,
  MIGRATION_0012_SUBSCRIPTIONS,
  MIGRATION_0013_SUBSCRIPTION_LIFECYCLE,
} from "@tminus/d1-registry";
import { createHandler, createJwt } from "../index";
import { getUserTier, GRACE_PERIOD_DAYS } from "./billing";
import { checkFeatureGate, isTierSufficient } from "../middleware/feature-gate";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const JWT_SECRET = "integration-test-jwt-secret-32chars-minimum";
const STRIPE_SECRET_KEY = "sk_test_integration_test_key_not_real";
const STRIPE_WEBHOOK_SECRET = "whsec_test_integration_webhook_secret";

// ---------------------------------------------------------------------------
// Real D1 mock backed by better-sqlite3
// ---------------------------------------------------------------------------

function createRealD1(db: DatabaseType): D1Database {
  const normalizeSQL = (sql: string): string => sql.replace(/\?(\d+)/g, "?");

  return {
    prepare(sql: string) {
      const normalizedSql = normalizeSQL(sql);
      return {
        bind(...params: unknown[]) {
          return {
            first<T>(): Promise<T | null> {
              const stmt = db.prepare(normalizedSql);
              const row = stmt.get(...params) as T | null;
              return Promise.resolve(row ?? null);
            },
            all<T>(): Promise<{ results: T[] }> {
              const stmt = db.prepare(normalizedSql);
              const rows = stmt.all(...params) as T[];
              return Promise.resolve({ results: rows });
            },
            run(): Promise<D1Result<unknown>> {
              const stmt = db.prepare(normalizedSql);
              const info = stmt.run(...params);
              return Promise.resolve({
                success: true,
                results: [],
                meta: {
                  duration: 0,
                  rows_read: 0,
                  rows_written: info.changes,
                  last_row_id: info.lastInsertRowid as number,
                  changed_db: info.changes > 0,
                  size_after: 0,
                  changes: info.changes,
                },
              } as unknown as D1Result<unknown>);
            },
          };
        },
      };
    },
    exec(sql: string): Promise<D1ExecResult> {
      db.exec(sql);
      return Promise.resolve({ count: 0, duration: 0 });
    },
    batch(_stmts: D1PreparedStatement[]): Promise<D1Result<unknown>[]> {
      return Promise.resolve([]);
    },
    dump(): Promise<ArrayBuffer> {
      return Promise.resolve(new ArrayBuffer(0));
    },
  } as unknown as D1Database;
}

// ---------------------------------------------------------------------------
// Mock KV namespace (in-memory)
// ---------------------------------------------------------------------------

function createMockKV(): KVNamespace {
  const store = new Map<string, { value: string; expiration?: number }>();
  return {
    async get(key: string): Promise<string | null> {
      const entry = store.get(key);
      if (!entry) return null;
      return entry.value;
    },
    async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
      const expiration = opts?.expirationTtl
        ? Math.floor(Date.now() / 1000) + opts.expirationTtl
        : undefined;
      store.set(key, { value, expiration });
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
    async list(): Promise<{ keys: Array<{ name: string }>; list_complete: boolean }> {
      return { keys: Array.from(store.keys()).map((name) => ({ name })), list_complete: true };
    },
    async getWithMetadata(): Promise<{ value: string | null; metadata: unknown }> {
      return { value: null, metadata: null };
    },
  } as unknown as KVNamespace;
}

// ---------------------------------------------------------------------------
// Mock DO namespace (minimal)
// ---------------------------------------------------------------------------

function createMockDONamespace(): DurableObjectNamespace {
  return {
    idFromName(name: string) {
      return { toString: () => name, name, equals: () => false } as unknown as DurableObjectId;
    },
    get(_id: DurableObjectId) {
      return {
        async fetch(): Promise<Response> {
          return new Response(JSON.stringify({ items: [], cursor: null, has_more: false }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      } as unknown as DurableObjectStub;
    },
    idFromString: () => ({} as DurableObjectId),
    newUniqueId: () => ({} as DurableObjectId),
    jurisdiction: function () { return this; },
  } as unknown as DurableObjectNamespace;
}

// ---------------------------------------------------------------------------
// Mock Queue
// ---------------------------------------------------------------------------

function createMockQueue(): Queue {
  return {
    async send() {},
    async sendBatch() {},
  } as unknown as Queue;
}

// ---------------------------------------------------------------------------
// Stripe signature helper
// ---------------------------------------------------------------------------

async function generateStripeSignature(
  payload: string,
  secret: string,
  timestamp?: number,
): Promise<string> {
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

  return `t=${ts},v1=${signature}`;
}

// ---------------------------------------------------------------------------
// Test env builder
// ---------------------------------------------------------------------------

function buildEnv(d1: D1Database): Env {
  return {
    DB: d1,
    USER_GRAPH: createMockDONamespace(),
    ACCOUNT: createMockDONamespace(),
    SYNC_QUEUE: createMockQueue(),
    WRITE_QUEUE: createMockQueue(),
    SESSIONS: createMockKV(),
    RATE_LIMITS: createMockKV(),
    JWT_SECRET,
    STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET,
  };
}

const mockCtx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

// ---------------------------------------------------------------------------
// Helper to create a test user and JWT
// ---------------------------------------------------------------------------

async function createTestUser(db: DatabaseType): Promise<{ userId: string; token: string }> {
  const userId = "usr_01HWTEST000000000000000000";

  // Insert org and user
  db.exec(`INSERT INTO orgs (org_id, name) VALUES ('org_test_01', 'Test Org')`);
  db.exec(
    `INSERT INTO users (user_id, org_id, email, password_hash, password_version)
     VALUES ('${userId}', 'org_test_01', 'test@example.com', 'hash', 1)`,
  );

  const token = await createJwt(
    {
      sub: userId,
      email: "test@example.com",
      tier: "free",
      pwd_ver: 1,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    JWT_SECRET,
  );

  return { userId, token };
}

// ---------------------------------------------------------------------------
// Helper: send webhook
// ---------------------------------------------------------------------------

async function sendWebhook(
  handler: ReturnType<typeof createHandler>,
  env: ReturnType<typeof buildEnv>,
  payload: string,
): Promise<Response> {
  const sig = await generateStripeSignature(payload, STRIPE_WEBHOOK_SECRET);
  return handler.fetch(
    new Request("https://api.tminus.ink/v1/billing/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Stripe-Signature": sig,
      },
      body: payload,
    }),
    env,
    mockCtx,
  );
}

// ===========================================================================
// Integration tests
// ===========================================================================

describe("Integration: Billing routes", () => {
  let db: DatabaseType;
  let d1: D1Database;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(MIGRATION_0001_INITIAL_SCHEMA);
    db.exec(MIGRATION_0004_AUTH_FIELDS);
    db.exec(MIGRATION_0012_SUBSCRIPTIONS);
    db.exec(MIGRATION_0013_SUBSCRIPTION_LIFECYCLE);
    d1 = createRealD1(db);

    // Save original fetch for Stripe API mock
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    db.close();
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // Checkout session creation
  // -----------------------------------------------------------------------

  it("POST /v1/billing/checkout creates a checkout session", async () => {
    const { token } = await createTestUser(db);
    const handler = createHandler();
    const env = buildEnv(d1);

    // Mock Stripe API
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "cs_test_session_123",
          url: "https://checkout.stripe.com/c/pay/cs_test_session_123",
          customer: "cus_test_456",
          subscription: null,
          metadata: { user_id: "usr_01HWTEST000000000000000000" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const request = new Request("https://api.tminus.ink/v1/billing/checkout", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ price_id: "price_premium_monthly" }),
    });

    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(201);

    const body = await response.json() as {
      ok: boolean;
      data: { session_id: string; checkout_url: string };
    };

    expect(body.ok).toBe(true);
    expect(body.data.session_id).toBe("cs_test_session_123");
    expect(body.data.checkout_url).toContain("checkout.stripe.com");
  });

  it("POST /v1/billing/checkout returns 400 without price_id", async () => {
    const { token } = await createTestUser(db);
    const handler = createHandler();
    const env = buildEnv(d1);

    const request = new Request("https://api.tminus.ink/v1/billing/checkout", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({}),
    });

    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(400);

    const body = await response.json() as { ok: boolean; error_code: string };
    expect(body.ok).toBe(false);
    expect(body.error_code).toBe("VALIDATION_ERROR");
  });

  it("POST /v1/billing/checkout returns 401 without auth", async () => {
    const handler = createHandler();
    const env = buildEnv(d1);

    const request = new Request("https://api.tminus.ink/v1/billing/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ price_id: "price_premium_monthly" }),
    });

    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(401);
  });

  // -----------------------------------------------------------------------
  // Webhook: checkout.session.completed -> tier upgrade
  // -----------------------------------------------------------------------

  it("POST /v1/billing/webhook handles checkout.session.completed and upgrades tier", async () => {
    const { userId } = await createTestUser(db);
    const handler = createHandler();
    const env = buildEnv(d1);

    // Verify user starts as free
    const tierBefore = await getUserTier(d1, userId);
    expect(tierBefore).toBe("free");

    // Create the webhook payload
    const webhookPayload = JSON.stringify({
      id: "evt_test_checkout_completed",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_123",
          customer: "cus_test_456",
          subscription: "sub_test_789",
          metadata: { user_id: userId },
        },
      },
    });

    const response = await sendWebhook(handler, env, webhookPayload);
    expect(response.status).toBe(200);

    const body = await response.json() as { ok: boolean; data: { received: boolean } };
    expect(body.ok).toBe(true);
    expect(body.data.received).toBe(true);

    // Verify tier was upgraded to premium in D1
    const tierAfter = await getUserTier(d1, userId);
    expect(tierAfter).toBe("premium");

    // Verify billing event was logged
    const events = db.prepare("SELECT * FROM billing_events WHERE user_id = ?").all(userId) as Array<{ event_type: string }>;
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.some(e => e.event_type === "checkout_completed")).toBe(true);
  });

  it("POST /v1/billing/webhook rejects invalid signature", async () => {
    const handler = createHandler();
    const env = buildEnv(d1);

    const webhookPayload = JSON.stringify({
      id: "evt_test_invalid",
      type: "checkout.session.completed",
      data: { object: {} },
    });

    const request = new Request("https://api.tminus.ink/v1/billing/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Stripe-Signature": "t=123,v1=invalid_signature_here",
      },
      body: webhookPayload,
    });

    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(401);

    const body = await response.json() as { ok: boolean; error_code: string };
    expect(body.ok).toBe(false);
    expect(body.error_code).toBe("AUTH_FAILED");
  });

  it("POST /v1/billing/webhook returns 400 without Stripe-Signature header", async () => {
    const handler = createHandler();
    const env = buildEnv(d1);

    const request = new Request("https://api.tminus.ink/v1/billing/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "evt_test", type: "test", data: { object: {} } }),
    });

    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(400);
  });

  // -----------------------------------------------------------------------
  // AC#1: Upgrade -> immediate tier change
  // -----------------------------------------------------------------------

  it("upgrade via customer.subscription.updated immediately changes tier (AC#1)", async () => {
    const { userId } = await createTestUser(db);
    const handler = createHandler();
    const env = buildEnv(d1);

    // Step 1: Checkout -> premium
    const checkoutPayload = JSON.stringify({
      id: "evt_checkout_upgrade",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_upgrade_test",
          customer: "cus_upgrade_456",
          subscription: "sub_upgrade_789",
          metadata: { user_id: userId },
        },
      },
    });

    let response = await sendWebhook(handler, env, checkoutPayload);
    expect(response.status).toBe(200);

    let tier = await getUserTier(d1, userId);
    expect(tier).toBe("premium");

    // Step 2: Upgrade to enterprise (immediate)
    const upgradePayload = JSON.stringify({
      id: "evt_upgrade_to_enterprise",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_upgrade_789",
          customer: "cus_upgrade_456",
          status: "active",
          current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
          metadata: { user_id: userId },
          items: { data: [{ price: { id: "price_enterprise_monthly" } }] },
        },
      },
    });

    response = await sendWebhook(handler, env, upgradePayload);
    expect(response.status).toBe(200);

    // Verify tier changed immediately to enterprise
    tier = await getUserTier(d1, userId);
    expect(tier).toBe("enterprise");

    // Verify billing event logged as upgrade
    const events = db.prepare(
      "SELECT event_type FROM billing_events WHERE user_id = ? ORDER BY created_at",
    ).all(userId) as Array<{ event_type: string }>;
    expect(events.some(e => e.event_type === "subscription_upgraded")).toBe(true);
  });

  // -----------------------------------------------------------------------
  // AC#2: Downgrade -> end of billing period
  // -----------------------------------------------------------------------

  it("downgrade via customer.subscription.updated keeps old tier with cancel_at_period_end (AC#2)", async () => {
    const { userId } = await createTestUser(db);
    const handler = createHandler();
    const env = buildEnv(d1);

    // Step 1: Checkout -> premium
    const checkoutPayload = JSON.stringify({
      id: "evt_checkout_downgrade",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_downgrade_test",
          customer: "cus_downgrade_456",
          subscription: "sub_downgrade_789",
          metadata: { user_id: userId },
        },
      },
    });

    let response = await sendWebhook(handler, env, checkoutPayload);
    expect(response.status).toBe(200);

    // Step 2: Upgrade to enterprise so we can test downgrade
    const upgradePayload = JSON.stringify({
      id: "evt_upgrade_for_downgrade",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_downgrade_789",
          customer: "cus_downgrade_456",
          status: "active",
          current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
          metadata: { user_id: userId },
          items: { data: [{ price: { id: "price_enterprise_monthly" } }] },
        },
      },
    });

    response = await sendWebhook(handler, env, upgradePayload);
    expect(response.status).toBe(200);

    let tier = await getUserTier(d1, userId);
    expect(tier).toBe("enterprise");

    // Step 3: Downgrade to premium (should keep enterprise until period end)
    const downgradePayload = JSON.stringify({
      id: "evt_downgrade_to_premium",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_downgrade_789",
          customer: "cus_downgrade_456",
          status: "active",
          current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
          metadata: { user_id: userId },
          items: { data: [{ price: { id: "price_premium_monthly" } }] },
        },
      },
    });

    response = await sendWebhook(handler, env, downgradePayload);
    expect(response.status).toBe(200);

    // Tier should STILL be enterprise (keeps access until period end)
    tier = await getUserTier(d1, userId);
    expect(tier).toBe("enterprise");

    // Verify cancel_at_period_end flag is set
    const sub = db.prepare(
      "SELECT cancel_at_period_end, previous_tier FROM subscriptions WHERE stripe_subscription_id = ?",
    ).get("sub_downgrade_789") as { cancel_at_period_end: number; previous_tier: string | null };
    expect(sub.cancel_at_period_end).toBe(1);

    // Verify billing event logged as downgrade
    const events = db.prepare(
      "SELECT event_type, metadata FROM billing_events WHERE user_id = ? AND event_type = 'subscription_downgraded'",
    ).all(userId) as Array<{ event_type: string; metadata: string | null }>;
    expect(events.length).toBeGreaterThanOrEqual(1);

    // Verify metadata includes scheduled new tier
    if (events[0].metadata) {
      const meta = JSON.parse(events[0].metadata);
      expect(meta.scheduled_new_tier).toBe("premium");
    }
  });

  // -----------------------------------------------------------------------
  // AC#3: Cancellation -> revert to free at period end
  // -----------------------------------------------------------------------

  it("customer.subscription.deleted reverts to free (AC#3)", async () => {
    const { userId } = await createTestUser(db);
    const handler = createHandler();
    const env = buildEnv(d1);

    // Step 1: Checkout -> premium
    const checkoutPayload = JSON.stringify({
      id: "evt_checkout_cancel",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_cancel_test",
          customer: "cus_cancel_456",
          subscription: "sub_cancel_789",
          metadata: { user_id: userId },
        },
      },
    });

    let response = await sendWebhook(handler, env, checkoutPayload);
    expect(response.status).toBe(200);

    let tier = await getUserTier(d1, userId);
    expect(tier).toBe("premium");

    // Step 2: Subscription deleted (cancelled at period end by Stripe)
    const deletePayload = JSON.stringify({
      id: "evt_sub_deleted_cancel",
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: "sub_cancel_789",
          customer: "cus_cancel_456",
          status: "canceled",
          current_period_end: Math.floor(Date.now() / 1000),
          metadata: { user_id: userId },
        },
      },
    });

    response = await sendWebhook(handler, env, deletePayload);
    expect(response.status).toBe(200);

    // Verify reverted to free
    tier = await getUserTier(d1, userId);
    expect(tier).toBe("free");

    // Verify status is cancelled
    const sub = db.prepare(
      "SELECT status, previous_tier FROM subscriptions WHERE stripe_subscription_id = ?",
    ).get("sub_cancel_789") as { status: string; previous_tier: string | null };
    expect(sub.status).toBe("cancelled");
    expect(sub.previous_tier).toBe("premium");

    // Verify billing event logged
    const events = db.prepare(
      "SELECT event_type FROM billing_events WHERE user_id = ? AND event_type = 'subscription_deleted'",
    ).all(userId) as Array<{ event_type: string }>;
    expect(events.length).toBe(1);
  });

  // -----------------------------------------------------------------------
  // AC#4: Payment failure -> grace period then downgrade
  // -----------------------------------------------------------------------

  it("invoice.payment_failed sets grace period (AC#4)", async () => {
    const { userId } = await createTestUser(db);
    const handler = createHandler();
    const env = buildEnv(d1);

    // Step 1: Checkout -> premium
    const checkoutPayload = JSON.stringify({
      id: "evt_checkout_for_fail",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_fail_test",
          customer: "cus_fail_456",
          subscription: "sub_fail_789",
          metadata: { user_id: userId },
        },
      },
    });

    let response = await sendWebhook(handler, env, checkoutPayload);
    expect(response.status).toBe(200);

    // Step 2: Payment failure
    const failPayload = JSON.stringify({
      id: "evt_payment_failed",
      type: "invoice.payment_failed",
      data: {
        object: {
          id: "in_fail_123",
          subscription: "sub_fail_789",
        },
      },
    });

    response = await sendWebhook(handler, env, failPayload);
    expect(response.status).toBe(200);

    // Verify subscription status is past_due
    const sub = db.prepare(
      "SELECT status, grace_period_end FROM subscriptions WHERE stripe_subscription_id = ?",
    ).get("sub_fail_789") as { status: string; grace_period_end: string | null };
    expect(sub.status).toBe("past_due");

    // Verify grace period is set
    expect(sub.grace_period_end).not.toBeNull();
    const gracePeriodEnd = new Date(sub.grace_period_end!);
    const now = new Date();
    const expectedMinEnd = new Date(now.getTime() + (GRACE_PERIOD_DAYS - 1) * 24 * 60 * 60 * 1000);
    expect(gracePeriodEnd.getTime()).toBeGreaterThan(expectedMinEnd.getTime());

    // Verify billing events logged (payment_failed + grace_period_started)
    const events = db.prepare(
      "SELECT event_type FROM billing_events WHERE user_id = ? ORDER BY created_at",
    ).all(userId) as Array<{ event_type: string }>;
    expect(events.some(e => e.event_type === "payment_failed")).toBe(true);
    expect(events.some(e => e.event_type === "grace_period_started")).toBe(true);
  });

  // -----------------------------------------------------------------------
  // AC#5: Renewal -> extend current_period_end
  // -----------------------------------------------------------------------

  it("subscription renewal extends current_period_end (AC#5)", async () => {
    const { userId } = await createTestUser(db);
    const handler = createHandler();
    const env = buildEnv(d1);

    // Step 1: Checkout -> premium
    const checkoutPayload = JSON.stringify({
      id: "evt_checkout_renew",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_renew_test",
          customer: "cus_renew_456",
          subscription: "sub_renew_789",
          metadata: { user_id: userId },
        },
      },
    });

    let response = await sendWebhook(handler, env, checkoutPayload);
    expect(response.status).toBe(200);

    // Get initial period end
    const initialSub = db.prepare(
      "SELECT current_period_end FROM subscriptions WHERE stripe_subscription_id = ?",
    ).get("sub_renew_789") as { current_period_end: string };
    const initialPeriodEnd = initialSub.current_period_end;

    // Step 2: Subscription renewed (extended period end, same tier)
    const newPeriodEnd = Math.floor(Date.now() / 1000) + 60 * 24 * 3600; // 60 days from now
    const renewPayload = JSON.stringify({
      id: "evt_renewal",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_renew_789",
          customer: "cus_renew_456",
          status: "active",
          current_period_end: newPeriodEnd,
          metadata: { user_id: userId },
          items: { data: [{ price: { id: "price_premium_monthly" } }] },
        },
      },
    });

    response = await sendWebhook(handler, env, renewPayload);
    expect(response.status).toBe(200);

    // Verify period end was extended
    const renewedSub = db.prepare(
      "SELECT current_period_end FROM subscriptions WHERE stripe_subscription_id = ?",
    ).get("sub_renew_789") as { current_period_end: string };
    const renewedPeriodEnd = renewedSub.current_period_end;

    expect(new Date(renewedPeriodEnd).getTime()).toBeGreaterThan(
      new Date(initialPeriodEnd).getTime(),
    );

    // Tier should still be premium
    const tier = await getUserTier(d1, userId);
    expect(tier).toBe("premium");

    // Verify billing event logged as renewal
    const events = db.prepare(
      "SELECT event_type FROM billing_events WHERE user_id = ? AND event_type = 'subscription_renewed'",
    ).all(userId) as Array<{ event_type: string }>;
    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  // -----------------------------------------------------------------------
  // AC#6: All events logged
  // -----------------------------------------------------------------------

  it("all lifecycle events are logged to billing_events (AC#6)", async () => {
    const { userId } = await createTestUser(db);
    const handler = createHandler();
    const env = buildEnv(d1);

    // 1. Checkout -> premium
    await sendWebhook(handler, env, JSON.stringify({
      id: "evt_lifecycle_checkout",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_lifecycle_test",
          customer: "cus_lifecycle_456",
          subscription: "sub_lifecycle_789",
          metadata: { user_id: userId },
        },
      },
    }));

    // 2. Subscription update (renewal, same tier)
    const periodEnd1 = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
    await sendWebhook(handler, env, JSON.stringify({
      id: "evt_lifecycle_update",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_lifecycle_789",
          customer: "cus_lifecycle_456",
          status: "active",
          current_period_end: periodEnd1,
          metadata: { user_id: userId },
          items: { data: [{ price: { id: "price_premium_monthly" } }] },
        },
      },
    }));

    // 3. Payment failed
    await sendWebhook(handler, env, JSON.stringify({
      id: "evt_lifecycle_fail",
      type: "invoice.payment_failed",
      data: {
        object: {
          id: "in_lifecycle_123",
          subscription: "sub_lifecycle_789",
        },
      },
    }));

    // 4. Subscription deleted (cancelled)
    await sendWebhook(handler, env, JSON.stringify({
      id: "evt_lifecycle_delete",
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: "sub_lifecycle_789",
          customer: "cus_lifecycle_456",
          status: "canceled",
          current_period_end: Math.floor(Date.now() / 1000),
          metadata: { user_id: userId },
        },
      },
    }));

    // Verify ALL events were logged
    const events = db.prepare(
      "SELECT event_type, stripe_event_id, old_tier, new_tier FROM billing_events WHERE user_id = ? ORDER BY created_at",
    ).all(userId) as Array<{
      event_type: string;
      stripe_event_id: string;
      old_tier: string | null;
      new_tier: string | null;
    }>;

    // Should have at least: checkout_completed, subscription_renewed, payment_failed, grace_period_started, subscription_deleted
    expect(events.length).toBeGreaterThanOrEqual(5);

    const eventTypes = events.map(e => e.event_type);
    expect(eventTypes).toContain("checkout_completed");
    expect(eventTypes).toContain("payment_failed");
    expect(eventTypes).toContain("grace_period_started");
    expect(eventTypes).toContain("subscription_deleted");

    // All events should have stripe_event_id set
    expect(events.every(e => e.stripe_event_id !== null)).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Full lifecycle: checkout -> update -> cancel -> verify data preserved
  // -----------------------------------------------------------------------

  it("handles subscription updated -> subscription deleted (full lifecycle)", async () => {
    const { userId } = await createTestUser(db);
    const handler = createHandler();
    const env = buildEnv(d1);

    // Step 1: Checkout completed -> premium
    const checkoutPayload = JSON.stringify({
      id: "evt_checkout",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_lifecycle",
          customer: "cus_lifecycle_456",
          subscription: "sub_lifecycle_789",
          metadata: { user_id: userId },
        },
      },
    });

    let response = await sendWebhook(handler, env, checkoutPayload);
    expect(response.status).toBe(200);

    let tier = await getUserTier(d1, userId);
    expect(tier).toBe("premium");

    // Step 2: Subscription updated (still active)
    const updatePayload = JSON.stringify({
      id: "evt_sub_updated",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_lifecycle_789",
          customer: "cus_lifecycle_456",
          status: "active",
          current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
          metadata: { user_id: userId },
          items: { data: [{ price: { id: "price_premium_monthly" } }] },
        },
      },
    });

    response = await sendWebhook(handler, env, updatePayload);
    expect(response.status).toBe(200);

    tier = await getUserTier(d1, userId);
    expect(tier).toBe("premium");

    // Step 3: Subscription deleted (cancelled) -> back to free
    const deletePayload = JSON.stringify({
      id: "evt_sub_deleted",
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: "sub_lifecycle_789",
          customer: "cus_lifecycle_456",
          status: "canceled",
          current_period_end: Math.floor(Date.now() / 1000),
          metadata: { user_id: userId },
        },
      },
    });

    response = await sendWebhook(handler, env, deletePayload);
    expect(response.status).toBe(200);

    tier = await getUserTier(d1, userId);
    expect(tier).toBe("free");

    // Verify subscription record still exists (data preserved -- AC#3)
    const sub = db.prepare(
      "SELECT * FROM subscriptions WHERE stripe_subscription_id = ?",
    ).get("sub_lifecycle_789");
    expect(sub).not.toBeNull();
  });

  // -----------------------------------------------------------------------
  // Feature gate: free vs premium access
  // -----------------------------------------------------------------------

  it("feature gate blocks free user from premium features", async () => {
    const { userId } = await createTestUser(db);

    // User has no subscription -> free tier
    const allowed = await checkFeatureGate(userId, "premium", d1);
    expect(allowed).toBe(false);
  });

  it("feature gate allows premium user to access premium features", async () => {
    const { userId } = await createTestUser(db);

    // Simulate checkout completed -> user becomes premium
    const checkoutPayload = JSON.stringify({
      id: "evt_gate_test",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_gate_test",
          customer: "cus_gate_456",
          subscription: "sub_gate_789",
          metadata: { user_id: userId },
        },
      },
    });

    const handler = createHandler();
    const env = buildEnv(d1);
    await sendWebhook(handler, env, checkoutPayload);

    // Now the user should be premium
    const allowed = await checkFeatureGate(userId, "premium", d1);
    expect(allowed).toBe(true);
  });

  it("feature gate always allows free features", async () => {
    const { userId } = await createTestUser(db);

    const allowed = await checkFeatureGate(userId, "free", d1);
    expect(allowed).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Billing status endpoint
  // -----------------------------------------------------------------------

  it("GET /v1/billing/status returns free tier when no subscription exists", async () => {
    const { token } = await createTestUser(db);
    const handler = createHandler();
    const env = buildEnv(d1);

    const request = new Request("https://api.tminus.ink/v1/billing/status", {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });

    const response = await handler.fetch(request, env, mockCtx);
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

  it("GET /v1/billing/status returns premium tier after checkout", async () => {
    const { userId, token } = await createTestUser(db);
    const handler = createHandler();
    const env = buildEnv(d1);

    // Simulate checkout completed
    const webhookPayload = JSON.stringify({
      id: "evt_status_test",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_status_test",
          customer: "cus_status_456",
          subscription: "sub_status_789",
          metadata: { user_id: userId },
        },
      },
    });

    await sendWebhook(handler, env, webhookPayload);

    // Now check billing status
    const request = new Request("https://api.tminus.ink/v1/billing/status", {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });

    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(200);

    const body = await response.json() as {
      ok: boolean;
      data: {
        tier: string;
        status: string;
        subscription: {
          subscription_id: string;
          stripe_customer_id: string;
          stripe_subscription_id: string;
          cancel_at_period_end: boolean;
          grace_period_end: string | null;
        };
      };
    };

    expect(body.ok).toBe(true);
    expect(body.data.tier).toBe("premium");
    expect(body.data.status).toBe("active");
    expect(body.data.subscription).not.toBeNull();
    expect(body.data.subscription.stripe_customer_id).toBe("cus_status_456");
    expect(body.data.subscription.stripe_subscription_id).toBe("sub_status_789");
    expect(body.data.subscription.cancel_at_period_end).toBe(false);
    expect(body.data.subscription.grace_period_end).toBeNull();
  });

  it("GET /v1/billing/status includes grace_period_end after payment failure", async () => {
    const { userId, token } = await createTestUser(db);
    const handler = createHandler();
    const env = buildEnv(d1);

    // Checkout
    await sendWebhook(handler, env, JSON.stringify({
      id: "evt_status_checkout",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_status_grace",
          customer: "cus_status_grace_456",
          subscription: "sub_status_grace_789",
          metadata: { user_id: userId },
        },
      },
    }));

    // Payment failure
    await sendWebhook(handler, env, JSON.stringify({
      id: "evt_status_fail",
      type: "invoice.payment_failed",
      data: {
        object: {
          id: "in_status_fail_123",
          subscription: "sub_status_grace_789",
        },
      },
    }));

    // Check status
    const request = new Request("https://api.tminus.ink/v1/billing/status", {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });

    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(200);

    const body = await response.json() as {
      ok: boolean;
      data: {
        tier: string;
        status: string;
        subscription: {
          grace_period_end: string | null;
        };
      };
    };

    expect(body.data.status).toBe("past_due");
    expect(body.data.subscription.grace_period_end).not.toBeNull();
  });

  // -----------------------------------------------------------------------
  // Webhook for unknown events (should acknowledge without error)
  // -----------------------------------------------------------------------

  it("POST /v1/billing/webhook acknowledges unknown event types", async () => {
    const handler = createHandler();
    const env = buildEnv(d1);

    const webhookPayload = JSON.stringify({
      id: "evt_unknown_type",
      type: "charge.succeeded",
      data: { object: { id: "ch_test_123" } },
    });

    const response = await sendWebhook(handler, env, webhookPayload);
    expect(response.status).toBe(200);

    const body = await response.json() as { ok: boolean; data: { received: boolean } };
    expect(body.ok).toBe(true);
    expect(body.data.received).toBe(true);
  });
});
