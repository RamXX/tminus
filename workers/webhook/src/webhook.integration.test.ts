/**
 * Integration tests for tminus-webhook worker.
 *
 * These tests use better-sqlite3 (the same SQLite engine underlying Cloudflare D1)
 * to create a REAL in-memory database with the actual accounts table schema.
 * The D1 mock wraps better-sqlite3 so all SQL queries execute against real SQLite,
 * proving the handler's SQL syntax and table schema assumptions are correct.
 *
 * Queue is mocked with a message-capturing stub (acceptable: queues are an
 * external service boundary -- we verify the messages sent, not queue internals).
 *
 * Each test exercises the FULL handler flow: createHandler() -> fetch() -> response,
 * with real SQL executing against real table structures.
 *
 * Per-scope routing tests (TM-8gfd.4):
 * - Google webhook resolves to account + scoped calendar_id
 * - Microsoft webhook resolves to account + scoped calendar_id (direct + legacy)
 * - Legacy channels (null calendar_id) emit telemetry, enqueue with null
 * - Unknown/expired channels handled with safe no-op
 * - Security: clientState mismatch blocks processing
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { createHandler } from "./index";
import {
  MIGRATION_0001_INITIAL_SCHEMA,
  MIGRATION_0002_MS_SUBSCRIPTIONS,
  MIGRATION_0008_SYNC_STATUS_COLUMNS,
  MIGRATION_0027_WEBHOOK_SCOPE_ROUTING,
} from "@tminus/d1-registry";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_ORG = {
  org_id: "org_01HXYZ00000000000000000001",
  name: "Integration Test Org",
} as const;

const TEST_USER = {
  user_id: "usr_01HXYZ00000000000000000001",
  org_id: TEST_ORG.org_id,
  email: "integration@example.com",
} as const;

const ACCOUNT_A = {
  account_id: "acc_01HXYZ0000000000000000000A",
  user_id: TEST_USER.user_id,
  provider: "google",
  provider_subject: "google-sub-aaaa",
  email: "alice@gmail.com",
  channel_token: "secret-token-alpha",
} as const;

const ACCOUNT_B = {
  account_id: "acc_01HXYZ0000000000000000000B",
  user_id: TEST_USER.user_id,
  provider: "google",
  provider_subject: "google-sub-bbbb",
  email: "alice-work@gmail.com",
  channel_token: "secret-token-beta",
} as const;

const TEST_CHANNEL_ID = "channel-uuid-integration-12345";
const TEST_RESOURCE_ID = "resource-id-integration-67890";

// ---------------------------------------------------------------------------
// Real D1 mock backed by better-sqlite3
// ---------------------------------------------------------------------------

/**
 * Creates a D1Database-compatible wrapper around better-sqlite3.
 *
 * This is a genuine integration test mock: all SQL queries execute against
 * a real SQLite database with real tables, real indexes, and real constraints.
 * The D1 API surface is minimal -- we only need prepare().bind().first() for
 * the webhook handler's single query.
 */
function createRealD1(db: DatabaseType): D1Database {
  // D1 uses ?1, ?2, ... for positional parameters; better-sqlite3 uses plain ?.
  // Since bind() passes params in order, a simple replacement is correct.
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
      // Not used by webhook handler
    },
  } as unknown as Queue & { messages: unknown[] };
}

// ---------------------------------------------------------------------------
// Request builder
// ---------------------------------------------------------------------------

function buildWebhookRequest(overrides?: {
  channelId?: string;
  resourceId?: string;
  resourceState?: string;
  channelToken?: string;
}): Request {
  const headers: Record<string, string> = {};

  headers["X-Goog-Channel-ID"] = overrides?.channelId ?? TEST_CHANNEL_ID;
  headers["X-Goog-Resource-ID"] = overrides?.resourceId ?? TEST_RESOURCE_ID;
  headers["X-Goog-Resource-State"] = overrides?.resourceState ?? "exists";
  headers["X-Goog-Channel-Token"] = overrides?.channelToken ?? ACCOUNT_A.channel_token;

  return new Request("https://webhook.tminus.dev/webhook/google", {
    method: "POST",
    headers,
  });
}

