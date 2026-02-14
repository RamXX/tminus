/**
 * Integration tests for ReconcileWorkflow.
 *
 * Uses real SQLite (better-sqlite3) for D1 mock. DOs are mocked at the fetch
 * boundary. Google Calendar API is mocked via injectable FetchFn.
 *
 * Tests prove:
 * 1. Full sync fetches all events from provider (AC 1)
 * 2. Cross-checks canonical events against provider events (AC 2)
 * 3. Cross-checks mirrors against provider mirrors (AC 3)
 * 4. Missing canonicals created (AC 4)
 * 5. Missing mirrors enqueued for creation (AC 5)
 * 6. Orphaned mirrors enqueued for deletion (AC 6)
 * 7. Hash mismatches corrected (AC 7)
 * 8. Stale mirrors tombstoned (AC 8)
 * 9. All discrepancies logged to event_journal (AC 9)
 * 10. AccountDO timestamps updated (AC 10)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { MIGRATION_0001_INITIAL_SCHEMA } from "@tminus/d1-registry";
import { ReconcileWorkflow } from "./index";
import type { ReconcileEnv, ReconcileParams } from "./index";
import type { AccountId } from "@tminus/shared";

// ---------------------------------------------------------------------------
// Test constants (valid ULID format: 4-char prefix + 26 Crockford Base32 chars)
// ---------------------------------------------------------------------------

const TEST_ORG = {
  org_id: "org_01HXYZ000000000000000001",
  name: "Reconcile Test Org",
} as const;

const TEST_USER = {
  user_id: "usr_01HXYZ000000000000000001",
  org_id: TEST_ORG.org_id,
  email: "reconcile@example.com",
} as const;

const ACCOUNT_A = {
  account_id: "acc_01HXYZ00000000000000000A" as AccountId,
  user_id: TEST_USER.user_id,
  provider: "google",
  provider_subject: "google-sub-recon-a",
  email: "alice@gmail.com",
} as const;

const ACCOUNT_B = {
  account_id: "acc_01HXYZ00000000000000000B" as AccountId,
  user_id: TEST_USER.user_id,
  provider: "google",
  provider_subject: "google-sub-recon-b",
  email: "alice-work@gmail.com",
} as const;

const TEST_ACCESS_TOKEN = "ya29.test-access-token-reconcile";
const TEST_SYNC_TOKEN = "new-sync-token-after-reconcile";

// Canonical event IDs for test fixtures
const CANONICAL_EVT_1 = "evt_01HXYZ000000000000000001";
const CANONICAL_EVT_2 = "evt_01HXYZ000000000000000002";
const CANONICAL_EVT_3 = "evt_01HXYZ000000000000000003";

// Policy ID
const POLICY_ID = "pol_01HXYZ000000000000000001";

// ---------------------------------------------------------------------------
// Google Calendar API event factories
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

function makeManagedMirrorEvent(
  canonicalEventId: string,
  originAccountId: string,
  overrides?: Record<string, unknown>,
) {
  return {
    id: "google_mirror_evt_200",
    summary: "Busy",
    start: { dateTime: "2026-02-15T11:00:00Z" },
    end: { dateTime: "2026-02-15T12:00:00Z" },
    status: "confirmed",
    extendedProperties: {
      private: {
        tminus: "true",
        managed: "true",
        canonical_event_id: canonicalEventId,
        origin_account_id: originAccountId,
      },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Real D1 mock backed by better-sqlite3 (same pattern as onboarding tests)
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

function createReconcileGoogleApiFetch(options: {
  eventPages?: Array<{
    events: unknown[];
    nextPageToken?: string;
    nextSyncToken?: string;
  }>;
}) {
  let eventsCallIndex = 0;

  return async (
    input: string | URL | Request,
    _init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    // events.list -- GET /calendars/{id}/events
    if (url.includes("/calendars/") && url.includes("/events")) {
      const pages = options.eventPages ?? [
        { events: [], nextSyncToken: TEST_SYNC_TOKEN },
      ];
      const page = pages[eventsCallIndex] ?? pages[pages.length - 1];
      eventsCallIndex++;

      return new Response(
        JSON.stringify({
          items: page.events,
          nextPageToken: page.nextPageToken,
          nextSyncToken: page.nextSyncToken,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response("Not found", { status: 404 });
  };
}

// ---------------------------------------------------------------------------
// DO stub mock state types
// ---------------------------------------------------------------------------

interface AccountDOState {
  accessToken: string;
  setSyncTokenCalls: string[];
  markSyncSuccessCalls: Array<{ ts: string }>;
}

interface UserGraphDOState {
  applyDeltaCalls: Array<{ account_id: string; deltas: unknown[] }>;
  findCanonicalByOriginCalls: Array<{
    origin_account_id: string;
    origin_event_id: string;
  }>;
  getMirrorCalls: Array<{
    canonical_event_id: string;
    target_account_id: string;
  }>;
  getActiveMirrorsCalls: Array<{ target_account_id: string }>;
  updateMirrorStateCalls: Array<{
    canonical_event_id: string;
    target_account_id: string;
    update: Record<string, unknown>;
  }>;
  getPolicyEdgesCalls: Array<{ from_account_id: string }>;
  getCanonicalEventCalls: Array<{ canonical_event_id: string }>;
  recomputeProjectionsCalls: Array<{
    canonical_event_id?: string;
  }>;
  logReconcileDiscrepancyCalls: Array<{
    canonical_event_id: string;
    discrepancy_type: string;
    details: Record<string, unknown>;
  }>;

  // State for mock responses
  canonicalEvents: Map<
    string,
    {
      event: Record<string, unknown>;
      mirrors: Array<Record<string, unknown>>;
    } | null
  >;
  canonicalByOrigin: Map<string, Record<string, unknown> | null>;
  mirrorsByKey: Map<string, Record<string, unknown> | null>;
  activeMirrorsByAccount: Map<string, Array<Record<string, unknown>>>;
  policyEdgesByAccount: Map<string, Array<Record<string, unknown>>>;
}

// ---------------------------------------------------------------------------
// DO stub mocks
// ---------------------------------------------------------------------------

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

      return new Response("Not found", { status: 404 });
    },
  };
}

function createMockUserGraphDO(state: UserGraphDOState) {
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
        const event = state.canonicalByOrigin.get(key) ?? null;
        return new Response(JSON.stringify({ event }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (path === "/getMirror") {
        const body = (await request.json()) as {
          canonical_event_id: string;
          target_account_id: string;
        };
        state.getMirrorCalls.push(body);
        const key = `${body.canonical_event_id}:${body.target_account_id}`;
        const mirror = state.mirrorsByKey.get(key) ?? null;
        return new Response(JSON.stringify({ mirror }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (path === "/getActiveMirrors") {
        const body = (await request.json()) as {
          target_account_id: string;
        };
        state.getActiveMirrorsCalls.push(body);
        const mirrors =
          state.activeMirrorsByAccount.get(body.target_account_id) ?? [];
        return new Response(JSON.stringify({ mirrors }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (path === "/updateMirrorState") {
        const body = (await request.json()) as {
          canonical_event_id: string;
          target_account_id: string;
          update: Record<string, unknown>;
        };
        state.updateMirrorStateCalls.push(body);
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (path === "/getPolicyEdges") {
        const body = (await request.json()) as {
          from_account_id: string;
        };
        state.getPolicyEdgesCalls.push(body);
        const edges =
          state.policyEdgesByAccount.get(body.from_account_id) ?? [];
        return new Response(JSON.stringify({ edges }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (path === "/getCanonicalEvent") {
        const body = (await request.json()) as {
          canonical_event_id: string;
        };
        state.getCanonicalEventCalls.push(body);
        const data =
          state.canonicalEvents.get(body.canonical_event_id) ?? null;
        return new Response(JSON.stringify(data), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (path === "/recomputeProjections") {
        const body = (await request.json()) as {
          canonical_event_id?: string;
        };
        state.recomputeProjectionsCalls.push(body);
        return new Response(JSON.stringify({ enqueued: 1 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
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
// createMockEnv factory
// ---------------------------------------------------------------------------

function createMockEnv(options: {
  d1: D1Database;
  writeQueue: Queue & { messages: unknown[] };
  accountDOState: AccountDOState;
  userGraphDOState: UserGraphDOState;
}): ReconcileEnv {
  const accountStub = createMockAccountDO(options.accountDOState);
  const userGraphStub = createMockUserGraphDO(options.userGraphDOState);

  return {
    DB: options.d1,
    WRITE_QUEUE: options.writeQueue,
    ACCOUNT: {
      idFromName(_name: string) {
        return { toString: () => "mock-account-do-id" } as DurableObjectId;
      },
      get(_id: DurableObjectId) {
        return accountStub as unknown as DurableObjectStub;
      },
    } as unknown as DurableObjectNamespace,
    USER_GRAPH: {
      idFromName(_name: string) {
        return { toString: () => "mock-ug-do-id" } as DurableObjectId;
      },
      get(_id: DurableObjectId) {
        return userGraphStub as unknown as DurableObjectStub;
      },
    } as unknown as DurableObjectNamespace,
  };
}

// ---------------------------------------------------------------------------
// Helper: default UserGraphDOState
// ---------------------------------------------------------------------------

function createDefaultUGState(): UserGraphDOState {
  return {
    applyDeltaCalls: [],
    findCanonicalByOriginCalls: [],
    getMirrorCalls: [],
    getActiveMirrorsCalls: [],
    updateMirrorStateCalls: [],
    getPolicyEdgesCalls: [],
    getCanonicalEventCalls: [],
    recomputeProjectionsCalls: [],
    logReconcileDiscrepancyCalls: [],
    canonicalEvents: new Map(),
    canonicalByOrigin: new Map(),
    mirrorsByKey: new Map(),
    activeMirrorsByAccount: new Map(),
    policyEdgesByAccount: new Map(),
  };
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe("ReconcileWorkflow integration tests (real SQLite, mocked Google API + DOs)", () => {
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

    // Seed prerequisite rows
    db.prepare("INSERT INTO orgs (org_id, name) VALUES (?, ?)").run(
      TEST_ORG.org_id,
      TEST_ORG.name,
    );
    db.prepare(
      "INSERT INTO users (user_id, org_id, email) VALUES (?, ?, ?)",
    ).run(TEST_USER.user_id, TEST_USER.org_id, TEST_USER.email);
    db.prepare(
      "INSERT INTO accounts (account_id, user_id, provider, provider_subject, email, status) VALUES (?, ?, ?, ?, ?, 'active')",
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
    };

    userGraphDOState = createDefaultUGState();

    env = createMockEnv({
      d1,
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
  // AC 1: Full sync fetches all events from provider
  // -------------------------------------------------------------------------

  it("AC1: full sync fetches all events from provider (paginated)", async () => {
    const page1Events = [
      makeOriginEvent({ id: "evt_p1_1", summary: "Page 1 Event 1" }),
      makeOriginEvent({ id: "evt_p1_2", summary: "Page 1 Event 2" }),
    ];
    const page2Events = [
      makeOriginEvent({ id: "evt_p2_1", summary: "Page 2 Event 1" }),
    ];

    // Set up canonical events so they are found (no drift)
    for (const id of ["evt_p1_1", "evt_p1_2", "evt_p2_1"]) {
      userGraphDOState.canonicalByOrigin.set(
        `${ACCOUNT_A.account_id}:${id}`,
        {
          canonical_event_id: `evt_canonical_${id}`,
          origin_account_id: ACCOUNT_A.account_id,
          origin_event_id: id,
        },
      );
    }

    // No policy edges -- no mirrors expected
    userGraphDOState.policyEdgesByAccount.set(ACCOUNT_A.account_id, []);

    const googleFetch = createReconcileGoogleApiFetch({
      eventPages: [
        { events: page1Events, nextPageToken: "page2_token" },
        { events: page2Events, nextSyncToken: TEST_SYNC_TOKEN },
      ],
    });

    const workflow = new ReconcileWorkflow(env, { fetchFn: googleFetch });
    const result = await workflow.run({
      account_id: ACCOUNT_A.account_id,
      reason: "scheduled",
    });

    expect(result.totalProviderEvents).toBe(3);
    expect(result.originEvents).toBe(3);
    expect(result.managedMirrors).toBe(0);
    expect(result.syncToken).toBe(TEST_SYNC_TOKEN);
    expect(result.discrepancies).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // AC 2: Cross-checks canonical events against provider events
  // -------------------------------------------------------------------------

  it("AC2: cross-checks each origin event against canonical store", async () => {
    const events = [
      makeOriginEvent({ id: "evt_known", summary: "Known Event" }),
      makeOriginEvent({ id: "evt_unknown", summary: "Unknown Event" }),
    ];

    // evt_known exists in canonical store, evt_unknown does not
    userGraphDOState.canonicalByOrigin.set(
      `${ACCOUNT_A.account_id}:evt_known`,
      {
        canonical_event_id: CANONICAL_EVT_1,
        origin_account_id: ACCOUNT_A.account_id,
        origin_event_id: "evt_known",
      },
    );
    // evt_unknown is NOT in the map (defaults to null)

    // No policy edges for the known event
    userGraphDOState.policyEdgesByAccount.set(ACCOUNT_A.account_id, []);

    const googleFetch = createReconcileGoogleApiFetch({
      eventPages: [
        { events, nextSyncToken: TEST_SYNC_TOKEN },
      ],
    });

    const workflow = new ReconcileWorkflow(env, { fetchFn: googleFetch });
    const result = await workflow.run({
      account_id: ACCOUNT_A.account_id,
      reason: "scheduled",
    });

    // Both events were cross-checked
    expect(userGraphDOState.findCanonicalByOriginCalls).toHaveLength(2);
    expect(
      userGraphDOState.findCanonicalByOriginCalls.map(
        (c) => c.origin_event_id,
      ),
    ).toContain("evt_known");
    expect(
      userGraphDOState.findCanonicalByOriginCalls.map(
        (c) => c.origin_event_id,
      ),
    ).toContain("evt_unknown");

    // Only evt_unknown should be a discrepancy
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0].type).toBe("missing_canonical");
    expect(result.discrepancies[0].origin_event_id).toBe("evt_unknown");
  });

  // -------------------------------------------------------------------------
  // AC 3: Cross-checks mirrors against provider mirrors
  // -------------------------------------------------------------------------

  it("AC3: cross-checks managed mirrors in provider against event_mirrors", async () => {
    const managedMirror = makeManagedMirrorEvent(
      CANONICAL_EVT_1,
      ACCOUNT_B.account_id,
    );

    // Set up mirror row so it is found
    userGraphDOState.mirrorsByKey.set(
      `${CANONICAL_EVT_1}:${ACCOUNT_A.account_id}`,
      {
        canonical_event_id: CANONICAL_EVT_1,
        target_account_id: ACCOUNT_A.account_id,
        target_calendar_id: "cal_overlay",
        provider_event_id: "google_mirror_evt_200",
        last_projected_hash: "abc123",
        last_write_ts: "2026-02-14T00:00:00Z",
        state: "ACTIVE",
        error_message: null,
      },
    );

    // Set up canonical event for hash check
    userGraphDOState.canonicalEvents.set(CANONICAL_EVT_1, {
      event: {
        canonical_event_id: CANONICAL_EVT_1,
        origin_account_id: ACCOUNT_B.account_id,
        origin_event_id: "original_evt_1",
        title: "Team Meeting",
        start: { dateTime: "2026-02-15T11:00:00Z" },
        end: { dateTime: "2026-02-15T12:00:00Z" },
        all_day: false,
        status: "confirmed",
        visibility: "default",
        transparency: "opaque",
      },
      mirrors: [],
    });

    // Set up policy edge for hash computation
    userGraphDOState.policyEdgesByAccount.set(ACCOUNT_B.account_id, [
      {
        policy_id: POLICY_ID,
        from_account_id: ACCOUNT_B.account_id,
        to_account_id: ACCOUNT_A.account_id,
        detail_level: "BUSY",
        calendar_kind: "BUSY_OVERLAY",
      },
    ]);

    // No active mirrors for step 2c
    userGraphDOState.activeMirrorsByAccount.set(ACCOUNT_A.account_id, []);

    const googleFetch = createReconcileGoogleApiFetch({
      eventPages: [
        { events: [managedMirror], nextSyncToken: TEST_SYNC_TOKEN },
      ],
    });

    const workflow = new ReconcileWorkflow(env, { fetchFn: googleFetch });
    const result = await workflow.run({
      account_id: ACCOUNT_A.account_id,
      reason: "scheduled",
    });

    // Should have checked the mirror
    expect(userGraphDOState.getMirrorCalls).toHaveLength(1);
    expect(userGraphDOState.getMirrorCalls[0].canonical_event_id).toBe(
      CANONICAL_EVT_1,
    );
    expect(result.managedMirrors).toBe(1);
  });

  // -------------------------------------------------------------------------
  // AC 4: Missing canonicals created
  // -------------------------------------------------------------------------

  it("AC4: detects missing canonical event and creates it via applyProviderDelta", async () => {
    const missingEvent = makeOriginEvent({
      id: "evt_missing_from_canonical",
      summary: "Ghost Event",
    });

    // No canonical exists for this event (not in map)

    const googleFetch = createReconcileGoogleApiFetch({
      eventPages: [
        { events: [missingEvent], nextSyncToken: TEST_SYNC_TOKEN },
      ],
    });

    const workflow = new ReconcileWorkflow(env, { fetchFn: googleFetch });
    const result = await workflow.run({
      account_id: ACCOUNT_A.account_id,
      reason: "scheduled",
    });

    // applyProviderDelta should have been called
    expect(userGraphDOState.applyDeltaCalls).toHaveLength(1);
    const call = userGraphDOState.applyDeltaCalls[0];
    expect(call.account_id).toBe(ACCOUNT_A.account_id);
    expect(call.deltas).toHaveLength(1);

    const delta = call.deltas[0] as Record<string, unknown>;
    expect(delta.type).toBe("updated");
    expect(delta.origin_event_id).toBe("evt_missing_from_canonical");

    // Event payload included
    const eventPayload = delta.event as Record<string, unknown>;
    expect(eventPayload.title).toBe("Ghost Event");

    // Discrepancy recorded
    expect(result.missingCanonicalsCreated).toBe(1);
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0].type).toBe("missing_canonical");
    expect(result.discrepancies[0].origin_event_id).toBe(
      "evt_missing_from_canonical",
    );
  });

  // -------------------------------------------------------------------------
  // AC 5: Missing mirrors enqueued for creation
  // -------------------------------------------------------------------------

  it("AC5: detects missing mirror and triggers recomputeProjections (enqueues UPSERT_MIRROR)", async () => {
    const originEvent = makeOriginEvent({
      id: "evt_has_canonical",
      summary: "Has Canonical",
    });

    // Canonical exists
    userGraphDOState.canonicalByOrigin.set(
      `${ACCOUNT_A.account_id}:evt_has_canonical`,
      {
        canonical_event_id: CANONICAL_EVT_1,
        origin_account_id: ACCOUNT_A.account_id,
        origin_event_id: "evt_has_canonical",
      },
    );

    // Policy edge exists A -> B, but no mirror row
    userGraphDOState.policyEdgesByAccount.set(ACCOUNT_A.account_id, [
      {
        policy_id: POLICY_ID,
        from_account_id: ACCOUNT_A.account_id,
        to_account_id: ACCOUNT_B.account_id,
        detail_level: "BUSY",
        calendar_kind: "BUSY_OVERLAY",
      },
    ]);

    // No mirror in mirrorsByKey (missing mirror)

    const googleFetch = createReconcileGoogleApiFetch({
      eventPages: [
        { events: [originEvent], nextSyncToken: TEST_SYNC_TOKEN },
      ],
    });

    const workflow = new ReconcileWorkflow(env, { fetchFn: googleFetch });
    const result = await workflow.run({
      account_id: ACCOUNT_A.account_id,
      reason: "manual",
    });

    // recomputeProjections should have been called for the canonical event
    expect(userGraphDOState.recomputeProjectionsCalls).toHaveLength(1);
    expect(
      userGraphDOState.recomputeProjectionsCalls[0].canonical_event_id,
    ).toBe(CANONICAL_EVT_1);

    // Discrepancy recorded
    expect(result.missingMirrorsEnqueued).toBe(1);
    const mirrorDisc = result.discrepancies.find(
      (d) => d.type === "missing_mirror",
    );
    expect(mirrorDisc).toBeDefined();
    expect(mirrorDisc!.canonical_event_id).toBe(CANONICAL_EVT_1);
    expect(mirrorDisc!.target_account_id).toBe(ACCOUNT_B.account_id);
  });

  // -------------------------------------------------------------------------
  // AC 6: Orphaned mirrors enqueued for deletion
  // -------------------------------------------------------------------------

  it("AC6: detects orphaned mirror in provider and enqueues DELETE_MIRROR", async () => {
    const orphanedMirror = makeManagedMirrorEvent(
      "evt_01HXYZ000000000000ORPHAN",
      ACCOUNT_B.account_id,
      { id: "google_orphan_evt_300" },
    );

    // No mirror row exists for this canonical_event_id + account
    // (mirrorsByKey is empty by default)

    // No active mirrors for step 2c
    userGraphDOState.activeMirrorsByAccount.set(ACCOUNT_A.account_id, []);

    const googleFetch = createReconcileGoogleApiFetch({
      eventPages: [
        { events: [orphanedMirror], nextSyncToken: TEST_SYNC_TOKEN },
      ],
    });

    const workflow = new ReconcileWorkflow(env, { fetchFn: googleFetch });
    const result = await workflow.run({
      account_id: ACCOUNT_A.account_id,
      reason: "scheduled",
    });

    // DELETE_MIRROR should have been enqueued to write queue
    expect(writeQueue.messages).toHaveLength(1);
    const deleteMsg = writeQueue.messages[0] as Record<string, unknown>;
    expect(deleteMsg.type).toBe("DELETE_MIRROR");
    expect(deleteMsg.canonical_event_id).toBe(
      "evt_01HXYZ000000000000ORPHAN",
    );
    expect(deleteMsg.target_account_id).toBe(ACCOUNT_A.account_id);
    expect(deleteMsg.provider_event_id).toBe("google_orphan_evt_300");
    expect(deleteMsg.idempotency_key).toBeTruthy();

    // Discrepancy recorded
    expect(result.orphanedMirrorsEnqueued).toBe(1);
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0].type).toBe("orphaned_mirror");
  });

  // -------------------------------------------------------------------------
  // AC 7: Hash mismatches corrected
  // -------------------------------------------------------------------------

  it("AC7: detects hash mismatch and triggers recomputeProjections to correct", async () => {
    const managedMirror = makeManagedMirrorEvent(
      CANONICAL_EVT_2,
      ACCOUNT_B.account_id,
      { id: "google_mirror_stale_hash" },
    );

    // Mirror row exists but with stale hash
    userGraphDOState.mirrorsByKey.set(
      `${CANONICAL_EVT_2}:${ACCOUNT_A.account_id}`,
      {
        canonical_event_id: CANONICAL_EVT_2,
        target_account_id: ACCOUNT_A.account_id,
        target_calendar_id: "cal_overlay",
        provider_event_id: "google_mirror_stale_hash",
        last_projected_hash: "STALE_HASH_DOES_NOT_MATCH",
        last_write_ts: "2026-02-13T00:00:00Z",
        state: "ACTIVE",
        error_message: null,
      },
    );

    // Canonical event for hash recomputation
    userGraphDOState.canonicalEvents.set(CANONICAL_EVT_2, {
      event: {
        canonical_event_id: CANONICAL_EVT_2,
        origin_account_id: ACCOUNT_B.account_id,
        origin_event_id: "original_evt_2",
        title: "Updated Meeting",
        start: { dateTime: "2026-02-15T11:00:00Z" },
        end: { dateTime: "2026-02-15T12:00:00Z" },
        all_day: false,
        status: "confirmed",
        visibility: "default",
        transparency: "opaque",
      },
      mirrors: [],
    });

    // Policy edge for projection
    userGraphDOState.policyEdgesByAccount.set(ACCOUNT_B.account_id, [
      {
        policy_id: POLICY_ID,
        from_account_id: ACCOUNT_B.account_id,
        to_account_id: ACCOUNT_A.account_id,
        detail_level: "BUSY",
        calendar_kind: "BUSY_OVERLAY",
      },
    ]);

    // No active mirrors for step 2c (or mock them as empty)
    userGraphDOState.activeMirrorsByAccount.set(ACCOUNT_A.account_id, []);

    const googleFetch = createReconcileGoogleApiFetch({
      eventPages: [
        { events: [managedMirror], nextSyncToken: TEST_SYNC_TOKEN },
      ],
    });

    const workflow = new ReconcileWorkflow(env, { fetchFn: googleFetch });
    const result = await workflow.run({
      account_id: ACCOUNT_A.account_id,
      reason: "scheduled",
    });

    // recomputeProjections called to correct the hash
    expect(userGraphDOState.recomputeProjectionsCalls).toHaveLength(1);
    expect(
      userGraphDOState.recomputeProjectionsCalls[0].canonical_event_id,
    ).toBe(CANONICAL_EVT_2);

    // Discrepancy recorded
    expect(result.hashMismatchesCorrected).toBe(1);
    const hashDisc = result.discrepancies.find(
      (d) => d.type === "hash_mismatch",
    );
    expect(hashDisc).toBeDefined();
    expect(hashDisc!.canonical_event_id).toBe(CANONICAL_EVT_2);
  });

  // -------------------------------------------------------------------------
  // AC 8: Stale mirrors tombstoned
  // -------------------------------------------------------------------------

  it("AC8: detects stale mirror and tombstones it", async () => {
    // Provider returns no managed mirrors -- but we have an ACTIVE mirror in state
    userGraphDOState.activeMirrorsByAccount.set(ACCOUNT_A.account_id, [
      {
        canonical_event_id: CANONICAL_EVT_3,
        target_account_id: ACCOUNT_A.account_id,
        target_calendar_id: "cal_overlay",
        provider_event_id: "google_evt_that_was_deleted",
        last_projected_hash: "some_hash",
        last_write_ts: "2026-02-13T00:00:00Z",
        state: "ACTIVE",
        error_message: null,
      },
    ]);

    // Provider returns empty -- no managed mirrors visible
    const googleFetch = createReconcileGoogleApiFetch({
      eventPages: [
        { events: [], nextSyncToken: TEST_SYNC_TOKEN },
      ],
    });

    const workflow = new ReconcileWorkflow(env, { fetchFn: googleFetch });
    const result = await workflow.run({
      account_id: ACCOUNT_A.account_id,
      reason: "scheduled",
    });

    // updateMirrorState called with TOMBSTONED
    expect(userGraphDOState.updateMirrorStateCalls).toHaveLength(1);
    expect(
      userGraphDOState.updateMirrorStateCalls[0].canonical_event_id,
    ).toBe(CANONICAL_EVT_3);
    expect(
      userGraphDOState.updateMirrorStateCalls[0].target_account_id,
    ).toBe(ACCOUNT_A.account_id);
    expect(userGraphDOState.updateMirrorStateCalls[0].update).toEqual({
      state: "TOMBSTONED",
    });

    // Discrepancy recorded
    expect(result.staleMirrorsTombstoned).toBe(1);
    const staleDisc = result.discrepancies.find(
      (d) => d.type === "stale_mirror",
    );
    expect(staleDisc).toBeDefined();
    expect(staleDisc!.canonical_event_id).toBe(CANONICAL_EVT_3);
  });

  // -------------------------------------------------------------------------
  // AC 9: All discrepancies logged to event_journal
  // -------------------------------------------------------------------------

  it("AC9: all discrepancies logged to event_journal via logReconcileDiscrepancy", async () => {
    // Set up multiple discrepancies: missing canonical + orphaned mirror
    const originEvent = makeOriginEvent({
      id: "evt_missing_can",
      summary: "Missing",
    });
    const orphanedMirror = makeManagedMirrorEvent(
      "evt_01HXYZ00000000000ORPHAN2",
      ACCOUNT_B.account_id,
      { id: "google_orphan_2" },
    );

    // No canonical for evt_missing_can (not in map)
    // No mirror row for orphaned mirror (not in map)

    // No active mirrors for step 2c
    userGraphDOState.activeMirrorsByAccount.set(ACCOUNT_A.account_id, []);

    const googleFetch = createReconcileGoogleApiFetch({
      eventPages: [
        {
          events: [originEvent, orphanedMirror],
          nextSyncToken: TEST_SYNC_TOKEN,
        },
      ],
    });

    const workflow = new ReconcileWorkflow(env, { fetchFn: googleFetch });
    const result = await workflow.run({
      account_id: ACCOUNT_A.account_id,
      reason: "drift_detected",
    });

    // Two discrepancies should be logged
    expect(result.discrepancies).toHaveLength(2);

    // logReconcileDiscrepancy called for each discrepancy
    expect(userGraphDOState.logReconcileDiscrepancyCalls).toHaveLength(2);

    // Check one is missing_canonical
    const missingLog = userGraphDOState.logReconcileDiscrepancyCalls.find(
      (c) => c.discrepancy_type === "missing_canonical",
    );
    expect(missingLog).toBeDefined();
    expect(missingLog!.details).toHaveProperty(
      "origin_event_id",
      "evt_missing_can",
    );

    // Check one is orphaned_mirror
    const orphanLog = userGraphDOState.logReconcileDiscrepancyCalls.find(
      (c) => c.discrepancy_type === "orphaned_mirror",
    );
    expect(orphanLog).toBeDefined();
    expect(orphanLog!.details).toHaveProperty(
      "provider_event_id",
      "google_orphan_2",
    );
  });

  // -------------------------------------------------------------------------
  // AC 10: AccountDO timestamps updated
  // -------------------------------------------------------------------------

  it("AC10: AccountDO timestamps updated after reconciliation", async () => {
    const googleFetch = createReconcileGoogleApiFetch({
      eventPages: [
        {
          events: [makeOriginEvent()],
          nextSyncToken: TEST_SYNC_TOKEN,
        },
      ],
    });

    // Canonical exists for the event (no drift)
    userGraphDOState.canonicalByOrigin.set(
      `${ACCOUNT_A.account_id}:google_evt_100`,
      {
        canonical_event_id: CANONICAL_EVT_1,
        origin_account_id: ACCOUNT_A.account_id,
        origin_event_id: "google_evt_100",
      },
    );
    userGraphDOState.policyEdgesByAccount.set(ACCOUNT_A.account_id, []);

    const workflow = new ReconcileWorkflow(env, { fetchFn: googleFetch });
    await workflow.run({
      account_id: ACCOUNT_A.account_id,
      reason: "scheduled",
    });

    // setSyncToken called with new sync token
    expect(accountDOState.setSyncTokenCalls).toEqual([TEST_SYNC_TOKEN]);

    // markSyncSuccess called
    expect(accountDOState.markSyncSuccessCalls).toHaveLength(1);
    expect(accountDOState.markSyncSuccessCalls[0].ts).toBeTruthy();
    // Verify the timestamp is a valid ISO date
    const ts = new Date(accountDOState.markSyncSuccessCalls[0].ts);
    expect(ts.getTime()).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Additional: clean reconciliation (no drift)
  // -------------------------------------------------------------------------

  it("clean reconciliation with no drift: zero discrepancies", async () => {
    const events = [
      makeOriginEvent({ id: "evt_clean_1", summary: "Clean 1" }),
      makeOriginEvent({ id: "evt_clean_2", summary: "Clean 2" }),
    ];

    // Both exist in canonical store
    userGraphDOState.canonicalByOrigin.set(
      `${ACCOUNT_A.account_id}:evt_clean_1`,
      {
        canonical_event_id: CANONICAL_EVT_1,
        origin_account_id: ACCOUNT_A.account_id,
        origin_event_id: "evt_clean_1",
      },
    );
    userGraphDOState.canonicalByOrigin.set(
      `${ACCOUNT_A.account_id}:evt_clean_2`,
      {
        canonical_event_id: CANONICAL_EVT_2,
        origin_account_id: ACCOUNT_A.account_id,
        origin_event_id: "evt_clean_2",
      },
    );

    // No policy edges -- no mirrors expected
    userGraphDOState.policyEdgesByAccount.set(ACCOUNT_A.account_id, []);

    // No active mirrors
    userGraphDOState.activeMirrorsByAccount.set(ACCOUNT_A.account_id, []);

    const googleFetch = createReconcileGoogleApiFetch({
      eventPages: [
        { events, nextSyncToken: TEST_SYNC_TOKEN },
      ],
    });

    const workflow = new ReconcileWorkflow(env, { fetchFn: googleFetch });
    const result = await workflow.run({
      account_id: ACCOUNT_A.account_id,
      reason: "scheduled",
    });

    expect(result.totalProviderEvents).toBe(2);
    expect(result.originEvents).toBe(2);
    expect(result.discrepancies).toHaveLength(0);
    expect(result.missingCanonicalsCreated).toBe(0);
    expect(result.missingMirrorsEnqueued).toBe(0);
    expect(result.orphanedMirrorsEnqueued).toBe(0);
    expect(result.hashMismatchesCorrected).toBe(0);
    expect(result.staleMirrorsTombstoned).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Additional: managed mirrors filtered from origin processing
  // -------------------------------------------------------------------------

  it("managed mirrors are classified separately and not treated as origins", async () => {
    const events = [
      makeOriginEvent({ id: "evt_origin_1", summary: "Origin" }),
      makeManagedMirrorEvent(CANONICAL_EVT_1, ACCOUNT_B.account_id, {
        id: "google_mirror_1",
      }),
    ];

    // Origin exists in canonical store
    userGraphDOState.canonicalByOrigin.set(
      `${ACCOUNT_A.account_id}:evt_origin_1`,
      {
        canonical_event_id: CANONICAL_EVT_1,
        origin_account_id: ACCOUNT_A.account_id,
        origin_event_id: "evt_origin_1",
      },
    );
    userGraphDOState.policyEdgesByAccount.set(ACCOUNT_A.account_id, []);

    // Mirror row exists for the managed mirror
    userGraphDOState.mirrorsByKey.set(
      `${CANONICAL_EVT_1}:${ACCOUNT_A.account_id}`,
      {
        canonical_event_id: CANONICAL_EVT_1,
        target_account_id: ACCOUNT_A.account_id,
        target_calendar_id: "cal_overlay",
        provider_event_id: "google_mirror_1",
        last_projected_hash: "correct_hash",
        last_write_ts: "2026-02-14T00:00:00Z",
        state: "ACTIVE",
        error_message: null,
      },
    );

    // Set up canonical event and edges for hash check
    userGraphDOState.canonicalEvents.set(CANONICAL_EVT_1, {
      event: {
        canonical_event_id: CANONICAL_EVT_1,
        origin_account_id: ACCOUNT_B.account_id,
        origin_event_id: "original_evt",
        title: "Team Meeting",
        start: { dateTime: "2026-02-15T11:00:00Z" },
        end: { dateTime: "2026-02-15T12:00:00Z" },
        all_day: false,
        status: "confirmed",
        visibility: "default",
        transparency: "opaque",
      },
      mirrors: [],
    });
    userGraphDOState.policyEdgesByAccount.set(ACCOUNT_B.account_id, [
      {
        policy_id: POLICY_ID,
        from_account_id: ACCOUNT_B.account_id,
        to_account_id: ACCOUNT_A.account_id,
        detail_level: "BUSY",
        calendar_kind: "BUSY_OVERLAY",
      },
    ]);

    // Active mirrors include google_mirror_1 -- it IS in provider, so no stale
    userGraphDOState.activeMirrorsByAccount.set(ACCOUNT_A.account_id, [
      {
        canonical_event_id: CANONICAL_EVT_1,
        target_account_id: ACCOUNT_A.account_id,
        target_calendar_id: "cal_overlay",
        provider_event_id: "google_mirror_1",
        last_projected_hash: "correct_hash",
        state: "ACTIVE",
      },
    ]);

    const googleFetch = createReconcileGoogleApiFetch({
      eventPages: [
        { events, nextSyncToken: TEST_SYNC_TOKEN },
      ],
    });

    const workflow = new ReconcileWorkflow(env, { fetchFn: googleFetch });
    const result = await workflow.run({
      account_id: ACCOUNT_A.account_id,
      reason: "scheduled",
    });

    expect(result.totalProviderEvents).toBe(2);
    expect(result.originEvents).toBe(1);
    expect(result.managedMirrors).toBe(1);

    // applyProviderDelta should NOT have been called (origin exists)
    expect(userGraphDOState.applyDeltaCalls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Additional: missing user_id throws meaningful error
  // -------------------------------------------------------------------------

  it("throws when user_id cannot be found for account", async () => {
    // Remove the account from D1
    db.prepare("DELETE FROM accounts WHERE account_id = ?").run(
      ACCOUNT_A.account_id,
    );

    const googleFetch = createReconcileGoogleApiFetch({});
    const workflow = new ReconcileWorkflow(env, { fetchFn: googleFetch });

    await expect(
      workflow.run({
        account_id: ACCOUNT_A.account_id,
        reason: "scheduled",
      }),
    ).rejects.toThrow(/no user_id found/);
  });

  // -------------------------------------------------------------------------
  // Additional: empty provider -- only stale mirror check runs
  // -------------------------------------------------------------------------

  it("empty provider with stale active mirror: tombstones correctly", async () => {
    // Provider returns empty
    userGraphDOState.activeMirrorsByAccount.set(ACCOUNT_A.account_id, [
      {
        canonical_event_id: CANONICAL_EVT_1,
        target_account_id: ACCOUNT_A.account_id,
        target_calendar_id: "cal_overlay",
        provider_event_id: "ghost_provider_evt",
        last_projected_hash: "hash",
        state: "ACTIVE",
      },
    ]);

    const googleFetch = createReconcileGoogleApiFetch({
      eventPages: [
        { events: [], nextSyncToken: TEST_SYNC_TOKEN },
      ],
    });

    const workflow = new ReconcileWorkflow(env, { fetchFn: googleFetch });
    const result = await workflow.run({
      account_id: ACCOUNT_A.account_id,
      reason: "scheduled",
    });

    expect(result.totalProviderEvents).toBe(0);
    expect(result.staleMirrorsTombstoned).toBe(1);
    expect(userGraphDOState.updateMirrorStateCalls).toHaveLength(1);
    expect(userGraphDOState.updateMirrorStateCalls[0].update).toEqual({
      state: "TOMBSTONED",
    });
  });
});
