/**
 * Integration tests for tier-based feature gating (TM-jfs.2).
 *
 * Tests the full tier gating flow against real D1 (via better-sqlite3):
 * 1. Free user adds 3rd account -> 403 TIER_REQUIRED
 * 2. Premium user adds 3rd account -> allowed
 * 3. Free user calls scheduling/constraints -> 403 TIER_REQUIRED
 * 4. Premium user calls scheduling/constraints -> allowed
 * 5. Enterprise user calls VIP-level features -> allowed
 *
 * All tests use real SQLite databases, real JWT generation, and the
 * actual API handler to verify the full request/response stack.
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
import { getUserTier, upsertSubscription } from "../routes/billing";
import {
  enforceFeatureGate,
  enforceAccountLimit,
  ACCOUNT_LIMITS,
} from "./feature-gate";

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
    async put(
      key: string,
      value: string,
      opts?: { expirationTtl?: number },
    ): Promise<void> {
      const expiration = opts?.expirationTtl
        ? Math.floor(Date.now() / 1000) + opts.expirationTtl
        : undefined;
      store.set(key, { value, expiration });
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
    async list(): Promise<{
      keys: Array<{ name: string }>;
      list_complete: boolean;
    }> {
      return {
        keys: Array.from(store.keys()).map((name) => ({ name })),
        list_complete: true,
      };
    },
    async getWithMetadata(): Promise<{
      value: string | null;
      metadata: unknown;
    }> {
      return { value: null, metadata: null };
    },
  } as unknown as KVNamespace;
}

// ---------------------------------------------------------------------------
// Mock DO namespace (minimal -- returns valid JSON for account/user-graph calls)
// ---------------------------------------------------------------------------

function createMockDONamespace(): DurableObjectNamespace {
  return {
    idFromName(name: string) {
      return {
        toString: () => name,
        name,
        equals: () => false,
      } as unknown as DurableObjectId;
    },
    get(_id: DurableObjectId) {
      return {
        async fetch(input: string | Request): Promise<Response> {
          const url =
            typeof input === "string" ? input : input.url;
          // Return constraint-like response for addConstraint
          if (url.includes("/addConstraint")) {
            return new Response(
              JSON.stringify({
                constraint_id: "cst_test_01",
                kind: "working_hours",
                config_json: {},
                active_from: null,
                active_to: null,
                created_at: new Date().toISOString(),
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          // Return list-like response for listConstraints
          if (url.includes("/listConstraints")) {
            return new Response(
              JSON.stringify({ items: [] }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          // Default: list-like response
          return new Response(
            JSON.stringify({
              items: [],
              cursor: null,
              has_more: false,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        },
      } as unknown as DurableObjectStub;
    },
    idFromString: () => ({}) as DurableObjectId,
    newUniqueId: () => ({}) as DurableObjectId,
    jurisdiction: function () {
      return this;
    },
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
// Helper to create a test user with a specific tier
// ---------------------------------------------------------------------------

async function createTestUser(
  db: DatabaseType,
  tier: "free" | "premium" | "enterprise" = "free",
  suffix = "",
): Promise<{ userId: string; token: string }> {
  const userId = `usr_01HWTEST${suffix.padEnd(18, "0").slice(0, 18)}`;
  const email = `test${suffix}@example.com`;

  // Insert org (idempotent)
  try {
    db.exec(
      `INSERT INTO orgs (org_id, name) VALUES ('org_test_01', 'Test Org')`,
    );
  } catch {
    // org already exists
  }

  db.exec(
    `INSERT INTO users (user_id, org_id, email, password_hash, password_version)
     VALUES ('${userId}', 'org_test_01', '${email}', 'hash', 1)`,
  );

  const token = await createJwt(
    {
      sub: userId,
      email,
      tier,
      pwd_ver: 1,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    JWT_SECRET,
  );

  return { userId, token };
}

/**
 * Set a user's subscription tier in D1 (simulates Stripe webhook completion).
 */
