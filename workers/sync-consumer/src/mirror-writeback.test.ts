/**
 * TM-9eu: Unit tests for mirror-side modification writeback.
 *
 * Tests the mirror writeback logic in isolation:
 * - Modified mirror -> canonical updated via applyProviderDelta
 * - Deleted mirror -> existing delete path (not writeback)
 * - Orphaned mirror -> graceful skip with warning
 * - Multiple mirrors from different origin accounts -> grouped correctly
 *
 * DO calls are mocked at the fetch boundary.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { MIGRATION_0001_INITIAL_SCHEMA } from "@tminus/d1-registry";
import { handleIncrementalSync } from "./index";
import type { SyncIncrementalMessage } from "@tminus/shared";
import type { AccountId } from "@tminus/shared";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_ORG = {
  org_id: "org_01HXYZ00000000000000000001",
  name: "Mirror Writeback Test Org",
} as const;

const TEST_USER = {
  user_id: "usr_01HXYZ00000000000000000001",
  org_id: TEST_ORG.org_id,
  email: "mirrortest@example.com",
} as const;

const ACCOUNT_A = {
  account_id: "acc_01HXYZ0000000000000000000A" as AccountId,
  user_id: TEST_USER.user_id,
  provider: "google",
  provider_subject: "google-sub-mirror-a",
  email: "alice@gmail.com",
} as const;

const ORIGIN_ACCOUNT_ID = "acc_01HXYZ0000000000000000000B";
const CANONICAL_EVENT_ID = "evt_01HXYZ00000000000000MIRROR";
const ORIGIN_EVENT_ID = "google_evt_origin_canonical_100";

const TEST_ACCESS_TOKEN = "ya29.test-access-token-mirror";
const TEST_SYNC_TOKEN = "sync-token-mirror-old";
const NEW_SYNC_TOKEN = "sync-token-mirror-new";

const noopSleep = async (_ms: number): Promise<void> => {};

// ---------------------------------------------------------------------------
// Event factories
// ---------------------------------------------------------------------------

function makeManagedMirrorEvent(overrides?: Record<string, unknown>) {
  return {
    id: "google_evt_mirror_wb_100",
    summary: "Mirrored Meeting",
    description: "A mirrored event",
    location: "Room 101",
    start: { dateTime: "2026-02-20T10:00:00Z" },
    end: { dateTime: "2026-02-20T11:00:00Z" },
    status: "confirmed",
    visibility: "default",
    transparency: "opaque",
    extendedProperties: {
      private: {
        tminus: "true",
        managed: "true",
        canonical_event_id: CANONICAL_EVENT_ID,
        origin_account_id: ORIGIN_ACCOUNT_ID,
      },
    },
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
// Mock helpers
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

interface DOCallTracker {
  applyDeltaCalls: Array<{ account_id: string; deltas: unknown[] }>;
  findCanonicalByMirrorCalls: Array<{
    target_account_id: string;
    provider_event_id: string;
  }>;
  getCanonicalEventCalls: Array<{ canonical_event_id: string }>;
  deleteCanonicalCalls: Array<{ canonical_event_id: string; source: string }>;
}

function createMockEnv(options: {
  d1: D1Database;
  mirrorLookup: Record<string, string>;
  canonicalEvents: Record<string, { event: Record<string, unknown>; mirrors: unknown[] }>;
  tracker: DOCallTracker;
}): Env {
  const { mirrorLookup, canonicalEvents, tracker } = options;

  const accountStub = {
    fetch: async (request: Request): Promise<Response> => {
      const url = new URL(request.url);
      const path = url.pathname;

      if (path === "/getAccessToken") {
        return new Response(
          JSON.stringify({ access_token: TEST_ACCESS_TOKEN }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (path === "/getSyncToken") {
        return new Response(
          JSON.stringify({ sync_token: TEST_SYNC_TOKEN }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (path === "/setSyncToken") {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (path === "/listCalendarScopes") {
        return new Response(
          JSON.stringify({
            scopes: [{ providerCalendarId: "primary", enabled: true, syncEnabled: true }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (path === "/getScopedSyncToken") {
        return new Response(
          JSON.stringify({ sync_token: TEST_SYNC_TOKEN }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (path === "/setScopedSyncToken") {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (path === "/markSyncSuccess") {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (path === "/markSyncFailure") {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not found", { status: 404 });
    },
  };

  const userGraphStub = {
    fetch: async (request: Request): Promise<Response> => {
      const url = new URL(request.url);

      if (url.pathname === "/applyProviderDelta") {
        const body = (await request.json()) as { account_id: string; deltas: unknown[] };
        tracker.applyDeltaCalls.push(body);
        return new Response(
          JSON.stringify({
            created: 0,
            updated: body.deltas.length,
            deleted: 0,
            mirrors_enqueued: 0,
            errors: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.pathname === "/findCanonicalByMirror") {
        const body = (await request.json()) as {
          target_account_id: string;
          provider_event_id: string;
        };
        tracker.findCanonicalByMirrorCalls.push(body);
        return new Response(
          JSON.stringify({
            canonical_event_id: mirrorLookup[body.provider_event_id] ?? null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.pathname === "/getCanonicalEvent") {
        const body = (await request.json()) as { canonical_event_id: string };
        tracker.getCanonicalEventCalls.push(body);
        const result = canonicalEvents[body.canonical_event_id] ?? null;
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.pathname === "/deleteCanonicalEvent") {
        const body = (await request.json()) as {
          canonical_event_id: string;
          source: string;
        };
        tracker.deleteCanonicalCalls.push(body);
        return new Response(JSON.stringify(true), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.pathname === "/getActiveMirrors") {
        return new Response(
          JSON.stringify({ mirrors: [] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response("Not found", { status: 404 });
    },
  };

  return {
    DB: options.d1,
    SYNC_QUEUE: createMockQueue(),
    WRITE_QUEUE: createMockQueue(),
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

function createGoogleApiFetch(options: {
  events?: unknown[];
  nextSyncToken?: string;
}) {
  return async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (url.includes("/calendars/") && url.includes("/events")) {
      return new Response(
        JSON.stringify({
          items: options.events ?? [],
          nextSyncToken: options.nextSyncToken,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("Not found", { status: 404 });
  };
}

// ---------------------------------------------------------------------------
// Unit tests: Mirror writeback logic
// ---------------------------------------------------------------------------

describe("TM-9eu: Mirror-side modification writeback", () => {
  let db: DatabaseType;
  let tracker: DOCallTracker;

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

    tracker = {
      applyDeltaCalls: [],
      findCanonicalByMirrorCalls: [],
      getCanonicalEventCalls: [],
      deleteCanonicalCalls: [],
    };
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it("writes back modified mirror event fields to canonical via applyProviderDelta", async () => {
    const env = createMockEnv({
      d1: createRealD1(db),
      mirrorLookup: {
        google_evt_mirror_wb_100: CANONICAL_EVENT_ID,
      },
      canonicalEvents: {
        [CANONICAL_EVENT_ID]: {
          event: {
            origin_account_id: ORIGIN_ACCOUNT_ID,
            origin_event_id: ORIGIN_EVENT_ID,
          },
          mirrors: [],
        },
      },
      tracker,
    });

    const googleFetch = createGoogleApiFetch({
      events: [
        makeManagedMirrorEvent({
          summary: "User Changed Title",
          location: "New Building",
          description: "User added notes",
        }),
      ],
      nextSyncToken: NEW_SYNC_TOKEN,
    });

    const message: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: ACCOUNT_A.account_id,
      channel_id: "ch-wb-1",
      resource_id: "res-wb-1",
      ping_ts: new Date().toISOString(),
      calendar_id: null,
    };

    await handleIncrementalSync(message, env, { fetchFn: googleFetch, sleepFn: noopSleep });

    // Verify DO interactions
    expect(tracker.findCanonicalByMirrorCalls).toHaveLength(1);
    expect(tracker.findCanonicalByMirrorCalls[0].provider_event_id).toBe("google_evt_mirror_wb_100");

    expect(tracker.getCanonicalEventCalls).toHaveLength(1);
    expect(tracker.getCanonicalEventCalls[0].canonical_event_id).toBe(CANONICAL_EVENT_ID);

    // The writeback should produce exactly one applyProviderDelta call
    expect(tracker.applyDeltaCalls).toHaveLength(1);
    const call = tracker.applyDeltaCalls[0];
    expect(call.account_id).toBe(ORIGIN_ACCOUNT_ID);

    const delta = call.deltas[0] as Record<string, unknown>;
    expect(delta.type).toBe("updated");
    expect(delta.origin_event_id).toBe(ORIGIN_EVENT_ID);
    expect(delta.origin_account_id).toBe(ORIGIN_ACCOUNT_ID);

    // Verify the event payload has the modified fields
    const evt = delta.event as Record<string, unknown>;
    expect(evt.title).toBe("User Changed Title");
    expect(evt.location).toBe("New Building");
    expect(evt.description).toBe("User added notes");

    // No deletes should occur
    expect(tracker.deleteCanonicalCalls).toHaveLength(0);
  });

  it("skips writeback when mirror update is a no-op against canonical payload", async () => {
    const env = createMockEnv({
      d1: createRealD1(db),
      mirrorLookup: {
        google_evt_mirror_wb_100: CANONICAL_EVENT_ID,
      },
      canonicalEvents: {
        [CANONICAL_EVENT_ID]: {
          event: {
            origin_account_id: ORIGIN_ACCOUNT_ID,
            origin_event_id: ORIGIN_EVENT_ID,
            title: "Mirrored Meeting",
            description: "A mirrored event",
            location: "Room 101",
            start: { dateTime: "2026-02-20T10:00:00Z" },
            end: { dateTime: "2026-02-20T11:00:00Z" },
            all_day: false,
            status: "confirmed",
            visibility: "default",
            transparency: "opaque",
          },
          mirrors: [],
        },
      },
      tracker,
    });

    const googleFetch = createGoogleApiFetch({
      events: [makeManagedMirrorEvent()],
      nextSyncToken: NEW_SYNC_TOKEN,
    });

    const message: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: ACCOUNT_A.account_id,
      channel_id: "ch-noop-1",
      resource_id: "res-noop-1",
      ping_ts: new Date().toISOString(),
      calendar_id: null,
    };

    await handleIncrementalSync(message, env, { fetchFn: googleFetch, sleepFn: noopSleep });

    expect(tracker.findCanonicalByMirrorCalls).toHaveLength(1);
    expect(tracker.getCanonicalEventCalls).toHaveLength(1);
    expect(tracker.applyDeltaCalls).toHaveLength(0);
    expect(tracker.deleteCanonicalCalls).toHaveLength(0);
  });

  it("skips orphaned mirrors gracefully when findCanonicalByMirror returns null", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const env = createMockEnv({
      d1: createRealD1(db),
      mirrorLookup: {}, // No canonical mapping
      canonicalEvents: {},
      tracker,
    });

    const googleFetch = createGoogleApiFetch({
      events: [makeManagedMirrorEvent({ summary: "Orphaned Edit" })],
      nextSyncToken: NEW_SYNC_TOKEN,
    });

    const message: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: ACCOUNT_A.account_id,
      channel_id: "ch-orphan-1",
      resource_id: "res-orphan-1",
      ping_ts: new Date().toISOString(),
      calendar_id: null,
    };

    await handleIncrementalSync(message, env, { fetchFn: googleFetch, sleepFn: noopSleep });

    // findCanonicalByMirror was called but returned null
    expect(tracker.findCanonicalByMirrorCalls).toHaveLength(1);
    // No further DO calls
    expect(tracker.getCanonicalEventCalls).toHaveLength(0);
    expect(tracker.applyDeltaCalls).toHaveLength(0);
    expect(tracker.deleteCanonicalCalls).toHaveLength(0);

    // Warning was logged
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("mirror writeback skipped, orphaned mirror"),
    );

    warnSpy.mockRestore();
  });

  it("does not trigger writeback for deleted mirrors (preserves existing delete path)", async () => {
    const env = createMockEnv({
      d1: createRealD1(db),
      mirrorLookup: {
        google_evt_mirror_wb_100: CANONICAL_EVENT_ID,
      },
      canonicalEvents: {},
      tracker,
    });

    const googleFetch = createGoogleApiFetch({
      events: [makeManagedMirrorEvent({ status: "cancelled" })],
      nextSyncToken: NEW_SYNC_TOKEN,
    });

    const message: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: ACCOUNT_A.account_id,
      channel_id: "ch-delete-1",
      resource_id: "res-delete-1",
      ping_ts: new Date().toISOString(),
      calendar_id: null,
    };

    await handleIncrementalSync(message, env, { fetchFn: googleFetch, sleepFn: noopSleep });

    // Delete path: findCanonicalByMirror + deleteCanonicalEvent
    expect(tracker.findCanonicalByMirrorCalls).toHaveLength(1);
    expect(tracker.deleteCanonicalCalls).toHaveLength(1);
    expect(tracker.deleteCanonicalCalls[0].canonical_event_id).toBe(CANONICAL_EVENT_ID);

    // No writeback path (no getCanonicalEvent, no applyProviderDelta)
    expect(tracker.getCanonicalEventCalls).toHaveLength(0);
    expect(tracker.applyDeltaCalls).toHaveLength(0);
  });

  it("emits console.info audit log for each mirror writeback", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const env = createMockEnv({
      d1: createRealD1(db),
      mirrorLookup: {
        google_evt_mirror_wb_100: CANONICAL_EVENT_ID,
      },
      canonicalEvents: {
        [CANONICAL_EVENT_ID]: {
          event: {
            origin_account_id: ORIGIN_ACCOUNT_ID,
            origin_event_id: ORIGIN_EVENT_ID,
          },
          mirrors: [],
        },
      },
      tracker,
    });

    const googleFetch = createGoogleApiFetch({
      events: [makeManagedMirrorEvent({ summary: "Audit Test" })],
      nextSyncToken: NEW_SYNC_TOKEN,
    });

    const message: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: ACCOUNT_A.account_id,
      channel_id: "ch-audit-1",
      resource_id: "res-audit-1",
      ping_ts: new Date().toISOString(),
      calendar_id: null,
    };

    await handleIncrementalSync(message, env, { fetchFn: googleFetch, sleepFn: noopSleep });

    // Verify audit log was emitted
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("mirror_writeback"),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining(CANONICAL_EVENT_ID),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining(ORIGIN_ACCOUNT_ID),
    );

    infoSpy.mockRestore();
  });

  it("handles mix of origin events and modified mirrors in the same sync batch", async () => {
    const env = createMockEnv({
      d1: createRealD1(db),
      mirrorLookup: {
        google_evt_mirror_wb_100: CANONICAL_EVENT_ID,
      },
      canonicalEvents: {
        [CANONICAL_EVENT_ID]: {
          event: {
            origin_account_id: ORIGIN_ACCOUNT_ID,
            origin_event_id: ORIGIN_EVENT_ID,
          },
          mirrors: [],
        },
      },
      tracker,
    });

    const googleFetch = createGoogleApiFetch({
      events: [
        // Origin event (normal processing)
        {
          id: "google_evt_origin_500",
          summary: "Real Origin Event",
          start: { dateTime: "2026-02-20T14:00:00Z" },
          end: { dateTime: "2026-02-20T15:00:00Z" },
          status: "confirmed",
        },
        // Managed mirror (writeback)
        makeManagedMirrorEvent({ summary: "Mirror Modified" }),
      ],
      nextSyncToken: NEW_SYNC_TOKEN,
    });

    const message: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: ACCOUNT_A.account_id,
      channel_id: "ch-mix-1",
      resource_id: "res-mix-1",
      ping_ts: new Date().toISOString(),
      calendar_id: null,
    };

    await handleIncrementalSync(message, env, { fetchFn: googleFetch, sleepFn: noopSleep });

    // Two applyProviderDelta calls:
    // 1. Origin event (account_id = ACCOUNT_A)
    // 2. Mirror writeback (account_id = ORIGIN_ACCOUNT_ID)
    expect(tracker.applyDeltaCalls).toHaveLength(2);

    // First call: origin event
    expect(tracker.applyDeltaCalls[0].account_id).toBe(ACCOUNT_A.account_id);
    expect(tracker.applyDeltaCalls[0].deltas).toHaveLength(1);
    const originDelta = tracker.applyDeltaCalls[0].deltas[0] as Record<string, unknown>;
    expect(originDelta.origin_event_id).toBe("google_evt_origin_500");

    // Second call: mirror writeback with canonical's origin keys
    expect(tracker.applyDeltaCalls[1].account_id).toBe(ORIGIN_ACCOUNT_ID);
    expect(tracker.applyDeltaCalls[1].deltas).toHaveLength(1);
    const writebackDelta = tracker.applyDeltaCalls[1].deltas[0] as Record<string, unknown>;
    expect(writebackDelta.origin_event_id).toBe(ORIGIN_EVENT_ID);
    expect(writebackDelta.type).toBe("updated");
  });
});
