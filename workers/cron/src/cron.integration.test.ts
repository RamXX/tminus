/**
 * Integration tests for tminus-cron worker.
 *
 * These tests use better-sqlite3 (the same SQLite engine underlying Cloudflare D1)
 * to create a REAL in-memory database with the actual accounts table schema.
 * The D1 mock wraps better-sqlite3 so all SQL queries execute against real SQLite,
 * proving the handler's SQL syntax and table schema assumptions are correct.
 *
 * AccountDO and Queue are mocked (external service boundaries). We verify the
 * messages sent and DO methods invoked, not their internals.
 *
 * Each test exercises a specific cron responsibility independently:
 * 1. Channel renewal (every 6h)
 * 2. Token health check (every 12h)
 * 3. Drift reconciliation dispatch (daily 03:00 UTC)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import {
  MIGRATION_0001_INITIAL_SCHEMA,
  MIGRATION_0008_SYNC_STATUS_COLUMNS,
  MIGRATION_0020_FEED_REFRESH,
} from "@tminus/d1-registry";
import { createHandler } from "./index";
import {
  CRON_CHANNEL_RENEWAL,
  CRON_TOKEN_HEALTH,
  CRON_RECONCILIATION,
  CRON_DRIFT_COMPUTATION,
  CRON_FEED_REFRESH,
  CHANNEL_RENEWAL_THRESHOLD_MS,
  MS_SUBSCRIPTION_RENEWAL_THRESHOLD_MS,
} from "./constants";

// ---------------------------------------------------------------------------
// Mock GoogleCalendarClient and generateId (used by reRegisterChannel)
//
// After TM-ucl1, the cron worker calls reRegisterChannel() which creates a
// GoogleCalendarClient and calls stopChannel/watchEvents directly against
// Google's API. In integration tests we mock these external API calls while
// keeping all D1 queries real (via better-sqlite3).
// ---------------------------------------------------------------------------

/** Tracks Google Calendar API calls for assertion. */
const googleApiCalls: Array<{ method: string; args: unknown[] }> = [];

vi.mock("@tminus/shared", async () => {
  const actual = await vi.importActual("@tminus/shared");
  return {
    ...actual,
    GoogleCalendarClient: vi.fn().mockImplementation(() => ({
      stopChannel: vi.fn(async (...args: unknown[]) => {
        googleApiCalls.push({ method: "stopChannel", args });
      }),
      watchEvents: vi.fn(async (...args: unknown[]) => {
        googleApiCalls.push({ method: "watchEvents", args });
        return {
          channelId: "new-channel-from-google",
          resourceId: "new-resource-from-google",
          expiration: String(Date.now() + 7 * 24 * 60 * 60 * 1000),
        };
      }),
    })),
    generateId: vi.fn((prefix: string) => `${prefix}_mock_${Date.now()}`),
  };
});

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_ORG = {
  org_id: "org_01HXYZ00000000000000000001",
  name: "Cron Test Org",
} as const;

const TEST_USER = {
  user_id: "usr_01HXYZ00000000000000000001",
  org_id: TEST_ORG.org_id,
  email: "cron-test@example.com",
} as const;

const ACCOUNT_A = {
  account_id: "acc_01HXYZ0000000000000000000A",
  user_id: TEST_USER.user_id,
  provider: "google",
  provider_subject: "google-sub-aaaa",
  email: "alice@gmail.com",
  status: "active",
  channel_id: "channel-aaa-111",
  channel_token: "secret-token-alpha",
} as const;

const ACCOUNT_B = {
  account_id: "acc_01HXYZ0000000000000000000B",
  user_id: TEST_USER.user_id,
  provider: "google",
  provider_subject: "google-sub-bbbb",
  email: "bob@gmail.com",
  status: "active",
  channel_id: "channel-bbb-222",
  channel_token: "secret-token-beta",
} as const;

const ACCOUNT_C_ERROR = {
  account_id: "acc_01HXYZ0000000000000000000C",
  user_id: TEST_USER.user_id,
  provider: "google",
  provider_subject: "google-sub-cccc",
  email: "charlie@gmail.com",
  status: "error",
  channel_id: "channel-ccc-333",
  channel_token: "secret-token-gamma",
} as const;

// ---------------------------------------------------------------------------
// Real D1 mock backed by better-sqlite3 (same pattern as webhook tests)
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
// MockQueue: captures messages for assertion
// ---------------------------------------------------------------------------

function createMockQueue(): Queue & { messages: unknown[] } {
  const messages: unknown[] = [];
  return {
    messages,
    async send(msg: unknown) {
      messages.push(msg);
    },
    async sendBatch(_msgs: Iterable<MessageSendRequest>) {
      // Not used by cron handler
    },
  } as unknown as Queue & { messages: unknown[] };
}

// ---------------------------------------------------------------------------
// Mock AccountDO namespace: captures DO interactions
// ---------------------------------------------------------------------------

interface DOCallRecord {
  accountId: string;
  path: string;
  method: string;
}

/**
 * Creates a mock DurableObjectNamespace that records calls to DO stubs.
 *
 * The mock DO stub responds to fetch() calls with configurable responses
 * so we can simulate healthy accounts, failed token refreshes, etc.
 */
function createMockAccountDONamespace(config?: {
  /** Map of account_id -> path -> Response. If not present, returns 200 OK. */
  responses?: Map<string, Map<string, Response>>;
}): DurableObjectNamespace & { calls: DOCallRecord[] } {
  const calls: DOCallRecord[] = [];

  return {
    calls,
    idFromName(name: string): DurableObjectId {
      return { toString: () => name, name, equals: () => false } as unknown as DurableObjectId;
    },
    get(_id: DurableObjectId): DurableObjectStub {
      const accountId = _id.toString();
      return {
        fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
          const url = typeof input === "string" ? new URL(input) : input instanceof URL ? input : new URL(input.url);
          const method = init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET");
          calls.push({ accountId, path: url.pathname, method });

          // Check configured responses
          const accountResponses = config?.responses?.get(accountId);
          if (accountResponses) {
            const pathResponse = accountResponses.get(url.pathname);
            if (pathResponse) {
              return Promise.resolve(pathResponse.clone());
            }
          }

          // Default: 200 OK with empty JSON
          return Promise.resolve(new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }));
        },
      } as unknown as DurableObjectStub;
    },
    idFromString(_hexId: string): DurableObjectId {
      return { toString: () => _hexId, equals: () => false } as unknown as DurableObjectId;
    },
    newUniqueId(): DurableObjectId {
      return { toString: () => "unique", equals: () => false } as unknown as DurableObjectId;
    },
    jurisdiction(_name: string): DurableObjectNamespace {
      return this;
    },
  } as unknown as DurableObjectNamespace & { calls: DOCallRecord[] };
}

