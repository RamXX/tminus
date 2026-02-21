/**
 * Integration tests for per-scope reconciliation (TM-8gfd.5 AC3).
 *
 * Uses real SQLite (better-sqlite3) for D1 mock. DOs are mocked at the fetch
 * boundary. Google Calendar API is mocked via injectable FetchFn.
 *
 * Tests prove:
 * - AC3: Reconcile flow can run per-scope with clear reason codes and metrics.
 *   - Multi-scope reconciliation deduplicates origin events across scopes.
 *   - Targeted scope reconciliation only fetches the specified scope.
 *   - Per-scope repair correctly identifies missing canonicals per scope.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { MIGRATION_0001_INITIAL_SCHEMA } from "@tminus/d1-registry";
import { ReconcileWorkflow } from "./index";
import type { ReconcileEnv, ReconcileParams } from "./index";
import type { AccountId } from "@tminus/shared";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_ORG = {
  org_id: "org_01HXYZ00000000000000000001",
  name: "Scoped Reconcile Test Org",
} as const;

const TEST_USER = {
  user_id: "usr_01HXYZ00000000000000000001",
  org_id: TEST_ORG.org_id,
  email: "scopedreconcile@example.com",
} as const;

const ACCOUNT_A = {
  account_id: "acc_01HXYZ0000000000000000000A" as AccountId,
  user_id: TEST_USER.user_id,
  provider: "google",
  provider_subject: "google-sub-scope-recon-a",
  email: "alice@gmail.com",
} as const;

const TEST_ACCESS_TOKEN = "ya29.test-access-token-scoped-reconcile";
const TEST_SYNC_TOKEN = "sync-token-scoped-reconcile";

// ---------------------------------------------------------------------------
// Event factories
// ---------------------------------------------------------------------------

function makeOriginEvent(overrides?: Record<string, unknown>) {
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
  setSyncTokenCalls: string[];
  markSyncSuccessCalls: Array<{ ts: string }>;
  calendarScopes: Array<{
    provider_calendar_id: string;
    enabled: boolean;
    sync_enabled: boolean;
  }>;
}

interface UserGraphDOState {
  applyDeltaCalls: Array<{ account_id: string; deltas: unknown[] }>;
  findCanonicalByOriginCalls: Array<{
    origin_account_id: string;
    origin_event_id: string;
  }>;
  canonicalByOrigin: Map<string, Record<string, unknown> | null>;
  getMirrorCalls: Array<{
    canonical_event_id: string;
    target_account_id: string;
  }>;
  getActiveMirrorsCalls: Array<{ target_account_id: string }>;
  getPolicyEdgesCalls: Array<{ from_account_id: string }>;
  getCanonicalEventCalls: Array<{ canonical_event_id: string }>;
  recomputeProjectionsCalls: Array<{ canonical_event_id?: string }>;
  logReconcileDiscrepancyCalls: Array<{
    canonical_event_id: string;
    discrepancy_type: string;
    details: Record<string, unknown>;
  }>;
  canonicalEvents: Map<string, { event: Record<string, unknown> } | null>;
  mirrorsByKey: Map<string, Record<string, unknown> | null>;
  activeMirrorsByAccount: Map<string, Array<Record<string, unknown>>>;
  policyEdgesByAccount: Map<string, Array<Record<string, unknown>>>;
}

// ---------------------------------------------------------------------------
// DO stub mocks
// ---------------------------------------------------------------------------

function createScopedAccountDO(state: AccountDOState) {
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

      if (path === "/setSyncToken") {
        const body = (await request.json()) as { sync_token: string };
        state.setSyncTokenCalls.push(body.sync_token);
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (path === "/markSyncSuccess") {
        const body = (await request.json()) as { ts: string };
        state.markSyncSuccessCalls.push(body);
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

      return new Response("Not found", { status: 404 });
    },
  };
}

function createScopedUserGraphDO(state: UserGraphDOState) {
  return {
    fetch: async (request: Request): Promise<Response> => {
      const url = new URL(request.url);
      const path = url.pathname;

      if (path === "/applyProviderDelta") {
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

      if (path === "/findCanonicalByOrigin") {
        const body = (await request.json()) as {
          origin_account_id: string;
          origin_event_id: string;
        };
        state.findCanonicalByOriginCalls.push(body);
        const key = `${body.origin_account_id}:${body.origin_event_id}`;
        const result = state.canonicalByOrigin.get(key) ?? null;
        return new Response(
          JSON.stringify({ event: result }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (path === "/getMirror") {
        const body = (await request.json()) as {
          canonical_event_id: string;
          target_account_id: string;
        };
        state.getMirrorCalls.push(body);
        const key = `${body.canonical_event_id}:${body.target_account_id}`;
        return new Response(
          JSON.stringify({ mirror: state.mirrorsByKey.get(key) ?? null }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (path === "/getActiveMirrors") {
        const body = (await request.json()) as { target_account_id: string };
        state.getActiveMirrorsCalls.push(body);
        const mirrors = state.activeMirrorsByAccount.get(body.target_account_id) ?? [];
        return new Response(
          JSON.stringify({ mirrors }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (path === "/getPolicyEdges") {
        const body = (await request.json()) as { from_account_id: string };
        state.getPolicyEdgesCalls.push(body);
        const edges = state.policyEdgesByAccount.get(body.from_account_id) ?? [];
        return new Response(
          JSON.stringify({ edges }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (path === "/getCanonicalEvent") {
        const body = (await request.json()) as { canonical_event_id: string };
        state.getCanonicalEventCalls.push(body);
        const result = state.canonicalEvents.get(body.canonical_event_id);
        return new Response(
          JSON.stringify(result ?? { event: null }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (path === "/logReconcileDiscrepancy") {
        const body = (await request.json()) as {
          canonical_event_id: string;
          discrepancy_type: string;
          details: Record<string, unknown>;
        };
        state.logReconcileDiscrepancyCalls.push(body);
        return new Response(JSON.stringify({ ok: true }), {
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

describe("Per-scope reconciliation (TM-8gfd.5 AC3)", () => {
  let db: DatabaseType;
  let d1: D1Database;
  let writeQueue: Queue & { messages: unknown[] };
  let accountDOState: AccountDOState;
  let userGraphDOState: UserGraphDOState;
  let env: ReconcileEnv;

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
    writeQueue = createMockQueue();

    accountDOState = {
      accessToken: TEST_ACCESS_TOKEN,
      setSyncTokenCalls: [],
      markSyncSuccessCalls: [],
      calendarScopes: [
        { provider_calendar_id: "primary", enabled: true, sync_enabled: true },
        { provider_calendar_id: "overlay-cal-1", enabled: true, sync_enabled: true },
      ],
    };

    userGraphDOState = {
      applyDeltaCalls: [],
      findCanonicalByOriginCalls: [],
      canonicalByOrigin: new Map(),
      getMirrorCalls: [],
      getActiveMirrorsCalls: [],
      getPolicyEdgesCalls: [],
      getCanonicalEventCalls: [],
      recomputeProjectionsCalls: [],
      logReconcileDiscrepancyCalls: [],
      canonicalEvents: new Map(),
      mirrorsByKey: new Map(),
      activeMirrorsByAccount: new Map(),
      policyEdgesByAccount: new Map(),
    };

    const accountStub = createScopedAccountDO(accountDOState);
    const userGraphStub = createScopedUserGraphDO(userGraphDOState);

    env = {
      DB: d1,
      WRITE_QUEUE: writeQueue,
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

  // -----------------------------------------------------------------------
  // AC3: Multi-scope reconciliation deduplicates across scopes
  // -----------------------------------------------------------------------

  it("AC3: multi-scope reconcile deduplicates origin events across 2 scopes", async () => {
    // Both primary and overlay return the same event
    const sharedEvent = makeOriginEvent({ id: "shared-recon-evt", summary: "Shared" });
    const calledCalendarIds: string[] = [];

    const scopedFetch = async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/calendars/") && url.includes("/events")) {
        const match = url.match(/\/calendars\/([^/]+)\/events/);
        if (match) calledCalendarIds.push(decodeURIComponent(match[1]));

        return new Response(
          JSON.stringify({
            items: [sharedEvent],
            nextSyncToken: TEST_SYNC_TOKEN,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("Not found", { status: 404 });
    };

    const workflow = new ReconcileWorkflow(env, { fetchFn: scopedFetch });
    const params: ReconcileParams = {
      account_id: ACCOUNT_A.account_id,
      reason: "scheduled",
    };

    const result = await workflow.run(params);

    // Both scopes were fetched
    expect(calledCalendarIds).toContain("primary");
    expect(calledCalendarIds).toContain("overlay-cal-1");

    // Only 1 origin event after dedup (not 2)
    expect(result.originEvents).toBe(1);

    // The same origin was only processed once for canonical checks
    expect(userGraphDOState.findCanonicalByOriginCalls).toHaveLength(1);
    expect(userGraphDOState.findCanonicalByOriginCalls[0].origin_event_id).toBe("shared-recon-evt");
  });

  // -----------------------------------------------------------------------
  // AC3: Targeted scope reconciliation
  // -----------------------------------------------------------------------

  it("AC3: targeted scope reconcile only fetches the specified scope", async () => {
    const calledCalendarIds: string[] = [];

    const scopedFetch = async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/calendars/") && url.includes("/events")) {
        const match = url.match(/\/calendars\/([^/]+)\/events/);
        if (match) calledCalendarIds.push(decodeURIComponent(match[1]));

        return new Response(
          JSON.stringify({
            items: [makeOriginEvent({ id: "overlay-only-evt" })],
            nextSyncToken: TEST_SYNC_TOKEN,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("Not found", { status: 404 });
    };

    const workflow = new ReconcileWorkflow(env, { fetchFn: scopedFetch });
    const params: ReconcileParams = {
      account_id: ACCOUNT_A.account_id,
      reason: "manual",
      scope: "overlay-cal-1",
    };

    const result = await workflow.run(params);

    // Only the targeted scope was fetched
    expect(calledCalendarIds).toEqual(["overlay-cal-1"]);
    expect(result.originEvents).toBe(1);
    expect(result.totalProviderEvents).toBe(1);
  });

  // -----------------------------------------------------------------------
  // AC3: Per-scope repair creates missing canonicals per scope
  // -----------------------------------------------------------------------

  it("AC3: per-scope reconcile creates missing canonicals for events found in each scope", async () => {
    const scopedFetch = async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/calendars/") && url.includes("/events")) {
        const isPrimary = url.includes("/calendars/primary/");
        return new Response(
          JSON.stringify({
            items: isPrimary
              ? [makeOriginEvent({ id: "primary-recon-evt", summary: "Primary Event" })]
              : [makeOriginEvent({ id: "overlay-recon-evt", summary: "Overlay Event" })],
            nextSyncToken: TEST_SYNC_TOKEN,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("Not found", { status: 404 });
    };

    // Neither event has a canonical -- both should be created
    const workflow = new ReconcileWorkflow(env, { fetchFn: scopedFetch });
    const params: ReconcileParams = {
      account_id: ACCOUNT_A.account_id,
      reason: "drift_detected",
    };

    const result = await workflow.run(params);

    // 2 unique origin events from 2 scopes
    expect(result.originEvents).toBe(2);
    expect(result.missingCanonicalsCreated).toBe(2);
    expect(result.discrepancies).toHaveLength(2);
    expect(result.discrepancies.every((d) => d.type === "missing_canonical")).toBe(true);

    // 2 apply calls -- one per missing canonical
    expect(userGraphDOState.applyDeltaCalls).toHaveLength(2);
  });
});
