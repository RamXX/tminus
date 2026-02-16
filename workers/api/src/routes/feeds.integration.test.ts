/**
 * Integration tests for ICS feed import endpoints.
 *
 * Uses the full API handler flow: createHandler() -> fetch() -> response,
 * with real D1 (better-sqlite3) and mock DO stubs.
 *
 * Proves:
 * - POST /v1/feeds creates a feed account in D1 and stores events via DO
 * - GET /v1/feeds lists feed accounts for the authenticated user
 * - Imported events appear in GET /v1/events response
 * - Feed-sourced events include the ics_feed source marker
 * - Error handling for invalid URLs, empty feeds, fetch failures
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import {
  MIGRATION_0001_INITIAL_SCHEMA,
  MIGRATION_0012_SUBSCRIPTIONS,
  MIGRATION_0013_SUBSCRIPTION_LIFECYCLE,
} from "@tminus/d1-registry";
import { createHandler, createJwt } from "../index";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const JWT_SECRET = "ics-feed-integration-test-secret-32chars";

const TEST_ORG = {
  org_id: "org_01HXY000000000000000000001",
  name: "Feed Test Org",
} as const;

const TEST_USER = {
  user_id: "usr_01HXY000000000000000000F01",
  org_id: TEST_ORG.org_id,
  email: "feedtest@example.com",
} as const;

// ---------------------------------------------------------------------------
// ICS fixtures
// ---------------------------------------------------------------------------

const VALID_ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Google Inc//Google Calendar 70.9054//EN
BEGIN:VEVENT
UID:event-alpha@google.com
DTSTART:20260315T100000Z
DTEND:20260315T110000Z
SUMMARY:Alpha Meeting
DESCRIPTION:First meeting of the day
LOCATION:Building A
STATUS:CONFIRMED
END:VEVENT
BEGIN:VEVENT
UID:event-beta@google.com
DTSTART:20260316T140000Z
DTEND:20260316T150000Z
SUMMARY:Beta Review
STATUS:TENTATIVE
END:VEVENT
BEGIN:VEVENT
UID:event-gamma@google.com
DTSTART;VALUE=DATE:20260320
DTEND;VALUE=DATE:20260321
SUMMARY:Company Holiday
TRANSP:TRANSPARENT
END:VEVENT
END:VCALENDAR`;

const EMPTY_ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
END:VCALENDAR`;

// ---------------------------------------------------------------------------
// D1 mock backed by better-sqlite3
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
// Mock DO namespace: captures calls and returns configured responses
// ---------------------------------------------------------------------------

interface DOCallRecord {
  name: string;
  path: string;
  method: string;
  body?: unknown;
}

/** Path response config: either a plain data object (returns 200) or explicit status+data. */
interface PathResponseConfig {
  status: number;
  data: unknown;
}

