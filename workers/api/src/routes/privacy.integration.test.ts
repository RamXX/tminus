/**
 * Integration tests for privacy routes (GDPR deletion request).
 *
 * Tests the FULL create -> check -> cancel deletion request flow against
 * real D1 (via better-sqlite3). Proves:
 * - Re-authentication required (password verification)
 * - Deletion request creation with 72h grace period
 * - Status checking for authenticated user
 * - Cancellation within grace period
 * - Rejection of duplicate pending requests
 * - Rejection of cancellation after grace period
 * - User isolation (can only see/cancel own requests)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import {
  MIGRATION_0001_INITIAL_SCHEMA,
  MIGRATION_0004_AUTH_FIELDS,
  MIGRATION_0005_DELETION_REQUESTS,
} from "@tminus/d1-registry";
import { hashPassword } from "@tminus/shared";
import { createHandler, createJwt } from "../index";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const JWT_SECRET = "integration-test-jwt-secret-32chars-minimum";
const TEST_PASSWORD = "securepass123";

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
    async list(): Promise<{ keys: Array<{ name: string }>; list_complete: boolean; cursor?: string }> {
      return { keys: Array.from(store.keys()).map((name) => ({ name })), list_complete: true };
    },
    async getWithMetadata(): Promise<{ value: string | null; metadata: unknown }> {
      return { value: null, metadata: null };
    },
  } as unknown as KVNamespace;
}

// ---------------------------------------------------------------------------
// Mock DO namespace
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
// Test env builder
// ---------------------------------------------------------------------------

function buildEnv(d1: D1Database, sessions: KVNamespace): Env {
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

// ---------------------------------------------------------------------------
// Helper: create a test user directly in DB with hashed password
// ---------------------------------------------------------------------------

async function createTestUser(
  db: DatabaseType,
  userId: string,
  email: string,
  password: string,
): Promise<string> {
  const orgId = userId.replace("usr_", "org_");
  const passwordHash = await hashPassword(password);

  db.prepare("INSERT INTO orgs (org_id, name) VALUES (?, ?)").run(orgId, `${email}'s org`);
  db.prepare(
    "INSERT INTO users (user_id, org_id, email, password_hash, password_version) VALUES (?, ?, ?, ?, ?)",
  ).run(userId, orgId, email, passwordHash, 1);

  return userId;
}

// ---------------------------------------------------------------------------
// Helper: create JWT for user
// ---------------------------------------------------------------------------

async function createTestJwt(userId: string, email: string): Promise<string> {
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

// ===========================================================================
// Integration tests
// ===========================================================================

describe("Integration: Privacy routes (deletion request)", () => {
  let db: DatabaseType;
  let d1: D1Database;
  let sessions: KVNamespace;
  const userId = "usr_01HXYZ000000000000PRIV01";
  const email = "privacy-test@example.com";

  beforeEach(async () => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(MIGRATION_0001_INITIAL_SCHEMA);
    // Apply auth fields migration -- split on semicolons
    const authStatements = MIGRATION_0004_AUTH_FIELDS.trim().split(";").filter(Boolean);
    for (const stmt of authStatements) {
      db.exec(stmt.trim() + ";");
    }
    // Apply deletion requests migration
    db.exec(MIGRATION_0005_DELETION_REQUESTS);
    d1 = createRealD1(db);
    sessions = createMockKV();

    // Create test user with known password
    await createTestUser(db, userId, email, TEST_PASSWORD);
  });

  afterEach(() => {
    db.close();
  });

  // -------------------------------------------------------------------------
  // POST /v1/account/delete-request
  // -------------------------------------------------------------------------

  describe("POST /v1/account/delete-request", () => {
    it("creates a pending deletion request with 72h grace period", async () => {
      const handler = createHandler();
      const env = buildEnv(d1, sessions);
      const jwt = await createTestJwt(userId, email);

      const res = await handler.fetch(
        new Request("https://api.tminus.dev/v1/account/delete-request", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${jwt}`,
          },
          body: JSON.stringify({ password: TEST_PASSWORD }),
        }),
        env,
        mockCtx,
      );

      expect(res.status).toBe(201);
      const body = await res.json() as {
        ok: boolean;
        data: {
          request_id: string;
          status: string;
          requested_at: string;
          scheduled_at: string;
          grace_period_hours: number;
          message: string;
        };
        meta: { request_id: string; timestamp: string };
      };
      expect(body.ok).toBe(true);
      expect(body.data.status).toBe("pending");
      expect(body.data.request_id).toMatch(/^delreq_/);
      expect(body.data.grace_period_hours).toBe(72);
      expect(body.data.message).toContain("72 hours");
      expect(body.meta.request_id).toMatch(/^req_/);

      // PROOF: Verify the scheduled_at is approximately 72 hours from now
      const requestedMs = new Date(body.data.requested_at).getTime();
      const scheduledMs = new Date(body.data.scheduled_at).getTime();
      const diffHours = (scheduledMs - requestedMs) / (60 * 60 * 1000);
      expect(diffHours).toBeCloseTo(72, 0); // within 1 hour tolerance

      // PROOF: Verify row exists in D1
      const row = db
        .prepare("SELECT * FROM deletion_requests WHERE user_id = ?")
        .get(userId) as {
        request_id: string;
        user_id: string;
        status: string;
        requested_at: string;
        scheduled_at: string;
        completed_at: string | null;
        cancelled_at: string | null;
      };
      expect(row).not.toBeNull();
      expect(row.status).toBe("pending");
      expect(row.user_id).toBe(userId);
      expect(row.completed_at).toBeNull();
      expect(row.cancelled_at).toBeNull();
    });

    it("returns 401 without authentication", async () => {
      const handler = createHandler();
      const env = buildEnv(d1, sessions);

      const res = await handler.fetch(
        new Request("https://api.tminus.dev/v1/account/delete-request", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: TEST_PASSWORD }),
        }),
        env,
        mockCtx,
      );

      expect(res.status).toBe(401);
    });

    it("returns 400 when password is missing", async () => {
      const handler = createHandler();
      const env = buildEnv(d1, sessions);
      const jwt = await createTestJwt(userId, email);

      const res = await handler.fetch(
        new Request("https://api.tminus.dev/v1/account/delete-request", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${jwt}`,
          },
          body: JSON.stringify({}),
        }),
        env,
        mockCtx,
      );

      expect(res.status).toBe(400);
      const body = await res.json() as { ok: boolean; error: string };
      expect(body.ok).toBe(false);
      expect(body.error).toContain("Password is required");
    });

    it("returns 401 when password is wrong", async () => {
      const handler = createHandler();
      const env = buildEnv(d1, sessions);
      const jwt = await createTestJwt(userId, email);

      const res = await handler.fetch(
        new Request("https://api.tminus.dev/v1/account/delete-request", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${jwt}`,
          },
          body: JSON.stringify({ password: "wrongpassword123" }),
        }),
        env,
        mockCtx,
      );

      expect(res.status).toBe(401);
      const body = await res.json() as { ok: boolean; error: string };
      expect(body.ok).toBe(false);
      expect(body.error).toContain("Invalid password");
    });

    it("returns 409 when a pending request already exists", async () => {
      const handler = createHandler();
      const env = buildEnv(d1, sessions);
      const jwt = await createTestJwt(userId, email);

      // First request -- succeeds
      const res1 = await handler.fetch(
        new Request("https://api.tminus.dev/v1/account/delete-request", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${jwt}`,
          },
          body: JSON.stringify({ password: TEST_PASSWORD }),
        }),
        env,
        mockCtx,
      );
      expect(res1.status).toBe(201);

      // Second request -- should be rejected
      const res2 = await handler.fetch(
        new Request("https://api.tminus.dev/v1/account/delete-request", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${jwt}`,
          },
          body: JSON.stringify({ password: TEST_PASSWORD }),
        }),
        env,
        mockCtx,
      );
      expect(res2.status).toBe(409);
      const body2 = await res2.json() as { ok: boolean; error: string };
      expect(body2.ok).toBe(false);
      expect(body2.error).toContain("already pending");
    });

    it("allows new request after previous was cancelled", async () => {
      const handler = createHandler();
      const env = buildEnv(d1, sessions);
      const jwt = await createTestJwt(userId, email);

      // Create first request
      await handler.fetch(
        new Request("https://api.tminus.dev/v1/account/delete-request", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${jwt}`,
          },
          body: JSON.stringify({ password: TEST_PASSWORD }),
        }),
        env,
        mockCtx,
      );

      // Cancel it
      await handler.fetch(
        new Request("https://api.tminus.dev/v1/account/delete-request", {
          method: "DELETE",
          headers: { Authorization: `Bearer ${jwt}` },
        }),
        env,
        mockCtx,
      );

      // Create new request -- should succeed
      const res = await handler.fetch(
        new Request("https://api.tminus.dev/v1/account/delete-request", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${jwt}`,
          },
          body: JSON.stringify({ password: TEST_PASSWORD }),
        }),
        env,
        mockCtx,
      );
      expect(res.status).toBe(201);

      // PROOF: Two rows in DB -- one cancelled, one pending
      const rows = db
        .prepare("SELECT status FROM deletion_requests WHERE user_id = ? ORDER BY requested_at")
        .all(userId) as Array<{ status: string }>;
      expect(rows).toHaveLength(2);
      expect(rows[0].status).toBe("cancelled");
      expect(rows[1].status).toBe("pending");
    });
  });

  // -------------------------------------------------------------------------
  // GET /v1/account/delete-request
  // -------------------------------------------------------------------------

  describe("GET /v1/account/delete-request", () => {
    it("returns has_pending_request: false when no request exists", async () => {
      const handler = createHandler();
      const env = buildEnv(d1, sessions);
      const jwt = await createTestJwt(userId, email);

      const res = await handler.fetch(
        new Request("https://api.tminus.dev/v1/account/delete-request", {
          method: "GET",
          headers: { Authorization: `Bearer ${jwt}` },
        }),
        env,
        mockCtx,
      );

      expect(res.status).toBe(200);
      const body = await res.json() as {
        ok: boolean;
        data: { has_pending_request: boolean; message: string };
      };
      expect(body.ok).toBe(true);
      expect(body.data.has_pending_request).toBe(false);
      expect(body.data.message).toContain("No deletion request");
    });

    it("returns pending request status with can_cancel: true", async () => {
      const handler = createHandler();
      const env = buildEnv(d1, sessions);
      const jwt = await createTestJwt(userId, email);

      // Create request
      await handler.fetch(
        new Request("https://api.tminus.dev/v1/account/delete-request", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${jwt}`,
          },
          body: JSON.stringify({ password: TEST_PASSWORD }),
        }),
        env,
        mockCtx,
      );

      // Check status
      const res = await handler.fetch(
        new Request("https://api.tminus.dev/v1/account/delete-request", {
          method: "GET",
          headers: { Authorization: `Bearer ${jwt}` },
        }),
        env,
        mockCtx,
      );

      expect(res.status).toBe(200);
      const body = await res.json() as {
        ok: boolean;
        data: {
          has_pending_request: boolean;
          request_id: string;
          status: string;
          can_cancel: boolean;
          requested_at: string;
          scheduled_at: string;
        };
      };
      expect(body.ok).toBe(true);
      expect(body.data.has_pending_request).toBe(true);
      expect(body.data.status).toBe("pending");
      expect(body.data.can_cancel).toBe(true);
      expect(body.data.request_id).toMatch(/^delreq_/);
    });

    it("returns cancelled request status", async () => {
      const handler = createHandler();
      const env = buildEnv(d1, sessions);
      const jwt = await createTestJwt(userId, email);

      // Create and cancel
      await handler.fetch(
        new Request("https://api.tminus.dev/v1/account/delete-request", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${jwt}`,
          },
          body: JSON.stringify({ password: TEST_PASSWORD }),
        }),
        env,
        mockCtx,
      );

      await handler.fetch(
        new Request("https://api.tminus.dev/v1/account/delete-request", {
          method: "DELETE",
          headers: { Authorization: `Bearer ${jwt}` },
        }),
        env,
        mockCtx,
      );

      // Check status
      const res = await handler.fetch(
        new Request("https://api.tminus.dev/v1/account/delete-request", {
          method: "GET",
          headers: { Authorization: `Bearer ${jwt}` },
        }),
        env,
        mockCtx,
      );

      expect(res.status).toBe(200);
      const body = await res.json() as {
        ok: boolean;
        data: {
          has_pending_request: boolean;
          status: string;
          cancelled_at: string;
          can_cancel: boolean;
        };
      };
      expect(body.ok).toBe(true);
      expect(body.data.has_pending_request).toBe(false);
      expect(body.data.status).toBe("cancelled");
      expect(body.data.cancelled_at).toBeTruthy();
      expect(body.data.can_cancel).toBe(false);
    });

    it("returns 401 without authentication", async () => {
      const handler = createHandler();
      const env = buildEnv(d1, sessions);

      const res = await handler.fetch(
        new Request("https://api.tminus.dev/v1/account/delete-request", {
          method: "GET",
        }),
        env,
        mockCtx,
      );

      expect(res.status).toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  // DELETE /v1/account/delete-request
  // -------------------------------------------------------------------------

  describe("DELETE /v1/account/delete-request", () => {
    it("cancels a pending deletion request within grace period", async () => {
      const handler = createHandler();
      const env = buildEnv(d1, sessions);
      const jwt = await createTestJwt(userId, email);

      // Create request
      const createRes = await handler.fetch(
        new Request("https://api.tminus.dev/v1/account/delete-request", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${jwt}`,
          },
          body: JSON.stringify({ password: TEST_PASSWORD }),
        }),
        env,
        mockCtx,
      );
      const createBody = await createRes.json() as { data: { request_id: string } };

      // Cancel
      const res = await handler.fetch(
        new Request("https://api.tminus.dev/v1/account/delete-request", {
          method: "DELETE",
          headers: { Authorization: `Bearer ${jwt}` },
        }),
        env,
        mockCtx,
      );

      expect(res.status).toBe(200);
      const body = await res.json() as {
        ok: boolean;
        data: {
          request_id: string;
          status: string;
          cancelled_at: string;
          message: string;
        };
      };
      expect(body.ok).toBe(true);
      expect(body.data.status).toBe("cancelled");
      expect(body.data.request_id).toBe(createBody.data.request_id);
      expect(body.data.cancelled_at).toBeTruthy();
      expect(body.data.message).toContain("cancelled");

      // PROOF: Verify D1 row updated
      const row = db
        .prepare("SELECT status, cancelled_at FROM deletion_requests WHERE request_id = ?")
        .get(createBody.data.request_id) as { status: string; cancelled_at: string };
      expect(row.status).toBe("cancelled");
      expect(row.cancelled_at).toBeTruthy();
    });

    it("returns 404 when no pending request exists", async () => {
      const handler = createHandler();
      const env = buildEnv(d1, sessions);
      const jwt = await createTestJwt(userId, email);

      const res = await handler.fetch(
        new Request("https://api.tminus.dev/v1/account/delete-request", {
          method: "DELETE",
          headers: { Authorization: `Bearer ${jwt}` },
        }),
        env,
        mockCtx,
      );

      expect(res.status).toBe(404);
      const body = await res.json() as { ok: boolean; error: string };
      expect(body.ok).toBe(false);
      expect(body.error).toContain("No pending deletion request");
    });

    it("returns 403 when grace period has expired", async () => {
      const handler = createHandler();
      const env = buildEnv(d1, sessions);
      const jwt = await createTestJwt(userId, email);

      // Insert a request with scheduled_at in the past (grace period expired)
      const pastScheduled = new Date(Date.now() - 1000).toISOString();
      db.prepare(
        `INSERT INTO deletion_requests (request_id, user_id, status, requested_at, scheduled_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        "delreq_expired_test",
        userId,
        "pending",
        new Date(Date.now() - 72 * 60 * 60 * 1000 - 1000).toISOString(),
        pastScheduled,
      );

      const res = await handler.fetch(
        new Request("https://api.tminus.dev/v1/account/delete-request", {
          method: "DELETE",
          headers: { Authorization: `Bearer ${jwt}` },
        }),
        env,
        mockCtx,
      );

      expect(res.status).toBe(403);
      const body = await res.json() as { ok: boolean; error: string };
      expect(body.ok).toBe(false);
      expect(body.error).toContain("Grace period has expired");
    });

    it("returns 401 without authentication", async () => {
      const handler = createHandler();
      const env = buildEnv(d1, sessions);

      const res = await handler.fetch(
        new Request("https://api.tminus.dev/v1/account/delete-request", {
          method: "DELETE",
        }),
        env,
        mockCtx,
      );

      expect(res.status).toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  // User isolation (AC #6: User can only delete their own account)
  // -------------------------------------------------------------------------

  describe("User isolation", () => {
    const otherUserId = "usr_01HXYZ000000000000PRIV02";
    const otherEmail = "other-user@example.com";

    it("user A cannot see user B's deletion request", async () => {
      const handler = createHandler();
      const env = buildEnv(d1, sessions);

      // Create another user
      await createTestUser(db, otherUserId, otherEmail, TEST_PASSWORD);

      // User B creates a deletion request (directly in DB for simplicity)
      db.prepare(
        `INSERT INTO deletion_requests (request_id, user_id, status, requested_at, scheduled_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        "delreq_other_user",
        otherUserId,
        "pending",
        new Date().toISOString(),
        new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(),
      );

      // User A checks their status -- should see no request
      const jwtA = await createTestJwt(userId, email);
      const res = await handler.fetch(
        new Request("https://api.tminus.dev/v1/account/delete-request", {
          method: "GET",
          headers: { Authorization: `Bearer ${jwtA}` },
        }),
        env,
        mockCtx,
      );

      expect(res.status).toBe(200);
      const body = await res.json() as {
        ok: boolean;
        data: { has_pending_request: boolean };
      };
      expect(body.data.has_pending_request).toBe(false);
    });

    it("user A cannot cancel user B's deletion request", async () => {
      const handler = createHandler();
      const env = buildEnv(d1, sessions);

      // Create another user
      await createTestUser(db, otherUserId, otherEmail, TEST_PASSWORD);

      // User B creates a deletion request
      db.prepare(
        `INSERT INTO deletion_requests (request_id, user_id, status, requested_at, scheduled_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        "delreq_other_cancel",
        otherUserId,
        "pending",
        new Date().toISOString(),
        new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(),
      );

      // User A tries to cancel -- should get 404 (not their request)
      const jwtA = await createTestJwt(userId, email);
      const res = await handler.fetch(
        new Request("https://api.tminus.dev/v1/account/delete-request", {
          method: "DELETE",
          headers: { Authorization: `Bearer ${jwtA}` },
        }),
        env,
        mockCtx,
      );

      expect(res.status).toBe(404);

      // PROOF: User B's request is still pending in DB
      const row = db
        .prepare("SELECT status FROM deletion_requests WHERE request_id = ?")
        .get("delreq_other_cancel") as { status: string };
      expect(row.status).toBe("pending");
    });
  });
});
