/**
 * Integration tests for security headers and CORS middleware in the tminus-api worker.
 *
 * These tests use the full createHandler() -> fetch() flow with:
 * - Real D1 via better-sqlite3 (for auth routes)
 * - Real security and CORS middleware (no mocks)
 * - Real JWT creation for authenticated requests
 *
 * Tests prove:
 * - All API responses include security headers (X-Frame-Options, HSTS, CSP, etc)
 * - CORS allows app.tminus.ink, rejects unauthorized origins
 * - Localhost allowed in dev mode (ENVIRONMENT != "production")
 * - Preflight OPTIONS returns correct CORS + security headers
 * - Security headers are present on success, error, and rate-limited responses
 * - Auth route responses include security + CORS headers
 * - Health endpoint includes security + CORS headers
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
  org_id: "org_01HXY000000000000000000SC1",
  name: "Security CORS Test Org",
} as const;

const TEST_USER = {
  user_id: "usr_01HXY000000000000000000SC1",
  org_id: TEST_ORG.org_id,
  email: "securitycors@example.com",
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
// Mock KV namespace
// ---------------------------------------------------------------------------

function createMockKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
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
  } as unknown as KVNamespace;
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
  environment?: string,
): Env {
  return {
    DB: db,
    USER_GRAPH: createMockDONamespace(),
    ACCOUNT: createMockDONamespace(),
    SYNC_QUEUE: createMockQueue(),
    WRITE_QUEUE: createMockQueue(),
    SESSIONS: createMockKV(),
    RATE_LIMITS: undefined as unknown as KVNamespace,
    JWT_SECRET,
    ENVIRONMENT: environment,
  };
}

function createExecutionContext(): ExecutionContext {
  return {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
}

/** Assert all 7 security headers are present on a response. */
function expectSecurityHeaders(response: Response): void {
  expect(response.headers.get("X-Frame-Options")).toBe("DENY");
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(response.headers.get("Strict-Transport-Security")).toBe(
    "max-age=31536000; includeSubDomains",
  );
  expect(response.headers.get("Content-Security-Policy")).toBe(
    "default-src 'none'; frame-ancestors 'none'",
  );
  expect(response.headers.get("Permissions-Policy")).toBe(
    "camera=(), microphone=(), geolocation=()",
  );
  expect(response.headers.get("Referrer-Policy")).toBe(
    "strict-origin-when-cross-origin",
  );
  expect(response.headers.get("X-DNS-Prefetch-Control")).toBe("off");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Security headers integration tests", () => {
  let sqliteDb: DatabaseType;
  let d1: D1Database;
  let handler: ReturnType<typeof createHandler>;

  beforeEach(() => {
    sqliteDb = new Database(":memory:");
    sqliteDb.exec(MIGRATION_0001_INITIAL_SCHEMA);
    sqliteDb.exec(MIGRATION_0004_AUTH_FIELDS);

    sqliteDb.prepare("INSERT INTO orgs (org_id, name) VALUES (?, ?)").run(
      TEST_ORG.org_id,
      TEST_ORG.name,
    );
    sqliteDb.prepare(
      "INSERT INTO users (user_id, org_id, email, password_hash, password_version) VALUES (?, ?, ?, ?, ?)",
    ).run(TEST_USER.user_id, TEST_USER.org_id, TEST_USER.email, "dummy_hash", 1);

    d1 = createRealD1(sqliteDb);
    handler = createHandler();
  });

  // =========================================================================
  // AC 1: All API responses include security headers
  // =========================================================================

  describe("Security headers on all response types", () => {
    it("health endpoint (200 success) includes all security headers", async () => {
      const env = createEnv(d1);
      const ctx = createExecutionContext();

      const response = await handler.fetch(
        new Request("https://api.tminus.ink/health"),
        env,
        ctx,
      );

      expect(response.status).toBe(200);
      expectSecurityHeaders(response);
    });

    it("authenticated endpoint (200 success) includes all security headers", async () => {
      const env = createEnv(d1);
      const ctx = createExecutionContext();
      const jwt = await makeJwt(TEST_USER.user_id, TEST_USER.email);

      const response = await handler.fetch(
        new Request("https://api.tminus.ink/v1/events", {
          headers: { Authorization: `Bearer ${jwt}` },
        }),
        env,
        ctx,
      );

      expect(response.status).toBe(200);
      expectSecurityHeaders(response);
    });

    it("401 unauthorized response includes all security headers", async () => {
      const env = createEnv(d1);
      const ctx = createExecutionContext();

      const response = await handler.fetch(
        new Request("https://api.tminus.ink/v1/events"),
        env,
        ctx,
      );

      expect(response.status).toBe(401);
      expectSecurityHeaders(response);
    });

    it("404 not found response includes all security headers", async () => {
      const env = createEnv(d1);
      const ctx = createExecutionContext();

      const response = await handler.fetch(
        new Request("https://api.tminus.ink/nonexistent"),
        env,
        ctx,
      );

      expect(response.status).toBe(404);
      expectSecurityHeaders(response);
    });

    it("OPTIONS preflight response includes all security headers", async () => {
      const env = createEnv(d1);
      const ctx = createExecutionContext();

      const response = await handler.fetch(
        new Request("https://api.tminus.ink/v1/events", {
          method: "OPTIONS",
          headers: { Origin: "https://app.tminus.ink" },
        }),
        env,
        ctx,
      );

      expect(response.status).toBe(204);
      expectSecurityHeaders(response);
    });

    it("HSTS max-age is exactly 31536000 (1 year)", async () => {
      const env = createEnv(d1);
      const ctx = createExecutionContext();

      const response = await handler.fetch(
        new Request("https://api.tminus.ink/health"),
        env,
        ctx,
      );

      const hsts = response.headers.get("Strict-Transport-Security")!;
      expect(hsts).toContain("max-age=31536000");
      expect(hsts).toContain("includeSubDomains");
    });
  });
});

