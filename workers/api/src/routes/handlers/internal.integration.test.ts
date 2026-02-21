/**
 * Integration tests for the internal/admin route handler.
 *
 * Uses better-sqlite3 for a REAL D1 database with the actual accounts schema.
 * AccountDO is a mock (external service boundary) that captures calls.
 * GoogleCalendarClient is mocked (external API boundary).
 *
 * These tests prove:
 * 1. Real SQL queries against the accounts table work correctly
 * 2. The full request flow: admin auth -> D1 lookup -> DO call -> D1 update -> response
 * 3. Channel renewal updates D1 with new channel info
 * 4. Error paths (non-Google, inactive, missing account) are handled correctly
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import {
  MIGRATION_0001_INITIAL_SCHEMA,
  MIGRATION_0002_MS_SUBSCRIPTIONS,
  MIGRATION_0008_SYNC_STATUS_COLUMNS,
  MIGRATION_0027_WEBHOOK_SCOPE_ROUTING,
} from "@tminus/d1-registry";
import { createHandler } from "../../index";

// ---------------------------------------------------------------------------
// Mock GoogleCalendarClient and generateId (external API boundary)
//
// IMPORTANT: channel-renewal.ts (inside @tminus/shared) imports
// GoogleCalendarClient from "./google-api" and generateId from "./id"
// using RELATIVE paths. Mocking "@tminus/shared" only intercepts imports
// that go through the package barrel (index.ts). To intercept the relative
// imports used by channel-renewal.ts, we must also mock the individual
// source modules that it imports from.
//
// vi.mock() calls are hoisted to the top of the file by vitest's transform,
// so we use vi.hoisted() to declare shared state that the mock factories
// can reference safely.
// ---------------------------------------------------------------------------

const {
  MOCK_WATCH_EXPIRATION,
  googleApiCalls,
  mockGoogleCalendarClient,
  mockGenerateId,
} = vi.hoisted(() => {
  const MOCK_WATCH_EXPIRATION = String(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const googleApiCalls: Array<{ method: string; args: unknown[] }> = [];

  const mockGoogleCalendarClient = vi.fn().mockImplementation(() => ({
    stopChannel: vi.fn(async (...args: unknown[]) => {
      googleApiCalls.push({ method: "stopChannel", args });
    }),
    watchEvents: vi.fn(async (...args: unknown[]) => {
      googleApiCalls.push({ method: "watchEvents", args });
      return {
        channelId: "renewed-channel-xyz",
        resourceId: "renewed-resource-abc",
        expiration: MOCK_WATCH_EXPIRATION,
      };
    }),
  }));

  const mockGenerateId = vi.fn((prefix: string) => `${prefix}_mock_${Date.now()}`);

  return { MOCK_WATCH_EXPIRATION, googleApiCalls, mockGoogleCalendarClient, mockGenerateId };
});

// Mock the barrel re-export (used by direct imports from @tminus/shared)
vi.mock("@tminus/shared", async () => {
  const actual = await vi.importActual("@tminus/shared");
  return {
    ...actual,
    GoogleCalendarClient: mockGoogleCalendarClient,
    generateId: mockGenerateId,
  };
});

// Mock the direct source modules (used by channel-renewal.ts -> ./google-api, ./id).
// channel-renewal.ts uses relative imports that resolve to these files,
// bypassing the @tminus/shared barrel mock.
vi.mock("../../../../../packages/shared/src/google-api", async () => {
  const actual = await vi.importActual("../../../../../packages/shared/src/google-api");
  return {
    ...actual,
    GoogleCalendarClient: mockGoogleCalendarClient,
  };
});

vi.mock("../../../../../packages/shared/src/id", async () => {
  const actual = await vi.importActual("../../../../../packages/shared/src/id");
  return {
    ...actual,
    generateId: mockGenerateId,
  };
});

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const ADMIN_KEY = "integration-test-admin-key-32chars-min";
const JWT_SECRET = "integration-test-jwt-secret-32chars-min";
const WEBHOOK_URL = "https://webhooks.tminus.ink/webhook/google";

const TEST_ORG = {
  org_id: "org_01HXY000000000000000000001",
  name: "Internal Test Org",
} as const;

const TEST_USER = {
  user_id: "usr_01HXY000000000000000000001",
  email: "internal-test@example.com",
} as const;

const GOOGLE_ACCOUNT_WITH_CHANNEL = {
  account_id: "acc_01HXY000000000000000INTGGL",
  user_id: TEST_USER.user_id,
  provider: "google",
  provider_subject: "google-sub-int-ggl",
  email: "test-google@gmail.com",
  status: "active",
  channel_id: "old-channel-before-renewal",
  channel_token: "old-token-before-renewal",
  channel_expiry_ts: new Date(Date.now() - 3600000).toISOString(), // expired 1h ago
  resource_id: "old-resource-before-renewal",
} as const;

const GOOGLE_ACCOUNT_NO_CHANNEL = {
  account_id: "acc_01HXY000000000000000INTNCH",
  user_id: TEST_USER.user_id,
  provider: "google",
  provider_subject: "google-sub-int-nch",
  email: "test-google-nch@gmail.com",
  status: "active",
  channel_id: null as string | null,
  channel_token: null as string | null,
  channel_expiry_ts: null as string | null,
  resource_id: null as string | null,
} as const;

const MS_ACCOUNT = {
  account_id: "acc_01HXY000000000000000INTMS1",
  user_id: TEST_USER.user_id,
  provider: "microsoft",
  provider_subject: "ms-sub-int-001",
  email: "test-ms@outlook.com",
  status: "active",
} as const;

const ERROR_ACCOUNT = {
  account_id: "acc_01HXY000000000000000INTERR",
  user_id: TEST_USER.user_id,
  provider: "google",
  provider_subject: "google-sub-int-err",
  email: "test-error@gmail.com",
  status: "error",
  channel_id: "dead-channel",
  channel_token: "dead-token",
  channel_expiry_ts: new Date(Date.now() - 86400000).toISOString(),
  resource_id: "dead-resource",
} as const;

// ---------------------------------------------------------------------------
// Real D1 backed by better-sqlite3
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
// Mock DO namespace (external service boundary)
// ---------------------------------------------------------------------------

interface DOCallRecord {
  name: string;
  path: string;
  method: string;
  body?: unknown;
}

function createMockDONamespace(config?: {
  pathResponses?: Map<string, { status: number; body: unknown }>;
}): DurableObjectNamespace & { calls: DOCallRecord[] } {
  const calls: DOCallRecord[] = [];

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
              ? (input as Request).method
              : "GET");

          let parsedBody: unknown;
          if (init?.body) {
            try {
              parsedBody = JSON.parse(init.body as string);
            } catch {
              parsedBody = init.body;
            }
          } else if (typeof input === "object" && "json" in input) {
            try {
              parsedBody = await (input as Request).clone().json();
            } catch {
              /* no body */
            }
          }

          calls.push({ name: doName, path: url.pathname, method, body: parsedBody });

          // Check custom responses
          const customResp = config?.pathResponses?.get(url.pathname);
          if (customResp) {
            return new Response(JSON.stringify(customResp.body), {
              status: customResp.status,
              headers: { "Content-Type": "application/json" },
            });
          }

          // Default responses for AccountDO operations
          if (url.pathname === "/getAccessToken") {
            return new Response(
              JSON.stringify({ access_token: "mock-google-access-token" }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          if (url.pathname === "/storeWatchChannel") {
            return new Response(JSON.stringify({ ok: true }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          // Default for UserGraphDO and other DO calls
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
  } as unknown as DurableObjectNamespace & { calls: DOCallRecord[] };
}

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockQueue(): Queue {
  return {
    async send() {},
    async sendBatch() {},
  } as unknown as Queue;
}

function createMockKV(): KVNamespace {
  return {
    async get() { return null; },
    async put() {},
    async delete() {},
    async list() { return { keys: [], list_complete: true }; },
    async getWithMetadata() { return { value: null, metadata: null }; },
  } as unknown as KVNamespace;
}

const mockCtx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

// ---------------------------------------------------------------------------
// Helper: insert test data
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
    channel_id?: string | null;
    channel_token?: string | null;
    channel_expiry_ts?: string | null;
    resource_id?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO accounts
     (account_id, user_id, provider, provider_subject, email, status, channel_id, channel_token, channel_expiry_ts, resource_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    account.account_id,
    account.user_id,
    account.provider,
    account.provider_subject,
    account.email,
    account.status ?? "active",
    account.channel_id ?? null,
    account.channel_token ?? null,
    account.channel_expiry_ts ?? null,
    account.resource_id ?? null,
  );
}

// ===========================================================================
// Integration test suites
// ===========================================================================

describe("Integration: POST /internal/accounts/:id/renew-channel", () => {
  let db: DatabaseType;
  let d1: D1Database;
  let accountDO: DurableObjectNamespace & { calls: DOCallRecord[] };

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(MIGRATION_0001_INITIAL_SCHEMA);
    db.exec(MIGRATION_0002_MS_SUBSCRIPTIONS);
    db.exec(MIGRATION_0008_SYNC_STATUS_COLUMNS);
    db.exec(MIGRATION_0027_WEBHOOK_SCOPE_ROUTING);

    // Seed org + user
    db.prepare("INSERT INTO orgs (org_id, name) VALUES (?, ?)").run(
      TEST_ORG.org_id,
      TEST_ORG.name,
    );
    db.prepare(
      "INSERT INTO users (user_id, org_id, email) VALUES (?, ?, ?)",
    ).run(TEST_USER.user_id, TEST_ORG.org_id, TEST_USER.email);

    // Seed accounts
    insertAccount(db, GOOGLE_ACCOUNT_WITH_CHANNEL);
    insertAccount(db, GOOGLE_ACCOUNT_NO_CHANNEL);
    insertAccount(db, MS_ACCOUNT);
    insertAccount(db, ERROR_ACCOUNT);

    d1 = createRealD1(db);
    accountDO = createMockDONamespace();
    googleApiCalls.length = 0;
  });

  afterEach(() => {
    db.close();
  });

  function buildEnv(
    overrides?: Partial<Env>,
  ): Env {
    return {
      DB: d1,
      USER_GRAPH: createMockDONamespace(),
      ACCOUNT: accountDO,
      SYNC_QUEUE: createMockQueue(),
      WRITE_QUEUE: createMockQueue(),
      SESSIONS: createMockKV(),
      RATE_LIMITS: createMockKV(),
      JWT_SECRET,
      ADMIN_KEY,
      WEBHOOK_URL,
      ...overrides,
    };
  }

  function makeInternalRequest(
    accountId: string,
    adminKey?: string,
  ): Request {
    const headers: Record<string, string> = {};
    if (adminKey !== undefined) {
      headers["X-Admin-Key"] = adminKey;
    }
    return new Request(
      `https://api.tminus.ink/internal/accounts/${accountId}/renew-channel`,
      { method: "POST", headers },
    );
  }

  // -- Auth tests (full handler flow) --

  it("returns 401 when admin key is missing (full handler)", async () => {
    const handler = createHandler();
    const env = buildEnv();
    const request = makeInternalRequest(GOOGLE_ACCOUNT_WITH_CHANNEL.account_id);
    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(401);
    const body = await response.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("admin key");
  });

  it("returns 401 when admin key is incorrect (full handler)", async () => {
    const handler = createHandler();
    const env = buildEnv();
    const request = makeInternalRequest(
      GOOGLE_ACCOUNT_WITH_CHANNEL.account_id,
      "wrong-admin-key-entirely",
    );
    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(401);
  });

  // -- Account validation tests --

  it("returns 404 when account does not exist in D1", async () => {
    const handler = createHandler();
    const env = buildEnv();
    const request = makeInternalRequest("acc_nonexistent_00000000000", ADMIN_KEY);
    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(404);
    const body = await response.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("not found");
  });

  it("returns 400 when account is Microsoft (not Google)", async () => {
    const handler = createHandler();
    const env = buildEnv();
    const request = makeInternalRequest(MS_ACCOUNT.account_id, ADMIN_KEY);
    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(400);
    const body = await response.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("microsoft");
  });

  it("returns 400 when Google account has error status", async () => {
    const handler = createHandler();
    const env = buildEnv();
    const request = makeInternalRequest(ERROR_ACCOUNT.account_id, ADMIN_KEY);
    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(400);
    const body = await response.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("error");
    expect(body.error).toContain("active");
  });

  // -- Success path tests --

  it("renews channel for Google account with existing channel (full flow)", async () => {
    const handler = createHandler();
    const env = buildEnv();
    const request = makeInternalRequest(
      GOOGLE_ACCOUNT_WITH_CHANNEL.account_id,
      ADMIN_KEY,
    );
    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(200);
    const body = await response.json() as {
      ok: boolean;
      data: {
        account_id: string;
        channel_id: string;
        resource_id: string;
        expiry: string;
        previous_channel_id: string | null;
      };
    };

    expect(body.ok).toBe(true);
    expect(body.data.account_id).toBe(GOOGLE_ACCOUNT_WITH_CHANNEL.account_id);
    expect(body.data.channel_id).toBe("renewed-channel-xyz");
    expect(body.data.resource_id).toBe("renewed-resource-abc");
    expect(body.data.expiry).toBeTruthy();
    expect(body.data.previous_channel_id).toBe(GOOGLE_ACCOUNT_WITH_CHANNEL.channel_id);

    // Verify D1 was updated with new channel info (including per-scope calendar_id)
    const updatedRow = db
      .prepare("SELECT channel_id, channel_expiry_ts, resource_id, channel_calendar_id FROM accounts WHERE account_id = ?")
      .get(GOOGLE_ACCOUNT_WITH_CHANNEL.account_id) as {
        channel_id: string;
        channel_expiry_ts: string;
        resource_id: string;
        channel_calendar_id: string;
      };

    expect(updatedRow.channel_id).toBe("renewed-channel-xyz");
    expect(updatedRow.resource_id).toBe("renewed-resource-abc");
    expect(updatedRow.channel_expiry_ts).toBeTruthy();
    // channel_calendar_id defaults to "primary" when not provided in request body
    expect(updatedRow.channel_calendar_id).toBe("primary");
    // Verify expiry is in the future (7 days from now)
    const expiryDate = new Date(updatedRow.channel_expiry_ts);
    expect(expiryDate.getTime()).toBeGreaterThan(Date.now());
  });

  it("renews channel for Google account without existing channel", async () => {
    const handler = createHandler();
    const env = buildEnv();
    const request = makeInternalRequest(
      GOOGLE_ACCOUNT_NO_CHANNEL.account_id,
      ADMIN_KEY,
    );
    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(200);
    const body = await response.json() as {
      ok: boolean;
      data: {
        account_id: string;
        channel_id: string;
        previous_channel_id: string | null;
      };
    };

    expect(body.ok).toBe(true);
    expect(body.data.channel_id).toBe("renewed-channel-xyz");
    expect(body.data.previous_channel_id).toBeNull();

    // Verify D1 was updated
    const updatedRow = db
      .prepare("SELECT channel_id, resource_id FROM accounts WHERE account_id = ?")
      .get(GOOGLE_ACCOUNT_NO_CHANNEL.account_id) as {
        channel_id: string;
        resource_id: string;
      };

    expect(updatedRow.channel_id).toBe("renewed-channel-xyz");
    expect(updatedRow.resource_id).toBe("renewed-resource-abc");
  });

  it("stops old channel with Google before registering new one", async () => {
    const handler = createHandler();
    const env = buildEnv();
    const request = makeInternalRequest(
      GOOGLE_ACCOUNT_WITH_CHANNEL.account_id,
      ADMIN_KEY,
    );
    await handler.fetch(request, env, mockCtx);

    // Google API should have received stopChannel + watchEvents
    expect(googleApiCalls.length).toBe(2);
    expect(googleApiCalls[0].method).toBe("stopChannel");
    expect(googleApiCalls[0].args[0]).toBe(GOOGLE_ACCOUNT_WITH_CHANNEL.channel_id);
    expect(googleApiCalls[0].args[1]).toBe(GOOGLE_ACCOUNT_WITH_CHANNEL.resource_id);
    expect(googleApiCalls[1].method).toBe("watchEvents");
  });

  it("skips stopChannel when account has no existing channel", async () => {
    const handler = createHandler();
    googleApiCalls.length = 0;
    const env = buildEnv();
    const request = makeInternalRequest(
      GOOGLE_ACCOUNT_NO_CHANNEL.account_id,
      ADMIN_KEY,
    );
    await handler.fetch(request, env, mockCtx);

    // Only watchEvents should be called (no stopChannel for non-existent channel)
    expect(googleApiCalls.length).toBe(1);
    expect(googleApiCalls[0].method).toBe("watchEvents");
  });

  it("calls AccountDO for access token and channel storage", async () => {
    const handler = createHandler();
    const env = buildEnv();
    const request = makeInternalRequest(
      GOOGLE_ACCOUNT_WITH_CHANNEL.account_id,
      ADMIN_KEY,
    );
    await handler.fetch(request, env, mockCtx);

    // AccountDO should have received getAccessToken + storeWatchChannel
    const accountCalls = accountDO.calls.filter(
      (c) => c.name === GOOGLE_ACCOUNT_WITH_CHANNEL.account_id,
    );
    expect(accountCalls.length).toBe(2);
    expect(accountCalls[0].path).toBe("/getAccessToken");
    expect(accountCalls[1].path).toBe("/storeWatchChannel");
    expect(accountCalls[1].body).toEqual(
      expect.objectContaining({
        channel_id: "renewed-channel-xyz",
        resource_id: "renewed-resource-abc",
        calendar_id: "primary",
      }),
    );
  });

  // -- Error recovery tests --

  it("returns 500 when AccountDO fails to get access token", async () => {
    const failDO = createMockDONamespace({
      pathResponses: new Map([
        ["/getAccessToken", { status: 401, body: { error: "token_revoked" } }],
      ]),
    });
    const handler = createHandler();
    const env = buildEnv({ ACCOUNT: failDO });
    const request = makeInternalRequest(
      GOOGLE_ACCOUNT_WITH_CHANNEL.account_id,
      ADMIN_KEY,
    );
    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(500);
    const body = await response.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("access token");

    // D1 should NOT have been updated (renewal failed before D1 write)
    const row = db
      .prepare("SELECT channel_id FROM accounts WHERE account_id = ?")
      .get(GOOGLE_ACCOUNT_WITH_CHANNEL.account_id) as { channel_id: string };
    expect(row.channel_id).toBe(GOOGLE_ACCOUNT_WITH_CHANNEL.channel_id);
  });

  // -- Security headers test --

  it("includes security headers in response", async () => {
    const handler = createHandler();
    const env = buildEnv();
    const request = makeInternalRequest(
      GOOGLE_ACCOUNT_WITH_CHANNEL.account_id,
      ADMIN_KEY,
    );
    const response = await handler.fetch(request, env, mockCtx);

    // The finalize function adds security headers to ALL responses
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});
