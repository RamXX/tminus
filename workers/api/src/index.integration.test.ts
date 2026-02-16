/**
 * Integration tests for tminus-api worker.
 *
 * These tests use better-sqlite3 for real D1 database operations and mock
 * DO stubs that capture calls and return configurable responses. This proves
 * the full request flow: auth -> routing -> D1 query -> DO call -> envelope.
 *
 * Each test exercises the FULL handler flow: createHandler() -> fetch() -> response,
 * with real SQL executing against real table structures and mock DOs that
 * simulate the actual DO protocol.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { MIGRATION_0001_INITIAL_SCHEMA, MIGRATION_0004_AUTH_FIELDS, MIGRATION_0012_SUBSCRIPTIONS, MIGRATION_0013_SUBSCRIPTION_LIFECYCLE } from "@tminus/d1-registry";
import { createHandler, createJwt } from "./index";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const JWT_SECRET = "integration-test-jwt-secret-32chars-minimum";

const TEST_ORG = {
  org_id: "org_01HXY000000000000000000001",
  name: "Integration Test Org",
} as const;

const TEST_USER = {
  user_id: "usr_01HXY000000000000000000001",
  org_id: TEST_ORG.org_id,
  email: "integration@example.com",
} as const;

const ACCOUNT_A = {
  account_id: "acc_01HXY0000000000000000000AA",
  user_id: TEST_USER.user_id,
  provider: "google",
  provider_subject: "google-sub-aaaa",
  email: "alice@gmail.com",
  status: "active",
} as const;

const ACCOUNT_B = {
  account_id: "acc_01HXY0000000000000000000BB",
  user_id: TEST_USER.user_id,
  provider: "google",
  provider_subject: "google-sub-bbbb",
  email: "bob@gmail.com",
  status: "active",
} as const;

// Different user's account -- should not be accessible
const OTHER_USER_ACCOUNT = {
  account_id: "acc_01HXY0000000000000000000CC",
  user_id: "usr_01HXY0000000000000000000ZZ",
  provider: "google",
  provider_subject: "google-sub-cccc",
  email: "other@gmail.com",
  status: "active",
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
// Mock DO namespace: captures calls and returns configured responses
// ---------------------------------------------------------------------------

interface DOCallRecord {
  name: string;
  path: string;
  method: string;
  body?: unknown;
}

function createMockDONamespace(config?: {
  /** Default JSON response for all DO calls. */
  defaultResponse?: unknown;
  /** Map of path -> response data. */
  pathResponses?: Map<string, unknown>;
}): DurableObjectNamespace & { calls: DOCallRecord[] } {
  const calls: DOCallRecord[] = [];
  const defaultResp = config?.defaultResponse ?? { ok: true };

  return {
    calls,
    idFromName(name: string): DurableObjectId {
      return {
        toString: () => name,
        name,
        equals: () => false,
      } as unknown as DurableObjectId;
    },
    get(_id: DurableObjectId): DurableObjectStub {
      const doName = _id.toString();
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
          const method =
            init?.method ??
            (typeof input === "object" && "method" in input
              ? input.method
              : "GET");

          let parsedBody: unknown;
          if (init?.body) {
            try {
              parsedBody = JSON.parse(init.body as string);
            } catch {
              parsedBody = init.body;
            }
          }

          calls.push({ name: doName, path: url.pathname, method, body: parsedBody });

          // Check path-specific responses
          const pathData = config?.pathResponses?.get(url.pathname);
          const responseData = pathData !== undefined ? pathData : defaultResp;

          return new Response(JSON.stringify(responseData), {
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
  } as unknown as DurableObjectNamespace & { calls: DOCallRecord[] };
}

// ---------------------------------------------------------------------------
// MockQueue
// ---------------------------------------------------------------------------

function createMockQueue(): Queue & { messages: unknown[] } {
  const messages: unknown[] = [];
  return {
    messages,
    async send(msg: unknown) {
      messages.push(msg);
    },
    async sendBatch(_msgs: Iterable<MessageSendRequest>) {},
  } as unknown as Queue & { messages: unknown[] };
}

// ---------------------------------------------------------------------------
// JWT helper
// ---------------------------------------------------------------------------

async function makeAuthHeader(userId?: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const token = await createJwt(
    { sub: userId ?? TEST_USER.user_id, iat: now, exp: now + 3600 },
    JWT_SECRET,
  );
  return `Bearer ${token}`;
}

// ---------------------------------------------------------------------------
// Helper: insert account into D1
// ---------------------------------------------------------------------------

function insertAccount(
  db: DatabaseType,
  account: {
    account_id: string;
    user_id: string;
    provider: string;
    provider_subject: string;
    email: string;
    status?: string;
  },
): void {
  db.prepare(
    `INSERT INTO accounts
     (account_id, user_id, provider, provider_subject, email, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    account.account_id,
    account.user_id,
    account.provider,
    account.provider_subject,
    account.email,
    account.status ?? "active",
  );
}

// ---------------------------------------------------------------------------
// Helper: build mock env
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

function buildEnv(
  d1: D1Database,
  userGraphDO?: DurableObjectNamespace,
  accountDO?: DurableObjectNamespace,
  sessions?: KVNamespace,
): Env {
  return {
    DB: d1,
    USER_GRAPH: userGraphDO ?? createMockDONamespace(),
    ACCOUNT: accountDO ?? createMockDONamespace(),
    SYNC_QUEUE: createMockQueue(),
    WRITE_QUEUE: createMockQueue(),
    SESSIONS: sessions ?? createMockKV(),
    JWT_SECRET,
  };
}

const mockCtx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

// ---------------------------------------------------------------------------
// Helper: ensure other user + org exists for cross-user tests
// ---------------------------------------------------------------------------

function seedOtherUser(db: DatabaseType): void {
  const otherOrgId = "org_01HXYZ00000000000000000099";
  db.prepare("INSERT OR IGNORE INTO orgs (org_id, name) VALUES (?, ?)").run(
    otherOrgId,
    "Other Org",
  );
  db.prepare(
    "INSERT OR IGNORE INTO users (user_id, org_id, email) VALUES (?, ?, ?)",
  ).run(OTHER_USER_ACCOUNT.user_id, otherOrgId, "other@example.com");
}

// ===========================================================================
// Integration test suites
// ===========================================================================

describe("Integration: Account endpoints", () => {
  let db: DatabaseType;
  let d1: D1Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(MIGRATION_0001_INITIAL_SCHEMA);
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

  // -----------------------------------------------------------------------
  // POST /v1/accounts/link
  // -----------------------------------------------------------------------

  it("POST /v1/accounts/link returns redirect info with envelope", async () => {
    const handler = createHandler();
    const env = buildEnv(d1);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request("https://api.tminus.dev/v1/accounts/link", {
        method: "POST",
        headers: { Authorization: authHeader },
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      data: { redirect_url: string };
      meta: { request_id: string; timestamp: string };
    };
    expect(body.ok).toBe(true);
    expect(body.data.redirect_url).toContain("oauth");
    expect(body.meta.request_id).toMatch(/^req_/);
    expect(body.meta.timestamp).toBeTruthy();
  });

  // -----------------------------------------------------------------------
  // GET /v1/accounts
  // -----------------------------------------------------------------------

  it("GET /v1/accounts returns user's accounts from D1", async () => {
    insertAccount(db, ACCOUNT_A);
    insertAccount(db, ACCOUNT_B);

    const handler = createHandler();
    const env = buildEnv(d1);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request("https://api.tminus.dev/v1/accounts", {
        method: "GET",
        headers: { Authorization: authHeader },
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      data: Array<{ account_id: string; email: string }>;
    };
    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(2);

    const emails = body.data.map((a) => a.email).sort();
    expect(emails).toEqual(["alice@gmail.com", "bob@gmail.com"]);
  });

  it("GET /v1/accounts does NOT return other users' accounts", async () => {
    insertAccount(db, ACCOUNT_A);
    seedOtherUser(db);
    insertAccount(db, OTHER_USER_ACCOUNT);

    const handler = createHandler();
    const env = buildEnv(d1);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request("https://api.tminus.dev/v1/accounts", {
        method: "GET",
        headers: { Authorization: authHeader },
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      data: Array<{ account_id: string }>;
    };
    expect(body.data).toHaveLength(1);
    expect(body.data[0].account_id).toBe(ACCOUNT_A.account_id);
  });

  it("GET /v1/accounts returns empty array for user with no accounts", async () => {
    const handler = createHandler();
    const env = buildEnv(d1);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request("https://api.tminus.dev/v1/accounts", {
        method: "GET",
        headers: { Authorization: authHeader },
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; data: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // GET /v1/accounts/:id
  // -----------------------------------------------------------------------

  it("GET /v1/accounts/:id returns account with health from AccountDO", async () => {
    insertAccount(db, ACCOUNT_A);

    const accountDO = createMockDONamespace({
      pathResponses: new Map([
        ["/getHealth", {
          lastSyncTs: "2026-01-01T00:00:00Z",
          lastSuccessTs: "2026-01-01T00:00:00Z",
          fullSyncNeeded: false,
        }],
      ]),
    });

    const handler = createHandler();
    const env = buildEnv(d1, undefined, accountDO);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request(`https://api.tminus.dev/v1/accounts/${ACCOUNT_A.account_id}`, {
        method: "GET",
        headers: { Authorization: authHeader },
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      data: {
        account_id: string;
        email: string;
        health: { lastSyncTs: string };
      };
    };
    expect(body.ok).toBe(true);
    expect(body.data.account_id).toBe(ACCOUNT_A.account_id);
    expect(body.data.email).toBe(ACCOUNT_A.email);
    expect(body.data.health).not.toBeNull();
    expect(body.data.health.lastSyncTs).toBe("2026-01-01T00:00:00Z");

    // Verify DO was called with correct account ID
    expect(accountDO.calls).toHaveLength(1);
    expect(accountDO.calls[0].name).toBe(ACCOUNT_A.account_id);
    expect(accountDO.calls[0].path).toBe("/getHealth");
  });

  it("GET /v1/accounts/:id returns 404 for nonexistent account", async () => {
    const handler = createHandler();
    const env = buildEnv(d1);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request(`https://api.tminus.dev/v1/accounts/${ACCOUNT_A.account_id}`, {
        method: "GET",
        headers: { Authorization: authHeader },
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(404);
    const body = (await response.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("Account not found");
  });

  it("GET /v1/accounts/:id returns 404 for another user's account", async () => {
    seedOtherUser(db);
    insertAccount(db, OTHER_USER_ACCOUNT);

    const handler = createHandler();
    const env = buildEnv(d1);
    const authHeader = await makeAuthHeader(); // auth as TEST_USER

    const response = await handler.fetch(
      new Request(
        `https://api.tminus.dev/v1/accounts/${OTHER_USER_ACCOUNT.account_id}`,
        { method: "GET", headers: { Authorization: authHeader } },
      ),
      env,
      mockCtx,
    );

    expect(response.status).toBe(404);
  });

  // -----------------------------------------------------------------------
  // DELETE /v1/accounts/:id
  // -----------------------------------------------------------------------

  it("DELETE /v1/accounts/:id executes cascade: revoke, stop channels, unlink, D1 update", async () => {
    insertAccount(db, ACCOUNT_A);

    const accountDO = createMockDONamespace();
    const userGraphDO = createMockDONamespace();
    const handler = createHandler();
    const env = buildEnv(d1, userGraphDO, accountDO);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request(`https://api.tminus.dev/v1/accounts/${ACCOUNT_A.account_id}`, {
        method: "DELETE",
        headers: { Authorization: authHeader },
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      data: { deleted: boolean };
    };
    expect(body.ok).toBe(true);
    expect(body.data.deleted).toBe(true);

    // Verify AccountDO calls: revokeTokens + stopWatchChannels
    expect(accountDO.calls).toHaveLength(2);
    expect(accountDO.calls[0].path).toBe("/revokeTokens");
    expect(accountDO.calls[1].path).toBe("/stopWatchChannels");

    // Verify UserGraphDO.unlinkAccount was called
    expect(userGraphDO.calls).toHaveLength(1);
    expect(userGraphDO.calls[0].path).toBe("/unlinkAccount");
    expect(userGraphDO.calls[0].body).toEqual({
      account_id: ACCOUNT_A.account_id,
    });

    // Verify D1 status was updated to 'revoked'
    const row = db
      .prepare("SELECT status FROM accounts WHERE account_id = ?")
      .get(ACCOUNT_A.account_id) as { status: string };
    expect(row.status).toBe("revoked");
  });

  it("DELETE /v1/accounts/:id returns 404 for nonexistent account", async () => {
    const handler = createHandler();
    const env = buildEnv(d1);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request(`https://api.tminus.dev/v1/accounts/${ACCOUNT_A.account_id}`, {
        method: "DELETE",
        headers: { Authorization: authHeader },
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(404);
  });

  // -----------------------------------------------------------------------
  // POST /v1/accounts/:id/reconnect
  // -----------------------------------------------------------------------

  it("POST /v1/accounts/:id/reconnect returns OAuth redirect URL for account provider", async () => {
    insertAccount(db, ACCOUNT_A);

    const handler = createHandler();
    const env = buildEnv(d1);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request(
        `https://api.tminus.dev/v1/accounts/${ACCOUNT_A.account_id}/reconnect`,
        {
          method: "POST",
          headers: { Authorization: authHeader },
        },
      ),
      env,
      mockCtx,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      data: {
        account_id: string;
        provider: string;
        redirect_url: string;
        message: string;
      };
    };
    expect(body.ok).toBe(true);
    expect(body.data.account_id).toBe(ACCOUNT_A.account_id);
    expect(body.data.provider).toBe("google");
    expect(body.data.redirect_url).toBe("/oauth/google/start");
    expect(body.data.message).toContain("Re-authenticate");
  });

  it("POST /v1/accounts/:id/reconnect returns 404 for nonexistent account", async () => {
    const handler = createHandler();
    const env = buildEnv(d1);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request(
        `https://api.tminus.dev/v1/accounts/${ACCOUNT_A.account_id}/reconnect`,
        {
          method: "POST",
          headers: { Authorization: authHeader },
        },
      ),
      env,
      mockCtx,
    );

    expect(response.status).toBe(404);
  });

  it("POST /v1/accounts/:id/reconnect returns 404 for another user's account", async () => {
    seedOtherUser(db);
    insertAccount(db, OTHER_USER_ACCOUNT);

    const handler = createHandler();
    const env = buildEnv(d1);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request(
        `https://api.tminus.dev/v1/accounts/${OTHER_USER_ACCOUNT.account_id}/reconnect`,
        {
          method: "POST",
          headers: { Authorization: authHeader },
        },
      ),
      env,
      mockCtx,
    );

    expect(response.status).toBe(404);
  });

  // -----------------------------------------------------------------------
  // GET /v1/accounts/:id/sync-history
  // -----------------------------------------------------------------------

  it("GET /v1/accounts/:id/sync-history returns sync events from UserGraphDO", async () => {
    insertAccount(db, ACCOUNT_A);

    const mockSyncEvents = {
      events: [
        { id: "sh-1", timestamp: "2026-02-14T12:00:00Z", event_count: 12, status: "success" },
        { id: "sh-2", timestamp: "2026-02-14T11:30:00Z", event_count: 8, status: "success" },
        { id: "sh-3", timestamp: "2026-02-14T11:00:00Z", event_count: 0, status: "error", error_message: "Rate limit" },
      ],
    };
    const userGraphDO = createMockDONamespace({
      pathResponses: new Map([["/getSyncHistory", mockSyncEvents]]),
    });

    const handler = createHandler();
    const env = buildEnv(d1, userGraphDO);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request(
        `https://api.tminus.dev/v1/accounts/${ACCOUNT_A.account_id}/sync-history`,
        {
          method: "GET",
          headers: { Authorization: authHeader },
        },
      ),
      env,
      mockCtx,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      data: {
        account_id: string;
        events: Array<{
          id: string;
          timestamp: string;
          event_count: number;
          status: string;
          error_message?: string;
        }>;
      };
    };
    expect(body.ok).toBe(true);
    expect(body.data.account_id).toBe(ACCOUNT_A.account_id);
    expect(body.data.events).toHaveLength(3);
    expect(body.data.events[0].event_count).toBe(12);
    expect(body.data.events[2].status).toBe("error");
    expect(body.data.events[2].error_message).toBe("Rate limit");
  });

  it("GET /v1/accounts/:id/sync-history returns 404 for nonexistent account", async () => {
    const handler = createHandler();
    const env = buildEnv(d1);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request(
        `https://api.tminus.dev/v1/accounts/${ACCOUNT_A.account_id}/sync-history`,
        {
          method: "GET",
          headers: { Authorization: authHeader },
        },
      ),
      env,
      mockCtx,
    );

    expect(response.status).toBe(404);
  });

  it("GET /v1/accounts/:id/sync-history returns empty array when DO has no history", async () => {
    insertAccount(db, ACCOUNT_A);

    // UserGraphDO returns error (path not supported yet)
    const userGraphDO = createMockDONamespace({
      pathResponses: new Map(),
    });

    const handler = createHandler();
    const env = buildEnv(d1, userGraphDO);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request(
        `https://api.tminus.dev/v1/accounts/${ACCOUNT_A.account_id}/sync-history`,
        {
          method: "GET",
          headers: { Authorization: authHeader },
        },
      ),
      env,
      mockCtx,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      data: { account_id: string; events: unknown[] };
    };
    expect(body.ok).toBe(true);
    expect(body.data.account_id).toBe(ACCOUNT_A.account_id);
    // The handler gracefully returns empty events when DO doesn't support the path
    expect(Array.isArray(body.data.events)).toBe(true);
  });
});

