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
  extractMicrosoftEventId,
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
  scopedSyncTokens: Record<string, string | null>;
  setScopedSyncTokenCalls: Array<{ provider_calendar_id: string; sync_token: string }>;
  calendarScopes: Array<{
    provider_calendar_id: string;
    enabled: boolean;
    sync_enabled: boolean;
  }>;
  accessTokenError?: { status: number; body: string };
}

interface UserGraphDOState {
  applyDeltaCalls: Array<{ account_id: string; deltas: unknown[] }>;
  deleteCanonicalCalls: Array<{ canonical_event_id: string; source: string }>;
  findCanonicalByMirrorCalls: Array<{
    target_account_id: string;
    provider_event_id: string;
  }>;
  getActiveMirrorsCalls: Array<{
    target_account_id: string;
    include_pending_with_provider_id?: boolean;
  }>;
  canonicalOriginEvents: Array<{
    origin_event_id: string;
    start?: { dateTime?: string; date?: string } | string | null;
  }>;
  activeMirrors: Array<{
    provider_event_id: string | null;
    target_calendar_id?: string | null;
    canonical_event_id?: string | null;
    last_write_ts?: string | null;
    state?: string | null;
  }>;
  mirrorLookupByProviderEventId: Record<string, string>;
  findCanonicalByMirrorErrorsByProviderEventId: Record<string, string>;
  // TM-9eu: Canonical events lookup for mirror writeback (getCanonicalEvent)
  canonicalEventsById: Record<
    string,
    { event: Record<string, unknown>; mirrors: unknown[] }
  >;
  getCanonicalEventCalls: Array<{ canonical_event_id: string }>;
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
        state.scopedSyncTokens.primary = body.sync_token;
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (path === "/listCalendarScopes") {
        return new Response(
          JSON.stringify({
            scopes: state.calendarScopes.map((scope) => ({
              providerCalendarId: scope.provider_calendar_id,
              enabled: scope.enabled,
              syncEnabled: scope.sync_enabled,
            })),
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      if (path === "/getScopedSyncToken") {
        const body = (await request.json()) as { provider_calendar_id: string };
        const scopedToken = Object.prototype.hasOwnProperty.call(
          state.scopedSyncTokens,
          body.provider_calendar_id,
        )
          ? state.scopedSyncTokens[body.provider_calendar_id]
          : null;
        return new Response(
          JSON.stringify({ sync_token: scopedToken ?? null }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      if (path === "/setScopedSyncToken") {
        const body = (await request.json()) as {
          provider_calendar_id: string;
          sync_token: string;
        };
        state.setScopedSyncTokenCalls.push(body);
        state.scopedSyncTokens[body.provider_calendar_id] = body.sync_token;
        if (body.provider_calendar_id === "primary") {
          state.syncToken = body.sync_token;
        }
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
      if (url.pathname === "/getActiveMirrors") {
        const body = (await request.json()) as {
          target_account_id: string;
          include_pending_with_provider_id?: boolean;
        };
        state.getActiveMirrorsCalls.push(body);
        const includePendingWithProviderId =
          body.include_pending_with_provider_id === true;
        const mirrors = state.activeMirrors.filter((mirror) => {
          const stateValue = mirror.state;
          const isActive = stateValue === undefined || stateValue === "ACTIVE";
          if (isActive) return true;
          if (!includePendingWithProviderId) return false;
          return (
            stateValue === "PENDING" &&
            typeof mirror.provider_event_id === "string" &&
            mirror.provider_event_id.length > 0
          );
        });
        return new Response(
          JSON.stringify({
            mirrors,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.pathname === "/findCanonicalByMirror") {
        const body = (await request.json()) as {
          target_account_id: string;
          provider_event_id: string;
        };
        state.findCanonicalByMirrorCalls.push(body);
        const forcedError =
          state.findCanonicalByMirrorErrorsByProviderEventId[body.provider_event_id];
        if (typeof forcedError === "string" && forcedError.length > 0) {
          return new Response(forcedError, { status: 500 });
        }
        return new Response(
          JSON.stringify({
            canonical_event_id:
              state.mirrorLookupByProviderEventId[body.provider_event_id] ?? null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.pathname === "/deleteCanonicalEvent") {
        const body = (await request.json()) as {
          canonical_event_id: string;
          source: string;
        };
        state.deleteCanonicalCalls.push(body);
        return new Response(JSON.stringify(true), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      // TM-9eu: getCanonicalEvent support for mirror writeback tests
      if (url.pathname === "/getCanonicalEvent") {
        const body = (await request.json()) as {
          canonical_event_id: string;
        };
        state.getCanonicalEventCalls.push(body);
        const result = state.canonicalEventsById[body.canonical_event_id] ?? null;
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
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
      scopedSyncTokens: {
        primary: TEST_SYNC_TOKEN,
      },
      setScopedSyncTokenCalls: [],
      calendarScopes: [
        {
          provider_calendar_id: "primary",
          enabled: true,
          sync_enabled: true,
        },
      ],
    };

    userGraphDOState = {
      applyDeltaCalls: [],
      deleteCanonicalCalls: [],
      findCanonicalByMirrorCalls: [],
      getActiveMirrorsCalls: [],
      canonicalOriginEvents: [],
      activeMirrors: [],
      mirrorLookupByProviderEventId: {},
      findCanonicalByMirrorErrorsByProviderEventId: {},
      canonicalEventsById: {},
      getCanonicalEventCalls: [],
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
      calendar_id: null,
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

  it("successful sync recovers account status from error to active in D1", async () => {
    db.prepare("UPDATE accounts SET status = 'error' WHERE account_id = ?").run(
      ACCOUNT_A.account_id,
    );

    const googleFetch = createGoogleApiFetch({
      events: [makeGoogleEvent()],
      nextSyncToken: NEW_SYNC_TOKEN,
    });

    const message: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: ACCOUNT_A.account_id,
      channel_id: "channel-recover-1",
      resource_id: "resource-recover-1",
      ping_ts: new Date().toISOString(),
      calendar_id: null,
    };

    await handleIncrementalSync(message, env, { fetchFn: googleFetch, sleepFn: noopSleep });

    const row = db
      .prepare("SELECT status FROM accounts WHERE account_id = ?")
      .get(ACCOUNT_A.account_id) as { status: string };
    expect(row.status).toBe("active");
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

  it("full-sync prune spikes are truncated to one atomic delete", async () => {
    env.DELETE_GUARD_MAX_DELETES_PER_SYNC_RUN = "1";
    env.DELETE_GUARD_MAX_DELETES_PER_ACCOUNT_BATCH = "2";
    env.DELETE_GUARD_MAX_DELETES_PER_BATCH = "2";

    userGraphDOState.canonicalOriginEvents = [
      {
        origin_event_id: "google_evt_keep_guard",
        start: { dateTime: "2026-02-20T09:00:00Z" },
      },
      {
        origin_event_id: "google_evt_stale_guard_1",
        start: { dateTime: "2026-02-21T09:00:00Z" },
      },
      {
        origin_event_id: "google_evt_stale_guard_2",
        start: { dateTime: "2026-02-22T09:00:00Z" },
      },
    ];

    const googleFetch = createGoogleApiFetch({
      events: [makeGoogleEvent({ id: "google_evt_keep_guard", summary: "Keep Guard" })],
      nextSyncToken: NEW_SYNC_TOKEN,
    });

    const message: SyncFullMessage = {
      type: "SYNC_FULL",
      account_id: ACCOUNT_A.account_id,
      reason: "reconcile",
    };

    await handleFullSync(message, env, { fetchFn: googleFetch, sleepFn: noopSleep });

    // Atomic deletion: upsert call plus exactly one synthetic delete delta.
    expect(userGraphDOState.applyDeltaCalls).toHaveLength(2);
    expect(userGraphDOState.applyDeltaCalls[0].deltas).toHaveLength(1);
    expect(userGraphDOState.applyDeltaCalls[1].deltas).toEqual([
      {
        type: "deleted",
        origin_account_id: ACCOUNT_A.account_id,
        origin_event_id: "google_evt_stale_guard_2",
      },
    ]);
    expect(accountDOState.syncSuccessCalls).toHaveLength(1);
    expect(accountDOState.syncFailureCalls).toHaveLength(0);
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

  it("full sync deletes stale managed mirrors missing from provider snapshot", async () => {
    accountDOState.calendarScopes = [
      {
        provider_calendar_id: "primary",
        enabled: true,
        sync_enabled: true,
      },
    ];
    accountDOState.scopedSyncTokens = {
      primary: TEST_SYNC_TOKEN,
      "overlay_busy_fullsync@group.calendar.google.com": "overlay-sync-old",
    };
    userGraphDOState.activeMirrors = [
      {
        provider_event_id: "google_evt_missing_mirror_fullsync",
        target_calendar_id: "overlay_busy_fullsync@group.calendar.google.com",
      },
    ];
    userGraphDOState.mirrorLookupByProviderEventId = {
      google_evt_missing_mirror_fullsync: "evt_01HXYZ00000000000000000008",
    };

    const googleFetch = async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string"
        ? new URL(input)
        : input instanceof URL
        ? input
        : new URL(input.url);
      const match = url.pathname.match(/\/calendars\/([^/]+)\/events/);
      const calendarId = match ? decodeURIComponent(match[1]) : "unknown";

      if (calendarId === "primary") {
        return new Response(
          JSON.stringify({
            items: [makeGoogleEvent({ id: "google_evt_origin_keep" })],
            nextSyncToken: "primary-sync-new",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (calendarId === "overlay_busy_fullsync@group.calendar.google.com") {
        return new Response(
          JSON.stringify({
            items: [],
            nextSyncToken: "overlay-sync-new",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response("Unexpected calendar", { status: 500 });
    };

    const message: SyncFullMessage = {
      type: "SYNC_FULL",
      account_id: ACCOUNT_A.account_id,
      reason: "token_410",
    };

    await handleFullSync(message, env, { fetchFn: googleFetch, sleepFn: noopSleep });

    expect(userGraphDOState.deleteCanonicalCalls).toEqual([
      {
        canonical_event_id: "evt_01HXYZ00000000000000000008",
        source: `provider:${ACCOUNT_A.account_id}`,
      },
    ]);
    expect(accountDOState.setScopedSyncTokenCalls).toEqual(
      expect.arrayContaining([
        {
          provider_calendar_id: "primary",
          sync_token: "primary-sync-new",
        },
        {
          provider_calendar_id: "overlay_busy_fullsync@group.calendar.google.com",
          sync_token: "overlay-sync-new",
        },
      ]),
    );
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
      calendar_id: null,
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

  it("google mirror without managed metadata is filtered when mirror index matches", async () => {
    userGraphDOState.activeMirrors = [
      { provider_event_id: "google_evt_mirror_missing_meta" },
    ];

    const googleFetch = createGoogleApiFetch({
      events: [
        makeGoogleEvent({
          id: "google_evt_mirror_missing_meta",
          summary: "Busy",
          extendedProperties: undefined,
        }),
        makeGoogleEvent({
          id: "google_evt_real_origin",
          summary: "Real Origin Event",
        }),
      ],
      nextSyncToken: NEW_SYNC_TOKEN,
    });

    const message: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: ACCOUNT_A.account_id,
      channel_id: "channel-google-missing-meta",
      resource_id: "resource-google-missing-meta",
      ping_ts: new Date().toISOString(),
      calendar_id: null,
    };

    await handleIncrementalSync(message, env, { fetchFn: googleFetch, sleepFn: noopSleep });

    expect(userGraphDOState.applyDeltaCalls).toHaveLength(1);
    expect(userGraphDOState.applyDeltaCalls[0].deltas).toHaveLength(1);
    const eventIds = userGraphDOState.applyDeltaCalls[0].deltas.map(
      (d: unknown) => (d as Record<string, unknown>).origin_event_id,
    );
    expect(eventIds).toEqual(["google_evt_real_origin"]);
  });

  it("managed mirror deletion triggers canonical delete", async () => {
    userGraphDOState.mirrorLookupByProviderEventId = {
      google_evt_mirror_200: "evt_01HXYZ00000000000000000001",
    };

    const googleFetch = createGoogleApiFetch({
      events: [makeManagedMirrorEvent({ status: "cancelled" })],
      nextSyncToken: NEW_SYNC_TOKEN,
    });

    const message: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: ACCOUNT_A.account_id,
      channel_id: "channel-managed-delete-1",
      resource_id: "resource-managed-delete-1",
      ping_ts: new Date().toISOString(),
      calendar_id: null,
    };

    await handleIncrementalSync(message, env, { fetchFn: googleFetch, sleepFn: noopSleep });

    expect(userGraphDOState.applyDeltaCalls).toHaveLength(0);
    expect(userGraphDOState.findCanonicalByMirrorCalls).toEqual([
      {
        target_account_id: ACCOUNT_A.account_id,
        provider_event_id: "google_evt_mirror_200",
      },
    ]);
    expect(userGraphDOState.deleteCanonicalCalls).toEqual([
      {
        canonical_event_id: "evt_01HXYZ00000000000000000001",
        source: `provider:${ACCOUNT_A.account_id}`,
      },
    ]);
  });

  it("delete guard allows small managed-mirror delete batches under configured threshold", async () => {
    env.DELETE_GUARD_MAX_DELETES_PER_SYNC_RUN = "1";
    env.DELETE_GUARD_MAX_DELETES_PER_ACCOUNT_BATCH = "1";
    env.DELETE_GUARD_MAX_DELETES_PER_BATCH = "1";

    userGraphDOState.mirrorLookupByProviderEventId = {
      google_evt_mirror_safe_1: "evt_01HXYZ00000000000000000101",
    };

    const googleFetch = createGoogleApiFetch({
      events: [makeManagedMirrorEvent({ id: "google_evt_mirror_safe_1", status: "cancelled" })],
      nextSyncToken: NEW_SYNC_TOKEN,
    });

    const message: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: ACCOUNT_A.account_id,
      channel_id: "channel-managed-delete-safe",
      resource_id: "resource-managed-delete-safe",
      ping_ts: new Date().toISOString(),
      calendar_id: null,
    };

    await handleIncrementalSync(message, env, { fetchFn: googleFetch, sleepFn: noopSleep });

    expect(userGraphDOState.deleteCanonicalCalls).toEqual([
      {
        canonical_event_id: "evt_01HXYZ00000000000000000101",
        source: `provider:${ACCOUNT_A.account_id}`,
      },
    ]);
    expect(accountDOState.syncFailureCalls).toHaveLength(0);
    expect(accountDOState.syncSuccessCalls).toHaveLength(1);
  });

  it("managed-mirror delete spikes are truncated to one atomic delete", async () => {
    env.DELETE_GUARD_MAX_DELETES_PER_SYNC_RUN = "1";
    env.DELETE_GUARD_MAX_DELETES_PER_ACCOUNT_BATCH = "1";
    env.DELETE_GUARD_MAX_DELETES_PER_BATCH = "2";

    userGraphDOState.mirrorLookupByProviderEventId = {
      google_evt_mirror_spike_1: "evt_01HXYZ00000000000000000111",
      google_evt_mirror_spike_2: "evt_01HXYZ00000000000000000112",
    };

    const googleFetch = createGoogleApiFetch({
      events: [
        makeManagedMirrorEvent({ id: "google_evt_mirror_spike_1", status: "cancelled" }),
        makeManagedMirrorEvent({ id: "google_evt_mirror_spike_2", status: "cancelled" }),
      ],
      nextSyncToken: NEW_SYNC_TOKEN,
    });

    const message: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: ACCOUNT_A.account_id,
      channel_id: "channel-managed-delete-spike",
      resource_id: "resource-managed-delete-spike",
      ping_ts: new Date().toISOString(),
      calendar_id: null,
    };

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let sawGuardAuditLog = false;
    try {
      await handleIncrementalSync(message, env, { fetchFn: googleFetch, sleepFn: noopSleep });
      sawGuardAuditLog = errorSpy.mock.calls.some(
        ([messageText]) => messageText === "sync-consumer: delete_guard_blocked",
      );
    } finally {
      errorSpy.mockRestore();
    }

    expect(userGraphDOState.deleteCanonicalCalls).toEqual([
      {
        canonical_event_id: "evt_01HXYZ00000000000000000111",
        source: `provider:${ACCOUNT_A.account_id}`,
      },
    ]);
    expect(accountDOState.syncSuccessCalls).toHaveLength(1);
    expect(accountDOState.syncFailureCalls).toHaveLength(0);
    expect(sawGuardAuditLog).toBe(false);
  });

  it("google deleted mirror without managed metadata still triggers canonical delete via mirror index", async () => {
    userGraphDOState.activeMirrors = [
      { provider_event_id: "google_evt_mirror_noext" },
    ];
    userGraphDOState.mirrorLookupByProviderEventId = {
      google_evt_mirror_noext: "evt_01HXYZ00000000000000000003",
    };

    const googleFetch = createGoogleApiFetch({
      events: [
        makeGoogleEvent({
          id: "google_evt_mirror_noext",
          status: "cancelled",
          extendedProperties: undefined,
        }),
      ],
      nextSyncToken: NEW_SYNC_TOKEN,
    });

    const message: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: ACCOUNT_A.account_id,
      channel_id: "channel-managed-delete-2",
      resource_id: "resource-managed-delete-2",
      ping_ts: new Date().toISOString(),
      calendar_id: null,
    };

    await handleIncrementalSync(message, env, { fetchFn: googleFetch, sleepFn: noopSleep });

    expect(userGraphDOState.applyDeltaCalls).toHaveLength(0);
    expect(userGraphDOState.findCanonicalByMirrorCalls).toEqual([
      {
        target_account_id: ACCOUNT_A.account_id,
        provider_event_id: "google_evt_mirror_noext",
      },
    ]);
    expect(userGraphDOState.deleteCanonicalCalls).toEqual([
      {
        canonical_event_id: "evt_01HXYZ00000000000000000003",
        source: `provider:${ACCOUNT_A.account_id}`,
      },
    ]);
  });

  // -------------------------------------------------------------------------
  // TM-9eu: Mirror-side modifications write back to canonical
  // -------------------------------------------------------------------------

  it("TM-9eu: modified managed mirror writes back to canonical event", async () => {
    // Setup: mirror lookup resolves to a canonical event
    const CANONICAL_EVENT_ID = "evt_01HXYZ00000000000000000001";
    const ORIGIN_ACCOUNT_ID = "acc_01HXYZ0000000000000000000B";
    const ORIGIN_EVENT_ID = "google_evt_origin_100";

    userGraphDOState.mirrorLookupByProviderEventId = {
      google_evt_mirror_200: CANONICAL_EVENT_ID,
    };
    userGraphDOState.canonicalEventsById = {
      [CANONICAL_EVENT_ID]: {
        event: {
          origin_account_id: ORIGIN_ACCOUNT_ID,
          origin_event_id: ORIGIN_EVENT_ID,
        },
        mirrors: [],
      },
    };

    // The mirror event was modified (title changed) -- NOT deleted
    const googleFetch = createGoogleApiFetch({
      events: [
        makeManagedMirrorEvent({
          summary: "Updated Mirror Title",
          location: "New Room",
        }),
      ],
      nextSyncToken: NEW_SYNC_TOKEN,
    });

    const message: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: ACCOUNT_A.account_id,
      channel_id: "channel-mirror-writeback-1",
      resource_id: "resource-mirror-writeback-1",
      ping_ts: new Date().toISOString(),
      calendar_id: null,
    };

    await handleIncrementalSync(message, env, { fetchFn: googleFetch, sleepFn: noopSleep });

    // Verify: findCanonicalByMirror was called for the mirror
    expect(userGraphDOState.findCanonicalByMirrorCalls).toEqual([
      {
        target_account_id: ACCOUNT_A.account_id,
        provider_event_id: "google_evt_mirror_200",
      },
    ]);

    // Verify: getCanonicalEvent was called to fetch origin keys
    expect(userGraphDOState.getCanonicalEventCalls).toEqual([
      { canonical_event_id: CANONICAL_EVENT_ID },
    ]);

    // Verify: applyProviderDelta was called with the canonical's origin keys
    // and the mirror's modified event payload
    expect(userGraphDOState.applyDeltaCalls).toHaveLength(1);
    const call = userGraphDOState.applyDeltaCalls[0];
    expect(call.account_id).toBe(ORIGIN_ACCOUNT_ID);
    expect(call.deltas).toHaveLength(1);

    const delta = call.deltas[0] as Record<string, unknown>;
    expect(delta.type).toBe("updated");
    expect(delta.origin_event_id).toBe(ORIGIN_EVENT_ID);
    expect(delta.origin_account_id).toBe(ORIGIN_ACCOUNT_ID);
    expect(delta.event).toBeDefined();

    const evt = delta.event as Record<string, unknown>;
    expect(evt.title).toBe("Updated Mirror Title");
    expect(evt.location).toBe("New Room");

    // Verify: no canonical deletes occurred (modification, not deletion)
    expect(userGraphDOState.deleteCanonicalCalls).toHaveLength(0);
  });

  it("TM-9eu: mirror deletion still uses existing delete path (not writeback)", async () => {
    // This verifies AC3: mirror delete behavior is unchanged
    userGraphDOState.mirrorLookupByProviderEventId = {
      google_evt_mirror_200: "evt_01HXYZ00000000000000000001",
    };

    const googleFetch = createGoogleApiFetch({
      events: [makeManagedMirrorEvent({ status: "cancelled" })],
      nextSyncToken: NEW_SYNC_TOKEN,
    });

    const message: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: ACCOUNT_A.account_id,
      channel_id: "channel-mirror-delete-unchanged",
      resource_id: "resource-mirror-delete-unchanged",
      ping_ts: new Date().toISOString(),
      calendar_id: null,
    };

    await handleIncrementalSync(message, env, { fetchFn: googleFetch, sleepFn: noopSleep });

    // Delete path: findCanonicalByMirror + deleteCanonicalEvent (no applyProviderDelta)
    expect(userGraphDOState.findCanonicalByMirrorCalls).toHaveLength(1);
    expect(userGraphDOState.deleteCanonicalCalls).toHaveLength(1);
    expect(userGraphDOState.applyDeltaCalls).toHaveLength(0);
    // getCanonicalEvent should NOT be called for deletes
    expect(userGraphDOState.getCanonicalEventCalls).toHaveLength(0);
  });

  it("TM-9eu: orphaned mirror (no canonical found) is silently skipped", async () => {
    // mirrorLookupByProviderEventId is empty -- no canonical for this mirror
    userGraphDOState.mirrorLookupByProviderEventId = {};

    const googleFetch = createGoogleApiFetch({
      events: [
        makeManagedMirrorEvent({
          summary: "Orphaned Mirror Edit",
        }),
      ],
      nextSyncToken: NEW_SYNC_TOKEN,
    });

    const message: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: ACCOUNT_A.account_id,
      channel_id: "channel-mirror-orphan-1",
      resource_id: "resource-mirror-orphan-1",
      ping_ts: new Date().toISOString(),
      calendar_id: null,
    };

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await handleIncrementalSync(message, env, { fetchFn: googleFetch, sleepFn: noopSleep });

    // No applyProviderDelta or deleteCanonicalEvent calls
    expect(userGraphDOState.applyDeltaCalls).toHaveLength(0);
    expect(userGraphDOState.deleteCanonicalCalls).toHaveLength(0);
    // getCanonicalEvent should NOT be called (we short-circuited)
    expect(userGraphDOState.getCanonicalEventCalls).toHaveLength(0);

    // Verify warning was logged for orphaned mirror
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("mirror writeback skipped, orphaned mirror"),
    );

    warnSpy.mockRestore();
  });

  it("google incremental sync reads overlay scopes and propagates overlay deletes", async () => {
    accountDOState.calendarScopes = [
      {
        provider_calendar_id: "primary",
        enabled: true,
        sync_enabled: true,
      },
      {
        provider_calendar_id: "overlay_busy_123@group.calendar.google.com",
        enabled: true,
        sync_enabled: true,
      },
    ];
    accountDOState.scopedSyncTokens = {
      primary: "sync-token-primary-old",
      "overlay_busy_123@group.calendar.google.com": "sync-token-overlay-old",
    };

    userGraphDOState.activeMirrors = [
      { provider_event_id: "google_evt_overlay_deleted" },
    ];
    userGraphDOState.mirrorLookupByProviderEventId = {
      google_evt_overlay_deleted: "evt_01HXYZ00000000000000000006",
    };

    const requestedCalendarIds: string[] = [];
    const googleFetch = async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string"
        ? new URL(input)
        : input instanceof URL
        ? input
        : new URL(input.url);

      if (!url.pathname.includes("/calendars/") || !url.pathname.includes("/events")) {
        return new Response("Not found", { status: 404 });
      }

      const match = url.pathname.match(/\/calendars\/([^/]+)\/events/);
      const calendarId = match ? decodeURIComponent(match[1]) : "unknown";
      requestedCalendarIds.push(calendarId);

      if (calendarId === "primary") {
        return new Response(
          JSON.stringify({
            items: [],
            nextSyncToken: "sync-token-primary-new",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (calendarId === "overlay_busy_123@group.calendar.google.com") {
        return new Response(
          JSON.stringify({
            items: [
              makeGoogleEvent({
                id: "google_evt_overlay_deleted",
                status: "cancelled",
                extendedProperties: undefined,
              }),
            ],
            nextSyncToken: "sync-token-overlay-new",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response("Unexpected calendar", { status: 500 });
    };

    const message: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: ACCOUNT_A.account_id,
      channel_id: "channel-overlay-delete",
      resource_id: "resource-overlay-delete",
      ping_ts: new Date().toISOString(),
      calendar_id: null,
    };

    await handleIncrementalSync(message, env, { fetchFn: googleFetch, sleepFn: noopSleep });

    expect(requestedCalendarIds).toEqual([
      "primary",
      "overlay_busy_123@group.calendar.google.com",
    ]);

    expect(userGraphDOState.deleteCanonicalCalls).toEqual([
      {
        canonical_event_id: "evt_01HXYZ00000000000000000006",
        source: `provider:${ACCOUNT_A.account_id}`,
      },
    ]);

    expect(accountDOState.setScopedSyncTokenCalls).toEqual(
      expect.arrayContaining([
        {
          provider_calendar_id: "primary",
          sync_token: "sync-token-primary-new",
        },
        {
          provider_calendar_id: "overlay_busy_123@group.calendar.google.com",
          sync_token: "sync-token-overlay-new",
        },
      ]),
    );
    expect(accountDOState.setSyncTokenCalls).toContain("sync-token-primary-new");
  });

  it("google incremental sync falls back to mirror target calendars when scopes are missing overlays", async () => {
    accountDOState.calendarScopes = [
      {
        provider_calendar_id: "primary",
        enabled: true,
        sync_enabled: true,
      },
    ];
    accountDOState.scopedSyncTokens = {
      primary: "sync-token-primary-old",
      "overlay_busy_legacy@group.calendar.google.com": "sync-token-overlay-old",
    };

    userGraphDOState.activeMirrors = [
      {
        provider_event_id: "google_evt_overlay_legacy_deleted",
        target_calendar_id: "overlay_busy_legacy@group.calendar.google.com",
      },
    ];
    userGraphDOState.mirrorLookupByProviderEventId = {
      google_evt_overlay_legacy_deleted: "evt_01HXYZ00000000000000000007",
    };

    const requestedCalendarIds: string[] = [];
    const googleFetch = async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string"
        ? new URL(input)
        : input instanceof URL
        ? input
        : new URL(input.url);

      if (!url.pathname.includes("/calendars/") || !url.pathname.includes("/events")) {
        return new Response("Not found", { status: 404 });
      }

      const match = url.pathname.match(/\/calendars\/([^/]+)\/events/);
      const calendarId = match ? decodeURIComponent(match[1]) : "unknown";
      requestedCalendarIds.push(calendarId);

      if (calendarId === "primary") {
        return new Response(
          JSON.stringify({
            items: [],
            nextSyncToken: "sync-token-primary-new",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (calendarId === "overlay_busy_legacy@group.calendar.google.com") {
        return new Response(
          JSON.stringify({
            items: [
              makeGoogleEvent({
                id: "google_evt_overlay_legacy_deleted",
                status: "cancelled",
                extendedProperties: undefined,
              }),
            ],
            nextSyncToken: "sync-token-overlay-new",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response("Unexpected calendar", { status: 500 });
    };

    const message: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: ACCOUNT_A.account_id,
      channel_id: "channel-overlay-fallback-delete",
      resource_id: "resource-overlay-fallback-delete",
      ping_ts: new Date().toISOString(),
      calendar_id: null,
    };

    await handleIncrementalSync(message, env, { fetchFn: googleFetch, sleepFn: noopSleep });

    expect(requestedCalendarIds).toEqual([
      "primary",
      "overlay_busy_legacy@group.calendar.google.com",
    ]);
    expect(userGraphDOState.deleteCanonicalCalls).toEqual([
      {
        canonical_event_id: "evt_01HXYZ00000000000000000007",
        source: `provider:${ACCOUNT_A.account_id}`,
      },
    ]);
    expect(accountDOState.setScopedSyncTokenCalls).toEqual(
      expect.arrayContaining([
        {
          provider_calendar_id: "primary",
          sync_token: "sync-token-primary-new",
        },
        {
          provider_calendar_id: "overlay_busy_legacy@group.calendar.google.com",
          sync_token: "sync-token-overlay-new",
        },
      ]),
    );
  });

  it("google incremental enqueues full sync when overlay scope has no cursor", async () => {
    accountDOState.calendarScopes = [
      {
        provider_calendar_id: "primary",
        enabled: true,
        sync_enabled: true,
      },
    ];
    accountDOState.scopedSyncTokens = {
      primary: "sync-token-primary-old",
    };
    userGraphDOState.activeMirrors = [
      {
        provider_event_id: "google_evt_overlay_bootstrap",
        target_calendar_id: "overlay_bootstrap_missing_cursor@group.calendar.google.com",
      },
    ];

    const googleFetch = async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string"
        ? new URL(input)
        : input instanceof URL
        ? input
        : new URL(input.url);
      const match = url.pathname.match(/\/calendars\/([^/]+)\/events/);
      const calendarId = match ? decodeURIComponent(match[1]) : "unknown";

      if (calendarId === "primary") {
        return new Response(
          JSON.stringify({
            items: [],
            nextSyncToken: "sync-token-primary-new",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (calendarId === "overlay_bootstrap_missing_cursor@group.calendar.google.com") {
        return new Response(
          JSON.stringify({
            items: [],
            nextSyncToken: "sync-token-overlay-new",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response("Unexpected calendar", { status: 500 });
    };

    const message: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: ACCOUNT_A.account_id,
      channel_id: "channel-overlay-bootstrap",
      resource_id: "resource-overlay-bootstrap",
      ping_ts: new Date().toISOString(),
      calendar_id: null,
    };

    await handleIncrementalSync(message, env, { fetchFn: googleFetch, sleepFn: noopSleep });

    expect(syncQueue.messages).toHaveLength(1);
    const enqueued = syncQueue.messages[0] as Record<string, unknown>;
    expect(enqueued.type).toBe("SYNC_FULL");
    expect(userGraphDOState.applyDeltaCalls).toHaveLength(0);
    expect(accountDOState.setSyncTokenCalls).toHaveLength(0);
  });

  it("google incremental skips unavailable overlay calendars (404) and continues syncing", async () => {
    accountDOState.calendarScopes = [
      {
        provider_calendar_id: "primary",
        enabled: true,
        sync_enabled: true,
      },
    ];
    accountDOState.scopedSyncTokens = {
      primary: "sync-token-primary-old",
      "overlay_missing_scope@group.calendar.google.com": "sync-token-missing-old",
    };
    userGraphDOState.activeMirrors = [
      {
        provider_event_id: null,
        target_calendar_id: "overlay_missing_scope@group.calendar.google.com",
      },
    ];

    const googleFetch = async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string"
        ? new URL(input)
        : input instanceof URL
        ? input
        : new URL(input.url);
      const match = url.pathname.match(/\/calendars\/([^/]+)\/events/);
      const calendarId = match ? decodeURIComponent(match[1]) : "unknown";

      if (calendarId === "primary") {
        return new Response(
          JSON.stringify({
            items: [makeGoogleEvent({ id: "google_evt_primary_only_after_404" })],
            nextSyncToken: "sync-token-primary-new",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (calendarId === "overlay_missing_scope@group.calendar.google.com") {
        return new Response(
          JSON.stringify({
            error: {
              code: 404,
              message: "Not Found",
              errors: [{ domain: "global", reason: "notFound", message: "Not Found" }],
            },
          }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response("Unexpected calendar", { status: 500 });
    };

    const message: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: ACCOUNT_A.account_id,
      channel_id: "channel-overlay-404",
      resource_id: "resource-overlay-404",
      ping_ts: new Date().toISOString(),
      calendar_id: null,
    };

    await handleIncrementalSync(message, env, { fetchFn: googleFetch, sleepFn: noopSleep });

    expect(syncQueue.messages).toHaveLength(0);
    expect(userGraphDOState.applyDeltaCalls).toHaveLength(1);
    expect(userGraphDOState.applyDeltaCalls[0].deltas).toHaveLength(1);
    expect(accountDOState.setSyncTokenCalls).toContain("sync-token-primary-new");
  });

  it("google deleted mirror resolves canonical via direct lookup when active mirror index is stale", async () => {
    userGraphDOState.activeMirrors = [];
    userGraphDOState.mirrorLookupByProviderEventId = {
      google_evt_mirror_stale_index: "evt_01HXYZ00000000000000000005",
    };

    const googleFetch = createGoogleApiFetch({
      events: [
        makeGoogleEvent({
          id: "google_evt_mirror_stale_index",
          status: "cancelled",
          extendedProperties: undefined,
        }),
      ],
      nextSyncToken: NEW_SYNC_TOKEN,
    });

    const message: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: ACCOUNT_A.account_id,
      channel_id: "channel-managed-delete-stale-index",
      resource_id: "resource-managed-delete-stale-index",
      ping_ts: new Date().toISOString(),
      calendar_id: null,
    };

    await handleIncrementalSync(message, env, { fetchFn: googleFetch, sleepFn: noopSleep });

    expect(userGraphDOState.applyDeltaCalls).toHaveLength(0);
    expect(userGraphDOState.findCanonicalByMirrorCalls).toEqual([
      {
        target_account_id: ACCOUNT_A.account_id,
        provider_event_id: "google_evt_mirror_stale_index",
      },
      {
        target_account_id: ACCOUNT_A.account_id,
        provider_event_id: "google_evt_mirror_stale_index",
      },
    ]);
    expect(userGraphDOState.deleteCanonicalCalls).toEqual([
      {
        canonical_event_id: "evt_01HXYZ00000000000000000005",
        source: `provider:${ACCOUNT_A.account_id}`,
      },
    ]);
  });

  it("google deleted mirror resolves canonical even when event ID encoding differs", async () => {
    userGraphDOState.activeMirrors = [
      { provider_event_id: "AAMkAGI2TQABAAA%2FAAABBB%3D%3D" },
    ];
    userGraphDOState.mirrorLookupByProviderEventId = {
      "AAMkAGI2TQABAAA%2FAAABBB%3D%3D": "evt_01HXYZ00000000000000000004",
    };

    const googleFetch = createGoogleApiFetch({
      events: [
        makeGoogleEvent({
          id: "AAMkAGI2TQABAAA/AAABBB==",
          status: "cancelled",
          extendedProperties: undefined,
        }),
      ],
      nextSyncToken: NEW_SYNC_TOKEN,
    });

    const message: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: ACCOUNT_A.account_id,
      channel_id: "channel-managed-delete-encoded",
      resource_id: "resource-managed-delete-encoded",
      ping_ts: new Date().toISOString(),
      calendar_id: null,
    };

    await handleIncrementalSync(message, env, { fetchFn: googleFetch, sleepFn: noopSleep });

    expect(userGraphDOState.applyDeltaCalls).toHaveLength(0);
    expect(userGraphDOState.findCanonicalByMirrorCalls).toEqual([
      {
        target_account_id: ACCOUNT_A.account_id,
        provider_event_id: "AAMkAGI2TQABAAA/AAABBB==",
      },
      {
        target_account_id: ACCOUNT_A.account_id,
        provider_event_id: "AAMkAGI2TQABAAA%2FAAABBB%3D%3D",
      },
    ]);
    expect(userGraphDOState.deleteCanonicalCalls).toEqual([
      {
        canonical_event_id: "evt_01HXYZ00000000000000000004",
        source: `provider:${ACCOUNT_A.account_id}`,
      },
    ]);
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
      calendar_id: null,
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
      calendar_id: null,
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
      calendar_id: null,
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
      calendar_id: null,
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
      calendar_id: null,
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
      calendar_id: null,
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
      calendar_id: null,
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
            calendar_id: null,
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
      calendar_id: null,
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
      calendar_id: null,
    };

    await handleIncrementalSync(message, env, { sleepFn: noopSleep });

    expect(userGraphDOState.applyDeltaCalls).toHaveLength(0);
    expect(accountDOState.syncSuccessCalls).toHaveLength(0);
    expect(accountDOState.syncFailureCalls).toHaveLength(1);
    expect(accountDOState.syncFailureCalls[0].error).toContain("invalid_grant");
  });

  // -------------------------------------------------------------------------
  // TM-08pp: Provider event ID canonicalization at ingestion
  // -------------------------------------------------------------------------

  it("TM-08pp: incremental sync normalizes URL-encoded provider_event_id to canonical form", async () => {
    // Google returns an event with a URL-encoded ID (@ encoded as %40)
    const encodedId = "event123_R20260215T090000%40google.com";
    const expectedCanonicalId = "event123_R20260215T090000@google.com";

    const googleFetch = createGoogleApiFetch({
      events: [
        makeGoogleEvent({
          id: encodedId,
          summary: "Encoded Event",
        }),
      ],
      nextSyncToken: "sync-token-canonical-test",
    });

    const message: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: ACCOUNT_A.account_id,
      channel_id: "channel-canonical-1",
      resource_id: "resource-canonical-1",
      ping_ts: new Date().toISOString(),
      calendar_id: null,
    };

    await handleIncrementalSync(message, env, {
      fetchFn: googleFetch,
      sleepFn: noopSleep,
    });

    // Verify deltas sent to UserGraphDO contain the canonical (decoded) ID
    expect(userGraphDOState.applyDeltaCalls).toHaveLength(1);
    const deltas = userGraphDOState.applyDeltaCalls[0].deltas as Array<{
      origin_event_id: string;
    }>;
    expect(deltas).toHaveLength(1);
    expect(deltas[0].origin_event_id).toBe(expectedCanonicalId);
  });

  it("TM-08pp: incremental sync normalizes double-encoded provider_event_id", async () => {
    // Double-encoded: @ -> %40 -> %2540
    const doubleEncodedId = "meeting%2540calendar.google.com";
    const expectedCanonicalId = "meeting@calendar.google.com";

    const googleFetch = createGoogleApiFetch({
      events: [
        makeGoogleEvent({
          id: doubleEncodedId,
          summary: "Double Encoded Event",
        }),
      ],
      nextSyncToken: "sync-token-double-encoded",
    });

    const message: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: ACCOUNT_A.account_id,
      channel_id: "channel-canonical-2",
      resource_id: "resource-canonical-2",
      ping_ts: new Date().toISOString(),
      calendar_id: null,
    };

    await handleIncrementalSync(message, env, {
      fetchFn: googleFetch,
      sleepFn: noopSleep,
    });

    expect(userGraphDOState.applyDeltaCalls).toHaveLength(1);
    const deltas = userGraphDOState.applyDeltaCalls[0].deltas as Array<{
      origin_event_id: string;
    }>;
    expect(deltas).toHaveLength(1);
    expect(deltas[0].origin_event_id).toBe(expectedCanonicalId);
  });

  it("TM-08pp: plain (unencoded) provider_event_id passes through unchanged", async () => {
    const plainId = "simple_event_id_no_encoding";

    const googleFetch = createGoogleApiFetch({
      events: [
        makeGoogleEvent({
          id: plainId,
          summary: "Plain Event",
        }),
      ],
      nextSyncToken: "sync-token-plain",
    });

    const message: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: ACCOUNT_A.account_id,
      channel_id: "channel-canonical-3",
      resource_id: "resource-canonical-3",
      ping_ts: new Date().toISOString(),
      calendar_id: null,
    };

    await handleIncrementalSync(message, env, {
      fetchFn: googleFetch,
      sleepFn: noopSleep,
    });

    expect(userGraphDOState.applyDeltaCalls).toHaveLength(1);
    const deltas = userGraphDOState.applyDeltaCalls[0].deltas as Array<{
      origin_event_id: string;
    }>;
    expect(deltas).toHaveLength(1);
    expect(deltas[0].origin_event_id).toBe(plainId);
  });

  it("TM-08pp: all encoding variants of same event resolve to same canonical form", async () => {
    // Three different events with IDs that are encoding variants of the same logical ID.
    // After canonicalization, they should all produce the same origin_event_id.
    // The sync-consumer normalizes each delta's origin_event_id to canonical form.
    // Actual dedup (upsert by origin_event_id) happens in UserGraphDO, not here.
    // This test verifies all variants converge to the same canonical ID.
    const canonicalId = "event@calendar/2026";
    const singleEncoded = "event%40calendar%2F2026";
    const doubleEncoded = "event%2540calendar%252F2026";

    const googleFetch = createGoogleApiFetch({
      events: [
        makeGoogleEvent({ id: singleEncoded, summary: "Single Encoded" }),
        makeGoogleEvent({ id: doubleEncoded, summary: "Double Encoded" }),
        makeGoogleEvent({ id: canonicalId, summary: "Already Canonical" }),
      ],
      nextSyncToken: "sync-token-variants",
    });

    const message: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: ACCOUNT_A.account_id,
      channel_id: "channel-canonical-4",
      resource_id: "resource-canonical-4",
      ping_ts: new Date().toISOString(),
      calendar_id: null,
    };

    await handleIncrementalSync(message, env, {
      fetchFn: googleFetch,
      sleepFn: noopSleep,
    });

    // All three events canonicalize to the same origin_event_id.
    // Cross-scope dedup (TM-8gfd.5) collapses duplicates, so only 1 delta
    // reaches UserGraphDO -- this is the correct behavior.
    expect(userGraphDOState.applyDeltaCalls).toHaveLength(1);
    const deltas = userGraphDOState.applyDeltaCalls[0].deltas as Array<{
      origin_event_id: string;
    }>;
    expect(deltas).toHaveLength(1);
    expect(deltas[0].origin_event_id).toBe(canonicalId);
  });

  it("TM-08pp: full sync normalizes provider_event_id values", async () => {
    const encodedId = "full_sync_event%40provider.com";
    const expectedCanonicalId = "full_sync_event@provider.com";

    const googleFetch = createGoogleApiFetch({
      events: [
        makeGoogleEvent({
          id: encodedId,
          summary: "Full Sync Encoded Event",
        }),
      ],
      nextSyncToken: "sync-token-full-canonical",
    });

    const message: SyncFullMessage = {
      type: "SYNC_FULL",
      account_id: ACCOUNT_A.account_id,
      reason: "reconcile",
    };

    await handleFullSync(message, env, {
      fetchFn: googleFetch,
      sleepFn: noopSleep,
    });

    expect(userGraphDOState.applyDeltaCalls).toHaveLength(1);
    const deltas = userGraphDOState.applyDeltaCalls[0].deltas as Array<{
      origin_event_id: string;
    }>;
    expect(deltas).toHaveLength(1);
    expect(deltas[0].origin_event_id).toBe(expectedCanonicalId);
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
    calendar_id: null,
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
        scopedSyncTokens: { primary: TEST_SYNC_TOKEN },
        setScopedSyncTokenCalls: [],
        calendarScopes: [
          {
            provider_calendar_id: "primary",
            enabled: true,
            sync_enabled: true,
          },
        ],
      };

      env = createMockEnv({
        d1,
        syncQueue,
        writeQueue,
        accountDOState,
        userGraphDOState: {
          applyDeltaCalls: [],
          deleteCanonicalCalls: [],
          findCanonicalByMirrorCalls: [],
          canonicalOriginEvents: [],
          activeMirrors: [],
          mirrorLookupByProviderEventId: {},
        },
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
// TM-9fc9: extractMicrosoftEventId unit tests
// ---------------------------------------------------------------------------

describe("extractMicrosoftEventId", () => {
  it("extracts event ID from 'me/events/{id}' path", () => {
    expect(extractMicrosoftEventId("me/events/AAMkAG-abc-123")).toBe("AAMkAG-abc-123");
  });

  it("extracts event ID from 'users/{uid}/events/{id}' path", () => {
    expect(extractMicrosoftEventId("users/user-uuid/events/AAMkAG-def-456")).toBe("AAMkAG-def-456");
  });

  it("returns null for non-event resource paths", () => {
    expect(extractMicrosoftEventId("me/calendars/some-calendar-id")).toBeNull();
    expect(extractMicrosoftEventId("me/messages/msg-123")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractMicrosoftEventId("")).toBeNull();
  });

  it("extracts event ID with special characters", () => {
    expect(extractMicrosoftEventId("me/events/AAMkAGU0OGRhZmI3=")).toBe("AAMkAGU0OGRhZmI3=");
  });

  it("handles deeply nested resource path", () => {
    expect(extractMicrosoftEventId("users/uid/calendarGroups/grp/calendars/cal/events/evt-789")).toBe("evt-789");
  });

  it("matches event segment case-insensitively", () => {
    expect(extractMicrosoftEventId("Users/uid/Events/AAMkAG-case-001")).toBe(
      "AAMkAG-case-001",
    );
  });

  it("extracts event ID from events('{id}') resource shape", () => {
    expect(extractMicrosoftEventId("users/uid/events('AAMkAG-paren-321')")).toBe(
      "AAMkAG-paren-321",
    );
  });

  it("ignores query strings when extracting event ID", () => {
    expect(extractMicrosoftEventId("me/events/AAMkAG-query-777?$select=id")).toBe(
      "AAMkAG-query-777",
    );
  });

  it("preserves slash-containing IDs from decoded resource paths", () => {
    expect(extractMicrosoftEventId("me/events/AAMkAGI2TQABAAA/AAABBB==")).toBe(
      "AAMkAGI2TQABAAA/AAABBB==",
    );
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
      scopedSyncTokens: {
        primary: MS_DELTA_LINK,
      },
      setScopedSyncTokenCalls: [],
      calendarScopes: [
        {
          provider_calendar_id: "primary",
          enabled: true,
          sync_enabled: true,
        },
      ],
    };

    userGraphDOState = {
      applyDeltaCalls: [],
      deleteCanonicalCalls: [],
      findCanonicalByMirrorCalls: [],
      getActiveMirrorsCalls: [],
      canonicalOriginEvents: [],
      activeMirrors: [],
      mirrorLookupByProviderEventId: {},
      findCanonicalByMirrorErrorsByProviderEventId: {},
      canonicalEventsById: {},
      getCanonicalEventCalls: [],
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
      calendar_id: null,
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

  it("scheduled microsoft sweep with mirror-only updates does not auto-enqueue SYNC_FULL", async () => {
    const mirrorEventId = "AAMkAG-ms-mirror-200";
    const canonicalEventId = "evt_01HXYZ00000000000000000001";

    userGraphDOState.activeMirrors = [
      { provider_event_id: mirrorEventId, target_calendar_id: "primary" },
    ];
    userGraphDOState.mirrorLookupByProviderEventId = {
      [mirrorEventId]: canonicalEventId,
    };
    userGraphDOState.canonicalEventsById = {
      [canonicalEventId]: {
        event: {
          origin_account_id: "acc_01HXYZ0000000000000000000A",
          origin_event_id: "google_evt_origin_200",
          title: "Busy",
          start: { dateTime: "2026-02-15T11:00:00.0000000", timeZone: "UTC" },
          end: { dateTime: "2026-02-15T12:00:00.0000000", timeZone: "UTC" },
          all_day: false,
          status: "confirmed",
          visibility: "default",
          transparency: "opaque",
        },
        mirrors: [],
      },
    };

    const msFetch = createMicrosoftApiFetch({
      events: [makeMicrosoftManagedMirrorEvent()],
      deltaLink: MS_NEW_DELTA_LINK,
    });

    const message: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: MS_ACCOUNT_B.account_id,
      channel_id: `scheduled-ms-${MS_ACCOUNT_B.account_id}`,
      resource_id: `scheduled-ms:${MS_ACCOUNT_B.account_id}:2026-02-23T05:15:37.000Z`,
      ping_ts: new Date().toISOString(),
      calendar_id: null,
    };

    await handleIncrementalSync(message, env, { fetchFn: msFetch, sleepFn: noopSleep });

    expect(userGraphDOState.applyDeltaCalls).toHaveLength(0);
    expect(userGraphDOState.deleteCanonicalCalls).toHaveLength(0);
    expect(accountDOState.syncSuccessCalls).toHaveLength(1);
    expect(syncQueue.messages).toHaveLength(0);
  });

  it("scheduled microsoft sweep reconciles missing managed mirror via bounded snapshot check", async () => {
    const mirrorEventId = "AAMkAG-ms-mirror-missing-6543";
    const canonicalEventId = "evt_01HXYZ000000000000000006543";

    userGraphDOState.activeMirrors = [
      { provider_event_id: mirrorEventId, target_calendar_id: "primary" },
    ];
    userGraphDOState.mirrorLookupByProviderEventId = {
      [mirrorEventId]: canonicalEventId,
    };
    userGraphDOState.canonicalEventsById = {
      [canonicalEventId]: {
        event: {
          origin_account_id: "acc_01HXYZ0000000000000000000A",
          origin_event_id: "google_evt_origin_6543",
          title: "t6543",
          start: { dateTime: "2026-02-23T20:55:00.000Z", timeZone: "UTC" },
          end: { dateTime: "2026-02-23T21:25:00.000Z", timeZone: "UTC" },
          all_day: false,
          status: "confirmed",
          visibility: "default",
          transparency: "opaque",
        },
        mirrors: [],
      },
    };

    const msFetch = async (
      input: string | URL | Request,
      _init?: RequestInit,
    ): Promise<Response> => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

      if (
        url.includes("graph.microsoft.com") &&
        url.includes("/me/calendars?") &&
        url.includes("isDefaultCalendar")
      ) {
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

      if (url.includes("graph.microsoft.com") && url.includes("deltatoken=")) {
        return new Response(
          JSON.stringify({
            value: [],
            "@odata.deltaLink": MS_NEW_DELTA_LINK,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      // Snapshot reconcile call (no deltatoken): mirror is missing upstream.
      if (url.includes("graph.microsoft.com") && url.includes("/calendarView/delta?")) {
        return new Response(
          JSON.stringify({
            value: [],
            "@odata.deltaLink":
              "https://graph.microsoft.com/v1.0/me/calendars/cal_ms_default/events/delta?$deltatoken=snapshot-new",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      return new Response("Not found", { status: 404 });
    };

    const message: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: MS_ACCOUNT_B.account_id,
      channel_id: `scheduled-ms-${MS_ACCOUNT_B.account_id}`,
      resource_id: `scheduled-ms:${MS_ACCOUNT_B.account_id}:2026-02-23T05:45:00.000Z`,
      ping_ts: new Date().toISOString(),
      calendar_id: null,
    };

    await handleIncrementalSync(message, env, { fetchFn: msFetch, sleepFn: noopSleep });

    expect(userGraphDOState.deleteCanonicalCalls).toHaveLength(1);
    expect(userGraphDOState.deleteCanonicalCalls[0].canonical_event_id).toBe(canonicalEventId);
    expect(accountDOState.syncSuccessCalls).toHaveLength(1);
    expect(syncQueue.messages).toHaveLength(0);
  });

  it("scheduled microsoft sweep includes pending mirrors with provider_event_id for reconcile", async () => {
    const mirrorEventId = "AAMkAG-ms-mirror-pending-9001";
    const canonicalEventId = "evt_01HXYZ000000000000000009001";
    const nowIso = new Date().toISOString();

    userGraphDOState.activeMirrors = [
      {
        provider_event_id: mirrorEventId,
        target_calendar_id: "primary",
        canonical_event_id: canonicalEventId,
        state: "PENDING",
        last_write_ts: nowIso,
      },
      {
        provider_event_id: null,
        target_calendar_id: "primary",
        state: "PENDING",
        last_write_ts: nowIso,
      },
    ];
    userGraphDOState.mirrorLookupByProviderEventId = {
      [mirrorEventId]: canonicalEventId,
    };
    userGraphDOState.canonicalEventsById = {
      [canonicalEventId]: {
        event: {
          origin_account_id: "acc_01HXYZ0000000000000000000A",
          origin_event_id: "google_evt_origin_pending_9001",
          title: "Pending mirror candidate",
          start: { dateTime: nowIso, timeZone: "UTC" },
          end: { dateTime: nowIso, timeZone: "UTC" },
          updated_at: nowIso,
          all_day: false,
          status: "confirmed",
          visibility: "default",
          transparency: "opaque",
        },
        mirrors: [],
      },
    };

    const msFetch = async (
      input: string | URL | Request,
      _init?: RequestInit,
    ): Promise<Response> => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

      if (
        url.includes("graph.microsoft.com") &&
        url.includes("/me/calendars?") &&
        url.includes("isDefaultCalendar")
      ) {
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

      if (url.includes("graph.microsoft.com") && url.includes("deltatoken=")) {
        return new Response(
          JSON.stringify({
            value: [],
            "@odata.deltaLink": MS_NEW_DELTA_LINK,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      if (url.includes("graph.microsoft.com") && url.includes("/calendarView/delta?")) {
        return new Response(
          JSON.stringify({
            value: [],
            "@odata.deltaLink":
              "https://graph.microsoft.com/v1.0/me/calendars/cal_ms_default/events/delta?$deltatoken=snapshot-pending",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      if (url.includes("graph.microsoft.com") && url.includes("/me/events/")) {
        return new Response("Not found", { status: 404 });
      }

      return new Response("Not found", { status: 404 });
    };

    const message: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: MS_ACCOUNT_B.account_id,
      channel_id: `scheduled-ms-${MS_ACCOUNT_B.account_id}`,
      resource_id: `scheduled-ms:${MS_ACCOUNT_B.account_id}:2026-02-23T06:15:00.000Z`,
      ping_ts: new Date().toISOString(),
      calendar_id: null,
    };

    await handleIncrementalSync(message, env, { fetchFn: msFetch, sleepFn: noopSleep });

    expect(
      userGraphDOState.getActiveMirrorsCalls.some(
        (call) => call.include_pending_with_provider_id === true,
      ),
    ).toBe(true);
    expect(userGraphDOState.deleteCanonicalCalls).toHaveLength(1);
    expect(userGraphDOState.deleteCanonicalCalls[0].canonical_event_id).toBe(canonicalEventId);
    expect(accountDOState.syncSuccessCalls).toHaveLength(1);
  });

  it("scheduled microsoft sweep does not delete when provider probe confirms mirror still exists", async () => {
    const mirrorEventId = "AAMkAG-ms-mirror-still-exists";
    const canonicalEventId = "evt_01HXYZ000000000000000006544";

    userGraphDOState.activeMirrors = [
      { provider_event_id: mirrorEventId, target_calendar_id: "primary" },
    ];
    userGraphDOState.mirrorLookupByProviderEventId = {
      [mirrorEventId]: canonicalEventId,
    };
    userGraphDOState.canonicalEventsById = {
      [canonicalEventId]: {
        event: {
          origin_account_id: "acc_01HXYZ0000000000000000000A",
          origin_event_id: "google_evt_origin_6544",
          title: "still exists upstream",
          start: { dateTime: "2026-02-23T21:00:00.000Z", timeZone: "UTC" },
          end: { dateTime: "2026-02-23T21:30:00.000Z", timeZone: "UTC" },
          all_day: false,
          status: "confirmed",
          visibility: "default",
          transparency: "opaque",
        },
        mirrors: [],
      },
    };

    const msFetch = async (
      input: string | URL | Request,
      _init?: RequestInit,
    ): Promise<Response> => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

      if (
        url.includes("graph.microsoft.com") &&
        url.includes("/me/calendars?") &&
        url.includes("isDefaultCalendar")
      ) {
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

      if (url.includes("graph.microsoft.com") && url.includes("deltatoken=")) {
        return new Response(
          JSON.stringify({
            value: [],
            "@odata.deltaLink": MS_NEW_DELTA_LINK,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      // Snapshot reconcile says missing...
      if (url.includes("graph.microsoft.com") && url.includes("/calendarView/delta?")) {
        return new Response(
          JSON.stringify({
            value: [],
            "@odata.deltaLink":
              "https://graph.microsoft.com/v1.0/me/calendars/cal_ms_default/events/delta?$deltatoken=snapshot-new-exists",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      // ...but direct probe confirms event still exists; no delete should occur.
      if (
        url.includes("graph.microsoft.com") &&
        url.includes("/me/events/") &&
        url.includes("?$select=id")
      ) {
        return new Response(
          JSON.stringify({ id: mirrorEventId }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      return new Response("Not found", { status: 404 });
    };

    const message: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: MS_ACCOUNT_B.account_id,
      channel_id: `scheduled-ms-${MS_ACCOUNT_B.account_id}`,
      resource_id: `scheduled-ms:${MS_ACCOUNT_B.account_id}:2026-02-23T05:45:00.000Z`,
      ping_ts: new Date().toISOString(),
      calendar_id: null,
    };

    await handleIncrementalSync(message, env, { fetchFn: msFetch, sleepFn: noopSleep });

    expect(userGraphDOState.deleteCanonicalCalls).toHaveLength(0);
    expect(accountDOState.syncSuccessCalls).toHaveLength(1);
    expect(syncQueue.messages).toHaveLength(0);
  });

  it("scheduled microsoft sweep does not reconcile-delete historical missing mirrors", async () => {
    const mirrorEventId = "AAMkAG-ms-mirror-old-1";
    const canonicalEventId = "evt_01HXYZ000000000000000009001";

    userGraphDOState.activeMirrors = [
      { provider_event_id: mirrorEventId, target_calendar_id: "primary" },
    ];
    userGraphDOState.mirrorLookupByProviderEventId = {
      [mirrorEventId]: canonicalEventId,
    };
    userGraphDOState.canonicalEventsById = {
      [canonicalEventId]: {
        event: {
          origin_account_id: "acc_01HXYZ0000000000000000000A",
          origin_event_id: "google_evt_origin_old_1",
          title: "Historical event",
          start: { dateTime: "2024-01-01T10:00:00.000Z", timeZone: "UTC" },
          end: { dateTime: "2024-01-01T11:00:00.000Z", timeZone: "UTC" },
          all_day: false,
          status: "confirmed",
          visibility: "default",
          transparency: "opaque",
        },
        mirrors: [],
      },
    };

    const msFetch = async (
      input: string | URL | Request,
      _init?: RequestInit,
    ): Promise<Response> => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

      if (
        url.includes("graph.microsoft.com") &&
        url.includes("/me/calendars?") &&
        url.includes("isDefaultCalendar")
      ) {
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

      if (url.includes("graph.microsoft.com") && url.includes("deltatoken=")) {
        return new Response(
          JSON.stringify({
            value: [],
            "@odata.deltaLink": MS_NEW_DELTA_LINK,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      if (url.includes("graph.microsoft.com") && url.includes("/calendarView/delta?")) {
        return new Response(
          JSON.stringify({
            value: [],
            "@odata.deltaLink":
              "https://graph.microsoft.com/v1.0/me/calendars/cal_ms_default/events/delta?$deltatoken=snapshot-new-2",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      return new Response("Not found", { status: 404 });
    };

    const message: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: MS_ACCOUNT_B.account_id,
      channel_id: `scheduled-ms-${MS_ACCOUNT_B.account_id}`,
      resource_id: `scheduled-ms:${MS_ACCOUNT_B.account_id}:2026-02-23T05:45:00.000Z`,
      ping_ts: new Date().toISOString(),
      calendar_id: null,
    };

    await handleIncrementalSync(message, env, { fetchFn: msFetch, sleepFn: noopSleep });

    expect(userGraphDOState.deleteCanonicalCalls).toHaveLength(0);
    expect(accountDOState.syncSuccessCalls).toHaveLength(1);
    expect(syncQueue.messages).toHaveLength(0);
  });

  it("scheduled microsoft sweep reconciles only one delete when recent missing candidates exceed safety cap", async () => {
    const missingMirrorCount = 6;
    const nowIso = new Date().toISOString();

    userGraphDOState.activeMirrors = Array.from({ length: missingMirrorCount }, (_, idx) => ({
      provider_event_id: `AAMkAG-ms-mirror-cap-${idx + 1}`,
      target_calendar_id: "primary",
    }));
    userGraphDOState.mirrorLookupByProviderEventId = Object.fromEntries(
      Array.from({ length: missingMirrorCount }, (_, idx) => [
        `AAMkAG-ms-mirror-cap-${idx + 1}`,
        `evt_01HXYZ00000000000000000CAP${idx + 1}`,
      ]),
    );
    userGraphDOState.canonicalEventsById = Object.fromEntries(
      Array.from({ length: missingMirrorCount }, (_, idx) => [
        `evt_01HXYZ00000000000000000CAP${idx + 1}`,
        {
          event: {
            origin_account_id: "acc_01HXYZ0000000000000000000A",
            origin_event_id: `google_evt_origin_cap_${idx + 1}`,
            title: `Cap ${idx + 1}`,
            start: { dateTime: nowIso, timeZone: "UTC" },
            end: { dateTime: nowIso, timeZone: "UTC" },
            updated_at: nowIso,
            all_day: false,
            status: "confirmed",
            visibility: "default",
            transparency: "opaque",
          },
          mirrors: [],
        },
      ]),
    );

    const msFetch = async (
      input: string | URL | Request,
      _init?: RequestInit,
    ): Promise<Response> => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

      if (
        url.includes("graph.microsoft.com") &&
        url.includes("/me/calendars?") &&
        url.includes("isDefaultCalendar")
      ) {
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
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.includes("graph.microsoft.com") && url.includes("deltatoken=")) {
        return new Response(
          JSON.stringify({
            value: [],
            "@odata.deltaLink": MS_NEW_DELTA_LINK,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.includes("graph.microsoft.com") && url.includes("/calendarView/delta?")) {
        return new Response(
          JSON.stringify({
            value: [],
            "@odata.deltaLink":
              "https://graph.microsoft.com/v1.0/me/calendars/cal_ms_default/events/delta?$deltatoken=snapshot-cap",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response("Not found", { status: 404 });
    };

    const message: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: MS_ACCOUNT_B.account_id,
      channel_id: `scheduled-ms-${MS_ACCOUNT_B.account_id}`,
      resource_id: `scheduled-ms:${MS_ACCOUNT_B.account_id}:2026-02-23T05:45:00.000Z`,
      ping_ts: new Date().toISOString(),
      calendar_id: null,
    };

    await handleIncrementalSync(message, env, { fetchFn: msFetch, sleepFn: noopSleep });

    expect(userGraphDOState.deleteCanonicalCalls).toEqual([
      {
        canonical_event_id: "evt_01HXYZ00000000000000000CAP1",
        source: `provider:${MS_ACCOUNT_B.account_id}`,
      },
    ]);
    expect(accountDOState.syncSuccessCalls).toHaveLength(1);
    expect(syncQueue.messages).toHaveLength(0);
  });

  it("scheduled microsoft sweep prioritizes most-recent mirror writes under probe/eval caps", async () => {
    const oldCandidateCount = 18;
    const recentMirrorEventId = "AAMkAG-ms-mirror-cap-recent";
    const recentCanonicalEventId = "evt_01HXYZ00000000000000000CAPRECENT";
    const nowIso = new Date().toISOString();
    const oldWriteTs = "2026-01-01T00:00:00.000Z";

    userGraphDOState.activeMirrors = [
      ...Array.from({ length: oldCandidateCount }, (_, idx) => ({
        provider_event_id: `AAMkAG-ms-mirror-cap-old-${idx + 1}`,
        target_calendar_id: "primary",
        state: "ACTIVE",
        last_write_ts: oldWriteTs,
      })),
      {
        provider_event_id: recentMirrorEventId,
        target_calendar_id: "primary",
        state: "ACTIVE",
        last_write_ts: nowIso,
      },
    ];

    userGraphDOState.mirrorLookupByProviderEventId = Object.fromEntries([
      ...Array.from({ length: oldCandidateCount }, (_, idx) => [
        `AAMkAG-ms-mirror-cap-old-${idx + 1}`,
        `evt_01HXYZ00000000000000000CAPOLD${idx + 1}`,
      ]),
      [recentMirrorEventId, recentCanonicalEventId],
    ]);

    userGraphDOState.canonicalEventsById = Object.fromEntries([
      ...Array.from({ length: oldCandidateCount }, (_, idx) => [
        `evt_01HXYZ00000000000000000CAPOLD${idx + 1}`,
        {
          event: {
            origin_account_id: "acc_01HXYZ0000000000000000000A",
            origin_event_id: `google_evt_origin_cap_old_${idx + 1}`,
            title: `Cap Old ${idx + 1}`,
            start: { dateTime: "2026-02-24T12:00:00.000Z", timeZone: "UTC" },
            end: { dateTime: "2026-02-24T12:30:00.000Z", timeZone: "UTC" },
            all_day: false,
            status: "confirmed",
            visibility: "default",
            transparency: "opaque",
          },
          mirrors: [],
        },
      ]),
      [
        recentCanonicalEventId,
        {
          event: {
            origin_account_id: "acc_01HXYZ0000000000000000000A",
            origin_event_id: "google_evt_origin_cap_recent",
            title: "Cap Recent",
            start: { dateTime: "2026-02-24T12:00:00.000Z", timeZone: "UTC" },
            end: { dateTime: "2026-02-24T12:30:00.000Z", timeZone: "UTC" },
            all_day: false,
            status: "confirmed",
            visibility: "default",
            transparency: "opaque",
          },
          mirrors: [],
        },
      ],
    ]);

    const probedEventIds: string[] = [];
    const msFetch = async (
      input: string | URL | Request,
      _init?: RequestInit,
    ): Promise<Response> => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

      if (
        url.includes("graph.microsoft.com") &&
        url.includes("/me/calendars?") &&
        url.includes("isDefaultCalendar")
      ) {
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

      if (url.includes("graph.microsoft.com") && url.includes("deltatoken=")) {
        return new Response(
          JSON.stringify({
            value: [],
            "@odata.deltaLink": MS_NEW_DELTA_LINK,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      if (url.includes("graph.microsoft.com") && url.includes("/calendarView/delta?")) {
        return new Response(
          JSON.stringify({
            value: [],
            "@odata.deltaLink":
              "https://graph.microsoft.com/v1.0/me/calendars/cal_ms_default/events/delta?$deltatoken=snapshot-cap-recent-priority",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      if (url.includes("graph.microsoft.com") && url.includes("/me/events/")) {
        const probePath = new URL(url).pathname;
        const rawEventId = probePath.split("/me/events/")[1] ?? "";
        const eventId = decodeURIComponent(rawEventId);
        if (eventId.length > 0) {
          probedEventIds.push(eventId);
        }
        if (eventId === recentMirrorEventId) {
          return new Response("Not found", { status: 404 });
        }
        return new Response(
          JSON.stringify({ id: eventId || "known-event" }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      return new Response("Not found", { status: 404 });
    };

    const message: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: MS_ACCOUNT_B.account_id,
      channel_id: `scheduled-ms-${MS_ACCOUNT_B.account_id}`,
      resource_id: `scheduled-ms:${MS_ACCOUNT_B.account_id}:2026-02-23T06:30:00.000Z`,
      ping_ts: new Date().toISOString(),
      calendar_id: null,
    };

    await handleIncrementalSync(message, env, { fetchFn: msFetch, sleepFn: noopSleep });

    expect(probedEventIds.length).toBeLessThanOrEqual(200);
    expect(probedEventIds).toContain(recentMirrorEventId);
    expect(userGraphDOState.deleteCanonicalCalls).toEqual([
      {
        canonical_event_id: recentCanonicalEventId,
        source: `provider:${MS_ACCOUNT_B.account_id}`,
      },
    ]);
    expect(accountDOState.syncSuccessCalls).toHaveLength(1);
  });

  it("scheduled microsoft sweep continues when one candidate lookup fails", async () => {
    const failingMirrorEventId = "AAMkAG-ms-mirror-failing-lookup";
    const goodMirrorEventId = "AAMkAG-ms-mirror-good-after-failure";
    const goodCanonicalEventId = "evt_01HXYZ00000000000000000GOOD900";
    const nowIso = new Date().toISOString();

    userGraphDOState.activeMirrors = [
      {
        provider_event_id: failingMirrorEventId,
        target_calendar_id: "primary",
        state: "ACTIVE",
        last_write_ts: new Date(Date.now() + 1_000).toISOString(),
      },
      {
        provider_event_id: goodMirrorEventId,
        target_calendar_id: "primary",
        state: "ACTIVE",
        last_write_ts: nowIso,
      },
    ];
    userGraphDOState.findCanonicalByMirrorErrorsByProviderEventId = {
      [failingMirrorEventId]: "forced findCanonicalByMirror failure",
    };
    userGraphDOState.mirrorLookupByProviderEventId = {
      [goodMirrorEventId]: goodCanonicalEventId,
    };
    userGraphDOState.canonicalEventsById = {
      [goodCanonicalEventId]: {
        event: {
          origin_account_id: "acc_01HXYZ0000000000000000000A",
          origin_event_id: "google_evt_origin_good_after_failure",
          title: "good candidate",
          start: { dateTime: nowIso, timeZone: "UTC" },
          end: { dateTime: nowIso, timeZone: "UTC" },
          updated_at: nowIso,
          all_day: false,
          status: "confirmed",
          visibility: "default",
          transparency: "opaque",
        },
        mirrors: [],
      },
    };

    const msFetch = async (
      input: string | URL | Request,
      _init?: RequestInit,
    ): Promise<Response> => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

      if (
        url.includes("graph.microsoft.com") &&
        url.includes("/me/calendars?") &&
        url.includes("isDefaultCalendar")
      ) {
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

      if (url.includes("graph.microsoft.com") && url.includes("deltatoken=")) {
        return new Response(
          JSON.stringify({
            value: [],
            "@odata.deltaLink": MS_NEW_DELTA_LINK,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      if (url.includes("graph.microsoft.com") && url.includes("/calendarView/delta?")) {
        return new Response(
          JSON.stringify({
            value: [],
            "@odata.deltaLink":
              "https://graph.microsoft.com/v1.0/me/calendars/cal_ms_default/events/delta?$deltatoken=snapshot-failure-continue",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      if (url.includes("graph.microsoft.com") && url.includes("/me/events/")) {
        const probePath = new URL(url).pathname;
        const rawEventId = probePath.split("/me/events/")[1] ?? "";
        const eventId = decodeURIComponent(rawEventId);
        if (eventId === goodMirrorEventId) {
          return new Response("Not found", { status: 404 });
        }
        return new Response(JSON.stringify({ id: eventId || "known-event" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response("Not found", { status: 404 });
    };

    const message: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: MS_ACCOUNT_B.account_id,
      channel_id: `scheduled-ms-${MS_ACCOUNT_B.account_id}`,
      resource_id: `scheduled-ms:${MS_ACCOUNT_B.account_id}:2026-02-23T06:45:00.000Z`,
      ping_ts: new Date().toISOString(),
      calendar_id: null,
    };

    await handleIncrementalSync(message, env, { fetchFn: msFetch, sleepFn: noopSleep });

    expect(userGraphDOState.deleteCanonicalCalls).toEqual([
      {
        canonical_event_id: goodCanonicalEventId,
        source: `provider:${MS_ACCOUNT_B.account_id}`,
      },
    ]);
    expect(accountDOState.syncSuccessCalls).toHaveLength(1);
  });

  it("incremental sync: legacy Microsoft mirror scope without cursor enqueues SYNC_FULL bootstrap", async () => {
    const mirrorCalendarId = "overlay-ms-cal-1";
    const mirrorEventId = "AAMkAG-ms-overlay-mirror-1";
    const fetchedUrls: string[] = [];

    // Legacy shape: AccountDO only knows primary scope, but active mirrors
    // reference a secondary target calendar that still needs convergence sync.
    accountDOState.calendarScopes = [
      {
        provider_calendar_id: "primary",
        enabled: true,
        sync_enabled: true,
      },
    ];
    accountDOState.scopedSyncTokens = {
      primary: MS_DELTA_LINK,
    };
    userGraphDOState.activeMirrors = [
      {
        provider_event_id: mirrorEventId,
        target_calendar_id: mirrorCalendarId,
      },
    ];
    const msFetch = async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      fetchedUrls.push(url);

      if (
        url.includes("graph.microsoft.com") &&
        url.includes("/me/calendars?") &&
        url.includes("isDefaultCalendar")
      ) {
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

      if (!url.includes("graph.microsoft.com")) {
        return new Response("Not found", { status: 404 });
      }

      // Primary scope: no deltas.
      if (url.includes(encodeURIComponent(MS_DEFAULT_CALENDAR_ID))) {
        return new Response(
          JSON.stringify({
            value: [],
            "@odata.deltaLink":
              "https://graph.microsoft.com/v1.0/me/calendars/cal_ms_default/events/delta?$deltatoken=primary-new",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      // Mirror overlay scope has no cursor yet; bootstrap path should escalate
      // this incremental run to SYNC_FULL reconciliation.
      if (url.includes(encodeURIComponent(mirrorCalendarId))) {
        return new Response(
          JSON.stringify({
            value: [makeMicrosoftDeletedEvent({ id: mirrorEventId })],
            "@odata.deltaLink":
              "https://graph.microsoft.com/v1.0/me/calendars/overlay-ms-cal-1/events/delta?$deltatoken=overlay-new",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      return new Response(
        JSON.stringify({
          value: [],
          "@odata.deltaLink": MS_NEW_DELTA_LINK,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    };

    const message: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: MS_ACCOUNT_B.account_id,
      channel_id: "channel-ms-overlay-sync",
      resource_id: "resource-ms-overlay-sync",
      ping_ts: new Date().toISOString(),
      calendar_id: null,
    };

    await handleIncrementalSync(message, env, { fetchFn: msFetch, sleepFn: noopSleep });

    expect(
      fetchedUrls.some((url) => url.includes(encodeURIComponent(mirrorCalendarId))),
    ).toBe(true);
    expect(syncQueue.messages).toHaveLength(1);
    expect((syncQueue.messages[0] as { type?: string }).type).toBe("SYNC_FULL");
    expect((syncQueue.messages[0] as { reason?: string }).reason).toBe("token_410");
    expect(accountDOState.syncSuccessCalls).toHaveLength(0);
    expect(userGraphDOState.deleteCanonicalCalls).toHaveLength(0);
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

  it("full sync reconciles stale Microsoft managed mirrors missing from provider snapshot", async () => {
    userGraphDOState.activeMirrors = [
      { provider_event_id: "AAMkAG-ms-stale-mirror-404", target_calendar_id: "primary" },
    ];
    userGraphDOState.mirrorLookupByProviderEventId = {
      "AAMkAG-ms-stale-mirror-404": "evt_01HXYZ00000000000000000999",
    };

    const msFetch = createMicrosoftApiFetch({
      events: [makeMicrosoftEvent({ id: "AAMkAG-ms-origin-keep" })],
      deltaLink: MS_NEW_DELTA_LINK,
    });

    const message: SyncFullMessage = {
      type: "SYNC_FULL",
      account_id: MS_ACCOUNT_B.account_id,
      reason: "reconcile",
    };

    await handleFullSync(message, env, { fetchFn: msFetch, sleepFn: noopSleep });

    expect(userGraphDOState.deleteCanonicalCalls).toEqual([
      {
        canonical_event_id: "evt_01HXYZ00000000000000000999",
        source: `provider:${MS_ACCOUNT_B.account_id}`,
      },
    ]);
    expect(accountDOState.syncSuccessCalls).toHaveLength(1);
  });

  it("full sync reconciles stale mirrors from legacy Microsoft overlay scope fallback", async () => {
    const mirrorCalendarId = "overlay-ms-cal-legacy";
    const staleMirrorEventId = "AAMkAG-ms-stale-overlay-1";
    const canonicalEventId = "evt_01HXYZ00000000000000000998";
    const fetchedUrls: string[] = [];

    // Legacy shape: only primary is registered in AccountDO scope table.
    accountDOState.calendarScopes = [
      {
        provider_calendar_id: "primary",
        enabled: true,
        sync_enabled: true,
      },
    ];
    userGraphDOState.activeMirrors = [
      {
        provider_event_id: staleMirrorEventId,
        target_calendar_id: mirrorCalendarId,
      },
    ];
    userGraphDOState.mirrorLookupByProviderEventId = {
      [staleMirrorEventId]: canonicalEventId,
    };

    const msFetch = async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      fetchedUrls.push(url);

      if (
        url.includes("graph.microsoft.com") &&
        url.includes("/me/calendars?") &&
        url.includes("isDefaultCalendar")
      ) {
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

      if (!url.includes("graph.microsoft.com")) {
        return new Response("Not found", { status: 404 });
      }

      // Primary scope includes one origin event that should be preserved.
      if (url.includes(encodeURIComponent(MS_DEFAULT_CALENDAR_ID))) {
        return new Response(
          JSON.stringify({
            value: [makeMicrosoftEvent({ id: "AAMkAG-ms-origin-keep-legacy" })],
            "@odata.deltaLink":
              "https://graph.microsoft.com/v1.0/me/calendars/cal_ms_default/events/delta?$deltatoken=primary-full-new",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      // Overlay scope snapshot does not include stale mirror anymore.
      if (url.includes(encodeURIComponent(mirrorCalendarId))) {
        return new Response(
          JSON.stringify({
            value: [],
            "@odata.deltaLink":
              "https://graph.microsoft.com/v1.0/me/calendars/overlay-ms-cal-legacy/events/delta?$deltatoken=overlay-full-new",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      return new Response(
        JSON.stringify({
          value: [],
          "@odata.deltaLink": MS_NEW_DELTA_LINK,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    };

    const message: SyncFullMessage = {
      type: "SYNC_FULL",
      account_id: MS_ACCOUNT_B.account_id,
      reason: "reconcile",
    };

    await handleFullSync(message, env, { fetchFn: msFetch, sleepFn: noopSleep });

    expect(
      fetchedUrls.some((url) => url.includes(encodeURIComponent(mirrorCalendarId))),
    ).toBe(true);
    expect(userGraphDOState.deleteCanonicalCalls).toEqual([
      {
        canonical_event_id: canonicalEventId,
        source: `provider:${MS_ACCOUNT_B.account_id}`,
      },
    ]);
    expect(accountDOState.setScopedSyncTokenCalls).toEqual(
      expect.arrayContaining([
        {
          provider_calendar_id: mirrorCalendarId,
          sync_token:
            "https://graph.microsoft.com/v1.0/me/calendars/overlay-ms-cal-legacy/events/delta?$deltatoken=overlay-full-new",
        },
      ]),
    );
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
      calendar_id: null,
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

  it("filters managed mirrors via UserGraph mirror index when delta payload lacks extension", async () => {
    userGraphDOState.activeMirrors = [
      { provider_event_id: "AAMkAG-ms-mirror-noext" },
    ];

    const msFetch = createMicrosoftApiFetch({
      events: [
        makeMicrosoftEvent({ id: "AAMkAG-origin-1" }),
        makeMicrosoftEvent({
          id: "AAMkAG-ms-mirror-noext",
          subject: "Busy",
          extensions: undefined,
          categories: undefined,
        }),
        makeMicrosoftEvent({ id: "AAMkAG-origin-2", subject: "Real Event 2" }),
      ],
      deltaLink: MS_NEW_DELTA_LINK,
    });

    const message: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: MS_ACCOUNT_B.account_id,
      channel_id: "channel-ms-2b",
      resource_id: "resource-ms-2b",
      ping_ts: new Date().toISOString(),
      calendar_id: null,
    };

    await handleIncrementalSync(message, env, { fetchFn: msFetch, sleepFn: noopSleep });

    expect(userGraphDOState.applyDeltaCalls).toHaveLength(1);
    expect(userGraphDOState.applyDeltaCalls[0].deltas).toHaveLength(2);
    const eventIds = userGraphDOState.applyDeltaCalls[0].deltas.map(
      (d: unknown) => (d as Record<string, unknown>).origin_event_id,
    );
    expect(eventIds).toContain("AAMkAG-origin-1");
    expect(eventIds).toContain("AAMkAG-origin-2");
    expect(eventIds).not.toContain("AAMkAG-ms-mirror-noext");
  });

  it("classifies MS event with category fallback as managed_mirror when extension is absent", async () => {
    // AC #8: MS event with categories: ["T-Minus Managed"] but NO open extension
    // should be classified as managed_mirror via the category fallback in
    // classifyMicrosoftEvent(), and excluded from the origin delta batch.
    const msFetch = createMicrosoftApiFetch({
      events: [
        makeMicrosoftEvent({ id: "AAMkAG-origin-cat-1", subject: "Real Origin" }),
        makeMicrosoftEvent({
          id: "AAMkAG-cat-mirror-300",
          subject: "Busy",
          extensions: undefined,
          categories: ["T-Minus Managed"],
        }),
        makeMicrosoftEvent({ id: "AAMkAG-origin-cat-2", subject: "Another Origin" }),
      ],
      deltaLink: MS_NEW_DELTA_LINK,
    });

    const message: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: MS_ACCOUNT_B.account_id,
      channel_id: "channel-ms-cat-fallback",
      resource_id: "resource-ms-cat-fallback",
      ping_ts: new Date().toISOString(),
      calendar_id: null,
    };

    await handleIncrementalSync(message, env, { fetchFn: msFetch, sleepFn: noopSleep });

    // The category-flagged mirror should be excluded from the origin delta batch
    expect(userGraphDOState.applyDeltaCalls).toHaveLength(1);
    expect(userGraphDOState.applyDeltaCalls[0].deltas).toHaveLength(2);

    const eventIds = userGraphDOState.applyDeltaCalls[0].deltas.map(
      (d: unknown) => (d as Record<string, unknown>).origin_event_id,
    );
    expect(eventIds).toContain("AAMkAG-origin-cat-1");
    expect(eventIds).toContain("AAMkAG-origin-cat-2");
    expect(eventIds).not.toContain("AAMkAG-cat-mirror-300");
  });

  it("managed Microsoft mirror deletion triggers canonical delete", async () => {
    userGraphDOState.mirrorLookupByProviderEventId = {
      "AAMkAG-ms-mirror-200": "evt_01HXYZ00000000000000000002",
    };

    const msFetch = createMicrosoftApiFetch({
      events: [makeMicrosoftManagedMirrorEvent({ isCancelled: true })],
      deltaLink: MS_NEW_DELTA_LINK,
    });

    const message: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: MS_ACCOUNT_B.account_id,
      channel_id: "channel-ms-managed-delete",
      resource_id: "resource-ms-managed-delete",
      ping_ts: new Date().toISOString(),
      calendar_id: null,
    };

    await handleIncrementalSync(message, env, { fetchFn: msFetch, sleepFn: noopSleep });

    expect(userGraphDOState.applyDeltaCalls).toHaveLength(0);
    expect(userGraphDOState.findCanonicalByMirrorCalls).toEqual([
      {
        target_account_id: MS_ACCOUNT_B.account_id,
        provider_event_id: "AAMkAG-ms-mirror-200",
      },
    ]);
    expect(userGraphDOState.deleteCanonicalCalls).toEqual([
      {
        canonical_event_id: "evt_01HXYZ00000000000000000002",
        source: `provider:${MS_ACCOUNT_B.account_id}`,
      },
    ]);
  });

  it("invalid Microsoft delta cursor enqueues SYNC_FULL recovery instead of failing sync", async () => {
    const invalidDeltaFetch = async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("graph.microsoft.com")) {
        return new Response(
          JSON.stringify({
            error: {
              code: "ErrorInvalidUrlQuery",
              message: "Tracking changes to events is not supported for this request.",
            },
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("Not found", { status: 404 });
    };

    const message: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: MS_ACCOUNT_B.account_id,
      channel_id: "channel-ms-2c",
      resource_id: "resource-ms-2c",
      ping_ts: new Date().toISOString(),
      calendar_id: null,
    };

    await handleIncrementalSync(message, env, { fetchFn: invalidDeltaFetch, sleepFn: noopSleep });

    expect(syncQueue.messages).toHaveLength(1);
    expect((syncQueue.messages[0] as { type?: string }).type).toBe("SYNC_FULL");
    expect(userGraphDOState.applyDeltaCalls).toHaveLength(0);
    expect(accountDOState.syncFailureCalls).toHaveLength(0);
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
      calendar_id: null,
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
      calendar_id: null,
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
      calendar_id: null,
    };

    // No special Microsoft-specific fields in the message
    await handleIncrementalSync(message, env, { fetchFn: msFetch, sleepFn: noopSleep });

    expect(userGraphDOState.applyDeltaCalls).toHaveLength(1);
    expect(accountDOState.syncSuccessCalls).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // TM-9fc9: Webhook-hinted mirror deletion (Microsoft)
  // -------------------------------------------------------------------------

  it("webhook_change_type=deleted with known mirror event ID deletes canonical", async () => {
    const mirrorProviderEventId = "AAMkAG-ms-mirror-200";
    const canonicalEventId = "evt_01HXYZ00000000000000000001";

    // Set up the DO state: mirror ID in active mirrors + lookup returns canonical
    userGraphDOState.activeMirrors = [
      { provider_event_id: mirrorProviderEventId, target_calendar_id: "cal-target" },
    ];
    userGraphDOState.mirrorLookupByProviderEventId = {
      [mirrorProviderEventId]: canonicalEventId,
    };

    // The delta response returns NO events (the deleted event vanishes from the delta)
    const msFetch = createMicrosoftApiFetch({
      events: [],
      deltaLink: MS_NEW_DELTA_LINK,
    });

    const message: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: MS_ACCOUNT_B.account_id,
      channel_id: "channel-ms-delete-1",
      resource_id: `me/events/${mirrorProviderEventId}`,
      ping_ts: new Date().toISOString(),
      calendar_id: null,
      webhook_change_type: "deleted",
    };

    await handleIncrementalSync(message, env, { fetchFn: msFetch, sleepFn: noopSleep });

    // The webhook hint should have triggered canonical deletion via findCanonicalByMirror + deleteCanonicalEvent
    expect(userGraphDOState.findCanonicalByMirrorCalls.length).toBeGreaterThanOrEqual(1);
    expect(userGraphDOState.deleteCanonicalCalls).toHaveLength(1);
    expect(userGraphDOState.deleteCanonicalCalls[0].canonical_event_id).toBe(canonicalEventId);

    // Normal sync still completes (sync success marked)
    expect(accountDOState.syncSuccessCalls).toHaveLength(1);
    expect(syncQueue.messages).toHaveLength(0);
  });

  it("webhook delete hint resolves mirror ID from resourceData.id and events('{id}') path variants", async () => {
    const encodedMirrorEventId = "AAMkAGI2TQABAAA%2FAAABBB%3D%3D";
    const canonicalEventId = "evt_01HXYZ00000000000000000011";

    // Active mirror index stores legacy encoded ID variant.
    userGraphDOState.activeMirrors = [
      { provider_event_id: encodedMirrorEventId, target_calendar_id: "cal-target" },
    ];
    userGraphDOState.mirrorLookupByProviderEventId = {
      [encodedMirrorEventId]: canonicalEventId,
    };

    const msFetch = createMicrosoftApiFetch({
      events: [],
      deltaLink: MS_NEW_DELTA_LINK,
    });

    const message: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: MS_ACCOUNT_B.account_id,
      channel_id: "channel-ms-delete-variant-1",
      resource_id: "Users/user-123/Events('AAMkAGI2TQABAAA%2FAAABBB%3D%3D')?$select=id",
      ping_ts: new Date().toISOString(),
      calendar_id: null,
      webhook_change_type: "Deleted",
      webhook_resource_data_id: "AAMkAGI2TQABAAA%2FAAABBB%3D%3D",
    };

    await handleIncrementalSync(message, env, { fetchFn: msFetch, sleepFn: noopSleep });

    expect(userGraphDOState.deleteCanonicalCalls).toHaveLength(1);
    expect(userGraphDOState.deleteCanonicalCalls[0].canonical_event_id).toBe(canonicalEventId);
    expect(accountDOState.syncSuccessCalls).toHaveLength(1);
    expect(syncQueue.messages).toHaveLength(0);
  });

  it("webhook_change_type=deleted with unknown event ID does NOT delete and does not enqueue SYNC_FULL", async () => {
    // No mirrors registered
    userGraphDOState.activeMirrors = [];
    userGraphDOState.mirrorLookupByProviderEventId = {};

    const msFetch = createMicrosoftApiFetch({
      events: [],
      deltaLink: MS_NEW_DELTA_LINK,
    });

    const message: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: MS_ACCOUNT_B.account_id,
      channel_id: "channel-ms-delete-2",
      resource_id: "me/events/AAMkAG-unknown-event-999",
      ping_ts: new Date().toISOString(),
      calendar_id: null,
      webhook_change_type: "deleted",
    };

    await handleIncrementalSync(message, env, { fetchFn: msFetch, sleepFn: noopSleep });

    // No canonical deletion should occur
    expect(userGraphDOState.deleteCanonicalCalls).toHaveLength(0);

    // Normal sync still completes; no broad reconcile fallback should be queued.
    expect(accountDOState.syncSuccessCalls).toHaveLength(1);
    expect(syncQueue.messages).toHaveLength(0);
  });

  it("webhook_change_type=updated does NOT trigger mirror deletion", async () => {
    const mirrorProviderEventId = "AAMkAG-ms-mirror-200";

    userGraphDOState.activeMirrors = [
      { provider_event_id: mirrorProviderEventId, target_calendar_id: "cal-target" },
    ];
    userGraphDOState.mirrorLookupByProviderEventId = {
      [mirrorProviderEventId]: "evt_01HXYZ00000000000000000001",
    };

    const msFetch = createMicrosoftApiFetch({
      events: [makeMicrosoftEvent()],
      deltaLink: MS_NEW_DELTA_LINK,
    });

    const message: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: MS_ACCOUNT_B.account_id,
      channel_id: "channel-ms-update-1",
      resource_id: `me/events/${mirrorProviderEventId}`,
      ping_ts: new Date().toISOString(),
      calendar_id: null,
      webhook_change_type: "updated",
    };

    await handleIncrementalSync(message, env, { fetchFn: msFetch, sleepFn: noopSleep });

    // No canonical deletion from webhook hint (only "deleted" triggers it)
    expect(userGraphDOState.deleteCanonicalCalls).toHaveLength(0);

    // Normal sync processes the origin event
    expect(userGraphDOState.applyDeltaCalls).toHaveLength(1);
    expect(accountDOState.syncSuccessCalls).toHaveLength(1);
  });

  it("webhook_change_type=updated deletes mirror canonical when provider probe confirms event is missing", async () => {
    const mirrorProviderEventId = "AAMkAG-ms-mirror-201";
    const canonicalEventId = "evt_01HXYZ00000000000000000077";
    const encodedMirrorEventId = encodeURIComponent(mirrorProviderEventId);

    userGraphDOState.activeMirrors = [
      { provider_event_id: mirrorProviderEventId, target_calendar_id: "cal-target" },
    ];
    userGraphDOState.mirrorLookupByProviderEventId = {
      [mirrorProviderEventId]: canonicalEventId,
    };

    const baseFetch = createMicrosoftApiFetch({
      events: [],
      deltaLink: MS_NEW_DELTA_LINK,
    });
    const msFetch = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes(`/me/events/${encodedMirrorEventId}?$select=id`)) {
        return new Response(
          JSON.stringify({ error: { code: "ErrorItemNotFound", message: "Not found" } }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        );
      }
      return baseFetch(input, init);
    };

    const message: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: MS_ACCOUNT_B.account_id,
      channel_id: "channel-ms-update-missing-1",
      resource_id: `me/events/${mirrorProviderEventId}`,
      ping_ts: new Date().toISOString(),
      calendar_id: null,
      webhook_change_type: "updated",
    };

    await handleIncrementalSync(message, env, { fetchFn: msFetch, sleepFn: noopSleep });

    expect(userGraphDOState.deleteCanonicalCalls).toHaveLength(1);
    expect(userGraphDOState.deleteCanonicalCalls[0].canonical_event_id).toBe(canonicalEventId);
    expect(accountDOState.syncSuccessCalls).toHaveLength(1);
    expect(syncQueue.messages).toHaveLength(0);
  });

  it("webhook_change_type=deleted with non-event resource path does NOT delete", async () => {
    const msFetch = createMicrosoftApiFetch({
      events: [],
      deltaLink: MS_NEW_DELTA_LINK,
    });

    const message: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: MS_ACCOUNT_B.account_id,
      channel_id: "channel-ms-delete-3",
      resource_id: "me/calendars/some-calendar-id",  // Not an events path
      ping_ts: new Date().toISOString(),
      calendar_id: null,
      webhook_change_type: "deleted",
    };

    await handleIncrementalSync(message, env, { fetchFn: msFetch, sleepFn: noopSleep });

    // No deletion -- resource path didn't contain event ID
    expect(userGraphDOState.deleteCanonicalCalls).toHaveLength(0);
    expect(accountDOState.syncSuccessCalls).toHaveLength(1);
    expect(syncQueue.messages).toHaveLength(0);
  });
});
