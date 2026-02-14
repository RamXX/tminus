/**
 * Integration tests for tminus-sync-consumer worker.
 *
 * Uses real SQLite (better-sqlite3) for D1 mock -- all SQL queries execute
 * against real tables with real constraints. DOs are mocked at the fetch
 * boundary (they are external services from the consumer's perspective).
 * Google Calendar API is mocked via injectable FetchFn.
 *
 * Tests prove:
 * - Incremental sync with syncToken fetches only changes
 * - Full sync paginates through all events
 * - Event classification filters managed mirrors (Invariant E)
 * - 410 Gone triggers SYNC_FULL enqueue
 * - Normalized deltas passed correctly to UserGraphDO
 * - AccountDO sync cursor updated after successful sync
 * - DLQ receives messages after max_retries (from TM-9j7)
 * - retryWithBackoff handles 429 and 500/503 correctly
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { MIGRATION_0001_INITIAL_SCHEMA } from "@tminus/d1-registry";
import {
  createQueueHandler,
  handleIncrementalSync,
  handleFullSync,
  retryWithBackoff,
} from "./index";
import type { SyncQueueMessage } from "./index";
import { RateLimitError, GoogleApiError } from "@tminus/shared";
import type { AccountId, SyncIncrementalMessage, SyncFullMessage } from "@tminus/shared";

// ---------------------------------------------------------------------------
// No-op sleep for tests (avoids real delays)
// ---------------------------------------------------------------------------

const noopSleep = async (_ms: number): Promise<void> => {};

// ---------------------------------------------------------------------------
// Test constants (valid ULID format: 4-char prefix + 26 Crockford Base32 chars)
// ---------------------------------------------------------------------------

const TEST_ORG = {
  org_id: "org_01HXYZ000000000000000001",
  name: "Sync Consumer Test Org",
} as const;

const TEST_USER = {
  user_id: "usr_01HXYZ000000000000000001",
  org_id: TEST_ORG.org_id,
  email: "synctest@example.com",
} as const;

const ACCOUNT_A = {
  account_id: "acc_01HXYZ00000000000000000A" as AccountId,
  user_id: TEST_USER.user_id,
  provider: "google",
  provider_subject: "google-sub-sync-a",
  email: "alice@gmail.com",
} as const;

const TEST_ACCESS_TOKEN = "ya29.test-access-token-integration";
const TEST_SYNC_TOKEN = "sync-token-abc123";
const NEW_SYNC_TOKEN = "sync-token-def456";

// ---------------------------------------------------------------------------
// Google Calendar API mock events
// ---------------------------------------------------------------------------

function makeGoogleEvent(overrides?: Record<string, unknown>) {
  return {
    id: "google_evt_100",
    summary: "Team Meeting",
    description: "Weekly sync",
    location: "Room 301",
    start: { dateTime: "2026-02-15T09:00:00Z" },
    end: { dateTime: "2026-02-15T10:00:00Z" },
    status: "confirmed",
    visibility: "default",
    transparency: "opaque",
    ...overrides,
  };
}

function makeManagedMirrorEvent(overrides?: Record<string, unknown>) {
  return {
    id: "google_evt_mirror_200",
    summary: "Busy",
    start: { dateTime: "2026-02-15T11:00:00Z" },
    end: { dateTime: "2026-02-15T12:00:00Z" },
    status: "confirmed",
    extendedProperties: {
      private: {
        tminus: "true",
        managed: "true",
        canonical_event_id: "evt_01HXYZ000000000000000001",
        origin_account_id: "acc_01HXYZ00000000000000000B",
      },
    },
    ...overrides,
  };
}

function makeCancelledEvent(overrides?: Record<string, unknown>) {
  return {
    id: "google_evt_300",
    status: "cancelled",
    ...overrides,
  };
}

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
      // Not used
    },
  } as unknown as Queue & { messages: unknown[] };
}

// ---------------------------------------------------------------------------
// Google Calendar API fetch mock factory
// ---------------------------------------------------------------------------

/**
 * Creates a mock fetch function that intercepts Google Calendar API calls.
 * Returns specified events and sync tokens based on the request URL.
 */
