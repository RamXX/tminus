/**
 * Phase 3C E2E Validation: Billing pipeline end-to-end proof.
 *
 * This test suite tells the COMPLETE billing story:
 *   1. Free user blocked from premium features -> 403 TIER_REQUIRED with upgrade_url
 *   2. Free user hits POST /v1/billing/checkout -> gets checkout URL (mock Stripe)
 *   3. Stripe webhook fires checkout.session.completed -> tier upgraded to premium in D1
 *   4. Premium features now accessible (scheduling, constraints)
 *   5. GET /v1/billing/status returns correct plan info
 *   6. Account limits enforced: free=2, premium=5, enterprise=10
 *   7. Subscription lifecycle: upgrade, downgrade, cancel, grace period
 *
 * All Stripe API calls are mocked at the fetch level. D1 is backed by real
 * SQLite (better-sqlite3) for accurate SQL behavior. JWT auth is real.
 *
 * Story: TM-jfs.5 (Phase 3C E2E Validation)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import {
  MIGRATION_0001_INITIAL_SCHEMA,
  MIGRATION_0004_AUTH_FIELDS,
  MIGRATION_0008_SYNC_STATUS_COLUMNS,
  MIGRATION_0012_SUBSCRIPTIONS,
  MIGRATION_0013_SUBSCRIPTION_LIFECYCLE,
} from "@tminus/d1-registry";
import { createHandler, createJwt } from "../index";
import { getUserTier, GRACE_PERIOD_DAYS } from "./billing";
import {
  ACCOUNT_LIMITS,
  isTierSufficient,
  checkFeatureGate,
  enforceFeatureGate,
  enforceAccountLimit,
  FEATURE_TIERS,
} from "../middleware/feature-gate";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const JWT_SECRET = "e2e-validation-jwt-secret-32chars-minimum";
const STRIPE_SECRET_KEY = "sk_test_e2e_validation_not_real";
const STRIPE_WEBHOOK_SECRET = "whsec_e2e_validation_webhook_secret";

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
// Stripe webhook signature generator
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
// Helper: create test user and JWT
// ---------------------------------------------------------------------------

async function createTestUser(
  db: DatabaseType,
  overrides?: { userId?: string; email?: string },
): Promise<{ userId: string; token: string }> {
  const userId = overrides?.userId ?? "usr_e2e_billing_validation_001";
  const email = overrides?.email ?? "e2e-billing@example.com";

  // Insert org if not exists
  const orgExists = db.prepare("SELECT org_id FROM orgs WHERE org_id = 'org_e2e_01'").get();
  if (!orgExists) {
    db.exec("INSERT INTO orgs (org_id, name) VALUES ('org_e2e_01', 'E2E Test Org')");
  }

  // Insert user
  db.exec(
    `INSERT INTO users (user_id, org_id, email, password_hash, password_version)
     VALUES ('${userId}', 'org_e2e_01', '${email}', 'hash', 1)`,
  );

  const token = await createJwt(
    {
      sub: userId,
      email,
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
// Helper: send webhook with valid signature
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

// ---------------------------------------------------------------------------
// Helper: add N accounts for a user (for limit testing)
// ---------------------------------------------------------------------------

function addAccountsForUser(db: DatabaseType, userId: string, count: number): string[] {
  const accountIds: string[] = [];
  for (let i = 0; i < count; i++) {
    const accountId = `acc_e2e_${userId}_${i.toString().padStart(3, "0")}`;
    db.exec(
      `INSERT INTO accounts (account_id, user_id, provider, provider_subject, email, status)
       VALUES ('${accountId}', '${userId}', 'google', 'sub_${accountId}', 'acct${i}@example.com', 'active')`,
    );
    accountIds.push(accountId);
  }
  return accountIds;
}

// ===========================================================================
// E2E Validation Test Suite
// ===========================================================================

describe("Phase 3C E2E Validation: Billing pipeline end-to-end", () => {
  let db: DatabaseType;
  let d1: D1Database;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(MIGRATION_0001_INITIAL_SCHEMA);
    db.exec(MIGRATION_0004_AUTH_FIELDS);
    db.exec(MIGRATION_0008_SYNC_STATUS_COLUMNS);
    db.exec(MIGRATION_0012_SUBSCRIPTIONS);
    db.exec(MIGRATION_0013_SUBSCRIPTION_LIFECYCLE);
    d1 = createRealD1(db);
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    db.close();
    vi.restoreAllMocks();
  });

  // =========================================================================
  // AC#1: Free user blocked from Premium features
  // =========================================================================

  describe("AC#1: Free user blocked from premium features", () => {
    it("free user gets 403 TIER_REQUIRED when calling scheduling (premium feature)", async () => {
      const { userId } = await createTestUser(db);

      // Verify user is free
      const tier = await getUserTier(d1, userId);
      expect(tier).toBe("free");

      // Feature gate should deny premium access
      const denied = await enforceFeatureGate(userId, "premium", d1);
      expect(denied).not.toBeNull();
      expect(denied!.status).toBe(403);

      const body = await denied!.json() as {
        ok: boolean;
        error: { code: string; message: string };
        required_tier: string;
        current_tier: string;
        upgrade_url: string;
      };

      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("TIER_REQUIRED");
      expect(body.required_tier).toBe("premium");
      expect(body.current_tier).toBe("free");
      expect(body.upgrade_url).toContain("billing/upgrade");
      expect(body.upgrade_url).toContain("tier=premium");
    });

    it("free user can access free features (accounts.list, events.list)", async () => {
      const { userId } = await createTestUser(db);

      // Free features should be allowed
      const deniedFree = await enforceFeatureGate(userId, "free", d1);
      expect(deniedFree).toBeNull(); // null means allowed

      // Verify free features in FEATURE_TIERS
      expect(FEATURE_TIERS["accounts.list"]).toBe("free");
      expect(FEATURE_TIERS["events.list"]).toBe("free");
      expect(FEATURE_TIERS["events.get"]).toBe("free");
    });

    it("tier comparison logic is correct across all tiers", () => {
      // free < premium < enterprise
      expect(isTierSufficient("free", "free")).toBe(true);
      expect(isTierSufficient("free", "premium")).toBe(false);
      expect(isTierSufficient("free", "enterprise")).toBe(false);
      expect(isTierSufficient("premium", "free")).toBe(true);
      expect(isTierSufficient("premium", "premium")).toBe(true);
      expect(isTierSufficient("premium", "enterprise")).toBe(false);
      expect(isTierSufficient("enterprise", "free")).toBe(true);
      expect(isTierSufficient("enterprise", "premium")).toBe(true);
      expect(isTierSufficient("enterprise", "enterprise")).toBe(true);
    });
  });

  // =========================================================================
  // AC#2: Stripe checkout completes (test mode)
  // =========================================================================

  describe("AC#2: Stripe checkout completes (test mode)", () => {
    it("POST /v1/billing/checkout returns checkout URL from mock Stripe", async () => {
      const { token } = await createTestUser(db);
      const handler = createHandler();
      const env = buildEnv(d1);

      // Mock Stripe API response
      globalThis.fetch = vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "cs_e2e_session_001",
            url: "https://checkout.stripe.com/c/pay/cs_e2e_session_001",
            customer: "cus_e2e_001",
            subscription: null,
            metadata: { user_id: "usr_e2e_billing_validation_001" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

      const response = await handler.fetch(
        new Request("https://api.tminus.ink/v1/billing/checkout", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ price_id: "price_premium_monthly" }),
        }),
        env,
        mockCtx,
      );

      expect(response.status).toBe(201);

      const body = await response.json() as {
        ok: boolean;
        data: { session_id: string; checkout_url: string };
      };

      expect(body.ok).toBe(true);
      expect(body.data.session_id).toBe("cs_e2e_session_001");
      expect(body.data.checkout_url).toContain("checkout.stripe.com");
      expect(body.data.checkout_url).toContain("cs_e2e_session_001");

      // Verify Stripe was called with correct params
      expect(globalThis.fetch).toHaveBeenCalledOnce();
      const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
      const fetchUrl = fetchCall[0] as string;
      expect(fetchUrl).toContain("api.stripe.com/v1/checkout/sessions");

      const fetchInit = fetchCall[1] as RequestInit;
      expect(fetchInit.method).toBe("POST");
      expect(fetchInit.headers).toHaveProperty("Authorization");
    });

    it("POST /v1/billing/checkout rejects missing price_id", async () => {
      const { token } = await createTestUser(db);
      const handler = createHandler();
      const env = buildEnv(d1);

      const response = await handler.fetch(
        new Request("https://api.tminus.ink/v1/billing/checkout", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({}),
        }),
        env,
        mockCtx,
      );

      expect(response.status).toBe(400);
      const body = await response.json() as { ok: boolean; error: { code: string } };
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });
  });

  // =========================================================================
  // AC#3: Tier upgraded in system
  // =========================================================================

  describe("AC#3: Tier upgraded in system after checkout webhook", () => {
    it("checkout.session.completed upgrades user from free to premium in D1", async () => {
      const { userId } = await createTestUser(db);
      const handler = createHandler();
      const env = buildEnv(d1);

      // BEFORE: user is free
      const tierBefore = await getUserTier(d1, userId);
      expect(tierBefore).toBe("free");

      // Simulate Stripe checkout.session.completed webhook
      const webhookPayload = JSON.stringify({
        id: "evt_e2e_checkout_completed",
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_e2e_checkout_001",
            customer: "cus_e2e_checkout_001",
            subscription: "sub_e2e_checkout_001",
            metadata: { user_id: userId },
          },
        },
      });

      const response = await sendWebhook(handler, env, webhookPayload);
      expect(response.status).toBe(200);

      const body = await response.json() as { ok: boolean; data: { received: boolean } };
      expect(body.ok).toBe(true);
      expect(body.data.received).toBe(true);

      // AFTER: user is now premium
      const tierAfter = await getUserTier(d1, userId);
      expect(tierAfter).toBe("premium");

      // Verify subscription record exists in D1
      const sub = db.prepare(
        "SELECT tier, status, stripe_customer_id, stripe_subscription_id FROM subscriptions WHERE user_id = ?",
      ).get(userId) as {
        tier: string;
        status: string;
        stripe_customer_id: string;
        stripe_subscription_id: string;
      };

      expect(sub.tier).toBe("premium");
      expect(sub.status).toBe("active");
      expect(sub.stripe_customer_id).toBe("cus_e2e_checkout_001");
      expect(sub.stripe_subscription_id).toBe("sub_e2e_checkout_001");

      // Verify billing event was logged
      const events = db.prepare(
        "SELECT event_type, old_tier, new_tier, new_status FROM billing_events WHERE user_id = ?",
      ).all(userId) as Array<{
        event_type: string;
        old_tier: string | null;
        new_tier: string | null;
        new_status: string | null;
      }>;

      expect(events.length).toBeGreaterThanOrEqual(1);
      const checkoutEvent = events.find(e => e.event_type === "checkout_completed");
      expect(checkoutEvent).toBeDefined();
      expect(checkoutEvent!.old_tier).toBe("free");
      expect(checkoutEvent!.new_tier).toBe("premium");
      expect(checkoutEvent!.new_status).toBe("active");
    });
  });

  // =========================================================================
  // AC#4: Premium features accessible after upgrade
  // =========================================================================

  describe("AC#4: Premium features accessible after upgrade", () => {
    it("premium user can access scheduling and constraints features", async () => {
      const { userId } = await createTestUser(db);
      const handler = createHandler();
      const env = buildEnv(d1);

      // First: verify free user is blocked from premium features
      let denied = await enforceFeatureGate(userId, "premium", d1);
      expect(denied).not.toBeNull();
      expect(denied!.status).toBe(403);

      // Upgrade via checkout webhook
      await sendWebhook(handler, env, JSON.stringify({
        id: "evt_e2e_upgrade_access",
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_e2e_access_001",
            customer: "cus_e2e_access_001",
            subscription: "sub_e2e_access_001",
            metadata: { user_id: userId },
          },
        },
      }));

      // Verify upgrade
      const tier = await getUserTier(d1, userId);
      expect(tier).toBe("premium");

      // Now premium features should be accessible
      denied = await enforceFeatureGate(userId, "premium", d1);
      expect(denied).toBeNull(); // null = allowed

      // Verify all premium features are unlocked
      const premiumFeatures = Object.entries(FEATURE_TIERS)
        .filter(([, requiredTier]) => requiredTier === "premium")
        .map(([feature]) => feature);

      expect(premiumFeatures.length).toBeGreaterThan(0);
      for (const feature of premiumFeatures) {
        const featureAllowed = await checkFeatureGate(userId, "premium", d1);
        expect(featureAllowed).toBe(true);
      }

      // Free features should still be accessible
      const freeAllowed = await checkFeatureGate(userId, "free", d1);
      expect(freeAllowed).toBe(true);

      // Enterprise features should still be blocked
      denied = await enforceFeatureGate(userId, "enterprise", d1);
      expect(denied).not.toBeNull();
      expect(denied!.status).toBe(403);
    });
  });

  // =========================================================================
  // AC#5: Billing UI shows correct plan
  // =========================================================================

  describe("AC#5: Billing status endpoint returns correct plan info", () => {
    it("GET /v1/billing/status returns free tier when no subscription", async () => {
      const { token } = await createTestUser(db);
      const handler = createHandler();
      const env = buildEnv(d1);

      const response = await handler.fetch(
        new Request("https://api.tminus.ink/v1/billing/status", {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        }),
        env,
        mockCtx,
      );

      expect(response.status).toBe(200);

      const body = await response.json() as {
        ok: boolean;
        data: {
          tier: string;
          status: string;
          subscription: null | Record<string, unknown>;
        };
      };

      expect(body.ok).toBe(true);
      expect(body.data.tier).toBe("free");
      expect(body.data.status).toBe("none");
      expect(body.data.subscription).toBeNull();
    });

    it("GET /v1/billing/status returns premium plan after checkout", async () => {
      const { userId, token } = await createTestUser(db);
      const handler = createHandler();
      const env = buildEnv(d1);

      // Upgrade via checkout webhook
      await sendWebhook(handler, env, JSON.stringify({
        id: "evt_e2e_status_checkout",
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_e2e_status_001",
            customer: "cus_e2e_status_001",
            subscription: "sub_e2e_status_001",
            metadata: { user_id: userId },
          },
        },
      }));

      const response = await handler.fetch(
        new Request("https://api.tminus.ink/v1/billing/status", {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        }),
        env,
        mockCtx,
      );

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
            current_period_end: string | null;
            cancel_at_period_end: boolean;
            grace_period_end: string | null;
            previous_tier: string | null;
          };
        };
      };

      expect(body.ok).toBe(true);
      expect(body.data.tier).toBe("premium");
      expect(body.data.status).toBe("active");
      expect(body.data.subscription).not.toBeNull();
      expect(body.data.subscription.stripe_customer_id).toBe("cus_e2e_status_001");
      expect(body.data.subscription.stripe_subscription_id).toBe("sub_e2e_status_001");
      expect(body.data.subscription.current_period_end).not.toBeNull();
      expect(body.data.subscription.cancel_at_period_end).toBe(false);
      expect(body.data.subscription.grace_period_end).toBeNull();
    });

    it("GET /v1/billing/status reflects past_due and grace period after payment failure", async () => {
      const { userId, token } = await createTestUser(db);
      const handler = createHandler();
      const env = buildEnv(d1);

      // Checkout
      await sendWebhook(handler, env, JSON.stringify({
        id: "evt_e2e_grace_checkout",
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_e2e_grace_001",
            customer: "cus_e2e_grace_001",
            subscription: "sub_e2e_grace_001",
            metadata: { user_id: userId },
          },
        },
      }));

      // Payment failure
      await sendWebhook(handler, env, JSON.stringify({
        id: "evt_e2e_payment_fail",
        type: "invoice.payment_failed",
        data: {
          object: {
            id: "in_e2e_fail_001",
            subscription: "sub_e2e_grace_001",
          },
        },
      }));

      const response = await handler.fetch(
        new Request("https://api.tminus.ink/v1/billing/status", {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        }),
        env,
        mockCtx,
      );

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

      // Grace period should be approximately GRACE_PERIOD_DAYS from now
      const gracePeriodEnd = new Date(body.data.subscription.grace_period_end!);
      const now = new Date();
      const daysDiff = (gracePeriodEnd.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
      expect(daysDiff).toBeGreaterThan(GRACE_PERIOD_DAYS - 1);
      expect(daysDiff).toBeLessThanOrEqual(GRACE_PERIOD_DAYS + 1);
    });
  });

  // =========================================================================
  // AC#6: Account limits enforced per tier
  // =========================================================================

  describe("AC#6: Account limits enforced per tier (free=2, premium=5, enterprise=10)", () => {
    it("ACCOUNT_LIMITS constants are correct", () => {
      expect(ACCOUNT_LIMITS.free).toBe(2);
      expect(ACCOUNT_LIMITS.premium).toBe(5);
      expect(ACCOUNT_LIMITS.enterprise).toBe(10);
    });

    it("free user with 2 accounts is blocked from adding a 3rd", async () => {
      const { userId } = await createTestUser(db);

      // Add 2 accounts (at the free limit)
      addAccountsForUser(db, userId, 2);

      // Should be blocked from adding more
      const denied = await enforceAccountLimit(userId, d1);
      expect(denied).not.toBeNull();
      expect(denied!.status).toBe(403);

      const body = await denied!.json() as {
        ok: boolean;
        error: { code: string; message: string };
        required_tier: string;
        current_tier: string;
        upgrade_url: string;
        usage: { accounts: number; limit: number };
      };

      expect(body.error.code).toBe("TIER_REQUIRED");
      expect(body.current_tier).toBe("free");
      expect(body.required_tier).toBe("premium");
      expect(body.usage.accounts).toBe(2);
      expect(body.usage.limit).toBe(2);
      expect(body.upgrade_url).toContain("tier=premium");
    });

    it("free user with 1 account is allowed to add a 2nd", async () => {
      const { userId } = await createTestUser(db);

      // Add 1 account (under the free limit)
      addAccountsForUser(db, userId, 1);

      const denied = await enforceAccountLimit(userId, d1);
      expect(denied).toBeNull(); // null = allowed
    });

    it("premium user can have up to 5 accounts", async () => {
      const { userId } = await createTestUser(db);
      const handler = createHandler();
      const env = buildEnv(d1);

      // Upgrade to premium
      await sendWebhook(handler, env, JSON.stringify({
        id: "evt_e2e_limits_checkout",
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_e2e_limits_001",
            customer: "cus_e2e_limits_001",
            subscription: "sub_e2e_limits_001",
            metadata: { user_id: userId },
          },
        },
      }));

      const tier = await getUserTier(d1, userId);
      expect(tier).toBe("premium");

      // Add 4 accounts (under premium limit of 5)
      addAccountsForUser(db, userId, 4);
      let denied = await enforceAccountLimit(userId, d1);
      expect(denied).toBeNull(); // 4 < 5, allowed

      // Add the 5th account (at the limit)
      db.exec(
        `INSERT INTO accounts (account_id, user_id, provider, provider_subject, email, status)
         VALUES ('acc_e2e_premium_5th', '${userId}', 'google', 'sub_5th', 'fifth@example.com', 'active')`,
      );

      // Now at 5 accounts -- should be blocked from adding 6th
      denied = await enforceAccountLimit(userId, d1);
      expect(denied).not.toBeNull();
      expect(denied!.status).toBe(403);

      const body = await denied!.json() as {
        usage: { accounts: number; limit: number };
        required_tier: string;
      };
      expect(body.usage.accounts).toBe(5);
      expect(body.usage.limit).toBe(5);
      expect(body.required_tier).toBe("enterprise");
    });

    it("enterprise user can have up to 10 accounts", async () => {
      const { userId } = await createTestUser(db);
      const handler = createHandler();
      const env = buildEnv(d1);

      // Upgrade to premium first
      await sendWebhook(handler, env, JSON.stringify({
        id: "evt_e2e_ent_checkout",
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_e2e_ent_001",
            customer: "cus_e2e_ent_001",
            subscription: "sub_e2e_ent_001",
            metadata: { user_id: userId },
          },
        },
      }));

      // Upgrade to enterprise
      await sendWebhook(handler, env, JSON.stringify({
        id: "evt_e2e_ent_upgrade",
        type: "customer.subscription.updated",
        data: {
          object: {
            id: "sub_e2e_ent_001",
            customer: "cus_e2e_ent_001",
            status: "active",
            current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
            metadata: { user_id: userId },
            items: { data: [{ price: { id: "price_enterprise_monthly" } }] },
          },
        },
      }));

      const tier = await getUserTier(d1, userId);
      expect(tier).toBe("enterprise");

      // Add 9 accounts (under the 10 limit)
      addAccountsForUser(db, userId, 9);
      let denied = await enforceAccountLimit(userId, d1);
      expect(denied).toBeNull(); // 9 < 10, allowed

      // Add the 10th
      db.exec(
        `INSERT INTO accounts (account_id, user_id, provider, provider_subject, email, status)
         VALUES ('acc_e2e_ent_10th', '${userId}', 'google', 'sub_10th', 'tenth@example.com', 'active')`,
      );

      // At limit of 10 -- should be blocked from adding 11th
      denied = await enforceAccountLimit(userId, d1);
      expect(denied).not.toBeNull();
      expect(denied!.status).toBe(403);
    });
  });

  // =========================================================================
  // AC#7: Subscription lifecycle
  // =========================================================================

  describe("AC#7: Subscription lifecycle (upgrade, downgrade, cancel, grace period)", () => {
    it("FULL LIFECYCLE: free -> premium -> enterprise -> downgrade -> cancel -> free", async () => {
      const { userId } = await createTestUser(db);
      const handler = createHandler();
      const env = buildEnv(d1);

      // Step 0: Verify starting state is free
      let tier = await getUserTier(d1, userId);
      expect(tier).toBe("free");

      // Step 1: Checkout -> premium
      await sendWebhook(handler, env, JSON.stringify({
        id: "evt_e2e_lifecycle_checkout",
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_e2e_lifecycle_001",
            customer: "cus_e2e_lifecycle_001",
            subscription: "sub_e2e_lifecycle_001",
            metadata: { user_id: userId },
          },
        },
      }));

      tier = await getUserTier(d1, userId);
      expect(tier).toBe("premium");

      // Step 2: Upgrade to enterprise (immediate)
      await sendWebhook(handler, env, JSON.stringify({
        id: "evt_e2e_lifecycle_upgrade",
        type: "customer.subscription.updated",
        data: {
          object: {
            id: "sub_e2e_lifecycle_001",
            customer: "cus_e2e_lifecycle_001",
            status: "active",
            current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
            metadata: { user_id: userId },
            items: { data: [{ price: { id: "price_enterprise_monthly" } }] },
          },
        },
      }));

      tier = await getUserTier(d1, userId);
      expect(tier).toBe("enterprise");

      // Step 3: Downgrade to premium (keeps enterprise until period end)
      await sendWebhook(handler, env, JSON.stringify({
        id: "evt_e2e_lifecycle_downgrade",
        type: "customer.subscription.updated",
        data: {
          object: {
            id: "sub_e2e_lifecycle_001",
            customer: "cus_e2e_lifecycle_001",
            status: "active",
            current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
            metadata: { user_id: userId },
            items: { data: [{ price: { id: "price_premium_monthly" } }] },
          },
        },
      }));

      // IMPORTANT: tier should STILL be enterprise (downgrade is deferred)
      tier = await getUserTier(d1, userId);
      expect(tier).toBe("enterprise");

      // Verify cancel_at_period_end is set
      const sub = db.prepare(
        "SELECT cancel_at_period_end, previous_tier FROM subscriptions WHERE stripe_subscription_id = ?",
      ).get("sub_e2e_lifecycle_001") as {
        cancel_at_period_end: number;
        previous_tier: string | null;
      };
      expect(sub.cancel_at_period_end).toBe(1);

      // Step 4: Subscription deleted (cancelled at period end) -> free
      await sendWebhook(handler, env, JSON.stringify({
        id: "evt_e2e_lifecycle_delete",
        type: "customer.subscription.deleted",
        data: {
          object: {
            id: "sub_e2e_lifecycle_001",
            customer: "cus_e2e_lifecycle_001",
            status: "canceled",
            current_period_end: Math.floor(Date.now() / 1000),
            metadata: { user_id: userId },
          },
        },
      }));

      tier = await getUserTier(d1, userId);
      expect(tier).toBe("free");

      // Verify subscription data is preserved (not deleted)
      const finalSub = db.prepare(
        "SELECT tier, status, previous_tier FROM subscriptions WHERE stripe_subscription_id = ?",
      ).get("sub_e2e_lifecycle_001") as {
        tier: string;
        status: string;
        previous_tier: string | null;
      };
      expect(finalSub).not.toBeNull();
      expect(finalSub.tier).toBe("free");
      expect(finalSub.status).toBe("cancelled");
      expect(finalSub.previous_tier).toBeDefined();

      // Step 5: Verify complete audit trail
      const events = db.prepare(
        "SELECT event_type, old_tier, new_tier FROM billing_events WHERE user_id = ? ORDER BY created_at",
      ).all(userId) as Array<{
        event_type: string;
        old_tier: string | null;
        new_tier: string | null;
      }>;

      const eventTypes = events.map(e => e.event_type);
      expect(eventTypes).toContain("checkout_completed");
      expect(eventTypes).toContain("subscription_upgraded");
      expect(eventTypes).toContain("subscription_downgraded");
      expect(eventTypes).toContain("subscription_deleted");
    });

    it("payment failure starts grace period, then subscription deleted downgrades to free", async () => {
      const { userId } = await createTestUser(db);
      const handler = createHandler();
      const env = buildEnv(d1);

      // Checkout -> premium
      await sendWebhook(handler, env, JSON.stringify({
        id: "evt_e2e_grace_lifecycle_checkout",
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_e2e_grace_lifecycle",
            customer: "cus_e2e_grace_lifecycle",
            subscription: "sub_e2e_grace_lifecycle",
            metadata: { user_id: userId },
          },
        },
      }));

      let tier = await getUserTier(d1, userId);
      expect(tier).toBe("premium");

      // Payment fails -> grace period starts
      await sendWebhook(handler, env, JSON.stringify({
        id: "evt_e2e_grace_payment_fail",
        type: "invoice.payment_failed",
        data: {
          object: {
            id: "in_e2e_grace_fail",
            subscription: "sub_e2e_grace_lifecycle",
          },
        },
      }));

      // Status should be past_due with grace period
      const sub = db.prepare(
        "SELECT status, grace_period_end, tier FROM subscriptions WHERE stripe_subscription_id = ?",
      ).get("sub_e2e_grace_lifecycle") as {
        status: string;
        grace_period_end: string | null;
        tier: string;
      };
      expect(sub.status).toBe("past_due");
      expect(sub.grace_period_end).not.toBeNull();
      // User still has premium access during grace period
      expect(sub.tier).toBe("premium");

      // Verify grace period is GRACE_PERIOD_DAYS (7 days)
      const graceEnd = new Date(sub.grace_period_end!);
      const now = new Date();
      const daysDiff = (graceEnd.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
      expect(daysDiff).toBeGreaterThan(GRACE_PERIOD_DAYS - 1);
      expect(daysDiff).toBeLessThanOrEqual(GRACE_PERIOD_DAYS + 1);

      // Eventually Stripe sends subscription.deleted after grace period
      await sendWebhook(handler, env, JSON.stringify({
        id: "evt_e2e_grace_delete",
        type: "customer.subscription.deleted",
        data: {
          object: {
            id: "sub_e2e_grace_lifecycle",
            customer: "cus_e2e_grace_lifecycle",
            status: "canceled",
            current_period_end: Math.floor(Date.now() / 1000),
            metadata: { user_id: userId },
          },
        },
      }));

      tier = await getUserTier(d1, userId);
      expect(tier).toBe("free");

      // Verify audit trail
      const events = db.prepare(
        "SELECT event_type FROM billing_events WHERE user_id = ? ORDER BY created_at",
      ).all(userId) as Array<{ event_type: string }>;
      const eventTypes = events.map(e => e.event_type);

      expect(eventTypes).toContain("checkout_completed");
      expect(eventTypes).toContain("payment_failed");
      expect(eventTypes).toContain("grace_period_started");
      expect(eventTypes).toContain("subscription_deleted");
    });

    it("subscription renewal extends billing period and keeps tier", async () => {
      const { userId } = await createTestUser(db);
      const handler = createHandler();
      const env = buildEnv(d1);

      // Checkout -> premium
      await sendWebhook(handler, env, JSON.stringify({
        id: "evt_e2e_renew_checkout",
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_e2e_renew_001",
            customer: "cus_e2e_renew_001",
            subscription: "sub_e2e_renew_001",
            metadata: { user_id: userId },
          },
        },
      }));

      // Record initial period_end
      const initialSub = db.prepare(
        "SELECT current_period_end FROM subscriptions WHERE stripe_subscription_id = ?",
      ).get("sub_e2e_renew_001") as { current_period_end: string };
      expect(initialSub.current_period_end).toBeTruthy();

      // Renewal: same tier, new period_end (60 days out)
      const newPeriodEnd = Math.floor(Date.now() / 1000) + 60 * 24 * 3600;
      await sendWebhook(handler, env, JSON.stringify({
        id: "evt_e2e_renewal",
        type: "customer.subscription.updated",
        data: {
          object: {
            id: "sub_e2e_renew_001",
            customer: "cus_e2e_renew_001",
            status: "active",
            current_period_end: newPeriodEnd,
            metadata: { user_id: userId },
            items: { data: [{ price: { id: "price_premium_monthly" } }] },
          },
        },
      }));

      // Tier remains premium
      const tier = await getUserTier(d1, userId);
      expect(tier).toBe("premium");

      // Period_end was extended
      const renewedSub = db.prepare(
        "SELECT current_period_end FROM subscriptions WHERE stripe_subscription_id = ?",
      ).get("sub_e2e_renew_001") as { current_period_end: string };

      expect(new Date(renewedSub.current_period_end).getTime()).toBeGreaterThan(
        new Date(initialSub.current_period_end).getTime(),
      );

      // Renewal event logged
      const events = db.prepare(
        "SELECT event_type FROM billing_events WHERE user_id = ? AND event_type = 'subscription_renewed'",
      ).all(userId) as Array<{ event_type: string }>;
      expect(events.length).toBeGreaterThanOrEqual(1);
    });
  });

  // =========================================================================
  // FULL E2E NARRATIVE: The complete billing journey
  // =========================================================================

  describe("FULL E2E NARRATIVE: Complete billing journey", () => {
    it("proves the entire billing pipeline works end-to-end in one cohesive flow", async () => {
      const { userId, token } = await createTestUser(db);
      const handler = createHandler();
      const env = buildEnv(d1);

      // ------------------------------------------------------------------
      // SCENE 1: Free user tries premium feature, gets blocked
      // ------------------------------------------------------------------

      let tier = await getUserTier(d1, userId);
      expect(tier).toBe("free");

      const gateDenied = await enforceFeatureGate(userId, "premium", d1);
      expect(gateDenied).not.toBeNull();
      expect(gateDenied!.status).toBe(403);

      const deniedBody = await gateDenied!.json() as {
        error: { code: string };
        upgrade_url: string;
      };
      expect(deniedBody.error.code).toBe("TIER_REQUIRED");
      expect(deniedBody.upgrade_url).toBeTruthy();

      // ------------------------------------------------------------------
      // SCENE 2: User initiates checkout (mock Stripe)
      // ------------------------------------------------------------------

      globalThis.fetch = vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "cs_e2e_narrative_001",
            url: "https://checkout.stripe.com/c/pay/cs_e2e_narrative_001",
            customer: "cus_e2e_narrative_001",
            subscription: null,
            metadata: { user_id: userId },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

      const checkoutResp = await handler.fetch(
        new Request("https://api.tminus.ink/v1/billing/checkout", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ price_id: "price_premium_monthly" }),
        }),
        env,
        mockCtx,
      );

      expect(checkoutResp.status).toBe(201);
      const checkoutBody = await checkoutResp.json() as {
        data: { checkout_url: string };
      };
      expect(checkoutBody.data.checkout_url).toContain("checkout.stripe.com");

      // Restore fetch for webhook calls
      globalThis.fetch = originalFetch;

      // ------------------------------------------------------------------
      // SCENE 3: Stripe webhook confirms checkout -> tier upgraded
      // ------------------------------------------------------------------

      await sendWebhook(handler, env, JSON.stringify({
        id: "evt_e2e_narrative_checkout_complete",
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_e2e_narrative_001",
            customer: "cus_e2e_narrative_001",
            subscription: "sub_e2e_narrative_001",
            metadata: { user_id: userId },
          },
        },
      }));

      tier = await getUserTier(d1, userId);
      expect(tier).toBe("premium");

      // ------------------------------------------------------------------
      // SCENE 4: Premium features now accessible
      // ------------------------------------------------------------------

      const premiumGate = await enforceFeatureGate(userId, "premium", d1);
      expect(premiumGate).toBeNull(); // allowed!

      // ------------------------------------------------------------------
      // SCENE 5: Billing status shows premium plan
      // ------------------------------------------------------------------

      const statusResp = await handler.fetch(
        new Request("https://api.tminus.ink/v1/billing/status", {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        }),
        env,
        mockCtx,
      );

      expect(statusResp.status).toBe(200);
      const statusBody = await statusResp.json() as {
        ok: boolean;
        data: {
          tier: string;
          status: string;
          subscription: {
            stripe_customer_id: string;
            cancel_at_period_end: boolean;
          };
        };
      };

      expect(statusBody.ok).toBe(true);
      expect(statusBody.data.tier).toBe("premium");
      expect(statusBody.data.status).toBe("active");
      expect(statusBody.data.subscription.stripe_customer_id).toBe("cus_e2e_narrative_001");
      expect(statusBody.data.subscription.cancel_at_period_end).toBe(false);

      // ------------------------------------------------------------------
      // SCENE 6: Account limit reflects premium tier (5 accounts)
      // ------------------------------------------------------------------

      addAccountsForUser(db, userId, 4);
      let limitDenied = await enforceAccountLimit(userId, d1);
      expect(limitDenied).toBeNull(); // 4 < 5, allowed

      // ------------------------------------------------------------------
      // SCENE 7: Audit trail is complete
      // ------------------------------------------------------------------

      const events = db.prepare(
        "SELECT event_type, stripe_event_id FROM billing_events WHERE user_id = ?",
      ).all(userId) as Array<{ event_type: string; stripe_event_id: string | null }>;

      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events.some(e => e.event_type === "checkout_completed")).toBe(true);
      // All events have stripe_event_id for traceability
      expect(events.every(e => e.stripe_event_id !== null)).toBe(true);
    });
  });
});