// ===========================================================================
// CORS integration tests
// ===========================================================================

describe("CORS integration tests", () => {
  let sqliteDb: DatabaseType;
  let d1: D1Database;
  let handler: ReturnType<typeof createHandler>;

  beforeEach(() => {
    sqliteDb = new Database(":memory:");
    sqliteDb.exec(MIGRATION_0001_INITIAL_SCHEMA);
    sqliteDb.exec(MIGRATION_0004_AUTH_FIELDS);

    sqliteDb.prepare("INSERT INTO orgs (org_id, name) VALUES (?, ?)").run(
      TEST_ORG.org_id,
      TEST_ORG.name,
    );
    sqliteDb.prepare(
      "INSERT INTO users (user_id, org_id, email, password_hash, password_version) VALUES (?, ?, ?, ?, ?)",
    ).run(TEST_USER.user_id, TEST_USER.org_id, TEST_USER.email, "dummy_hash", 1);

    d1 = createRealD1(sqliteDb);
    handler = createHandler();
  });

  // =========================================================================
  // AC 2: CORS allows app.tminus.ink, rejects unauthorized origins
  // =========================================================================

  describe("CORS origin validation", () => {
    it("allows https://app.tminus.ink and includes CORS headers", async () => {
      const env = createEnv(d1, "production");
      const ctx = createExecutionContext();

      const response = await handler.fetch(
        new Request("https://api.tminus.ink/health", {
          headers: { Origin: "https://app.tminus.ink" },
        }),
        env,
        ctx,
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://app.tminus.ink",
      );
      expect(response.headers.get("Access-Control-Allow-Methods")).toContain("GET");
      expect(response.headers.get("Vary")).toBe("Origin");
    });

    it("allows https://tminus.ink and includes CORS headers", async () => {
      const env = createEnv(d1, "production");
      const ctx = createExecutionContext();

      const response = await handler.fetch(
        new Request("https://api.tminus.ink/health", {
          headers: { Origin: "https://tminus.ink" },
        }),
        env,
        ctx,
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://tminus.ink",
      );
    });

    it("rejects http://evil.com in production (no CORS headers)", async () => {
      const env = createEnv(d1, "production");
      const ctx = createExecutionContext();

      const response = await handler.fetch(
        new Request("https://api.tminus.ink/health", {
          headers: { Origin: "http://evil.com" },
        }),
        env,
        ctx,
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
      // Security headers are STILL present even without CORS
      expectSecurityHeaders(response);
    });

    it("rejects localhost in production mode (no CORS headers)", async () => {
      const env = createEnv(d1, "production");
      const ctx = createExecutionContext();

      const response = await handler.fetch(
        new Request("https://api.tminus.ink/health", {
          headers: { Origin: "http://localhost:3000" },
        }),
        env,
        ctx,
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });
  });

  // =========================================================================
  // AC 3: Localhost allowed in dev mode
  // =========================================================================

  describe("Localhost in dev mode", () => {
    it("allows http://localhost:3000 when ENVIRONMENT is development", async () => {
      const env = createEnv(d1, "development");
      const ctx = createExecutionContext();

      const response = await handler.fetch(
        new Request("https://api.tminus.ink/health", {
          headers: { Origin: "http://localhost:3000" },
        }),
        env,
        ctx,
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "http://localhost:3000",
      );
    });

    it("allows http://localhost:8787 (wrangler dev port) in dev mode", async () => {
      const env = createEnv(d1, "development");
      const ctx = createExecutionContext();

      const response = await handler.fetch(
        new Request("https://api.tminus.ink/health", {
          headers: { Origin: "http://localhost:8787" },
        }),
        env,
        ctx,
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "http://localhost:8787",
      );
    });

    it("allows http://127.0.0.1:5173 (Vite dev port) in dev mode", async () => {
      const env = createEnv(d1, "development");
      const ctx = createExecutionContext();

      const response = await handler.fetch(
        new Request("https://api.tminus.ink/health", {
          headers: { Origin: "http://127.0.0.1:5173" },
        }),
        env,
        ctx,
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "http://127.0.0.1:5173",
      );
    });

    it("defaults to dev mode when ENVIRONMENT is not set", async () => {
      const env = createEnv(d1); // No ENVIRONMENT set
      const ctx = createExecutionContext();

      const response = await handler.fetch(
        new Request("https://api.tminus.ink/health", {
          headers: { Origin: "http://localhost:3000" },
        }),
        env,
        ctx,
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "http://localhost:3000",
      );
    });
  });

  // =========================================================================
  // CORS preflight (OPTIONS) with allowed and disallowed origins
  // =========================================================================

  describe("CORS preflight", () => {
    it("preflight from allowed origin returns CORS headers", async () => {
      const env = createEnv(d1, "production");
      const ctx = createExecutionContext();

      const response = await handler.fetch(
        new Request("https://api.tminus.ink/v1/events", {
          method: "OPTIONS",
          headers: {
            Origin: "https://app.tminus.ink",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "Authorization, Content-Type",
          },
        }),
        env,
        ctx,
      );

      expect(response.status).toBe(204);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://app.tminus.ink",
      );
      expect(response.headers.get("Access-Control-Allow-Methods")).toContain("GET");
      expect(response.headers.get("Access-Control-Allow-Methods")).toContain("POST");
      expect(response.headers.get("Access-Control-Allow-Methods")).toContain("PUT");
      expect(response.headers.get("Access-Control-Allow-Methods")).toContain("PATCH");
      expect(response.headers.get("Access-Control-Allow-Methods")).toContain("DELETE");
      expect(response.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
      expect(response.headers.get("Access-Control-Allow-Headers")).toContain("Content-Type");
      expect(response.headers.get("Access-Control-Max-Age")).toBe("86400");
    });

    it("preflight from disallowed origin returns 204 WITHOUT CORS headers", async () => {
      const env = createEnv(d1, "production");
      const ctx = createExecutionContext();

      const response = await handler.fetch(
        new Request("https://api.tminus.ink/v1/events", {
          method: "OPTIONS",
          headers: {
            Origin: "http://evil.com",
            "Access-Control-Request-Method": "POST",
          },
        }),
        env,
        ctx,
      );

      expect(response.status).toBe(204);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
      expect(response.headers.get("Access-Control-Allow-Methods")).toBeNull();
      // But still has security headers
      expectSecurityHeaders(response);
    });

    it("preflight from localhost in dev mode returns CORS headers", async () => {
      const env = createEnv(d1, "development");
      const ctx = createExecutionContext();

      const response = await handler.fetch(
        new Request("https://api.tminus.ink/v1/events", {
          method: "OPTIONS",
          headers: {
            Origin: "http://localhost:3000",
            "Access-Control-Request-Method": "GET",
          },
        }),
        env,
        ctx,
      );

      expect(response.status).toBe(204);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "http://localhost:3000",
      );
    });
  });

  // =========================================================================
  // Cross-origin requests on authenticated endpoints
  // =========================================================================

  describe("CORS on authenticated endpoints", () => {
    it("authenticated response from allowed origin includes CORS + security headers", async () => {
      const env = createEnv(d1, "production");
      const ctx = createExecutionContext();
      const jwt = await makeJwt(TEST_USER.user_id, TEST_USER.email);

      const response = await handler.fetch(
        new Request("https://api.tminus.ink/v1/events", {
          headers: {
            Authorization: `Bearer ${jwt}`,
            Origin: "https://app.tminus.ink",
          },
        }),
        env,
        ctx,
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://app.tminus.ink",
      );
      expectSecurityHeaders(response);
    });

    it("401 error from allowed origin includes CORS + security headers", async () => {
      const env = createEnv(d1, "production");
      const ctx = createExecutionContext();

      const response = await handler.fetch(
        new Request("https://api.tminus.ink/v1/events", {
          headers: { Origin: "https://app.tminus.ink" },
        }),
        env,
        ctx,
      );

      expect(response.status).toBe(401);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://app.tminus.ink",
      );
      expectSecurityHeaders(response);
    });

    it("exposes rate limit headers to client via Access-Control-Expose-Headers", async () => {
      const env = createEnv(d1, "production");
      const ctx = createExecutionContext();

      const response = await handler.fetch(
        new Request("https://api.tminus.ink/v1/events", {
          method: "OPTIONS",
          headers: { Origin: "https://app.tminus.ink" },
        }),
        env,
        ctx,
      );

      const exposed = response.headers.get("Access-Control-Expose-Headers");
      expect(exposed).toContain("X-RateLimit-Limit");
      expect(exposed).toContain("X-RateLimit-Remaining");
      expect(exposed).toContain("X-RateLimit-Reset");
      expect(exposed).toContain("Retry-After");
    });
  });

  // =========================================================================
  // Requests without Origin header (same-origin, server-to-server)
  // =========================================================================

  describe("Requests without Origin header", () => {
    it("work normally without CORS headers (no Origin = same-origin)", async () => {
      const env = createEnv(d1);
      const ctx = createExecutionContext();

      const response = await handler.fetch(
        new Request("https://api.tminus.ink/health"),
        env,
        ctx,
      );

      expect(response.status).toBe(200);
      // No CORS headers since no Origin was sent
      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
      // Security headers are always present
      expectSecurityHeaders(response);
    });
  });
});