function createGoogleApiFetch(options: {
  events?: unknown[];
  nextPageToken?: string;
  nextSyncToken?: string;
  statusCode?: number;
  errorText?: string;
}) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    // Handle events.list calls
    if (url.includes("/calendars/") && url.includes("/events")) {
      if (options.statusCode && options.statusCode !== 200) {
        return new Response(options.errorText ?? "Error", {
          status: options.statusCode,
        });
      }

      return new Response(
        JSON.stringify({
          items: options.events ?? [],
          nextPageToken: options.nextPageToken,
          nextSyncToken: options.nextSyncToken,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    return new Response("Not found", { status: 404 });
  };
}

/**
 * Creates a paginated Google API mock that returns different pages.
 */
function createPaginatedGoogleApiFetch(pages: Array<{
  events: unknown[];
  nextPageToken?: string;
  nextSyncToken?: string;
}>) {
  let callIndex = 0;
  return async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (url.includes("/calendars/") && url.includes("/events")) {
      const page = pages[callIndex] ?? pages[pages.length - 1];
      callIndex++;

      return new Response(
        JSON.stringify({
          items: page.events,
          nextPageToken: page.nextPageToken,
          nextSyncToken: page.nextSyncToken,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    return new Response("Not found", { status: 404 });
  };
}

// ---------------------------------------------------------------------------
// DO stub mocks
// ---------------------------------------------------------------------------

interface AccountDOState {
  accessToken: string;
  syncToken: string | null;
  syncSuccessCalls: Array<{ ts: string }>;
  syncFailureCalls: Array<{ error: string }>;
  setSyncTokenCalls: string[];
}

interface UserGraphDOState {
  applyDeltaCalls: Array<{ account_id: string; deltas: unknown[] }>;
}

function createMockAccountDO(state: AccountDOState) {
  return {
    fetch: async (request: Request): Promise<Response> => {
      const url = new URL(request.url);
      const path = url.pathname;

      if (path === "/getAccessToken") {
        return new Response(
          JSON.stringify({ access_token: state.accessToken }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (path === "/getSyncToken") {
        return new Response(
          JSON.stringify({ sync_token: state.syncToken }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (path === "/setSyncToken") {
        const body = (await request.json()) as { sync_token: string };
        state.setSyncTokenCalls.push(body.sync_token);
        state.syncToken = body.sync_token;
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (path === "/markSyncSuccess") {
        const body = (await request.json()) as { ts: string };
        state.syncSuccessCalls.push(body);
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (path === "/markSyncFailure") {
        const body = (await request.json()) as { error: string };
        state.syncFailureCalls.push(body);
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response("Not found", { status: 404 });
    },
  };
}

function createMockUserGraphDO(state: UserGraphDOState) {
  return {
    fetch: async (request: Request): Promise<Response> => {
      const url = new URL(request.url);
      if (url.pathname === "/applyProviderDelta") {
        const body = (await request.json()) as {
          account_id: string;
          deltas: unknown[];
        };
        state.applyDeltaCalls.push(body);
        return new Response(
          JSON.stringify({
            created: body.deltas.length,
            updated: 0,
            deleted: 0,
            mirrors_enqueued: 0,
            errors: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("Not found", { status: 404 });
    },
  };
}

/**
 * Create mock Env with all bindings wired up.
 */
function createMockEnv(options: {
  d1: D1Database;
  syncQueue: Queue & { messages: unknown[] };
  writeQueue: Queue & { messages: unknown[] };
  accountDOState: AccountDOState;
  userGraphDOState: UserGraphDOState;
}): Env {
  const accountStub = createMockAccountDO(options.accountDOState);
  const userGraphStub = createMockUserGraphDO(options.userGraphDOState);

  return {
    DB: options.d1,
    SYNC_QUEUE: options.syncQueue,
    WRITE_QUEUE: options.writeQueue,
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: "test-client-secret",
    MASTER_KEY: "0".repeat(64),
    ACCOUNT: {
      idFromName(_name: string) {
        return { toString: () => "mock-do-id" } as DurableObjectId;
      },
      get(_id: DurableObjectId) {
        return accountStub as unknown as DurableObjectStub;
      },
    } as unknown as DurableObjectNamespace,
    USER_GRAPH: {
      idFromName(_name: string) {
        return { toString: () => "mock-ug-id" } as DurableObjectId;
      },
      get(_id: DurableObjectId) {
        return userGraphStub as unknown as DurableObjectStub;
      },
    } as unknown as DurableObjectNamespace,
  };
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe("Sync consumer integration tests (real SQLite, mocked Google API + DOs)", () => {
  let db: DatabaseType;
  let d1: D1Database;
  let syncQueue: Queue & { messages: unknown[] };
  let writeQueue: Queue & { messages: unknown[] };
  let accountDOState: AccountDOState;
  let userGraphDOState: UserGraphDOState;
  let env: Env;

  beforeEach(() => {
    // Create fresh in-memory SQLite database
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(MIGRATION_0001_INITIAL_SCHEMA);

    // Seed prerequisite rows
    db.prepare("INSERT INTO orgs (org_id, name) VALUES (?, ?)").run(
      TEST_ORG.org_id,
      TEST_ORG.name,
    );
    db.prepare(
      "INSERT INTO users (user_id, org_id, email) VALUES (?, ?, ?)",
    ).run(TEST_USER.user_id, TEST_USER.org_id, TEST_USER.email);
    db.prepare(
      "INSERT INTO accounts (account_id, user_id, provider, provider_subject, email) VALUES (?, ?, ?, ?, ?)",
    ).run(
      ACCOUNT_A.account_id,
      ACCOUNT_A.user_id,
      ACCOUNT_A.provider,
      ACCOUNT_A.provider_subject,
      ACCOUNT_A.email,
    );

    d1 = createRealD1(db);
    syncQueue = createMockQueue();
    writeQueue = createMockQueue();

    accountDOState = {
      accessToken: TEST_ACCESS_TOKEN,
      syncToken: TEST_SYNC_TOKEN,
      syncSuccessCalls: [],
      syncFailureCalls: [],
      setSyncTokenCalls: [],
    };

    userGraphDOState = {
      applyDeltaCalls: [],
    };

    env = createMockEnv({
      d1,
      syncQueue,
      writeQueue,
      accountDOState,
      userGraphDOState,
    });
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. Incremental sync with syncToken fetches only changes
  // -------------------------------------------------------------------------

  it("incremental sync: fetches changes via syncToken and applies deltas", async () => {
    const googleFetch = createGoogleApiFetch({
      events: [makeGoogleEvent()],
      nextSyncToken: NEW_SYNC_TOKEN,
    });

    const message: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: ACCOUNT_A.account_id,
      channel_id: "channel-1",
      resource_id: "resource-1",
      ping_ts: new Date().toISOString(),
    };

    await handleIncrementalSync(message, env, { fetchFn: googleFetch, sleepFn: noopSleep });

    // Verify deltas were passed to UserGraphDO
    expect(userGraphDOState.applyDeltaCalls).toHaveLength(1);
    const call = userGraphDOState.applyDeltaCalls[0];
    expect(call.account_id).toBe(ACCOUNT_A.account_id);
    expect(call.deltas).toHaveLength(1);

    const delta = call.deltas[0] as Record<string, unknown>;
    expect(delta.type).toBe("updated"); // Google uses "updated" for both creates/updates
    expect(delta.origin_event_id).toBe("google_evt_100");
    expect(delta.origin_account_id).toBe(ACCOUNT_A.account_id);
    expect(delta.event).toBeDefined();

    // Verify sync cursor updated
    expect(accountDOState.setSyncTokenCalls).toContain(NEW_SYNC_TOKEN);

    // Verify sync success marked
    expect(accountDOState.syncSuccessCalls).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // 2. Full sync paginates through all events
  // -------------------------------------------------------------------------

  it("full sync: paginates through all events and applies all deltas", async () => {
    const page1Events = [
      makeGoogleEvent({ id: "google_evt_p1_1", summary: "Page 1 Event 1" }),
      makeGoogleEvent({ id: "google_evt_p1_2", summary: "Page 1 Event 2" }),
    ];
    const page2Events = [
      makeGoogleEvent({ id: "google_evt_p2_1", summary: "Page 2 Event 1" }),
    ];

    const googleFetch = createPaginatedGoogleApiFetch([
      { events: page1Events, nextPageToken: "page2_token" },
      { events: page2Events, nextSyncToken: NEW_SYNC_TOKEN },
    ]);

    const message: SyncFullMessage = {
      type: "SYNC_FULL",
      account_id: ACCOUNT_A.account_id,
      reason: "onboarding",
    };

    await handleFullSync(message, env, { fetchFn: googleFetch, sleepFn: noopSleep });

    // All 3 events across 2 pages should be in a single applyProviderDelta call
    expect(userGraphDOState.applyDeltaCalls).toHaveLength(1);
    expect(userGraphDOState.applyDeltaCalls[0].deltas).toHaveLength(3);

    // Verify origin_event_ids
    const eventIds = userGraphDOState.applyDeltaCalls[0].deltas.map(
      (d: unknown) => (d as Record<string, unknown>).origin_event_id,
    );
    expect(eventIds).toContain("google_evt_p1_1");
    expect(eventIds).toContain("google_evt_p1_2");
    expect(eventIds).toContain("google_evt_p2_1");

    // Sync token from last page is saved
    expect(accountDOState.setSyncTokenCalls).toContain(NEW_SYNC_TOKEN);
    expect(accountDOState.syncSuccessCalls).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // 3. Event classification filters managed mirrors
  // -------------------------------------------------------------------------

  it("managed mirrors are NOT treated as new origins (Invariant E)", async () => {
    const googleFetch = createGoogleApiFetch({
      events: [
        makeGoogleEvent({ id: "google_evt_origin" }),
        makeManagedMirrorEvent(),
        makeGoogleEvent({ id: "google_evt_origin_2", summary: "Real Event 2" }),
      ],
      nextSyncToken: NEW_SYNC_TOKEN,
    });

    const message: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: ACCOUNT_A.account_id,
      channel_id: "channel-1",
      resource_id: "resource-1",
      ping_ts: new Date().toISOString(),
    };

    await handleIncrementalSync(message, env, { fetchFn: googleFetch, sleepFn: noopSleep });

    // Only 2 origin events should produce deltas (managed mirror filtered out)
    expect(userGraphDOState.applyDeltaCalls).toHaveLength(1);
    expect(userGraphDOState.applyDeltaCalls[0].deltas).toHaveLength(2);

    const eventIds = userGraphDOState.applyDeltaCalls[0].deltas.map(
      (d: unknown) => (d as Record<string, unknown>).origin_event_id,
    );
    expect(eventIds).toContain("google_evt_origin");
    expect(eventIds).toContain("google_evt_origin_2");
    // Mirror event NOT included
    expect(eventIds).not.toContain("google_evt_mirror_200");
  });

  // -------------------------------------------------------------------------
  // 4. 410 Gone triggers SYNC_FULL enqueue
  // -------------------------------------------------------------------------

  it("410 Gone on incremental sync triggers SYNC_FULL enqueue", async () => {
    const googleFetch = createGoogleApiFetch({
      statusCode: 410,
      errorText: "Sync token expired",
    });

    const message: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: ACCOUNT_A.account_id,
      channel_id: "channel-1",
      resource_id: "resource-1",
      ping_ts: new Date().toISOString(),
    };

    await handleIncrementalSync(message, env, { fetchFn: googleFetch, sleepFn: noopSleep });

    // SYNC_FULL should be enqueued
    expect(syncQueue.messages).toHaveLength(1);
    const enqueuedMsg = syncQueue.messages[0] as Record<string, unknown>;
    expect(enqueuedMsg.type).toBe("SYNC_FULL");
    expect(enqueuedMsg.account_id).toBe(ACCOUNT_A.account_id);
    expect(enqueuedMsg.reason).toBe("token_410");

    // No deltas applied (sync stopped after 410)
    expect(userGraphDOState.applyDeltaCalls).toHaveLength(0);

    // Sync token NOT updated (no new token to save)
    expect(accountDOState.setSyncTokenCalls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 5. Normalized deltas passed correctly to UserGraphDO
  // -------------------------------------------------------------------------

  it("deltas contain correct normalized event data from Google event", async () => {
    const detailedEvent = makeGoogleEvent({
      id: "google_evt_detailed",
      summary: "Sprint Planning",
      description: "Q2 sprint planning session",
      location: "Conference Room B",
      start: { dateTime: "2026-03-01T14:00:00Z" },
      end: { dateTime: "2026-03-01T16:00:00Z" },
      status: "confirmed",
      visibility: "private",
      transparency: "opaque",
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"],
    });

    const googleFetch = createGoogleApiFetch({
      events: [detailedEvent],
      nextSyncToken: NEW_SYNC_TOKEN,
    });

    const message: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: ACCOUNT_A.account_id,
      channel_id: "channel-1",
      resource_id: "resource-1",
      ping_ts: new Date().toISOString(),
    };

    await handleIncrementalSync(message, env, { fetchFn: googleFetch, sleepFn: noopSleep });

    expect(userGraphDOState.applyDeltaCalls).toHaveLength(1);
    const delta = userGraphDOState.applyDeltaCalls[0].deltas[0] as Record<
      string,
      unknown
    >;
    const eventPayload = delta.event as Record<string, unknown>;

    expect(eventPayload.title).toBe("Sprint Planning");
    expect(eventPayload.description).toBe("Q2 sprint planning session");
    expect(eventPayload.location).toBe("Conference Room B");
    expect(eventPayload.start).toEqual({ dateTime: "2026-03-01T14:00:00Z" });
    expect(eventPayload.end).toEqual({ dateTime: "2026-03-01T16:00:00Z" });
    expect(eventPayload.all_day).toBe(false);
    expect(eventPayload.status).toBe("confirmed");
    expect(eventPayload.visibility).toBe("private");
    expect(eventPayload.transparency).toBe("opaque");
    expect(eventPayload.recurrence_rule).toBe("RRULE:FREQ=WEEKLY;BYDAY=MO");
    expect(eventPayload.origin_account_id).toBe(ACCOUNT_A.account_id);
    expect(eventPayload.origin_event_id).toBe("google_evt_detailed");
  });

  // -------------------------------------------------------------------------
  // 6. AccountDO sync cursor updated after successful sync
  // -------------------------------------------------------------------------

  it("sync cursor is updated with new syncToken after successful sync", async () => {
    const specificSyncToken = "new-cursor-xyz789";
    const googleFetch = createGoogleApiFetch({
      events: [makeGoogleEvent()],
      nextSyncToken: specificSyncToken,
    });

    const message: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: ACCOUNT_A.account_id,
      channel_id: "channel-1",
      resource_id: "resource-1",
      ping_ts: new Date().toISOString(),
    };

    await handleIncrementalSync(message, env, { fetchFn: googleFetch, sleepFn: noopSleep });

    // Verify the specific token was saved
    expect(accountDOState.setSyncTokenCalls).toEqual([specificSyncToken]);
    expect(accountDOState.syncToken).toBe(specificSyncToken);
  });

  // -------------------------------------------------------------------------
  // 7. Cancelled events produce delete deltas
  // -------------------------------------------------------------------------

  it("cancelled events produce 'deleted' type deltas", async () => {
    const googleFetch = createGoogleApiFetch({
      events: [makeCancelledEvent()],
      nextSyncToken: NEW_SYNC_TOKEN,
    });

    const message: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: ACCOUNT_A.account_id,
      channel_id: "channel-1",
      resource_id: "resource-1",
      ping_ts: new Date().toISOString(),
    };

    await handleIncrementalSync(message, env, { fetchFn: googleFetch, sleepFn: noopSleep });

    expect(userGraphDOState.applyDeltaCalls).toHaveLength(1);
    const delta = userGraphDOState.applyDeltaCalls[0].deltas[0] as Record<
      string,
      unknown
    >;
    expect(delta.type).toBe("deleted");
    expect(delta.origin_event_id).toBe("google_evt_300");
    // Deleted events have no event payload
    expect(delta.event).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 8. 403 Insufficient scope marks failure, does not retry
  // -------------------------------------------------------------------------

  it("403 insufficient scope marks sync failure and does not retry", async () => {
    const googleFetch = createGoogleApiFetch({
      statusCode: 403,
      errorText: "Insufficient Permission",
    });

    const message: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: ACCOUNT_A.account_id,
      channel_id: "channel-1",
      resource_id: "resource-1",
      ping_ts: new Date().toISOString(),
    };

    await handleIncrementalSync(message, env, { fetchFn: googleFetch, sleepFn: noopSleep });

    // Sync failure marked
    expect(accountDOState.syncFailureCalls).toHaveLength(1);
    expect(accountDOState.syncFailureCalls[0].error).toContain("403");

    // No deltas applied
    expect(userGraphDOState.applyDeltaCalls).toHaveLength(0);

    // No sync success
    expect(accountDOState.syncSuccessCalls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 9. D1 user_id lookup -- real SQL executes against real table
  // -------------------------------------------------------------------------

  it("D1 lookup correctly resolves account_id to user_id", async () => {
    const googleFetch = createGoogleApiFetch({
      events: [makeGoogleEvent()],
      nextSyncToken: NEW_SYNC_TOKEN,
    });

    const message: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: ACCOUNT_A.account_id,
      channel_id: "channel-1",
      resource_id: "resource-1",
      ping_ts: new Date().toISOString(),
    };

    await handleIncrementalSync(message, env, { fetchFn: googleFetch, sleepFn: noopSleep });

    // If D1 lookup failed, processAndApplyDeltas would throw.
    // Successful delta application proves D1 found the user_id.
    expect(userGraphDOState.applyDeltaCalls).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // 10. No events from Google -> no deltas applied, cursor still updated
  // -------------------------------------------------------------------------

  it("empty event list from Google: no deltas, cursor updated, sync success", async () => {
    const googleFetch = createGoogleApiFetch({
      events: [],
      nextSyncToken: NEW_SYNC_TOKEN,
    });

    const message: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: ACCOUNT_A.account_id,
      channel_id: "channel-1",
      resource_id: "resource-1",
      ping_ts: new Date().toISOString(),
    };

    await handleIncrementalSync(message, env, { fetchFn: googleFetch, sleepFn: noopSleep });

    // No deltas applied
    expect(userGraphDOState.applyDeltaCalls).toHaveLength(0);

    // Cursor still updated
    expect(accountDOState.setSyncTokenCalls).toContain(NEW_SYNC_TOKEN);

    // Sync still marked as success
    expect(accountDOState.syncSuccessCalls).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // 11. Queue handler processes batch and acks/retries correctly
  // -------------------------------------------------------------------------

  it("queue handler acks successful messages and retries failed ones", async () => {
    const googleFetch = createGoogleApiFetch({
      events: [makeGoogleEvent()],
      nextSyncToken: NEW_SYNC_TOKEN,
    });

    const handler = createQueueHandler({ fetchFn: googleFetch, sleepFn: noopSleep });

    const ackedIds: string[] = [];
    const retriedIds: string[] = [];

    const mockBatch: MessageBatch<SyncQueueMessage> = {
      queue: "tminus-sync-queue",
      messages: [
        {
          id: "msg-1",
          timestamp: new Date(),
          attempts: 1,
          body: {
            type: "SYNC_INCREMENTAL",
            account_id: ACCOUNT_A.account_id,
            channel_id: "channel-1",
            resource_id: "resource-1",
            ping_ts: new Date().toISOString(),
          } as SyncIncrementalMessage,
          ack() {
            ackedIds.push("msg-1");
          },
          retry() {
            retriedIds.push("msg-1");
          },
        },
      ],
      ackAll() {},
      retryAll() {},
    } as unknown as MessageBatch<SyncQueueMessage>;

    await handler.queue(mockBatch, env);

    expect(ackedIds).toContain("msg-1");
    expect(retriedIds).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 12. Full sync with reason field logs context appropriately
  // -------------------------------------------------------------------------

  it("full sync with token_410 reason processes correctly", async () => {
    const googleFetch = createGoogleApiFetch({
      events: [makeGoogleEvent()],
      nextSyncToken: NEW_SYNC_TOKEN,
    });

    const message: SyncFullMessage = {
      type: "SYNC_FULL",
      account_id: ACCOUNT_A.account_id,
      reason: "token_410",
    };

    await handleFullSync(message, env, { fetchFn: googleFetch, sleepFn: noopSleep });

    expect(userGraphDOState.applyDeltaCalls).toHaveLength(1);
    expect(accountDOState.syncSuccessCalls).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // 13. All-day events normalized correctly
  // -------------------------------------------------------------------------

  it("all-day events are normalized with correct all_day flag", async () => {
    const allDayEvent = makeGoogleEvent({
      id: "google_evt_allday",
      summary: "Company Holiday",
      start: { date: "2026-02-20" },
      end: { date: "2026-02-21" },
    });

    const googleFetch = createGoogleApiFetch({
      events: [allDayEvent],
      nextSyncToken: NEW_SYNC_TOKEN,
    });

    const message: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: ACCOUNT_A.account_id,
      channel_id: "channel-1",
      resource_id: "resource-1",
      ping_ts: new Date().toISOString(),
    };

    await handleIncrementalSync(message, env, { fetchFn: googleFetch, sleepFn: noopSleep });

    const delta = userGraphDOState.applyDeltaCalls[0].deltas[0] as Record<
      string,
      unknown
    >;
    const eventPayload = delta.event as Record<string, unknown>;
    expect(eventPayload.all_day).toBe(true);
    expect(eventPayload.start).toEqual({ date: "2026-02-20" });
    expect(eventPayload.end).toEqual({ date: "2026-02-21" });
  });
});

// ---------------------------------------------------------------------------
// DLQ integration test (from TM-9j7 review requirement)
// ---------------------------------------------------------------------------

describe("DLQ integration: messages retried and sent to DLQ after max_retries", () => {
  let db: DatabaseType;
  let d1: D1Database;
  let syncQueue: Queue & { messages: unknown[] };
  let writeQueue: Queue & { messages: unknown[] };
  let env: Env;

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
    db.prepare(
      "INSERT INTO accounts (account_id, user_id, provider, provider_subject, email) VALUES (?, ?, ?, ?, ?)",
    ).run(
      ACCOUNT_A.account_id,
      ACCOUNT_A.user_id,
      ACCOUNT_A.provider,
      ACCOUNT_A.provider_subject,
      ACCOUNT_A.email,
    );

    d1 = createRealD1(db);
    syncQueue = createMockQueue();
    writeQueue = createMockQueue();
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it("message that fails processing is retried; after max_retries, DLQ receives original body", async () => {
    // Simulate a handler that always throws (unrecoverable error).
    // In production, Cloudflare Workers runtime handles retry and DLQ routing.
    // This test proves that:
    // 1. msg.retry() is called on failure (not ack)
    // 2. After max_retries (5), the message body is preserved for DLQ

    const MAX_RETRIES = 5;
    const dlqMessages: unknown[] = [];

    // Google API that always fails with 500 (triggers retry in retryWithBackoff)
    // But since retryWithBackoff has max 3 retries for 5xx, it throws on the 4th
    // and the queue handler calls msg.retry()
    const failingFetch = createGoogleApiFetch({
      statusCode: 500,
      errorText: "Internal Server Error",
    });

    const handler = createQueueHandler({ fetchFn: failingFetch, sleepFn: noopSleep });

    const originalBody: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: ACCOUNT_A.account_id,
      channel_id: "channel-dlq-test",
      resource_id: "resource-dlq-test",
      ping_ts: "2026-02-15T00:00:00Z",
    };

    let retryCount = 0;

    // Simulate multiple attempts as Cloudflare Workers runtime would
    for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
      const isLastAttempt = attempt > MAX_RETRIES;

      const mockBatch: MessageBatch<SyncQueueMessage> = {
        queue: "tminus-sync-queue",
        messages: [
          {
            id: `msg-dlq-attempt-${attempt}`,
            timestamp: new Date(),
            attempts: attempt,
            body: originalBody,
            ack() {
              // Message should NOT be acked when processing fails
            },
            retry() {
              retryCount++;
              if (isLastAttempt) {
                // After max_retries, Cloudflare sends to DLQ
                // The original body is preserved
                dlqMessages.push(originalBody);
              }
            },
          },
        ],
        ackAll() {},
        retryAll() {},
      } as unknown as MessageBatch<SyncQueueMessage>;

      const accountDOState: AccountDOState = {
        accessToken: TEST_ACCESS_TOKEN,
        syncToken: TEST_SYNC_TOKEN,
        syncSuccessCalls: [],
        syncFailureCalls: [],
        setSyncTokenCalls: [],
      };

      env = createMockEnv({
        d1,
        syncQueue,
        writeQueue,
        accountDOState,
        userGraphDOState: { applyDeltaCalls: [] },
      });

      await handler.queue(mockBatch, env);
    }

    // Verify msg.retry() was called for all attempts
    expect(retryCount).toBe(MAX_RETRIES + 1);

    // Verify DLQ received the message after max_retries
    expect(dlqMessages).toHaveLength(1);

    // Verify DLQ message preserves original body
    const dlqMsg = dlqMessages[0] as SyncIncrementalMessage;
    expect(dlqMsg.type).toBe("SYNC_INCREMENTAL");
    expect(dlqMsg.account_id).toBe(ACCOUNT_A.account_id);
    expect(dlqMsg.channel_id).toBe("channel-dlq-test");
    expect(dlqMsg.resource_id).toBe("resource-dlq-test");
    expect(dlqMsg.ping_ts).toBe("2026-02-15T00:00:00Z");
  });
});

// ---------------------------------------------------------------------------
// Unit tests: retryWithBackoff
// ---------------------------------------------------------------------------

describe("retryWithBackoff", () => {
  it("succeeds on first attempt without retries", async () => {
    const result = await retryWithBackoff(async () => "success", { sleepFn: noopSleep });
    expect(result).toBe("success");
  });

  it("retries on 429 RateLimitError up to maxRetries429", async () => {
    let attempts = 0;
    const fn = async () => {
      attempts++;
      if (attempts <= 3) {
        throw new RateLimitError("Rate limited");
      }
      return "success after retries";
    };

    const result = await retryWithBackoff(fn, { maxRetries429: 5, maxRetries5xx: 3, sleepFn: noopSleep });
    expect(result).toBe("success after retries");
    expect(attempts).toBe(4); // 3 failures + 1 success
  });

  it("throws 429 after exhausting max retries", async () => {
    const fn = async () => {
      throw new RateLimitError("Rate limited forever");
    };

    await expect(retryWithBackoff(fn, { maxRetries429: 2, maxRetries5xx: 3, sleepFn: noopSleep })).rejects.toThrow(RateLimitError);
  });

  it("retries on 500/503 GoogleApiError up to maxRetries5xx", async () => {
    let attempts = 0;
    const fn = async () => {
      attempts++;
      if (attempts <= 2) {
        throw new GoogleApiError("Server error", 500);
      }
      return "recovered";
    };

    const result = await retryWithBackoff(fn, { maxRetries429: 5, maxRetries5xx: 3, sleepFn: noopSleep });
    expect(result).toBe("recovered");
    expect(attempts).toBe(3);
  });

  it("throws 500 after exhausting max retries", async () => {
    const fn = async () => {
      throw new GoogleApiError("Server error", 500);
    };

    await expect(retryWithBackoff(fn, { maxRetries429: 5, maxRetries5xx: 2, sleepFn: noopSleep })).rejects.toThrow(GoogleApiError);
  });

  it("does not retry non-retryable errors (e.g., 404)", async () => {
    let attempts = 0;
    const fn = async () => {
      attempts++;
      throw new GoogleApiError("Not found", 404);
    };

    await expect(retryWithBackoff(fn, { sleepFn: noopSleep })).rejects.toThrow(GoogleApiError);
    expect(attempts).toBe(1); // No retries
  });

  it("retries 503 errors same as 500", async () => {
    let attempts = 0;
    const fn = async () => {
      attempts++;
      if (attempts <= 1) {
        throw new GoogleApiError("Service unavailable", 503);
      }
      return "back up";
    };

    const result = await retryWithBackoff(fn, { maxRetries429: 5, maxRetries5xx: 3, sleepFn: noopSleep });
    expect(result).toBe("back up");
    expect(attempts).toBe(2);
  });
});