async function setUserTier(
  d1: D1Database,
  userId: string,
  tier: "premium" | "enterprise",
): Promise<void> {
  await upsertSubscription(d1, {
    user_id: userId,
    tier,
    stripe_customer_id: `cus_${userId}`,
    stripe_subscription_id: `sub_${userId}`,
    current_period_end: new Date(
      Date.now() + 30 * 24 * 60 * 60 * 1000,
    ).toISOString(),
    status: "active",
  });
}

/**
 * Insert mock accounts for a user in D1.
 */
function insertAccounts(
  db: DatabaseType,
  userId: string,
  count: number,
): void {
  for (let i = 0; i < count; i++) {
    db.exec(
      `INSERT INTO accounts (account_id, user_id, provider, provider_subject, email, status)
       VALUES ('acc_${userId}_${i}', '${userId}', 'google', 'sub_${userId}_${i}', 'acct${i}@example.com', 'active')`,
    );
  }
}

// ===========================================================================
// Integration tests
// ===========================================================================

describe("Integration: Tier-based feature gating", () => {
  let db: DatabaseType;
  let d1: D1Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(MIGRATION_0001_INITIAL_SCHEMA);
    db.exec(MIGRATION_0004_AUTH_FIELDS);
    db.exec(MIGRATION_0012_SUBSCRIPTIONS);
    db.exec(MIGRATION_0013_SUBSCRIPTION_LIFECYCLE);
    d1 = createRealD1(db);
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // Account limit enforcement via API
  // -----------------------------------------------------------------------

  describe("Account limits via API", () => {
    it("free user at limit (2 accounts) gets 403 TIER_REQUIRED when linking 3rd", async () => {
      const { userId, token } = await createTestUser(db, "free", "AL1");
      insertAccounts(db, userId, 2); // At free limit

      const handler = createHandler();
      const env = buildEnv(d1);

      const request = new Request(
        "https://api.tminus.ink/v1/accounts/link",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
        },
      );

      const response = await handler.fetch(request, env, mockCtx);
      expect(response.status).toBe(403);

      const body = (await response.json()) as {
        ok: boolean;
        error: string;
        error_code: string;
        required_tier: string;
        current_tier: string;
        upgrade_url: string;
        usage: { accounts: number; limit: number };
      };

      expect(body.ok).toBe(false);
      expect(body.error_code).toBe("TIER_REQUIRED");
      expect(body.error).toContain("Account limit reached");
      expect(body.required_tier).toBe("premium");
      expect(body.current_tier).toBe("free");
      expect(body.upgrade_url).toContain(
        "https://app.tminus.ink/billing/upgrade",
      );
      expect(body.upgrade_url).toContain("tier=premium");
      expect(body.usage.accounts).toBe(2);
      expect(body.usage.limit).toBe(2);
    });

    it("premium user with 2 accounts can link a 3rd account", async () => {
      const { userId, token } = await createTestUser(db, "premium", "AL2");
      await setUserTier(d1, userId, "premium");
      insertAccounts(db, userId, 2); // Under premium limit (5)

      const handler = createHandler();
      const env = buildEnv(d1);

      const request = new Request(
        "https://api.tminus.ink/v1/accounts/link",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
        },
      );

      const response = await handler.fetch(request, env, mockCtx);
      // Should NOT be 403 -- the account link handler returns 200 with redirect info
      expect(response.status).toBe(200);

      const body = (await response.json()) as {
        ok: boolean;
        data: { redirect_url: string };
      };
      expect(body.ok).toBe(true);
      expect(body.data.redirect_url).toContain("oauth");
    });

    it("premium user at limit (5 accounts) gets 403 with enterprise upgrade", async () => {
      const { userId, token } = await createTestUser(db, "premium", "AL3");
      await setUserTier(d1, userId, "premium");
      insertAccounts(db, userId, 5); // At premium limit

      const handler = createHandler();
      const env = buildEnv(d1);

      const request = new Request(
        "https://api.tminus.ink/v1/accounts/link",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
        },
      );

      const response = await handler.fetch(request, env, mockCtx);
      expect(response.status).toBe(403);

      const body = (await response.json()) as {
        error_code: string;
        required_tier: string;
        upgrade_url: string;
      };
      expect(body.error_code).toBe("TIER_REQUIRED");
      expect(body.required_tier).toBe("enterprise");
      expect(body.upgrade_url).toContain("tier=enterprise");
    });

    it("enterprise user with 9 accounts can link a 10th", async () => {
      const { userId, token } = await createTestUser(db, "enterprise", "AL4");
      await setUserTier(d1, userId, "enterprise");
      insertAccounts(db, userId, 9); // Under enterprise limit (10)

      const handler = createHandler();
      const env = buildEnv(d1);

      const request = new Request(
        "https://api.tminus.ink/v1/accounts/link",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
        },
      );

      const response = await handler.fetch(request, env, mockCtx);
      expect(response.status).toBe(200);
    });
  });

  // -----------------------------------------------------------------------
  // Feature gating on scheduling/constraints
  // -----------------------------------------------------------------------

  describe("Scheduling/constraint gating via API", () => {
    it("free user creating a constraint gets 403 TIER_REQUIRED", async () => {
      const { token } = await createTestUser(db, "free", "FG1");
      const handler = createHandler();
      const env = buildEnv(d1);

      const request = new Request(
        "https://api.tminus.ink/v1/constraints",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            kind: "working_hours",
            config_json: {
              days: [1, 2, 3, 4, 5],
              start_time: "09:00",
              end_time: "17:00",
              timezone: "America/Chicago",
            },
          }),
        },
      );

      const response = await handler.fetch(request, env, mockCtx);
      expect(response.status).toBe(403);

      const body = (await response.json()) as {
        ok: boolean;
        error: string;
        error_code: string;
        required_tier: string;
        current_tier: string;
        upgrade_url: string;
      };

      expect(body.ok).toBe(false);
      expect(body.error_code).toBe("TIER_REQUIRED");
      expect(body.error).toContain("premium");
      expect(body.required_tier).toBe("premium");
      expect(body.current_tier).toBe("free");
      expect(body.upgrade_url).toContain("tier=premium");
    });

    it("premium user creating a constraint is allowed", async () => {
      const { userId, token } = await createTestUser(db, "premium", "FG2");
      await setUserTier(d1, userId, "premium");

      const handler = createHandler();
      const env = buildEnv(d1);

      const request = new Request(
        "https://api.tminus.ink/v1/constraints",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            kind: "working_hours",
            config_json: {
              days: [1, 2, 3, 4, 5],
              start_time: "09:00",
              end_time: "17:00",
              timezone: "America/Chicago",
            },
          }),
        },
      );

      const response = await handler.fetch(request, env, mockCtx);
      // Should NOT be 403 -- the constraint creation is allowed for premium
      // It should reach the DO handler and return 201
      expect(response.status).toBe(201);
    });

    it("free user listing constraints is allowed (read-only)", async () => {
      const { token } = await createTestUser(db, "free", "FG3");
      const handler = createHandler();
      const env = buildEnv(d1);

      const request = new Request(
        "https://api.tminus.ink/v1/constraints",
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
      );

      const response = await handler.fetch(request, env, mockCtx);
      // Read-only constraint listing is free tier
      expect(response.status).toBe(200);
    });
  });

  // -----------------------------------------------------------------------
  // Feature gating via enforceFeatureGate (direct function calls)
  // -----------------------------------------------------------------------

  describe("enforceFeatureGate with real D1", () => {
    it("free user blocked from premium feature", async () => {
      const { userId } = await createTestUser(db, "free", "EFG1");
      const result = await enforceFeatureGate(userId, "premium", d1);
      expect(result).not.toBeNull();
      expect(result!.status).toBe(403);
    });

    it("premium user allowed for premium feature", async () => {
      const { userId } = await createTestUser(db, "premium", "EFG2");
      await setUserTier(d1, userId, "premium");
      const result = await enforceFeatureGate(userId, "premium", d1);
      expect(result).toBeNull();
    });

    it("premium user blocked from enterprise feature", async () => {
      const { userId } = await createTestUser(db, "premium", "EFG3");
      await setUserTier(d1, userId, "premium");
      const result = await enforceFeatureGate(userId, "enterprise", d1);
      expect(result).not.toBeNull();
      expect(result!.status).toBe(403);
    });

    it("enterprise user allowed for enterprise feature (VIP)", async () => {
      const { userId } = await createTestUser(db, "enterprise", "EFG4");
      await setUserTier(d1, userId, "enterprise");
      const result = await enforceFeatureGate(userId, "enterprise", d1);
      expect(result).toBeNull();
    });

    it("enterprise user allowed for premium feature", async () => {
      const { userId } = await createTestUser(db, "enterprise", "EFG5");
      await setUserTier(d1, userId, "enterprise");
      const result = await enforceFeatureGate(userId, "premium", d1);
      expect(result).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Account limit enforcement via enforceAccountLimit (direct)
  // -----------------------------------------------------------------------

  describe("enforceAccountLimit with real D1", () => {
    it("free user at limit blocked", async () => {
      const { userId } = await createTestUser(db, "free", "EAL1");
      insertAccounts(db, userId, 2);
      const result = await enforceAccountLimit(userId, d1);
      expect(result).not.toBeNull();
      expect(result!.status).toBe(403);
    });

    it("premium user under limit allowed", async () => {
      const { userId } = await createTestUser(db, "premium", "EAL2");
      await setUserTier(d1, userId, "premium");
      insertAccounts(db, userId, 3);
      const result = await enforceAccountLimit(userId, d1);
      expect(result).toBeNull();
    });

    it("enterprise user at 10 accounts blocked", async () => {
      const { userId } = await createTestUser(db, "enterprise", "EAL3");
      await setUserTier(d1, userId, "enterprise");
      insertAccounts(db, userId, 10);
      const result = await enforceAccountLimit(userId, d1);
      expect(result).not.toBeNull();
      expect(result!.status).toBe(403);
    });
  });

  // -----------------------------------------------------------------------
  // Tier upgrade lifecycle: free -> premium unlocks features
  // -----------------------------------------------------------------------

  describe("Tier upgrade lifecycle", () => {
    it("user starts free, upgrades to premium, constraints unlock", async () => {
      const { userId } = await createTestUser(db, "free", "LIFE1");

      // Initially blocked
      let result = await enforceFeatureGate(userId, "premium", d1);
      expect(result).not.toBeNull();
      expect(result!.status).toBe(403);

      // Simulate Stripe upgrade to premium
      await setUserTier(d1, userId, "premium");

      // Now allowed
      result = await enforceFeatureGate(userId, "premium", d1);
      expect(result).toBeNull();
    });

    it("user upgrades from free to enterprise, VIP unlocks", async () => {
      const { userId } = await createTestUser(db, "free", "LIFE2");

      // Initially blocked from enterprise features
      let result = await enforceFeatureGate(userId, "enterprise", d1);
      expect(result).not.toBeNull();

      // Upgrade to enterprise
      await setUserTier(d1, userId, "enterprise");

      // VIP and commitments now allowed
      result = await enforceFeatureGate(userId, "enterprise", d1);
      expect(result).toBeNull();
    });

    it("upgrading from free to premium raises account limit from 2 to 5", async () => {
      const { userId } = await createTestUser(db, "free", "LIFE3");
      insertAccounts(db, userId, 2); // At free limit

      // Blocked at 2
      let result = await enforceAccountLimit(userId, d1);
      expect(result).not.toBeNull();

      // Upgrade to premium
      await setUserTier(d1, userId, "premium");

      // Now can add more (limit is 5, have 2)
      result = await enforceAccountLimit(userId, d1);
      expect(result).toBeNull();
    });
  });
});
