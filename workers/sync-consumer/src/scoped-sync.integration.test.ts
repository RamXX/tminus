/**
 * Integration tests for per-scope sync cursors and ingestion (TM-8gfd.5).
 *
 * Uses real SQLite (better-sqlite3) for D1 mock. DOs are mocked at the fetch
 * boundary. Google Calendar API is mocked via injectable FetchFn.
 *
 * Tests prove:
 * - AC1: Incremental sync iterates scoped calendars with per-scope cursor state
 * - AC2: Full sync iterates scoped calendars with per-scope cursor updates
 * - AC4: Sync health reporting includes scope-level freshness and error status
 * - AC5: No duplicate canonical inserts from multi-scope ingestion (dedup)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { MIGRATION_0001_INITIAL_SCHEMA } from "@tminus/d1-registry";
import {
  handleIncrementalSync,
  handleFullSync,
  getSyncHealthReport,
} from "./index";
import type { AccountId, SyncIncrementalMessage, SyncFullMessage } from "@tminus/shared";

// ---------------------------------------------------------------------------
// No-op sleep for tests
// ---------------------------------------------------------------------------

const noopSleep = async (_ms: number): Promise<void> => {};

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_ORG = {
  org_id: "org_01HXYZ00000000000000000001",
  name: "Scoped Sync Test Org",
} as const;

const TEST_USER = {
  user_id: "usr_01HXYZ00000000000000000001",
  org_id: TEST_ORG.org_id,
  email: "scopedtest@example.com",
} as const;

const ACCOUNT_A = {
  account_id: "acc_01HXYZ0000000000000000000A" as AccountId,
  user_id: TEST_USER.user_id,
  provider: "google",
  provider_subject: "google-sub-scoped-a",
  email: "alice@gmail.com",
} as const;

const TEST_ACCESS_TOKEN = "ya29.test-access-token-scoped";
const TEST_SYNC_TOKEN = "sync-token-scoped-abc";

// ---------------------------------------------------------------------------
// Event factories
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
// DO state types
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
}

interface ScopedHealthState {
  scopedSyncSuccessCalls: Array<{ provider_calendar_id: string; ts: string }>;
  scopedSyncFailureCalls: Array<{ provider_calendar_id: string; error: string }>;
  scopedSyncHealthResponses: Record<string, {
    last_sync_ts: string | null;
    last_success_ts: string | null;
    error_message: string | null;
    has_cursor: boolean;
  }>;
  accountLevelHealth: {
    last_sync_ts: string | null;
    last_success_ts: string | null;
    error_message: string | null;
  };
}

interface UserGraphDOState {
  applyDeltaCalls: Array<{ account_id: string; deltas: unknown[] }>;
  deleteCanonicalCalls: Array<{ canonical_event_id: string; source: string }>;
  findCanonicalByMirrorCalls: Array<{
    target_account_id: string;
    provider_event_id: string;
  }>;
  canonicalOriginEvents: Array<{
    origin_event_id: string;
    start?: { dateTime?: string; date?: string } | string | null;
  }>;
  activeMirrors: Array<{
    provider_event_id: string | null;
    target_calendar_id?: string | null;
  }>;
  mirrorLookupByProviderEventId: Record<string, string>;
}

// ---------------------------------------------------------------------------
// DO stub mocks
// ---------------------------------------------------------------------------

function createScopedAccountDO(state: AccountDOState, healthState: ScopedHealthState) {
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
          { status: 200, headers: { "Content-Type": "application/json" } },
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
          { status: 200, headers: { "Content-Type": "application/json" } },
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

      if (path === "/markScopedSyncSuccess") {
        const body = (await request.json()) as { provider_calendar_id: string; ts: string };
        healthState.scopedSyncSuccessCalls.push(body);
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (path === "/markScopedSyncFailure") {
        const body = (await request.json()) as { provider_calendar_id: string; error: string };
        healthState.scopedSyncFailureCalls.push(body);
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (path === "/getSyncHealth") {
        return new Response(
          JSON.stringify(healthState.accountLevelHealth),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (path === "/getScopedSyncHealth") {
        const body = (await request.json()) as { provider_calendar_id: string };
        const health = healthState.scopedSyncHealthResponses[body.provider_calendar_id];
        if (health) {
          return new Response(JSON.stringify(health), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({
            last_sync_ts: null,
            last_success_ts: null,
            error_message: null,
            has_cursor: false,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
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
        return new Response(
          JSON.stringify({ mirrors: state.activeMirrors }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.pathname === "/findCanonicalByMirror") {
        const body = (await request.json()) as {
          target_account_id: string;
          provider_event_id: string;
        };
        state.findCanonicalByMirrorCalls.push(body);
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
      return new Response("Not found", { status: 404 });
    },
  };
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe("Per-scope sync cursors and ingestion (TM-8gfd.5)", () => {
  let db: DatabaseType;
  let d1: D1Database;
  let syncQueue: Queue & { messages: unknown[] };
  let writeQueue: Queue & { messages: unknown[] };
  let accountDOState: AccountDOState;
  let healthState: ScopedHealthState;
  let userGraphDOState: UserGraphDOState;
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

    healthState = {
      scopedSyncSuccessCalls: [],
      scopedSyncFailureCalls: [],
      scopedSyncHealthResponses: {},
      accountLevelHealth: {
        last_sync_ts: null,
        last_success_ts: null,
        error_message: null,
      },
    };

    accountDOState = {
      accessToken: TEST_ACCESS_TOKEN,
      syncToken: TEST_SYNC_TOKEN,
      syncSuccessCalls: [],
      syncFailureCalls: [],
      setSyncTokenCalls: [],
      scopedSyncTokens: {
        primary: TEST_SYNC_TOKEN,
        "overlay-cal-1": "overlay-sync-token-1",
      },
      setScopedSyncTokenCalls: [],
      calendarScopes: [
        { provider_calendar_id: "primary", enabled: true, sync_enabled: true },
        { provider_calendar_id: "overlay-cal-1", enabled: true, sync_enabled: true },
      ],
    };

    userGraphDOState = {
      applyDeltaCalls: [],
      deleteCanonicalCalls: [],
      findCanonicalByMirrorCalls: [],
      canonicalOriginEvents: [],
      activeMirrors: [],
      mirrorLookupByProviderEventId: {},
    };

    const accountStub = createScopedAccountDO(accountDOState, healthState);
    const userGraphStub = createMockUserGraphDO(userGraphDOState);

    env = {
      DB: d1,
      SYNC_QUEUE: syncQueue,
      WRITE_QUEUE: writeQueue,
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
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // AC1: Incremental sync iterates scoped calendars with per-scope cursors
  // -------------------------------------------------------------------------

  it("AC1: incremental sync iterates 2 Google scopes with independent cursors", async () => {
    let callCount = 0;
    const scopedFetch = async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url.includes("/calendars/") && url.includes("/events")) {
        callCount++;
        const isPrimary = url.includes("/calendars/primary/");
        const isOverlay = url.includes("/calendars/overlay-cal-1/");

        if (isPrimary) {
          return new Response(
            JSON.stringify({
              items: [makeGoogleEvent({ id: "primary-evt-1", summary: "Primary Meeting" })],
              nextSyncToken: "primary-cursor-new",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        if (isOverlay) {
          return new Response(
            JSON.stringify({
              items: [makeGoogleEvent({ id: "overlay-evt-1", summary: "Overlay Meeting" })],
              nextSyncToken: "overlay-cursor-new",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
      }

      return new Response("Not found", { status: 404 });
    };

    const message: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: ACCOUNT_A.account_id,
      channel_id: "channel-scoped-1",
      resource_id: "resource-scoped-1",
      ping_ts: new Date().toISOString(),
      calendar_id: null,
    };

    await handleIncrementalSync(message, env, { fetchFn: scopedFetch, sleepFn: noopSleep });

    // Both scopes were fetched
    expect(callCount).toBe(2);

    // Events from both scopes were applied
    expect(userGraphDOState.applyDeltaCalls).toHaveLength(1);
    const deltas = userGraphDOState.applyDeltaCalls[0].deltas as Array<{ origin_event_id: string }>;
    expect(deltas).toHaveLength(2);
    const deltaIds = deltas.map((d) => d.origin_event_id);
    expect(deltaIds).toContain("primary-evt-1");
    expect(deltaIds).toContain("overlay-evt-1");

    // Per-scope cursors were updated independently
    expect(accountDOState.setScopedSyncTokenCalls).toHaveLength(2);
    const primaryUpdate = accountDOState.setScopedSyncTokenCalls.find(
      (c) => c.provider_calendar_id === "primary",
    );
    const overlayUpdate = accountDOState.setScopedSyncTokenCalls.find(
      (c) => c.provider_calendar_id === "overlay-cal-1",
    );
    expect(primaryUpdate?.sync_token).toBe("primary-cursor-new");
    expect(overlayUpdate?.sync_token).toBe("overlay-cursor-new");

    // Per-scope sync success was marked
    expect(healthState.scopedSyncSuccessCalls).toHaveLength(2);
    const scopedScopes = healthState.scopedSyncSuccessCalls.map((c) => c.provider_calendar_id);
    expect(scopedScopes).toContain("primary");
    expect(scopedScopes).toContain("overlay-cal-1");

    // Account-level sync success also marked
    expect(accountDOState.syncSuccessCalls).toHaveLength(1);
  });

  it("AC1: targeted scope sync only syncs the specified calendar_id", async () => {
    const calledCalendarIds: string[] = [];
    const scopedFetch = async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url.includes("/calendars/") && url.includes("/events")) {
        const match = url.match(/\/calendars\/([^/]+)\/events/);
        if (match) calledCalendarIds.push(decodeURIComponent(match[1]));

        return new Response(
          JSON.stringify({
            items: [makeGoogleEvent({ id: "targeted-evt-1" })],
            nextSyncToken: "targeted-cursor-new",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response("Not found", { status: 404 });
    };

    const message: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: ACCOUNT_A.account_id,
      channel_id: "channel-targeted",
      resource_id: "resource-targeted",
      ping_ts: new Date().toISOString(),
      calendar_id: "overlay-cal-1",
    };

    await handleIncrementalSync(message, env, { fetchFn: scopedFetch, sleepFn: noopSleep });

    // Only the targeted scope was fetched
    expect(calledCalendarIds).toHaveLength(1);
    expect(calledCalendarIds[0]).toBe("overlay-cal-1");

    // Only one cursor was updated
    expect(accountDOState.setScopedSyncTokenCalls).toHaveLength(1);
    expect(accountDOState.setScopedSyncTokenCalls[0].provider_calendar_id).toBe("overlay-cal-1");

    // Per-scope sync success for only the targeted scope
    expect(healthState.scopedSyncSuccessCalls).toHaveLength(1);
    expect(healthState.scopedSyncSuccessCalls[0].provider_calendar_id).toBe("overlay-cal-1");
  });

  // -------------------------------------------------------------------------
  // AC2: Full sync iterates scoped calendars with per-scope cursors
  // -------------------------------------------------------------------------

  it("AC2: full sync iterates 2 Google scopes and updates per-scope cursors", async () => {
    const calledCalendarIds: string[] = [];
    const scopedFetch = async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url.includes("/calendars/") && url.includes("/events")) {
        const match = url.match(/\/calendars\/([^/]+)\/events/);
        if (match) calledCalendarIds.push(decodeURIComponent(match[1]));
        const isPrimary = url.includes("/calendars/primary/");

        return new Response(
          JSON.stringify({
            items: isPrimary
              ? [makeGoogleEvent({ id: "full-primary-evt" })]
              : [makeGoogleEvent({ id: "full-overlay-evt" })],
            nextSyncToken: isPrimary ? "full-primary-cursor" : "full-overlay-cursor",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response("Not found", { status: 404 });
    };

    const message: SyncFullMessage = {
      type: "SYNC_FULL",
      account_id: ACCOUNT_A.account_id,
      reason: "reconcile",
    };

    await handleFullSync(message, env, { fetchFn: scopedFetch, sleepFn: noopSleep });

    // Both scopes were fetched
    expect(calledCalendarIds).toContain("primary");
    expect(calledCalendarIds).toContain("overlay-cal-1");

    // Per-scope cursors were updated
    expect(accountDOState.setScopedSyncTokenCalls).toHaveLength(2);
    const primaryCursor = accountDOState.setScopedSyncTokenCalls.find(
      (c) => c.provider_calendar_id === "primary",
    );
    const overlayCursor = accountDOState.setScopedSyncTokenCalls.find(
      (c) => c.provider_calendar_id === "overlay-cal-1",
    );
    expect(primaryCursor?.sync_token).toBe("full-primary-cursor");
    expect(overlayCursor?.sync_token).toBe("full-overlay-cursor");

    // Per-scope sync success was marked
    expect(healthState.scopedSyncSuccessCalls).toHaveLength(2);

    // Events from both scopes were applied
    expect(userGraphDOState.applyDeltaCalls).toHaveLength(1);
    const deltas = userGraphDOState.applyDeltaCalls[0].deltas as Array<{ origin_event_id: string }>;
    expect(deltas).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // AC4: Sync health reporting includes scope-level freshness
  // -------------------------------------------------------------------------

  it("AC4: getSyncHealthReport returns per-scope health for Google accounts", async () => {
    healthState.scopedSyncHealthResponses = {
      primary: {
        last_sync_ts: "2026-02-20T12:00:00Z",
        last_success_ts: "2026-02-20T12:00:00Z",
        error_message: null,
        has_cursor: true,
      },
      "overlay-cal-1": {
        last_sync_ts: "2026-02-20T11:00:00Z",
        last_success_ts: "2026-02-20T11:00:00Z",
        error_message: null,
        has_cursor: true,
      },
    };

    healthState.accountLevelHealth = {
      last_sync_ts: "2026-02-20T12:00:00Z",
      last_success_ts: "2026-02-20T12:00:00Z",
      error_message: null,
    };

    const report = await getSyncHealthReport(ACCOUNT_A.account_id, env);

    expect(report.accountId).toBe(ACCOUNT_A.account_id);
    expect(report.provider).toBe("google");
    expect(report.accountLevel.lastSyncTs).toBe("2026-02-20T12:00:00Z");
    expect(report.scopes).toHaveLength(2);

    const primaryScope = report.scopes.find((s) => s.providerCalendarId === "primary");
    const overlayScope = report.scopes.find((s) => s.providerCalendarId === "overlay-cal-1");
    expect(primaryScope?.hasCursor).toBe(true);
    expect(primaryScope?.lastSuccessTs).toBe("2026-02-20T12:00:00Z");
    expect(overlayScope?.hasCursor).toBe(true);
    expect(overlayScope?.lastSuccessTs).toBe("2026-02-20T11:00:00Z");
  });

  it("AC4: getSyncHealthReport reports error state for a failing scope", async () => {
    healthState.scopedSyncHealthResponses = {
      primary: {
        last_sync_ts: "2026-02-20T12:00:00Z",
        last_success_ts: "2026-02-20T12:00:00Z",
        error_message: null,
        has_cursor: true,
      },
      "overlay-cal-1": {
        last_sync_ts: "2026-02-20T11:00:00Z",
        last_success_ts: null,
        error_message: "Calendar not accessible",
        has_cursor: false,
      },
    };

    healthState.accountLevelHealth = {
      last_sync_ts: "2026-02-20T12:00:00Z",
      last_success_ts: "2026-02-20T12:00:00Z",
      error_message: null,
    };

    const report = await getSyncHealthReport(ACCOUNT_A.account_id, env);

    expect(report.scopes).toHaveLength(2);
    const overlayScope = report.scopes.find((s) => s.providerCalendarId === "overlay-cal-1");
    expect(overlayScope?.errorMessage).toBe("Calendar not accessible");
    expect(overlayScope?.lastSuccessTs).toBeNull();
    expect(overlayScope?.hasCursor).toBe(false);
  });

  // -------------------------------------------------------------------------
  // AC5: Cross-scope deduplication
  // -------------------------------------------------------------------------

  it("AC5: same event appearing in 2 scopes produces only 1 delta (dedup)", async () => {
    const scopedFetch = async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url.includes("/calendars/") && url.includes("/events")) {
        const isPrimary = url.includes("/calendars/primary/");
        return new Response(
          JSON.stringify({
            items: [makeGoogleEvent({ id: "shared-evt-999", summary: "Cross-scope event" })],
            nextSyncToken: isPrimary ? "primary-token-dedup" : "overlay-token-dedup",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response("Not found", { status: 404 });
    };

    const message: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: ACCOUNT_A.account_id,
      channel_id: "channel-dedup",
      resource_id: "resource-dedup",
      ping_ts: new Date().toISOString(),
      calendar_id: null,
    };

    await handleIncrementalSync(message, env, { fetchFn: scopedFetch, sleepFn: noopSleep });

    expect(userGraphDOState.applyDeltaCalls).toHaveLength(1);
    const deltas = userGraphDOState.applyDeltaCalls[0].deltas as Array<{ origin_event_id: string }>;
    expect(deltas).toHaveLength(1);
    expect(deltas[0].origin_event_id).toBe("shared-evt-999");
  });

  it("AC5: different events from 2 scopes each produce a delta", async () => {
    const scopedFetch = async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url.includes("/calendars/") && url.includes("/events")) {
        const isPrimary = url.includes("/calendars/primary/");
        return new Response(
          JSON.stringify({
            items: [
              makeGoogleEvent({
                id: isPrimary ? "unique-primary-evt" : "unique-overlay-evt",
                summary: isPrimary ? "Primary Only" : "Overlay Only",
              }),
            ],
            nextSyncToken: isPrimary ? "primary-token-unique" : "overlay-token-unique",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response("Not found", { status: 404 });
    };

    const message: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: ACCOUNT_A.account_id,
      channel_id: "channel-unique",
      resource_id: "resource-unique",
      ping_ts: new Date().toISOString(),
      calendar_id: null,
    };

    await handleIncrementalSync(message, env, { fetchFn: scopedFetch, sleepFn: noopSleep });

    expect(userGraphDOState.applyDeltaCalls).toHaveLength(1);
    const deltas = userGraphDOState.applyDeltaCalls[0].deltas as Array<{ origin_event_id: string }>;
    expect(deltas).toHaveLength(2);
    const ids = deltas.map((d) => d.origin_event_id);
    expect(ids).toContain("unique-primary-evt");
    expect(ids).toContain("unique-overlay-evt");
  });

  it("AC5: full sync also deduplicates across scopes", async () => {
    const scopedFetch = async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url.includes("/calendars/") && url.includes("/events")) {
        return new Response(
          JSON.stringify({
            items: [makeGoogleEvent({ id: "shared-full-evt", summary: "Shared Full Sync Event" })],
            nextSyncToken: "full-dedup-token",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response("Not found", { status: 404 });
    };

    const message: SyncFullMessage = {
      type: "SYNC_FULL",
      account_id: ACCOUNT_A.account_id,
      reason: "onboarding",
    };

    await handleFullSync(message, env, { fetchFn: scopedFetch, sleepFn: noopSleep });

    expect(userGraphDOState.applyDeltaCalls).toHaveLength(1);
    const deltas = userGraphDOState.applyDeltaCalls[0].deltas as Array<{ origin_event_id: string }>;
    expect(deltas).toHaveLength(1);
    expect(deltas[0].origin_event_id).toBe("shared-full-evt");
  });

  // -------------------------------------------------------------------------
  // Mixed: incremental + full with scoped cursors
  // -------------------------------------------------------------------------

  it("mixed: per-scope cursor independence across targeted incremental sync", async () => {
    const incrementalFetch = async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url.includes("/calendars/overlay-cal-1/events")) {
        return new Response(
          JSON.stringify({
            items: [makeGoogleEvent({ id: "incr-overlay-evt" })],
            nextSyncToken: "incr-overlay-cursor",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response("Not found", { status: 404 });
    };

    const incrMessage: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: ACCOUNT_A.account_id,
      channel_id: "channel-mixed-incr",
      resource_id: "resource-mixed-incr",
      ping_ts: new Date().toISOString(),
      calendar_id: "overlay-cal-1",
    };

    await handleIncrementalSync(incrMessage, env, { fetchFn: incrementalFetch, sleepFn: noopSleep });

    // Only overlay cursor was updated
    expect(accountDOState.setScopedSyncTokenCalls).toHaveLength(1);
    expect(accountDOState.setScopedSyncTokenCalls[0].provider_calendar_id).toBe("overlay-cal-1");
    expect(accountDOState.setScopedSyncTokenCalls[0].sync_token).toBe("incr-overlay-cursor");

    // Primary cursor should still be the original
    expect(accountDOState.scopedSyncTokens.primary).toBe(TEST_SYNC_TOKEN);
    expect(accountDOState.scopedSyncTokens["overlay-cal-1"]).toBe("incr-overlay-cursor");
  });
});