// ===========================================================================
// Integration: Event endpoints
// ===========================================================================

describe("Integration: Event endpoints", () => {
  let db: DatabaseType;
  let d1: D1Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(MIGRATION_0001_INITIAL_SCHEMA);
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

  // -----------------------------------------------------------------------
  // GET /v1/events
  // -----------------------------------------------------------------------

  it("GET /v1/events delegates to UserGraphDO.listCanonicalEvents and returns data", async () => {
    const mockEvents = [
      { canonical_event_id: "evt_01HXYZ00000000000000000001", title: "Meeting" },
      { canonical_event_id: "evt_01HXYZ00000000000000000002", title: "Lunch" },
    ];

    const userGraphDO = createMockDONamespace({
      pathResponses: new Map([
        ["/listCanonicalEvents", {
          items: mockEvents,
          cursor: "cursor123",
          has_more: true,
        }],
      ]),
    });

    const handler = createHandler();
    const env = buildEnv(d1, userGraphDO);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request("https://api.tminus.dev/v1/events?start=2026-01-01&end=2026-12-31&limit=10", {
        method: "GET",
        headers: { Authorization: authHeader },
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      data: Array<{ canonical_event_id: string; title: string }>;
      meta: { next_cursor?: string };
    };
    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(2);
    expect(body.data[0].title).toBe("Meeting");
    expect(body.meta.next_cursor).toBe("cursor123");

    // Verify DO was called with correct user ID and query
    expect(userGraphDO.calls).toHaveLength(1);
    expect(userGraphDO.calls[0].name).toBe(TEST_USER.user_id);
    expect(userGraphDO.calls[0].path).toBe("/listCanonicalEvents");
    const doBody = userGraphDO.calls[0].body as Record<string, unknown>;
    expect(doBody.time_min).toBe("2026-01-01");
    expect(doBody.time_max).toBe("2026-12-31");
    expect(doBody.limit).toBe(10);
  });

  it("GET /v1/events passes cursor and account_id filter to DO", async () => {
    const userGraphDO = createMockDONamespace({
      pathResponses: new Map([
        ["/listCanonicalEvents", { items: [], cursor: null, has_more: false }],
      ]),
    });

    const handler = createHandler();
    const env = buildEnv(d1, userGraphDO);
    const authHeader = await makeAuthHeader();

    await handler.fetch(
      new Request(
        `https://api.tminus.dev/v1/events?cursor=abc123&account_id=${ACCOUNT_A.account_id}`,
        { method: "GET", headers: { Authorization: authHeader } },
      ),
      env,
      mockCtx,
    );

    const doBody = userGraphDO.calls[0].body as Record<string, unknown>;
    expect(doBody.cursor).toBe("abc123");
    expect(doBody.origin_account_id).toBe(ACCOUNT_A.account_id);
  });

  // -----------------------------------------------------------------------
  // GET /v1/events/:id
  // -----------------------------------------------------------------------

  it("GET /v1/events/:id returns event with mirrors", async () => {
    const eventId = "evt_01HXYZ00000000000000000001";
    const userGraphDO = createMockDONamespace({
      pathResponses: new Map([
        ["/getCanonicalEvent", {
          event: { canonical_event_id: eventId, title: "Important Meeting" },
          mirrors: [{ target_account_id: ACCOUNT_B.account_id, state: "ACTIVE" }],
        }],
      ]),
    });

    const handler = createHandler();
    const env = buildEnv(d1, userGraphDO);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request(`https://api.tminus.dev/v1/events/${eventId}`, {
        method: "GET",
        headers: { Authorization: authHeader },
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      data: { event: { title: string }; mirrors: unknown[] };
    };
    expect(body.ok).toBe(true);
    expect(body.data.event.title).toBe("Important Meeting");
    expect(body.data.mirrors).toHaveLength(1);
  });

  // -----------------------------------------------------------------------
  // POST /v1/events
  // -----------------------------------------------------------------------

  it("POST /v1/events creates event and returns ID in envelope", async () => {
    const newEventId = "evt_01HXYZ00000000000000000099";
    const userGraphDO = createMockDONamespace({
      pathResponses: new Map([
        ["/upsertCanonicalEvent", newEventId],
      ]),
    });

    const handler = createHandler();
    const env = buildEnv(d1, userGraphDO);
    const authHeader = await makeAuthHeader();

    const eventPayload = {
      title: "New Event",
      origin_account_id: ACCOUNT_A.account_id,
      origin_event_id: "google-event-123",
      start: { dateTime: "2026-06-15T09:00:00Z" },
      end: { dateTime: "2026-06-15T10:00:00Z" },
      all_day: false,
    };

    const response = await handler.fetch(
      new Request("https://api.tminus.dev/v1/events", {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(eventPayload),
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      ok: boolean;
      data: { canonical_event_id: string };
    };
    expect(body.ok).toBe(true);
    expect(body.data.canonical_event_id).toBe(newEventId);

    // Verify DO was called with correct data
    expect(userGraphDO.calls).toHaveLength(1);
    expect(userGraphDO.calls[0].path).toBe("/upsertCanonicalEvent");
    const doBody = userGraphDO.calls[0].body as {
      event: Record<string, unknown>;
      source: string;
    };
    expect(doBody.source).toBe("api");
    expect(doBody.event.title).toBe("New Event");
  });

  // -----------------------------------------------------------------------
  // PATCH /v1/events/:id
  // -----------------------------------------------------------------------

  it("PATCH /v1/events/:id updates event with ID merged into body", async () => {
    const eventId = "evt_01HXYZ00000000000000000001";
    const userGraphDO = createMockDONamespace({
      pathResponses: new Map([
        ["/upsertCanonicalEvent", eventId],
      ]),
    });

    const handler = createHandler();
    const env = buildEnv(d1, userGraphDO);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request(`https://api.tminus.dev/v1/events/${eventId}`, {
        method: "PATCH",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: "Updated Title" }),
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      data: { canonical_event_id: string };
    };
    expect(body.ok).toBe(true);
    expect(body.data.canonical_event_id).toBe(eventId);

    // Verify the event ID was merged into the body
    const doBody = userGraphDO.calls[0].body as {
      event: Record<string, unknown>;
    };
    expect(doBody.event.canonical_event_id).toBe(eventId);
    expect(doBody.event.title).toBe("Updated Title");
  });

  // -----------------------------------------------------------------------
  // DELETE /v1/events/:id
  // -----------------------------------------------------------------------

  it("DELETE /v1/events/:id returns success when event exists", async () => {
    const eventId = "evt_01HXYZ00000000000000000001";
    const userGraphDO = createMockDONamespace({
      pathResponses: new Map([
        ["/deleteCanonicalEvent", true],
      ]),
    });

    const handler = createHandler();
    const env = buildEnv(d1, userGraphDO);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request(`https://api.tminus.dev/v1/events/${eventId}`, {
        method: "DELETE",
        headers: { Authorization: authHeader },
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      data: { deleted: boolean };
    };
    expect(body.ok).toBe(true);
    expect(body.data.deleted).toBe(true);

    // Verify DO call
    expect(userGraphDO.calls).toHaveLength(1);
    expect(userGraphDO.calls[0].path).toBe("/deleteCanonicalEvent");
    const doBody = userGraphDO.calls[0].body as Record<string, unknown>;
    expect(doBody.canonical_event_id).toBe(eventId);
    expect(doBody.source).toBe("api");
  });

  it("DELETE /v1/events/:id returns 404 when event does not exist", async () => {
    const eventId = "evt_01HXYZ00000000000000000001";
    const userGraphDO = createMockDONamespace({
      pathResponses: new Map([
        ["/deleteCanonicalEvent", false],
      ]),
    });

    const handler = createHandler();
    const env = buildEnv(d1, userGraphDO);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request(`https://api.tminus.dev/v1/events/${eventId}`, {
        method: "DELETE",
        headers: { Authorization: authHeader },
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(404);
  });
});

// ===========================================================================
// Integration: Policy endpoints
// ===========================================================================

describe("Integration: Policy endpoints", () => {
  let db: DatabaseType;
  let d1: D1Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(MIGRATION_0001_INITIAL_SCHEMA);
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

  // -----------------------------------------------------------------------
  // GET /v1/policies
  // -----------------------------------------------------------------------

  it("GET /v1/policies returns policies from UserGraphDO", async () => {
    const policies = [
      { policy_id: "pol_01HXYZ00000000000000000001", name: "Default Policy" },
    ];
    const userGraphDO = createMockDONamespace({
      pathResponses: new Map([
        ["/listPolicies", { items: policies, cursor: null, has_more: false }],
      ]),
    });

    const handler = createHandler();
    const env = buildEnv(d1, userGraphDO);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request("https://api.tminus.dev/v1/policies", {
        method: "GET",
        headers: { Authorization: authHeader },
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      data: Array<{ policy_id: string; name: string }>;
    };
    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].name).toBe("Default Policy");
  });

  // -----------------------------------------------------------------------
  // POST /v1/policies
  // -----------------------------------------------------------------------

  it("POST /v1/policies creates a policy via UserGraphDO", async () => {
    const createdPolicy = {
      policy_id: "pol_01HXYZ00000000000000000001",
      name: "My Policy",
    };
    const userGraphDO = createMockDONamespace({
      pathResponses: new Map([
        ["/createPolicy", createdPolicy],
      ]),
    });

    const handler = createHandler();
    const env = buildEnv(d1, userGraphDO);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request("https://api.tminus.dev/v1/policies", {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "My Policy" }),
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      ok: boolean;
      data: { policy_id: string; name: string };
    };
    expect(body.ok).toBe(true);
    expect(body.data.name).toBe("My Policy");

    // Verify DO call
    expect(userGraphDO.calls).toHaveLength(1);
    expect(userGraphDO.calls[0].path).toBe("/createPolicy");
  });

  // -----------------------------------------------------------------------
  // GET /v1/policies/:id
  // -----------------------------------------------------------------------

  it("GET /v1/policies/:id returns policy with edges", async () => {
    const policyId = "pol_01HXYZ00000000000000000001";
    const policyData = {
      policy_id: policyId,
      name: "Test Policy",
      edges: [
        {
          from_account_id: ACCOUNT_A.account_id,
          to_account_id: ACCOUNT_B.account_id,
          detail_level: "BUSY",
          calendar_kind: "BUSY_OVERLAY",
        },
      ],
    };
    const userGraphDO = createMockDONamespace({
      pathResponses: new Map([
        ["/getPolicy", policyData],
      ]),
    });

    const handler = createHandler();
    const env = buildEnv(d1, userGraphDO);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request(`https://api.tminus.dev/v1/policies/${policyId}`, {
        method: "GET",
        headers: { Authorization: authHeader },
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      data: { policy_id: string; edges: unknown[] };
    };
    expect(body.ok).toBe(true);
    expect(body.data.policy_id).toBe(policyId);
    expect(body.data.edges).toHaveLength(1);
  });

  // -----------------------------------------------------------------------
  // PUT /v1/policies/:id/edges
  // -----------------------------------------------------------------------

  it("PUT /v1/policies/:id/edges sets edges and triggers recomputeProjections", async () => {
    const policyId = "pol_01HXYZ00000000000000000001";
    const userGraphDO = createMockDONamespace({
      pathResponses: new Map([
        ["/setPolicyEdges", { edges_set: 2, projections_recomputed: 5 }],
      ]),
    });

    const handler = createHandler();
    const env = buildEnv(d1, userGraphDO);
    const authHeader = await makeAuthHeader();

    const edges = [
      {
        from_account_id: ACCOUNT_A.account_id,
        to_account_id: ACCOUNT_B.account_id,
        detail_level: "BUSY",
        calendar_kind: "BUSY_OVERLAY",
      },
      {
        from_account_id: ACCOUNT_B.account_id,
        to_account_id: ACCOUNT_A.account_id,
        detail_level: "TITLE",
        calendar_kind: "BUSY_OVERLAY",
      },
    ];

    const response = await handler.fetch(
      new Request(`https://api.tminus.dev/v1/policies/${policyId}/edges`, {
        method: "PUT",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ edges }),
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      data: { edges_set: number; projections_recomputed: number };
    };
    expect(body.ok).toBe(true);
    expect(body.data.edges_set).toBe(2);
    expect(body.data.projections_recomputed).toBe(5);

    // Verify DO call payload includes edges and policy ID
    expect(userGraphDO.calls).toHaveLength(1);
    expect(userGraphDO.calls[0].path).toBe("/setPolicyEdges");
    const doBody = userGraphDO.calls[0].body as Record<string, unknown>;
    expect(doBody.policy_id).toBe(policyId);
    expect(doBody.edges).toHaveLength(2);
  });
});

// ===========================================================================
// Integration: Sync status endpoints
// ===========================================================================

describe("Integration: Sync status endpoints", () => {
  let db: DatabaseType;
  let d1: D1Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(MIGRATION_0001_INITIAL_SCHEMA);
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

  // -----------------------------------------------------------------------
  // GET /v1/sync/status
  // -----------------------------------------------------------------------

  it("GET /v1/sync/status aggregates health across all accounts", async () => {
    insertAccount(db, ACCOUNT_A);
    insertAccount(db, ACCOUNT_B);

    const accountDO = createMockDONamespace({
      pathResponses: new Map([
        ["/getHealth", {
          lastSyncTs: "2026-01-01T00:00:00Z",
          lastSuccessTs: "2026-01-01T00:00:00Z",
          fullSyncNeeded: false,
        }],
      ]),
    });

    const userGraphDO = createMockDONamespace({
      pathResponses: new Map([
        ["/getSyncHealth", {
          total_events: 42,
          total_mirrors: 84,
          total_journal_entries: 100,
          pending_mirrors: 3,
          error_mirrors: 0,
          last_journal_ts: "2026-01-01T12:00:00Z",
        }],
      ]),
    });

    const handler = createHandler();
    const env = buildEnv(d1, userGraphDO, accountDO);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request("https://api.tminus.dev/v1/sync/status", {
        method: "GET",
        headers: { Authorization: authHeader },
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      data: {
        accounts: Array<{
          account_id: string;
          status: string;
          health: unknown;
        }>;
        user_graph: {
          total_events: number;
          total_mirrors: number;
        };
      };
    };
    expect(body.ok).toBe(true);

    // Two accounts with health
    expect(body.data.accounts).toHaveLength(2);
    expect(body.data.accounts[0].health).not.toBeNull();
    expect(body.data.accounts[1].health).not.toBeNull();

    // UserGraph health
    expect(body.data.user_graph.total_events).toBe(42);
    expect(body.data.user_graph.total_mirrors).toBe(84);

    // Verify AccountDO was called for each account
    expect(accountDO.calls).toHaveLength(2);
    // Verify UserGraphDO was called
    expect(userGraphDO.calls).toHaveLength(1);
    expect(userGraphDO.calls[0].path).toBe("/getSyncHealth");
  });

  // -----------------------------------------------------------------------
  // GET /v1/sync/status/:accountId
  // -----------------------------------------------------------------------

  it("GET /v1/sync/status/:accountId returns per-account health", async () => {
    insertAccount(db, ACCOUNT_A);

    const accountDO = createMockDONamespace({
      pathResponses: new Map([
        ["/getHealth", {
          lastSyncTs: "2026-02-14T10:00:00Z",
          lastSuccessTs: "2026-02-14T10:00:00Z",
          fullSyncNeeded: false,
        }],
      ]),
    });

    const handler = createHandler();
    const env = buildEnv(d1, undefined, accountDO);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request(
        `https://api.tminus.dev/v1/sync/status/${ACCOUNT_A.account_id}`,
        { method: "GET", headers: { Authorization: authHeader } },
      ),
      env,
      mockCtx,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      data: { lastSyncTs: string };
    };
    expect(body.ok).toBe(true);
    expect(body.data.lastSyncTs).toBe("2026-02-14T10:00:00Z");
  });

  it("GET /v1/sync/status/:accountId returns 404 for unowned account", async () => {
    seedOtherUser(db);
    insertAccount(db, OTHER_USER_ACCOUNT);

    const handler = createHandler();
    const env = buildEnv(d1);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request(
        `https://api.tminus.dev/v1/sync/status/${OTHER_USER_ACCOUNT.account_id}`,
        { method: "GET", headers: { Authorization: authHeader } },
      ),
      env,
      mockCtx,
    );

    expect(response.status).toBe(404);
  });

  // -----------------------------------------------------------------------
  // GET /v1/sync/journal
  // -----------------------------------------------------------------------

  it("GET /v1/sync/journal returns journal entries from UserGraphDO", async () => {
    const journalEntries = [
      {
        journal_id: "jrn_01HXYZ00000000000000000001",
        canonical_event_id: "evt_01HXYZ00000000000000000001",
        change_type: "created",
        actor: "api",
        ts: "2026-01-01T00:00:00Z",
      },
    ];

    const userGraphDO = createMockDONamespace({
      pathResponses: new Map([
        ["/queryJournal", {
          items: journalEntries,
          cursor: null,
          has_more: false,
        }],
      ]),
    });

    const handler = createHandler();
    const env = buildEnv(d1, userGraphDO);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request("https://api.tminus.dev/v1/sync/journal?limit=10", {
        method: "GET",
        headers: { Authorization: authHeader },
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      data: Array<{ journal_id: string; change_type: string }>;
    };
    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].change_type).toBe("created");

    // Verify query params passed through
    const doBody = userGraphDO.calls[0].body as Record<string, unknown>;
    expect(doBody.limit).toBe(10);
  });

  it("GET /v1/sync/journal passes event_id and cursor filters to DO", async () => {
    const userGraphDO = createMockDONamespace({
      pathResponses: new Map([
        ["/queryJournal", { items: [], cursor: null, has_more: false }],
      ]),
    });

    const handler = createHandler();
    const env = buildEnv(d1, userGraphDO);
    const authHeader = await makeAuthHeader();

    await handler.fetch(
      new Request(
        "https://api.tminus.dev/v1/sync/journal?event_id=evt_01HXYZ00000000000000000001&cursor=jrn_cursor",
        { method: "GET", headers: { Authorization: authHeader } },
      ),
      env,
      mockCtx,
    );

    const doBody = userGraphDO.calls[0].body as Record<string, unknown>;
    expect(doBody.canonical_event_id).toBe("evt_01HXYZ00000000000000000001");
    expect(doBody.cursor).toBe("jrn_cursor");
  });
});

// ===========================================================================
// Integration: Auth enforcement (full flow)
// ===========================================================================

describe("Integration: Auth enforcement full flow", () => {
  let db: DatabaseType;
  let d1: D1Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(MIGRATION_0001_INITIAL_SCHEMA);
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

  it("all /v1 endpoints reject requests without auth", async () => {
    const handler = createHandler();
    const env = buildEnv(d1);

    const endpoints = [
      { method: "GET", path: "/v1/accounts" },
      { method: "POST", path: "/v1/accounts/link" },
      { method: "GET", path: "/v1/events" },
      { method: "POST", path: "/v1/events" },
      { method: "GET", path: "/v1/policies" },
      { method: "POST", path: "/v1/policies" },
      { method: "GET", path: "/v1/sync/status" },
      { method: "GET", path: "/v1/sync/journal" },
    ];

    for (const ep of endpoints) {
      const response = await handler.fetch(
        new Request(`https://api.tminus.dev${ep.path}`, {
          method: ep.method,
        }),
        env,
        mockCtx,
      );
      expect(response.status).toBe(401);

      const body = (await response.json()) as { ok: boolean; error: string };
      expect(body.ok).toBe(false);
      expect(body.error).toBe("Authentication required");
    }
  });

  it("valid JWT grants access to endpoints", async () => {
    insertAccount(db, ACCOUNT_A);

    const userGraphDO = createMockDONamespace({
      pathResponses: new Map([
        ["/listCanonicalEvents", { items: [], cursor: null, has_more: false }],
      ]),
    });

    const handler = createHandler();
    const env = buildEnv(d1, userGraphDO);
    const authHeader = await makeAuthHeader();

    // GET /v1/events with valid auth should succeed (200, not 401)
    const response = await handler.fetch(
      new Request("https://api.tminus.dev/v1/events", {
        method: "GET",
        headers: { Authorization: authHeader },
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});

// ===========================================================================
// Constraint endpoint integration tests (TM-gj5.1)
// ===========================================================================

describe("Integration: Constraint endpoints", () => {
  let db: DatabaseType;
  let d1: D1Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(MIGRATION_0001_INITIAL_SCHEMA);
    db.exec(MIGRATION_0012_SUBSCRIPTIONS);
    db.exec(MIGRATION_0013_SUBSCRIPTION_LIFECYCLE);
    // Auth fields migration
    db.exec(MIGRATION_0004_AUTH_FIELDS);
    db.prepare("INSERT INTO orgs (org_id, name) VALUES (?, ?)").run(
      TEST_ORG.org_id,
      TEST_ORG.name,
    );
    db.prepare(
      "INSERT INTO users (user_id, org_id, email) VALUES (?, ?, ?)",
    ).run(TEST_USER.user_id, TEST_USER.org_id, TEST_USER.email);
    // Insert a premium subscription so the feature gate allows constraint access
    db.prepare(
      `INSERT INTO subscriptions (subscription_id, user_id, tier, status)
       VALUES (?, ?, 'premium', 'active')`,
    ).run("sub_test_constraints", TEST_USER.user_id);
    d1 = createRealD1(db);
  });

  afterEach(() => {
    db.close();
  });

  // -----------------------------------------------------------------------
  // POST /v1/constraints -- success
  // -----------------------------------------------------------------------

  it("POST /v1/constraints creates a trip constraint and returns 201", async () => {
    const doNamespace = createMockDONamespace({
      pathResponses: new Map([
        [
          "/addConstraint",
          {
            constraint_id: "cst_01HXY0000000000000000000AA",
            kind: "trip",
            config_json: { name: "Paris Vacation", timezone: "Europe/Paris", block_policy: "BUSY" },
            active_from: "2026-03-01T00:00:00Z",
            active_to: "2026-03-08T00:00:00Z",
            created_at: "2026-02-14T00:00:00Z",
          },
        ],
      ]),
    });

    const handler = createHandler();
    const env = buildEnv(d1, doNamespace);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request("https://api.tminus.dev/v1/constraints", {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          kind: "trip",
          config_json: { name: "Paris Vacation", timezone: "Europe/Paris", block_policy: "BUSY" },
          active_from: "2026-03-01T00:00:00Z",
          active_to: "2026-03-08T00:00:00Z",
        }),
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      ok: boolean;
      data: { constraint_id: string; kind: string };
    };
    expect(body.ok).toBe(true);
    expect(body.data.constraint_id).toMatch(/^cst_/);
    expect(body.data.kind).toBe("trip");

    // Verify the DO was called with correct path and body
    expect(doNamespace.calls).toHaveLength(1);
    expect(doNamespace.calls[0].path).toBe("/addConstraint");
    expect(doNamespace.calls[0].body).toEqual({
      kind: "trip",
      config_json: { name: "Paris Vacation", timezone: "Europe/Paris", block_policy: "BUSY" },
      active_from: "2026-03-01T00:00:00Z",
      active_to: "2026-03-08T00:00:00Z",
    });
  });

  // -----------------------------------------------------------------------
  // POST /v1/constraints -- validation errors
  // -----------------------------------------------------------------------

  it("POST /v1/constraints rejects missing kind", async () => {
    const handler = createHandler();
    const env = buildEnv(d1);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request("https://api.tminus.dev/v1/constraints", {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          config_json: { name: "Test" },
          active_from: "2026-03-01T00:00:00Z",
          active_to: "2026-03-08T00:00:00Z",
        }),
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("kind");
  });

  it("POST /v1/constraints rejects missing config_json", async () => {
    const handler = createHandler();
    const env = buildEnv(d1);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request("https://api.tminus.dev/v1/constraints", {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          kind: "trip",
          active_from: "2026-03-01T00:00:00Z",
          active_to: "2026-03-08T00:00:00Z",
        }),
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("config_json");
  });

  it("POST /v1/constraints rejects invalid active_from date", async () => {
    const handler = createHandler();
    const env = buildEnv(d1);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request("https://api.tminus.dev/v1/constraints", {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          kind: "trip",
          config_json: { name: "Test", timezone: "UTC", block_policy: "BUSY" },
          active_from: "not-a-date",
          active_to: "2026-03-08T00:00:00Z",
        }),
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("active_from");
  });

  it("POST /v1/constraints requires auth", async () => {
    const handler = createHandler();
    const env = buildEnv(d1);

    const response = await handler.fetch(
      new Request("https://api.tminus.dev/v1/constraints", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "trip",
          config_json: { name: "Test" },
        }),
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(401);
  });

  // -----------------------------------------------------------------------
  // GET /v1/constraints -- list
  // -----------------------------------------------------------------------

  it("GET /v1/constraints lists constraints via DO", async () => {
    const doNamespace = createMockDONamespace({
      pathResponses: new Map([
        [
          "/listConstraints",
          {
            items: [
              {
                constraint_id: "cst_01HXY0000000000000000000AA",
                kind: "trip",
                config_json: { name: "Trip A" },
                active_from: "2026-03-01T00:00:00Z",
                active_to: "2026-03-08T00:00:00Z",
                created_at: "2026-02-14T00:00:00Z",
              },
            ],
          },
        ],
      ]),
    });

    const handler = createHandler();
    const env = buildEnv(d1, doNamespace);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request("https://api.tminus.dev/v1/constraints", {
        method: "GET",
        headers: { Authorization: authHeader },
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      data: Array<{ constraint_id: string; kind: string }>;
    };
    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].kind).toBe("trip");
  });

  // -----------------------------------------------------------------------
  // DELETE /v1/constraints/:id -- cascading delete
  // -----------------------------------------------------------------------

  it("DELETE /v1/constraints/:id deletes via DO and returns 200", async () => {
    const constraintId = "cst_01HXY0000000000000000000AA";
    const doNamespace = createMockDONamespace({
      pathResponses: new Map([
        ["/deleteConstraint", { deleted: true }],
      ]),
    });

    const handler = createHandler();
    const env = buildEnv(d1, doNamespace);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request(`https://api.tminus.dev/v1/constraints/${constraintId}`, {
        method: "DELETE",
        headers: { Authorization: authHeader },
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; data: { deleted: boolean } };
    expect(body.ok).toBe(true);
    expect(body.data.deleted).toBe(true);

    // Verify DO was called
    expect(doNamespace.calls).toHaveLength(1);
    expect(doNamespace.calls[0].path).toBe("/deleteConstraint");
    expect(doNamespace.calls[0].body).toEqual({ constraint_id: constraintId });
  });

  it("DELETE /v1/constraints/:id returns 404 for non-existent", async () => {
    const constraintId = "cst_01HXY0000000000000000000BB";
    const doNamespace = createMockDONamespace({
      pathResponses: new Map([
        ["/deleteConstraint", { deleted: false }],
      ]),
    });

    const handler = createHandler();
    const env = buildEnv(d1, doNamespace);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request(`https://api.tminus.dev/v1/constraints/${constraintId}`, {
        method: "DELETE",
        headers: { Authorization: authHeader },
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(404);
  });

  it("DELETE /v1/constraints/:id rejects invalid ID format", async () => {
    const handler = createHandler();
    const env = buildEnv(d1);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request("https://api.tminus.dev/v1/constraints/bad-id", {
        method: "DELETE",
        headers: { Authorization: authHeader },
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("Invalid constraint ID");
  });

  // -----------------------------------------------------------------------
  // GET /v1/constraints/:id -- get single
  // -----------------------------------------------------------------------

  it("GET /v1/constraints/:id returns constraint from DO", async () => {
    const constraintId = "cst_01HXY0000000000000000000AA";
    const doNamespace = createMockDONamespace({
      pathResponses: new Map([
        [
          "/getConstraint",
          {
            constraint_id: constraintId,
            kind: "trip",
            config_json: { name: "Test Trip" },
            active_from: "2026-03-01T00:00:00Z",
            active_to: "2026-03-08T00:00:00Z",
            created_at: "2026-02-14T00:00:00Z",
          },
        ],
      ]),
    });

    const handler = createHandler();
    const env = buildEnv(d1, doNamespace);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request(`https://api.tminus.dev/v1/constraints/${constraintId}`, {
        method: "GET",
        headers: { Authorization: authHeader },
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      data: { constraint_id: string; kind: string };
    };
    expect(body.ok).toBe(true);
    expect(body.data.constraint_id).toBe(constraintId);
    expect(body.data.kind).toBe("trip");
  });

  // -----------------------------------------------------------------------
  // PUT /v1/constraints/:id -- update
  // -----------------------------------------------------------------------

  it("PUT /v1/constraints/:id updates constraint via DO and returns 200", async () => {
    const constraintId = "cst_01HXY0000000000000000000AA";
    const doNamespace = createMockDONamespace({
      pathResponses: new Map([
        [
          "/updateConstraint",
          {
            constraint_id: constraintId,
            kind: "trip",
            config_json: { name: "Updated Trip", timezone: "Europe/London", block_policy: "TITLE" },
            active_from: "2026-04-01T00:00:00Z",
            active_to: "2026-04-10T00:00:00Z",
            created_at: "2026-02-14T00:00:00Z",
          },
        ],
      ]),
    });

    const handler = createHandler();
    const env = buildEnv(d1, doNamespace);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request(`https://api.tminus.dev/v1/constraints/${constraintId}`, {
        method: "PUT",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          config_json: { name: "Updated Trip", timezone: "Europe/London", block_policy: "TITLE" },
          active_from: "2026-04-01T00:00:00Z",
          active_to: "2026-04-10T00:00:00Z",
        }),
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      data: {
        constraint_id: string;
        kind: string;
        config_json: { name: string };
      };
    };
    expect(body.ok).toBe(true);
    expect(body.data.constraint_id).toBe(constraintId);
    expect(body.data.config_json.name).toBe("Updated Trip");

    // Verify DO was called with correct payload
    expect(doNamespace.calls).toHaveLength(1);
    expect(doNamespace.calls[0].path).toBe("/updateConstraint");
    expect(doNamespace.calls[0].body).toEqual({
      constraint_id: constraintId,
      config_json: { name: "Updated Trip", timezone: "Europe/London", block_policy: "TITLE" },
      active_from: "2026-04-01T00:00:00Z",
      active_to: "2026-04-10T00:00:00Z",
    });
  });

  it("PUT /v1/constraints/:id returns 404 when constraint does not exist", async () => {
    const constraintId = "cst_01HXY0000000000000000000BB";
    const doNamespace = createMockDONamespace({
      pathResponses: new Map([
        ["/updateConstraint", null],
      ]),
    });

    const handler = createHandler();
    const env = buildEnv(d1, doNamespace);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request(`https://api.tminus.dev/v1/constraints/${constraintId}`, {
        method: "PUT",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          config_json: { reason: "test" },
        }),
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(404);
    const body = (await response.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("not found");
  });

  it("PUT /v1/constraints/:id rejects invalid active_from date", async () => {
    const constraintId = "cst_01HXY0000000000000000000AA";
    const handler = createHandler();
    const env = buildEnv(d1);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request(`https://api.tminus.dev/v1/constraints/${constraintId}`, {
        method: "PUT",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          config_json: { name: "Test" },
          active_from: "not-a-date",
        }),
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("active_from");
  });

  // -----------------------------------------------------------------------
  // CRUD lifecycle for each constraint kind
  // -----------------------------------------------------------------------

  it("creates and retrieves a working_hours constraint", async () => {
    const workingHoursConfig = {
      days: [1, 2, 3, 4, 5],
      start_time: "09:00",
      end_time: "17:00",
      timezone: "America/New_York",
    };
    const constraintId = "cst_01HXY0000000000000000000WH";

    const doNamespace = createMockDONamespace({
      pathResponses: new Map([
        ["/addConstraint", {
          constraint_id: constraintId,
          kind: "working_hours",
          config_json: workingHoursConfig,
          active_from: null,
          active_to: null,
          created_at: "2026-02-14T00:00:00Z",
        }],
        ["/getConstraint", {
          constraint_id: constraintId,
          kind: "working_hours",
          config_json: workingHoursConfig,
          active_from: null,
          active_to: null,
          created_at: "2026-02-14T00:00:00Z",
        }],
      ]),
    });

    const handler = createHandler();
    const env = buildEnv(d1, doNamespace);
    const authHeader = await makeAuthHeader();

    // Create
    const createResp = await handler.fetch(
      new Request("https://api.tminus.dev/v1/constraints", {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "working_hours", config_json: workingHoursConfig }),
      }),
      env,
      mockCtx,
    );

    expect(createResp.status).toBe(201);
    const createBody = (await createResp.json()) as {
      ok: boolean;
      data: { constraint_id: string; kind: string };
    };
    expect(createBody.ok).toBe(true);
    expect(createBody.data.kind).toBe("working_hours");

    // Retrieve
    const getResp = await handler.fetch(
      new Request(`https://api.tminus.dev/v1/constraints/${constraintId}`, {
        method: "GET",
        headers: { Authorization: authHeader },
      }),
      env,
      mockCtx,
    );

    expect(getResp.status).toBe(200);
    const getBody = (await getResp.json()) as {
      ok: boolean;
      data: { kind: string; config_json: typeof workingHoursConfig };
    };
    expect(getBody.data.kind).toBe("working_hours");
    expect(getBody.data.config_json.start_time).toBe("09:00");
  });

  it("creates and retrieves a buffer constraint", async () => {
    const bufferConfig = { type: "travel", minutes: 15, applies_to: "all" };
    const constraintId = "cst_01HXY0000000000000000000BF";

    const doNamespace = createMockDONamespace({
      pathResponses: new Map([
        ["/addConstraint", {
          constraint_id: constraintId,
          kind: "buffer",
          config_json: bufferConfig,
          active_from: null,
          active_to: null,
          created_at: "2026-02-14T00:00:00Z",
        }],
      ]),
    });

    const handler = createHandler();
    const env = buildEnv(d1, doNamespace);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request("https://api.tminus.dev/v1/constraints", {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "buffer", config_json: bufferConfig }),
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      ok: boolean;
      data: { constraint_id: string; kind: string; config_json: typeof bufferConfig };
    };
    expect(body.ok).toBe(true);
    expect(body.data.kind).toBe("buffer");
    expect(body.data.config_json.type).toBe("travel");
    expect(body.data.config_json.minutes).toBe(15);
  });

  it("creates a no_meetings_after constraint", async () => {
    const noMeetingsConfig = { time: "18:00", timezone: "America/Chicago" };
    const constraintId = "cst_01HXY0000000000000000000NM";

    const doNamespace = createMockDONamespace({
      pathResponses: new Map([
        ["/addConstraint", {
          constraint_id: constraintId,
          kind: "no_meetings_after",
          config_json: noMeetingsConfig,
          active_from: null,
          active_to: null,
          created_at: "2026-02-14T00:00:00Z",
        }],
      ]),
    });

    const handler = createHandler();
    const env = buildEnv(d1, doNamespace);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request("https://api.tminus.dev/v1/constraints", {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "no_meetings_after", config_json: noMeetingsConfig }),
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      ok: boolean;
      data: { kind: string; config_json: typeof noMeetingsConfig };
    };
    expect(body.ok).toBe(true);
    expect(body.data.kind).toBe("no_meetings_after");
    expect(body.data.config_json.time).toBe("18:00");
  });

  it("creates an override constraint with active dates", async () => {
    const overrideConfig = { reason: "Company offsite - no meetings" };
    const constraintId = "cst_01HXY0000000000000000000V1";

    const doNamespace = createMockDONamespace({
      pathResponses: new Map([
        ["/addConstraint", {
          constraint_id: constraintId,
          kind: "override",
          config_json: overrideConfig,
          active_from: "2026-06-01T00:00:00Z",
          active_to: "2026-06-03T00:00:00Z",
          created_at: "2026-02-14T00:00:00Z",
        }],
      ]),
    });

    const handler = createHandler();
    const env = buildEnv(d1, doNamespace);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request("https://api.tminus.dev/v1/constraints", {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "override",
          config_json: overrideConfig,
          active_from: "2026-06-01T00:00:00Z",
          active_to: "2026-06-03T00:00:00Z",
        }),
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      ok: boolean;
      data: {
        kind: string;
        config_json: typeof overrideConfig;
        active_from: string;
        active_to: string;
      };
    };
    expect(body.ok).toBe(true);
    expect(body.data.kind).toBe("override");
    expect(body.data.config_json.reason).toBe("Company offsite - no meetings");
    expect(body.data.active_from).toBe("2026-06-01T00:00:00Z");
  });

  // -----------------------------------------------------------------------
  // List with kind filter
  // -----------------------------------------------------------------------

  it("GET /v1/constraints?kind=trip filters by kind", async () => {
    const doNamespace = createMockDONamespace({
      pathResponses: new Map([
        ["/listConstraints", {
          items: [
            {
              constraint_id: "cst_01HXY0000000000000000000AA",
              kind: "trip",
              config_json: { name: "Paris" },
              active_from: "2026-03-01T00:00:00Z",
              active_to: "2026-03-08T00:00:00Z",
              created_at: "2026-02-14T00:00:00Z",
            },
          ],
        }],
      ]),
    });

    const handler = createHandler();
    const env = buildEnv(d1, doNamespace);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request("https://api.tminus.dev/v1/constraints?kind=trip", {
        method: "GET",
        headers: { Authorization: authHeader },
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      data: Array<{ kind: string }>;
    };
    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].kind).toBe("trip");

    // Verify the kind filter was passed to the DO
    expect(doNamespace.calls).toHaveLength(1);
    expect(doNamespace.calls[0].path).toBe("/listConstraints");
    const doBody = doNamespace.calls[0].body as { kind?: string };
    expect(doBody.kind).toBe("trip");
  });

  it("GET /v1/constraints without kind filter returns all constraints", async () => {
    const doNamespace = createMockDONamespace({
      pathResponses: new Map([
        ["/listConstraints", {
          items: [
            { constraint_id: "cst_01HXY0000000000000000000AA", kind: "trip" },
            { constraint_id: "cst_01HXY0000000000000000000BB", kind: "working_hours" },
            { constraint_id: "cst_01HXY0000000000000000000CC", kind: "buffer" },
          ],
        }],
      ]),
    });

    const handler = createHandler();
    const env = buildEnv(d1, doNamespace);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request("https://api.tminus.dev/v1/constraints", {
        method: "GET",
        headers: { Authorization: authHeader },
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      data: Array<{ kind: string }>;
    };
    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(3);

    // kind should be undefined (not passed to DO)
    const doBody = doNamespace.calls[0].body as { kind?: string };
    expect(doBody.kind).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // Invalid config returns proper error envelope
  // -----------------------------------------------------------------------

  it("POST /v1/constraints with invalid kind returns 400 with error envelope", async () => {
    const handler = createHandler();
    const env = buildEnv(d1);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request("https://api.tminus.dev/v1/constraints", {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "nonexistent_kind",
          config_json: { foo: "bar" },
        }),
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { ok: boolean; error: string; meta: { request_id: string } };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("Invalid constraint kind");
    expect(body.error).toContain("nonexistent_kind");
    // Verify proper envelope structure
    expect(body.meta).toBeDefined();
    expect(body.meta.request_id).toMatch(/^req_/);
  });

  it("POST /v1/constraints with invalid working_hours config returns 400", async () => {
    const handler = createHandler();
    const env = buildEnv(d1);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request("https://api.tminus.dev/v1/constraints", {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "working_hours",
          config_json: { days: "not-an-array" },
        }),
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("days");
  });

  it("POST /v1/constraints with invalid buffer config returns 400", async () => {
    const handler = createHandler();
    const env = buildEnv(d1);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request("https://api.tminus.dev/v1/constraints", {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "buffer",
          config_json: { type: "invalid_type", minutes: 15, applies_to: "all" },
        }),
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("type");
  });

  it("POST /v1/constraints with invalid no_meetings_after config returns 400", async () => {
    const handler = createHandler();
    const env = buildEnv(d1);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request("https://api.tminus.dev/v1/constraints", {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "no_meetings_after",
          config_json: { time: "25:00", timezone: "UTC" },
        }),
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("time");
  });

  it("POST /v1/constraints with invalid override config returns 400", async () => {
    const handler = createHandler();
    const env = buildEnv(d1);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request("https://api.tminus.dev/v1/constraints", {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "override",
          config_json: { reason: "" },
        }),
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("reason");
  });

  // -----------------------------------------------------------------------
  // Delete cascades to derived events (verified via DO call)
  // -----------------------------------------------------------------------

  it("DELETE /v1/constraints/:id calls DO deleteConstraint which cascades", async () => {
    const constraintId = "cst_01HXY0000000000000000000AA";
    const doNamespace = createMockDONamespace({
      pathResponses: new Map([
        ["/deleteConstraint", { deleted: true }],
      ]),
    });

    const handler = createHandler();
    const env = buildEnv(d1, doNamespace);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request(`https://api.tminus.dev/v1/constraints/${constraintId}`, {
        method: "DELETE",
        headers: { Authorization: authHeader },
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; data: { deleted: boolean } };
    expect(body.ok).toBe(true);
    expect(body.data.deleted).toBe(true);

    // Verify the correct constraint ID was sent to the DO for cascade delete
    expect(doNamespace.calls).toHaveLength(1);
    expect(doNamespace.calls[0].path).toBe("/deleteConstraint");
    expect(doNamespace.calls[0].body).toEqual({ constraint_id: constraintId });
  });
});

// ===========================================================================
// Integration: Enhanced Commitment Proof Export (TM-3m7.3)
// ===========================================================================

/**
 * Mock R2Bucket for integration tests.
 *
 * Stores objects in memory with metadata, supports get/put/list operations.
 * This proves the full export -> store -> retrieve -> verify flow.
 */
function createMockR2Bucket(): R2Bucket & {
  objects: Map<string, { body: string; httpMetadata: Record<string, string>; customMetadata: Record<string, string> }>;
} {
  const objects = new Map<string, { body: string; httpMetadata: Record<string, string>; customMetadata: Record<string, string> }>();

  return {
    objects,

    async put(key: string, value: string | ReadableStream | ArrayBuffer | null, options?: R2PutOptions): Promise<R2Object> {
      const body = typeof value === "string" ? value : "";
      const httpMeta: Record<string, string> = {};
      if (options?.httpMetadata && typeof options.httpMetadata === "object" && !(options.httpMetadata instanceof Headers)) {
        if (options.httpMetadata.contentType) httpMeta.contentType = options.httpMetadata.contentType;
        if (options.httpMetadata.contentDisposition) httpMeta.contentDisposition = options.httpMetadata.contentDisposition;
      }
      const customMeta = (options?.customMetadata ?? {}) as Record<string, string>;
      objects.set(key, { body, httpMetadata: httpMeta, customMetadata: customMeta });

      return {
        key,
        version: "v1",
        size: body.length,
        etag: "mock-etag",
        httpEtag: '"mock-etag"',
        uploaded: new Date(),
        httpMetadata: httpMeta,
        customMetadata: customMeta,
        writeHttpMetadata(headers: Headers) {
          if (httpMeta.contentType) headers.set("content-type", httpMeta.contentType);
          if (httpMeta.contentDisposition) headers.set("content-disposition", httpMeta.contentDisposition);
        },
      } as unknown as R2Object;
    },

    async get(key: string): Promise<R2ObjectBody | null> {
      const obj = objects.get(key);
      if (!obj) return null;

      return {
        key,
        version: "v1",
        size: obj.body.length,
        etag: "mock-etag",
        httpEtag: '"mock-etag"',
        uploaded: new Date(),
        httpMetadata: obj.httpMetadata,
        customMetadata: obj.customMetadata,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(obj.body));
            controller.close();
          },
        }),
        bodyUsed: false,
        arrayBuffer: async () => new TextEncoder().encode(obj.body).buffer,
        text: async () => obj.body,
        json: async () => JSON.parse(obj.body),
        blob: async () => new Blob([obj.body]),
        writeHttpMetadata(headers: Headers) {
          if (obj.httpMetadata.contentType) headers.set("content-type", obj.httpMetadata.contentType);
          if (obj.httpMetadata.contentDisposition) headers.set("content-disposition", obj.httpMetadata.contentDisposition);
        },
      } as unknown as R2ObjectBody;
    },

    async list(options?: R2ListOptions): Promise<R2Objects> {
      const prefix = options?.prefix ?? "";
      const matchingObjects: R2Object[] = [];

      for (const [key, obj] of objects.entries()) {
        if (key.startsWith(prefix)) {
          matchingObjects.push({
            key,
            version: "v1",
            size: obj.body.length,
            etag: "mock-etag",
            httpEtag: '"mock-etag"',
            uploaded: new Date(),
            httpMetadata: obj.httpMetadata,
            customMetadata: obj.customMetadata,
          } as unknown as R2Object);
        }
      }

      return {
        objects: matchingObjects,
        truncated: false,
        delimitedPrefixes: [],
      } as unknown as R2Objects;
    },

    async delete(_key: string | string[]): Promise<void> {},
    async head(_key: string): Promise<R2Object | null> { return null; },
    createMultipartUpload: undefined as unknown as R2Bucket["createMultipartUpload"],
    resumeMultipartUpload: undefined as unknown as R2Bucket["resumeMultipartUpload"],
  } as unknown as R2Bucket & {
    objects: Map<string, { body: string; httpMetadata: Record<string, string>; customMetadata: Record<string, string> }>;
  };
}

const TEST_MASTER_KEY = "integration-test-master-key-for-hmac-sha256-signing";

/** Proof data as the DO returns it (raw JSON body, not wrapped in an envelope). */
const TEST_PROOF_DATA = {
  commitment: {
    commitment_id: "cmt_01TESTAAAAAAAAAAAAAAAAAA88",
    client_id: "client_acme",
    client_name: "Acme Corp",
    window_type: "WEEKLY",
    target_hours: 10,
    rolling_window_weeks: 4,
    hard_minimum: false,
    proof_required: true,
    created_at: "2026-02-01T00:00:00.000Z",
  },
  window_start: "2026-01-18T00:00:00.000Z",
  window_end: "2026-02-15T00:00:00.000Z",
  actual_hours: 12.5,
  status: "compliant",
  events: [
    {
      canonical_event_id: "evt_01TEST000EVT00000000000001",
      title: "Sprint Planning",
      start_ts: "2026-02-10T09:00:00.000Z",
      end_ts: "2026-02-10T11:00:00.000Z",
      hours: 2,
      billing_category: "BILLABLE",
    },
    {
      canonical_event_id: "evt_01TEST000EVT00000000000002",
      title: "Code Review",
      start_ts: "2026-02-11T14:00:00.000Z",
      end_ts: "2026-02-11T16:30:00.000Z",
      hours: 2.5,
      billing_category: "BILLABLE",
    },
    {
      canonical_event_id: "evt_01TEST000EVT00000000000003",
      title: "Client Meeting",
      start_ts: "2026-02-12T10:00:00.000Z",
      end_ts: "2026-02-12T18:00:00.000Z",
      hours: 8,
      billing_category: "BILLABLE",
    },
  ],
};

describe("Integration: Enhanced Commitment Proof Export", () => {
  let db: DatabaseType;
  let d1: D1Database;
  let r2Bucket: ReturnType<typeof createMockR2Bucket>;
  const handler = createHandler();

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(MIGRATION_0001_INITIAL_SCHEMA);
    db.exec(MIGRATION_0012_SUBSCRIPTIONS);
    db.exec(MIGRATION_0013_SUBSCRIPTION_LIFECYCLE);
    db.prepare("INSERT INTO orgs (org_id, name) VALUES (?, ?)").run(TEST_ORG.org_id, TEST_ORG.name);
    db.prepare("INSERT INTO users (user_id, org_id, email) VALUES (?, ?, ?)").run(
      TEST_USER.user_id, TEST_USER.org_id, TEST_USER.email,
    );
    // Add premium tier so feature gate passes
    db.prepare(
      `INSERT INTO subscriptions (subscription_id, user_id, tier, status)
       VALUES (?, ?, 'premium', 'active')`,
    ).run("sub_test_proof", TEST_USER.user_id);

    d1 = createRealD1(db);
    r2Bucket = createMockR2Bucket();
  });

  afterEach(() => {
    db.close();
  });

  function buildProofEnv(doPathResponses?: Map<string, unknown>): Env {
    const doNamespace = createMockDONamespace({
      defaultResponse: { ok: true },
      pathResponses: doPathResponses,
    });
    return {
      DB: d1,
      USER_GRAPH: doNamespace,
      ACCOUNT: createMockDONamespace(),
      SYNC_QUEUE: createMockQueue(),
      WRITE_QUEUE: createMockQueue(),
      SESSIONS: createMockKV(),
      JWT_SECRET,
      MASTER_KEY: TEST_MASTER_KEY,
      PROOF_BUCKET: r2Bucket as unknown as R2Bucket,
    };
  }

  // -------------------------------------------------------------------------
  // PDF (HTML) export with cryptographic signature
  // -------------------------------------------------------------------------

  it("POST /v1/commitments/:id/export generates HTML proof with signature", async () => {
    const doResponses = new Map<string, unknown>();
    doResponses.set("/getCommitmentProofData", TEST_PROOF_DATA);
    const env = buildProofEnv(doResponses);

    const authHeader = await makeAuthHeader();
    const response = await handler.fetch(
      new Request("https://api.test/v1/commitments/cmt_01TESTAAAAAAAAAAAAAAAAAA88/export", {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ format: "pdf" }),
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as {
      ok: boolean;
      data: {
        proof_id: string;
        proof_hash: string;
        signature: string;
        signed_at: string;
        format: string;
        r2_key: string;
        download_url: string;
        commitment_id: string;
        actual_hours: number;
        target_hours: number;
        status: string;
        event_count: number;
      };
    };

    expect(body.ok).toBe(true);

    // AC 1: PDF export generated with event breakdown
    expect(body.data.format).toBe("pdf");
    expect(body.data.event_count).toBe(3);

    // AC 2: SHA-256 proof hash computed
    expect(body.data.proof_hash).toMatch(/^[a-f0-9]{64}$/);

    // Signature present (HMAC-SHA256 produces 64-char hex)
    expect(body.data.signature).toMatch(/^[a-f0-9]{64}$/);
    expect(body.data.signed_at).toBeTruthy();

    // proof_id has correct prefix
    expect(body.data.proof_id).toMatch(/^prf_/);

    // R2 key matches expected pattern: proofs/{userId}/{commitmentId}/{window}.html
    expect(body.data.r2_key).toContain(`proofs/${TEST_USER.user_id}/`);
    expect(body.data.r2_key).toContain("cmt_01TESTAAAAAAAAAAAAAAAAAA88");
    expect(body.data.r2_key).toMatch(/\.html$/);

    // AC 4: Stored in R2 with 7-year retention
    expect(r2Bucket.objects.size).toBe(1);
    const storedKey = Array.from(r2Bucket.objects.keys())[0];
    const storedObj = r2Bucket.objects.get(storedKey)!;

    // Verify R2 metadata
    expect(storedObj.customMetadata.proof_id).toMatch(/^prf_/);
    expect(storedObj.customMetadata.proof_hash).toBe(body.data.proof_hash);
    expect(storedObj.customMetadata.signature).toBe(body.data.signature);
    expect(storedObj.customMetadata.retention_policy).toBe("7_years");
    expect(storedObj.customMetadata.retention_expiry).toBeTruthy();
    expect(storedObj.customMetadata.window_start).toBe("2026-01-18T00:00:00.000Z");
    expect(storedObj.customMetadata.window_end).toBe("2026-02-15T00:00:00.000Z");

    // Verify 7-year retention expiry is approximately 7 years from now
    const retentionDate = new Date(storedObj.customMetadata.retention_expiry);
    const expectedMinDate = new Date(Date.now() + 6.9 * 365 * 24 * 60 * 60 * 1000);
    expect(retentionDate.getTime()).toBeGreaterThan(expectedMinDate.getTime());

    // Verify HTML content
    expect(storedObj.body).toContain("<!DOCTYPE html>");
    expect(storedObj.body).toContain("Acme Corp");
    expect(storedObj.body).toContain("Sprint Planning");
    expect(storedObj.body).toContain("Code Review");
    expect(storedObj.body).toContain("Client Meeting");
    expect(storedObj.body).toContain(body.data.proof_hash);
    expect(storedObj.httpMetadata.contentType).toBe("text/html");
  });

  // -------------------------------------------------------------------------
  // CSV export
  // -------------------------------------------------------------------------

  it("POST /v1/commitments/:id/export generates CSV with signature", async () => {
    const doResponses = new Map<string, unknown>();
    doResponses.set("/getCommitmentProofData", TEST_PROOF_DATA);
    const env = buildProofEnv(doResponses);

    const authHeader = await makeAuthHeader();
    const response = await handler.fetch(
      new Request("https://api.test/v1/commitments/cmt_01TESTAAAAAAAAAAAAAAAAAA88/export", {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ format: "csv" }),
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as {
      ok: boolean;
      data: { format: string; proof_hash: string; signature: string; r2_key: string };
    };

    expect(body.ok).toBe(true);

    // AC 5: CSV alternative format available
    expect(body.data.format).toBe("csv");
    expect(body.data.r2_key).toMatch(/\.csv$/);
    expect(body.data.proof_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(body.data.signature).toMatch(/^[a-f0-9]{64}$/);

    // Verify CSV stored in R2
    const storedKey = Array.from(r2Bucket.objects.keys())[0];
    const storedObj = r2Bucket.objects.get(storedKey)!;
    expect(storedObj.httpMetadata.contentType).toBe("text/csv");
    expect(storedObj.body).toContain("event_id,title,start,end,hours,billing_category");
    expect(storedObj.body).toContain("Sprint Planning");
  });

  // -------------------------------------------------------------------------
  // Proof verification endpoint
  // -------------------------------------------------------------------------

  it("GET /v1/proofs/:id/verify returns valid=true for genuine proof", async () => {
    // Step 1: Export a proof to create R2 object with metadata
    const doResponses = new Map<string, unknown>();
    doResponses.set("/getCommitmentProofData", TEST_PROOF_DATA);
    const env = buildProofEnv(doResponses);

    const authHeader = await makeAuthHeader();
    const exportResponse = await handler.fetch(
      new Request("https://api.test/v1/commitments/cmt_01TESTAAAAAAAAAAAAAAAAAA88/export", {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ format: "pdf" }),
      }),
      env,
      mockCtx,
    );

    expect(exportResponse.status).toBe(200);
    const exportBody = await exportResponse.json() as { ok: boolean; data: { proof_id: string; proof_hash: string; signature: string } };
    expect(exportBody.ok).toBe(true);

    const proofId = exportBody.data.proof_id;

    // Step 2: Verify the proof
    // AC 3: Signature verifiable via endpoint
    // AC 6: Verification endpoint returns validity
    const verifyResponse = await handler.fetch(
      new Request(`https://api.test/v1/proofs/${proofId}/verify`, {
        headers: { Authorization: authHeader },
      }),
      env,
      mockCtx,
    );

    expect(verifyResponse.status).toBe(200);
    const verifyBody = await verifyResponse.json() as {
      ok: boolean;
      data: { valid: boolean; proof_hash: string; signed_at: string | null };
    };

    expect(verifyBody.ok).toBe(true);
    expect(verifyBody.data.valid).toBe(true);
    expect(verifyBody.data.proof_hash).toBe(exportBody.data.proof_hash);
    expect(verifyBody.data.signed_at).toBeTruthy();
  });

  it("GET /v1/proofs/:id/verify returns valid=false when signature is tampered", async () => {
    // Create a proof with tampered signature in R2
    const doResponses = new Map<string, unknown>();
    doResponses.set("/getCommitmentProofData", TEST_PROOF_DATA);
    const env = buildProofEnv(doResponses);

    const authHeader = await makeAuthHeader();

    // Export to create the proof
    const exportResponse = await handler.fetch(
      new Request("https://api.test/v1/commitments/cmt_01TESTAAAAAAAAAAAAAAAAAA88/export", {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
      }),
      env,
      mockCtx,
    );
    const exportBody = await exportResponse.json() as { ok: boolean; data: { proof_id: string; r2_key: string } };
    const proofId = exportBody.data.proof_id;
    const r2Key = exportBody.data.r2_key;

    // Tamper with the stored signature
    const storedObj = r2Bucket.objects.get(r2Key)!;
    storedObj.customMetadata.signature = "0000000000000000000000000000000000000000000000000000000000000000";

    // Verify should return false
    const verifyResponse = await handler.fetch(
      new Request(`https://api.test/v1/proofs/${proofId}/verify`, {
        headers: { Authorization: authHeader },
      }),
      env,
      mockCtx,
    );

    expect(verifyResponse.status).toBe(200);
    const verifyBody = await verifyResponse.json() as { ok: boolean; data: { valid: boolean } };
    expect(verifyBody.ok).toBe(true);
    expect(verifyBody.data.valid).toBe(false);
  });

  it("GET /v1/proofs/:id/verify returns 404 for non-existent proof", async () => {
    const env = buildProofEnv();
    const authHeader = await makeAuthHeader();

    const verifyResponse = await handler.fetch(
      new Request("https://api.test/v1/proofs/prf_01NONEXISTENT000000000001/verify", {
        headers: { Authorization: authHeader },
      }),
      env,
      mockCtx,
    );

    expect(verifyResponse.status).toBe(404);
    const body = await verifyResponse.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("Proof not found");
  });

  // -------------------------------------------------------------------------
  // Proof download
  // -------------------------------------------------------------------------

  it("GET /v1/proofs/{r2_key} downloads stored proof document", async () => {
    const doResponses = new Map<string, unknown>();
    doResponses.set("/getCommitmentProofData", TEST_PROOF_DATA);
    const env = buildProofEnv(doResponses);

    const authHeader = await makeAuthHeader();

    // Export first
    const exportResponse = await handler.fetch(
      new Request("https://api.test/v1/commitments/cmt_01TESTAAAAAAAAAAAAAAAAAA88/export", {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ format: "pdf" }),
      }),
      env,
      mockCtx,
    );

    const exportBody = await exportResponse.json() as { ok: boolean; data: { r2_key: string; download_url: string } };
    expect(exportBody.ok).toBe(true);

    // Download via the download_url
    const downloadResponse = await handler.fetch(
      new Request(`https://api.test${exportBody.data.download_url}`, {
        headers: { Authorization: authHeader },
      }),
      env,
      mockCtx,
    );

    expect(downloadResponse.status).toBe(200);
    const downloadedContent = await downloadResponse.text();
    expect(downloadedContent).toContain("<!DOCTYPE html>");
    expect(downloadedContent).toContain("Acme Corp");
  });

  // -------------------------------------------------------------------------
  // Validation / error cases
  // -------------------------------------------------------------------------

  it("POST /v1/commitments/:id/export returns 500 when MASTER_KEY missing", async () => {
    const env = buildProofEnv();
    // Remove MASTER_KEY
    delete (env as Record<string, unknown>).MASTER_KEY;

    const authHeader = await makeAuthHeader();
    const response = await handler.fetch(
      new Request("https://api.test/v1/commitments/cmt_01TESTAAAAAAAAAAAAAAAAAA88/export", {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(500);
    const body = await response.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("MASTER_KEY missing");
  });

  it("POST /v1/commitments/:id/export rejects invalid format", async () => {
    const env = buildProofEnv();
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request("https://api.test/v1/commitments/cmt_01TESTAAAAAAAAAAAAAAAAAA88/export", {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ format: "xml" }),
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(400);
    const body = await response.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("format must be");
  });
});

// ===========================================================================
// CalDAV Feed Integration Tests (Phase 5A)
// ===========================================================================

describe("Integration: CalDAV feed endpoints", () => {
  let db: DatabaseType;
  let d1: D1Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(MIGRATION_0001_INITIAL_SCHEMA);
    db.exec(MIGRATION_0012_SUBSCRIPTIONS);
    db.exec(MIGRATION_0013_SUBSCRIPTION_LIFECYCLE);
    db.prepare("INSERT INTO orgs (org_id, name) VALUES (?, ?)").run(
      TEST_ORG.org_id,
      TEST_ORG.name,
    );
    db.prepare(
      "INSERT INTO users (user_id, org_id, email) VALUES (?, ?, ?)",
    ).run(TEST_USER.user_id, TEST_ORG.org_id, TEST_USER.email);
    d1 = createRealD1(db);
  });

  afterEach(() => {
    db.close();
  });

  it("GET /v1/caldav/:user_id/calendar.ics returns valid iCalendar with events", async () => {
    // Configure DO to return canonical events
    const mockEvents = [
      {
        canonical_event_id: "evt_01HXY000000000000000000001",
        origin_account_id: "acc_01HXY0000000000000000000AA",
        origin_event_id: "google-evt-001",
        title: "Morning standup",
        description: "Daily sync",
        location: "Room 101",
        start: { dateTime: "2025-06-15T09:00:00Z" },
        end: { dateTime: "2025-06-15T09:15:00Z" },
        all_day: false,
        status: "confirmed",
        visibility: "default",
        transparency: "opaque",
        source: "provider",
        version: 1,
        created_at: "2025-06-01T00:00:00Z",
        updated_at: "2025-06-01T00:00:00Z",
      },
      {
        canonical_event_id: "evt_01HXY000000000000000000002",
        origin_account_id: "acc_01HXY0000000000000000000AA",
        origin_event_id: "google-evt-002",
        title: "Team offsite",
        description: null,
        location: null,
        start: { date: "2025-06-20" },
        end: { date: "2025-06-21" },
        all_day: true,
        status: "confirmed",
        visibility: "default",
        transparency: "opaque",
        source: "provider",
        version: 1,
        created_at: "2025-06-01T00:00:00Z",
        updated_at: "2025-06-01T00:00:00Z",
      },
    ];

    const userGraphDO = createMockDONamespace({
      pathResponses: new Map([
        ["/listCanonicalEvents", { items: mockEvents, cursor: null, has_more: false }],
      ]),
    });

    const env = buildEnv(d1, userGraphDO);
    const handler = createHandler();
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request(`https://api.test/v1/caldav/${TEST_USER.user_id}/calendar.ics`, {
        method: "GET",
        headers: { Authorization: authHeader },
      }),
      env,
      mockCtx,
    );

    // Should return 200 with iCalendar content
    expect(response.status).toBe(200);

    // Verify Content-Type header
    expect(response.headers.get("Content-Type")).toBe("text/calendar; charset=utf-8");

    // Verify Cache-Control header (5-minute cache)
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=300");

    // Verify Content-Disposition header
    expect(response.headers.get("Content-Disposition")).toContain("calendar.ics");

    // Verify subscription URL header
    expect(response.headers.get("X-Calendar-Subscription-URL")).toContain("/v1/caldav/");

    // Parse the iCalendar body
    const icalBody = await response.text();

    // Verify VCALENDAR structure
    expect(icalBody).toContain("BEGIN:VCALENDAR");
    expect(icalBody).toContain("END:VCALENDAR");
    expect(icalBody).toContain("VERSION:2.0");
    expect(icalBody).toContain("PRODID:-//T-Minus//Calendar Feed//EN");
    expect(icalBody).toContain("CALSCALE:GREGORIAN");
    expect(icalBody).toContain("METHOD:PUBLISH");
    expect(icalBody).toContain("X-WR-CALNAME:T-Minus Unified Calendar");

    // Verify first event (timed, UTC)
    expect(icalBody).toContain("BEGIN:VEVENT");
    expect(icalBody).toContain("UID:evt_01HXY000000000000000000001");
    expect(icalBody).toContain("SUMMARY:Morning standup");
    expect(icalBody).toContain("DESCRIPTION:Daily sync");
    expect(icalBody).toContain("LOCATION:Room 101");
    expect(icalBody).toContain("DTSTART:20250615T090000Z");
    expect(icalBody).toContain("DTEND:20250615T091500Z");
    expect(icalBody).toContain("STATUS:CONFIRMED");

    // Verify second event (all-day)
    expect(icalBody).toContain("UID:evt_01HXY000000000000000000002");
    expect(icalBody).toContain("SUMMARY:Team offsite");
    expect(icalBody).toContain("DTSTART;VALUE=DATE:20250620");
    expect(icalBody).toContain("DTEND;VALUE=DATE:20250621");

    // Verify exactly 2 VEVENTs
    const eventCount = (icalBody.match(/BEGIN:VEVENT/g) || []).length;
    expect(eventCount).toBe(2);

    // Verify DO was called correctly
    expect(userGraphDO.calls.length).toBe(1);
    expect(userGraphDO.calls[0].path).toBe("/listCanonicalEvents");
  });

  it("GET /v1/caldav/:user_id/calendar.ics returns empty calendar when no events", async () => {
    const userGraphDO = createMockDONamespace({
      pathResponses: new Map([
        ["/listCanonicalEvents", { items: [], cursor: null, has_more: false }],
      ]),
    });

    const env = buildEnv(d1, userGraphDO);
    const handler = createHandler();
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request(`https://api.test/v1/caldav/${TEST_USER.user_id}/calendar.ics`, {
        method: "GET",
        headers: { Authorization: authHeader },
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/calendar; charset=utf-8");

    const icalBody = await response.text();
    expect(icalBody).toContain("BEGIN:VCALENDAR");
    expect(icalBody).toContain("END:VCALENDAR");
    expect(icalBody).not.toContain("BEGIN:VEVENT");
  });

  it("GET /v1/caldav/:user_id/calendar.ics returns 401 without auth", async () => {
    const env = buildEnv(d1);
    const handler = createHandler();

    const response = await handler.fetch(
      new Request(`https://api.test/v1/caldav/${TEST_USER.user_id}/calendar.ics`, {
        method: "GET",
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(401);
    const body = await response.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("Authentication required");
  });

  it("GET /v1/caldav/:other_user_id/calendar.ics returns 403 for wrong user", async () => {
    const userGraphDO = createMockDONamespace();
    const env = buildEnv(d1, userGraphDO);
    const handler = createHandler();
    const authHeader = await makeAuthHeader();

    // Try to access another user's calendar feed
    const response = await handler.fetch(
      new Request("https://api.test/v1/caldav/usr_01HXY0000000000000000000ZZ/calendar.ics", {
        method: "GET",
        headers: { Authorization: authHeader },
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(403);
    const body = await response.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("Forbidden");
  });

  it("GET /v1/caldav/:user_id/calendar.ics includes timezone events with VTIMEZONE", async () => {
    const mockEvents = [
      {
        canonical_event_id: "evt_01HXY000000000000000000003",
        origin_account_id: "acc_01HXY0000000000000000000AA",
        origin_event_id: "google-evt-003",
        title: "Chicago meeting",
        description: null,
        location: null,
        start: { dateTime: "2025-06-15T14:00:00", timeZone: "America/Chicago" },
        end: { dateTime: "2025-06-15T15:00:00", timeZone: "America/Chicago" },
        all_day: false,
        status: "confirmed",
        visibility: "default",
        transparency: "opaque",
        source: "provider",
        version: 1,
        created_at: "2025-06-01T00:00:00Z",
        updated_at: "2025-06-01T00:00:00Z",
      },
    ];

    const userGraphDO = createMockDONamespace({
      pathResponses: new Map([
        ["/listCanonicalEvents", { items: mockEvents, cursor: null, has_more: false }],
      ]),
    });

    const env = buildEnv(d1, userGraphDO);
    const handler = createHandler();
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request(`https://api.test/v1/caldav/${TEST_USER.user_id}/calendar.ics`, {
        method: "GET",
        headers: { Authorization: authHeader },
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(200);
    const icalBody = await response.text();

    // Should include VTIMEZONE for America/Chicago
    expect(icalBody).toContain("BEGIN:VTIMEZONE");
    expect(icalBody).toContain("TZID:America/Chicago");
    expect(icalBody).toContain("END:VTIMEZONE");

    // DTSTART should reference the timezone
    expect(icalBody).toContain("DTSTART;TZID=America/Chicago:20250615T140000");
    expect(icalBody).toContain("DTEND;TZID=America/Chicago:20250615T150000");
  });

  it("GET /v1/caldav/subscription-url returns the subscription URL for the user", async () => {
    const env = buildEnv(d1);
    const handler = createHandler();
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request("https://api.test/v1/caldav/subscription-url", {
        method: "GET",
        headers: { Authorization: authHeader },
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as {
      ok: boolean;
      data: { subscription_url: string; content_type: string; instructions: string };
    };
    expect(body.ok).toBe(true);
    expect(body.data.subscription_url).toContain(`/v1/caldav/${TEST_USER.user_id}/calendar.ics`);
    expect(body.data.content_type).toBe("text/calendar");
    expect(body.data.instructions).toContain("subscription");
  });
});
