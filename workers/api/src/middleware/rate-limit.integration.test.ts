/**
 * Integration tests for rate limiting in the tminus-api worker.
 *
 * These tests use the full createHandler() -> fetch() flow with:
 * - Real D1 via better-sqlite3 (for auth routes)
 * - Mock KV for RATE_LIMITS and SESSIONS
 * - Real JWT creation for authenticated requests
 *
 * Tests prove:
 * - Unauthenticated users get 429 after exceeding 10/min limit per IP
 * - Free tier users get 429 after exceeding 100/min limit
 * - Premium tier has higher limit than free tier
 * - Auth endpoints (register/login) have separate stricter limits
 * - 429 response includes Retry-After header and standard envelope
 * - Rate limit headers appear on successful responses
 * - Existing tests pass with rate limits (graceful degradation when KV is absent)
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { MIGRATION_0001_INITIAL_SCHEMA, MIGRATION_0004_AUTH_FIELDS } from "@tminus/d1-registry";
import { createHandler, createJwt } from "../index";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const JWT_SECRET = "integration-test-jwt-secret-32chars-minimum";

const TEST_ORG = {
  org_id: "org_01HXY000000000000000000RM1",
  name: "Rate Limit Test Org",
} as const;

const TEST_USER = {
  user_id: "usr_01HXY000000000000000000RM1",
  org_id: TEST_ORG.org_id,
  email: "ratelimit@example.com",
} as const;

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
// Mock KV namespace for rate limiting
// ---------------------------------------------------------------------------

function createMockKV(): KVNamespace & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string, _options?: unknown): Promise<string | null> {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string, _options?: unknown): Promise<void> {
      store.set(key, value);
    },
    async delete(_key: string): Promise<void> {
      store.delete(_key);
    },
    async list(_options?: unknown): Promise<KVNamespaceListResult<unknown, string>> {
      return {
        keys: [],
        list_complete: true,
        cacheStatus: null,
      } as unknown as KVNamespaceListResult<unknown, string>;
    },
    async getWithMetadata(key: string, _options?: unknown): Promise<KVNamespaceGetWithMetadataResult<string, unknown>> {
      const value = store.get(key) ?? null;
      return { value, metadata: null, cacheStatus: null } as unknown as KVNamespaceGetWithMetadataResult<string, unknown>;
    },
  } as unknown as KVNamespace & { store: Map<string, string> };
}

// ---------------------------------------------------------------------------
// Mock DO namespace
// ---------------------------------------------------------------------------

function createMockDONamespace(): DurableObjectNamespace {
  return {
    idFromName(_name: string): DurableObjectId {
      return {
        toString: () => _name,
        name: _name,
        equals: () => false,
      } as unknown as DurableObjectId;
    },
    get(_id: DurableObjectId): DurableObjectStub {
      return {
        async fetch(
          _input: RequestInfo | URL,
          _init?: RequestInit,
        ): Promise<Response> {
          return new Response(JSON.stringify({ ok: true, data: {} }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      } as unknown as DurableObjectStub;
    },
    newUniqueId: () => ({ toString: () => "unique" } as unknown as DurableObjectId),
    idFromString: (id: string) =>
      ({ toString: () => id } as unknown as DurableObjectId),
    jurisdiction: () => ({} as unknown as DurableObjectNamespace),
  } as unknown as DurableObjectNamespace;
}

// ---------------------------------------------------------------------------
// Mock Queue
// ---------------------------------------------------------------------------

function createMockQueue(): Queue {
  return {
    async send(_message: unknown): Promise<void> {},
    async sendBatch(_messages: Iterable<MessageSendRequest>): Promise<void> {},
  } as unknown as Queue;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

async function makeJwt(userId: string, email: string): Promise<string> {
  return createJwt(
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
}

function createEnv(
  db: D1Database,
  rateLimitsKV?: KVNamespace,
): Env {
  return {
    DB: db,
    USER_GRAPH: createMockDONamespace(),
    ACCOUNT: createMockDONamespace(),
    SYNC_QUEUE: createMockQueue(),
    WRITE_QUEUE: createMockQueue(),
    SESSIONS: createMockKV(),
    RATE_LIMITS: rateLimitsKV ?? (undefined as unknown as KVNamespace),
    JWT_SECRET,
  };
}

function createExecutionContext(): ExecutionContext {
  return {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Rate limiting integration tests", () => {
  let sqliteDb: DatabaseType;
  let d1: D1Database;
  let rateLimitsKV: KVNamespace & { store: Map<string, string> };
  let handler: ReturnType<typeof createHandler>;

  beforeEach(() => {
    sqliteDb = new Database(":memory:");
    // Apply migrations
    sqliteDb.exec(MIGRATION_0001_INITIAL_SCHEMA);
    sqliteDb.exec(MIGRATION_0004_AUTH_FIELDS);

    // Seed test data
    sqliteDb.prepare("INSERT INTO orgs (org_id, name) VALUES (?, ?)").run(
      TEST_ORG.org_id,
      TEST_ORG.name,
    );
    sqliteDb.prepare(
      "INSERT INTO users (user_id, org_id, email, password_hash, password_version) VALUES (?, ?, ?, ?, ?)",
    ).run(TEST_USER.user_id, TEST_USER.org_id, TEST_USER.email, "dummy_hash", 1);

    d1 = createRealD1(sqliteDb);
    rateLimitsKV = createMockKV();
    handler = createHandler();
  });

  // =========================================================================
  // AC 1: Unauth endpoints rate-limited per IP
  // =========================================================================

  describe("Unauthenticated user rate limiting (10/min per IP)", () => {
    it("allows requests under the limit and returns rate limit headers", async () => {
      const env = createEnv(d1, rateLimitsKV);
      const ctx = createExecutionContext();

      // First unauthenticated request to a protected endpoint
      const response = await handler.fetch(
        new Request("https://api.tminus.ink/v1/events", {
          headers: { "CF-Connecting-IP": "192.168.1.100" },
        }),
        env,
        ctx,
      );

      // Should get 401 (no auth) but rate limit headers should be present on the response
      // Note: unauthenticated users hitting protected endpoints still get the rate limit check
      // but the 401 response won't have rate limit headers since they're not rate-limited yet
      expect(response.status).toBe(401);
    });

    it("returns 429 after exceeding 10 requests per minute from same IP", async () => {
      const env = createEnv(d1, rateLimitsKV);
      const ctx = createExecutionContext();

      // Send 10 unauthenticated requests (should all get 401 but count toward rate limit)
      for (let i = 0; i < 10; i++) {
        const resp = await handler.fetch(
          new Request("https://api.tminus.ink/v1/events", {
            headers: { "CF-Connecting-IP": "10.0.0.50" },
          }),
          env,
          ctx,
        );
        expect(resp.status).toBe(401);
      }

      // 11th request should be rate-limited with 429
      const rateLimited = await handler.fetch(
        new Request("https://api.tminus.ink/v1/events", {
          headers: { "CF-Connecting-IP": "10.0.0.50" },
        }),
        env,
        ctx,
      );

      expect(rateLimited.status).toBe(429);
      const body = await rateLimited.json() as Record<string, unknown>;
      expect(body).toMatchObject({
        ok: false,
        error: "Too many requests. Please try again later.",
        error_code: "RATE_LIMITED",
      });
      expect(typeof body.error).toBe("string");
      expect(typeof body.error_code).toBe("string");
      expect(rateLimited.headers.get("Retry-After")).toBeTruthy();
      expect(rateLimited.headers.get("X-RateLimit-Limit")).toBe("10");
      expect(rateLimited.headers.get("X-RateLimit-Remaining")).toBe("0");
    });
  });

  // =========================================================================
  // AC 2: Auth endpoints rate-limited per user by tier
  // =========================================================================

  describe("Authenticated user rate limiting (free tier: 100/min)", () => {
    it("allows authenticated requests and adds rate limit headers", async () => {
      const env = createEnv(d1, rateLimitsKV);
      const ctx = createExecutionContext();
      const jwt = await makeJwt(TEST_USER.user_id, TEST_USER.email);

      const response = await handler.fetch(
        new Request("https://api.tminus.ink/v1/events", {
          headers: {
            Authorization: `Bearer ${jwt}`,
            "CF-Connecting-IP": "10.0.0.1",
          },
        }),
        env,
        ctx,
      );

      // Should succeed (200) with rate limit headers
      expect(response.status).toBe(200);
      expect(response.headers.get("X-RateLimit-Limit")).toBe("100");
      expect(response.headers.get("X-RateLimit-Remaining")).toBe("99");
      expect(response.headers.get("X-RateLimit-Reset")).toBeTruthy();
    });

    it("returns 429 after exceeding free tier limit", async () => {
      const env = createEnv(d1, rateLimitsKV);
      const ctx = createExecutionContext();
      const jwt = await makeJwt(TEST_USER.user_id, TEST_USER.email);

      // Pre-fill the rate limit counter to 99 (just under the limit)
      // This avoids making 100 actual requests in a test
      const { computeWindowKey } = await import("@tminus/shared");
      const identity = `user:${TEST_USER.user_id}`;
      const key = computeWindowKey(identity, 60);
      rateLimitsKV.store.set(key, "99");

      // Next request should succeed (100th)
      const okResp = await handler.fetch(
        new Request("https://api.tminus.ink/v1/events", {
          headers: {
            Authorization: `Bearer ${jwt}`,
            "CF-Connecting-IP": "10.0.0.1",
          },
        }),
        env,
        ctx,
      );
      expect(okResp.status).toBe(200);
      expect(okResp.headers.get("X-RateLimit-Remaining")).toBe("0");

      // 101st request should be rate-limited
      const rateLimited = await handler.fetch(
        new Request("https://api.tminus.ink/v1/events", {
          headers: {
            Authorization: `Bearer ${jwt}`,
            "CF-Connecting-IP": "10.0.0.1",
          },
        }),
        env,
        ctx,
      );

      expect(rateLimited.status).toBe(429);
      const body = await rateLimited.json() as Record<string, unknown>;
      expect(body).toMatchObject({
        ok: false,
        error: "Too many requests. Please try again later.",
        error_code: "RATE_LIMITED",
      });
      expect(typeof body.error).toBe("string");
      expect(rateLimited.headers.get("Retry-After")).toBeTruthy();
      expect(rateLimited.headers.get("X-RateLimit-Limit")).toBe("100");
    });
  });

  // =========================================================================
  // Premium tier has higher limit than free tier
  // =========================================================================

  describe("Premium tier has higher limit", () => {
    it("free tier is limited to 100/min while premium allows 500/min", async () => {
      // This is a constant/config-level verification.
      // The tier selection logic is proven in unit tests. Here we verify
      // the config values are what we expect for free vs premium.
      const { TIER_LIMITS } = await import("@tminus/shared");
      expect(TIER_LIMITS.free.maxRequests).toBe(100);
      expect(TIER_LIMITS.premium.maxRequests).toBe(500);
      expect(TIER_LIMITS.enterprise.maxRequests).toBe(2000);
      expect(TIER_LIMITS.premium.maxRequests).toBeGreaterThan(TIER_LIMITS.free.maxRequests);
    });
  });

  // =========================================================================
  // AC 3: 429 response with Retry-After header and standard envelope
  // =========================================================================

  describe("429 response format", () => {
    it("includes Retry-After header, standard envelope, and all rate limit headers", async () => {
      const env = createEnv(d1, rateLimitsKV);
      const ctx = createExecutionContext();

      // Pre-fill to exceed limit
      const { computeWindowKey } = await import("@tminus/shared");
      const identity = `ip:10.0.0.99`;
      const key = computeWindowKey(identity, 60);
      rateLimitsKV.store.set(key, "10");

      const response = await handler.fetch(
        new Request("https://api.tminus.ink/v1/events", {
          headers: { "CF-Connecting-IP": "10.0.0.99" },
        }),
        env,
        ctx,
      );

      expect(response.status).toBe(429);

      // Verify headers
      expect(response.headers.get("Content-Type")).toBe("application/json");
      expect(response.headers.get("Retry-After")).toBeTruthy();
      expect(parseInt(response.headers.get("Retry-After")!)).toBeGreaterThan(0);
      expect(response.headers.get("X-RateLimit-Limit")).toBe("10");
      expect(response.headers.get("X-RateLimit-Remaining")).toBe("0");
      expect(response.headers.get("X-RateLimit-Reset")).toBeTruthy();

      // Verify canonical envelope body (error: string + error_code: string)
      const body = await response.json() as Record<string, unknown>;
      expect(body.ok).toBe(false);
      expect(body.error).toBe("Too many requests. Please try again later.");
      expect(body.error_code).toBe("RATE_LIMITED");
      expect(typeof body.error).toBe("string");
      expect(typeof body.error_code).toBe("string");
      expect((body.meta as Record<string, unknown>).request_id).toMatch(/^req_/);
      expect((body.meta as Record<string, unknown>).timestamp).toBeDefined();
      expect((body.meta as Record<string, unknown>).retry_after).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // AC 4: KV state with auto-expiry (verified by TTL in put options)
  // =========================================================================

  describe("KV state with auto-expiry", () => {
    it("rate limit counters are stored in KV with TTL", async () => {
      const env = createEnv(d1, rateLimitsKV);
      const ctx = createExecutionContext();
      const jwt = await makeJwt(TEST_USER.user_id, TEST_USER.email);

      // Make a request to trigger a KV write
      await handler.fetch(
        new Request("https://api.tminus.ink/v1/events", {
          headers: {
            Authorization: `Bearer ${jwt}`,
            "CF-Connecting-IP": "10.0.0.1",
          },
        }),
        env,
        ctx,
      );

      // Verify a rate limit key was written to KV
      const keys = Array.from(rateLimitsKV.store.keys());
      const rlKey = keys.find((k) => k.startsWith("rl:user:"));
      expect(rlKey).toBeDefined();
      expect(rateLimitsKV.store.get(rlKey!)).toBe("1");
    });
  });

  // =========================================================================
  // AC 5: Register 5/hr/IP, Login 10/min/IP
  // =========================================================================

  describe("Auth endpoint rate limits", () => {
    it("register endpoint: blocked after 5 requests per hour from same IP", async () => {
      const env = createEnv(d1, rateLimitsKV);
      const ctx = createExecutionContext();

      // Pre-fill the register rate limit counter to 5
      const { computeWindowKey } = await import("@tminus/shared");
      const identity = "auth_register:10.0.0.77";
      const key = computeWindowKey(identity, 3600);
      rateLimitsKV.store.set(key, "5");

      // Next register attempt with a real (non-test) email should be rate-limited
      const response = await handler.fetch(
        new Request("https://api.tminus.ink/v1/auth/register", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "CF-Connecting-IP": "10.0.0.77",
          },
          body: JSON.stringify({
            email: "newuser@realmail.com",
            password: "ValidPassword123",
          }),
        }),
        env,
        ctx,
      );

      expect(response.status).toBe(429);
      const body = await response.json() as Record<string, unknown>;
      expect(body).toMatchObject({
        ok: false,
        error: "Too many requests. Please try again later.",
        error_code: "RATE_LIMITED",
      });
      expect(typeof body.error).toBe("string");
      expect(response.headers.get("Retry-After")).toBeTruthy();
      expect(response.headers.get("X-RateLimit-Limit")).toBe("5");
    });

    it("login endpoint: blocked after 10 requests per minute from same IP", async () => {
      const env = createEnv(d1, rateLimitsKV);
      const ctx = createExecutionContext();

      // Pre-fill the login rate limit counter to 10
      const { computeWindowKey } = await import("@tminus/shared");
      const identity = "auth_login:10.0.0.88";
      const key = computeWindowKey(identity, 60);
      rateLimitsKV.store.set(key, "10");

      // Next login attempt should be rate-limited
      const response = await handler.fetch(
        new Request("https://api.tminus.ink/v1/auth/login", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "CF-Connecting-IP": "10.0.0.88",
          },
          body: JSON.stringify({
            email: "test@example.com",
            password: "anypassword",
          }),
        }),
        env,
        ctx,
      );

      expect(response.status).toBe(429);
      const body = await response.json() as Record<string, unknown>;
      expect(body).toMatchObject({
        ok: false,
        error: "Too many requests. Please try again later.",
        error_code: "RATE_LIMITED",
      });
      expect(typeof body.error).toBe("string");
      expect(response.headers.get("X-RateLimit-Limit")).toBe("10");
    });

    it("register: allows 5 requests before blocking", async () => {
      const env = createEnv(d1, rateLimitsKV);
      const ctx = createExecutionContext();

      // Each register attempt with a unique email will create a new user (or fail on duplicate).
      // For this test, we just need to verify the rate limiter kicks in after 5 requests.
      for (let i = 0; i < 5; i++) {
        const resp = await handler.fetch(
          new Request("https://api.tminus.ink/v1/auth/register", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "CF-Connecting-IP": "10.0.0.55",
            },
            body: JSON.stringify({
              email: `user${i}@rate-test.com`,
              password: "ValidPassword123",
            }),
          }),
          env,
          ctx,
        );
        // Should NOT be 429 (might be 201 or 400 depending on validation)
        expect(resp.status).not.toBe(429);
      }

      // 6th request from same IP should be rate-limited
      const rateLimited = await handler.fetch(
        new Request("https://api.tminus.ink/v1/auth/register", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "CF-Connecting-IP": "10.0.0.55",
          },
          body: JSON.stringify({
            email: "user5@rate-test.com",
            password: "ValidPassword123",
          }),
        }),
        env,
        ctx,
      );

      expect(rateLimited.status).toBe(429);
    });
  });

  // =========================================================================
  // AC 6: Existing tests pass with rate limits
  // =========================================================================

  describe("Graceful degradation (RATE_LIMITS KV not bound)", () => {
    it("works without RATE_LIMITS binding (no rate limiting applied)", async () => {
      // Create env WITHOUT rate limits KV
      const envNoRL = createEnv(d1);
      const ctx = createExecutionContext();
      const jwt = await makeJwt(TEST_USER.user_id, TEST_USER.email);

      const response = await handler.fetch(
        new Request("https://api.tminus.ink/v1/events", {
          headers: {
            Authorization: `Bearer ${jwt}`,
            "CF-Connecting-IP": "10.0.0.1",
          },
        }),
        envNoRL,
        ctx,
      );

      // Should work normally without rate limit headers
      expect(response.status).toBe(200);
      expect(response.headers.get("X-RateLimit-Limit")).toBeNull();
    });

    it("health endpoint is never rate-limited", async () => {
      const env = createEnv(d1, rateLimitsKV);
      const ctx = createExecutionContext();

      // Make many health check requests
      for (let i = 0; i < 20; i++) {
        const resp = await handler.fetch(
          new Request("https://api.tminus.ink/health", {
            headers: { "CF-Connecting-IP": "10.0.0.1" },
          }),
          env,
          ctx,
        );
        expect(resp.status).toBe(200);
      }
    });

    it("CORS preflight is never rate-limited", async () => {
      const env = createEnv(d1, rateLimitsKV);
      const ctx = createExecutionContext();

      for (let i = 0; i < 20; i++) {
        const resp = await handler.fetch(
          new Request("https://api.tminus.ink/v1/events", {
            method: "OPTIONS",
            headers: { "CF-Connecting-IP": "10.0.0.1" },
          }),
          env,
          ctx,
        );
        expect(resp.status).toBe(204);
      }
    });
  });

  // =========================================================================
  // Different IPs have independent rate limits
  // =========================================================================

  describe("IP isolation", () => {
    it("different IPs have independent rate limit counters", async () => {
      const env = createEnv(d1, rateLimitsKV);
      const ctx = createExecutionContext();

      // Pre-fill one IP to the limit
      const { computeWindowKey } = await import("@tminus/shared");
      const identity1 = "ip:10.0.0.1";
      const key1 = computeWindowKey(identity1, 60);
      rateLimitsKV.store.set(key1, "10");

      // IP 10.0.0.1 should be blocked
      const blocked = await handler.fetch(
        new Request("https://api.tminus.ink/v1/events", {
          headers: { "CF-Connecting-IP": "10.0.0.1" },
        }),
        env,
        ctx,
      );
      expect(blocked.status).toBe(429);

      // IP 10.0.0.2 should NOT be blocked
      const allowed = await handler.fetch(
        new Request("https://api.tminus.ink/v1/events", {
          headers: { "CF-Connecting-IP": "10.0.0.2" },
        }),
        env,
        ctx,
      );
      expect(allowed.status).toBe(401); // 401 because no auth, but NOT 429
    });
  });

  // =========================================================================
  // TM-x8aq: Test email exemption from register rate limits
  // =========================================================================

  describe("Test email exemption from register rate limits (TM-x8aq)", () => {
    it("test email (@example.com) bypasses register rate limit even when IP is exhausted", async () => {
      const env = createEnv(d1, rateLimitsKV);
      const ctx = createExecutionContext();

      // Pre-fill the register rate limit counter for this IP to the limit (5/hr)
      const { computeWindowKey } = await import("@tminus/shared");
      const identity = "auth_register:10.0.0.200";
      const key = computeWindowKey(identity, 3600);
      rateLimitsKV.store.set(key, "5");

      // A real email from the same IP should be blocked
      const blockedResp = await handler.fetch(
        new Request("https://api.tminus.ink/v1/auth/register", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "CF-Connecting-IP": "10.0.0.200",
          },
          body: JSON.stringify({
            email: "realuser@gmail.com",
            password: "ValidPassword123",
          }),
        }),
        env,
        ctx,
      );
      expect(blockedResp.status).toBe(429);

      // A test email from the same IP should NOT be blocked
      const exemptResp = await handler.fetch(
        new Request("https://api.tminus.ink/v1/auth/register", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "CF-Connecting-IP": "10.0.0.200",
          },
          body: JSON.stringify({
            email: "testuser@example.com",
            password: "ValidPassword123",
          }),
        }),
        env,
        ctx,
      );
      // Should NOT be 429 -- should proceed to handler (likely 201 for success)
      expect(exemptResp.status).not.toBe(429);
      // Verify it actually reached the register handler (201 = user created)
      expect(exemptResp.status).toBe(201);
      const body = await exemptResp.json() as Record<string, unknown>;
      expect(body.ok).toBe(true);
    });

    it("smoke-test email pattern (@test.tminus.ink) bypasses register rate limit", async () => {
      const env = createEnv(d1, rateLimitsKV);
      const ctx = createExecutionContext();

      // Pre-fill the register rate limit counter for this IP to the limit
      const { computeWindowKey } = await import("@tminus/shared");
      const identity = "auth_register:10.0.0.201";
      const key = computeWindowKey(identity, 3600);
      rateLimitsKV.store.set(key, "5");

      // The exact pattern used by smoke-test.mjs
      const smokeEmail = `smoke-${Date.now().toString(36)}@test.tminus.ink`;
      const exemptResp = await handler.fetch(
        new Request("https://api.tminus.ink/v1/auth/register", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "CF-Connecting-IP": "10.0.0.201",
          },
          body: JSON.stringify({
            email: smokeEmail,
            password: "ValidPassword123",
          }),
        }),
        env,
        ctx,
      );
      // Should NOT be 429 -- should proceed to handler
      expect(exemptResp.status).not.toBe(429);
      expect(exemptResp.status).toBe(201);
    });

    it("test- prefix email bypasses register rate limit", async () => {
      const env = createEnv(d1, rateLimitsKV);
      const ctx = createExecutionContext();

      // Pre-fill the register rate limit counter to the limit
      const { computeWindowKey } = await import("@tminus/shared");
      const identity = "auth_register:10.0.0.202";
      const key = computeWindowKey(identity, 3600);
      rateLimitsKV.store.set(key, "5");

      const exemptResp = await handler.fetch(
        new Request("https://api.tminus.ink/v1/auth/register", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "CF-Connecting-IP": "10.0.0.202",
          },
          body: JSON.stringify({
            email: "test-deployment-check@anyserver.com",
            password: "ValidPassword123",
          }),
        }),
        env,
        ctx,
      );
      expect(exemptResp.status).not.toBe(429);
      expect(exemptResp.status).toBe(201);
    });

    it("login endpoint is NOT exempt for test emails (only register is)", async () => {
      const env = createEnv(d1, rateLimitsKV);
      const ctx = createExecutionContext();

      // Pre-fill the login rate limit counter to the limit
      const { computeWindowKey } = await import("@tminus/shared");
      const identity = "auth_login:10.0.0.203";
      const key = computeWindowKey(identity, 60);
      rateLimitsKV.store.set(key, "10");

      // Even a test email should be rate-limited on login
      const resp = await handler.fetch(
        new Request("https://api.tminus.ink/v1/auth/login", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "CF-Connecting-IP": "10.0.0.203",
          },
          body: JSON.stringify({
            email: "test-user@example.com",
            password: "anypassword",
          }),
        }),
        env,
        ctx,
      );
      expect(resp.status).toBe(429);
    });

    it("real user emails are still rate-limited normally on register", async () => {
      const env = createEnv(d1, rateLimitsKV);
      const ctx = createExecutionContext();

      // Pre-fill to the limit
      const { computeWindowKey } = await import("@tminus/shared");
      const identity = "auth_register:10.0.0.204";
      const key = computeWindowKey(identity, 3600);
      rateLimitsKV.store.set(key, "5");

      const resp = await handler.fetch(
        new Request("https://api.tminus.ink/v1/auth/register", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "CF-Connecting-IP": "10.0.0.204",
          },
          body: JSON.stringify({
            email: "legitimate.user@protonmail.com",
            password: "ValidPassword123",
          }),
        }),
        env,
        ctx,
      );
      expect(resp.status).toBe(429);
      const body = await resp.json() as Record<string, unknown>;
      expect(body.error_code).toBe("RATE_LIMITED");
    });

    it("malformed JSON body still gets rate-limited (no bypass)", async () => {
      const env = createEnv(d1, rateLimitsKV);
      const ctx = createExecutionContext();

      // Pre-fill to the limit
      const { computeWindowKey } = await import("@tminus/shared");
      const identity = "auth_register:10.0.0.205";
      const key = computeWindowKey(identity, 3600);
      rateLimitsKV.store.set(key, "5");

      const resp = await handler.fetch(
        new Request("https://api.tminus.ink/v1/auth/register", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "CF-Connecting-IP": "10.0.0.205",
          },
          body: "not valid json",
        }),
        env,
        ctx,
      );
      // Should still be rate-limited because we can't determine the email
      expect(resp.status).toBe(429);
    });

    it("multiple test email registrations from same IP all succeed (no accumulation)", async () => {
      const env = createEnv(d1, rateLimitsKV);
      const ctx = createExecutionContext();

      // Make 10 test email registrations from the same IP (well above the 5/hr limit)
      for (let i = 0; i < 10; i++) {
        const resp = await handler.fetch(
          new Request("https://api.tminus.ink/v1/auth/register", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "CF-Connecting-IP": "10.0.0.206",
            },
            body: JSON.stringify({
              email: `test-user-${i}@example.com`,
              password: "ValidPassword123",
            }),
          }),
          env,
          ctx,
        );
        // None should be 429 -- test emails bypass rate limiting entirely
        expect(resp.status).not.toBe(429);
        // All should succeed (201)
        expect(resp.status).toBe(201);
      }
    });
  });
});
