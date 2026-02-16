/**
 * Integration tests for enterprise billing tier integration.
 *
 * Story: TM-nt8 -- Enterprise Billing Tier Integration
 *
 * Tests the full enterprise billing flow against real D1 (via better-sqlite3):
 * 1. AC#1: Enterprise tier required for org creation (403 TIER_REQUIRED)
 * 2. AC#2: Per-seat pricing via Stripe (seat count update -> Stripe quantity)
 * 3. AC#3: Seat limit enforced on member addition (403 SEAT_LIMIT)
 * 4. AC#4: Seat count update triggers Stripe subscription update
 * 5. AC#5: Clear upgrade prompts for insufficient tier/seats
 * 6. AC#6: Stripe webhooks handle seat-related events
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
  MIGRATION_0015_ORGANIZATIONS,
  MIGRATION_0016_ORG_MEMBERS,
  MIGRATION_0017_ORG_POLICIES,
  MIGRATION_0018_ORG_SEAT_BILLING,
} from "@tminus/d1-registry";
import { createHandler, createJwt } from "../index";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const JWT_SECRET = "integration-test-jwt-secret-32chars-minimum";
const STRIPE_SECRET_KEY = "sk_test_integration_test_key_not_real";
const STRIPE_WEBHOOK_SECRET = "whsec_test_integration_webhook_secret";

/**
 * Valid ULID-format org IDs for testing.
 * Format: org_ + 26-char Crockford Base32 string.
 */
// All IDs: prefix (4 chars) + 26-char Crockford Base32 ULID (no I, L, O, U)
const ORG_SEAT_TEST        = "org_01HW0000SEAT0TEST0000001A0";
const ORG_SEAT_OK          = "org_01HW0000SEATK0000000002A00";
const ORG_BILLING          = "org_01HW0000B1NG0000000003AB00";
const ORG_BILLING_VAL      = "org_01HW0000B1VA0000000004AB00";
const ORG_BILLING_NONADMIN = "org_01HW0000NADM0000000005AB00";
const ORG_PROMPT           = "org_01HW0000PRMT0000000006AB00";
const ORG_WEBHOOK          = "org_01HW0000WBHK0000000007AB00";
const ORG_WEBHOOK_LOG      = "org_01HW0000WBKG0000000008AB00";
const USR_MEMBER1          = "usr_01HW0000MEMBER010000000010";
const USR_MEMBER2          = "usr_01HW0000MEMBER020000000020";
const USR_MEMBERK          = "usr_01HW0000MEMBERK00000000030";
const USR_PROMPTM          = "usr_01HW0000PRMTMB000000000040";

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
    batch(stmts: D1PreparedStatement[]): Promise<D1Result<unknown>[]> {
      const results: D1Result<unknown>[] = [];
      for (const stmt of stmts) {
        const result = (stmt as unknown as { run(): Promise<D1Result<unknown>> }).run();
        results.push(result as unknown as D1Result<unknown>);
      }
      return Promise.resolve(results);
    },
    dump(): Promise<ArrayBuffer> {
      return Promise.resolve(new ArrayBuffer(0));
    },
  } as unknown as D1Database;
}

// ---------------------------------------------------------------------------
// Mock helpers
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

