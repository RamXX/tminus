/**
 * Integration tests for billing routes.
 *
 * Tests the FULL Stripe billing flow against real D1 (via better-sqlite3):
 * 1. Create checkout session -> verify session URL returned
 * 2. Simulate webhook checkout.session.completed -> verify tier updated in D1
 * 3. Verify feature gate blocks free user and allows premium user
 * 4. Subscription lifecycle: create, update, cancel
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
} from "@tminus/d1-registry";
import { createHandler, createJwt } from "../index";
import { getUserTier } from "./billing";
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

    const body = await response.json() as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("VALIDATION_ERROR");
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

    const signature = await generateStripeSignature(webhookPayload, STRIPE_WEBHOOK_SECRET);

    const request = new Request("https://api.tminus.ink/v1/billing/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Stripe-Signature": signature,
      },
      body: webhookPayload,
    });

    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(200);

    const body = await response.json() as { ok: boolean; data: { received: boolean } };
    expect(body.ok).toBe(true);
    expect(body.data.received).toBe(true);

    // Verify tier was upgraded to premium in D1
    const tierAfter = await getUserTier(d1, userId);
    expect(tierAfter).toBe("premium");
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

    const body = await response.json() as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("AUTH_FAILED");
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
  // Subscription lifecycle: update and cancel
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

    let sig = await generateStripeSignature(checkoutPayload, STRIPE_WEBHOOK_SECRET);
    let response = await handler.fetch(
      new Request("https://api.tminus.ink/v1/billing/webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Stripe-Signature": sig,
        },
        body: checkoutPayload,
      }),
      env,
      mockCtx,
    );
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

    sig = await generateStripeSignature(updatePayload, STRIPE_WEBHOOK_SECRET);
    response = await handler.fetch(
      new Request("https://api.tminus.ink/v1/billing/webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Stripe-Signature": sig,
        },
        body: updatePayload,
      }),
      env,
      mockCtx,
    );
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

    sig = await generateStripeSignature(deletePayload, STRIPE_WEBHOOK_SECRET);
    response = await handler.fetch(
      new Request("https://api.tminus.ink/v1/billing/webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Stripe-Signature": sig,
        },
        body: deletePayload,
      }),
      env,
      mockCtx,
    );
    expect(response.status).toBe(200);

    tier = await getUserTier(d1, userId);
    expect(tier).toBe("free");
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
    const sig = await generateStripeSignature(checkoutPayload, STRIPE_WEBHOOK_SECRET);

    await handler.fetch(
      new Request("https://api.tminus.ink/v1/billing/webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Stripe-Signature": sig,
        },
        body: checkoutPayload,
      }),
      env,
      mockCtx,
    );

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

    const sig = await generateStripeSignature(webhookPayload, STRIPE_WEBHOOK_SECRET);
    await handler.fetch(
      new Request("https://api.tminus.ink/v1/billing/webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Stripe-Signature": sig,
        },
        body: webhookPayload,
      }),
      env,
      mockCtx,
    );

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
        };
      };
    };

    expect(body.ok).toBe(true);
    expect(body.data.tier).toBe("premium");
    expect(body.data.status).toBe("active");
    expect(body.data.subscription).not.toBeNull();
    expect(body.data.subscription.stripe_customer_id).toBe("cus_status_456");
    expect(body.data.subscription.stripe_subscription_id).toBe("sub_status_789");
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

    const sig = await generateStripeSignature(webhookPayload, STRIPE_WEBHOOK_SECRET);

    const response = await handler.fetch(
      new Request("https://api.tminus.ink/v1/billing/webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Stripe-Signature": sig,
        },
        body: webhookPayload,
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; data: { received: boolean } };
    expect(body.ok).toBe(true);
    expect(body.data.received).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Payment failed -> past_due
  // -----------------------------------------------------------------------

  it("POST /v1/billing/webhook handles invoice.payment_failed", async () => {
    const { userId } = await createTestUser(db);
    const handler = createHandler();
    const env = buildEnv(d1);

    // First create a subscription via checkout
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

    let sig = await generateStripeSignature(checkoutPayload, STRIPE_WEBHOOK_SECRET);
    await handler.fetch(
      new Request("https://api.tminus.ink/v1/billing/webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Stripe-Signature": sig,
        },
        body: checkoutPayload,
      }),
      env,
      mockCtx,
    );

    // Now simulate payment failure
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

    sig = await generateStripeSignature(failPayload, STRIPE_WEBHOOK_SECRET);
    const response = await handler.fetch(
      new Request("https://api.tminus.ink/v1/billing/webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Stripe-Signature": sig,
        },
        body: failPayload,
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(200);

    // Verify subscription status is past_due
    const row = db
      .prepare("SELECT status FROM subscriptions WHERE stripe_subscription_id = ?")
      .get("sub_fail_789") as { status: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.status).toBe("past_due");
  });
});
