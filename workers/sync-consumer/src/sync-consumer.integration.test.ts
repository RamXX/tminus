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
import {
  RateLimitError,
  GoogleApiError,
  MicrosoftApiError,
  MicrosoftRateLimitError,
  MicrosoftTokenExpiredError,
} from "@tminus/shared";
import type { AccountId, SyncIncrementalMessage, SyncFullMessage } from "@tminus/shared";

// ---------------------------------------------------------------------------
// No-op sleep for tests (avoids real delays)
// ---------------------------------------------------------------------------

const noopSleep = async (_ms: number): Promise<void> => {};

// ---------------------------------------------------------------------------
// Test constants (valid ULID format: 4-char prefix + 26 Crockford Base32 chars)
// ---------------------------------------------------------------------------

const TEST_ORG = {
  org_id: "org_01HXYZ00000000000000000001",
  name: "Sync Consumer Test Org",
} as const;

const TEST_USER = {
  user_id: "usr_01HXYZ00000000000000000001",
  org_id: TEST_ORG.org_id,
  email: "synctest@example.com",
} as const;

const ACCOUNT_A = {
  account_id: "acc_01HXYZ0000000000000000000A" as AccountId,
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
        canonical_event_id: "evt_01HXYZ00000000000000000001",
        origin_account_id: "acc_01HXYZ0000000000000000000B",
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
  accessTokenError?: { status: number; body: string };
}

interface UserGraphDOState {
  applyDeltaCalls: Array<{ account_id: string; deltas: unknown[] }>;
  canonicalOriginEvents: Array<{
    origin_event_id: string;
    start?: { dateTime?: string; date?: string } | string | null;
  }>;
}

