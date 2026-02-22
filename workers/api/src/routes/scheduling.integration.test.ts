/**
 * Integration tests for GET /v1/scheduling/sessions (TM-w5wj).
 *
 * Verifies that the API worker returns the correct HTTP response envelope shape
 * for scheduling session listings. The frontend api.ts `listSessions()` function
 * depends on the response being `{ ok: true, data: { items: [...], total: N } }`
 * so it can unwrap `.data.items` into a plain SchedulingSession[] array.
 *
 * These tests exercise the FULL handler flow: createHandler() -> fetch() -> response,
 * with a mock UserGraph DO that returns configurable session data (following the
 * established pattern from graph.integration.test.ts and accounts.integration.test.ts).
 *
 * The DO layer is mocked (it returns canned data), but the API handler, routing,
 * auth, and response envelope logic are all REAL -- proving the HTTP response shape
 * matches what the frontend expects.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import {
  MIGRATION_0001_INITIAL_SCHEMA,
  MIGRATION_0008_SYNC_STATUS_COLUMNS,
  MIGRATION_0012_SUBSCRIPTIONS,
  MIGRATION_0013_SUBSCRIPTION_LIFECYCLE,
} from "@tminus/d1-registry";
import { createHandler, createJwt } from "../index";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const JWT_SECRET = "scheduling-integration-test-secret-32chars-min";

const TEST_ORG = {
  org_id: "org_01HXY000000000000000000001",
  name: "Scheduling Integration Test Org",
} as const;

const TEST_USER = {
  user_id: "usr_01HXY000000000000000000001",
  org_id: TEST_ORG.org_id,
  email: "scheduling-test@example.com",
} as const;

// ---------------------------------------------------------------------------
// Mock session data (mirrors the shape returned by UserGraph DO
// listSchedulingSessions method)
// ---------------------------------------------------------------------------

const MOCK_SESSION_A = {
  session_id: "sched_01HXY0000000000000000001",
  user_id: TEST_USER.user_id,
  title: "Weekly Standup",
  status: "candidates_ready",
  duration_minutes: 30,
  window_start: "2026-02-20T08:00:00Z",
  window_end: "2026-02-20T18:00:00Z",
  created_at: "2026-02-19T10:00:00Z",
  updated_at: "2026-02-19T10:05:00Z",
  candidates: [],
  participants: [],
};

const MOCK_SESSION_B = {
  session_id: "sched_01HXY0000000000000000002",
  user_id: TEST_USER.user_id,
  title: "1:1 with Manager",
  status: "open",
  duration_minutes: 60,
  window_start: "2026-02-21T09:00:00Z",
  window_end: "2026-02-21T17:00:00Z",
  created_at: "2026-02-20T08:00:00Z",
  updated_at: "2026-02-20T08:00:00Z",
  candidates: [],
  participants: [],
};

// ---------------------------------------------------------------------------
// Real D1 mock backed by better-sqlite3
// ---------------------------------------------------------------------------

function createRealD1(db: DatabaseType): D1Database {
  const normalizeSQL = (sql: string): string => sql.replace(/\?(\d+)/g, "?");

  function createBoundStatement(normalizedSql: string, params: unknown[]) {
    return {
      first<T>(): Promise<T | null> {
        const stmt = db.prepare(normalizedSql);
        const row = (params.length > 0 ? stmt.get(...params) : stmt.get()) as T | null;
        return Promise.resolve(row ?? null);
      },
      all<T>(): Promise<{ results: T[] }> {
        const stmt = db.prepare(normalizedSql);
        const rows = (params.length > 0 ? stmt.all(...params) : stmt.all()) as T[];
        return Promise.resolve({ results: rows });
      },
      run(): Promise<D1Result<unknown>> {
        const stmt = db.prepare(normalizedSql);
        const info = params.length > 0 ? stmt.run(...params) : stmt.run();
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
  }

  return {
    prepare(sql: string) {
      const normalizedSql = normalizeSQL(sql);
      const unboundStmt = createBoundStatement(normalizedSql, []);
      return {
        ...unboundStmt,
        bind(...params: unknown[]) {
          return createBoundStatement(normalizedSql, params);
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
// Mock DO namespace for UserGraph (scheduling sessions)
// ---------------------------------------------------------------------------

function createMockUserGraphDO(config?: {
  sessions?: unknown[];
  total?: number;
}): DurableObjectNamespace {
  const items = config?.sessions ?? [];
  const total = config?.total ?? items.length;

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
          input: RequestInfo | URL,
          init?: RequestInit,
        ): Promise<Response> {
          const url =
            typeof input === "string"
              ? new URL(input)
              : input instanceof URL
                ? input
                : new URL(input.url);

          if (url.pathname === "/listSchedulingSessions") {
            return new Response(
              JSON.stringify({ items, total }),
              {
                status: 200,
                headers: { "Content-Type": "application/json" },
              },
            );
          }

          // Default passthrough for other DO calls
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      } as unknown as DurableObjectStub;
    },
    idFromString(_hexId: string): DurableObjectId {
      return {
        toString: () => _hexId,
        equals: () => false,
      } as unknown as DurableObjectId;
    },
    newUniqueId(): DurableObjectId {
      return {
        toString: () => "unique",
        equals: () => false,
      } as unknown as DurableObjectId;
    },
    jurisdiction(_name: string): DurableObjectNamespace {
      return this;
    },
  } as unknown as DurableObjectNamespace;
}

function createMockQueue(): Queue {
  return {
    async send(_msg: unknown) {},
    async sendBatch(_msgs: Iterable<MessageSendRequest>) {},
  } as unknown as Queue;
}

function createMockKV(): KVNamespace {
  return {
    async get(_key: string): Promise<string | null> {
      return null;
    },
    async put(_key: string, _value: string): Promise<void> {},
    async delete(_key: string): Promise<void> {},
    async list(): Promise<{ keys: Array<{ name: string }>; list_complete: boolean }> {
      return { keys: [], list_complete: true };
    },
    async getWithMetadata(): Promise<{ value: string | null; metadata: unknown }> {
      return { value: null, metadata: null };
    },
  } as unknown as KVNamespace;
}

// ---------------------------------------------------------------------------
// Env and helpers
// ---------------------------------------------------------------------------

function buildEnv(
  d1: D1Database,
  userGraphDO?: DurableObjectNamespace,
): Env {
  return {
    DB: d1,
    USER_GRAPH: userGraphDO ?? createMockUserGraphDO(),
    ACCOUNT: createMockUserGraphDO() as unknown as DurableObjectNamespace,
    SYNC_QUEUE: createMockQueue(),
    WRITE_QUEUE: createMockQueue(),
    SESSIONS: createMockKV(),
    JWT_SECRET,
  } as Env;
}

const mockCtx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

async function makeAuthHeader(userId?: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const token = await createJwt(
    { sub: userId ?? TEST_USER.user_id, iat: now, exp: now + 3600 },
    JWT_SECRET,
  );
  return `Bearer ${token}`;
}

// ===========================================================================
// Integration tests
// ===========================================================================

describe("Integration: GET /v1/scheduling/sessions", () => {
  let db: DatabaseType;
  let d1: D1Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(MIGRATION_0001_INITIAL_SCHEMA);
    db.exec(MIGRATION_0008_SYNC_STATUS_COLUMNS);
    db.exec(MIGRATION_0012_SUBSCRIPTIONS);
    db.exec(MIGRATION_0013_SUBSCRIPTION_LIFECYCLE);
    db.prepare("INSERT INTO orgs (org_id, name) VALUES (?, ?)").run(
      TEST_ORG.org_id,
      TEST_ORG.name,
    );
    db.prepare(
      "INSERT INTO users (user_id, org_id, email) VALUES (?, ?, ?)",
    ).run(TEST_USER.user_id, TEST_USER.org_id, TEST_USER.email);
    d1 = createRealD1(db);
  });

  afterEach(() => {
    db.close();
  });

  // -------------------------------------------------------------------------
  // Auth gate
  // -------------------------------------------------------------------------

  it("returns 401 without auth header", async () => {
    const handler = createHandler();
    const env = buildEnv(d1);

    const response = await handler.fetch(
      new Request("https://api.tminus.dev/v1/scheduling/sessions"),
      env,
      mockCtx,
    );

    expect(response.status).toBe(401);
    const body = (await response.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Empty list -- verifies envelope shape with zero items
  // -------------------------------------------------------------------------

  it("returns { ok: true, data: { items: [], total: 0 } } when no sessions exist", async () => {
    const userGraphDO = createMockUserGraphDO({ sessions: [], total: 0 });
    const handler = createHandler();
    const env = buildEnv(d1, userGraphDO);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request("https://api.tminus.dev/v1/scheduling/sessions", {
        headers: { Authorization: authHeader },
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      ok: boolean;
      data: { items: unknown[]; total: number };
      meta: { request_id: string; timestamp: string };
    };

    // Verify the outer envelope
    expect(body.ok).toBe(true);
    expect(body.meta).toBeDefined();
    expect(typeof body.meta.request_id).toBe("string");
    expect(typeof body.meta.timestamp).toBe("string");

    // Verify the data payload is a paginated wrapper (NOT a raw array)
    expect(body.data).toBeDefined();
    expect(typeof body.data).toBe("object");
    expect(Array.isArray(body.data)).toBe(false);
    expect(body.data.items).toBeDefined();
    expect(Array.isArray(body.data.items)).toBe(true);
    expect(body.data.items).toHaveLength(0);
    expect(body.data.total).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Non-empty list -- verifies items are present and total matches
  // -------------------------------------------------------------------------

  it("returns { ok: true, data: { items: [...], total: N } } with session data", async () => {
    const sessions = [MOCK_SESSION_A, MOCK_SESSION_B];
    const userGraphDO = createMockUserGraphDO({ sessions, total: 2 });
    const handler = createHandler();
    const env = buildEnv(d1, userGraphDO);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request("https://api.tminus.dev/v1/scheduling/sessions", {
        headers: { Authorization: authHeader },
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      ok: boolean;
      data: {
        items: Array<{
          session_id: string;
          title: string;
          status: string;
          duration_minutes: number;
        }>;
        total: number;
      };
      meta: { request_id: string; timestamp: string };
    };

    // Outer envelope shape
    expect(body.ok).toBe(true);
    expect(body.meta).toBeDefined();

    // Paginated data shape
    expect(body.data).toBeDefined();
    expect(Array.isArray(body.data)).toBe(false);
    expect(body.data.items).toBeDefined();
    expect(Array.isArray(body.data.items)).toBe(true);
    expect(body.data.items).toHaveLength(2);
    expect(body.data.total).toBe(2);

    // Verify session fields are preserved through the handler
    const first = body.data.items[0];
    expect(first.session_id).toBe(MOCK_SESSION_A.session_id);
    expect(first.title).toBe("Weekly Standup");
    expect(first.status).toBe("candidates_ready");
    expect(first.duration_minutes).toBe(30);

    const second = body.data.items[1];
    expect(second.session_id).toBe(MOCK_SESSION_B.session_id);
    expect(second.title).toBe("1:1 with Manager");
    expect(second.status).toBe("open");
  });

  // -------------------------------------------------------------------------
  // Frontend compatibility: data.items is what listSessions() unwraps
  // -------------------------------------------------------------------------

  it("envelope.data.items is a plain array compatible with Array.isArray and .find()", async () => {
    const sessions = [MOCK_SESSION_A];
    const userGraphDO = createMockUserGraphDO({ sessions, total: 1 });
    const handler = createHandler();
    const env = buildEnv(d1, userGraphDO);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request("https://api.tminus.dev/v1/scheduling/sessions", {
        headers: { Authorization: authHeader },
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      data: { items: unknown[]; total: number };
    };

    // This is the exact unwrapping path the frontend uses:
    //   apiFetch<T> returns envelope.data  -> { items: [...], total: N }
    //   listSessions() returns result.items -> SchedulingSession[]
    const envelopeData = body.data;
    expect(envelopeData).toHaveProperty("items");
    expect(envelopeData).toHaveProperty("total");

    const items = envelopeData.items;
    expect(Array.isArray(items)).toBe(true);
    expect(items).toHaveLength(1);

    // Prove .find() works (this is the exact call site that crashed in
    // Scheduling.tsx:295 before the fix)
    const found = items.find(
      (s: unknown) =>
        (s as { session_id: string }).session_id === MOCK_SESSION_A.session_id,
    );
    expect(found).toBeDefined();
    expect((found as { title: string }).title).toBe("Weekly Standup");
  });

  // -------------------------------------------------------------------------
  // Validation: invalid status filter
  // -------------------------------------------------------------------------

  it("returns 400 for invalid status filter", async () => {
    const handler = createHandler();
    const env = buildEnv(d1);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request(
        "https://api.tminus.dev/v1/scheduling/sessions?status=bogus",
        { headers: { Authorization: authHeader } },
      ),
      env,
      mockCtx,
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("Invalid status filter");
  });

  // -------------------------------------------------------------------------
  // Validation: limit/offset
  // -------------------------------------------------------------------------

  it("returns 400 for out-of-range limit", async () => {
    const handler = createHandler();
    const env = buildEnv(d1);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request(
        "https://api.tminus.dev/v1/scheduling/sessions?limit=999",
        { headers: { Authorization: authHeader } },
      ),
      env,
      mockCtx,
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("limit must be between");
  });

  it("returns 400 for negative offset", async () => {
    const handler = createHandler();
    const env = buildEnv(d1);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request(
        "https://api.tminus.dev/v1/scheduling/sessions?offset=-1",
        { headers: { Authorization: authHeader } },
      ),
      env,
      mockCtx,
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("offset must be");
  });
});
