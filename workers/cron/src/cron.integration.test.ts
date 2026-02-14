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
import { MIGRATION_0001_INITIAL_SCHEMA } from "@tminus/d1-registry";
import { createHandler } from "./index";
import {
  CRON_CHANNEL_RENEWAL,
  CRON_TOKEN_HEALTH,
  CRON_RECONCILIATION,
  CHANNEL_RENEWAL_THRESHOLD_MS,
  MS_SUBSCRIPTION_RENEWAL_THRESHOLD_MS,
} from "./constants";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_ORG = {
  org_id: "org_01HXYZ000000000000000001",
  name: "Cron Test Org",
} as const;

const TEST_USER = {
  user_id: "usr_01HXYZ000000000000000001",
  org_id: TEST_ORG.org_id,
  email: "cron-test@example.com",
} as const;

const ACCOUNT_A = {
  account_id: "acc_01HXYZ00000000000000000A",
  user_id: TEST_USER.user_id,
  provider: "google",
  provider_subject: "google-sub-aaaa",
  email: "alice@gmail.com",
  status: "active",
  channel_id: "channel-aaa-111",
  channel_token: "secret-token-alpha",
} as const;

const ACCOUNT_B = {
  account_id: "acc_01HXYZ00000000000000000B",
  user_id: TEST_USER.user_id,
  provider: "google",
  provider_subject: "google-sub-bbbb",
  email: "bob@gmail.com",
  status: "active",
  channel_id: "channel-bbb-222",
  channel_token: "secret-token-beta",
} as const;

const ACCOUNT_C_ERROR = {
  account_id: "acc_01HXYZ00000000000000000C",
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

  it("renews channels expiring within 24 hours", async () => {
    // Channel expires in 12 hours (within threshold)
    const expiresIn12h = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
    insertAccount(db, {
      ...ACCOUNT_A,
      channel_expiry_ts: expiresIn12h,
    });

    const doNamespace = createMockAccountDONamespace();
    const handler = createHandler();
    const env = { DB: d1, ACCOUNT: doNamespace, RECONCILE_QUEUE: queue } as Env;
    const event = buildScheduledEvent(CRON_CHANNEL_RENEWAL);
    const ctx = buildMockCtx();

    await handler.scheduled(event, env, ctx);

    // AccountDO.renewChannel() should have been called
    expect(doNamespace.calls).toHaveLength(1);
    expect(doNamespace.calls[0].accountId).toBe(ACCOUNT_A.account_id);
    expect(doNamespace.calls[0].path).toBe("/renewChannel");
    expect(doNamespace.calls[0].method).toBe("POST");
  });

  it("does NOT renew channels expiring in more than 24 hours", async () => {
    // Channel expires in 48 hours (outside threshold)
    const expiresIn48h = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
    insertAccount(db, {
      ...ACCOUNT_A,
      channel_expiry_ts: expiresIn48h,
    });

    const doNamespace = createMockAccountDONamespace();
    const handler = createHandler();
    const env = { DB: d1, ACCOUNT: doNamespace, RECONCILE_QUEUE: queue } as Env;
    const event = buildScheduledEvent(CRON_CHANNEL_RENEWAL);
    const ctx = buildMockCtx();

    await handler.scheduled(event, env, ctx);

    // No DO calls -- channel is not expiring soon
    expect(doNamespace.calls).toHaveLength(0);
  });

  it("renews multiple expiring channels in a single run", async () => {
    const expiresIn6h = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    insertAccount(db, {
      ...ACCOUNT_A,
      channel_expiry_ts: expiresIn6h,
    });
    insertAccount(db, {
      ...ACCOUNT_B,
      channel_expiry_ts: expiresIn6h,
    });

    const doNamespace = createMockAccountDONamespace();
    const handler = createHandler();
    const env = { DB: d1, ACCOUNT: doNamespace, RECONCILE_QUEUE: queue } as Env;
    const event = buildScheduledEvent(CRON_CHANNEL_RENEWAL);
    const ctx = buildMockCtx();

    await handler.scheduled(event, env, ctx);

    // Both accounts should have renewChannel called
    expect(doNamespace.calls).toHaveLength(2);
    const calledAccountIds = doNamespace.calls.map((c) => c.accountId).sort();
    expect(calledAccountIds).toEqual(
      [ACCOUNT_A.account_id, ACCOUNT_B.account_id].sort(),
    );
  });

  it("skips accounts with null channel_expiry_ts", async () => {
    insertAccount(db, {
      ...ACCOUNT_A,
      channel_expiry_ts: null,
    });

    const doNamespace = createMockAccountDONamespace();
    const handler = createHandler();
    const env = { DB: d1, ACCOUNT: doNamespace, RECONCILE_QUEUE: queue } as Env;
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
    const env = { DB: d1, ACCOUNT: doNamespace, RECONCILE_QUEUE: queue } as Env;
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

    // Account A returns 500, Account B succeeds
    const responses = new Map<string, Map<string, Response>>();
    responses.set(
      ACCOUNT_A.account_id,
      new Map([["/renewChannel", new Response("Internal Error", { status: 500 })]]),
    );

    const doNamespace = createMockAccountDONamespace({ responses });
    const handler = createHandler();
    const env = { DB: d1, ACCOUNT: doNamespace, RECONCILE_QUEUE: queue } as Env;
    const event = buildScheduledEvent(CRON_CHANNEL_RENEWAL);
    const ctx = buildMockCtx();

    await handler.scheduled(event, env, ctx);

    // Both should be attempted (error is caught, not thrown)
    expect(doNamespace.calls).toHaveLength(2);
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
  account_id: "acc_01HXYZ0000000000000000MS",
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