const mockCtx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

// ---------------------------------------------------------------------------
// Integration test suite
// ---------------------------------------------------------------------------

describe("Webhook integration tests (real SQLite via better-sqlite3)", () => {
  let db: DatabaseType;
  let d1: D1Database;
  let queue: Queue & { messages: unknown[] };

  beforeEach(() => {
    // Create a fresh in-memory SQLite database for each test
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");

    // Apply the REAL D1 registry schema -- the same SQL used in production
    db.exec(MIGRATION_0001_INITIAL_SCHEMA);
    db.exec(MIGRATION_0002_MS_SUBSCRIPTIONS);
    db.exec(MIGRATION_0008_SYNC_STATUS_COLUMNS);
    db.exec(MIGRATION_0027_WEBHOOK_SCOPE_ROUTING);

    // Seed the prerequisite rows (FK chain: orgs -> users -> accounts)
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

  // -------------------------------------------------------------------------
  // Google per-scope routing (AC 1)
  // -------------------------------------------------------------------------

  it("Google webhook resolves to account + scoped calendar_id (AC 1)", async () => {
    db.prepare(
      `INSERT INTO accounts (account_id, user_id, provider, provider_subject, email, channel_token, channel_calendar_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      ACCOUNT_A.account_id,
      ACCOUNT_A.user_id,
      ACCOUNT_A.provider,
      ACCOUNT_A.provider_subject,
      ACCOUNT_A.email,
      ACCOUNT_A.channel_token,
      "work-calendar-123",
    );

    const handler = createHandler();
    const env = { DB: d1, SYNC_QUEUE: queue, MS_WEBHOOK_CLIENT_STATE: "test-ms-secret" } as Env;
    const request = buildWebhookRequest({ channelToken: ACCOUNT_A.channel_token });

    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(200);
    expect(queue.messages).toHaveLength(1);

    const msg = queue.messages[0] as Record<string, unknown>;
    expect(msg.type).toBe("SYNC_INCREMENTAL");
    expect(msg.account_id).toBe(ACCOUNT_A.account_id);
    expect(msg.calendar_id).toBe("work-calendar-123");
  });

  it("Google webhook with legacy channel (null calendar_id) enqueues with calendar_id: null (AC 4)", async () => {
    db.prepare(
      `INSERT INTO accounts (account_id, user_id, provider, provider_subject, email, channel_token)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      ACCOUNT_A.account_id,
      ACCOUNT_A.user_id,
      ACCOUNT_A.provider,
      ACCOUNT_A.provider_subject,
      ACCOUNT_A.email,
      ACCOUNT_A.channel_token,
    );

    const handler = createHandler();
    const env = { DB: d1, SYNC_QUEUE: queue, MS_WEBHOOK_CLIENT_STATE: "test-ms-secret" } as Env;
    const request = buildWebhookRequest({ channelToken: ACCOUNT_A.channel_token });

    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(200);
    expect(queue.messages).toHaveLength(1);

    const msg = queue.messages[0] as Record<string, unknown>;
    expect(msg.type).toBe("SYNC_INCREMENTAL");
    expect(msg.account_id).toBe(ACCOUNT_A.account_id);
    expect(msg.calendar_id).toBeNull();
  });

  it("multiple accounts: webhook routes to correct account and calendar based on channel_token", async () => {
    db.prepare(
      `INSERT INTO accounts (account_id, user_id, provider, provider_subject, email, channel_token, channel_calendar_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      ACCOUNT_A.account_id,
      ACCOUNT_A.user_id,
      ACCOUNT_A.provider,
      ACCOUNT_A.provider_subject,
      ACCOUNT_A.email,
      ACCOUNT_A.channel_token,
      "cal-personal",
    );

    db.prepare(
      `INSERT INTO accounts (account_id, user_id, provider, provider_subject, email, channel_token, channel_calendar_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      ACCOUNT_B.account_id,
      ACCOUNT_B.user_id,
      ACCOUNT_B.provider,
      ACCOUNT_B.provider_subject,
      ACCOUNT_B.email,
      ACCOUNT_B.channel_token,
      "cal-work",
    );

    const handler = createHandler();
    const env = { DB: d1, SYNC_QUEUE: queue, MS_WEBHOOK_CLIENT_STATE: "test-ms-secret" } as Env;

    const request = buildWebhookRequest({ channelToken: ACCOUNT_B.channel_token });
    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(200);
    expect(queue.messages).toHaveLength(1);

    const msg = queue.messages[0] as Record<string, unknown>;
    expect(msg.account_id).toBe(ACCOUNT_B.account_id);
    expect(msg.calendar_id).toBe("cal-work");
    expect(msg.account_id).not.toBe(ACCOUNT_A.account_id);
  });

  // -------------------------------------------------------------------------
  // Google unknown/expired channel handling (AC 4)
  // -------------------------------------------------------------------------

  it("unknown channel_token: returns 200, no enqueue (safe no-op)", async () => {
    db.prepare(
      `INSERT INTO accounts (account_id, user_id, provider, provider_subject, email, channel_token)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      ACCOUNT_A.account_id,
      ACCOUNT_A.user_id,
      ACCOUNT_A.provider,
      ACCOUNT_A.provider_subject,
      ACCOUNT_A.email,
      ACCOUNT_A.channel_token,
    );

    const handler = createHandler();
    const env = { DB: d1, SYNC_QUEUE: queue, MS_WEBHOOK_CLIENT_STATE: "test-ms-secret" } as Env;
    const request = buildWebhookRequest({ channelToken: "completely-unknown-token" });

    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(200);
    expect(queue.messages).toHaveLength(0);
  });

  it("sync resource_state: returns 200 immediately, no D1 query, no enqueue", async () => {
    const handler = createHandler();
    const env = { DB: d1, SYNC_QUEUE: queue, MS_WEBHOOK_CLIENT_STATE: "test-ms-secret" } as Env;
    const request = buildWebhookRequest({ resourceState: "sync" });

    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(200);
    expect(queue.messages).toHaveLength(0);
  });

  it("empty accounts table: D1 query returns null gracefully, no enqueue", async () => {
    const handler = createHandler();
    const env = { DB: d1, SYNC_QUEUE: queue, MS_WEBHOOK_CLIENT_STATE: "test-ms-secret" } as Env;
    const request = buildWebhookRequest({ channelToken: "any-token" });

    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(200);
    expect(queue.messages).toHaveLength(0);
  });

  it("not_exists resource_state: full flow enqueues incremental + reconcile full sync", async () => {
    db.prepare(
      `INSERT INTO accounts (account_id, user_id, provider, provider_subject, email, channel_token, channel_calendar_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      ACCOUNT_A.account_id,
      ACCOUNT_A.user_id,
      ACCOUNT_A.provider,
      ACCOUNT_A.provider_subject,
      ACCOUNT_A.email,
      ACCOUNT_A.channel_token,
      "primary",
    );

    const handler = createHandler();
    const env = { DB: d1, SYNC_QUEUE: queue, MS_WEBHOOK_CLIENT_STATE: "test-ms-secret" } as Env;
    const request = buildWebhookRequest({
      channelToken: ACCOUNT_A.channel_token,
      resourceState: "not_exists",
    });

    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(200);
    expect(queue.messages).toHaveLength(2);

    const incrementalMsg = queue.messages[0] as Record<string, unknown>;
    expect(incrementalMsg.type).toBe("SYNC_INCREMENTAL");
    expect(incrementalMsg.account_id).toBe(ACCOUNT_A.account_id);
    expect(incrementalMsg.calendar_id).toBe("primary");

    const fullMsg = queue.messages[1] as Record<string, unknown>;
    expect(fullMsg.type).toBe("SYNC_FULL");
    expect(fullMsg.account_id).toBe(ACCOUNT_A.account_id);
    expect(fullMsg.reason).toBe("reconcile");
  });

  // -------------------------------------------------------------------------
  // D1 schema validation
  // -------------------------------------------------------------------------

  it("handler SQL query correctly includes channel_calendar_id from real D1", async () => {
    db.prepare(
      `INSERT INTO accounts (account_id, user_id, provider, provider_subject, email, channel_token, channel_calendar_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      ACCOUNT_A.account_id,
      ACCOUNT_A.user_id,
      ACCOUNT_A.provider,
      ACCOUNT_A.provider_subject,
      ACCOUNT_A.email,
      ACCOUNT_A.channel_token,
      "specific-calendar-xyz",
    );

    const result = await d1
      .prepare("SELECT account_id, channel_calendar_id FROM accounts WHERE channel_token = ?1")
      .bind(ACCOUNT_A.channel_token)
      .first<{ account_id: string; channel_calendar_id: string | null }>();

    expect(result).not.toBeNull();
    expect(result!.account_id).toBe(ACCOUNT_A.account_id);
    expect(result!.channel_calendar_id).toBe("specific-calendar-xyz");
  });

  // -------------------------------------------------------------------------
  // Microsoft per-scope routing (AC 2)
  // -------------------------------------------------------------------------

  it("Microsoft validation handshake: returns validationToken as plain text", async () => {
    const handler = createHandler();
    const env = { DB: d1, SYNC_QUEUE: queue, MS_WEBHOOK_CLIENT_STATE: "test-ms-secret" } as Env;

    const request = new Request(
      "https://webhook.tminus.dev/webhook/microsoft?validationToken=real-validation-abc",
      { method: "POST" },
    );
    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toBe("real-validation-abc");
    expect(response.headers.get("Content-Type")).toBe("text/plain");
  });

  it("Microsoft webhook resolves to account + scoped calendar_id via direct lookup (AC 2)", async () => {
    db.prepare(
      `INSERT INTO accounts
       (account_id, user_id, provider, provider_subject, email, status, channel_id, channel_token, channel_calendar_id)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    ).run(
      ACCOUNT_A.account_id,
      ACCOUNT_A.user_id,
      "microsoft",
      "ms-sub-aaaa",
      ACCOUNT_A.email,
      "ms-sub-real-123",
      "ms-client-state-123",
      "AAMkAGU0OGRh",
    );

    const handler = createHandler();
    const env = { DB: d1, SYNC_QUEUE: queue, MS_WEBHOOK_CLIENT_STATE: "test-ms-secret" } as Env;

    const body = {
      value: [{
        subscriptionId: "ms-sub-real-123",
        changeType: "updated",
        clientState: "ms-client-state-123",
        resource: "users/ms-user/events/evt-42",
      }],
    };
    const request = new Request("https://webhook.tminus.dev/webhook/microsoft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(202);
    expect(queue.messages).toHaveLength(1);

    const msg = queue.messages[0] as Record<string, unknown>;
    expect(msg.type).toBe("SYNC_INCREMENTAL");
    expect(msg.account_id).toBe(ACCOUNT_A.account_id);
    expect(msg.channel_id).toBe("ms-sub-real-123");
    expect(msg.calendar_id).toBe("AAMkAGU0OGRh");
  });

  it("Microsoft legacy fallback: ms_subscriptions join resolves calendar_id (AC 2)", async () => {
    db.prepare(
      `INSERT INTO accounts
       (account_id, user_id, provider, provider_subject, email, status, channel_token)
       VALUES (?, ?, ?, ?, ?, 'active', ?)`,
    ).run(
      "acc_sql_test",
      TEST_USER.user_id,
      "microsoft",
      "ms-sub-fallback",
      "legacy@example.com",
      "legacy-client-state",
    );

    db.prepare(
      "INSERT INTO ms_subscriptions (subscription_id, account_id, calendar_id) VALUES (?, ?, ?)",
    ).run("ms-sub-verify-sql", "acc_sql_test", "legacy-cal-abc");

    const handler = createHandler();
    const env = { DB: d1, SYNC_QUEUE: queue, MS_WEBHOOK_CLIENT_STATE: "test-ms-secret" } as Env;

    const body = {
      value: [{
        subscriptionId: "ms-sub-verify-sql",
        changeType: "updated",
        clientState: "legacy-client-state",
        resource: "users/x/events/y",
      }],
    };
    const request = new Request("https://webhook.tminus.dev/webhook/microsoft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(202);
    expect(queue.messages).toHaveLength(1);
    const msg = queue.messages[0] as Record<string, unknown>;
    expect(msg.account_id).toBe("acc_sql_test");
    expect(msg.calendar_id).toBe("legacy-cal-abc");
  });

  it("Microsoft legacy subscription without calendar_id enqueues with null (AC 4)", async () => {
    db.prepare(
      `INSERT INTO accounts
       (account_id, user_id, provider, provider_subject, email, status, channel_token)
       VALUES (?, ?, ?, ?, ?, 'active', ?)`,
    ).run(
      "acc_legacy_no_cal",
      TEST_USER.user_id,
      "microsoft",
      "ms-sub-legacy-nocal",
      "legacy-nocal@example.com",
      "legacy-state-nocal",
    );

    // Legacy ms_subscriptions row WITHOUT calendar_id
    db.prepare(
      "INSERT INTO ms_subscriptions (subscription_id, account_id) VALUES (?, ?)",
    ).run("ms-sub-legacy-nocal", "acc_legacy_no_cal");

    const handler = createHandler();
    const env = { DB: d1, SYNC_QUEUE: queue, MS_WEBHOOK_CLIENT_STATE: "test-ms-secret" } as Env;

    const body = {
      value: [{
        subscriptionId: "ms-sub-legacy-nocal",
        changeType: "updated",
        clientState: "legacy-state-nocal",
        resource: "users/x/events/y",
      }],
    };
    const request = new Request("https://webhook.tminus.dev/webhook/microsoft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(202);
    expect(queue.messages).toHaveLength(1);
    const msg = queue.messages[0] as Record<string, unknown>;
    expect(msg.calendar_id).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Microsoft security checks (AC 5)
  // -------------------------------------------------------------------------

  it("Microsoft clientState mismatch: returns 202 and skips enqueue (AC 5)", async () => {
    db.prepare(
      `INSERT INTO accounts
       (account_id, user_id, provider, provider_subject, email, status, channel_id, channel_token)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
    ).run(
      ACCOUNT_A.account_id,
      ACCOUNT_A.user_id,
      "microsoft",
      "ms-sub-any-subject",
      ACCOUNT_A.email,
      "ms-sub-any",
      "expected-client-state",
    );

    const handler = createHandler();
    const env = { DB: d1, SYNC_QUEUE: queue, MS_WEBHOOK_CLIENT_STATE: "test-ms-secret" } as Env;

    const body = {
      value: [{
        subscriptionId: "ms-sub-any",
        changeType: "created",
        clientState: "WRONG-secret",
        resource: "users/x/events/y",
      }],
    };
    const request = new Request("https://webhook.tminus.dev/webhook/microsoft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(202);
    expect(queue.messages).toHaveLength(0);
  });

  it("Microsoft mixed payload: valid notifications enqueue, mismatched skip (AC 5)", async () => {
    db.prepare(
      `INSERT INTO accounts
       (account_id, user_id, provider, provider_subject, email, status, channel_id, channel_token, channel_calendar_id)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    ).run(
      "acc_ms_valid_mix",
      TEST_USER.user_id,
      "microsoft",
      "ms-sub-valid-mix",
      "valid.mix@example.com",
      "ms-sub-valid-mix",
      "valid-secret",
      "cal-valid-mix",
    );

    db.prepare(
      `INSERT INTO accounts
       (account_id, user_id, provider, provider_subject, email, status, channel_id, channel_token)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
    ).run(
      "acc_ms_bad_mix",
      TEST_USER.user_id,
      "microsoft",
      "ms-sub-bad-mix",
      "bad.mix@example.com",
      "ms-sub-bad-mix",
      "expected-bad-secret",
    );

    const handler = createHandler();
    const env = { DB: d1, SYNC_QUEUE: queue, MS_WEBHOOK_CLIENT_STATE: "test-ms-secret" } as Env;

    const body = {
      value: [
        {
          subscriptionId: "ms-sub-bad-mix",
          changeType: "updated",
          clientState: "WRONG-secret",
          resource: "users/x/events/y",
        },
        {
          subscriptionId: "ms-sub-valid-mix",
          changeType: "created",
          clientState: "valid-secret",
          resource: "users/x/events/z",
        },
      ],
    };
    const request = new Request("https://webhook.tminus.dev/webhook/microsoft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(202);
    expect(queue.messages).toHaveLength(1);
    const msg = queue.messages[0] as Record<string, unknown>;
    expect(msg.account_id).toBe("acc_ms_valid_mix");
    expect(msg.calendar_id).toBe("cal-valid-mix");
  });

  it("Microsoft unknown subscriptionId: returns 202 but does not enqueue (AC 4)", async () => {
    const handler = createHandler();
    const env = { DB: d1, SYNC_QUEUE: queue, MS_WEBHOOK_CLIENT_STATE: "test-ms-secret" } as Env;

    const body = {
      value: [{
        subscriptionId: "ms-sub-unknown",
        changeType: "updated",
        clientState: "test-ms-secret",
        resource: "users/x/events/y",
      }],
    };
    const request = new Request("https://webhook.tminus.dev/webhook/microsoft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(202);
    expect(queue.messages).toHaveLength(0);
  });

  it("Microsoft status='error' account does NOT enqueue (only active accounts sync)", async () => {
    db.prepare(
      `INSERT INTO accounts
       (account_id, user_id, provider, provider_subject, email, status, channel_id, channel_token, channel_calendar_id)
       VALUES (?, ?, ?, ?, ?, 'error', ?, ?, ?)`,
    ).run(
      ACCOUNT_A.account_id,
      ACCOUNT_A.user_id,
      "microsoft",
      "ms-sub-error",
      ACCOUNT_A.email,
      "ms-sub-error-123",
      "ms-client-state-error",
      "cal-error",
    );

    const handler = createHandler();
    const env = { DB: d1, SYNC_QUEUE: queue, MS_WEBHOOK_CLIENT_STATE: "test-ms-secret" } as Env;

    const body = {
      value: [{
        subscriptionId: "ms-sub-error-123",
        changeType: "updated",
        clientState: "ms-client-state-error",
        resource: "users/ms-user/events/evt-99",
      }],
    };
    const request = new Request("https://webhook.tminus.dev/webhook/microsoft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const response = await handler.fetch(request, env, mockCtx);

    // Non-active accounts are silently dropped (return 202 but no enqueue)
    expect(response.status).toBe(202);
    expect(queue.messages).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // D1 schema validation for per-scope columns
  // -------------------------------------------------------------------------

  it("channel_calendar_id column exists and stores values correctly", async () => {
    db.prepare(
      `INSERT INTO accounts (account_id, user_id, provider, provider_subject, email, channel_token, channel_calendar_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      ACCOUNT_A.account_id,
      ACCOUNT_A.user_id,
      ACCOUNT_A.provider,
      ACCOUNT_A.provider_subject,
      ACCOUNT_A.email,
      ACCOUNT_A.channel_token,
      "my-specific-calendar",
    );

    const row = db.prepare(
      "SELECT channel_calendar_id FROM accounts WHERE account_id = ?",
    ).get(ACCOUNT_A.account_id) as { channel_calendar_id: string | null };

    expect(row.channel_calendar_id).toBe("my-specific-calendar");
  });

  it("ms_subscriptions.calendar_id column exists and stores values correctly", async () => {
    db.prepare(
      `INSERT INTO accounts (account_id, user_id, provider, provider_subject, email)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      ACCOUNT_A.account_id,
      ACCOUNT_A.user_id,
      "microsoft",
      "ms-subject",
      ACCOUNT_A.email,
    );

    db.prepare(
      "INSERT INTO ms_subscriptions (subscription_id, account_id, calendar_id) VALUES (?, ?, ?)",
    ).run("sub-cal-test", ACCOUNT_A.account_id, "my-ms-calendar");

    const row = db.prepare(
      "SELECT calendar_id FROM ms_subscriptions WHERE subscription_id = ?",
    ).get("sub-cal-test") as { calendar_id: string | null };

    expect(row.calendar_id).toBe("my-ms-calendar");
  });
});