function createMockAccountDO(state: AccountDOState) {
  return {
    fetch: async (request: Request): Promise<Response> => {
      const url = new URL(request.url);
      const path = url.pathname;

      if (path === "/getAccessToken") {
        if (state.accessTokenError) {
          return new Response(state.accessTokenError.body, {
            status: state.accessTokenError.status,
            headers: { "Content-Type": "application/json" },
          });
        }
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
      if (url.pathname === "/listCanonicalEvents") {
        return new Response(
          JSON.stringify({
            items: state.canonicalOriginEvents,
            cursor: null,
            has_more: false,
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
      canonicalOriginEvents: [],
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

  it("full sync prunes stale canonical origin events missing upstream", async () => {
    userGraphDOState.canonicalOriginEvents = [
      {
        origin_event_id: "google_evt_keep",
        start: { dateTime: "2026-02-20T09:00:00Z" },
      },
      {
        origin_event_id: "google_evt_stale",
        start: { dateTime: "2026-02-21T09:00:00Z" },
      },
    ];

    const googleFetch = createGoogleApiFetch({
      events: [makeGoogleEvent({ id: "google_evt_keep", summary: "Keep" })],
      nextSyncToken: NEW_SYNC_TOKEN,
    });

    const message: SyncFullMessage = {
      type: "SYNC_FULL",
      account_id: ACCOUNT_A.account_id,
      reason: "onboarding",
    };

    await handleFullSync(message, env, { fetchFn: googleFetch, sleepFn: noopSleep });

    // First call: upsert current provider events
    // Second call: synthetic delete for stale canonical origin IDs
    expect(userGraphDOState.applyDeltaCalls).toHaveLength(2);
    expect(userGraphDOState.applyDeltaCalls[0].deltas).toHaveLength(1);
    expect(userGraphDOState.applyDeltaCalls[1].deltas).toEqual([
      {
        type: "deleted",
        origin_account_id: ACCOUNT_A.account_id,
        origin_event_id: "google_evt_stale",
      },
    ]);
  });

  it("full sync does not prune historical events outside prune window", async () => {
    userGraphDOState.canonicalOriginEvents = [
      {
        origin_event_id: "google_evt_keep",
        start: { dateTime: "2026-02-20T09:00:00Z" },
      },
      {
        origin_event_id: "google_evt_old",
        start: { dateTime: "2020-02-20T09:00:00Z" },
      },
    ];

    const googleFetch = createGoogleApiFetch({
      events: [makeGoogleEvent({ id: "google_evt_keep", summary: "Keep" })],
      nextSyncToken: NEW_SYNC_TOKEN,
    });

    const message: SyncFullMessage = {
      type: "SYNC_FULL",
      account_id: ACCOUNT_A.account_id,
      reason: "onboarding",
    };

    await handleFullSync(message, env, { fetchFn: googleFetch, sleepFn: noopSleep });

    // Only upsert call should run; historical missing event is skipped for prune.
    expect(userGraphDOState.applyDeltaCalls).toHaveLength(1);
    expect(userGraphDOState.applyDeltaCalls[0].deltas).toHaveLength(1);
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

  it("invalid_grant from AccountDO marks sync failure and does not throw", async () => {
    accountDOState.accessTokenError = {
      status: 500,
      body: JSON.stringify({
        error: "Token refresh failed (400): {\"error\":\"invalid_grant\"}",
      }),
    };

    const message: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: ACCOUNT_A.account_id,
      channel_id: "channel-invalid-grant",
      resource_id: "resource-invalid-grant",
      ping_ts: new Date().toISOString(),
    };

    await handleIncrementalSync(message, env, { sleepFn: noopSleep });

    expect(userGraphDOState.applyDeltaCalls).toHaveLength(0);
    expect(accountDOState.syncSuccessCalls).toHaveLength(0);
    expect(accountDOState.syncFailureCalls).toHaveLength(1);
    expect(accountDOState.syncFailureCalls[0].error).toContain("invalid_grant");
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

  // -------------------------------------------------------------------------
  // Microsoft error handling in retryWithBackoff
  // -------------------------------------------------------------------------

  it("retries on MicrosoftRateLimitError (429)", async () => {
    let attempts = 0;
    const fn = async () => {
      attempts++;
      if (attempts <= 2) {
        throw new MicrosoftRateLimitError("Rate limited by Microsoft Graph API");
      }
      return "success after microsoft retries";
    };

    const result = await retryWithBackoff(fn, { maxRetries429: 5, maxRetries5xx: 3, sleepFn: noopSleep });
    expect(result).toBe("success after microsoft retries");
    expect(attempts).toBe(3);
  });

  it("retries on MicrosoftApiError with 500/503", async () => {
    let attempts = 0;
    const fn = async () => {
      attempts++;
      if (attempts <= 1) {
        throw new MicrosoftApiError("Server error", 500);
      }
      return "recovered from microsoft error";
    };

    const result = await retryWithBackoff(fn, { maxRetries429: 5, maxRetries5xx: 3, sleepFn: noopSleep });
    expect(result).toBe("recovered from microsoft error");
    expect(attempts).toBe(2);
  });

  it("throws MicrosoftRateLimitError after exhausting max retries", async () => {
    const fn = async () => {
      throw new MicrosoftRateLimitError("Rate limited forever");
    };

    await expect(retryWithBackoff(fn, { maxRetries429: 2, maxRetries5xx: 3, sleepFn: noopSleep })).rejects.toThrow(MicrosoftRateLimitError);
  });

  it("does not retry non-retryable MicrosoftApiError (e.g., 403)", async () => {
    let attempts = 0;
    const fn = async () => {
      attempts++;
      throw new MicrosoftApiError("Forbidden", 403);
    };

    await expect(retryWithBackoff(fn, { sleepFn: noopSleep })).rejects.toThrow(MicrosoftApiError);
    expect(attempts).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Microsoft provider constants
// ---------------------------------------------------------------------------

const MS_ACCOUNT_B = {
  account_id: "acc_01HXYZ0000000000000000000B" as AccountId,
  user_id: TEST_USER.user_id,
  provider: "microsoft",
  provider_subject: "ms-sub-sync-b",
  email: "alice@outlook.com",
} as const;

const MS_DEFAULT_CALENDAR_ID = "cal_ms_default";
const MS_ACCESS_TOKEN = "eyJ0eXAiOiJKV1QiLCJ-test-ms-token";
const MS_DELTA_LINK = `https://graph.microsoft.com/v1.0/me/calendars/${MS_DEFAULT_CALENDAR_ID}/events/delta?$deltatoken=abc123`;
const MS_NEW_DELTA_LINK = `https://graph.microsoft.com/v1.0/me/calendars/${MS_DEFAULT_CALENDAR_ID}/events/delta?$deltatoken=def456`;

// ---------------------------------------------------------------------------
// Microsoft Graph API mock event helper
// ---------------------------------------------------------------------------

function makeMicrosoftEvent(overrides?: Record<string, unknown>) {
  return {
    id: "AAMkAG-ms-event-100",
    subject: "MS Teams Standup",
    body: { contentType: "text", content: "Daily standup notes" },
    location: { displayName: "Teams Room 1" },
    start: { dateTime: "2026-02-15T09:00:00.0000000", timeZone: "UTC" },
    end: { dateTime: "2026-02-15T10:00:00.0000000", timeZone: "UTC" },
    isAllDay: false,
    isCancelled: false,
    showAs: "busy",
    sensitivity: "normal",
    ...overrides,
  };
}

function makeMicrosoftManagedMirrorEvent(overrides?: Record<string, unknown>) {
  return {
    id: "AAMkAG-ms-mirror-200",
    subject: "Busy",
    start: { dateTime: "2026-02-15T11:00:00.0000000", timeZone: "UTC" },
    end: { dateTime: "2026-02-15T12:00:00.0000000", timeZone: "UTC" },
    isAllDay: false,
    isCancelled: false,
    showAs: "busy",
    sensitivity: "normal",
    extensions: [
      {
        "@odata.type": "microsoft.graph.openExtension",
        extensionName: "com.tminus.metadata",
        tminus: "true",
        managed: "true",
        canonicalId: "evt_01HXYZ00000000000000000001",
        originAccount: "acc_01HXYZ0000000000000000000A",
      },
    ],
    ...overrides,
  };
}

function makeMicrosoftDeletedEvent(overrides?: Record<string, unknown>) {
  return {
    id: "AAMkAG-ms-event-300",
    "@removed": { reason: "deleted" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Microsoft Graph API fetch mock factory
// ---------------------------------------------------------------------------

/**
 * Creates a mock fetch that intercepts Microsoft Graph Calendar API calls.
 * Returns events in the Microsoft Graph response format (value[] with @odata links).
 */
function createMicrosoftApiFetch(options: {
  events?: unknown[];
  nextLink?: string;  // @odata.nextLink (pagination)
  deltaLink?: string; // @odata.deltaLink (incremental sync token)
  statusCode?: number;
  errorText?: string;
}) {
  return async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    // Resolve provider-agnostic "primary" to Microsoft default calendar ID.
    if (url.includes("graph.microsoft.com") && url.includes("/me/calendars?") && url.includes("isDefaultCalendar")) {
      return new Response(
        JSON.stringify({
          value: [
            {
              id: MS_DEFAULT_CALENDAR_ID,
              name: "Calendar",
              isDefaultCalendar: true,
              canEdit: true,
            },
          ],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // Handle Microsoft Graph calendar events (including delta queries)
    if (url.includes("graph.microsoft.com") && (url.includes("/events") || url.includes("delta"))) {
      if (options.statusCode && options.statusCode !== 200) {
        return new Response(
          JSON.stringify({ error: { code: "ErrorAccessDenied", message: options.errorText ?? "Error" } }),
          { status: options.statusCode },
        );
      }

      return new Response(
        JSON.stringify({
          value: options.events ?? [],
          "@odata.nextLink": options.nextLink,
          "@odata.deltaLink": options.deltaLink,
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
 * Creates a paginated Microsoft Graph API mock that returns different pages.
 */
function createPaginatedMicrosoftApiFetch(pages: Array<{
  events: unknown[];
  nextLink?: string;  // @odata.nextLink
  deltaLink?: string; // @odata.deltaLink
}>) {
  let callIndex = 0;
  return async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    // Resolve provider-agnostic "primary" to Microsoft default calendar ID.
    if (url.includes("graph.microsoft.com") && url.includes("/me/calendars?") && url.includes("isDefaultCalendar")) {
      return new Response(
        JSON.stringify({
          value: [
            {
              id: MS_DEFAULT_CALENDAR_ID,
              name: "Calendar",
              isDefaultCalendar: true,
              canEdit: true,
            },
          ],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    if (url.includes("graph.microsoft.com") && (url.includes("/events") || url.includes("delta"))) {
      const page = pages[callIndex] ?? pages[pages.length - 1];
      callIndex++;

      return new Response(
        JSON.stringify({
          value: page.events,
          "@odata.nextLink": page.nextLink,
          "@odata.deltaLink": page.deltaLink,
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
// Microsoft provider dispatch integration tests
// ---------------------------------------------------------------------------

describe("Sync consumer Microsoft provider dispatch (real SQLite, mocked Microsoft Graph API + DOs)", () => {
  let db: DatabaseType;
  let d1: D1Database;
  let syncQueue: Queue & { messages: unknown[] };
  let writeQueue: Queue & { messages: unknown[] };
  let accountDOState: AccountDOState;
  let userGraphDOState: UserGraphDOState;
  let env: Env;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(MIGRATION_0001_INITIAL_SCHEMA);

    // Seed with a Microsoft account
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
      MS_ACCOUNT_B.account_id,
      MS_ACCOUNT_B.user_id,
      MS_ACCOUNT_B.provider,   // 'microsoft'
      MS_ACCOUNT_B.provider_subject,
      MS_ACCOUNT_B.email,
    );

    d1 = createRealD1(db);
    syncQueue = createMockQueue();
    writeQueue = createMockQueue();

    accountDOState = {
      accessToken: MS_ACCESS_TOKEN,
      syncToken: MS_DELTA_LINK,  // Microsoft stores full deltaLink URL as sync token
      syncSuccessCalls: [],
      syncFailureCalls: [],
      setSyncTokenCalls: [],
    };

    userGraphDOState = {
      applyDeltaCalls: [],
      canonicalOriginEvents: [],
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
  // 1. Microsoft incremental sync uses delta queries
  // -------------------------------------------------------------------------

  it("incremental sync: uses Microsoft delta query and applies deltas", async () => {
    const msFetch = createMicrosoftApiFetch({
      events: [makeMicrosoftEvent()],
      deltaLink: MS_NEW_DELTA_LINK,
    });

    const message: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: MS_ACCOUNT_B.account_id,
      channel_id: "channel-ms-1",
      resource_id: "resource-ms-1",
      ping_ts: new Date().toISOString(),
    };

    await handleIncrementalSync(message, env, { fetchFn: msFetch, sleepFn: noopSleep });

    // Verify deltas were passed to UserGraphDO
    expect(userGraphDOState.applyDeltaCalls).toHaveLength(1);
    const call = userGraphDOState.applyDeltaCalls[0];
    expect(call.account_id).toBe(MS_ACCOUNT_B.account_id);
    expect(call.deltas).toHaveLength(1);

    const delta = call.deltas[0] as Record<string, unknown>;
    expect(delta.type).toBe("updated");
    expect(delta.origin_event_id).toBe("AAMkAG-ms-event-100");
    expect(delta.origin_account_id).toBe(MS_ACCOUNT_B.account_id);

    // Verify event payload was normalized via Microsoft normalizer
    const eventPayload = delta.event as Record<string, unknown>;
    expect(eventPayload).toBeDefined();
    expect(eventPayload.title).toBe("MS Teams Standup");
    expect(eventPayload.description).toBe("Daily standup notes");
    expect(eventPayload.location).toBe("Teams Room 1");

    // Delta link stored as sync token
    expect(accountDOState.setSyncTokenCalls).toContain(MS_NEW_DELTA_LINK);
    expect(accountDOState.syncSuccessCalls).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // 2. Microsoft full sync paginates via @odata.nextLink
  // -------------------------------------------------------------------------

  it("full sync: paginates via @odata.nextLink and stores deltaLink", async () => {
    const nextLinkUrl = "https://graph.microsoft.com/v1.0/me/calendars/primary/events/delta?$skiptoken=page2";

    const msFetch = createPaginatedMicrosoftApiFetch([
      {
        events: [
          makeMicrosoftEvent({ id: "AAMkAG-p1-1", subject: "Page 1 Event 1" }),
          makeMicrosoftEvent({ id: "AAMkAG-p1-2", subject: "Page 1 Event 2" }),
        ],
        nextLink: nextLinkUrl,
      },
      {
        events: [
          makeMicrosoftEvent({ id: "AAMkAG-p2-1", subject: "Page 2 Event 1" }),
        ],
        deltaLink: MS_NEW_DELTA_LINK,
      },
    ]);

    const message: SyncFullMessage = {
      type: "SYNC_FULL",
      account_id: MS_ACCOUNT_B.account_id,
      reason: "onboarding",
    };

    await handleFullSync(message, env, { fetchFn: msFetch, sleepFn: noopSleep });

    // All 3 events across 2 pages
    expect(userGraphDOState.applyDeltaCalls).toHaveLength(1);
    expect(userGraphDOState.applyDeltaCalls[0].deltas).toHaveLength(3);

    const eventIds = userGraphDOState.applyDeltaCalls[0].deltas.map(
      (d: unknown) => (d as Record<string, unknown>).origin_event_id,
    );
    expect(eventIds).toContain("AAMkAG-p1-1");
    expect(eventIds).toContain("AAMkAG-p1-2");
    expect(eventIds).toContain("AAMkAG-p2-1");

    // Delta link from last page saved as sync token
    expect(accountDOState.setSyncTokenCalls).toContain(MS_NEW_DELTA_LINK);
    expect(accountDOState.syncSuccessCalls).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // 3. Microsoft managed mirror events are filtered (Invariant E)
  // -------------------------------------------------------------------------

  it("managed mirrors with com.tminus.metadata extension are filtered (Invariant E)", async () => {
    const msFetch = createMicrosoftApiFetch({
      events: [
        makeMicrosoftEvent({ id: "AAMkAG-origin-1" }),
        makeMicrosoftManagedMirrorEvent(),
        makeMicrosoftEvent({ id: "AAMkAG-origin-2", subject: "Real Event 2" }),
      ],
      deltaLink: MS_NEW_DELTA_LINK,
    });

    const message: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: MS_ACCOUNT_B.account_id,
      channel_id: "channel-ms-2",
      resource_id: "resource-ms-2",
      ping_ts: new Date().toISOString(),
    };

    await handleIncrementalSync(message, env, { fetchFn: msFetch, sleepFn: noopSleep });

    // Only 2 origin events (managed mirror filtered out)
    expect(userGraphDOState.applyDeltaCalls).toHaveLength(1);
    expect(userGraphDOState.applyDeltaCalls[0].deltas).toHaveLength(2);

    const eventIds = userGraphDOState.applyDeltaCalls[0].deltas.map(
      (d: unknown) => (d as Record<string, unknown>).origin_event_id,
    );
    expect(eventIds).toContain("AAMkAG-origin-1");
    expect(eventIds).toContain("AAMkAG-origin-2");
    expect(eventIds).not.toContain("AAMkAG-ms-mirror-200");
  });

  // -------------------------------------------------------------------------
  // 4. Microsoft deleted events (@removed) produce delete deltas
  // -------------------------------------------------------------------------

  it("@removed events produce 'deleted' type deltas", async () => {
    const msFetch = createMicrosoftApiFetch({
      events: [makeMicrosoftDeletedEvent()],
      deltaLink: MS_NEW_DELTA_LINK,
    });

    const message: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: MS_ACCOUNT_B.account_id,
      channel_id: "channel-ms-3",
      resource_id: "resource-ms-3",
      ping_ts: new Date().toISOString(),
    };

    await handleIncrementalSync(message, env, { fetchFn: msFetch, sleepFn: noopSleep });

    expect(userGraphDOState.applyDeltaCalls).toHaveLength(1);
    const delta = userGraphDOState.applyDeltaCalls[0].deltas[0] as Record<string, unknown>;
    expect(delta.type).toBe("deleted");
    expect(delta.origin_event_id).toBe("AAMkAG-ms-event-300");
    expect(delta.event).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 5. Microsoft 403 marks sync failure
  // -------------------------------------------------------------------------

  it("403 from Microsoft marks sync failure and does not retry", async () => {
    const msFetch = createMicrosoftApiFetch({
      statusCode: 403,
      errorText: "Insufficient privileges",
    });

    const message: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: MS_ACCOUNT_B.account_id,
      channel_id: "channel-ms-4",
      resource_id: "resource-ms-4",
      ping_ts: new Date().toISOString(),
    };

    await handleIncrementalSync(message, env, { fetchFn: msFetch, sleepFn: noopSleep });

    expect(accountDOState.syncFailureCalls).toHaveLength(1);
    expect(accountDOState.syncFailureCalls[0].error).toContain("403");
    expect(userGraphDOState.applyDeltaCalls).toHaveLength(0);
    expect(accountDOState.syncSuccessCalls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 6. Provider dispatch is seamless -- no message schema changes
  // -------------------------------------------------------------------------

  it("same message schema works for Microsoft (provider looked up from D1)", async () => {
    const msFetch = createMicrosoftApiFetch({
      events: [makeMicrosoftEvent()],
      deltaLink: MS_NEW_DELTA_LINK,
    });

    // The message uses account_id -- provider is resolved via D1 lookup
    const message: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: MS_ACCOUNT_B.account_id,  // D1 has provider='microsoft' for this account
      channel_id: "channel-ms-5",
      resource_id: "resource-ms-5",
      ping_ts: new Date().toISOString(),
    };

    // No special Microsoft-specific fields in the message
    await handleIncrementalSync(message, env, { fetchFn: msFetch, sleepFn: noopSleep });

    expect(userGraphDOState.applyDeltaCalls).toHaveLength(1);
    expect(accountDOState.syncSuccessCalls).toHaveLength(1);
  });
});