function createMockDONamespace(config?: {
  defaultResponse?: unknown;
  pathResponses?: Map<string, unknown | PathResponseConfig>;
}): DurableObjectNamespace & { calls: DOCallRecord[] } {
  const calls: DOCallRecord[] = [];
  const defaultResp = config?.defaultResponse ?? { ok: true };

  function resolveResponse(pathData: unknown | PathResponseConfig | undefined): { status: number; body: unknown } {
    if (pathData === undefined) {
      return { status: 200, body: defaultResp };
    }
    // Check if it's a PathResponseConfig (has status and data properties)
    if (
      typeof pathData === "object" &&
      pathData !== null &&
      "status" in pathData &&
      "data" in pathData &&
      typeof (pathData as PathResponseConfig).status === "number"
    ) {
      const prc = pathData as PathResponseConfig;
      return { status: prc.status, body: prc.data };
    }
    return { status: 200, body: pathData };
  }

  return {
    calls,
    idFromName(name: string): DurableObjectId {
      return {
        toString: () => name,
        name,
        equals: () => false,
      } as unknown as DurableObjectId;
    },
    get(_id: DurableObjectId): DurableObjectStub {
      const doName = _id.toString();
      return {
        async fetch(
          input: RequestInfo | URL,
          init?: RequestInit,
        ): Promise<Response> {
          const url =
            typeof input === "string"
              ? new URL(input)
              : input instanceof URL
                ? input
                : new URL(input.url);
          const method =
            init?.method ??
            (typeof input === "object" && "method" in input
              ? input.method
              : "GET");

          let parsedBody: unknown;
          if (init?.body) {
            try {
              parsedBody = JSON.parse(init.body as string);
            } catch {
              parsedBody = init.body;
            }
          }

          calls.push({ name: doName, path: url.pathname, method, body: parsedBody });

          const pathData = config?.pathResponses?.get(url.pathname);
          const resolved = resolveResponse(pathData);

          return new Response(JSON.stringify(resolved.body), {
            status: resolved.status,
            headers: { "Content-Type": "application/json" },
          });
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
// Other mocks
// ---------------------------------------------------------------------------

function createMockQueue(): Queue & { messages: unknown[] } {
  const messages: unknown[] = [];
  return {
    messages,
    async send(msg: unknown) { messages.push(msg); },
    async sendBatch(_msgs: Iterable<MessageSendRequest>) {},
  } as unknown as Queue & { messages: unknown[] };
}

function createMockKV(): KVNamespace {
  const store = new Map<string, { value: string; expiration?: number }>();
  return {
    store,
    async get(key: string): Promise<string | null> {
      const entry = store.get(key);
      if (!entry) return null;
      return entry.value;
    },
    async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
      const expiration = opts?.expirationTtl
        ? Math.floor(Date.now() / 1000) + opts.expirationTtl
        : undefined;
      store.set(key, { value, expiration });
    },
    async delete(key: string): Promise<void> { store.delete(key); },
    async list(): Promise<{ keys: Array<{ name: string }>; list_complete: boolean }> {
      return { keys: Array.from(store.keys()).map((name) => ({ name })), list_complete: true };
    },
    async getWithMetadata(): Promise<{ value: string | null; metadata: unknown }> {
      return { value: null, metadata: null };
    },
  } as unknown as KVNamespace;
}

// ---------------------------------------------------------------------------
// JWT helper
// ---------------------------------------------------------------------------

async function makeAuthHeader(userId?: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const token = await createJwt(
    { sub: userId ?? TEST_USER.user_id, iat: now, exp: now + 3600 },
    JWT_SECRET,
  );
  return `Bearer ${token}`;
}

// ---------------------------------------------------------------------------
// Env builder
// ---------------------------------------------------------------------------

function buildEnv(
  d1: D1Database,
  userGraphDO?: DurableObjectNamespace,
  accountDO?: DurableObjectNamespace,
): Env {
  return {
    DB: d1,
    USER_GRAPH: userGraphDO ?? createMockDONamespace(),
    ACCOUNT: accountDO ?? createMockDONamespace(),
    SYNC_QUEUE: createMockQueue(),
    WRITE_QUEUE: createMockQueue(),
    SESSIONS: createMockKV(),
    JWT_SECRET,
    RATE_LIMITS: createMockKV(),
  };
}

const mockCtx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

// ---------------------------------------------------------------------------
// Global fetch interception for ICS feed fetching
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ===========================================================================
// Integration test suites
// ===========================================================================

describe("Integration: ICS Feed Import (Phase 6C)", () => {
  let db: DatabaseType;
  let d1: D1Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(MIGRATION_0001_INITIAL_SCHEMA);
    db.exec(MIGRATION_0012_SUBSCRIPTIONS);
    db.exec(MIGRATION_0013_SUBSCRIPTION_LIFECYCLE);
    // Seed org and user
    db.prepare("INSERT INTO orgs (org_id, name) VALUES (?, ?)").run(
      TEST_ORG.org_id,
      TEST_ORG.name,
    );
    db.prepare(
      "INSERT INTO users (user_id, org_id, email) VALUES (?, ?, ?)",
    ).run(TEST_USER.user_id, TEST_USER.org_id, TEST_USER.email);
    d1 = createRealD1(db);
  });

  afterEach(() => {
    db.close();
  });

  // -------------------------------------------------------------------------
  // POST /v1/feeds -- successful import
  // -------------------------------------------------------------------------

  it("POST /v1/feeds imports events from a valid ICS URL and creates feed account in D1", async () => {
    // Mock external ICS fetch
    globalThis.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("calendar.google.com")) {
        return new Response(VALID_ICS, {
          status: 200,
          headers: { "Content-Type": "text/calendar" },
        });
      }
      // Pass through to original fetch for DO calls
      return originalFetch(input, init);
    });

    const applyResult = {
      created: 3,
      updated: 0,
      deleted: 0,
      mirrors_enqueued: 0,
      errors: [],
    };
    const pathResponses = new Map<string, unknown>();
    pathResponses.set("/applyProviderDelta", applyResult);

    const userGraphDO = createMockDONamespace({ pathResponses });

    const handler = createHandler();
    const env = buildEnv(d1, userGraphDO);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request("https://api.tminus.dev/v1/feeds", {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          url: "https://calendar.google.com/calendar/ical/example/public/basic.ics",
        }),
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(201);
    const body = await response.json() as {
      ok: boolean;
      data: {
        account_id: string;
        feed_url: string;
        events_imported: number;
        date_range: { earliest: string; latest: string };
      };
    };
    expect(body.ok).toBe(true);
    expect(body.data.events_imported).toBe(3);
    expect(body.data.feed_url).toBe(
      "https://calendar.google.com/calendar/ical/example/public/basic.ics",
    );
    expect(body.data.account_id).toMatch(/^acc_/);
    expect(body.data.date_range.earliest).toBeDefined();
    expect(body.data.date_range.latest).toBeDefined();

    // Verify feed account was created in D1
    const accountRow = db.prepare(
      "SELECT * FROM accounts WHERE account_id = ?",
    ).get(body.data.account_id) as { provider: string; user_id: string; status: string } | null;
    expect(accountRow).not.toBeNull();
    expect(accountRow!.provider).toBe("ics_feed");
    expect(accountRow!.user_id).toBe(TEST_USER.user_id);
    expect(accountRow!.status).toBe("active");

    // Verify DO was called with applyProviderDelta
    expect(userGraphDO.calls).toHaveLength(1);
    expect(userGraphDO.calls[0].path).toBe("/applyProviderDelta");
    expect(userGraphDO.calls[0].method).toBe("POST");

    const doBody = userGraphDO.calls[0].body as {
      account_id: string;
      deltas: Array<{ type: string; origin_event_id: string; event: { title: string } }>;
    };
    expect(doBody.deltas).toHaveLength(3);
    expect(doBody.deltas[0].type).toBe("created");
    expect(doBody.deltas[0].event.title).toBe("Alpha Meeting");
  });

  // -------------------------------------------------------------------------
  // POST /v1/feeds -- validation errors
  // -------------------------------------------------------------------------

  it("POST /v1/feeds returns 400 for HTTP URL", async () => {
    const handler = createHandler();
    const env = buildEnv(d1);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request("https://api.tminus.dev/v1/feeds", {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url: "http://insecure.com/cal.ics" }),
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(400);
    const body = await response.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("HTTPS");
  });

  it("POST /v1/feeds returns 502 when remote ICS fetch fails", async () => {
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      return new Response("Service Unavailable", { status: 503 });
    });

    const handler = createHandler();
    const env = buildEnv(d1);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request("https://api.tminus.dev/v1/feeds", {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url: "https://example.com/broken.ics" }),
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(502);
  });

  it("POST /v1/feeds returns 422 when ICS has no events", async () => {
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      return new Response(EMPTY_ICS, {
        status: 200,
        headers: { "Content-Type": "text/calendar" },
      });
    });

    const handler = createHandler();
    const env = buildEnv(d1);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request("https://api.tminus.dev/v1/feeds", {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url: "https://example.com/empty.ics" }),
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(422);
    const body = await response.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("No events");
  });

  it("POST /v1/feeds returns 401 without auth token", async () => {
    const handler = createHandler();
    const env = buildEnv(d1);

    const response = await handler.fetch(
      new Request("https://api.tminus.dev/v1/feeds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/cal.ics" }),
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // GET /v1/feeds -- list feed accounts
  // -------------------------------------------------------------------------

  it("GET /v1/feeds returns empty array when user has no feeds", async () => {
    const handler = createHandler();
    const env = buildEnv(d1);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request("https://api.tminus.dev/v1/feeds", {
        method: "GET",
        headers: { Authorization: authHeader },
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; data: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.data).toEqual([]);
  });

  it("GET /v1/feeds returns feed accounts after import", async () => {
    // Manually insert a feed account to simulate a prior import
    db.prepare(
      `INSERT INTO accounts (account_id, user_id, provider, provider_subject, email, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      "acc_01HXY0000000000000000FEED1",
      TEST_USER.user_id,
      "ics_feed",
      "https://cal.example.com/feed.ics",
      "https://cal.example.com/feed.ics",
      "active",
    );

    const handler = createHandler();
    const env = buildEnv(d1);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request("https://api.tminus.dev/v1/feeds", {
        method: "GET",
        headers: { Authorization: authHeader },
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as {
      ok: boolean;
      data: Array<{ account_id: string; provider: string; feed_url: string }>;
    };
    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].account_id).toBe("acc_01HXY0000000000000000FEED1");
    expect(body.data[0].provider).toBe("ics_feed");
    expect(body.data[0].feed_url).toBe("https://cal.example.com/feed.ics");
  });

  // -------------------------------------------------------------------------
  // Imported events appear in GET /v1/events
  // -------------------------------------------------------------------------

  it("imported feed events are returned by GET /v1/events via DO", async () => {
    // Mock fetch for ICS
    globalThis.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("calendar.google.com")) {
        return new Response(VALID_ICS, {
          status: 200,
          headers: { "Content-Type": "text/calendar" },
        });
      }
      return originalFetch(input, init);
    });

    // The DO returns feed events when queried
    const feedEvents = [
      {
        canonical_event_id: "evt_01TEST00000000000000001",
        origin_account_id: "acc_feed_test",
        origin_event_id: "event-alpha@google.com",
        title: "Alpha Meeting",
        start_ts: "2026-03-15T10:00:00Z",
        end_ts: "2026-03-15T11:00:00Z",
        source: "ics_feed",
        all_day: false,
        status: "confirmed",
        visibility: "default",
        transparency: "opaque",
      },
      {
        canonical_event_id: "evt_01TEST00000000000000002",
        origin_account_id: "acc_feed_test",
        origin_event_id: "event-beta@google.com",
        title: "Beta Review",
        start_ts: "2026-03-16T14:00:00Z",
        end_ts: "2026-03-16T15:00:00Z",
        source: "ics_feed",
        all_day: false,
        status: "tentative",
        visibility: "default",
        transparency: "opaque",
      },
    ];

    const pathResponses = new Map<string, unknown>();
    pathResponses.set("/applyProviderDelta", {
      created: 3,
      updated: 0,
      deleted: 0,
      mirrors_enqueued: 0,
      errors: [],
    });
    pathResponses.set("/listCanonicalEvents", {
      items: feedEvents,
      cursor: null,
      has_more: false,
    });

    const userGraphDO = createMockDONamespace({ pathResponses });

    const handler = createHandler();
    const env = buildEnv(d1, userGraphDO);
    const authHeader = await makeAuthHeader();

    // Step 1: Import the feed
    const importResp = await handler.fetch(
      new Request("https://api.tminus.dev/v1/feeds", {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          url: "https://calendar.google.com/calendar/ical/test/public/basic.ics",
        }),
      }),
      env,
      mockCtx,
    );
    expect(importResp.status).toBe(201);

    // Step 2: Verify events appear in the events list
    const eventsResp = await handler.fetch(
      new Request("https://api.tminus.dev/v1/events", {
        method: "GET",
        headers: { Authorization: authHeader },
      }),
      env,
      mockCtx,
    );

    expect(eventsResp.status).toBe(200);
    const eventsBody = await eventsResp.json() as {
      ok: boolean;
      data: Array<{ title: string; source: string }>;
    };
    expect(eventsBody.ok).toBe(true);
    expect(eventsBody.data).toHaveLength(2);

    // Verify feed-sourced events have ics_feed source
    const feedSourced = eventsBody.data.filter(
      (e) => e.source === "ics_feed",
    );
    expect(feedSourced).toHaveLength(2);
    expect(feedSourced.map((e) => e.title).sort()).toEqual([
      "Alpha Meeting",
      "Beta Review",
    ]);
  });

  // -------------------------------------------------------------------------
  // Feed events are visually distinguishable (source field)
  // -------------------------------------------------------------------------

  it("feed events have 'ics_feed' source to distinguish from synced events", async () => {
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      return new Response(VALID_ICS, {
        status: 200,
        headers: { "Content-Type": "text/calendar" },
      });
    });

    const pathResponses = new Map<string, unknown>();
    pathResponses.set("/applyProviderDelta", {
      created: 3, updated: 0, deleted: 0, mirrors_enqueued: 0, errors: [],
    });

    const userGraphDO = createMockDONamespace({ pathResponses });
    const handler = createHandler();
    const env = buildEnv(d1, userGraphDO);
    const authHeader = await makeAuthHeader();

    const resp = await handler.fetch(
      new Request("https://api.tminus.dev/v1/feeds", {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url: "https://example.com/feed.ics" }),
      }),
      env,
      mockCtx,
    );

    expect(resp.status).toBe(201);

    // Verify the deltas sent to DO have no source field (source is set by DO)
    // but the account type in D1 is ics_feed
    const doBody = userGraphDO.calls[0].body as {
      account_id: string;
      deltas: Array<{ type: string }>;
    };
    expect(doBody.deltas.every((d) => d.type === "created")).toBe(true);

    // Verify account in D1 is ics_feed
    const row = db.prepare(
      "SELECT provider FROM accounts WHERE account_id = ?",
    ).get(doBody.account_id) as { provider: string } | null;
    expect(row).not.toBeNull();
    expect(row!.provider).toBe("ics_feed");
  });
});

// ===========================================================================
// Integration: ICS-to-OAuth Upgrade Flow (TM-d17.5)
// ===========================================================================

describe("Integration: ICS-to-OAuth Upgrade Flow (TM-d17.5)", () => {
  let db: DatabaseType;
  let d1: D1Database;

  const GOOGLE_FEED_URL =
    "https://calendar.google.com/calendar/ical/example/public/basic.ics";
  const FEED_ACCOUNT_ID = "acc_01HXY000000000000000FEED01";
  const OAUTH_ACCOUNT_ID = "acc_01HXY00000000000000OAUTH01";

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(MIGRATION_0001_INITIAL_SCHEMA);
    db.exec(MIGRATION_0012_SUBSCRIPTIONS);
    db.exec(MIGRATION_0013_SUBSCRIPTION_LIFECYCLE);
    // Seed org + user
    db.prepare("INSERT INTO orgs (org_id, name) VALUES (?, ?)").run(
      TEST_ORG.org_id,
      TEST_ORG.name,
    );
    db.prepare(
      "INSERT INTO users (user_id, org_id, email) VALUES (?, ?, ?)",
    ).run(TEST_USER.user_id, TEST_USER.org_id, TEST_USER.email);

    d1 = createRealD1(db);
  });

  afterEach(() => {
    db.close();
  });

  // Helper: seed a feed account in D1
  function seedFeedAccount(
    accountId: string,
    feedUrl: string,
    status = "active",
  ): void {
    db.prepare(
      `INSERT INTO accounts (account_id, user_id, provider, provider_subject, email, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(accountId, TEST_USER.user_id, "ics_feed", feedUrl, feedUrl, status);
  }

  // Helper: seed an OAuth account in D1
  function seedOAuthAccount(accountId: string, provider = "google"): void {
    db.prepare(
      `INSERT INTO accounts (account_id, user_id, provider, provider_subject, email, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      accountId,
      TEST_USER.user_id,
      provider,
      `provider-sub-${accountId}`,
      "oauth@example.com",
      "active",
    );
  }

  // -------------------------------------------------------------------------
  // POST /v1/feeds/:id/upgrade -- success path
  // -------------------------------------------------------------------------

  it("POST /v1/feeds/:id/upgrade calls DO /getAccountEvents and /executeUpgrade, returns 200 with merge summary", async () => {
    seedFeedAccount(FEED_ACCOUNT_ID, GOOGLE_FEED_URL);

    // Mock DO responses for the upgrade flow
    const icsEvents = [
      {
        origin_event_id: "shared-uid-001@google.com",
        origin_account_id: FEED_ACCOUNT_ID,
        title: "Morning Standup",
        start: { dateTime: "2026-03-15T09:00:00Z" },
        end: { dateTime: "2026-03-15T09:30:00Z" },
        all_day: false,
        status: "confirmed",
        visibility: "default",
        transparency: "opaque",
        source: "ics_feed",
      },
    ];

    const providerEvents = [
      {
        origin_event_id: "shared-uid-001@google.com",
        origin_account_id: OAUTH_ACCOUNT_ID,
        title: "Morning Standup",
        start: { dateTime: "2026-03-15T09:00:00Z" },
        end: { dateTime: "2026-03-15T09:30:00Z" },
        all_day: false,
        status: "confirmed",
        visibility: "default",
        transparency: "opaque",
        source: "provider",
        attendees: [
          { email: "alice@example.com", partstat: "ACCEPTED" },
          { email: "bob@example.com", partstat: "TENTATIVE" },
        ],
        meeting_url: "https://meet.google.com/abc-defg-hij",
      },
      {
        origin_event_id: "provider-only-001@google.com",
        origin_account_id: OAUTH_ACCOUNT_ID,
        title: "New Provider-Only Event",
        start: { dateTime: "2026-03-16T14:00:00Z" },
        end: { dateTime: "2026-03-16T15:00:00Z" },
        all_day: false,
        status: "confirmed",
        visibility: "default",
        transparency: "opaque",
        source: "provider",
      },
    ];

    // The DO mock returns different events depending on the account_id sent.
    // We use a function-based approach via pathResponses.
    // Since the mock uses pathname matching, both calls to /getAccountEvents
    // will hit the same path. We need a call counter.
    let getAccountEventsCallCount = 0;

    const pathResponses = new Map<string, unknown>();
    // We need the mock to return different data for different calls to same path.
    // Override the namespace to handle this.

    const calls: DOCallRecord[] = [];
    const userGraphDO: DurableObjectNamespace & { calls: DOCallRecord[] } = {
      calls,
      idFromName(name: string): DurableObjectId {
        return { toString: () => name, name, equals: () => false } as unknown as DurableObjectId;
      },
      get(_id: DurableObjectId): DurableObjectStub {
        const doName = _id.toString();
        return {
          async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
            const url = typeof input === "string" ? new URL(input) : input instanceof URL ? input : new URL(input.url);
            const method = init?.method ?? "GET";
            let parsedBody: unknown;
            if (init?.body) {
              try { parsedBody = JSON.parse(init.body as string); } catch { parsedBody = init.body; }
            }
            calls.push({ name: doName, path: url.pathname, method, body: parsedBody });

            if (url.pathname === "/getAccountEvents") {
              getAccountEventsCallCount++;
              const body = parsedBody as { account_id: string };
              if (body.account_id === FEED_ACCOUNT_ID) {
                return new Response(JSON.stringify({ events: icsEvents }), {
                  status: 200,
                  headers: { "Content-Type": "application/json" },
                });
              }
              if (body.account_id === OAUTH_ACCOUNT_ID) {
                return new Response(JSON.stringify({ events: providerEvents }), {
                  status: 200,
                  headers: { "Content-Type": "application/json" },
                });
              }
            }

            if (url.pathname === "/executeUpgrade") {
              return new Response(JSON.stringify({ ok: true }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
              });
            }

            return new Response(JSON.stringify({ ok: true }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
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

    const handler = createHandler();
    const env = buildEnv(d1, userGraphDO);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request(`https://api.tminus.dev/v1/feeds/${FEED_ACCOUNT_ID}/upgrade`, {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ oauth_account_id: OAUTH_ACCOUNT_ID }),
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as {
      ok: boolean;
      data: {
        detected_provider: { provider: string; confidence: string };
        merged_count: number;
        new_count: number;
        orphaned_count: number;
        ics_account_removed: string;
        oauth_account_activated: string;
      };
    };
    expect(body.ok).toBe(true);

    // Verify merge summary
    expect(body.data.detected_provider.provider).toBe("google");
    expect(body.data.detected_provider.confidence).toBe("high");
    expect(body.data.merged_count).toBe(1); // shared-uid-001 matched by iCalUID
    expect(body.data.new_count).toBe(1); // provider-only-001 is new
    expect(body.data.orphaned_count).toBe(0); // no orphaned ICS events
    expect(body.data.ics_account_removed).toBe(FEED_ACCOUNT_ID);
    expect(body.data.oauth_account_activated).toBe(OAUTH_ACCOUNT_ID);

    // Verify DO calls: getAccountEvents (x2) + executeUpgrade (x1)
    expect(calls).toHaveLength(3);
    expect(calls[0].path).toBe("/getAccountEvents");
    expect((calls[0].body as { account_id: string }).account_id).toBe(FEED_ACCOUNT_ID);
    expect(calls[1].path).toBe("/getAccountEvents");
    expect((calls[1].body as { account_id: string }).account_id).toBe(OAUTH_ACCOUNT_ID);
    expect(calls[2].path).toBe("/executeUpgrade");

    // Verify executeUpgrade payload
    const upgradePayload = calls[2].body as {
      ics_account_id: string;
      oauth_account_id: string;
      merged_events: Array<{ origin_event_id: string; matched_by: string; attendees?: unknown[] }>;
      new_events: Array<{ origin_event_id: string }>;
      orphaned_events: unknown[];
    };
    expect(upgradePayload.ics_account_id).toBe(FEED_ACCOUNT_ID);
    expect(upgradePayload.oauth_account_id).toBe(OAUTH_ACCOUNT_ID);
    expect(upgradePayload.merged_events).toHaveLength(1);
    expect(upgradePayload.merged_events[0].origin_event_id).toBe("shared-uid-001@google.com");
    expect(upgradePayload.merged_events[0].matched_by).toBe("ical_uid");
    expect(upgradePayload.merged_events[0].attendees).toHaveLength(2);
    expect(upgradePayload.new_events).toHaveLength(1);
    expect(upgradePayload.new_events[0].origin_event_id).toBe("provider-only-001@google.com");
    expect(upgradePayload.orphaned_events).toHaveLength(0);

    // Verify D1: feed account marked as 'upgraded'
    const feedRow = db.prepare(
      "SELECT status FROM accounts WHERE account_id = ?",
    ).get(FEED_ACCOUNT_ID) as { status: string } | null;
    expect(feedRow).not.toBeNull();
    expect(feedRow!.status).toBe("upgraded");
  });

  // -------------------------------------------------------------------------
  // POST /v1/feeds/:id/upgrade -- validation errors
  // -------------------------------------------------------------------------

  it("POST /v1/feeds/:id/upgrade returns 400 when oauth_account_id is missing", async () => {
    seedFeedAccount(FEED_ACCOUNT_ID, GOOGLE_FEED_URL);

    const handler = createHandler();
    const env = buildEnv(d1);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request(`https://api.tminus.dev/v1/feeds/${FEED_ACCOUNT_ID}/upgrade`, {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(400);
    const body = await response.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("oauth_account_id");
  });

  it("POST /v1/feeds/:id/upgrade returns 404 when feed does not exist", async () => {
    const handler = createHandler();
    const env = buildEnv(d1);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request("https://api.tminus.dev/v1/feeds/acc_nonexistent/upgrade", {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ oauth_account_id: OAUTH_ACCOUNT_ID }),
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(404);
    const body = await response.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("not found");
  });

  it("POST /v1/feeds/:id/upgrade returns 401 without auth token", async () => {
    const handler = createHandler();
    const env = buildEnv(d1);

    const response = await handler.fetch(
      new Request(`https://api.tminus.dev/v1/feeds/${FEED_ACCOUNT_ID}/upgrade`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ oauth_account_id: OAUTH_ACCOUNT_ID }),
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // POST /v1/feeds/:id/upgrade -- DO error handling
  // -------------------------------------------------------------------------

  it("POST /v1/feeds/:id/upgrade returns 500 when DO /getAccountEvents fails", async () => {
    seedFeedAccount(FEED_ACCOUNT_ID, GOOGLE_FEED_URL);

    const pathResponses = new Map<string, unknown>();
    pathResponses.set("/getAccountEvents", {
      status: 500,
      data: { error: "Internal DO error" },
    } as PathResponseConfig);

    const userGraphDO = createMockDONamespace({ pathResponses });

    const handler = createHandler();
    const env = buildEnv(d1, userGraphDO);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request(`https://api.tminus.dev/v1/feeds/${FEED_ACCOUNT_ID}/upgrade`, {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ oauth_account_id: OAUTH_ACCOUNT_ID }),
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(500);
    const body = await response.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("Failed to fetch ICS events");
  });

  it("POST /v1/feeds/:id/upgrade returns 500 when DO /executeUpgrade fails", async () => {
    seedFeedAccount(FEED_ACCOUNT_ID, GOOGLE_FEED_URL);

    // /getAccountEvents succeeds but /executeUpgrade fails
    const pathResponses = new Map<string, unknown>();
    pathResponses.set("/getAccountEvents", { events: [] });
    pathResponses.set("/executeUpgrade", {
      status: 500,
      data: { error: "Upgrade execution failed" },
    } as PathResponseConfig);

    const userGraphDO = createMockDONamespace({ pathResponses });

    const handler = createHandler();
    const env = buildEnv(d1, userGraphDO);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request(`https://api.tminus.dev/v1/feeds/${FEED_ACCOUNT_ID}/upgrade`, {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ oauth_account_id: OAUTH_ACCOUNT_ID }),
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(500);
    const body = await response.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("Failed to execute upgrade");
  });

  // -------------------------------------------------------------------------
  // Full round-trip: ICS import -> upgrade -> events merged
  // -------------------------------------------------------------------------

  it("full round-trip: import ICS feed, then upgrade to OAuth with events merged", async () => {
    // Step 1: Mock ICS fetch and import a feed
    globalThis.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("calendar.google.com")) {
        return new Response(VALID_ICS, {
          status: 200,
          headers: { "Content-Type": "text/calendar" },
        });
      }
      return originalFetch(input, init);
    });

    // Step 1 DO: applyProviderDelta succeeds for import
    const importPathResponses = new Map<string, unknown>();
    importPathResponses.set("/applyProviderDelta", {
      created: 3, updated: 0, deleted: 0, mirrors_enqueued: 0, errors: [],
    });

    const importDO = createMockDONamespace({ pathResponses: importPathResponses });
    const handler = createHandler();
    const importEnv = buildEnv(d1, importDO);
    const authHeader = await makeAuthHeader();

    const importResp = await handler.fetch(
      new Request("https://api.tminus.dev/v1/feeds", {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url: GOOGLE_FEED_URL }),
      }),
      importEnv,
      mockCtx,
    );

    expect(importResp.status).toBe(201);
    const importBody = await importResp.json() as {
      ok: boolean;
      data: { account_id: string; events_imported: number };
    };
    expect(importBody.ok).toBe(true);
    expect(importBody.data.events_imported).toBe(3);
    const feedAccountId = importBody.data.account_id;

    // Verify feed account exists in D1
    const beforeUpgrade = db.prepare(
      "SELECT status, provider FROM accounts WHERE account_id = ?",
    ).get(feedAccountId) as { status: string; provider: string };
    expect(beforeUpgrade.provider).toBe("ics_feed");
    expect(beforeUpgrade.status).toBe("active");

    // Step 2: Upgrade the feed to OAuth
    // Simulate ICS events returned from DO (the 3 we just imported)
    const icsEvents = [
      {
        origin_event_id: "event-alpha@google.com",
        origin_account_id: feedAccountId,
        title: "Alpha Meeting",
        start: { dateTime: "2026-03-15T10:00:00Z" },
        end: { dateTime: "2026-03-15T11:00:00Z" },
        all_day: false,
        status: "confirmed",
        visibility: "default",
        transparency: "opaque",
        source: "ics_feed",
      },
      {
        origin_event_id: "event-beta@google.com",
        origin_account_id: feedAccountId,
        title: "Beta Review",
        start: { dateTime: "2026-03-16T14:00:00Z" },
        end: { dateTime: "2026-03-16T15:00:00Z" },
        all_day: false,
        status: "tentative",
        visibility: "default",
        transparency: "opaque",
        source: "ics_feed",
      },
    ];

    // Provider events: alpha matches by iCalUID, gamma is new from provider
    const providerEvents = [
      {
        origin_event_id: "event-alpha@google.com",
        origin_account_id: OAUTH_ACCOUNT_ID,
        title: "Alpha Meeting",
        start: { dateTime: "2026-03-15T10:00:00Z" },
        end: { dateTime: "2026-03-15T11:00:00Z" },
        all_day: false,
        status: "confirmed",
        visibility: "default",
        transparency: "opaque",
        source: "provider",
        attendees: [{ email: "alice@example.com", partstat: "ACCEPTED" }],
        conference_data: { type: "hangoutsMeet", url: "https://meet.google.com/abc" },
      },
      {
        origin_event_id: "provider-only-event@google.com",
        origin_account_id: OAUTH_ACCOUNT_ID,
        title: "Provider-Only Sync Event",
        start: { dateTime: "2026-03-17T10:00:00Z" },
        end: { dateTime: "2026-03-17T11:00:00Z" },
        all_day: false,
        status: "confirmed",
        visibility: "default",
        transparency: "opaque",
        source: "provider",
      },
    ];

    // Build a custom DO mock that returns correct events per account_id
    const upgradeCalls: DOCallRecord[] = [];
    const upgradeDO: DurableObjectNamespace & { calls: DOCallRecord[] } = {
      calls: upgradeCalls,
      idFromName(name: string): DurableObjectId {
        return { toString: () => name, name, equals: () => false } as unknown as DurableObjectId;
      },
      get(_id: DurableObjectId): DurableObjectStub {
        const doName = _id.toString();
        return {
          async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
            const url = typeof input === "string" ? new URL(input) : input instanceof URL ? input : new URL(input.url);
            const method = init?.method ?? "GET";
            let parsedBody: unknown;
            if (init?.body) {
              try { parsedBody = JSON.parse(init.body as string); } catch { parsedBody = init.body; }
            }
            upgradeCalls.push({ name: doName, path: url.pathname, method, body: parsedBody });

            if (url.pathname === "/getAccountEvents") {
              const reqBody = parsedBody as { account_id: string };
              if (reqBody.account_id === feedAccountId) {
                return new Response(JSON.stringify({ events: icsEvents }), { status: 200, headers: { "Content-Type": "application/json" } });
              }
              return new Response(JSON.stringify({ events: providerEvents }), { status: 200, headers: { "Content-Type": "application/json" } });
            }
            if (url.pathname === "/executeUpgrade") {
              return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
            }
            return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
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

    const upgradeEnv = buildEnv(d1, upgradeDO);

    const upgradeResp = await handler.fetch(
      new Request(`https://api.tminus.dev/v1/feeds/${feedAccountId}/upgrade`, {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ oauth_account_id: OAUTH_ACCOUNT_ID }),
      }),
      upgradeEnv,
      mockCtx,
    );

    expect(upgradeResp.status).toBe(200);
    const upgradeBody = await upgradeResp.json() as {
      ok: boolean;
      data: {
        detected_provider: { provider: string };
        merged_count: number;
        new_count: number;
        orphaned_count: number;
      };
    };
    expect(upgradeBody.ok).toBe(true);
    expect(upgradeBody.data.detected_provider.provider).toBe("google");
    // alpha matched by iCalUID, beta is orphaned (no provider match), 1 new from provider
    expect(upgradeBody.data.merged_count).toBe(1);
    expect(upgradeBody.data.new_count).toBe(1);
    expect(upgradeBody.data.orphaned_count).toBe(1); // beta is orphaned

    // Verify the executeUpgrade payload preserves orphaned events (BR-1)
    const execCall = upgradeCalls.find(c => c.path === "/executeUpgrade");
    expect(execCall).toBeDefined();
    const execPayload = execCall!.body as {
      orphaned_events: Array<{ origin_event_id: string; title: string }>;
      merged_events: Array<{ enriched_fields: string[]; matched_by: string }>;
    };
    expect(execPayload.orphaned_events).toHaveLength(1);
    expect(execPayload.orphaned_events[0].title).toBe("Beta Review");
    // Verify merged event has enrichment metadata (BR-2)
    expect(execPayload.merged_events[0].matched_by).toBe("ical_uid");
    expect(execPayload.merged_events[0].enriched_fields).toContain("attendees");
    expect(execPayload.merged_events[0].enriched_fields).toContain("conference_data");

    // Verify D1: feed account marked as 'upgraded'
    const afterUpgrade = db.prepare(
      "SELECT status FROM accounts WHERE account_id = ?",
    ).get(feedAccountId) as { status: string };
    expect(afterUpgrade.status).toBe("upgraded");
  });

  // -------------------------------------------------------------------------
  // POST /v1/feeds/downgrade -- success with feed URL
  // -------------------------------------------------------------------------

  it("POST /v1/feeds/downgrade creates fallback ICS feed account when feed URL is provided", async () => {
    seedOAuthAccount(OAUTH_ACCOUNT_ID);

    const pathResponses = new Map<string, unknown>();
    pathResponses.set("/getAccountEvents", {
      events: [
        {
          origin_event_id: "evt-001",
          origin_account_id: OAUTH_ACCOUNT_ID,
          title: "Preserved Event",
          start: { dateTime: "2026-03-15T09:00:00Z" },
          end: { dateTime: "2026-03-15T10:00:00Z" },
          all_day: false,
          status: "confirmed",
          visibility: "default",
          transparency: "opaque",
          source: "provider",
        },
      ],
    });
    const userGraphDO = createMockDONamespace({ pathResponses });

    const handler = createHandler();
    const env = buildEnv(d1, userGraphDO);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request("https://api.tminus.dev/v1/feeds/downgrade", {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          oauth_account_id: OAUTH_ACCOUNT_ID,
          provider: "google",
          feed_url: GOOGLE_FEED_URL,
        }),
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as {
      ok: boolean;
      data: {
        new_feed_account_id: string;
        feed_url: string;
        preserved_event_count: number;
        mode: string;
        oauth_account_removed: string;
      };
    };
    expect(body.ok).toBe(true);
    expect(body.data.feed_url).toBe(GOOGLE_FEED_URL);
    expect(body.data.preserved_event_count).toBe(1);
    expect(body.data.mode).toBe("read_only");
    expect(body.data.oauth_account_removed).toBe(OAUTH_ACCOUNT_ID);
    expect(body.data.new_feed_account_id).toMatch(/^acc_/);

    // Verify new feed account created in D1
    const newFeedRow = db.prepare(
      "SELECT provider, provider_subject, status FROM accounts WHERE account_id = ?",
    ).get(body.data.new_feed_account_id) as {
      provider: string;
      provider_subject: string;
      status: string;
    } | null;
    expect(newFeedRow).not.toBeNull();
    expect(newFeedRow!.provider).toBe("ics_feed");
    expect(newFeedRow!.provider_subject).toBe(GOOGLE_FEED_URL);
    expect(newFeedRow!.status).toBe("active");

    // Verify OAuth account marked as 'downgraded'
    const oauthRow = db.prepare(
      "SELECT status FROM accounts WHERE account_id = ?",
    ).get(OAUTH_ACCOUNT_ID) as { status: string };
    expect(oauthRow.status).toBe("downgraded");

    // Verify DO was called to get current events
    expect(userGraphDO.calls).toHaveLength(1);
    expect(userGraphDO.calls[0].path).toBe("/getAccountEvents");
    expect((userGraphDO.calls[0].body as { account_id: string }).account_id).toBe(OAUTH_ACCOUNT_ID);
  });

  // -------------------------------------------------------------------------
  // POST /v1/feeds/downgrade -- without feed URL
  // -------------------------------------------------------------------------

  it("POST /v1/feeds/downgrade returns warning when no feed URL is available", async () => {
    seedOAuthAccount(OAUTH_ACCOUNT_ID);

    const pathResponses = new Map<string, unknown>();
    pathResponses.set("/getAccountEvents", { events: [] });
    const userGraphDO = createMockDONamespace({ pathResponses });

    const handler = createHandler();
    const env = buildEnv(d1, userGraphDO);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request("https://api.tminus.dev/v1/feeds/downgrade", {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          oauth_account_id: OAUTH_ACCOUNT_ID,
          provider: "apple",
          // No feed_url provided
        }),
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as {
      ok: boolean;
      data: {
        preserved_event_count: number;
        mode: string;
        warning: string;
      };
    };
    expect(body.ok).toBe(true);
    expect(body.data.mode).toBe("read_only");
    expect(body.data.warning).toContain("No public ICS feed URL");
  });

  // -------------------------------------------------------------------------
  // POST /v1/feeds/downgrade -- validation errors
  // -------------------------------------------------------------------------

  it("POST /v1/feeds/downgrade returns 400 when oauth_account_id is missing", async () => {
    const handler = createHandler();
    const env = buildEnv(d1);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request("https://api.tminus.dev/v1/feeds/downgrade", {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ provider: "google" }),
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(400);
    const body = await response.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("oauth_account_id");
  });

  it("POST /v1/feeds/downgrade returns 400 when provider is missing", async () => {
    const handler = createHandler();
    const env = buildEnv(d1);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request("https://api.tminus.dev/v1/feeds/downgrade", {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ oauth_account_id: OAUTH_ACCOUNT_ID }),
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(400);
    const body = await response.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("provider");
  });

  // -------------------------------------------------------------------------
  // POST /v1/feeds/downgrade -- DO error resilience
  // -------------------------------------------------------------------------

  it("POST /v1/feeds/downgrade handles DO /getAccountEvents failure gracefully (uses empty events)", async () => {
    seedOAuthAccount(OAUTH_ACCOUNT_ID);

    const pathResponses = new Map<string, unknown>();
    pathResponses.set("/getAccountEvents", {
      status: 500,
      data: { error: "DO unavailable" },
    } as PathResponseConfig);
    const userGraphDO = createMockDONamespace({ pathResponses });

    const handler = createHandler();
    const env = buildEnv(d1, userGraphDO);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request("https://api.tminus.dev/v1/feeds/downgrade", {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          oauth_account_id: OAUTH_ACCOUNT_ID,
          provider: "google",
          feed_url: GOOGLE_FEED_URL,
        }),
      }),
      env,
      mockCtx,
    );

    // Downgrade should still succeed even if DO call fails
    // (handleDowngradeFeed catches errors and defaults to empty events)
    expect(response.status).toBe(200);
    const body = await response.json() as {
      ok: boolean;
      data: { preserved_event_count: number; mode: string };
    };
    expect(body.ok).toBe(true);
    expect(body.data.preserved_event_count).toBe(0);
    expect(body.data.mode).toBe("read_only");
  });

  // -------------------------------------------------------------------------
  // GET /v1/feeds/:id/provider -- provider detection
  // -------------------------------------------------------------------------

  it("GET /v1/feeds/:id/provider detects Google from feed URL", async () => {
    seedFeedAccount(FEED_ACCOUNT_ID, GOOGLE_FEED_URL);

    const handler = createHandler();
    const env = buildEnv(d1);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request(`https://api.tminus.dev/v1/feeds/${FEED_ACCOUNT_ID}/provider`, {
        method: "GET",
        headers: { Authorization: authHeader },
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as {
      ok: boolean;
      data: {
        account_id: string;
        feed_url: string;
        detected_provider: string;
        confidence: string;
      };
    };
    expect(body.ok).toBe(true);
    expect(body.data.account_id).toBe(FEED_ACCOUNT_ID);
    expect(body.data.detected_provider).toBe("google");
    expect(body.data.confidence).toBe("high");
  });

  it("GET /v1/feeds/:id/provider detects Microsoft from Outlook URL", async () => {
    const outlookFeedUrl = "https://outlook.office365.com/owa/calendar/abc/def/basic.ics";
    seedFeedAccount(FEED_ACCOUNT_ID, outlookFeedUrl);

    const handler = createHandler();
    const env = buildEnv(d1);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request(`https://api.tminus.dev/v1/feeds/${FEED_ACCOUNT_ID}/provider`, {
        method: "GET",
        headers: { Authorization: authHeader },
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as {
      ok: boolean;
      data: { detected_provider: string; confidence: string };
    };
    expect(body.ok).toBe(true);
    expect(body.data.detected_provider).toBe("microsoft");
    expect(body.data.confidence).toBe("high");
  });

  it("GET /v1/feeds/:id/provider returns unknown for unrecognized provider", async () => {
    const unknownFeedUrl = "https://some-random-cal.example.com/feed.ics";
    seedFeedAccount(FEED_ACCOUNT_ID, unknownFeedUrl);

    const handler = createHandler();
    const env = buildEnv(d1);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request(`https://api.tminus.dev/v1/feeds/${FEED_ACCOUNT_ID}/provider`, {
        method: "GET",
        headers: { Authorization: authHeader },
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as {
      ok: boolean;
      data: { detected_provider: string; confidence: string };
    };
    expect(body.ok).toBe(true);
    expect(body.data.detected_provider).toBe("unknown");
    expect(body.data.confidence).toBe("none");
  });

  it("GET /v1/feeds/:id/provider returns 404 for non-existent feed", async () => {
    const handler = createHandler();
    const env = buildEnv(d1);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request("https://api.tminus.dev/v1/feeds/acc_nonexistent/provider", {
        method: "GET",
        headers: { Authorization: authHeader },
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(404);
    const body = await response.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
  });
});