async function createTestUser(
  db: DatabaseType,
  tier: "free" | "premium" | "enterprise" = "free",
): Promise<{ userId: string; token: string }> {
  const userId = "usr_01HWTEST000000000000000000";

  db.exec(`INSERT OR IGNORE INTO orgs (org_id, name) VALUES ('org_test_01', 'Test Org')`);
  db.exec(
    `INSERT OR IGNORE INTO users (user_id, org_id, email, password_hash, password_version)
     VALUES ('${userId}', 'org_test_01', 'test@example.com', 'hash', 1)`,
  );

  if (tier !== "free") {
    db.exec(
      `INSERT OR IGNORE INTO subscriptions
       (subscription_id, user_id, tier, stripe_customer_id, stripe_subscription_id,
        current_period_end, status)
       VALUES ('sub_test_ent_01', '${userId}', '${tier}', 'cus_test_ent_456',
               'sub_stripe_ent_789',
               datetime('now', '+30 days'), 'active')`,
    );
  }

  const token = await createJwt(
    {
      sub: userId,
      email: "test@example.com",
      tier,
      pwd_ver: 1,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    JWT_SECRET,
  );

  return { userId, token };
}

// ---------------------------------------------------------------------------
// Helper: create enterprise org directly in DB
// ---------------------------------------------------------------------------

function createEnterpriseOrg(
  db: DatabaseType,
  orgId: string,
  adminUserId: string,
  seatLimit = 5,
  stripeSubId: string | null = null,
): void {
  db.exec(
    `INSERT INTO organizations (org_id, name, seat_limit, stripe_subscription_id)
     VALUES ('${orgId}', 'Enterprise Org', ${seatLimit}, ${stripeSubId ? `'${stripeSubId}'` : "NULL"})`,
  );
  db.exec(
    `INSERT INTO org_members (org_id, user_id, role)
     VALUES ('${orgId}', '${adminUserId}', 'admin')`,
  );
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

describe("Integration: Enterprise billing tier", () => {
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
    db.exec(MIGRATION_0015_ORGANIZATIONS);
    db.exec(MIGRATION_0016_ORG_MEMBERS);
    db.exec(MIGRATION_0017_ORG_POLICIES);
    db.exec(MIGRATION_0018_ORG_SEAT_BILLING);
    d1 = createRealD1(db);

    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    db.close();
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // AC#1: Enterprise tier required for org creation
  // -----------------------------------------------------------------------

  it("AC#1: POST /v1/orgs returns 403 TIER_REQUIRED for free user", async () => {
    const { token } = await createTestUser(db, "free");
    const handler = createHandler();
    const env = buildEnv(d1);

    const request = new Request("https://api.tminus.ink/v1/orgs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name: "My Enterprise Org" }),
    });

    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(403);

    const body = await response.json() as {
      ok: boolean;
      error: string;
      error_code: string;
      required_tier: string;
      upgrade_url: string;
    };

    expect(body.ok).toBe(false);
    expect(body.error_code).toBe("TIER_REQUIRED");
    expect(body.required_tier).toBe("enterprise");
    expect(body.upgrade_url).toContain("enterprise");
  });

  it("AC#1: POST /v1/orgs returns 403 TIER_REQUIRED for premium user", async () => {
    const { token } = await createTestUser(db, "premium");
    const handler = createHandler();
    const env = buildEnv(d1);

    const request = new Request("https://api.tminus.ink/v1/orgs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name: "My Enterprise Org" }),
    });

    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(403);

    const body = await response.json() as {
      ok: boolean;
      error_code: string;
      required_tier: string;
    };

    expect(body.error_code).toBe("TIER_REQUIRED");
    expect(body.required_tier).toBe("enterprise");
  });

  it("AC#1: POST /v1/orgs succeeds for enterprise user", async () => {
    const { token } = await createTestUser(db, "enterprise");
    const handler = createHandler();
    const env = buildEnv(d1);

    const request = new Request("https://api.tminus.ink/v1/orgs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name: "My Enterprise Org" }),
    });

    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(201);

    const body = await response.json() as {
      ok: boolean;
      data: { org_id: string; name: string; seat_limit: number };
    };

    expect(body.ok).toBe(true);
    expect(body.data.org_id).toMatch(/^org_/);
    expect(body.data.name).toBe("My Enterprise Org");
    expect(body.data.seat_limit).toBe(5); // DEFAULT_INCLUDED_SEATS
  });

  // -----------------------------------------------------------------------
  // AC#3: Seat limit enforced on member addition
  // -----------------------------------------------------------------------

  it("AC#3: POST /v1/orgs/:id/members returns 403 SEAT_LIMIT when at capacity", async () => {
    const { userId, token } = await createTestUser(db, "enterprise");
    const handler = createHandler();
    const env = buildEnv(d1);

    // Create org with seat_limit = 2 (admin + 1 member max)
    createEnterpriseOrg(db, ORG_SEAT_TEST, userId, 2);

    // Add a second user to reach seat limit
    db.exec(
      `INSERT OR IGNORE INTO users (user_id, org_id, email, password_hash, password_version)
       VALUES ('${USR_MEMBER1}', 'org_test_01', 'member1@example.com', 'hash', 1)`,
    );
    db.exec(
      `INSERT INTO org_members (org_id, user_id, role)
       VALUES ('${ORG_SEAT_TEST}', '${USR_MEMBER1}', 'member')`,
    );

    // Now try to add a third member (should be blocked)
    db.exec(
      `INSERT OR IGNORE INTO users (user_id, org_id, email, password_hash, password_version)
       VALUES ('${USR_MEMBER2}', 'org_test_01', 'member2@example.com', 'hash', 1)`,
    );

    const request = new Request(`https://api.tminus.ink/v1/orgs/${ORG_SEAT_TEST}/members`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ user_id: USR_MEMBER2, role: "member" }),
    });

    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(403);

    const body = await response.json() as {
      ok: boolean;
      error: string;
      error_code: string;
      current_seats: number;
      seat_limit: number;
      upgrade_url: string;
    };

    expect(body.ok).toBe(false);
    expect(body.error_code).toBe("SEAT_LIMIT");
    expect(body.current_seats).toBe(2);
    expect(body.seat_limit).toBe(2);
    expect(body.upgrade_url).toBeTruthy();
  });

  it("AC#3: POST /v1/orgs/:id/members succeeds when under seat limit", async () => {
    const { userId, token } = await createTestUser(db, "enterprise");
    const handler = createHandler();
    const env = buildEnv(d1);

    // Create org with seat_limit = 5 (admin + 4 members max)
    createEnterpriseOrg(db, ORG_SEAT_OK, userId, 5);

    db.exec(
      `INSERT OR IGNORE INTO users (user_id, org_id, email, password_hash, password_version)
       VALUES ('${USR_MEMBERK}', 'org_test_01', 'member.ok@example.com', 'hash', 1)`,
    );

    const request = new Request(`https://api.tminus.ink/v1/orgs/${ORG_SEAT_OK}/members`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ user_id: USR_MEMBERK, role: "member" }),
    });

    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(201);

    const body = await response.json() as {
      ok: boolean;
      data: { org_id: string; user_id: string; role: string };
    };

    expect(body.ok).toBe(true);
    expect(body.data.user_id).toBe(USR_MEMBERK);
  });

  // -----------------------------------------------------------------------
  // AC#2 + AC#4: Per-seat pricing, seat update triggers Stripe update
  // -----------------------------------------------------------------------

  it("AC#2+4: POST /v1/orgs/:id/billing/seats updates Stripe subscription quantity", async () => {
    const { userId, token } = await createTestUser(db, "enterprise");
    const handler = createHandler();
    const env = buildEnv(d1);

    createEnterpriseOrg(db, ORG_BILLING, userId, 5, "sub_stripe_ent_789");

    const mockStripeSubscription = {
      id: "sub_stripe_ent_789",
      items: {
        data: [{ id: "si_seat_item_01", price: { id: "price_enterprise_seat" }, quantity: 5 }],
      },
    };

    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(mockStripeSubscription), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ...mockStripeSubscription,
            items: {
              data: [{ id: "si_seat_item_01", price: { id: "price_enterprise_seat" }, quantity: 10 }],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    const request = new Request(`https://api.tminus.ink/v1/orgs/${ORG_BILLING}/billing/seats`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ seat_count: 10 }),
    });

    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(200);

    const body = await response.json() as {
      ok: boolean;
      data: { org_id: string; seat_limit: number; stripe_updated: boolean };
    };

    expect(body.ok).toBe(true);
    expect(body.data.seat_limit).toBe(10);
    expect(body.data.stripe_updated).toBe(true);

    // Verify Stripe API was called to update quantity
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);

    // Verify D1 was updated
    const org = db.prepare("SELECT seat_limit FROM organizations WHERE org_id = ?").get(ORG_BILLING) as { seat_limit: number };
    expect(org.seat_limit).toBe(10);
  });

  it("AC#4: POST /v1/orgs/:id/billing/seats returns 400 for invalid seat_count", async () => {
    const { userId, token } = await createTestUser(db, "enterprise");
    const handler = createHandler();
    const env = buildEnv(d1);

    createEnterpriseOrg(db, ORG_BILLING_VAL, userId, 5, "sub_stripe_ent_789");

    const request = new Request(`https://api.tminus.ink/v1/orgs/${ORG_BILLING_VAL}/billing/seats`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ seat_count: -1 }),
    });

    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(400);
  });

  it("AC#4: POST /v1/orgs/:id/billing/seats requires admin role", async () => {
    const { userId, token } = await createTestUser(db, "enterprise");
    const handler = createHandler();
    const env = buildEnv(d1);

    db.exec(
      `INSERT INTO organizations (org_id, name, seat_limit)
       VALUES ('${ORG_BILLING_NONADMIN}', 'Other Org', 5)`,
    );
    db.exec(
      `INSERT INTO org_members (org_id, user_id, role)
       VALUES ('${ORG_BILLING_NONADMIN}', '${userId}', 'member')`,
    );

    const request = new Request(`https://api.tminus.ink/v1/orgs/${ORG_BILLING_NONADMIN}/billing/seats`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ seat_count: 10 }),
    });

    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(403);
  });

  // -----------------------------------------------------------------------
  // AC#5: Clear upgrade prompts
  // -----------------------------------------------------------------------

  it("AC#5: TIER_REQUIRED response includes upgrade URL for org creation", async () => {
    const { token } = await createTestUser(db, "free");
    const handler = createHandler();
    const env = buildEnv(d1);

    const request = new Request("https://api.tminus.ink/v1/orgs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name: "Denied Org" }),
    });

    const response = await handler.fetch(request, env, mockCtx);
    const body = await response.json() as {
      error: string;
      error_code: string;
      upgrade_url: string;
      required_tier: string;
    };

    expect(body.error_code).toBe("TIER_REQUIRED");
    expect(body.error).toContain("enterprise");
    expect(body.upgrade_url).toContain("enterprise");
    expect(body.required_tier).toBe("enterprise");
  });

  it("AC#5: SEAT_LIMIT response includes upgrade URL for seat addition", async () => {
    const { userId, token } = await createTestUser(db, "enterprise");
    const handler = createHandler();
    const env = buildEnv(d1);

    // Create org at capacity (seat_limit = 1, 1 admin member = at limit)
    createEnterpriseOrg(db, ORG_PROMPT, userId, 1);

    db.exec(
      `INSERT OR IGNORE INTO users (user_id, org_id, email, password_hash, password_version)
       VALUES ('${USR_PROMPTM}', 'org_test_01', 'prompt@example.com', 'hash', 1)`,
    );

    const request = new Request(`https://api.tminus.ink/v1/orgs/${ORG_PROMPT}/members`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ user_id: USR_PROMPTM, role: "member" }),
    });

    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(403);

    const body = await response.json() as {
      error: string;
      error_code: string;
      upgrade_url: string;
    };

    expect(body.error_code).toBe("SEAT_LIMIT");
    expect(body.error).toContain("Seat limit");
    expect(body.error).toContain("add more seats");
    expect(body.upgrade_url).toContain("seats");
  });

  // -----------------------------------------------------------------------
  // AC#6: Stripe webhooks handle seat-related events
  // -----------------------------------------------------------------------

  it("AC#6: customer.subscription.updated with quantity change updates org seat_limit", async () => {
    const { userId } = await createTestUser(db, "enterprise");
    const handler = createHandler();
    const env = buildEnv(d1);

    createEnterpriseOrg(db, ORG_WEBHOOK, userId, 5, "sub_webhook_ent_01");

    const webhookPayload = JSON.stringify({
      id: "evt_seat_webhook_01",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_webhook_ent_01",
          customer: "cus_test_ent_456",
          status: "active",
          current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
          metadata: { user_id: userId, org_id: ORG_WEBHOOK },
          items: {
            data: [{
              id: "si_seat_01",
              price: { id: "price_enterprise_seat" },
              quantity: 15,
            }],
          },
        },
      },
    });

    const response = await sendWebhook(handler, env, webhookPayload);
    expect(response.status).toBe(200);

    // Verify the org seat_limit was updated
    const org = db.prepare("SELECT seat_limit FROM organizations WHERE org_id = ?").get(ORG_WEBHOOK) as { seat_limit: number };
    expect(org.seat_limit).toBe(15);
  });

  it("AC#6: webhook logs seat billing event", async () => {
    const { userId } = await createTestUser(db, "enterprise");
    const handler = createHandler();
    const env = buildEnv(d1);

    createEnterpriseOrg(db, ORG_WEBHOOK_LOG, userId, 5, "sub_webhook_log_01");

    const webhookPayload = JSON.stringify({
      id: "evt_seat_log_01",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_webhook_log_01",
          customer: "cus_test_ent_456",
          status: "active",
          current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
          metadata: { user_id: userId, org_id: ORG_WEBHOOK_LOG },
          items: {
            data: [{
              id: "si_seat_log_01",
              price: { id: "price_enterprise_seat" },
              quantity: 20,
            }],
          },
        },
      },
    });

    const response = await sendWebhook(handler, env, webhookPayload);
    expect(response.status).toBe(200);

    // Verify billing event was logged
    const events = db.prepare(
      "SELECT event_type, metadata FROM billing_events WHERE user_id = ?",
    ).all(userId) as Array<{ event_type: string; metadata: string | null }>;
    expect(events.length).toBeGreaterThanOrEqual(1);
  });
});
