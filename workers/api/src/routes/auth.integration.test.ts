/**
 * Integration tests for auth routes.
 *
 * Tests the FULL register -> login -> refresh -> logout flow against
 * real D1 (via better-sqlite3) and real KV (in-memory mock).
 * Proves:
 * - User creation in D1 with PBKDF2 hashed password
 * - Refresh token stored in KV with SHA-256 hashed key
 * - Token rotation on refresh
 * - Logout invalidates refresh token
 * - Auth enforcement: GET /v1/events with JWT returns 200, without returns 401
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { MIGRATION_0001_INITIAL_SCHEMA, MIGRATION_0004_AUTH_FIELDS } from "@tminus/d1-registry";
import { verifyJWT } from "@tminus/shared";
import { createHandler, createJwt } from "../index";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const JWT_SECRET = "integration-test-jwt-secret-32chars-minimum";

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

function createMockKV(): KVNamespace & { store: Map<string, { value: string; expiration?: number }> } {
  const store = new Map<string, { value: string; expiration?: number }>();
  return {
    store,
    async get(key: string): Promise<string | null> {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiration && Date.now() / 1000 > entry.expiration) {
        store.delete(key);
        return null;
      }
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
    async list(): Promise<{ keys: Array<{ name: string }>; list_complete: boolean; cursor?: string }> {
      return { keys: Array.from(store.keys()).map((name) => ({ name })), list_complete: true };
    },
    async getWithMetadata(): Promise<{ value: string | null; metadata: unknown }> {
      return { value: null, metadata: null };
    },
  } as unknown as KVNamespace & { store: Map<string, { value: string; expiration?: number }> };
}

// ---------------------------------------------------------------------------
// Mock DO namespace (minimal, for existing routes that need it)
// ---------------------------------------------------------------------------

function createMockDONamespace(): DurableObjectNamespace {
  return {
    idFromName(name: string) {
      return { toString: () => name, name, equals: () => false } as unknown as DurableObjectId;
    },
    get(_id: DurableObjectId) {
      return {
        async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
          const url = typeof input === "string" ? new URL(input) : input instanceof URL ? input : new URL(input.url);
          // Default response for /listCanonicalEvents
          if (url.pathname === "/listCanonicalEvents") {
            return new Response(JSON.stringify({ items: [], cursor: null, has_more: false }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      } as unknown as DurableObjectStub;
    },
    idFromString: () => ({} as DurableObjectId),
    newUniqueId: () => ({} as DurableObjectId),
    jurisdiction: function() { return this; },
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

function buildEnv(
  d1: D1Database,
  sessions: KVNamespace,
): Env {
  return {
    DB: d1,
    USER_GRAPH: createMockDONamespace(),
    ACCOUNT: createMockDONamespace(),
    SYNC_QUEUE: createMockQueue(),
    WRITE_QUEUE: createMockQueue(),
    SESSIONS: sessions,
    JWT_SECRET,
  };
}

const mockCtx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

// ===========================================================================
// Auth route integration tests
// ===========================================================================

describe("Integration: Auth routes", () => {
  let db: DatabaseType;
  let d1: D1Database;
  let sessions: ReturnType<typeof createMockKV>;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(MIGRATION_0001_INITIAL_SCHEMA);
    // Apply auth fields migration -- SQLite doesn't support multiple ALTERs
    // in a single exec, so run them individually.
    const authStatements = MIGRATION_0004_AUTH_FIELDS.trim().split(";").filter(Boolean);
    for (const stmt of authStatements) {
      db.exec(stmt.trim() + ";");
    }
    d1 = createRealD1(db);
    sessions = createMockKV();
  });

  afterEach(() => {
    db.close();
  });

  // -------------------------------------------------------------------------
  // POST /v1/auth/register
  // -------------------------------------------------------------------------

  describe("POST /v1/auth/register", () => {
    it("creates a new user and returns JWT + refresh token", async () => {
      const handler = createHandler();
      const env = buildEnv(d1, sessions);

      const res = await handler.fetch(
        new Request("https://api.tminus.dev/v1/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "test@example.com", password: "securepass123" }),
        }),
        env,
        mockCtx,
      );

      expect(res.status).toBe(201);
      const body = await res.json() as {
        ok: boolean;
        data: {
          user: { id: string; email: string; tier: string };
          access_token: string;
          refresh_token: string;
        };
        meta: { request_id: string; timestamp: string };
      };
      expect(body.ok).toBe(true);
      expect(body.data.user.email).toBe("test@example.com");
      expect(body.data.user.tier).toBe("free");
      expect(body.data.user.id).toMatch(/^usr_/);
      expect(body.data.access_token).toBeTruthy();
      expect(body.data.refresh_token).toBeTruthy();
      expect(body.meta.request_id).toMatch(/^req_/);

      // Verify user in D1
      const row = db.prepare("SELECT user_id, email, password_hash, password_version FROM users WHERE email = ?").get("test@example.com") as {
        user_id: string;
        email: string;
        password_hash: string;
        password_version: number;
      };
      expect(row).not.toBeNull();
      expect(row.user_id).toMatch(/^usr_/);
      expect(row.password_hash).toBeTruthy();
      // PROOF: password not stored in plaintext
      expect(row.password_hash).not.toContain("securepass123");
      expect(row.password_version).toBe(1);

      // Verify refresh token in KV (key is hashed)
      expect(sessions.store.size).toBe(1);
      const kvEntry = Array.from(sessions.store.entries())[0];
      expect(kvEntry[0]).toMatch(/^refresh_[0-9a-f]{64}$/);
      const sessionData = JSON.parse(kvEntry[1].value);
      expect(sessionData.user_id).toBe(row.user_id);

      // Verify JWT is valid
      const payload = await verifyJWT(body.data.access_token, JWT_SECRET);
      expect(payload).not.toBeNull();
      expect(payload!.sub).toBe(row.user_id);
      expect(payload!.email).toBe("test@example.com");
      expect(payload!.tier).toBe("free");
      expect(payload!.pwd_ver).toBe(1);
    });

    it("returns 409 when email already exists", async () => {
      const handler = createHandler();
      const env = buildEnv(d1, sessions);

      // Register first
      await handler.fetch(
        new Request("https://api.tminus.dev/v1/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "dup@example.com", password: "password123" }),
        }),
        env,
        mockCtx,
      );

      // Try to register again
      const res = await handler.fetch(
        new Request("https://api.tminus.dev/v1/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "dup@example.com", password: "password456" }),
        }),
        env,
        mockCtx,
      );

      expect(res.status).toBe(409);
      const body = await res.json() as { ok: boolean; error_code: string };
      expect(body.ok).toBe(false);
      expect(body.error_code).toBe("CONFLICT");
    });

    it("returns 400 for invalid email format", async () => {
      const handler = createHandler();
      const env = buildEnv(d1, sessions);

      const res = await handler.fetch(
        new Request("https://api.tminus.dev/v1/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "not-an-email", password: "password123" }),
        }),
        env,
        mockCtx,
      );

      expect(res.status).toBe(400);
      const body = await res.json() as { ok: boolean; error_code: string };
      expect(body.ok).toBe(false);
      expect(body.error_code).toBe("VALIDATION_ERROR");
    });

    it("returns 400 for weak password", async () => {
      const handler = createHandler();
      const env = buildEnv(d1, sessions);

      const res = await handler.fetch(
        new Request("https://api.tminus.dev/v1/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "test@example.com", password: "short" }),
        }),
        env,
        mockCtx,
      );

      expect(res.status).toBe(400);
      const body = await res.json() as { ok: boolean; error_code: string };
      expect(body.ok).toBe(false);
      expect(body.error_code).toBe("VALIDATION_ERROR");
    });

    it("returns 400 for missing body", async () => {
      const handler = createHandler();
      const env = buildEnv(d1, sessions);

      const res = await handler.fetch(
        new Request("https://api.tminus.dev/v1/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        }),
        env,
        mockCtx,
      );

      expect(res.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // POST /v1/auth/login
  // -------------------------------------------------------------------------

  describe("POST /v1/auth/login", () => {
    // Helper: register a user first
    async function registerUser(env: Env, email = "test@example.com", password = "securepass123") {
      const handler = createHandler();
      const res = await handler.fetch(
        new Request("https://api.tminus.dev/v1/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
        }),
        env,
        mockCtx,
      );
      return res.json() as Promise<{ ok: boolean; data: { user: { id: string } } }>;
    }

    it("authenticates with correct credentials and returns JWT + refresh token", async () => {
      const handler = createHandler();
      const env = buildEnv(d1, sessions);

      await registerUser(env);

      const res = await handler.fetch(
        new Request("https://api.tminus.dev/v1/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "test@example.com", password: "securepass123" }),
        }),
        env,
        mockCtx,
      );

      expect(res.status).toBe(200);
      const body = await res.json() as {
        ok: boolean;
        data: {
          user: { id: string; email: string; tier: string };
          access_token: string;
          refresh_token: string;
        };
      };
      expect(body.ok).toBe(true);
      expect(body.data.user.email).toBe("test@example.com");
      expect(body.data.access_token).toBeTruthy();
      expect(body.data.refresh_token).toBeTruthy();

      // Verify JWT payload
      const payload = await verifyJWT(body.data.access_token, JWT_SECRET);
      expect(payload).not.toBeNull();
      expect(payload!.email).toBe("test@example.com");
    });

    it("returns 401 for wrong password", async () => {
      const handler = createHandler();
      const env = buildEnv(d1, sessions);

      await registerUser(env);

      const res = await handler.fetch(
        new Request("https://api.tminus.dev/v1/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "test@example.com", password: "wrongpassword" }),
        }),
        env,
        mockCtx,
      );

      expect(res.status).toBe(401);
      const body = await res.json() as { ok: boolean; error_code: string };
      expect(body.ok).toBe(false);
      expect(body.error_code).toBe("AUTH_FAILED");
    });

    it("increments failed_login_attempts on wrong password", async () => {
      const handler = createHandler();
      const env = buildEnv(d1, sessions);

      await registerUser(env);

      // Wrong password attempt
      await handler.fetch(
        new Request("https://api.tminus.dev/v1/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "test@example.com", password: "wrongpassword" }),
        }),
        env,
        mockCtx,
      );

      // Verify counter incremented
      const row = db.prepare("SELECT failed_login_attempts FROM users WHERE email = ?").get("test@example.com") as { failed_login_attempts: number };
      expect(row.failed_login_attempts).toBe(1);
    });

    it("resets failed_login_attempts on successful login", async () => {
      const handler = createHandler();
      const env = buildEnv(d1, sessions);

      await registerUser(env);

      // Wrong attempt
      await handler.fetch(
        new Request("https://api.tminus.dev/v1/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "test@example.com", password: "wrongpassword" }),
        }),
        env,
        mockCtx,
      );

      // Correct attempt
      await handler.fetch(
        new Request("https://api.tminus.dev/v1/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "test@example.com", password: "securepass123" }),
        }),
        env,
        mockCtx,
      );

      const row = db.prepare("SELECT failed_login_attempts FROM users WHERE email = ?").get("test@example.com") as { failed_login_attempts: number };
      expect(row.failed_login_attempts).toBe(0);
    });

    it("returns 401 for non-existent email", async () => {
      const handler = createHandler();
      const env = buildEnv(d1, sessions);

      const res = await handler.fetch(
        new Request("https://api.tminus.dev/v1/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "nonexistent@example.com", password: "password123" }),
        }),
        env,
        mockCtx,
      );

      expect(res.status).toBe(401);
    });

    it("returns 400 for missing email/password", async () => {
      const handler = createHandler();
      const env = buildEnv(d1, sessions);

      const res = await handler.fetch(
        new Request("https://api.tminus.dev/v1/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }),
        env,
        mockCtx,
      );

      expect(res.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // POST /v1/auth/refresh
  // -------------------------------------------------------------------------

  describe("POST /v1/auth/refresh", () => {
    async function registerAndLogin(env: Env) {
      const handler = createHandler();
      await handler.fetch(
        new Request("https://api.tminus.dev/v1/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "test@example.com", password: "securepass123" }),
        }),
        env,
        mockCtx,
      );
      const loginRes = await handler.fetch(
        new Request("https://api.tminus.dev/v1/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "test@example.com", password: "securepass123" }),
        }),
        env,
        mockCtx,
      );
      return loginRes.json() as Promise<{
        data: { access_token: string; refresh_token: string; user: { id: string } };
      }>;
    }

    it("exchanges refresh token for new JWT and rotated refresh token", async () => {
      const handler = createHandler();
      const env = buildEnv(d1, sessions);

      const loginData = await registerAndLogin(env);
      const oldRefreshToken = loginData.data.refresh_token;

      const res = await handler.fetch(
        new Request("https://api.tminus.dev/v1/auth/refresh", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: oldRefreshToken }),
        }),
        env,
        mockCtx,
      );

      expect(res.status).toBe(200);
      const body = await res.json() as {
        ok: boolean;
        data: { access_token: string; refresh_token: string };
      };
      expect(body.ok).toBe(true);
      expect(body.data.access_token).toBeTruthy();
      expect(body.data.refresh_token).toBeTruthy();

      // New refresh token should be DIFFERENT from old one (rotation)
      expect(body.data.refresh_token).not.toBe(oldRefreshToken);

      // Verify the new JWT is valid
      const payload = await verifyJWT(body.data.access_token, JWT_SECRET);
      expect(payload).not.toBeNull();
      expect(payload!.email).toBe("test@example.com");
    });

    it("old refresh token is invalid after rotation", async () => {
      const handler = createHandler();
      const env = buildEnv(d1, sessions);

      const loginData = await registerAndLogin(env);
      const oldRefreshToken = loginData.data.refresh_token;

      // Use the refresh token
      await handler.fetch(
        new Request("https://api.tminus.dev/v1/auth/refresh", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: oldRefreshToken }),
        }),
        env,
        mockCtx,
      );

      // Try using the OLD refresh token again
      const res = await handler.fetch(
        new Request("https://api.tminus.dev/v1/auth/refresh", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: oldRefreshToken }),
        }),
        env,
        mockCtx,
      );

      expect(res.status).toBe(401);
      const body = await res.json() as { ok: boolean; error_code: string };
      expect(body.ok).toBe(false);
      expect(body.error_code).toBe("AUTH_FAILED");
    });

    it("returns 401 for invalid refresh token", async () => {
      const handler = createHandler();
      const env = buildEnv(d1, sessions);

      const res = await handler.fetch(
        new Request("https://api.tminus.dev/v1/auth/refresh", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: "nonexistent-token" }),
        }),
        env,
        mockCtx,
      );

      expect(res.status).toBe(401);
    });

    it("returns 400 for missing refresh_token", async () => {
      const handler = createHandler();
      const env = buildEnv(d1, sessions);

      const res = await handler.fetch(
        new Request("https://api.tminus.dev/v1/auth/refresh", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }),
        env,
        mockCtx,
      );

      expect(res.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // POST /v1/auth/logout
  // -------------------------------------------------------------------------

  describe("POST /v1/auth/logout", () => {
    it("invalidates refresh token in KV", async () => {
      const handler = createHandler();
      const env = buildEnv(d1, sessions);

      // Register + login
      await handler.fetch(
        new Request("https://api.tminus.dev/v1/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "test@example.com", password: "securepass123" }),
        }),
        env,
        mockCtx,
      );
      const loginRes = await handler.fetch(
        new Request("https://api.tminus.dev/v1/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "test@example.com", password: "securepass123" }),
        }),
        env,
        mockCtx,
      );
      const loginBody = await loginRes.json() as { data: { refresh_token: string } };
      const refreshToken = loginBody.data.refresh_token;

      // Logout
      const res = await handler.fetch(
        new Request("https://api.tminus.dev/v1/auth/logout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: refreshToken }),
        }),
        env,
        mockCtx,
      );

      expect(res.status).toBe(200);
      const body = await res.json() as { ok: boolean; data: { logged_out: boolean } };
      expect(body.ok).toBe(true);
      expect(body.data.logged_out).toBe(true);

      // Try to refresh with the same token -- should fail
      const refreshRes = await handler.fetch(
        new Request("https://api.tminus.dev/v1/auth/refresh", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: refreshToken }),
        }),
        env,
        mockCtx,
      );

      expect(refreshRes.status).toBe(401);
    });

    it("returns 200 even if refresh token was already deleted (idempotent)", async () => {
      const handler = createHandler();
      const env = buildEnv(d1, sessions);

      const res = await handler.fetch(
        new Request("https://api.tminus.dev/v1/auth/logout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: "already-deleted-token" }),
        }),
        env,
        mockCtx,
      );

      expect(res.status).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  // Full flow: register -> login -> access protected endpoint -> refresh -> logout
  // -------------------------------------------------------------------------

  describe("Full auth flow", () => {
    it("register -> login -> GET /v1/events (200) -> refresh -> logout -> refresh fails", async () => {
      const handler = createHandler();
      const env = buildEnv(d1, sessions);

      // 1. Register
      const regRes = await handler.fetch(
        new Request("https://api.tminus.dev/v1/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "flow@example.com", password: "securepass123" }),
        }),
        env,
        mockCtx,
      );
      expect(regRes.status).toBe(201);

      // 2. Login
      const loginRes = await handler.fetch(
        new Request("https://api.tminus.dev/v1/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "flow@example.com", password: "securepass123" }),
        }),
        env,
        mockCtx,
      );
      expect(loginRes.status).toBe(200);
      const loginBody = await loginRes.json() as {
        data: { access_token: string; refresh_token: string };
      };

      // 3. Access protected endpoint WITH JWT -> should return 200
      const eventsRes = await handler.fetch(
        new Request("https://api.tminus.dev/v1/events", {
          method: "GET",
          headers: { Authorization: `Bearer ${loginBody.data.access_token}` },
        }),
        env,
        mockCtx,
      );
      expect(eventsRes.status).toBe(200);

      // 4. Access protected endpoint WITHOUT JWT -> should return 401
      const noAuthRes = await handler.fetch(
        new Request("https://api.tminus.dev/v1/events", {
          method: "GET",
        }),
        env,
        mockCtx,
      );
      expect(noAuthRes.status).toBe(401);

      // 5. Refresh token
      const refreshRes = await handler.fetch(
        new Request("https://api.tminus.dev/v1/auth/refresh", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: loginBody.data.refresh_token }),
        }),
        env,
        mockCtx,
      );
      expect(refreshRes.status).toBe(200);
      const refreshBody = await refreshRes.json() as {
        data: { access_token: string; refresh_token: string };
      };

      // 6. The new JWT also works on protected endpoints
      const eventsRes2 = await handler.fetch(
        new Request("https://api.tminus.dev/v1/events", {
          method: "GET",
          headers: { Authorization: `Bearer ${refreshBody.data.access_token}` },
        }),
        env,
        mockCtx,
      );
      expect(eventsRes2.status).toBe(200);

      // 7. Logout with the new refresh token
      const logoutRes = await handler.fetch(
        new Request("https://api.tminus.dev/v1/auth/logout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: refreshBody.data.refresh_token }),
        }),
        env,
        mockCtx,
      );
      expect(logoutRes.status).toBe(200);

      // 8. Refresh with the same token should now fail
      const postLogoutRefresh = await handler.fetch(
        new Request("https://api.tminus.dev/v1/auth/refresh", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: refreshBody.data.refresh_token }),
        }),
        env,
        mockCtx,
      );
      expect(postLogoutRefresh.status).toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  // KV TTL verification
  // -------------------------------------------------------------------------

  describe("KV session TTL", () => {
    it("refresh token stored with 7-day TTL (604800 seconds)", async () => {
      const handler = createHandler();
      const env = buildEnv(d1, sessions);

      await handler.fetch(
        new Request("https://api.tminus.dev/v1/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "ttl@example.com", password: "password123" }),
        }),
        env,
        mockCtx,
      );

      // Check KV entry has expiration set
      const entry = Array.from(sessions.store.values())[0];
      expect(entry.expiration).toBeDefined();

      // Expiration should be approximately 7 days from now
      const nowSeconds = Math.floor(Date.now() / 1000);
      const expectedExpiration = nowSeconds + 604800;
      const tolerance = 5; // seconds
      expect(entry.expiration).toBeGreaterThanOrEqual(expectedExpiration - tolerance);
      expect(entry.expiration).toBeLessThanOrEqual(expectedExpiration + tolerance);
    });
  });

  // -------------------------------------------------------------------------
  // Password hashing verification
  // -------------------------------------------------------------------------

  describe("Password hashing", () => {
    it("password is hashed with PBKDF2 (not stored in plaintext)", async () => {
      const handler = createHandler();
      const env = buildEnv(d1, sessions);
      const password = "my_secret_password_123";

      await handler.fetch(
        new Request("https://api.tminus.dev/v1/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "hash@example.com", password }),
        }),
        env,
        mockCtx,
      );

      const row = db.prepare("SELECT password_hash FROM users WHERE email = ?").get("hash@example.com") as { password_hash: string };
      // PROOF: password_hash is NOT the plaintext password
      expect(row.password_hash).not.toBe(password);
      expect(row.password_hash).not.toContain(password);
      // PROOF: password_hash is in PBKDF2 format (hex_salt:hex_key)
      expect(row.password_hash).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);
    });
  });

  // -------------------------------------------------------------------------
  // Account lockout and brute force protection (TM-as6.4)
  // -------------------------------------------------------------------------

  describe("Account lockout (TM-as6.4)", () => {
    const LOCKOUT_EMAIL = "lockout@example.com";
    const CORRECT_PASSWORD = "correctpass123";
    const WRONG_PASSWORD = "wrongpassword";

    /** Register a user for lockout tests. */
    async function registerLockoutUser(env: Env) {
      const handler = createHandler();
      await handler.fetch(
        new Request("https://api.tminus.dev/v1/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: LOCKOUT_EMAIL, password: CORRECT_PASSWORD }),
        }),
        env,
        mockCtx,
      );
    }

    /** Attempt a login and return the response. */
    async function attemptLogin(env: Env, password: string) {
      const handler = createHandler();
      return handler.fetch(
        new Request("https://api.tminus.dev/v1/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: LOCKOUT_EMAIL, password }),
        }),
        env,
        mockCtx,
      );
    }

    /** Get the user's lockout state from D1. */
    function getLockoutState() {
      return db.prepare(
        "SELECT failed_login_attempts, locked_until FROM users WHERE email = ?",
      ).get(LOCKOUT_EMAIL) as {
        failed_login_attempts: number;
        locked_until: string | null;
      };
    }

    it("increments failed_login_attempts on each wrong password", async () => {
      const env = buildEnv(d1, sessions);
      await registerLockoutUser(env);

      // 3 wrong attempts
      for (let i = 0; i < 3; i++) {
        const res = await attemptLogin(env, WRONG_PASSWORD);
        expect(res.status).toBe(401);
      }

      const state = getLockoutState();
      expect(state.failed_login_attempts).toBe(3);
      // Should NOT be locked yet (threshold is 5)
      expect(state.locked_until).toBeNull();
    });

    it("locks account for 15 min after 5 failed attempts", async () => {
      const env = buildEnv(d1, sessions);
      await registerLockoutUser(env);

      // 5 wrong attempts
      for (let i = 0; i < 5; i++) {
        await attemptLogin(env, WRONG_PASSWORD);
      }

      const state = getLockoutState();
      expect(state.failed_login_attempts).toBe(5);
      expect(state.locked_until).not.toBeNull();

      // Verify locked_until is approximately 15 min from now
      const lockedUntilMs = new Date(state.locked_until!).getTime();
      const expectedMs = Date.now() + 15 * 60 * 1000;
      expect(lockedUntilMs).toBeGreaterThanOrEqual(expectedMs - 5000);
      expect(lockedUntilMs).toBeLessThanOrEqual(expectedMs + 5000);
    });

    it("returns 403 ERR_ACCOUNT_LOCKED with retryAfter when locked", async () => {
      const env = buildEnv(d1, sessions);
      await registerLockoutUser(env);

      // Lock the account (5 fails)
      for (let i = 0; i < 5; i++) {
        await attemptLogin(env, WRONG_PASSWORD);
      }

      // Next attempt should be blocked with 403
      const res = await attemptLogin(env, CORRECT_PASSWORD);
      expect(res.status).toBe(403);

      const body = await res.json() as {
        ok: boolean;
        error: string;
        error_code: string;
        retryAfter: number;
      };
      expect(body.ok).toBe(false);
      expect(body.error_code).toBe("ERR_ACCOUNT_LOCKED");
      expect(body.error).toContain("locked");
      // retryAfter should be present and approximately 900 seconds (15 min)
      expect(body.retryAfter).toBeGreaterThan(0);
      expect(body.retryAfter).toBeLessThanOrEqual(900);
    });

    it("locks account for 1 hour after 10 failed attempts", async () => {
      const env = buildEnv(d1, sessions);
      await registerLockoutUser(env);

      // Set counter directly to 9 (simulating 9 past failures with expired locks)
      // to avoid having to simulate lock expiry for each intermediate attempt.
      db.prepare("UPDATE users SET failed_login_attempts = 9, locked_until = NULL WHERE email = ?").run(LOCKOUT_EMAIL);

      // One more fail -> total 10 -> 1 hour lockout
      await attemptLogin(env, WRONG_PASSWORD);

      const state = getLockoutState();
      expect(state.failed_login_attempts).toBe(10);
      expect(state.locked_until).not.toBeNull();

      // Verify locked_until is approximately 1 hour from now
      const lockedUntilMs = new Date(state.locked_until!).getTime();
      const expectedMs = Date.now() + 60 * 60 * 1000;
      expect(lockedUntilMs).toBeGreaterThanOrEqual(expectedMs - 5000);
      expect(lockedUntilMs).toBeLessThanOrEqual(expectedMs + 5000);
    });

    it("locks account for 24 hours after 20 failed attempts", async () => {
      const env = buildEnv(d1, sessions);
      await registerLockoutUser(env);

      // Set the counter directly to 19 to avoid 20 sequential login calls
      db.prepare("UPDATE users SET failed_login_attempts = 19, locked_until = NULL WHERE email = ?").run(LOCKOUT_EMAIL);

      // One more fail -> total 20 -> 24 hour lockout
      await attemptLogin(env, WRONG_PASSWORD);

      const state = getLockoutState();
      expect(state.failed_login_attempts).toBe(20);
      expect(state.locked_until).not.toBeNull();

      // Verify locked_until is approximately 24 hours from now
      const lockedUntilMs = new Date(state.locked_until!).getTime();
      const expectedMs = Date.now() + 24 * 60 * 60 * 1000;
      expect(lockedUntilMs).toBeGreaterThanOrEqual(expectedMs - 5000);
      expect(lockedUntilMs).toBeLessThanOrEqual(expectedMs + 5000);
    });

    it("successful login resets failed_login_attempts and locked_until", async () => {
      const env = buildEnv(d1, sessions);
      await registerLockoutUser(env);

      // 3 wrong attempts
      for (let i = 0; i < 3; i++) {
        await attemptLogin(env, WRONG_PASSWORD);
      }
      expect(getLockoutState().failed_login_attempts).toBe(3);

      // Successful login
      const res = await attemptLogin(env, CORRECT_PASSWORD);
      expect(res.status).toBe(200);
      const body = await res.json() as { ok: boolean; data: { access_token: string } };
      expect(body.ok).toBe(true);
      expect(body.data.access_token).toBeTruthy();

      // Verify counter is reset
      const state = getLockoutState();
      expect(state.failed_login_attempts).toBe(0);
      expect(state.locked_until).toBeNull();
    });

    it("login succeeds after lockout expires (simulated expiry)", async () => {
      const env = buildEnv(d1, sessions);
      await registerLockoutUser(env);

      // Lock the account (5 fails)
      for (let i = 0; i < 5; i++) {
        await attemptLogin(env, WRONG_PASSWORD);
      }

      // Verify locked
      const lockedRes = await attemptLogin(env, CORRECT_PASSWORD);
      expect(lockedRes.status).toBe(403);

      // Simulate lockout expiry: set locked_until to the past
      db.prepare("UPDATE users SET locked_until = ? WHERE email = ?")
        .run(new Date(Date.now() - 1000).toISOString(), LOCKOUT_EMAIL);

      // Now login should work with correct password
      const res = await attemptLogin(env, CORRECT_PASSWORD);
      expect(res.status).toBe(200);
      const body = await res.json() as { ok: boolean; data: { access_token: string } };
      expect(body.ok).toBe(true);

      // And counter should be reset
      const state = getLockoutState();
      expect(state.failed_login_attempts).toBe(0);
      expect(state.locked_until).toBeNull();
    });

    it("lockout state is persisted in D1 across handler instances", async () => {
      const env = buildEnv(d1, sessions);
      await registerLockoutUser(env);

      // Use one handler instance for 3 failures
      for (let i = 0; i < 3; i++) {
        await attemptLogin(env, WRONG_PASSWORD);
      }

      // Verify D1 state directly
      const state1 = getLockoutState();
      expect(state1.failed_login_attempts).toBe(3);

      // Use a fresh handler instance for 2 more failures
      for (let i = 0; i < 2; i++) {
        await attemptLogin(env, WRONG_PASSWORD);
      }

      // D1 should have cumulative count
      const state2 = getLockoutState();
      expect(state2.failed_login_attempts).toBe(5);
      expect(state2.locked_until).not.toBeNull();
    });

    it("progressive escalation: 5 -> 15min, 10 -> 1hr, 20 -> 24hr", async () => {
      const env = buildEnv(d1, sessions);
      await registerLockoutUser(env);

      // --- Phase 1: 5 fails -> 15 min lock ---
      for (let i = 0; i < 5; i++) {
        await attemptLogin(env, WRONG_PASSWORD);
      }
      let state = getLockoutState();
      expect(state.failed_login_attempts).toBe(5);
      let lockedMs = new Date(state.locked_until!).getTime();
      // Should be ~15 min (900s) from now
      expect(lockedMs - Date.now()).toBeGreaterThan(895_000);
      expect(lockedMs - Date.now()).toBeLessThan(905_000);

      // --- Phase 2: Set counter to 9, simulate expiry, one more fail -> total 10 -> 1 hr lock ---
      // After threshold 5, each subsequent wrong attempt re-locks immediately.
      // To reach 10 we simulate accumulated failures with expired locks.
      db.prepare("UPDATE users SET failed_login_attempts = 9, locked_until = NULL WHERE email = ?").run(LOCKOUT_EMAIL);
      await attemptLogin(env, WRONG_PASSWORD);
      state = getLockoutState();
      expect(state.failed_login_attempts).toBe(10);
      lockedMs = new Date(state.locked_until!).getTime();
      // Should be ~1 hr (3600s) from now
      expect(lockedMs - Date.now()).toBeGreaterThan(3_595_000);
      expect(lockedMs - Date.now()).toBeLessThan(3_605_000);

      // --- Phase 3: Set counter to 19, simulate expiry, one more fail -> total 20 -> 24 hr lock ---
      db.prepare("UPDATE users SET failed_login_attempts = 19, locked_until = NULL WHERE email = ?").run(LOCKOUT_EMAIL);
      await attemptLogin(env, WRONG_PASSWORD);
      state = getLockoutState();
      expect(state.failed_login_attempts).toBe(20);
      lockedMs = new Date(state.locked_until!).getTime();
      // Should be ~24 hr (86400s) from now
      expect(lockedMs - Date.now()).toBeGreaterThan(86_395_000);
      expect(lockedMs - Date.now()).toBeLessThan(86_405_000);
    });
  });
});
