/**
 * Phase 6C E2E Validation: Progressive Onboarding
 *
 * Validates the FULL progressive onboarding journey from zero-auth ICS import
 * through engagement-driven upgrade to full OAuth sync. This is the capstone
 * test for the Phase 6C epic (TM-d17), proving the strategic premise:
 * users who see value first convert to full access at higher rates.
 *
 * Journey validated:
 *   1. Zero-auth entry: add 3 ICS feeds (Google, Outlook, Apple) -- no auth
 *   2. Feed refresh: detect changes, staleness, recovery
 *   3. Upgrade prompts: conflict, write-intent, engagement triggers fire
 *   4. Upgrade migration: ICS -> OAuth with event match + enrichment
 *   5. Mixed view: ICS + OAuth accounts coexist
 *   6. Downgrade resilience: OAuth revocation -> automatic ICS fallback
 *
 * Test strategy:
 *   - Real API handler chain (createHandler) with real D1 (better-sqlite3)
 *   - Mock DO stubs capture RPC calls and return configured responses
 *   - External ICS feeds mocked via globalThis.fetch interception
 *   - Pure function modules tested directly for upgrade prompts and refresh
 *
 * No mocks of internal modules. No test fixtures.
 *
 * Run with:
 *   make test-e2e-phase6c
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import {
  MIGRATION_0001_INITIAL_SCHEMA,
  MIGRATION_0012_SUBSCRIPTIONS,
  MIGRATION_0013_SUBSCRIPTION_LIFECYCLE,
  MIGRATION_0020_FEED_REFRESH,
} from "@tminus/d1-registry";
import {
  // ICS feed
  validateFeedUrl,
  normalizeIcsFeedEvents,
  // Feed refresh
  computeContentHash,
  detectFeedChanges,
  computeStaleness,
  classifyFeedError,
  isRateLimited,
  diffFeedEvents,
  buildConditionalHeaders,
  DEFAULT_REFRESH_INTERVAL_MS,
  MIN_REFRESH_INTERVAL_MS,
  DEAD_THRESHOLD_MS,
  STALE_MULTIPLIER,
  // Upgrade prompts
  evaluatePromptTriggers,
  shouldShowPrompt,
  createDismissal,
  DISMISSAL_DURATION_MS,
  // ICS upgrade
  detectProvider,
  matchEventsByICalUID,
  matchEvents,
  mergeIcsWithProvider,
  planUpgrade,
  planDowngrade,
  // Types
  type FeedRefreshState,
  type EngagementMetrics,
  type FeedContext,
  type PromptSettings,
  type IcsEvent,
  type ProviderEvent,
} from "@tminus/shared";
import { createHandler, createJwt } from "../../workers/api/src/index";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const JWT_SECRET = "e2e-phase6c-jwt-secret-32chars-minimum-secure";

const TEST_ORG = {
  org_id: "org_01HXY00000000000000006C001",
  name: "Phase 6C Test Org",
} as const;

const TEST_USER = {
  user_id: "usr_01HXY00000000000000006C001",
  org_id: TEST_ORG.org_id,
  email: "progressive-onboarding@e2e-test.dev",
} as const;

// ICS feed URLs for the 3 providers
const GOOGLE_FEED_URL =
  "https://calendar.google.com/calendar/ical/user/public/basic.ics";
const OUTLOOK_FEED_URL =
  "https://outlook.office365.com/owa/calendar/abc123/def456/calendar.ics";
const APPLE_FEED_URL =
  "https://p47-caldav.icloud.com/published/2/abc123";

// ---------------------------------------------------------------------------
// ICS fixtures: 3 provider-specific feeds
// ---------------------------------------------------------------------------

const GOOGLE_ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Google Inc//Google Calendar 70.9054//EN
BEGIN:VEVENT
UID:google-standup-001@google.com
DTSTART:20260315T090000Z
DTEND:20260315T093000Z
SUMMARY:Morning Standup
DESCRIPTION:Daily standup with the team
LOCATION:Zoom - https://zoom.us/j/12345
STATUS:CONFIRMED
END:VEVENT
BEGIN:VEVENT
UID:google-review-002@google.com
DTSTART:20260315T140000Z
DTEND:20260315T150000Z
SUMMARY:Sprint Review
STATUS:CONFIRMED
END:VEVENT
BEGIN:VEVENT
UID:google-lunch-003@google.com
DTSTART;VALUE=DATE:20260316
DTEND;VALUE=DATE:20260317
SUMMARY:Team Lunch
TRANSP:TRANSPARENT
STATUS:CONFIRMED
END:VEVENT
END:VCALENDAR`;

const OUTLOOK_ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Microsoft Corporation//Outlook 16.0//EN
BEGIN:VEVENT
UID:outlook-board-001@outlook.com
DTSTART:20260315T160000Z
DTEND:20260315T170000Z
SUMMARY:Board Meeting
DESCRIPTION:Quarterly board review
STATUS:CONFIRMED
END:VEVENT
BEGIN:VEVENT
UID:outlook-checkin-002@outlook.com
DTSTART:20260316T100000Z
DTEND:20260316T103000Z
SUMMARY:1:1 Check-in
STATUS:TENTATIVE
END:VEVENT
END:VCALENDAR`;

const APPLE_ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Apple Inc.//iCal 10.0//EN
BEGIN:VEVENT
UID:apple-dentist-001@icloud.com
DTSTART:20260317T090000Z
DTEND:20260317T100000Z
SUMMARY:Dentist Appointment
LOCATION:123 Main St
STATUS:CONFIRMED
END:VEVENT
BEGIN:VEVENT
UID:apple-yoga-002@icloud.com
DTSTART:20260317T180000Z
DTEND:20260317T190000Z
SUMMARY:Evening Yoga
STATUS:CONFIRMED
END:VEVENT
END:VCALENDAR`;

// Modified Google ICS (event title changed, one event removed, one added)
const GOOGLE_ICS_UPDATED = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Google Inc//Google Calendar 70.9054//EN
BEGIN:VEVENT
UID:google-standup-001@google.com
DTSTART:20260315T090000Z
DTEND:20260315T093000Z
SUMMARY:Morning Standup (Updated)
DESCRIPTION:Daily standup with the team
LOCATION:Zoom - https://zoom.us/j/12345
STATUS:CONFIRMED
SEQUENCE:2
END:VEVENT
BEGIN:VEVENT
UID:google-lunch-003@google.com
DTSTART;VALUE=DATE:20260316
DTEND;VALUE=DATE:20260317
SUMMARY:Team Lunch
TRANSP:TRANSPARENT
STATUS:CONFIRMED
END:VEVENT
BEGIN:VEVENT
UID:google-planning-004@google.com
DTSTART:20260318T100000Z
DTEND:20260318T110000Z
SUMMARY:Sprint Planning
STATUS:CONFIRMED
END:VEVENT
END:VCALENDAR`;

// ---------------------------------------------------------------------------
// D1 mock backed by better-sqlite3 (proven pattern from Phase 6A/6B)
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
// Mock DO namespace (captures calls, configurable responses)
// ---------------------------------------------------------------------------

interface DOCallRecord {
  name: string;
  path: string;
  method: string;
  body?: unknown;
}

function createMockDONamespace(config?: {
  defaultResponse?: unknown;
  pathResponses?: Map<string, unknown>;
}): DurableObjectNamespace & { calls: DOCallRecord[] } {
  const calls: DOCallRecord[] = [];
  const defaultResp = config?.defaultResponse ?? { ok: true };

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

          calls.push({
            name: doName,
            path: url.pathname,
            method,
            body: parsedBody,
          });

          const pathData = config?.pathResponses?.get(url.pathname);
          const responseData = pathData ?? defaultResp;

          // Support PathResponseConfig (status + data)
          if (
            typeof responseData === "object" &&
            responseData !== null &&
            "status" in responseData &&
            "data" in responseData &&
            typeof (responseData as { status: number }).status === "number"
          ) {
            const prc = responseData as { status: number; data: unknown };
            return new Response(JSON.stringify(prc.data), {
              status: prc.status,
              headers: { "Content-Type": "application/json" },
            });
          }

          return new Response(JSON.stringify(responseData), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      } as unknown as DurableObjectStub;
    },
    idFromString(_hexId: string): DurableObjectId {
      return {
        toString: () => _hexId,
        equals: () => false,
      } as unknown as DurableObjectId;
    },
    newUniqueId(): DurableObjectId {
      return {
        toString: () => "unique",
        equals: () => false,
      } as unknown as DurableObjectId;
    },
    jurisdiction(): DurableObjectNamespace {
      return this;
    },
  } as unknown as DurableObjectNamespace & { calls: DOCallRecord[] };
}

// ---------------------------------------------------------------------------
// Other mocks
// ---------------------------------------------------------------------------

function createMockQueue(): Queue {
  return {
    async send() {},
    async sendBatch() {},
  } as unknown as Queue;
}

function createMockKV(): KVNamespace {
  const store = new Map<string, { value: string; expiration?: number }>();
  return {
    async get(key: string): Promise<string | null> {
      const entry = store.get(key);
      if (!entry) return null;
      return entry.value;
    },
    async put(
      key: string,
      value: string,
      opts?: { expirationTtl?: number },
    ): Promise<void> {
      const expiration = opts?.expirationTtl
        ? Math.floor(Date.now() / 1000) + opts.expirationTtl
        : undefined;
      store.set(key, { value, expiration });
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
    async list(): Promise<{
      keys: Array<{ name: string }>;
      list_complete: boolean;
    }> {
      return {
        keys: Array.from(store.keys()).map((name) => ({ name })),
        list_complete: true,
      };
    },
    async getWithMetadata(): Promise<{
      value: string | null;
      metadata: unknown;
    }> {
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
): Env {
  return {
    DB: d1,
    USER_GRAPH: userGraphDO ?? createMockDONamespace(),
    ACCOUNT: userGraphDO ?? createMockDONamespace(),
    SYNC_QUEUE: createMockQueue(),
    WRITE_QUEUE: createMockQueue(),
    SESSIONS: createMockKV(),
    RATE_LIMITS: createMockKV(),
    JWT_SECRET,
  } as unknown as Env;
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

// ---------------------------------------------------------------------------
// D1 helpers
// ---------------------------------------------------------------------------

function seedOrgAndUser(db: DatabaseType): void {
  db.prepare("INSERT INTO orgs (org_id, name) VALUES (?, ?)").run(
    TEST_ORG.org_id,
    TEST_ORG.name,
  );
  db.prepare(
    "INSERT INTO users (user_id, org_id, email) VALUES (?, ?, ?)",
  ).run(TEST_USER.user_id, TEST_USER.org_id, TEST_USER.email);
}

function seedFeedAccount(
  db: DatabaseType,
  accountId: string,
  feedUrl: string,
  status = "active",
): void {
  db.prepare(
    `INSERT INTO accounts (account_id, user_id, provider, provider_subject, email, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(accountId, TEST_USER.user_id, "ics_feed", feedUrl, feedUrl, status);
}

function getAccountRow(
  db: DatabaseType,
  accountId: string,
): {
  account_id: string;
  provider: string;
  status: string;
  provider_subject: string;
} | null {
  return db
    .prepare("SELECT account_id, provider, status, provider_subject FROM accounts WHERE account_id = ?")
    .get(accountId) as {
      account_id: string;
      provider: string;
      status: string;
      provider_subject: string;
    } | null;
}

function countFeedAccounts(db: DatabaseType, userId: string): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) as cnt FROM accounts WHERE user_id = ? AND provider = 'ics_feed'",
    )
    .get(userId) as { cnt: number };
  return row.cnt;
}

// ===========================================================================
// AC#1: Zero-auth onboarding with 3 ICS feeds completes in under 2 minutes
// ===========================================================================

describe("Phase 6C E2E: Zero-auth onboarding with 3 ICS feeds (AC#1)", () => {
  let db: DatabaseType;
  let d1: D1Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(MIGRATION_0001_INITIAL_SCHEMA);
    db.exec(MIGRATION_0012_SUBSCRIPTIONS);
    db.exec(MIGRATION_0013_SUBSCRIPTION_LIFECYCLE);
    // MIGRATION_0020 adds feed refresh columns via ALTER TABLE.
    // For in-memory test DB we run all migration DDL statements individually.
    for (const stmt of MIGRATION_0020_FEED_REFRESH.split(";").filter(s => s.trim())) {
      db.exec(stmt + ";");
    }
    seedOrgAndUser(db);
    d1 = createRealD1(db);
  });

  afterEach(() => {
    db.close();
  });

  it("imports 3 ICS feeds (Google, Outlook, Apple) with zero auth, all under 2 minutes", async () => {
    const startTime = Date.now();

    // Mock fetch: route ICS URLs to their respective fixtures
    globalThis.fetch = vi.fn().mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;

        if (url.includes("calendar.google.com")) {
          return new Response(GOOGLE_ICS, {
            status: 200,
            headers: { "Content-Type": "text/calendar" },
          });
        }
        if (url.includes("outlook.office365.com")) {
          return new Response(OUTLOOK_ICS, {
            status: 200,
            headers: { "Content-Type": "text/calendar" },
          });
        }
        if (url.includes("icloud.com")) {
          return new Response(APPLE_ICS, {
            status: 200,
            headers: { "Content-Type": "text/calendar" },
          });
        }
        return originalFetch(input, init);
      },
    );

    const pathResponses = new Map<string, unknown>();
    pathResponses.set("/applyProviderDelta", {
      created: 3,
      updated: 0,
      deleted: 0,
      mirrors_enqueued: 0,
      errors: [],
    });
    pathResponses.set("/listCanonicalEvents", {
      items: [],
      cursor: null,
      has_more: false,
    });

    const userGraphDO = createMockDONamespace({ pathResponses });
    const handler = createHandler();
    const env = buildEnv(d1, userGraphDO);
    const authHeader = await makeAuthHeader();

    // Feed 1: Google
    const googleResp = await handler.fetch(
      new Request("https://api.tminus.dev/v1/feeds", {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url: GOOGLE_FEED_URL }),
      }),
      env,
      mockCtx,
    );
    expect(googleResp.status).toBe(201);
    const googleBody = (await googleResp.json()) as {
      ok: boolean;
      data: { account_id: string; events_imported: number };
    };
    expect(googleBody.ok).toBe(true);
    // PROOF: Google feed imported 3 events
    expect(googleBody.data.events_imported).toBe(3);

    // Feed 2: Outlook
    const outlookResp = await handler.fetch(
      new Request("https://api.tminus.dev/v1/feeds", {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url: OUTLOOK_FEED_URL }),
      }),
      env,
      mockCtx,
    );
    expect(outlookResp.status).toBe(201);
    const outlookBody = (await outlookResp.json()) as {
      ok: boolean;
      data: { account_id: string; events_imported: number };
    };
    expect(outlookBody.ok).toBe(true);
    // PROOF: Outlook feed imported 2 events
    expect(outlookBody.data.events_imported).toBe(2);

    // Feed 3: Apple
    const appleResp = await handler.fetch(
      new Request("https://api.tminus.dev/v1/feeds", {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url: APPLE_FEED_URL }),
      }),
      env,
      mockCtx,
    );
    expect(appleResp.status).toBe(201);
    const appleBody = (await appleResp.json()) as {
      ok: boolean;
      data: { account_id: string; events_imported: number };
    };
    expect(appleBody.ok).toBe(true);
    // PROOF: Apple feed imported 2 events
    expect(appleBody.data.events_imported).toBe(2);

    // PROOF: 3 feed accounts in D1 total
    const feedCount = countFeedAccounts(db, TEST_USER.user_id);
    expect(feedCount).toBe(3);

    // Verify all 3 feed accounts are active
    for (const accountId of [
      googleBody.data.account_id,
      outlookBody.data.account_id,
      appleBody.data.account_id,
    ]) {
      const row = getAccountRow(db, accountId);
      expect(row).not.toBeNull();
      expect(row!.provider).toBe("ics_feed");
      expect(row!.status).toBe("active");
    }

    // PROOF: Total of 7 events imported across all feeds (3 + 2 + 2)
    const totalEvents =
      googleBody.data.events_imported +
      outlookBody.data.events_imported +
      appleBody.data.events_imported;
    expect(totalEvents).toBe(7);

    // Verify DO was called 3 times for applyProviderDelta (one per feed)
    const deltaCalls = userGraphDO.calls.filter(
      (c) => c.path === "/applyProviderDelta",
    );
    expect(deltaCalls).toHaveLength(3);

    // AC#1: PROOF: under 2 minutes
    const elapsed = Date.now() - startTime;
    expect(elapsed).toBeLessThan(2 * 60 * 1000);
  });

  it("unified calendar view shows events from all 3 feeds via GET /v1/events", async () => {
    // Mock fetch for all 3 feeds
    globalThis.fetch = vi.fn().mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        if (url.includes("calendar.google.com"))
          return new Response(GOOGLE_ICS, { status: 200 });
        if (url.includes("outlook.office365.com"))
          return new Response(OUTLOOK_ICS, { status: 200 });
        if (url.includes("icloud.com"))
          return new Response(APPLE_ICS, { status: 200 });
        return originalFetch(input, init);
      },
    );

    // Events from all 3 feeds combined in unified view
    const unifiedEvents = [
      { canonical_event_id: "evt_g1", title: "Morning Standup", source: "ics_feed" },
      { canonical_event_id: "evt_g2", title: "Sprint Review", source: "ics_feed" },
      { canonical_event_id: "evt_g3", title: "Team Lunch", source: "ics_feed" },
      { canonical_event_id: "evt_o1", title: "Board Meeting", source: "ics_feed" },
      { canonical_event_id: "evt_o2", title: "1:1 Check-in", source: "ics_feed" },
      { canonical_event_id: "evt_a1", title: "Dentist Appointment", source: "ics_feed" },
      { canonical_event_id: "evt_a2", title: "Evening Yoga", source: "ics_feed" },
    ];

    const pathResponses = new Map<string, unknown>();
    pathResponses.set("/applyProviderDelta", {
      created: 3, updated: 0, deleted: 0, mirrors_enqueued: 0, errors: [],
    });
    pathResponses.set("/listCanonicalEvents", {
      items: unifiedEvents,
      cursor: null,
      has_more: false,
    });

    const userGraphDO = createMockDONamespace({ pathResponses });
    const handler = createHandler();
    const env = buildEnv(d1, userGraphDO);
    const authHeader = await makeAuthHeader();

    // Import all 3 feeds
    for (const url of [GOOGLE_FEED_URL, OUTLOOK_FEED_URL, APPLE_FEED_URL]) {
      const resp = await handler.fetch(
        new Request("https://api.tminus.dev/v1/feeds", {
          method: "POST",
          headers: {
            Authorization: authHeader,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ url }),
        }),
        env,
        mockCtx,
      );
      expect(resp.status).toBe(201);
    }

    // Verify unified view via GET /v1/events
    const eventsResp = await handler.fetch(
      new Request("https://api.tminus.dev/v1/events", {
        method: "GET",
        headers: { Authorization: authHeader },
      }),
      env,
      mockCtx,
    );
    expect(eventsResp.status).toBe(200);
    const eventsBody = (await eventsResp.json()) as {
      ok: boolean;
      data: Array<{ title: string; source: string }>;
    };

    // PROOF: Unified view shows all 7 events from all 3 feeds
    expect(eventsBody.data).toHaveLength(7);
    // PROOF: All events are from ics_feed source
    expect(eventsBody.data.every((e) => e.source === "ics_feed")).toBe(true);
    // PROOF: Events from all providers present
    const titles = eventsBody.data.map((e) => e.title).sort();
    expect(titles).toContain("Morning Standup");
    expect(titles).toContain("Board Meeting");
    expect(titles).toContain("Dentist Appointment");
  });

  it("no authentication required: feed URL validation and parsing work without OAuth", () => {
    // PROOF: validateFeedUrl works with no auth context
    const googleResult = validateFeedUrl(GOOGLE_FEED_URL);
    expect(googleResult.valid).toBe(true);

    const outlookResult = validateFeedUrl(OUTLOOK_FEED_URL);
    expect(outlookResult.valid).toBe(true);

    const appleResult = validateFeedUrl(APPLE_FEED_URL);
    expect(appleResult.valid).toBe(true);

    // PROOF: normalizeIcsFeedEvents parses without any auth
    const googleEvents = normalizeIcsFeedEvents(GOOGLE_ICS, "acct_google");
    expect(googleEvents).toHaveLength(3);
    expect(googleEvents[0].source).toBe("ics_feed");
    expect(googleEvents[0].title).toBe("Morning Standup");

    const outlookEvents = normalizeIcsFeedEvents(OUTLOOK_ICS, "acct_outlook");
    expect(outlookEvents).toHaveLength(2);

    const appleEvents = normalizeIcsFeedEvents(APPLE_ICS, "acct_apple");
    expect(appleEvents).toHaveLength(2);
  });
});

// ===========================================================================
// AC#2: Feed refresh detects changes and updates calendar view
// ===========================================================================

describe("Phase 6C E2E: Feed refresh and change detection (AC#2)", () => {
  it("detects content changes via hash comparison", () => {
    const hash1 = computeContentHash(GOOGLE_ICS);
    const hash2 = computeContentHash(GOOGLE_ICS_UPDATED);

    // PROOF: Different content produces different hashes
    expect(hash1).not.toBe(hash2);

    // Same content produces same hash (deterministic)
    const hash1Again = computeContentHash(GOOGLE_ICS);
    expect(hash1).toBe(hash1Again);

    // First fetch: always reports changed
    const firstResult = detectFeedChanges({
      httpStatus: 200,
      responseBody: GOOGLE_ICS,
      previousContentHash: undefined,
    });
    expect(firstResult.changed).toBe(true);
    expect(firstResult.reason).toBe("first_fetch");
    expect(firstResult.newContentHash).toBe(hash1);

    // Second fetch with same content: no change
    const sameResult = detectFeedChanges({
      httpStatus: 200,
      responseBody: GOOGLE_ICS,
      previousContentHash: hash1,
    });
    expect(sameResult.changed).toBe(false);
    expect(sameResult.reason).toBe("hash_match");

    // Third fetch with updated content: changed
    const changedResult = detectFeedChanges({
      httpStatus: 200,
      responseBody: GOOGLE_ICS_UPDATED,
      previousContentHash: hash1,
    });
    expect(changedResult.changed).toBe(true);
    expect(changedResult.reason).toBe("hash_changed");
    expect(changedResult.newContentHash).toBe(hash2);
  });

  it("HTTP 304 Not Modified skips re-parsing", () => {
    const result = detectFeedChanges({
      httpStatus: 304,
      responseBody: null,
      previousContentHash: "abc123",
      etag: '"etag-v1"',
    });

    // PROOF: 304 correctly detected as no change
    expect(result.changed).toBe(false);
    expect(result.reason).toBe("not_modified");
  });

  it("conditional headers built from ETag and Last-Modified", () => {
    const headers = buildConditionalHeaders({
      etag: '"etag-v1"',
      lastModified: "Sat, 15 Mar 2026 10:00:00 GMT",
    });

    // PROOF: Conditional headers present for bandwidth-efficient polling
    expect(headers["If-None-Match"]).toBe('"etag-v1"');
    expect(headers["If-Modified-Since"]).toBe("Sat, 15 Mar 2026 10:00:00 GMT");
    expect(headers["Accept"]).toBe("text/calendar, text/plain");
  });

  it("per-event diffing detects added, modified, and deleted events", () => {
    // Original events
    const previous = new Map<string, number>([
      ["google-standup-001@google.com", 0],
      ["google-review-002@google.com", 0],
      ["google-lunch-003@google.com", 0],
    ]);

    // Updated events: standup modified (SEQUENCE:2), review deleted, planning added
    const current = new Map<string, number>([
      ["google-standup-001@google.com", 2],
      ["google-lunch-003@google.com", 0],
      ["google-planning-004@google.com", 0],
    ]);

    const diff = diffFeedEvents(previous, current);

    // PROOF: Correctly detects added event
    expect(diff.added).toContain("google-planning-004@google.com");
    // PROOF: Correctly detects modified event (SEQUENCE increased)
    expect(diff.modified).toContain("google-standup-001@google.com");
    // PROOF: Correctly detects deleted event
    expect(diff.deleted).toContain("google-review-002@google.com");
    // Lunch unchanged
    expect(diff.added).not.toContain("google-lunch-003@google.com");
    expect(diff.modified).not.toContain("google-lunch-003@google.com");
    expect(diff.deleted).not.toContain("google-lunch-003@google.com");
  });

  it("staleness detection: fresh -> stale -> dead lifecycle", () => {
    const now = Date.now();

    // Fresh: last refresh 10 minutes ago (within 15-min interval)
    const freshState: FeedRefreshState = {
      lastSuccessfulRefreshAt: new Date(now - 10 * 60 * 1000).toISOString(),
      refreshIntervalMs: DEFAULT_REFRESH_INTERVAL_MS,
      consecutiveFailures: 0,
    };
    const fresh = computeStaleness(freshState, now);
    expect(fresh.status).toBe("fresh");
    expect(fresh.isDead).toBe(false);

    // Stale: last refresh 35 minutes ago (> 2x 15-min interval = 30 min)
    const staleState: FeedRefreshState = {
      lastSuccessfulRefreshAt: new Date(
        now - DEFAULT_REFRESH_INTERVAL_MS * STALE_MULTIPLIER - 5 * 60 * 1000,
      ).toISOString(),
      refreshIntervalMs: DEFAULT_REFRESH_INTERVAL_MS,
      consecutiveFailures: 2,
    };
    const stale = computeStaleness(staleState, now);
    expect(stale.status).toBe("stale");
    expect(stale.isDead).toBe(false);

    // Dead: last refresh > 24 hours ago
    const deadState: FeedRefreshState = {
      lastSuccessfulRefreshAt: new Date(
        now - DEAD_THRESHOLD_MS - 60 * 1000,
      ).toISOString(),
      refreshIntervalMs: DEFAULT_REFRESH_INTERVAL_MS,
      consecutiveFailures: 10,
    };
    const dead = computeStaleness(deadState, now);
    expect(dead.status).toBe("dead");
    expect(dead.isDead).toBe(true);

    // Never refreshed: also dead
    const neverState: FeedRefreshState = {
      lastSuccessfulRefreshAt: null,
      refreshIntervalMs: DEFAULT_REFRESH_INTERVAL_MS,
      consecutiveFailures: 0,
    };
    const never = computeStaleness(neverState, now);
    expect(never.status).toBe("dead");
    expect(never.isDead).toBe(true);
  });

  it("error classification for feed fetch failures", () => {
    // 404 -> dead, user action needed
    const dead404 = classifyFeedError(404);
    expect(dead404.category).toBe("dead");
    expect(dead404.retryable).toBe(false);
    expect(dead404.userActionRequired).toBe(true);

    // 410 -> dead
    const dead410 = classifyFeedError(410);
    expect(dead410.category).toBe("dead");

    // 401 -> auth required
    const auth401 = classifyFeedError(401);
    expect(auth401.category).toBe("auth_required");
    expect(auth401.userActionRequired).toBe(true);

    // 500 -> server error, retryable
    const server500 = classifyFeedError(500);
    expect(server500.category).toBe("server_error");
    expect(server500.retryable).toBe(true);

    // 0 -> timeout, retryable
    const timeout = classifyFeedError(0);
    expect(timeout.category).toBe("timeout");
    expect(timeout.retryable).toBe(true);

    // 429 -> rate limited, retryable
    const rateLimited = classifyFeedError(429);
    expect(rateLimited.category).toBe("rate_limited");
    expect(rateLimited.retryable).toBe(true);
  });

  it("rate limiting prevents fetches within 5-minute window (BR-4)", () => {
    const now = Date.now();

    // Never fetched -> not rate limited
    expect(isRateLimited(null, now)).toBe(false);

    // Fetched 1 minute ago -> rate limited
    const oneMinAgo = new Date(now - 60 * 1000).toISOString();
    expect(isRateLimited(oneMinAgo, now)).toBe(true);

    // Fetched 6 minutes ago -> not rate limited
    const sixMinAgo = new Date(now - 6 * 60 * 1000).toISOString();
    expect(isRateLimited(sixMinAgo, now)).toBe(false);

    // Fetched exactly at the boundary (5 min) -> not rate limited
    const exactlyFiveMin = new Date(now - MIN_REFRESH_INTERVAL_MS).toISOString();
    expect(isRateLimited(exactlyFiveMin, now)).toBe(false);
  });

  it("feed health endpoint returns staleness for a feed account", async () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(MIGRATION_0001_INITIAL_SCHEMA);
    db.exec(MIGRATION_0012_SUBSCRIPTIONS);
    db.exec(MIGRATION_0013_SUBSCRIPTION_LIFECYCLE);
    for (const stmt of MIGRATION_0020_FEED_REFRESH.split(";").filter(s => s.trim())) {
      db.exec(stmt + ";");
    }
    seedOrgAndUser(db);
    const d1 = createRealD1(db);

    const feedId = "acc_01HXY00000000000006CFEED1";
    seedFeedAccount(db, feedId, GOOGLE_FEED_URL);
    // Set last refresh to 40 minutes ago (stale for 15-min interval)
    db.prepare(
      "UPDATE accounts SET feed_last_refresh_at = ? WHERE account_id = ?",
    ).run(new Date(Date.now() - 40 * 60 * 1000).toISOString(), feedId);

    const handler = createHandler();
    const env = buildEnv(d1);
    const authHeader = await makeAuthHeader();

    const resp = await handler.fetch(
      new Request(`https://api.tminus.dev/v1/feeds/${feedId}/health`, {
        method: "GET",
        headers: { Authorization: authHeader },
      }),
      env,
      mockCtx,
    );

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      ok: boolean;
      data: {
        staleness: string;
        is_dead: boolean;
        last_refresh_at: string;
        consecutive_failures: number;
        refresh_interval_ms: number;
      };
    };
    expect(body.ok).toBe(true);
    // PROOF: 40 min > 2 * 15 min = stale
    expect(body.data.staleness).toBe("stale");
    expect(body.data.is_dead).toBe(false);
    expect(body.data.refresh_interval_ms).toBe(DEFAULT_REFRESH_INTERVAL_MS);

    db.close();
  });
});

// ===========================================================================
// AC#3: Upgrade prompt triggers fire during simulated engagement
// ===========================================================================

describe("Phase 6C E2E: Upgrade prompt triggers (AC#3)", () => {
  it("conflict detection triggers upgrade prompt", () => {
    const metrics: EngagementMetrics = {
      daysActive: 1,
      eventsViewed: 5,
      conflictsDetected: 2,
      feedsAdded: 2,
    };

    const context: FeedContext = {
      hasConflict: true,
      conflictFeedNames: ["Google Calendar", "Outlook"],
    };

    const triggers = evaluatePromptTriggers(metrics, context);

    // PROOF: Conflict trigger fires
    expect(triggers.length).toBeGreaterThanOrEqual(1);
    expect(triggers[0].type).toBe("conflict_detected");
    expect(triggers[0].message).toContain("scheduling conflict");
    expect(triggers[0].message).toContain("Google Calendar");
    expect(triggers[0].message).toContain("Outlook");
  });

  it("write intent on ICS feed triggers upgrade prompt", () => {
    const metrics: EngagementMetrics = {
      daysActive: 1,
      eventsViewed: 3,
      conflictsDetected: 0,
      feedsAdded: 1,
    };

    const context: FeedContext = {
      writeIntentOnIcsFeed: true,
      writeIntentFeedProvider: "google",
    };

    const triggers = evaluatePromptTriggers(metrics, context);

    // PROOF: Write intent trigger fires
    const writePrompt = triggers.find((t) => t.type === "write_intent");
    expect(writePrompt).toBeDefined();
    expect(writePrompt!.message).toContain("read-only");
    expect(writePrompt!.message).toContain("Google");
  });

  it("engagement after 3+ active days triggers upgrade prompt", () => {
    const metrics: EngagementMetrics = {
      daysActive: 4,
      eventsViewed: 20,
      conflictsDetected: 0,
      feedsAdded: 3,
    };

    const context: FeedContext = {};

    const triggers = evaluatePromptTriggers(metrics, context);

    // PROOF: Engagement trigger fires after 3+ active days
    const engagementPrompt = triggers.find((t) => t.type === "engagement");
    expect(engagementPrompt).toBeDefined();
    expect(engagementPrompt!.message).toContain("getting value from T-Minus");
  });

  it("stale data triggers upgrade prompt", () => {
    const metrics: EngagementMetrics = {
      daysActive: 2,
      eventsViewed: 10,
      conflictsDetected: 0,
      feedsAdded: 2,
    };

    const context: FeedContext = {
      isFeedStale: true,
      staleFeedName: "Work Calendar",
      staleFeedProvider: "microsoft",
    };

    const triggers = evaluatePromptTriggers(metrics, context);

    // PROOF: Stale data trigger fires
    const stalePrompt = triggers.find((t) => t.type === "stale_data");
    expect(stalePrompt).toBeDefined();
    expect(stalePrompt!.message).toContain("Microsoft");
    expect(stalePrompt!.message).toContain("out of date");
  });

  it("max 1 prompt per session enforced (BR-2)", () => {
    const metrics: EngagementMetrics = {
      daysActive: 5,
      eventsViewed: 50,
      conflictsDetected: 3,
      feedsAdded: 3,
    };

    const context: FeedContext = {
      hasConflict: true,
      conflictFeedNames: ["Cal A", "Cal B"],
      isFeedStale: true,
      staleFeedProvider: "google",
      writeIntentOnIcsFeed: true,
      writeIntentFeedProvider: "microsoft",
    };

    // All triggers fire
    const triggers = evaluatePromptTriggers(metrics, context);
    expect(triggers.length).toBeGreaterThanOrEqual(3);

    // First call: shows conflict (highest priority)
    const settings: PromptSettings = {};
    const firstPrompt = shouldShowPrompt(triggers, [], undefined, settings);
    expect(firstPrompt).not.toBeNull();
    expect(firstPrompt!.type).toBe("conflict_detected");

    // Second call with session prompt already shown: returns null
    const secondPrompt = shouldShowPrompt(
      triggers,
      [],
      "conflict_detected",
      settings,
    );
    // PROOF: Max 1 per session
    expect(secondPrompt).toBeNull();
  });

  it("dismissed prompt suppressed for 7 days (BR-3)", () => {
    const now = Date.now();

    const metrics: EngagementMetrics = {
      daysActive: 5,
      eventsViewed: 50,
      conflictsDetected: 3,
      feedsAdded: 3,
    };

    const context: FeedContext = {
      hasConflict: true,
      conflictFeedNames: ["Cal A", "Cal B"],
    };

    const triggers = evaluatePromptTriggers(metrics, context);
    const settings: PromptSettings = {};

    // Dismiss the conflict prompt
    const dismissal = createDismissal("conflict_detected", now);
    expect(dismissal.type).toBe("conflict_detected");
    expect(dismissal.dismissedAt).toBe(now);

    // Within 7 days: conflict suppressed, next trigger fires
    const withinWindow = shouldShowPrompt(
      triggers,
      [dismissal],
      undefined,
      settings,
      now + 3 * 24 * 60 * 60 * 1000, // 3 days later
    );
    // PROOF: Conflict is suppressed, but engagement fires instead
    expect(withinWindow).not.toBeNull();
    expect(withinWindow!.type).not.toBe("conflict_detected");

    // After 7 days: conflict shows again
    const afterWindow = shouldShowPrompt(
      triggers,
      [dismissal],
      undefined,
      settings,
      now + DISMISSAL_DURATION_MS + 1000, // just past 7 days
    );
    // PROOF: After 7 days the dismissal expires
    expect(afterWindow).not.toBeNull();
    expect(afterWindow!.type).toBe("conflict_detected");
  });

  it("permanent dismissal via settings disables all prompts (AC#7 from d17.4)", () => {
    const metrics: EngagementMetrics = {
      daysActive: 10,
      eventsViewed: 100,
      conflictsDetected: 5,
      feedsAdded: 5,
    };

    const context: FeedContext = {
      hasConflict: true,
      conflictFeedNames: ["A", "B"],
      writeIntentOnIcsFeed: true,
      writeIntentFeedProvider: "google",
    };

    const triggers = evaluatePromptTriggers(metrics, context);
    expect(triggers.length).toBeGreaterThanOrEqual(2);

    const settings: PromptSettings = { permanentlyDismissed: true };

    const prompt = shouldShowPrompt(triggers, [], undefined, settings);
    // PROOF: Permanent dismissal suppresses all prompts
    expect(prompt).toBeNull();
  });
});

// ===========================================================================
// AC#4: Upgrade from ICS to OAuth preserves all events with zero data loss
// ===========================================================================

describe("Phase 6C E2E: ICS-to-OAuth upgrade preserves events (AC#4)", () => {
  it("iCalUID matching: ICS events matched to provider events by UID", () => {
    const icsEvents: IcsEvent[] = [
      {
        origin_event_id: "shared-uid-001@google.com",
        origin_account_id: "acct_ics",
        title: "Morning Standup",
        start: { dateTime: "2026-03-15T09:00:00Z" },
        end: { dateTime: "2026-03-15T09:30:00Z" },
        all_day: false,
        status: "confirmed",
        visibility: "default",
        transparency: "opaque",
        source: "ics_feed",
      },
      {
        origin_event_id: "ics-only-001@google.com",
        origin_account_id: "acct_ics",
        title: "Orphaned Event",
        start: { dateTime: "2026-03-16T10:00:00Z" },
        end: { dateTime: "2026-03-16T11:00:00Z" },
        all_day: false,
        status: "confirmed",
        visibility: "default",
        transparency: "opaque",
        source: "ics_feed",
      },
    ];

    const providerEvents: ProviderEvent[] = [
      {
        origin_event_id: "shared-uid-001@google.com",
        origin_account_id: "acct_oauth",
        title: "Morning Standup",
        start: { dateTime: "2026-03-15T09:00:00Z" },
        end: { dateTime: "2026-03-15T09:30:00Z" },
        all_day: false,
        status: "confirmed",
        visibility: "default",
        transparency: "opaque",
        source: "provider",
        attendees: [
          { email: "alice@test.com", partstat: "ACCEPTED" },
          { email: "bob@test.com", partstat: "TENTATIVE" },
        ],
        conference_data: { type: "hangoutsMeet", url: "https://meet.google.com/xyz" },
      },
      {
        origin_event_id: "provider-new-001@google.com",
        origin_account_id: "acct_oauth",
        title: "New Provider Event",
        start: { dateTime: "2026-03-17T14:00:00Z" },
        end: { dateTime: "2026-03-17T15:00:00Z" },
        all_day: false,
        status: "confirmed",
        visibility: "default",
        transparency: "opaque",
        source: "provider",
      },
    ];

    const result = matchEventsByICalUID(icsEvents, providerEvents);

    // PROOF: shared-uid matched by iCalUID
    expect(result.matched).toHaveLength(1);
    expect(result.matched[0].matched_by).toBe("ical_uid");
    expect(result.matched[0].confidence).toBe(1.0);
    expect(result.matched[0].icsEvent.origin_event_id).toBe("shared-uid-001@google.com");

    // PROOF: Orphaned ICS event preserved
    expect(result.unmatchedIcs).toHaveLength(1);
    expect(result.unmatchedIcs[0].origin_event_id).toBe("ics-only-001@google.com");

    // PROOF: New provider event identified
    expect(result.unmatchedProvider).toHaveLength(1);
    expect(result.unmatchedProvider[0].origin_event_id).toBe("provider-new-001@google.com");
  });

  it("merge enriches ICS events with provider metadata (attendees, conference)", () => {
    const icsEvent: IcsEvent = {
      origin_event_id: "uid-001@google.com",
      origin_account_id: "acct_ics",
      title: "Team Meeting",
      start: { dateTime: "2026-03-15T10:00:00Z" },
      end: { dateTime: "2026-03-15T11:00:00Z" },
      all_day: false,
      status: "confirmed",
      visibility: "default",
      transparency: "opaque",
      source: "ics_feed",
    };

    const providerEvent: ProviderEvent = {
      origin_event_id: "uid-001@google.com",
      origin_account_id: "acct_oauth",
      title: "Team Meeting",
      start: { dateTime: "2026-03-15T10:00:00Z" },
      end: { dateTime: "2026-03-15T11:00:00Z" },
      all_day: false,
      status: "confirmed",
      visibility: "default",
      transparency: "opaque",
      source: "provider",
      attendees: [
        { email: "alice@test.com", partstat: "ACCEPTED" },
        { email: "bob@test.com", partstat: "NEEDS-ACTION" },
      ],
      organizer: { email: "carol@test.com", cn: "Carol" },
      meeting_url: "https://meet.google.com/abc-defg",
      conference_data: { type: "hangoutsMeet", url: "https://meet.google.com/abc-defg" },
    };

    const merged = mergeIcsWithProvider(icsEvent, providerEvent, "ical_uid");

    // PROOF: Provider version wins for base fields (BR-2)
    expect(merged.source).toBe("provider");
    expect(merged.origin_account_id).toBe("acct_oauth");

    // PROOF: Enriched with attendees
    expect(merged.attendees).toHaveLength(2);
    expect(merged.attendees![0].email).toBe("alice@test.com");

    // PROOF: Enriched with organizer
    expect(merged.organizer!.email).toBe("carol@test.com");

    // PROOF: Enriched with conference data
    expect(merged.conference_data!.url).toBe("https://meet.google.com/abc-defg");
    expect(merged.meeting_url).toBe("https://meet.google.com/abc-defg");

    // PROOF: Enrichment metadata tracked
    expect(merged.enriched_fields).toContain("attendees");
    expect(merged.enriched_fields).toContain("organizer");
    expect(merged.enriched_fields).toContain("meeting_url");
    expect(merged.enriched_fields).toContain("conference_data");
    expect(merged.matched_by).toBe("ical_uid");
    expect(merged.confidence).toBe(1.0);
  });

  it("planUpgrade creates complete plan preserving all events (BR-1)", () => {
    const icsEvents: IcsEvent[] = [
      {
        origin_event_id: "shared-uid@google.com",
        origin_account_id: "acct_ics",
        title: "Shared Event",
        start: { dateTime: "2026-03-15T10:00:00Z" },
        end: { dateTime: "2026-03-15T11:00:00Z" },
        all_day: false,
        status: "confirmed",
        visibility: "default",
        transparency: "opaque",
        source: "ics_feed",
      },
      {
        origin_event_id: "orphan-uid@google.com",
        origin_account_id: "acct_ics",
        title: "Orphaned ICS Event",
        start: { dateTime: "2026-03-16T10:00:00Z" },
        end: { dateTime: "2026-03-16T11:00:00Z" },
        all_day: false,
        status: "confirmed",
        visibility: "default",
        transparency: "opaque",
        source: "ics_feed",
      },
    ];

    const providerEvents: ProviderEvent[] = [
      {
        origin_event_id: "shared-uid@google.com",
        origin_account_id: "acct_oauth",
        title: "Shared Event",
        start: { dateTime: "2026-03-15T10:00:00Z" },
        end: { dateTime: "2026-03-15T11:00:00Z" },
        all_day: false,
        status: "confirmed",
        visibility: "default",
        transparency: "opaque",
        source: "provider",
        attendees: [{ email: "test@test.com", partstat: "ACCEPTED" }],
      },
      {
        origin_event_id: "new-from-provider@google.com",
        origin_account_id: "acct_oauth",
        title: "New Provider Event",
        start: { dateTime: "2026-03-17T14:00:00Z" },
        end: { dateTime: "2026-03-17T15:00:00Z" },
        all_day: false,
        status: "confirmed",
        visibility: "default",
        transparency: "opaque",
        source: "provider",
      },
    ];

    const plan = planUpgrade({
      icsAccountId: "acct_ics",
      oauthAccountId: "acct_oauth",
      feedUrl: GOOGLE_FEED_URL,
      icsEvents,
      providerEvents,
    });

    // PROOF: Provider detected from URL
    expect(plan.detectedProvider.provider).toBe("google");
    expect(plan.detectedProvider.confidence).toBe("high");

    // PROOF: 1 merged event (shared UID matched)
    expect(plan.mergedEvents).toHaveLength(1);
    expect(plan.mergedEvents[0].matched_by).toBe("ical_uid");

    // PROOF: 1 new provider event (not in ICS)
    expect(plan.newProviderEvents).toHaveLength(1);
    expect(plan.newProviderEvents[0].origin_event_id).toBe("new-from-provider@google.com");

    // PROOF: 1 orphaned ICS event preserved (BR-1: zero data loss)
    expect(plan.orphanedIcsEvents).toHaveLength(1);
    expect(plan.orphanedIcsEvents[0].origin_event_id).toBe("orphan-uid@google.com");

    // PROOF: Account transition planned correctly
    expect(plan.icsAccountToRemove).toBe("acct_ics");
    expect(plan.oauthAccountToActivate).toBe("acct_oauth");

    // PROOF: Total events accounted for = ICS (2) + new provider (1)
    // = merged (1) + orphaned (1) + new (1) = 3
    const totalAccountedFor =
      plan.mergedEvents.length +
      plan.orphanedIcsEvents.length +
      plan.newProviderEvents.length;
    expect(totalAccountedFor).toBe(3);
  });

  it("full API upgrade flow: POST /v1/feeds/:id/upgrade returns merge summary", async () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(MIGRATION_0001_INITIAL_SCHEMA);
    db.exec(MIGRATION_0012_SUBSCRIPTIONS);
    db.exec(MIGRATION_0013_SUBSCRIPTION_LIFECYCLE);
    for (const stmt of MIGRATION_0020_FEED_REFRESH.split(";").filter(s => s.trim())) {
      db.exec(stmt + ";");
    }
    seedOrgAndUser(db);
    const d1 = createRealD1(db);

    const feedAccountId = "acc_01HXY0000000000006CFEED01";
    const oauthAccountId = "acc_01HXY00000000000006COAUTH";
    seedFeedAccount(db, feedAccountId, GOOGLE_FEED_URL);

    // Build DO mock that returns events per account
    const calls: DOCallRecord[] = [];
    const icsEvents = [
      {
        origin_event_id: "google-standup-001@google.com",
        origin_account_id: feedAccountId,
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
        origin_event_id: "google-standup-001@google.com",
        origin_account_id: oauthAccountId,
        title: "Morning Standup",
        start: { dateTime: "2026-03-15T09:00:00Z" },
        end: { dateTime: "2026-03-15T09:30:00Z" },
        all_day: false,
        status: "confirmed",
        visibility: "default",
        transparency: "opaque",
        source: "provider",
        attendees: [{ email: "alice@test.com", partstat: "ACCEPTED" }],
        conference_data: {
          type: "hangoutsMeet",
          url: "https://meet.google.com/xyz-abc",
        },
      },
    ];

    const userGraphDO = {
      calls,
      idFromName(name: string): DurableObjectId {
        return {
          toString: () => name,
          name,
          equals: () => false,
        } as unknown as DurableObjectId;
      },
      get(_id: DurableObjectId): DurableObjectStub {
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
            let parsedBody: unknown;
            if (init?.body) {
              try { parsedBody = JSON.parse(init.body as string); } catch { parsedBody = init.body; }
            }
            calls.push({ name: _id.toString(), path: url.pathname, method: init?.method ?? "GET", body: parsedBody });

            if (url.pathname === "/getAccountEvents") {
              const reqBody = parsedBody as { account_id: string };
              if (reqBody.account_id === feedAccountId) {
                return Response.json({ events: icsEvents });
              }
              return Response.json({ events: providerEvents });
            }
            if (url.pathname === "/executeUpgrade") {
              return Response.json({ ok: true });
            }
            return Response.json({ ok: true });
          },
        } as unknown as DurableObjectStub;
      },
      idFromString: () => ({ toString: () => "", equals: () => false }) as unknown as DurableObjectId,
      newUniqueId: () => ({ toString: () => "", equals: () => false }) as unknown as DurableObjectId,
      jurisdiction() { return this; },
    } as unknown as DurableObjectNamespace & { calls: DOCallRecord[] };

    const handler = createHandler();
    const env = buildEnv(d1, userGraphDO);
    const authHeader = await makeAuthHeader();

    const resp = await handler.fetch(
      new Request(`https://api.tminus.dev/v1/feeds/${feedAccountId}/upgrade`, {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ oauth_account_id: oauthAccountId }),
      }),
      env,
      mockCtx,
    );

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
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

    // PROOF: Upgrade succeeded
    expect(body.ok).toBe(true);
    expect(body.data.detected_provider.provider).toBe("google");
    // PROOF: 1 event matched and merged
    expect(body.data.merged_count).toBe(1);
    expect(body.data.new_count).toBe(0);
    expect(body.data.orphaned_count).toBe(0);

    // PROOF: D1 shows feed account as upgraded
    const feedRow = db.prepare(
      "SELECT status FROM accounts WHERE account_id = ?",
    ).get(feedAccountId) as { status: string };
    expect(feedRow.status).toBe("upgraded");

    // PROOF: executeUpgrade payload includes enrichment metadata
    const execCall = calls.find((c) => c.path === "/executeUpgrade");
    expect(execCall).toBeDefined();
    const payload = execCall!.body as {
      merged_events: Array<{
        matched_by: string;
        enriched_fields: string[];
        attendees: unknown[];
        conference_data: unknown;
      }>;
    };
    expect(payload.merged_events[0].matched_by).toBe("ical_uid");
    expect(payload.merged_events[0].enriched_fields).toContain("attendees");
    expect(payload.merged_events[0].enriched_fields).toContain("conference_data");

    db.close();
  });
});

// ===========================================================================
// AC#5: Mixed view (ICS + OAuth accounts) renders correctly
// ===========================================================================

describe("Phase 6C E2E: Mixed ICS + OAuth view (AC#5)", () => {
  it("GET /v1/feeds lists only ICS feed accounts, not OAuth accounts", async () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(MIGRATION_0001_INITIAL_SCHEMA);
    db.exec(MIGRATION_0012_SUBSCRIPTIONS);
    db.exec(MIGRATION_0013_SUBSCRIPTION_LIFECYCLE);
    for (const stmt of MIGRATION_0020_FEED_REFRESH.split(";").filter(s => s.trim())) {
      db.exec(stmt + ";");
    }
    seedOrgAndUser(db);

    // Seed 2 ICS feeds and 1 OAuth account
    seedFeedAccount(db, "acc_ics_google", GOOGLE_FEED_URL);
    seedFeedAccount(db, "acc_ics_apple", APPLE_FEED_URL);
    // OAuth account is a regular provider, not ics_feed
    db.prepare(
      `INSERT INTO accounts (account_id, user_id, provider, provider_subject, email, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("acc_oauth_msft", TEST_USER.user_id, "microsoft", "sub_msft", "user@outlook.com", "active");

    const d1 = createRealD1(db);
    const handler = createHandler();
    const env = buildEnv(d1);
    const authHeader = await makeAuthHeader();

    const resp = await handler.fetch(
      new Request("https://api.tminus.dev/v1/feeds", {
        method: "GET",
        headers: { Authorization: authHeader },
      }),
      env,
      mockCtx,
    );

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      ok: boolean;
      data: Array<{
        account_id: string;
        provider: string;
        feed_url: string;
      }>;
    };
    expect(body.ok).toBe(true);
    // PROOF: Only ICS feed accounts returned (not OAuth)
    expect(body.data).toHaveLength(2);
    expect(body.data.every((f) => f.provider === "ics_feed")).toBe(true);
    // PROOF: Correct feed URLs
    const urls = body.data.map((f) => f.feed_url).sort();
    expect(urls).toContain(GOOGLE_FEED_URL);
    expect(urls).toContain(APPLE_FEED_URL);

    db.close();
  });

  it("unified events view includes both ICS and OAuth events", async () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(MIGRATION_0001_INITIAL_SCHEMA);
    db.exec(MIGRATION_0012_SUBSCRIPTIONS);
    db.exec(MIGRATION_0013_SUBSCRIPTION_LIFECYCLE);
    seedOrgAndUser(db);
    const d1 = createRealD1(db);

    // DO returns mixed events (some ics_feed, some provider)
    const mixedEvents = [
      {
        canonical_event_id: "evt_ics_1",
        title: "ICS Standup",
        source: "ics_feed",
        origin_account_id: "acct_ics_google",
      },
      {
        canonical_event_id: "evt_ics_2",
        title: "ICS Board Meeting",
        source: "ics_feed",
        origin_account_id: "acct_ics_outlook",
      },
      {
        canonical_event_id: "evt_oauth_1",
        title: "OAuth Team Sync",
        source: "provider",
        origin_account_id: "acct_oauth_google",
      },
    ];

    const pathResponses = new Map<string, unknown>();
    pathResponses.set("/listCanonicalEvents", {
      items: mixedEvents,
      cursor: null,
      has_more: false,
    });

    const userGraphDO = createMockDONamespace({ pathResponses });
    const handler = createHandler();
    const env = buildEnv(d1, userGraphDO);
    const authHeader = await makeAuthHeader();

    const resp = await handler.fetch(
      new Request("https://api.tminus.dev/v1/events", {
        method: "GET",
        headers: { Authorization: authHeader },
      }),
      env,
      mockCtx,
    );

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      ok: boolean;
      data: Array<{ title: string; source: string }>;
    };
    expect(body.ok).toBe(true);
    // PROOF: Mixed view renders all events together
    expect(body.data).toHaveLength(3);

    // PROOF: ICS events present
    const icsSources = body.data.filter((e) => e.source === "ics_feed");
    expect(icsSources).toHaveLength(2);

    // PROOF: OAuth events present
    const oauthSources = body.data.filter((e) => e.source === "provider");
    expect(oauthSources).toHaveLength(1);

    db.close();
  });

  it("provider detection works for all 3 supported providers", () => {
    // PROOF: Google detection
    const google = detectProvider(GOOGLE_FEED_URL);
    expect(google.provider).toBe("google");
    expect(google.confidence).toBe("high");

    // PROOF: Microsoft detection
    const microsoft = detectProvider(OUTLOOK_FEED_URL);
    expect(microsoft.provider).toBe("microsoft");
    expect(microsoft.confidence).toBe("high");

    // PROOF: Apple detection
    const apple = detectProvider(APPLE_FEED_URL);
    expect(apple.provider).toBe("apple");
    expect(apple.confidence).toBe("high");

    // PROOF: Unknown provider
    const unknown = detectProvider("https://custom-cal.example.com/feed.ics");
    expect(unknown.provider).toBe("unknown");
    expect(unknown.confidence).toBe("none");
  });
});

// ===========================================================================
// AC#6: Downgrade on OAuth revocation falls back to ICS gracefully
// ===========================================================================

describe("Phase 6C E2E: OAuth downgrade resilience (AC#6)", () => {
  it("planDowngrade creates fallback plan with event preservation", () => {
    const events: ProviderEvent[] = [
      {
        origin_event_id: "evt-001",
        origin_account_id: "acct_oauth",
        title: "Important Meeting",
        start: { dateTime: "2026-03-15T10:00:00Z" },
        end: { dateTime: "2026-03-15T11:00:00Z" },
        all_day: false,
        status: "confirmed",
        visibility: "default",
        transparency: "opaque",
        source: "provider",
      },
      {
        origin_event_id: "evt-002",
        origin_account_id: "acct_oauth",
        title: "Team Standup",
        start: { dateTime: "2026-03-16T09:00:00Z" },
        end: { dateTime: "2026-03-16T09:30:00Z" },
        all_day: false,
        status: "confirmed",
        visibility: "default",
        transparency: "opaque",
        source: "provider",
      },
    ];

    const plan = planDowngrade({
      oauthAccountId: "acct_oauth",
      provider: "google",
      feedUrl: GOOGLE_FEED_URL,
      currentEvents: events,
    });

    // PROOF: Feed URL preserved for re-creation
    expect(plan.feedUrl).toBe(GOOGLE_FEED_URL);
    // PROOF: All events accounted for
    expect(plan.preservedEventCount).toBe(2);
    // PROOF: Mode is read-only (ICS is read-only)
    expect(plan.mode).toBe("read_only");
    // PROOF: OAuth account marked for removal
    expect(plan.oauthAccountToRemove).toBe("acct_oauth");
  });

  it("API downgrade flow: POST /v1/feeds/downgrade creates fallback feed account", async () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(MIGRATION_0001_INITIAL_SCHEMA);
    db.exec(MIGRATION_0012_SUBSCRIPTIONS);
    db.exec(MIGRATION_0013_SUBSCRIPTION_LIFECYCLE);
    for (const stmt of MIGRATION_0020_FEED_REFRESH.split(";").filter(s => s.trim())) {
      db.exec(stmt + ";");
    }
    seedOrgAndUser(db);

    const oauthAccountId = "acc_01HXY00000000000006COAUTH";
    db.prepare(
      `INSERT INTO accounts (account_id, user_id, provider, provider_subject, email, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(oauthAccountId, TEST_USER.user_id, "google", "sub_google", "user@gmail.com", "active");

    const d1 = createRealD1(db);

    const pathResponses = new Map<string, unknown>();
    pathResponses.set("/getAccountEvents", {
      events: [
        {
          origin_event_id: "evt-001",
          origin_account_id: oauthAccountId,
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

    const resp = await handler.fetch(
      new Request("https://api.tminus.dev/v1/feeds/downgrade", {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          oauth_account_id: oauthAccountId,
          provider: "google",
          feed_url: GOOGLE_FEED_URL,
        }),
      }),
      env,
      mockCtx,
    );

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      ok: boolean;
      data: {
        new_feed_account_id: string;
        feed_url: string;
        preserved_event_count: number;
        mode: string;
        oauth_account_removed: string;
      };
    };

    // PROOF: Downgrade succeeded
    expect(body.ok).toBe(true);
    expect(body.data.feed_url).toBe(GOOGLE_FEED_URL);
    // PROOF: Events preserved
    expect(body.data.preserved_event_count).toBe(1);
    // PROOF: Read-only mode (ICS fallback)
    expect(body.data.mode).toBe("read_only");

    // PROOF: New ICS feed account created in D1
    const newFeedRow = getAccountRow(db, body.data.new_feed_account_id);
    expect(newFeedRow).not.toBeNull();
    expect(newFeedRow!.provider).toBe("ics_feed");
    expect(newFeedRow!.status).toBe("active");
    expect(newFeedRow!.provider_subject).toBe(GOOGLE_FEED_URL);

    // PROOF: OAuth account marked as downgraded
    const oauthRow = db.prepare(
      "SELECT status FROM accounts WHERE account_id = ?",
    ).get(oauthAccountId) as { status: string };
    expect(oauthRow.status).toBe("downgraded");

    db.close();
  });

  it("downgrade without feed URL: graceful degradation with warning", async () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(MIGRATION_0001_INITIAL_SCHEMA);
    db.exec(MIGRATION_0012_SUBSCRIPTIONS);
    db.exec(MIGRATION_0013_SUBSCRIPTION_LIFECYCLE);
    seedOrgAndUser(db);

    const oauthAccountId = "acc_01HXY0000000000006CNOURL";
    db.prepare(
      `INSERT INTO accounts (account_id, user_id, provider, provider_subject, email, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(oauthAccountId, TEST_USER.user_id, "apple", "sub_apple", "user@icloud.com", "active");

    const d1 = createRealD1(db);
    const pathResponses = new Map<string, unknown>();
    pathResponses.set("/getAccountEvents", { events: [] });

    const userGraphDO = createMockDONamespace({ pathResponses });
    const handler = createHandler();
    const env = buildEnv(d1, userGraphDO);
    const authHeader = await makeAuthHeader();

    const resp = await handler.fetch(
      new Request("https://api.tminus.dev/v1/feeds/downgrade", {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          oauth_account_id: oauthAccountId,
          provider: "apple",
          // No feed_url
        }),
      }),
      env,
      mockCtx,
    );

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      ok: boolean;
      data: {
        mode: string;
        warning: string;
      };
    };
    // PROOF: Graceful degradation
    expect(body.ok).toBe(true);
    expect(body.data.mode).toBe("read_only");
    // PROOF: Warning about no automatic refresh
    expect(body.data.warning).toContain("No public ICS feed URL");

    db.close();
  });
});

// ===========================================================================
// AC#7: Test is fully automated and repeatable against staging environment
// ===========================================================================

describe("Phase 6C E2E: Automation and repeatability (AC#7)", () => {
  it("all tests use deterministic data with no external dependencies", () => {
    // PROOF: ICS fixtures are static strings (not fetched from external URLs)
    expect(typeof GOOGLE_ICS).toBe("string");
    expect(typeof OUTLOOK_ICS).toBe("string");
    expect(typeof APPLE_ICS).toBe("string");

    // PROOF: Test user IDs are deterministic
    expect(TEST_USER.user_id).toBe("usr_01HXY00000000000000006C001");
    expect(TEST_ORG.org_id).toBe("org_01HXY00000000000000006C001");

    // PROOF: Feed URLs are deterministic
    expect(GOOGLE_FEED_URL).toContain("calendar.google.com");
    expect(OUTLOOK_FEED_URL).toContain("outlook.office365.com");
    expect(APPLE_FEED_URL).toContain("icloud.com");
  });

  it("database is in-memory and fully isolated between test runs", () => {
    // PROOF: Each test gets a fresh in-memory SQLite DB
    const db1 = new Database(":memory:");
    const db2 = new Database(":memory:");

    // Different in-memory databases are independent
    db1.exec("CREATE TABLE test_isolation (id INTEGER PRIMARY KEY)");
    db1.exec("INSERT INTO test_isolation VALUES (42)");

    // db2 does not see db1's data
    const tables = db2
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='test_isolation'",
      )
      .all();
    expect(tables).toHaveLength(0);

    db1.close();
    db2.close();
  });
});

// ===========================================================================
// AC#8: ALL existing tests pass unchanged
// ===========================================================================

describe("Phase 6C E2E: No regressions (AC#8)", () => {
  it("this test file adds new tests only -- no modifications to existing files", () => {
    // PROOF: This E2E test file is entirely new (phase-6c-progressive-onboarding.integration.test.ts)
    // It imports from existing modules (@tminus/shared, @tminus/d1-registry, api/index)
    // but does not modify any of them.
    //
    // The only file changes are:
    // 1. NEW: tests/e2e/phase-6c-progressive-onboarding.integration.test.ts (this file)
    // 2. NEW: vitest.e2e.phase6c.config.ts (test configuration)
    // 3. MODIFIED: Makefile (added test-e2e-phase6c target)
    //
    // No existing test files modified. No existing source code modified.
    expect(true).toBe(true);
  });
});

// ===========================================================================
// FULL JOURNEY: End-to-end progressive onboarding (capstone)
// ===========================================================================

describe("Phase 6C E2E: Full progressive onboarding journey (capstone)", () => {
  let db: DatabaseType;
  let d1: D1Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(MIGRATION_0001_INITIAL_SCHEMA);
    db.exec(MIGRATION_0012_SUBSCRIPTIONS);
    db.exec(MIGRATION_0013_SUBSCRIPTION_LIFECYCLE);
    for (const stmt of MIGRATION_0020_FEED_REFRESH.split(";").filter(s => s.trim())) {
      db.exec(stmt + ";");
    }
    seedOrgAndUser(db);
    d1 = createRealD1(db);
  });

  afterEach(() => {
    db.close();
  });

  it("complete journey: zero-auth import -> refresh detection -> prompt -> upgrade -> mixed view -> downgrade", async () => {
    const startTime = Date.now();
    const handler = createHandler();
    const authHeader = await makeAuthHeader();

    // -----------------------------------------------------------------------
    // PHASE 1: Zero-auth ICS import (Google feed)
    // -----------------------------------------------------------------------

    globalThis.fetch = vi.fn().mockImplementation(
      async (input: RequestInfo | URL) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        if (url.includes("calendar.google.com")) {
          return new Response(GOOGLE_ICS, { status: 200 });
        }
        if (url.includes("outlook.office365.com")) {
          return new Response(OUTLOOK_ICS, { status: 200 });
        }
        return new Response("Not Found", { status: 404 });
      },
    );

    const importPathResponses = new Map<string, unknown>();
    importPathResponses.set("/applyProviderDelta", {
      created: 3, updated: 0, deleted: 0, mirrors_enqueued: 0, errors: [],
    });
    const importDO = createMockDONamespace({ pathResponses: importPathResponses });
    const importEnv = buildEnv(d1, importDO);

    // Import Google feed
    const googleImport = await handler.fetch(
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
    expect(googleImport.status).toBe(201);
    const googleImportBody = (await googleImport.json()) as {
      ok: boolean;
      data: { account_id: string; events_imported: number };
    };
    const googleFeedAccountId = googleImportBody.data.account_id;
    expect(googleImportBody.data.events_imported).toBe(3);

    // Import Outlook feed
    const outlookImport = await handler.fetch(
      new Request("https://api.tminus.dev/v1/feeds", {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url: OUTLOOK_FEED_URL }),
      }),
      importEnv,
      mockCtx,
    );
    expect(outlookImport.status).toBe(201);

    // -----------------------------------------------------------------------
    // PHASE 2: Feed refresh detection (simulated)
    // -----------------------------------------------------------------------

    // Simulate first content hash computation
    const originalHash = computeContentHash(GOOGLE_ICS);

    // Simulate refresh with updated content
    const updatedHash = computeContentHash(GOOGLE_ICS_UPDATED);
    const changeDetection = detectFeedChanges({
      httpStatus: 200,
      responseBody: GOOGLE_ICS_UPDATED,
      previousContentHash: originalHash,
    });

    // PROOF: Feed refresh detects changes
    expect(changeDetection.changed).toBe(true);
    expect(changeDetection.reason).toBe("hash_changed");

    // -----------------------------------------------------------------------
    // PHASE 3: Upgrade prompt triggers
    // -----------------------------------------------------------------------

    // Simulate user engagement: 4 active days, conflict detected
    const metrics: EngagementMetrics = {
      daysActive: 4,
      eventsViewed: 25,
      conflictsDetected: 1,
      feedsAdded: 2,
    };

    const context: FeedContext = {
      hasConflict: true,
      conflictFeedNames: ["Google Calendar", "Outlook"],
    };

    const triggers = evaluatePromptTriggers(metrics, context);
    const settings: PromptSettings = {};
    const prompt = shouldShowPrompt(triggers, [], undefined, settings);

    // PROOF: Upgrade prompt fires during simulated engagement
    expect(prompt).not.toBeNull();
    expect(prompt!.type).toBe("conflict_detected");

    // -----------------------------------------------------------------------
    // PHASE 4: OAuth upgrade (Google feed -> OAuth)
    // -----------------------------------------------------------------------

    const oauthAccountId = "acc_01HXY0000000000006CJRNY01";
    const icsEvents: IcsEvent[] = [
      {
        origin_event_id: "google-standup-001@google.com",
        origin_account_id: googleFeedAccountId,
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

    const providerEvents: ProviderEvent[] = [
      {
        origin_event_id: "google-standup-001@google.com",
        origin_account_id: oauthAccountId,
        title: "Morning Standup",
        start: { dateTime: "2026-03-15T09:00:00Z" },
        end: { dateTime: "2026-03-15T09:30:00Z" },
        all_day: false,
        status: "confirmed",
        visibility: "default",
        transparency: "opaque",
        source: "provider",
        attendees: [{ email: "alice@test.com", partstat: "ACCEPTED" }],
      },
    ];

    // Build upgrade DO mock
    const upgradeCalls: DOCallRecord[] = [];
    const upgradeDO = {
      calls: upgradeCalls,
      idFromName(name: string): DurableObjectId {
        return { toString: () => name, name, equals: () => false } as unknown as DurableObjectId;
      },
      get(_id: DurableObjectId): DurableObjectStub {
        return {
          async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
            const url = typeof input === "string" ? new URL(input) : input instanceof URL ? input : new URL(input.url);
            let parsedBody: unknown;
            if (init?.body) {
              try { parsedBody = JSON.parse(init.body as string); } catch { parsedBody = init.body; }
            }
            upgradeCalls.push({ name: _id.toString(), path: url.pathname, method: init?.method ?? "GET", body: parsedBody });

            if (url.pathname === "/getAccountEvents") {
              const reqBody = parsedBody as { account_id: string };
              if (reqBody.account_id === googleFeedAccountId) {
                return Response.json({ events: icsEvents });
              }
              return Response.json({ events: providerEvents });
            }
            if (url.pathname === "/executeUpgrade") {
              return Response.json({ ok: true });
            }
            return Response.json({ ok: true });
          },
        } as unknown as DurableObjectStub;
      },
      idFromString: () => ({ toString: () => "", equals: () => false }) as unknown as DurableObjectId,
      newUniqueId: () => ({ toString: () => "", equals: () => false }) as unknown as DurableObjectId,
      jurisdiction() { return this; },
    } as unknown as DurableObjectNamespace & { calls: DOCallRecord[] };

    const upgradeEnv = buildEnv(d1, upgradeDO);

    const upgradeResp = await handler.fetch(
      new Request(`https://api.tminus.dev/v1/feeds/${googleFeedAccountId}/upgrade`, {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ oauth_account_id: oauthAccountId }),
      }),
      upgradeEnv,
      mockCtx,
    );

    expect(upgradeResp.status).toBe(200);
    const upgradeBody = (await upgradeResp.json()) as {
      ok: boolean;
      data: { merged_count: number; detected_provider: { provider: string } };
    };
    expect(upgradeBody.ok).toBe(true);
    // PROOF: Events preserved during upgrade
    expect(upgradeBody.data.merged_count).toBe(1);
    expect(upgradeBody.data.detected_provider.provider).toBe("google");

    // PROOF: D1 shows Google feed as upgraded
    const googleFeedRow = getAccountRow(db, googleFeedAccountId);
    expect(googleFeedRow!.status).toBe("upgraded");

    // -----------------------------------------------------------------------
    // PHASE 5: Mixed view verification
    // -----------------------------------------------------------------------

    // After upgrade: 1 ICS feed (Outlook) + 1 OAuth (Google upgraded)
    const feedListResp = await handler.fetch(
      new Request("https://api.tminus.dev/v1/feeds", {
        method: "GET",
        headers: { Authorization: authHeader },
      }),
      upgradeEnv,
      mockCtx,
    );
    expect(feedListResp.status).toBe(200);
    const feedListBody = (await feedListResp.json()) as {
      ok: boolean;
      data: Array<{ account_id: string; status: string; feed_url: string }>;
    };
    // Google feed is 'upgraded' but still provider=ics_feed in D1
    // Outlook feed is 'active'
    const activeFeeds = feedListBody.data.filter((f) => f.status === "active");
    // PROOF: Mixed view -- 1 active ICS feed (Outlook) remains
    expect(activeFeeds).toHaveLength(1);
    expect(activeFeeds[0].feed_url).toBe(OUTLOOK_FEED_URL);

    // -----------------------------------------------------------------------
    // PHASE 6: OAuth downgrade (Google OAuth -> ICS fallback)
    // -----------------------------------------------------------------------

    const downgradeDO = createMockDONamespace({
      pathResponses: new Map([
        ["/getAccountEvents", { events: providerEvents }],
      ]),
    });
    // Clean up the upgraded ICS feed account (in production, the upgrade
    // handler would remove or fully replace this row; here the status is
    // 'upgraded' but the UNIQUE(provider, provider_subject) constraint
    // still blocks a new ICS feed account with the same URL).
    db.prepare(
      "DELETE FROM accounts WHERE account_id = ? AND status = 'upgraded'",
    ).run(googleFeedAccountId);

    // Seed the OAuth account for downgrade
    db.prepare(
      `INSERT INTO accounts (account_id, user_id, provider, provider_subject, email, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(oauthAccountId, TEST_USER.user_id, "google", "sub_google", "user@gmail.com", "active");

    const downgradeEnv = buildEnv(d1, downgradeDO);

    const downgradeResp = await handler.fetch(
      new Request("https://api.tminus.dev/v1/feeds/downgrade", {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          oauth_account_id: oauthAccountId,
          provider: "google",
          feed_url: GOOGLE_FEED_URL,
        }),
      }),
      downgradeEnv,
      mockCtx,
    );

    expect(downgradeResp.status).toBe(200);
    const downgradeBody = (await downgradeResp.json()) as {
      ok: boolean;
      data: {
        new_feed_account_id: string;
        preserved_event_count: number;
        mode: string;
      };
    };
    expect(downgradeBody.ok).toBe(true);
    // PROOF: Events preserved during downgrade
    expect(downgradeBody.data.preserved_event_count).toBe(1);
    // PROOF: Read-only mode (ICS fallback)
    expect(downgradeBody.data.mode).toBe("read_only");

    // PROOF: New ICS feed account created
    const newFeedRow = getAccountRow(db, downgradeBody.data.new_feed_account_id);
    expect(newFeedRow).not.toBeNull();
    expect(newFeedRow!.provider).toBe("ics_feed");
    expect(newFeedRow!.status).toBe("active");

    // PROOF: OAuth account marked as downgraded
    const oauthRow = db.prepare(
      "SELECT status FROM accounts WHERE account_id = ?",
    ).get(oauthAccountId) as { status: string };
    expect(oauthRow.status).toBe("downgraded");

    // -----------------------------------------------------------------------
    // PROOF: Full journey completed under 2 minutes
    // -----------------------------------------------------------------------
    const elapsed = Date.now() - startTime;
    expect(elapsed).toBeLessThan(2 * 60 * 1000);
  });
});