// ---------------------------------------------------------------------------
// Helper: insert account into D1 with specific channel_expiry_ts
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
  },
): void {
  db.prepare(
    `INSERT INTO accounts
     (account_id, user_id, provider, provider_subject, email, status, channel_id, channel_token, channel_expiry_ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  );
}

// ---------------------------------------------------------------------------
// Helper: build a mock ScheduledEvent
// ---------------------------------------------------------------------------

function buildScheduledEvent(cron: string): ScheduledEvent {
  return {
    cron,
    scheduledTime: Date.now(),
    noRetry(): void {
      // no-op
    },
  } as unknown as ScheduledEvent;
}

// ---------------------------------------------------------------------------
// Helper: build the mock ExecutionContext
// ---------------------------------------------------------------------------

const buildMockCtx = (): ExecutionContext => ({
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext);

// ---------------------------------------------------------------------------
// Integration test suite: Channel Renewal
// ---------------------------------------------------------------------------

describe("Cron integration tests: Channel Renewal (every 6h)", () => {
  let db: DatabaseType;
  let d1: D1Database;
  let queue: Queue & { messages: unknown[] };

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(MIGRATION_0001_INITIAL_SCHEMA);
    db.exec(MIGRATION_0008_SYNC_STATUS_COLUMNS);
    db.prepare("INSERT INTO orgs (org_id, name) VALUES (?, ?)").run(
      TEST_ORG.org_id,
      TEST_ORG.name,
    );
    db.prepare(
      "INSERT INTO users (user_id, org_id, email) VALUES (?, ?, ?)",
    ).run(TEST_USER.user_id, TEST_USER.org_id, TEST_USER.email);
    d1 = createRealD1(db);
    queue = createMockQueue();
    googleApiCalls.length = 0;
  });

  afterEach(() => {
    db.close();
  });

  it("re-registers channels expiring within 24 hours via reRegisterChannel", async () => {
    // Channel expires in 12 hours (within threshold)
    const expiresIn12h = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
    insertAccount(db, {
      ...ACCOUNT_A,
      channel_expiry_ts: expiresIn12h,
    });

    // Mock DO responses for the reRegisterChannel flow:
    // 1. /getAccessToken returns a token
    // 2. /storeWatchChannel stores new channel metadata
    const responses = new Map<string, Map<string, Response>>();
    responses.set(
      ACCOUNT_A.account_id,
      new Map([
        ["/getAccessToken", new Response(JSON.stringify({ access_token: "mock-token" }), {
          status: 200, headers: { "Content-Type": "application/json" },
        })],
        ["/storeWatchChannel", new Response(JSON.stringify({ ok: true }), {
          status: 200, headers: { "Content-Type": "application/json" },
        })],
      ]),
    );

    const doNamespace = createMockAccountDONamespace({ responses });
    const handler = createHandler();
    const env = { DB: d1, ACCOUNT: doNamespace, RECONCILE_QUEUE: queue, WEBHOOK_URL: "https://webhook.test" } as Env;
    const event = buildScheduledEvent(CRON_CHANNEL_RENEWAL);
    const ctx = buildMockCtx();

    await handler.scheduled(event, env, ctx);

    // reRegisterChannel flow: getAccessToken -> Google stopChannel -> Google watchEvents -> storeWatchChannel
    const accountCalls = doNamespace.calls.filter(c => c.accountId === ACCOUNT_A.account_id);
    expect(accountCalls.some(c => c.path === "/getAccessToken")).toBe(true);
    expect(accountCalls.some(c => c.path === "/storeWatchChannel")).toBe(true);

    // Google API calls should have been made (mocked)
    expect(googleApiCalls.some(c => c.method === "watchEvents")).toBe(true);

    // D1 should be updated with new channel metadata
    const row = db.prepare("SELECT channel_id, resource_id FROM accounts WHERE account_id = ?")
      .get(ACCOUNT_A.account_id) as { channel_id: string; resource_id: string };
    expect(row.channel_id).toBe("new-channel-from-google");
    expect(row.resource_id).toBe("new-resource-from-google");
  });

  it("does NOT renew channels expiring in more than 24 hours", async () => {
    // Channel expires in 48 hours (outside threshold)
    const expiresIn48h = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
    // Also set last_sync_ts to now so it's not considered stale
    const now = new Date().toISOString();
    insertAccount(db, {
      ...ACCOUNT_A,
      channel_expiry_ts: expiresIn48h,
    });
    // Set last_sync_ts to now so the channel is NOT considered stale
    db.prepare("UPDATE accounts SET last_sync_ts = ? WHERE account_id = ?")
      .run(now, ACCOUNT_A.account_id);

    const doNamespace = createMockAccountDONamespace();
    const handler = createHandler();
    const env = { DB: d1, ACCOUNT: doNamespace, RECONCILE_QUEUE: queue, WEBHOOK_URL: "https://webhook.test" } as Env;
    const event = buildScheduledEvent(CRON_CHANNEL_RENEWAL);
    const ctx = buildMockCtx();

    await handler.scheduled(event, env, ctx);

    // No DO calls -- channel is not expiring soon and has recent sync
    expect(doNamespace.calls).toHaveLength(0);
  });

  it("re-registers multiple expiring channels in a single run", async () => {
    const expiresIn6h = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    insertAccount(db, {
      ...ACCOUNT_A,
      channel_expiry_ts: expiresIn6h,
    });
    insertAccount(db, {
      ...ACCOUNT_B,
      channel_expiry_ts: expiresIn6h,
    });

    // Mock DO responses for both accounts
    const responses = new Map<string, Map<string, Response>>();
    for (const acct of [ACCOUNT_A, ACCOUNT_B]) {
      responses.set(
        acct.account_id,
        new Map([
          ["/getAccessToken", new Response(JSON.stringify({ access_token: "mock-token" }), {
            status: 200, headers: { "Content-Type": "application/json" },
          })],
          ["/storeWatchChannel", new Response(JSON.stringify({ ok: true }), {
            status: 200, headers: { "Content-Type": "application/json" },
          })],
        ]),
      );
    }

    const doNamespace = createMockAccountDONamespace({ responses });
    const handler = createHandler();
    const env = { DB: d1, ACCOUNT: doNamespace, RECONCILE_QUEUE: queue, WEBHOOK_URL: "https://webhook.test" } as Env;
    const event = buildScheduledEvent(CRON_CHANNEL_RENEWAL);
    const ctx = buildMockCtx();

    await handler.scheduled(event, env, ctx);

    // Both accounts should have getAccessToken + storeWatchChannel called
    const calledAccountIds = [...new Set(doNamespace.calls.map(c => c.accountId))].sort();
    expect(calledAccountIds).toEqual(
      [ACCOUNT_A.account_id, ACCOUNT_B.account_id].sort(),
    );
    // Each account should have both DO calls
    for (const acctId of calledAccountIds) {
      const calls = doNamespace.calls.filter(c => c.accountId === acctId);
      expect(calls.some(c => c.path === "/getAccessToken")).toBe(true);
      expect(calls.some(c => c.path === "/storeWatchChannel")).toBe(true);
    }
  });

  it("skips accounts with null channel_expiry_ts", async () => {
    insertAccount(db, {
      ...ACCOUNT_A,
      channel_expiry_ts: null,
    });

    const doNamespace = createMockAccountDONamespace();
    const handler = createHandler();
    const env = { DB: d1, ACCOUNT: doNamespace, RECONCILE_QUEUE: queue, WEBHOOK_URL: "https://webhook.test" } as Env;
    const event = buildScheduledEvent(CRON_CHANNEL_RENEWAL);
    const ctx = buildMockCtx();

    await handler.scheduled(event, env, ctx);

    expect(doNamespace.calls).toHaveLength(0);
  });

  it("skips accounts with status='error' even if channel expiring soon", async () => {
    const expiresIn6h = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    insertAccount(db, {
      ...ACCOUNT_C_ERROR,
      channel_expiry_ts: expiresIn6h,
    });

    const doNamespace = createMockAccountDONamespace();
    const handler = createHandler();
    const env = { DB: d1, ACCOUNT: doNamespace, RECONCILE_QUEUE: queue, WEBHOOK_URL: "https://webhook.test" } as Env;
    const event = buildScheduledEvent(CRON_CHANNEL_RENEWAL);
    const ctx = buildMockCtx();

    await handler.scheduled(event, env, ctx);

    // Error accounts should not have channels renewed
    expect(doNamespace.calls).toHaveLength(0);
  });

  it("continues processing other accounts when one DO call fails", async () => {
    const expiresIn6h = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    insertAccount(db, { ...ACCOUNT_A, channel_expiry_ts: expiresIn6h });
    insertAccount(db, { ...ACCOUNT_B, channel_expiry_ts: expiresIn6h });

    // Account A: getAccessToken returns 500 (reRegisterChannel will log error and continue)
    // Account B: succeeds normally
    const responses = new Map<string, Map<string, Response>>();
    responses.set(
      ACCOUNT_A.account_id,
      new Map([["/getAccessToken", new Response("Internal Error", { status: 500 })]]),
    );
    responses.set(
      ACCOUNT_B.account_id,
      new Map([
        ["/getAccessToken", new Response(JSON.stringify({ access_token: "mock-token" }), {
          status: 200, headers: { "Content-Type": "application/json" },
        })],
        ["/storeWatchChannel", new Response(JSON.stringify({ ok: true }), {
          status: 200, headers: { "Content-Type": "application/json" },
        })],
      ]),
    );

    const doNamespace = createMockAccountDONamespace({ responses });
    const handler = createHandler();
    const env = { DB: d1, ACCOUNT: doNamespace, RECONCILE_QUEUE: queue, WEBHOOK_URL: "https://webhook.test" } as Env;
    const event = buildScheduledEvent(CRON_CHANNEL_RENEWAL);
    const ctx = buildMockCtx();

    await handler.scheduled(event, env, ctx);

    // Both accounts should be attempted (error is caught, not thrown)
    const uniqueAccounts = [...new Set(doNamespace.calls.map(c => c.accountId))];
    expect(uniqueAccounts).toHaveLength(2);
    // Account A should have getAccessToken attempted (and failed)
    expect(doNamespace.calls.some(c => c.accountId === ACCOUNT_A.account_id && c.path === "/getAccessToken")).toBe(true);
    // Account B should have completed successfully (getAccessToken + storeWatchChannel)
    expect(doNamespace.calls.some(c => c.accountId === ACCOUNT_B.account_id && c.path === "/storeWatchChannel")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration test suite: Token Health Check
// ---------------------------------------------------------------------------

describe("Cron integration tests: Token Health Check (every 12h)", () => {
  let db: DatabaseType;
  let d1: D1Database;
  let queue: Queue & { messages: unknown[] };

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(MIGRATION_0001_INITIAL_SCHEMA);
    db.exec(MIGRATION_0008_SYNC_STATUS_COLUMNS);
    db.prepare("INSERT INTO orgs (org_id, name) VALUES (?, ?)").run(
      TEST_ORG.org_id,
      TEST_ORG.name,
    );
    db.prepare(
      "INSERT INTO users (user_id, org_id, email) VALUES (?, ?, ?)",
    ).run(TEST_USER.user_id, TEST_USER.org_id, TEST_USER.email);
    d1 = createRealD1(db);
    queue = createMockQueue();
  });

  afterEach(() => {
    db.close();
  });

  it("checks health for all active accounts", async () => {
    insertAccount(db, { ...ACCOUNT_A });
    insertAccount(db, { ...ACCOUNT_B });

    const doNamespace = createMockAccountDONamespace();
    const handler = createHandler();
    const env = { DB: d1, ACCOUNT: doNamespace, RECONCILE_QUEUE: queue } as Env;
    const event = buildScheduledEvent(CRON_TOKEN_HEALTH);
    const ctx = buildMockCtx();

    await handler.scheduled(event, env, ctx);

    // Should call getHealth then getAccessToken for each active account
    const healthCalls = doNamespace.calls.filter((c) => c.path === "/getHealth");
    expect(healthCalls).toHaveLength(2);
  });

  it("skips accounts with status='error'", async () => {
    insertAccount(db, { ...ACCOUNT_A });
    insertAccount(db, { ...ACCOUNT_C_ERROR });

    const doNamespace = createMockAccountDONamespace();
    const handler = createHandler();
    const env = { DB: d1, ACCOUNT: doNamespace, RECONCILE_QUEUE: queue } as Env;
    const event = buildScheduledEvent(CRON_TOKEN_HEALTH);
    const ctx = buildMockCtx();

    await handler.scheduled(event, env, ctx);

    // Only active accounts get health-checked
    const healthCalls = doNamespace.calls.filter((c) => c.path === "/getHealth");
    expect(healthCalls).toHaveLength(1);
    expect(healthCalls[0].accountId).toBe(ACCOUNT_A.account_id);
  });

  it("marks account as error in D1 when token refresh fails", async () => {
    insertAccount(db, { ...ACCOUNT_A });

    // getHealth returns OK, but getAccessToken fails
    const responses = new Map<string, Map<string, Response>>();
    responses.set(
      ACCOUNT_A.account_id,
      new Map([
        ["/getHealth", new Response(JSON.stringify({ ok: true }), { status: 200 })],
        ["/getAccessToken", new Response("Token refresh failed", { status: 500 })],
      ]),
    );

    const doNamespace = createMockAccountDONamespace({ responses });
    const handler = createHandler();
    const env = { DB: d1, ACCOUNT: doNamespace, RECONCILE_QUEUE: queue } as Env;
    const event = buildScheduledEvent(CRON_TOKEN_HEALTH);
    const ctx = buildMockCtx();

    await handler.scheduled(event, env, ctx);

    // Account status should be updated to 'error' in D1
    const row = db
      .prepare("SELECT status FROM accounts WHERE account_id = ?")
      .get(ACCOUNT_A.account_id) as { status: string };
    expect(row.status).toBe("error");
  });

  it("does NOT mark account as error when token refresh succeeds", async () => {
    insertAccount(db, { ...ACCOUNT_A });

    // Both getHealth and getAccessToken succeed
    const doNamespace = createMockAccountDONamespace();
    const handler = createHandler();
    const env = { DB: d1, ACCOUNT: doNamespace, RECONCILE_QUEUE: queue } as Env;
    const event = buildScheduledEvent(CRON_TOKEN_HEALTH);
    const ctx = buildMockCtx();

    await handler.scheduled(event, env, ctx);

    // Account status should remain 'active'
    const row = db
      .prepare("SELECT status FROM accounts WHERE account_id = ?")
      .get(ACCOUNT_A.account_id) as { status: string };
    expect(row.status).toBe("active");
  });

  it("continues processing when one account's health check fails", async () => {
    insertAccount(db, { ...ACCOUNT_A });
    insertAccount(db, { ...ACCOUNT_B });

    // Account A: getHealth fails entirely
    const responses = new Map<string, Map<string, Response>>();
    responses.set(
      ACCOUNT_A.account_id,
      new Map([
        ["/getHealth", new Response("DO unavailable", { status: 503 })],
      ]),
    );

    const doNamespace = createMockAccountDONamespace({ responses });
    const handler = createHandler();
    const env = { DB: d1, ACCOUNT: doNamespace, RECONCILE_QUEUE: queue } as Env;
    const event = buildScheduledEvent(CRON_TOKEN_HEALTH);
    const ctx = buildMockCtx();

    await handler.scheduled(event, env, ctx);

    // Both accounts should be attempted
    const healthCalls = doNamespace.calls.filter((c) => c.path === "/getHealth");
    expect(healthCalls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Integration test suite: Drift Reconciliation Dispatch
// ---------------------------------------------------------------------------

describe("Cron integration tests: Drift Reconciliation (daily 03:00 UTC)", () => {
  let db: DatabaseType;
  let d1: D1Database;
  let queue: Queue & { messages: unknown[] };

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(MIGRATION_0001_INITIAL_SCHEMA);
    db.exec(MIGRATION_0008_SYNC_STATUS_COLUMNS);
    db.prepare("INSERT INTO orgs (org_id, name) VALUES (?, ?)").run(
      TEST_ORG.org_id,
      TEST_ORG.name,
    );
    db.prepare(
      "INSERT INTO users (user_id, org_id, email) VALUES (?, ?, ?)",
    ).run(TEST_USER.user_id, TEST_USER.org_id, TEST_USER.email);
    d1 = createRealD1(db);
    queue = createMockQueue();
  });

  afterEach(() => {
    db.close();
  });

  it("enqueues RECONCILE_ACCOUNT for all active accounts", async () => {
    insertAccount(db, { ...ACCOUNT_A });
    insertAccount(db, { ...ACCOUNT_B });

    const doNamespace = createMockAccountDONamespace();
    const handler = createHandler();
    const env = { DB: d1, ACCOUNT: doNamespace, RECONCILE_QUEUE: queue } as Env;
    const event = buildScheduledEvent(CRON_RECONCILIATION);
    const ctx = buildMockCtx();

    await handler.scheduled(event, env, ctx);

    // Two messages should be enqueued (one per active account)
    expect(queue.messages).toHaveLength(2);

    const messages = queue.messages as Array<Record<string, unknown>>;
    const accountIds = messages.map((m) => m.account_id).sort();
    expect(accountIds).toEqual(
      [ACCOUNT_A.account_id, ACCOUNT_B.account_id].sort(),
    );

    // Verify message shape
    for (const msg of messages) {
      expect(msg.type).toBe("RECONCILE_ACCOUNT");
      expect(msg.reason).toBe("scheduled");
      expect(typeof msg.account_id).toBe("string");
    }
  });

  it("skips accounts with status='error'", async () => {
    insertAccount(db, { ...ACCOUNT_A });
    insertAccount(db, { ...ACCOUNT_C_ERROR });

    const doNamespace = createMockAccountDONamespace();
    const handler = createHandler();
    const env = { DB: d1, ACCOUNT: doNamespace, RECONCILE_QUEUE: queue } as Env;
    const event = buildScheduledEvent(CRON_RECONCILIATION);
    const ctx = buildMockCtx();

    await handler.scheduled(event, env, ctx);

    // Only account A (active) should be enqueued
    expect(queue.messages).toHaveLength(1);
    const msg = queue.messages[0] as Record<string, unknown>;
    expect(msg.account_id).toBe(ACCOUNT_A.account_id);
  });

  it("enqueues nothing when no active accounts exist", async () => {
    // Only error account exists
    insertAccount(db, { ...ACCOUNT_C_ERROR });

    const doNamespace = createMockAccountDONamespace();
    const handler = createHandler();
    const env = { DB: d1, ACCOUNT: doNamespace, RECONCILE_QUEUE: queue } as Env;
    const event = buildScheduledEvent(CRON_RECONCILIATION);
    const ctx = buildMockCtx();

    await handler.scheduled(event, env, ctx);

    expect(queue.messages).toHaveLength(0);
  });

  it("enqueues nothing when accounts table is empty", async () => {
    const doNamespace = createMockAccountDONamespace();
    const handler = createHandler();
    const env = { DB: d1, ACCOUNT: doNamespace, RECONCILE_QUEUE: queue } as Env;
    const event = buildScheduledEvent(CRON_RECONCILIATION);
    const ctx = buildMockCtx();

    await handler.scheduled(event, env, ctx);

    expect(queue.messages).toHaveLength(0);
  });

  it("does NOT call AccountDO for reconciliation (queue-only operation)", async () => {
    insertAccount(db, { ...ACCOUNT_A });

    const doNamespace = createMockAccountDONamespace();
    const handler = createHandler();
    const env = { DB: d1, ACCOUNT: doNamespace, RECONCILE_QUEUE: queue } as Env;
    const event = buildScheduledEvent(CRON_RECONCILIATION);
    const ctx = buildMockCtx();

    await handler.scheduled(event, env, ctx);

    // Reconciliation only enqueues messages -- no DO calls
    expect(doNamespace.calls).toHaveLength(0);
    expect(queue.messages).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Unit test: Channel expiry threshold calculation
// ---------------------------------------------------------------------------

describe("Channel expiry threshold calculation", () => {
  it("CHANNEL_RENEWAL_THRESHOLD_MS equals 24 hours in milliseconds", () => {
    const twentyFourHoursMs = 24 * 60 * 60 * 1000;
    expect(CHANNEL_RENEWAL_THRESHOLD_MS).toBe(twentyFourHoursMs);
  });

  it("MS_SUBSCRIPTION_RENEWAL_THRESHOLD_MS equals 54 hours in milliseconds (75% of 3 days)", () => {
    const fiftyFourHoursMs = 54 * 60 * 60 * 1000;
    expect(MS_SUBSCRIPTION_RENEWAL_THRESHOLD_MS).toBe(fiftyFourHoursMs);
  });
});

// ---------------------------------------------------------------------------
// Integration test suite: Microsoft Subscription Renewal (AC 5)
// ---------------------------------------------------------------------------

const ACCOUNT_MS = {
  account_id: "acc_01HXYZ000000000000000000MS",
  user_id: TEST_USER.user_id,
  provider: "microsoft",
  provider_subject: "ms-subject-aaaa",
  email: "alice@outlook.com",
  status: "active",
  channel_id: null,
  channel_token: null,
} as const;

describe("Cron integration tests: Microsoft Subscription Renewal (AC 5)", () => {
  let db: DatabaseType;
  let d1: D1Database;
  let queue: Queue & { messages: unknown[] };

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(MIGRATION_0001_INITIAL_SCHEMA);
    db.exec(MIGRATION_0008_SYNC_STATUS_COLUMNS);
    db.prepare("INSERT INTO orgs (org_id, name) VALUES (?, ?)").run(
      TEST_ORG.org_id,
      TEST_ORG.name,
    );
    db.prepare(
      "INSERT INTO users (user_id, org_id, email) VALUES (?, ?, ?)",
    ).run(TEST_USER.user_id, TEST_USER.org_id, TEST_USER.email);
    d1 = createRealD1(db);
    queue = createMockQueue();
    googleApiCalls.length = 0;
  });

  afterEach(() => {
    db.close();
  });

  it("renews Microsoft subscriptions expiring within 54 hours (75% of 3 days)", async () => {
    insertAccount(db, ACCOUNT_MS);

    // Subscription expiring in 40 hours (within 54h threshold)
    const expiresIn40h = new Date(Date.now() + 40 * 60 * 60 * 1000).toISOString();

    // Configure DO to return a subscription that needs renewal
    const responses = new Map<string, Map<string, Response>>();
    responses.set(
      ACCOUNT_MS.account_id,
      new Map([
        [
          "/getMsSubscriptions",
          new Response(JSON.stringify({
            subscriptions: [{
              subscriptionId: "ms-sub-renew-1",
              expiration: expiresIn40h,
            }],
          }), { status: 200, headers: { "Content-Type": "application/json" } }),
        ],
        [
          "/renewMsSubscription",
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ],
      ]),
    );

    const doNamespace = createMockAccountDONamespace({ responses });
    const handler = createHandler();
    const env = { DB: d1, ACCOUNT: doNamespace, RECONCILE_QUEUE: queue } as Env;
    const event = buildScheduledEvent(CRON_CHANNEL_RENEWAL);
    const ctx = buildMockCtx();

    await handler.scheduled(event, env, ctx);

    // Should have called getMsSubscriptions and renewMsSubscription
    const msCalls = doNamespace.calls.filter(
      (c) => c.accountId === ACCOUNT_MS.account_id,
    );
    expect(msCalls.some((c) => c.path === "/getMsSubscriptions")).toBe(true);
    expect(msCalls.some((c) => c.path === "/renewMsSubscription")).toBe(true);
  });

  it("does NOT renew subscriptions with more than 54 hours remaining", async () => {
    insertAccount(db, ACCOUNT_MS);

    // Subscription expiring in 60 hours (outside 54h threshold)
    const expiresIn60h = new Date(Date.now() + 60 * 60 * 60 * 1000).toISOString();

    const responses = new Map<string, Map<string, Response>>();
    responses.set(
      ACCOUNT_MS.account_id,
      new Map([
        [
          "/getMsSubscriptions",
          new Response(JSON.stringify({
            subscriptions: [{
              subscriptionId: "ms-sub-fresh",
              expiration: expiresIn60h,
            }],
          }), { status: 200, headers: { "Content-Type": "application/json" } }),
        ],
      ]),
    );

    const doNamespace = createMockAccountDONamespace({ responses });
    const handler = createHandler();
    const env = { DB: d1, ACCOUNT: doNamespace, RECONCILE_QUEUE: queue } as Env;
    const event = buildScheduledEvent(CRON_CHANNEL_RENEWAL);
    const ctx = buildMockCtx();

    await handler.scheduled(event, env, ctx);

    // Should have called getMsSubscriptions but NOT renewMsSubscription
    const msCalls = doNamespace.calls.filter(
      (c) => c.accountId === ACCOUNT_MS.account_id,
    );
    expect(msCalls.some((c) => c.path === "/getMsSubscriptions")).toBe(true);
    expect(msCalls.some((c) => c.path === "/renewMsSubscription")).toBe(false);
  });

  it("skips Google accounts (only processes provider=microsoft)", async () => {
    // Only insert Google accounts, no Microsoft
    insertAccount(db, ACCOUNT_A);

    const doNamespace = createMockAccountDONamespace();
    const handler = createHandler();
    const env = { DB: d1, ACCOUNT: doNamespace, RECONCILE_QUEUE: queue } as Env;
    const event = buildScheduledEvent(CRON_CHANNEL_RENEWAL);
    const ctx = buildMockCtx();

    await handler.scheduled(event, env, ctx);

    // No getMsSubscriptions calls (only Google accounts exist)
    const msCalls = doNamespace.calls.filter(
      (c) => c.path === "/getMsSubscriptions",
    );
    expect(msCalls).toHaveLength(0);
  });

  it("handles DO errors gracefully during subscription renewal", async () => {
    insertAccount(db, ACCOUNT_MS);

    // DO returns error for getMsSubscriptions
    const responses = new Map<string, Map<string, Response>>();
    responses.set(
      ACCOUNT_MS.account_id,
      new Map([
        [
          "/getMsSubscriptions",
          new Response("Internal Error", { status: 500 }),
        ],
      ]),
    );

    const doNamespace = createMockAccountDONamespace({ responses });
    const handler = createHandler();
    const env = { DB: d1, ACCOUNT: doNamespace, RECONCILE_QUEUE: queue } as Env;
    const event = buildScheduledEvent(CRON_CHANNEL_RENEWAL);
    const ctx = buildMockCtx();

    // Should not throw
    await handler.scheduled(event, env, ctx);

    // getMsSubscriptions was attempted but renewMsSubscription was not
    const msCalls = doNamespace.calls.filter(
      (c) => c.accountId === ACCOUNT_MS.account_id,
    );
    expect(msCalls.some((c) => c.path === "/getMsSubscriptions")).toBe(true);
    expect(msCalls.some((c) => c.path === "/renewMsSubscription")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration test: Cron dispatch routing
// ---------------------------------------------------------------------------

describe("Cron dispatch routing", () => {
  let db: DatabaseType;
  let d1: D1Database;
  let queue: Queue & { messages: unknown[] };

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(MIGRATION_0001_INITIAL_SCHEMA);
    db.exec(MIGRATION_0008_SYNC_STATUS_COLUMNS);
    db.prepare("INSERT INTO orgs (org_id, name) VALUES (?, ?)").run(
      TEST_ORG.org_id,
      TEST_ORG.name,
    );
    db.prepare(
      "INSERT INTO users (user_id, org_id, email) VALUES (?, ?, ?)",
    ).run(TEST_USER.user_id, TEST_USER.org_id, TEST_USER.email);
    d1 = createRealD1(db);
    queue = createMockQueue();
  });

  afterEach(() => {
    db.close();
  });

  it("unknown cron schedule does not crash (logs warning only)", async () => {
    const doNamespace = createMockAccountDONamespace();
    const handler = createHandler();
    const env = { DB: d1, ACCOUNT: doNamespace, RECONCILE_QUEUE: queue } as Env;
    const event = buildScheduledEvent("0 0 * * 0"); // unknown schedule
    const ctx = buildMockCtx();

    // Should not throw
    await handler.scheduled(event, env, ctx);

    // No work done
    expect(doNamespace.calls).toHaveLength(0);
    expect(queue.messages).toHaveLength(0);
  });

  it("health endpoint returns 200 OK", async () => {
    const doNamespace = createMockAccountDONamespace();
    const handler = createHandler();
    const env = { DB: d1, ACCOUNT: doNamespace, RECONCILE_QUEUE: queue } as Env;
    const ctx = buildMockCtx();

    const request = new Request("https://cron.tminus.dev/health", {
      method: "GET",
    });
    const response = await handler.fetch(request, env, ctx);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("OK");
  });
});

// ---------------------------------------------------------------------------
// Integration test suite: Social Drift Computation (daily 04:00 UTC)
// ---------------------------------------------------------------------------

describe("Cron integration tests: Social Drift Computation (daily 04:00 UTC)", () => {
  let db: DatabaseType;
  let d1: D1Database;
  let queue: Queue & { messages: unknown[] };

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(MIGRATION_0001_INITIAL_SCHEMA);
    db.exec(MIGRATION_0008_SYNC_STATUS_COLUMNS);
    db.prepare("INSERT INTO orgs (org_id, name) VALUES (?, ?)").run(
      TEST_ORG.org_id,
      TEST_ORG.name,
    );
    db.prepare(
      "INSERT INTO users (user_id, org_id, email) VALUES (?, ?, ?)",
    ).run(TEST_USER.user_id, TEST_USER.org_id, TEST_USER.email);
    d1 = createRealD1(db);
    queue = createMockQueue();
  });

  afterEach(() => {
    db.close();
  });

  it("calls getDriftReport and storeDriftAlerts for each active user", async () => {
    insertAccount(db, { ...ACCOUNT_A });
    insertAccount(db, { ...ACCOUNT_B }); // same user_id as A

    // Mock drift report response
    const mockDriftReport = {
      overdue: [
        {
          relationship_id: "rel_01HXY000000000000000000E01",
          display_name: "Alice",
          category: "FRIEND",
          drift_ratio: 2.5,
          days_overdue: 10,
          urgency: 5.0,
        },
      ],
      total_tracked: 3,
      total_overdue: 1,
      computed_at: new Date().toISOString(),
    };

    // UserGraphDO mock that returns drift report and accepts store
    const userGraphCalls: DOCallRecord[] = [];
    const userGraphNamespace = {
      calls: userGraphCalls,
      idFromName(name: string): DurableObjectId {
        return { toString: () => name, name, equals: () => false } as unknown as DurableObjectId;
      },
      get(_id: DurableObjectId): DurableObjectStub {
        const userId = _id.toString();
        return {
          fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
            const url = typeof input === "string" ? new URL(input) : input instanceof URL ? input : new URL(input.url);
            const method = init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET");
            userGraphCalls.push({ accountId: userId, path: url.pathname, method });

            if (url.pathname === "/getDriftReport") {
              return Promise.resolve(
                new Response(JSON.stringify(mockDriftReport), {
                  status: 200,
                  headers: { "Content-Type": "application/json" },
                }),
              );
            }

            if (url.pathname === "/storeDriftAlerts") {
              return Promise.resolve(
                new Response(JSON.stringify({ stored: 1 }), {
                  status: 200,
                  headers: { "Content-Type": "application/json" },
                }),
              );
            }

            return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
          },
        } as unknown as DurableObjectStub;
      },
      idFromString(_hexId: string): DurableObjectId {
        return { toString: () => _hexId, equals: () => false } as unknown as DurableObjectId;
      },
      newUniqueId(): DurableObjectId {
        return { toString: () => "unique", equals: () => false } as unknown as DurableObjectId;
      },
      jurisdiction(_name: string): DurableObjectNamespace {
        return this;
      },
    } as unknown as DurableObjectNamespace & { calls: DOCallRecord[] };

    const doNamespace = createMockAccountDONamespace();
    const handler = createHandler();
    const env = {
      DB: d1,
      ACCOUNT: doNamespace,
      USER_GRAPH: userGraphNamespace,
      RECONCILE_QUEUE: queue,
    } as Env;
    const event = buildScheduledEvent(CRON_DRIFT_COMPUTATION);
    const ctx = buildMockCtx();

    await handler.scheduled(event, env, ctx);

    // Should call getDriftReport and storeDriftAlerts for the one distinct user
    const reportCalls = userGraphCalls.filter((c) => c.path === "/getDriftReport");
    const storeCalls = userGraphCalls.filter((c) => c.path === "/storeDriftAlerts");
    expect(reportCalls).toHaveLength(1);
    expect(storeCalls).toHaveLength(1);
    expect(reportCalls[0].accountId).toBe(TEST_USER.user_id);
    expect(storeCalls[0].accountId).toBe(TEST_USER.user_id);
  });

  it("skips error accounts (only processes active users)", async () => {
    insertAccount(db, { ...ACCOUNT_C_ERROR });

    const userGraphCalls: DOCallRecord[] = [];
    const userGraphNamespace = {
      calls: userGraphCalls,
      idFromName(name: string): DurableObjectId {
        return { toString: () => name, name, equals: () => false } as unknown as DurableObjectId;
      },
      get(_id: DurableObjectId): DurableObjectStub {
        return {
          fetch(): Promise<Response> {
            userGraphCalls.push({ accountId: _id.toString(), path: "/getDriftReport", method: "POST" });
            return Promise.resolve(new Response(JSON.stringify({ overdue: [], total_tracked: 0, total_overdue: 0, computed_at: new Date().toISOString() }), { status: 200 }));
          },
        } as unknown as DurableObjectStub;
      },
      idFromString(_hexId: string): DurableObjectId {
        return { toString: () => _hexId, equals: () => false } as unknown as DurableObjectId;
      },
      newUniqueId(): DurableObjectId {
        return { toString: () => "unique", equals: () => false } as unknown as DurableObjectId;
      },
      jurisdiction(_name: string): DurableObjectNamespace {
        return this;
      },
    } as unknown as DurableObjectNamespace & { calls: DOCallRecord[] };

    const doNamespace = createMockAccountDONamespace();
    const handler = createHandler();
    const env = {
      DB: d1,
      ACCOUNT: doNamespace,
      USER_GRAPH: userGraphNamespace,
      RECONCILE_QUEUE: queue,
    } as Env;
    const event = buildScheduledEvent(CRON_DRIFT_COMPUTATION);
    const ctx = buildMockCtx();

    await handler.scheduled(event, env, ctx);

    // No UserGraphDO calls (only error accounts exist)
    expect(userGraphCalls).toHaveLength(0);
  });

  it("continues processing when one user's drift computation fails", async () => {
    // Insert two different users
    const TEST_USER_2 = {
      user_id: "usr_01HXYZ00000000000000000002",
      org_id: TEST_ORG.org_id,
      email: "user2@example.com",
    };
    db.prepare(
      "INSERT INTO users (user_id, org_id, email) VALUES (?, ?, ?)",
    ).run(TEST_USER_2.user_id, TEST_USER_2.org_id, TEST_USER_2.email);

    insertAccount(db, { ...ACCOUNT_A });
    insertAccount(db, {
      account_id: "acc_01HXYZ0000000000000000000D",
      user_id: TEST_USER_2.user_id,
      provider: "google",
      provider_subject: "google-sub-dddd",
      email: "user2@gmail.com",
      status: "active",
    });

    const userGraphCalls: DOCallRecord[] = [];
    const userGraphNamespace = {
      calls: userGraphCalls,
      idFromName(name: string): DurableObjectId {
        return { toString: () => name, name, equals: () => false } as unknown as DurableObjectId;
      },
      get(_id: DurableObjectId): DurableObjectStub {
        const userId = _id.toString();
        return {
          fetch(input: RequestInfo | URL): Promise<Response> {
            const url = typeof input === "string" ? new URL(input) : input instanceof URL ? input : new URL(input.url);
            userGraphCalls.push({ accountId: userId, path: url.pathname, method: "POST" });

            // First user fails
            if (userId === TEST_USER.user_id && url.pathname === "/getDriftReport") {
              return Promise.resolve(new Response("Internal Error", { status: 500 }));
            }

            if (url.pathname === "/getDriftReport") {
              return Promise.resolve(
                new Response(JSON.stringify({ overdue: [], total_tracked: 0, total_overdue: 0, computed_at: new Date().toISOString() }), {
                  status: 200,
                  headers: { "Content-Type": "application/json" },
                }),
              );
            }

            if (url.pathname === "/storeDriftAlerts") {
              return Promise.resolve(
                new Response(JSON.stringify({ stored: 0 }), {
                  status: 200,
                  headers: { "Content-Type": "application/json" },
                }),
              );
            }

            return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
          },
        } as unknown as DurableObjectStub;
      },
      idFromString(_hexId: string): DurableObjectId {
        return { toString: () => _hexId, equals: () => false } as unknown as DurableObjectId;
      },
      newUniqueId(): DurableObjectId {
        return { toString: () => "unique", equals: () => false } as unknown as DurableObjectId;
      },
      jurisdiction(_name: string): DurableObjectNamespace {
        return this;
      },
    } as unknown as DurableObjectNamespace & { calls: DOCallRecord[] };

    const doNamespace = createMockAccountDONamespace();
    const handler = createHandler();
    const env = {
      DB: d1,
      ACCOUNT: doNamespace,
      USER_GRAPH: userGraphNamespace,
      RECONCILE_QUEUE: queue,
    } as Env;
    const event = buildScheduledEvent(CRON_DRIFT_COMPUTATION);
    const ctx = buildMockCtx();

    // Should not throw
    await handler.scheduled(event, env, ctx);

    // Both users should have getDriftReport attempted
    const reportCalls = userGraphCalls.filter((c) => c.path === "/getDriftReport");
    expect(reportCalls).toHaveLength(2);

    // Only user2 should have storeDriftAlerts (user1 failed at getDriftReport)
    const storeCalls = userGraphCalls.filter((c) => c.path === "/storeDriftAlerts");
    expect(storeCalls).toHaveLength(1);
    expect(storeCalls[0].accountId).toBe(TEST_USER_2.user_id);
  });

  it("does nothing when no active accounts exist", async () => {
    const userGraphCalls: DOCallRecord[] = [];
    const userGraphNamespace = {
      calls: userGraphCalls,
      idFromName(name: string): DurableObjectId {
        return { toString: () => name, name, equals: () => false } as unknown as DurableObjectId;
      },
      get(): DurableObjectStub {
        return {} as unknown as DurableObjectStub;
      },
      idFromString(_hexId: string): DurableObjectId {
        return { toString: () => _hexId, equals: () => false } as unknown as DurableObjectId;
      },
      newUniqueId(): DurableObjectId {
        return { toString: () => "unique", equals: () => false } as unknown as DurableObjectId;
      },
      jurisdiction(_name: string): DurableObjectNamespace {
        return this;
      },
    } as unknown as DurableObjectNamespace & { calls: DOCallRecord[] };

    const doNamespace = createMockAccountDONamespace();
    const handler = createHandler();
    const env = {
      DB: d1,
      ACCOUNT: doNamespace,
      USER_GRAPH: userGraphNamespace,
      RECONCILE_QUEUE: queue,
    } as Env;
    const event = buildScheduledEvent(CRON_DRIFT_COMPUTATION);
    const ctx = buildMockCtx();

    await handler.scheduled(event, env, ctx);

    // No DO calls
    expect(userGraphCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Integration test suite: ICS Feed Refresh (TM-d17.3)
// ---------------------------------------------------------------------------

const ACCOUNT_ICS_FEED = {
  account_id: "acc_01HXYZ00000000000000FEED01",
  user_id: TEST_USER.user_id,
  provider: "ics_feed",
  provider_subject: "https://example.com/feed.ics",
  email: "https://example.com/feed.ics",
  status: "active",
  channel_id: null,
  channel_token: null,
} as const;

const VALID_ICS_CONTENT = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
BEGIN:VEVENT
UID:refresh-event-001@example.com
DTSTART:20260301T090000Z
DTEND:20260301T100000Z
SUMMARY:Morning Standup
END:VEVENT
BEGIN:VEVENT
UID:refresh-event-002@example.com
DTSTART:20260302T140000Z
DTEND:20260302T150000Z
SUMMARY:Design Review
END:VEVENT
END:VCALENDAR`;

const CHANGED_ICS_CONTENT = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
BEGIN:VEVENT
UID:refresh-event-001@example.com
DTSTART:20260301T090000Z
DTEND:20260301T100000Z
SUMMARY:Morning Standup (Updated)
END:VEVENT
BEGIN:VEVENT
UID:refresh-event-003@example.com
DTSTART:20260303T100000Z
DTEND:20260303T110000Z
SUMMARY:New Meeting
END:VEVENT
END:VCALENDAR`;

describe("Cron integration tests: ICS Feed Refresh (TM-d17.3)", () => {
  let db: DatabaseType;
  let d1: D1Database;
  let queue: Queue & { messages: unknown[] };
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(MIGRATION_0001_INITIAL_SCHEMA);
    // Apply migrations for feed refresh columns
    db.exec(MIGRATION_0008_SYNC_STATUS_COLUMNS);
    db.exec(MIGRATION_0020_FEED_REFRESH);
    db.prepare("INSERT INTO orgs (org_id, name) VALUES (?, ?)").run(
      TEST_ORG.org_id,
      TEST_ORG.name,
    );
    db.prepare(
      "INSERT INTO users (user_id, org_id, email) VALUES (?, ?, ?)",
    ).run(TEST_USER.user_id, TEST_USER.org_id, TEST_USER.email);
    d1 = createRealD1(db);
    queue = createMockQueue();
  });

  afterEach(() => {
    db.close();
    globalThis.fetch = originalFetch;
  });

  it("fetches active ICS feed accounts and applies deltas to UserGraphDO", async () => {
    insertAccount(db, ACCOUNT_ICS_FEED);

    // Mock global fetch for the ICS feed URL
    globalThis.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("example.com/feed.ics")) {
        return new Response(VALID_ICS_CONTENT, {
          status: 200,
          headers: { "Content-Type": "text/calendar", "ETag": '"etag-001"' },
        });
      }
      return new Response("Not Found", { status: 404 });
    });

    // UserGraphDO mock
    const userGraphCalls: DOCallRecord[] = [];
    const userGraphNamespace = {
      calls: userGraphCalls,
      idFromName(name: string): DurableObjectId {
        return { toString: () => name, name, equals: () => false } as unknown as DurableObjectId;
      },
      get(_id: DurableObjectId): DurableObjectStub {
        return {
          fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
            const url = typeof input === "string" ? new URL(input) : input instanceof URL ? input : new URL(input.url);
            const method = init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET");
            userGraphCalls.push({ accountId: _id.toString(), path: url.pathname, method });
            return Promise.resolve(new Response(JSON.stringify({ created: 2, updated: 0, deleted: 0, mirrors_enqueued: 0, errors: [] }), {
              status: 200, headers: { "Content-Type": "application/json" },
            }));
          },
        } as unknown as DurableObjectStub;
      },
      idFromString: () => ({ toString: () => "x", equals: () => false } as unknown as DurableObjectId),
      newUniqueId: () => ({ toString: () => "x", equals: () => false } as unknown as DurableObjectId),
      jurisdiction: function() { return this; },
    } as unknown as DurableObjectNamespace & { calls: DOCallRecord[] };

    const doNamespace = createMockAccountDONamespace();
    const handler = createHandler();
    const env = {
      DB: d1,
      ACCOUNT: doNamespace,
      USER_GRAPH: userGraphNamespace,
      RECONCILE_QUEUE: queue,
    } as Env;
    const event = buildScheduledEvent(CRON_FEED_REFRESH);
    const ctx = buildMockCtx();

    await handler.scheduled(event, env, ctx);

    // UserGraphDO should have received applyProviderDelta call
    expect(userGraphCalls).toHaveLength(1);
    expect(userGraphCalls[0].path).toBe("/applyProviderDelta");
    expect(userGraphCalls[0].method).toBe("POST");

    // D1 should be updated with refresh metadata
    const row = db.prepare("SELECT feed_etag, feed_last_refresh_at, feed_content_hash, feed_consecutive_failures FROM accounts WHERE account_id = ?").get(ACCOUNT_ICS_FEED.account_id) as {
      feed_etag: string | null;
      feed_last_refresh_at: string | null;
      feed_content_hash: string | null;
      feed_consecutive_failures: number;
    };
    expect(row.feed_etag).toBe('"etag-001"');
    expect(row.feed_last_refresh_at).toBeTruthy();
    expect(row.feed_content_hash).toBeTruthy();
    expect(row.feed_consecutive_failures).toBe(0);
  });

  it("skips re-parsing when server returns 304 Not Modified (ETag match)", async () => {
    // Set up feed with existing etag
    insertAccount(db, ACCOUNT_ICS_FEED);
    db.prepare(
      `UPDATE accounts SET feed_etag = ?, feed_last_refresh_at = ?, feed_content_hash = ?
       WHERE account_id = ?`,
    ).run('"etag-001"', new Date(Date.now() - 20 * 60 * 1000).toISOString(), "abc123", ACCOUNT_ICS_FEED.account_id);

    // Mock fetch: return 304 Not Modified
    globalThis.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = (init as { headers?: Record<string, string> })?.headers ?? {};
      // Server recognizes the ETag
      if (headers["If-None-Match"] === '"etag-001"') {
        return new Response(null, { status: 304 });
      }
      return new Response(VALID_ICS_CONTENT, {
        status: 200,
        headers: { "Content-Type": "text/calendar" },
      });
    });

    const userGraphCalls: DOCallRecord[] = [];
    const userGraphNamespace = {
      calls: userGraphCalls,
      idFromName(name: string): DurableObjectId {
        return { toString: () => name, name, equals: () => false } as unknown as DurableObjectId;
      },
      get(): DurableObjectStub {
        return {
          fetch(): Promise<Response> {
            return Promise.resolve(new Response("should not be called", { status: 500 }));
          },
        } as unknown as DurableObjectStub;
      },
      idFromString: () => ({ toString: () => "x", equals: () => false } as unknown as DurableObjectId),
      newUniqueId: () => ({ toString: () => "x", equals: () => false } as unknown as DurableObjectId),
      jurisdiction: function() { return this; },
    } as unknown as DurableObjectNamespace & { calls: DOCallRecord[] };

    const doNamespace = createMockAccountDONamespace();
    const handler = createHandler();
    const env = {
      DB: d1,
      ACCOUNT: doNamespace,
      USER_GRAPH: userGraphNamespace,
      RECONCILE_QUEUE: queue,
    } as Env;
    const event = buildScheduledEvent(CRON_FEED_REFRESH);
    const ctx = buildMockCtx();

    await handler.scheduled(event, env, ctx);

    // Should NOT have called UserGraphDO (no change)
    expect(userGraphCalls).toHaveLength(0);

    // Should have sent conditional request with If-None-Match
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const sentHeaders = fetchCall[1]?.headers as Record<string, string>;
    expect(sentHeaders["If-None-Match"]).toBe('"etag-001"');

    // D1 metadata should still be updated (timestamp refreshed)
    const row = db.prepare("SELECT feed_last_refresh_at FROM accounts WHERE account_id = ?").get(ACCOUNT_ICS_FEED.account_id) as { feed_last_refresh_at: string | null };
    expect(row.feed_last_refresh_at).toBeTruthy();
  });

  it("skips feeds with manual-only refresh interval (0)", async () => {
    insertAccount(db, ACCOUNT_ICS_FEED);
    db.prepare("UPDATE accounts SET feed_refresh_interval_ms = 0 WHERE account_id = ?").run(ACCOUNT_ICS_FEED.account_id);

    globalThis.fetch = vi.fn();

    const userGraphNamespace = {
      idFromName: () => ({ toString: () => "x", equals: () => false } as unknown as DurableObjectId),
      get: () => ({} as unknown as DurableObjectStub),
      idFromString: () => ({ toString: () => "x", equals: () => false } as unknown as DurableObjectId),
      newUniqueId: () => ({ toString: () => "x", equals: () => false } as unknown as DurableObjectId),
      jurisdiction: function() { return this; },
    } as unknown as DurableObjectNamespace;

    const doNamespace = createMockAccountDONamespace();
    const handler = createHandler();
    const env = {
      DB: d1,
      ACCOUNT: doNamespace,
      USER_GRAPH: userGraphNamespace,
      RECONCILE_QUEUE: queue,
    } as Env;
    const event = buildScheduledEvent(CRON_FEED_REFRESH);
    const ctx = buildMockCtx();

    await handler.scheduled(event, env, ctx);

    // Should not fetch anything
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("respects rate limit: skips feed fetched less than 5 minutes ago (BR-4)", async () => {
    insertAccount(db, ACCOUNT_ICS_FEED);
    // Feed was fetched 2 minutes ago
    const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    db.prepare("UPDATE accounts SET feed_last_fetch_at = ? WHERE account_id = ?").run(twoMinAgo, ACCOUNT_ICS_FEED.account_id);

    globalThis.fetch = vi.fn();

    const userGraphNamespace = {
      idFromName: () => ({ toString: () => "x", equals: () => false } as unknown as DurableObjectId),
      get: () => ({} as unknown as DurableObjectStub),
      idFromString: () => ({ toString: () => "x", equals: () => false } as unknown as DurableObjectId),
      newUniqueId: () => ({ toString: () => "x", equals: () => false } as unknown as DurableObjectId),
      jurisdiction: function() { return this; },
    } as unknown as DurableObjectNamespace;

    const doNamespace = createMockAccountDONamespace();
    const handler = createHandler();
    const env = {
      DB: d1,
      ACCOUNT: doNamespace,
      USER_GRAPH: userGraphNamespace,
      RECONCILE_QUEUE: queue,
    } as Env;
    const event = buildScheduledEvent(CRON_FEED_REFRESH);
    const ctx = buildMockCtx();

    await handler.scheduled(event, env, ctx);

    // Should not fetch anything (rate limited)
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("marks feed as error when HTTP 404 (dead feed)", async () => {
    insertAccount(db, ACCOUNT_ICS_FEED);

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("Not Found", { status: 404 }),
    );

    const userGraphNamespace = {
      idFromName: () => ({ toString: () => "x", equals: () => false } as unknown as DurableObjectId),
      get: () => ({} as unknown as DurableObjectStub),
      idFromString: () => ({ toString: () => "x", equals: () => false } as unknown as DurableObjectId),
      newUniqueId: () => ({ toString: () => "x", equals: () => false } as unknown as DurableObjectId),
      jurisdiction: function() { return this; },
    } as unknown as DurableObjectNamespace;

    const doNamespace = createMockAccountDONamespace();
    const handler = createHandler();
    const env = {
      DB: d1,
      ACCOUNT: doNamespace,
      USER_GRAPH: userGraphNamespace,
      RECONCILE_QUEUE: queue,
    } as Env;
    const event = buildScheduledEvent(CRON_FEED_REFRESH);
    const ctx = buildMockCtx();

    await handler.scheduled(event, env, ctx);

    // Feed should be marked as error in D1
    const row = db.prepare("SELECT status, feed_consecutive_failures FROM accounts WHERE account_id = ?").get(ACCOUNT_ICS_FEED.account_id) as { status: string; feed_consecutive_failures: number };
    expect(row.status).toBe("error");
    expect(row.feed_consecutive_failures).toBe(1);
  });

  it("marks feed as error when HTTP 401 (auth required)", async () => {
    insertAccount(db, ACCOUNT_ICS_FEED);

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("Unauthorized", { status: 401 }),
    );

    const userGraphNamespace = {
      idFromName: () => ({ toString: () => "x", equals: () => false } as unknown as DurableObjectId),
      get: () => ({} as unknown as DurableObjectStub),
      idFromString: () => ({ toString: () => "x", equals: () => false } as unknown as DurableObjectId),
      newUniqueId: () => ({ toString: () => "x", equals: () => false } as unknown as DurableObjectId),
      jurisdiction: function() { return this; },
    } as unknown as DurableObjectNamespace;

    const doNamespace = createMockAccountDONamespace();
    const handler = createHandler();
    const env = {
      DB: d1,
      ACCOUNT: doNamespace,
      USER_GRAPH: userGraphNamespace,
      RECONCILE_QUEUE: queue,
    } as Env;
    const event = buildScheduledEvent(CRON_FEED_REFRESH);
    const ctx = buildMockCtx();

    await handler.scheduled(event, env, ctx);

    const row = db.prepare("SELECT status, feed_consecutive_failures FROM accounts WHERE account_id = ?").get(ACCOUNT_ICS_FEED.account_id) as { status: string; feed_consecutive_failures: number };
    expect(row.status).toBe("error");
    expect(row.feed_consecutive_failures).toBe(1);
  });

  it("increments consecutive failures on server error but keeps status active", async () => {
    insertAccount(db, ACCOUNT_ICS_FEED);

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("Internal Server Error", { status: 500 }),
    );

    const userGraphNamespace = {
      idFromName: () => ({ toString: () => "x", equals: () => false } as unknown as DurableObjectId),
      get: () => ({} as unknown as DurableObjectStub),
      idFromString: () => ({ toString: () => "x", equals: () => false } as unknown as DurableObjectId),
      newUniqueId: () => ({ toString: () => "x", equals: () => false } as unknown as DurableObjectId),
      jurisdiction: function() { return this; },
    } as unknown as DurableObjectNamespace;

    const doNamespace = createMockAccountDONamespace();
    const handler = createHandler();
    const env = {
      DB: d1,
      ACCOUNT: doNamespace,
      USER_GRAPH: userGraphNamespace,
      RECONCILE_QUEUE: queue,
    } as Env;
    const event = buildScheduledEvent(CRON_FEED_REFRESH);
    const ctx = buildMockCtx();

    await handler.scheduled(event, env, ctx);

    // Status stays active for server errors (retryable)
    const row = db.prepare("SELECT status, feed_consecutive_failures FROM accounts WHERE account_id = ?").get(ACCOUNT_ICS_FEED.account_id) as { status: string; feed_consecutive_failures: number };
    expect(row.status).toBe("active");
    expect(row.feed_consecutive_failures).toBe(1);
  });

  it("does not fetch non-ICS feeds (Google, Microsoft accounts)", async () => {
    insertAccount(db, { ...ACCOUNT_A });  // Google account

    globalThis.fetch = vi.fn();

    const userGraphNamespace = {
      idFromName: () => ({ toString: () => "x", equals: () => false } as unknown as DurableObjectId),
      get: () => ({} as unknown as DurableObjectStub),
      idFromString: () => ({ toString: () => "x", equals: () => false } as unknown as DurableObjectId),
      newUniqueId: () => ({ toString: () => "x", equals: () => false } as unknown as DurableObjectId),
      jurisdiction: function() { return this; },
    } as unknown as DurableObjectNamespace;

    const doNamespace = createMockAccountDONamespace();
    const handler = createHandler();
    const env = {
      DB: d1,
      ACCOUNT: doNamespace,
      USER_GRAPH: userGraphNamespace,
      RECONCILE_QUEUE: queue,
    } as Env;
    const event = buildScheduledEvent(CRON_FEED_REFRESH);
    const ctx = buildMockCtx();

    await handler.scheduled(event, env, ctx);

    // Should not fetch anything (not an ICS feed)
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("handles network errors gracefully", async () => {
    insertAccount(db, ACCOUNT_ICS_FEED);

    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network timeout"));

    const userGraphNamespace = {
      idFromName: () => ({ toString: () => "x", equals: () => false } as unknown as DurableObjectId),
      get: () => ({} as unknown as DurableObjectStub),
      idFromString: () => ({ toString: () => "x", equals: () => false } as unknown as DurableObjectId),
      newUniqueId: () => ({ toString: () => "x", equals: () => false } as unknown as DurableObjectId),
      jurisdiction: function() { return this; },
    } as unknown as DurableObjectNamespace;

    const doNamespace = createMockAccountDONamespace();
    const handler = createHandler();
    const env = {
      DB: d1,
      ACCOUNT: doNamespace,
      USER_GRAPH: userGraphNamespace,
      RECONCILE_QUEUE: queue,
    } as Env;
    const event = buildScheduledEvent(CRON_FEED_REFRESH);
    const ctx = buildMockCtx();

    // Should not throw
    await handler.scheduled(event, env, ctx);

    // Consecutive failures should increment
    const row = db.prepare("SELECT feed_consecutive_failures, feed_last_fetch_at FROM accounts WHERE account_id = ?").get(ACCOUNT_ICS_FEED.account_id) as { feed_consecutive_failures: number; feed_last_fetch_at: string | null };
    expect(row.feed_consecutive_failures).toBe(1);
    expect(row.feed_last_fetch_at).toBeTruthy();
  });

  it("continues processing other feeds when one feed fails", async () => {
    // Insert two feeds
    insertAccount(db, ACCOUNT_ICS_FEED);
    const FEED_B = {
      ...ACCOUNT_ICS_FEED,
      account_id: "acc_01HXYZ00000000000000FEED02",
      provider_subject: "https://example.com/feed-b.ics",
      email: "https://example.com/feed-b.ics",
    };
    insertAccount(db, FEED_B);

    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      callCount++;
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("feed.ics")) {
        throw new Error("Network error for feed A");
      }
      return new Response(VALID_ICS_CONTENT, {
        status: 200,
        headers: { "Content-Type": "text/calendar" },
      });
    });

    const userGraphCalls: DOCallRecord[] = [];
    const userGraphNamespace = {
      calls: userGraphCalls,
      idFromName(name: string): DurableObjectId {
        return { toString: () => name, name, equals: () => false } as unknown as DurableObjectId;
      },
      get(_id: DurableObjectId): DurableObjectStub {
        return {
          fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
            const url = typeof input === "string" ? new URL(input) : input instanceof URL ? input : new URL(input.url);
            const method = init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET");
            userGraphCalls.push({ accountId: _id.toString(), path: url.pathname, method });
            return Promise.resolve(new Response(JSON.stringify({ created: 2, updated: 0, deleted: 0, mirrors_enqueued: 0, errors: [] }), {
              status: 200, headers: { "Content-Type": "application/json" },
            }));
          },
        } as unknown as DurableObjectStub;
      },
      idFromString: () => ({ toString: () => "x", equals: () => false } as unknown as DurableObjectId),
      newUniqueId: () => ({ toString: () => "x", equals: () => false } as unknown as DurableObjectId),
      jurisdiction: function() { return this; },
    } as unknown as DurableObjectNamespace & { calls: DOCallRecord[] };

    const doNamespace = createMockAccountDONamespace();
    const handler = createHandler();
    const env = {
      DB: d1,
      ACCOUNT: doNamespace,
      USER_GRAPH: userGraphNamespace,
      RECONCILE_QUEUE: queue,
    } as Env;
    const event = buildScheduledEvent(CRON_FEED_REFRESH);
    const ctx = buildMockCtx();

    await handler.scheduled(event, env, ctx);

    // Both feeds should be attempted
    expect(callCount).toBe(2);
    // Feed B should have succeeded
    expect(userGraphCalls).toHaveLength(1);
  });
});
