/**
 * Integration tests for OnboardingWorkflow.
 *
 * Uses real SQLite (better-sqlite3) for D1 mock -- all SQL queries execute
 * against real tables with real constraints. DOs are mocked at the fetch
 * boundary (they are external services from the workflow's perspective).
 * Google Calendar API is mocked via injectable FetchFn.
 *
 * Tests prove:
 * 1. Calendar list fetched and overlay calendar created
 * 2. Events paginated and synced to UserGraphDO
 * 3. Watch channel registered with correct parameters
 * 4. syncToken stored in AccountDO
 * 5. Account marked active in D1
 * 6. Default bidirectional BUSY policy edges created
 * 7. Existing canonical events projected to new account
 * 8. Error handling marks account as error in D1
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { MIGRATION_0001_INITIAL_SCHEMA } from "@tminus/d1-registry";
import { OnboardingWorkflow } from "./index";
import type { OnboardingEnv, OnboardingParams } from "./index";
import { BUSY_OVERLAY_CALENDAR_NAME } from "@tminus/shared";
import type { AccountId } from "@tminus/shared";

// ---------------------------------------------------------------------------
// Test constants (valid ULID format: 4-char prefix + 26 Crockford Base32 chars)
// ---------------------------------------------------------------------------

const TEST_ORG = {
  org_id: "org_01HXYZ00000000000000000001",
  name: "Onboarding Test Org",
} as const;

const TEST_USER = {
  user_id: "usr_01HXYZ00000000000000000001",
  org_id: TEST_ORG.org_id,
  email: "onboarding@example.com",
} as const;

const ACCOUNT_NEW = {
  account_id: "acc_01HXYZ0000000000000000000A" as AccountId,
  user_id: TEST_USER.user_id,
  provider: "google",
  provider_subject: "google-sub-new-a",
  email: "alice@gmail.com",
} as const;

const ACCOUNT_EXISTING = {
  account_id: "acc_01HXYZ0000000000000000000B" as AccountId,
  user_id: TEST_USER.user_id,
  provider: "google",
  provider_subject: "google-sub-existing-b",
  email: "alice-work@gmail.com",
} as const;

const TEST_ACCESS_TOKEN = "ya29.test-access-token-onboarding";
const TEST_SYNC_TOKEN = "initial-sync-token-xyz";
const PRIMARY_CALENDAR_ID = "alice@gmail.com";
const OVERLAY_CALENDAR_ID = "overlay_calendar_id_from_google";
const TEST_WEBHOOK_URL = "https://webhook.tminus.dev/v1/google";
const WATCH_CHANNEL_ID = "cal_01HXYZ000000000000000099";
const WATCH_RESOURCE_ID = "resource-id-from-google";
const WATCH_EXPIRATION = String(Date.now() + 7 * 24 * 60 * 60 * 1000);
const WATCH_TOKEN = "cal_01HXYZ000000000000000098";

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
 * Creates a comprehensive Google API mock that handles all endpoint types:
 * - calendarList.list
 * - calendars.insert
 * - events.list (with pagination)
 * - events.watch
 */
function createOnboardingGoogleApiFetch(options: {
  calendars?: Array<{
    id: string;
    summary: string;
    primary?: boolean;
    accessRole: string;
  }>;
  overlayCalendarId?: string;
  eventPages?: Array<{
    events: unknown[];
    nextPageToken?: string;
    nextSyncToken?: string;
  }>;
  watchResponse?: {
    id: string;
    resourceId: string;
    expiration: string;
  };
}) {
  let eventsCallIndex = 0;

  return async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const method =
      (typeof input === "object" && "method" in input
        ? (input as Request).method
        : init?.method) ?? "GET";

    // calendarList.list -- GET /users/me/calendarList
    if (url.includes("/users/me/calendarList") && method === "GET") {
      return new Response(
        JSON.stringify({
          items:
            options.calendars ?? [
              {
                id: PRIMARY_CALENDAR_ID,
                summary: "Alice",
                primary: true,
                accessRole: "owner",
              },
            ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // calendars.insert -- POST /calendars (no /events in path)
    if (
      url.endsWith("/calendar/v3/calendars") &&
      method === "POST"
    ) {
      return new Response(
        JSON.stringify({
          id: options.overlayCalendarId ?? OVERLAY_CALENDAR_ID,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // events.watch -- POST /calendars/{id}/events/watch
    if (url.includes("/events/watch") && method === "POST") {
      const watchResp = options.watchResponse ?? {
        id: WATCH_CHANNEL_ID,
        resourceId: WATCH_RESOURCE_ID,
        expiration: WATCH_EXPIRATION,
      };
      return new Response(JSON.stringify(watchResp), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // events.list -- GET /calendars/{id}/events
    if (url.includes("/calendars/") && url.includes("/events")) {
      const pages = options.eventPages ?? [
        {
          events: [makeGoogleEvent()],
          nextSyncToken: TEST_SYNC_TOKEN,
        },
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
// DO stub mocks
// ---------------------------------------------------------------------------

interface AccountDOState {
  accessToken: string;
  setSyncTokenCalls: string[];
  markSyncSuccessCalls: string[];
  storeWatchChannelCalls: Array<{
    channel_id: string;
    resource_id: string;
    expiration: string;
    calendar_id: string;
  }>;
  createMsSubscriptionCalls: Array<{
    webhook_url: string;
    calendar_id: string;
    client_state: string;
  }>;
}

interface UserGraphDOState {
  applyDeltaCalls: Array<{ account_id: string; deltas: unknown[] }>;
  storeCalendarsCalls: Array<{
    calendars: Array<{
      account_id: string;
      provider_calendar_id: string;
      role: string;
      kind: string;
      display_name: string;
    }>;
  }>;
  ensureDefaultPolicyCalls: Array<{ accounts: string[] }>;
  recomputeProjectionsCalls: number;
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
        state.markSyncSuccessCalls.push(body.ts);
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (path === "/storeWatchChannel") {
        const body = (await request.json()) as {
          channel_id: string;
          resource_id: string;
          expiration: string;
          calendar_id: string;
        };
        state.storeWatchChannelCalls.push(body);
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (path === "/createMsSubscription") {
        const body = (await request.json()) as {
          webhook_url: string;
          calendar_id: string;
          client_state: string;
        };
        state.createMsSubscriptionCalls.push(body);
        return new Response(
          JSON.stringify({
            subscriptionId: MS_SUBSCRIPTION_ID,
            resource: `/me/calendars/${body.calendar_id}/events`,
            expiration: MS_SUBSCRIPTION_EXPIRY,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
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

      if (path === "/storeCalendars") {
        const body = (await request.json()) as {
          calendars: Array<{
            account_id: string;
            provider_calendar_id: string;
            role: string;
            kind: string;
            display_name: string;
          }>;
        };
        state.storeCalendarsCalls.push(body);
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (path === "/ensureDefaultPolicy") {
        const body = (await request.json()) as { accounts: string[] };
        state.ensureDefaultPolicyCalls.push(body);
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (path === "/recomputeProjections") {
        state.recomputeProjectionsCalls++;
        return new Response(JSON.stringify({ enqueued: 0 }), {
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
  writeQueue: Queue & { messages: unknown[] };
  accountDOState: AccountDOState;
  userGraphDOState: UserGraphDOState;
}): OnboardingEnv {
  const accountStub = createMockAccountDO(options.accountDOState);
  const userGraphStub = createMockUserGraphDO(options.userGraphDOState);

  return {
    DB: options.d1,
    WRITE_QUEUE: options.writeQueue,
    WEBHOOK_URL: TEST_WEBHOOK_URL,
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
// Integration tests
// ---------------------------------------------------------------------------

describe("OnboardingWorkflow integration tests (real SQLite, mocked Google API + DOs)", () => {
  let db: DatabaseType;
  let d1: D1Database;
  let writeQueue: Queue & { messages: unknown[] };
  let accountDOState: AccountDOState;
  let userGraphDOState: UserGraphDOState;
  let env: OnboardingEnv;

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
      "INSERT INTO accounts (account_id, user_id, provider, provider_subject, email, status) VALUES (?, ?, ?, ?, ?, 'pending')",
    ).run(
      ACCOUNT_NEW.account_id,
      ACCOUNT_NEW.user_id,
      ACCOUNT_NEW.provider,
      ACCOUNT_NEW.provider_subject,
      ACCOUNT_NEW.email,
    );

    d1 = createRealD1(db);
    writeQueue = createMockQueue();

    accountDOState = {
      accessToken: TEST_ACCESS_TOKEN,
      setSyncTokenCalls: [],
      markSyncSuccessCalls: [],
      storeWatchChannelCalls: [],
      createMsSubscriptionCalls: [],
    };

    userGraphDOState = {
      applyDeltaCalls: [],
      storeCalendarsCalls: [],
      ensureDefaultPolicyCalls: [],
      recomputeProjectionsCalls: 0,
    };

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
  // 1. Full onboarding flow happy path
  // -------------------------------------------------------------------------

  it("full onboarding flow: calendar setup, sync, watch, activate", async () => {
    const googleFetch = createOnboardingGoogleApiFetch({
      eventPages: [
        {
          events: [makeGoogleEvent()],
          nextSyncToken: TEST_SYNC_TOKEN,
        },
      ],
    });

    const workflow = new OnboardingWorkflow(env, { fetchFn: googleFetch });
    const params: OnboardingParams = {
      account_id: ACCOUNT_NEW.account_id,
      user_id: TEST_USER.user_id,
    };

    const result = await workflow.run(params);

    // Calendar setup
    expect(result.calendarSetup.primaryCalendarId).toBe(PRIMARY_CALENDAR_ID);
    expect(result.calendarSetup.overlayCalendarId).toBe(OVERLAY_CALENDAR_ID);
    expect(result.calendarSetup.allCalendars).toHaveLength(1);

    // Event sync
    expect(result.eventSync.totalEvents).toBe(1);
    expect(result.eventSync.totalDeltas).toBe(1);
    expect(result.eventSync.syncToken).toBe(TEST_SYNC_TOKEN);
    expect(result.eventSync.pagesProcessed).toBe(1);
    expect(accountDOState.markSyncSuccessCalls).toHaveLength(1);

    // Watch channel
    expect(result.watchRegistration.channelId).toBe(WATCH_CHANNEL_ID);
    expect(result.watchRegistration.resourceId).toBe(WATCH_RESOURCE_ID);
    expect(result.watchRegistration.expiration).toBe(WATCH_EXPIRATION);

    // Account activated
    expect(result.accountActivated).toBe(true);

    // Projection triggered
    expect(result.projectionEnqueued).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 2. Calendar list fetched and overlay calendar created
  // -------------------------------------------------------------------------

  it("fetches calendar list and creates busy overlay calendar", async () => {
    const calendars = [
      {
        id: "alice@gmail.com",
        summary: "Alice Personal",
        primary: true,
        accessRole: "owner",
      },
      {
        id: "alice@work.com",
        summary: "Work Calendar",
        accessRole: "writer",
      },
    ];

    const googleFetch = createOnboardingGoogleApiFetch({
      calendars,
      overlayCalendarId: "custom-overlay-id",
    });

    const workflow = new OnboardingWorkflow(env, { fetchFn: googleFetch });
    const result = await workflow.run({
      account_id: ACCOUNT_NEW.account_id,
      user_id: TEST_USER.user_id,
    });

    // Primary detected correctly
    expect(result.calendarSetup.primaryCalendarId).toBe("alice@gmail.com");
    expect(result.calendarSetup.overlayCalendarId).toBe("custom-overlay-id");
    expect(result.calendarSetup.allCalendars).toHaveLength(2);

    // UserGraphDO received storeCalendars call
    expect(userGraphDOState.storeCalendarsCalls).toHaveLength(1);
    const storedCalendars = userGraphDOState.storeCalendarsCalls[0].calendars;
    expect(storedCalendars).toHaveLength(2);

    // Primary calendar stored
    const primaryCal = storedCalendars.find((c) => c.role === "primary");
    expect(primaryCal).toBeDefined();
    expect(primaryCal!.provider_calendar_id).toBe("alice@gmail.com");
    expect(primaryCal!.kind).toBe("PRIMARY");
    expect(primaryCal!.display_name).toBe("Alice Personal");

    // Overlay calendar stored
    const overlayCal = storedCalendars.find((c) => c.role === "overlay");
    expect(overlayCal).toBeDefined();
    expect(overlayCal!.provider_calendar_id).toBe("custom-overlay-id");
    expect(overlayCal!.kind).toBe("BUSY_OVERLAY");
    expect(overlayCal!.display_name).toBe(BUSY_OVERLAY_CALENDAR_NAME);
  });

  // -------------------------------------------------------------------------
  // 3. Events paginated and synced to UserGraphDO
  // -------------------------------------------------------------------------

  it("full event sync paginates through all events and applies all deltas", async () => {
    const page1Events = [
      makeGoogleEvent({ id: "evt_p1_1", summary: "Page 1 Event 1" }),
      makeGoogleEvent({ id: "evt_p1_2", summary: "Page 1 Event 2" }),
    ];
    const page2Events = [
      makeGoogleEvent({ id: "evt_p2_1", summary: "Page 2 Event 1" }),
    ];
    const page3Events = [
      makeGoogleEvent({ id: "evt_p3_1", summary: "Page 3 Event 1" }),
      makeGoogleEvent({ id: "evt_p3_2", summary: "Page 3 Event 2" }),
    ];

    const googleFetch = createOnboardingGoogleApiFetch({
      eventPages: [
        { events: page1Events, nextPageToken: "page2_token" },
        { events: page2Events, nextPageToken: "page3_token" },
        { events: page3Events, nextSyncToken: TEST_SYNC_TOKEN },
      ],
    });

    const workflow = new OnboardingWorkflow(env, { fetchFn: googleFetch });
    const result = await workflow.run({
      account_id: ACCOUNT_NEW.account_id,
      user_id: TEST_USER.user_id,
    });

    // All 5 events returned by auto-paginating listEvents (consumes all 3 API pages internally)
    expect(result.eventSync.totalEvents).toBe(5);
    expect(result.eventSync.totalDeltas).toBe(5);
    // listEvents auto-paginates, so the workflow sees 1 "page" containing all events
    expect(result.eventSync.pagesProcessed).toBe(1);
    expect(result.eventSync.syncToken).toBe(TEST_SYNC_TOKEN);

    // All deltas applied in a single batch (listEvents returns all events at once)
    expect(userGraphDOState.applyDeltaCalls).toHaveLength(1);
    expect(userGraphDOState.applyDeltaCalls[0].deltas).toHaveLength(5);

    // Verify all event IDs
    const allDeltaEventIds = userGraphDOState.applyDeltaCalls.flatMap(
      (call) =>
        call.deltas.map(
          (d: unknown) => (d as Record<string, unknown>).origin_event_id,
        ),
    );
    expect(allDeltaEventIds).toContain("evt_p1_1");
    expect(allDeltaEventIds).toContain("evt_p1_2");
    expect(allDeltaEventIds).toContain("evt_p2_1");
    expect(allDeltaEventIds).toContain("evt_p3_1");
    expect(allDeltaEventIds).toContain("evt_p3_2");
  });

  // -------------------------------------------------------------------------
  // 4. Events classified: managed mirrors filtered (Invariant E)
  // -------------------------------------------------------------------------

  it("events classified correctly: managed mirrors filtered out", async () => {
    const googleFetch = createOnboardingGoogleApiFetch({
      eventPages: [
        {
          events: [
            makeGoogleEvent({ id: "real_evt_1", summary: "Real Event" }),
            makeManagedMirrorEvent(), // Should be filtered
            makeGoogleEvent({ id: "real_evt_2", summary: "Another Event" }),
          ],
          nextSyncToken: TEST_SYNC_TOKEN,
        },
      ],
    });

    const workflow = new OnboardingWorkflow(env, { fetchFn: googleFetch });
    const result = await workflow.run({
      account_id: ACCOUNT_NEW.account_id,
      user_id: TEST_USER.user_id,
    });

    // 3 events fetched, but only 2 deltas (mirror filtered out)
    expect(result.eventSync.totalEvents).toBe(3);
    expect(result.eventSync.totalDeltas).toBe(2);

    // Only origin events passed to UserGraphDO
    const deltas = userGraphDOState.applyDeltaCalls[0].deltas;
    expect(deltas).toHaveLength(2);
    const eventIds = deltas.map(
      (d: unknown) => (d as Record<string, unknown>).origin_event_id,
    );
    expect(eventIds).toContain("real_evt_1");
    expect(eventIds).toContain("real_evt_2");
    expect(eventIds).not.toContain("google_evt_mirror_200");
  });

  // -------------------------------------------------------------------------
  // 5. Watch channel registered with correct parameters
  // -------------------------------------------------------------------------

  it("watch channel registered with correct parameters and stored in AccountDO", async () => {
    const watchResponse = {
      id: "channel-from-google",
      resourceId: "resource-from-google",
      expiration: String(Date.now() + 7 * 24 * 60 * 60 * 1000),
    };

    const googleFetch = createOnboardingGoogleApiFetch({
      watchResponse,
    });

    const workflow = new OnboardingWorkflow(env, { fetchFn: googleFetch });
    const result = await workflow.run({
      account_id: ACCOUNT_NEW.account_id,
      user_id: TEST_USER.user_id,
    });

    // Watch response recorded correctly
    expect(result.watchRegistration.channelId).toBe("channel-from-google");
    expect(result.watchRegistration.resourceId).toBe("resource-from-google");
    expect(result.watchRegistration.expiration).toBe(watchResponse.expiration);
    // Token is a generated cal_ ID (not empty, not the channel id)
    expect(result.watchRegistration.token).toMatch(/^cal_/);

    // AccountDO received storeWatchChannel call
    expect(accountDOState.storeWatchChannelCalls).toHaveLength(1);
    const watchCall = accountDOState.storeWatchChannelCalls[0];
    expect(watchCall.channel_id).toBe("channel-from-google");
    expect(watchCall.resource_id).toBe("resource-from-google");
    expect(watchCall.expiration).toBe(watchResponse.expiration);
    expect(watchCall.calendar_id).toBe(PRIMARY_CALENDAR_ID);
  });

  // -------------------------------------------------------------------------
  // 6. syncToken stored in AccountDO
  // -------------------------------------------------------------------------

  it("syncToken from last events page stored in AccountDO", async () => {
    const specificSyncToken = "final-sync-token-abc123";

    const googleFetch = createOnboardingGoogleApiFetch({
      eventPages: [
        { events: [makeGoogleEvent()], nextPageToken: "page2" },
        {
          events: [makeGoogleEvent({ id: "evt_2" })],
          nextSyncToken: specificSyncToken,
        },
      ],
    });

    const workflow = new OnboardingWorkflow(env, { fetchFn: googleFetch });
    await workflow.run({
      account_id: ACCOUNT_NEW.account_id,
      user_id: TEST_USER.user_id,
    });

    // syncToken saved to AccountDO
    expect(accountDOState.setSyncTokenCalls).toEqual([specificSyncToken]);
  });

  // -------------------------------------------------------------------------
  // 7. Account marked active in D1
  // -------------------------------------------------------------------------

  it("account marked active in D1 with channel info after successful onboarding", async () => {
    const googleFetch = createOnboardingGoogleApiFetch({});
    const workflow = new OnboardingWorkflow(env, { fetchFn: googleFetch });

    await workflow.run({
      account_id: ACCOUNT_NEW.account_id,
      user_id: TEST_USER.user_id,
    });

    // Read account from real D1
    const accountRow = db
      .prepare("SELECT * FROM accounts WHERE account_id = ?")
      .get(ACCOUNT_NEW.account_id) as Record<string, unknown>;

    expect(accountRow.status).toBe("active");
    expect(accountRow.channel_id).toBe(WATCH_CHANNEL_ID);
    // channel_token is the generated cal_ token
    expect(typeof accountRow.channel_token).toBe("string");
    expect((accountRow.channel_token as string).length).toBeGreaterThan(0);
    // channel_expiry_ts is an ISO string
    expect(accountRow.channel_expiry_ts).toBeTruthy();
    const expiryDate = new Date(accountRow.channel_expiry_ts as string);
    expect(expiryDate.getTime()).toBeGreaterThan(Date.now());
  });

  // -------------------------------------------------------------------------
  // 8. Default bidirectional BUSY policy edges created
  // -------------------------------------------------------------------------

  it("default bidirectional BUSY policy edges created when multiple accounts exist", async () => {
    // Add an existing account for the same user
    db.prepare(
      "INSERT INTO accounts (account_id, user_id, provider, provider_subject, email, status) VALUES (?, ?, ?, ?, ?, 'active')",
    ).run(
      ACCOUNT_EXISTING.account_id,
      ACCOUNT_EXISTING.user_id,
      ACCOUNT_EXISTING.provider,
      ACCOUNT_EXISTING.provider_subject,
      ACCOUNT_EXISTING.email,
    );

    const googleFetch = createOnboardingGoogleApiFetch({});
    const workflow = new OnboardingWorkflow(env, { fetchFn: googleFetch });

    const result = await workflow.run({
      account_id: ACCOUNT_NEW.account_id,
      user_id: TEST_USER.user_id,
    });

    expect(result.policyEdgesCreated).toBe(true);

    // UserGraphDO received ensureDefaultPolicy with both accounts
    expect(userGraphDOState.ensureDefaultPolicyCalls).toHaveLength(1);
    const policyCall = userGraphDOState.ensureDefaultPolicyCalls[0];
    expect(policyCall.accounts).toHaveLength(2);
    expect(policyCall.accounts).toContain(ACCOUNT_NEW.account_id);
    expect(policyCall.accounts).toContain(ACCOUNT_EXISTING.account_id);
  });

  // -------------------------------------------------------------------------
  // 9. Single account: no policy edges created
  // -------------------------------------------------------------------------

  it("no policy edges created when only one account exists", async () => {
    const googleFetch = createOnboardingGoogleApiFetch({});
    const workflow = new OnboardingWorkflow(env, { fetchFn: googleFetch });

    const result = await workflow.run({
      account_id: ACCOUNT_NEW.account_id,
      user_id: TEST_USER.user_id,
    });

    // With only one account, no edges are needed
    expect(result.policyEdgesCreated).toBe(false);
    expect(userGraphDOState.ensureDefaultPolicyCalls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 10. Existing events projected to new account
  // -------------------------------------------------------------------------

  it("existing canonical events projected to new account via recomputeProjections", async () => {
    const googleFetch = createOnboardingGoogleApiFetch({});
    const workflow = new OnboardingWorkflow(env, { fetchFn: googleFetch });

    const result = await workflow.run({
      account_id: ACCOUNT_NEW.account_id,
      user_id: TEST_USER.user_id,
    });

    expect(result.projectionEnqueued).toBe(true);
    expect(userGraphDOState.recomputeProjectionsCalls).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 11. Error handling: account marked as error in D1
  // -------------------------------------------------------------------------

  it("account marked as error in D1 when onboarding fails", async () => {
    // Google API returns 500 for calendarList -- causes immediate failure
    const failingFetch = async (): Promise<Response> => {
      return new Response("Internal Server Error", { status: 500 });
    };

    const workflow = new OnboardingWorkflow(env, { fetchFn: failingFetch });

    await expect(
      workflow.run({
        account_id: ACCOUNT_NEW.account_id,
        user_id: TEST_USER.user_id,
      }),
    ).rejects.toThrow();

    // Account should be marked as error in D1
    const accountRow = db
      .prepare("SELECT status FROM accounts WHERE account_id = ?")
      .get(ACCOUNT_NEW.account_id) as { status: string };
    expect(accountRow.status).toBe("error");
  });

  // -------------------------------------------------------------------------
  // 12. Events classified correctly: normalized event data
  // -------------------------------------------------------------------------

  it("deltas contain correctly normalized event data", async () => {
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

    const googleFetch = createOnboardingGoogleApiFetch({
      eventPages: [
        {
          events: [detailedEvent],
          nextSyncToken: TEST_SYNC_TOKEN,
        },
      ],
    });

    const workflow = new OnboardingWorkflow(env, { fetchFn: googleFetch });
    await workflow.run({
      account_id: ACCOUNT_NEW.account_id,
      user_id: TEST_USER.user_id,
    });

    const delta = userGraphDOState.applyDeltaCalls[0].deltas[0] as Record<
      string,
      unknown
    >;
    expect(delta.type).toBe("updated");
    expect(delta.origin_event_id).toBe("google_evt_detailed");
    expect(delta.origin_account_id).toBe(ACCOUNT_NEW.account_id);

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
  });

  // -------------------------------------------------------------------------
  // 13. Empty calendar: no deltas but sync still succeeds
  // -------------------------------------------------------------------------

  it("empty calendar: zero events but sync completes and account activates", async () => {
    const googleFetch = createOnboardingGoogleApiFetch({
      eventPages: [
        {
          events: [],
          nextSyncToken: TEST_SYNC_TOKEN,
        },
      ],
    });

    const workflow = new OnboardingWorkflow(env, { fetchFn: googleFetch });
    const result = await workflow.run({
      account_id: ACCOUNT_NEW.account_id,
      user_id: TEST_USER.user_id,
    });

    expect(result.eventSync.totalEvents).toBe(0);
    expect(result.eventSync.totalDeltas).toBe(0);
    expect(result.eventSync.pagesProcessed).toBe(1);
    expect(result.accountActivated).toBe(true);

    // No deltas applied
    expect(userGraphDOState.applyDeltaCalls).toHaveLength(0);

    // syncToken still saved
    expect(accountDOState.setSyncTokenCalls).toEqual([TEST_SYNC_TOKEN]);

    // Account still activated
    const accountRow = db
      .prepare("SELECT status FROM accounts WHERE account_id = ?")
      .get(ACCOUNT_NEW.account_id) as { status: string };
    expect(accountRow.status).toBe("active");
  });

  // -------------------------------------------------------------------------
  // 14. classifyAndNormalize unit behavior: all-day events
  // -------------------------------------------------------------------------

  it("all-day events are normalized correctly during onboarding sync", async () => {
    const allDayEvent = makeGoogleEvent({
      id: "google_evt_allday",
      summary: "Company Holiday",
      start: { date: "2026-02-20" },
      end: { date: "2026-02-21" },
    });

    const googleFetch = createOnboardingGoogleApiFetch({
      eventPages: [
        {
          events: [allDayEvent],
          nextSyncToken: TEST_SYNC_TOKEN,
        },
      ],
    });

    const workflow = new OnboardingWorkflow(env, { fetchFn: googleFetch });
    await workflow.run({
      account_id: ACCOUNT_NEW.account_id,
      user_id: TEST_USER.user_id,
    });

    const delta = userGraphDOState.applyDeltaCalls[0].deltas[0] as Record<
      string,
      unknown
    >;
    const eventPayload = delta.event as Record<string, unknown>;
    expect(eventPayload.all_day).toBe(true);
    expect(eventPayload.start).toEqual({ date: "2026-02-20" });
    expect(eventPayload.end).toEqual({ date: "2026-02-21" });
  });

  // -------------------------------------------------------------------------
  // 15. Cancelled events produce delete deltas
  // -------------------------------------------------------------------------

  it("cancelled events produce delete deltas during onboarding", async () => {
    const cancelledEvent = {
      id: "google_evt_cancelled",
      status: "cancelled",
    };

    const googleFetch = createOnboardingGoogleApiFetch({
      eventPages: [
        {
          events: [cancelledEvent],
          nextSyncToken: TEST_SYNC_TOKEN,
        },
      ],
    });

    const workflow = new OnboardingWorkflow(env, { fetchFn: googleFetch });
    await workflow.run({
      account_id: ACCOUNT_NEW.account_id,
      user_id: TEST_USER.user_id,
    });

    const delta = userGraphDOState.applyDeltaCalls[0].deltas[0] as Record<
      string,
      unknown
    >;
    expect(delta.type).toBe("deleted");
    expect(delta.origin_event_id).toBe("google_evt_cancelled");
    expect(delta.event).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 16. No primary calendar throws meaningful error
  // -------------------------------------------------------------------------

  it("throws when no primary calendar is found", async () => {
    const googleFetch = createOnboardingGoogleApiFetch({
      calendars: [
        {
          id: "secondary@group.calendar.google.com",
          summary: "Shared Calendar",
          accessRole: "reader",
        },
      ],
    });

    const workflow = new OnboardingWorkflow(env, { fetchFn: googleFetch });

    await expect(
      workflow.run({
        account_id: ACCOUNT_NEW.account_id,
        user_id: TEST_USER.user_id,
      }),
    ).rejects.toThrow(/No primary calendar found/);

    // Account should be marked as error
    const accountRow = db
      .prepare("SELECT status FROM accounts WHERE account_id = ?")
      .get(ACCOUNT_NEW.account_id) as { status: string };
    expect(accountRow.status).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// Microsoft onboarding integration tests
// ---------------------------------------------------------------------------

const MS_ACCOUNT = {
  account_id: "acc_01HXYZ0000000000000000000M" as AccountId,
  user_id: TEST_USER.user_id,
  provider: "microsoft",
  provider_subject: "ms-sub-user-m",
  email: "ramiro@cibertrend.com",
} as const;

const MS_ACCESS_TOKEN = "eyJ0eXAiOiJKV1Q.ms-test-access-token";
const MS_PRIMARY_CALENDAR_ID = "AAMkADQ0ZGJmPrimaryCalId";
const MS_OVERLAY_CALENDAR_ID = "AAMkADQ0ZGJmOverlayCalId";
const MS_SUBSCRIPTION_ID = "sub-id-from-microsoft-graph";
const MS_SUBSCRIPTION_RESOURCE = "/me/calendars/AAMkADQ0ZGJmPrimaryCalId/events";
const MS_SUBSCRIPTION_EXPIRY = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
const MS_SYNC_TOKEN = "https://graph.microsoft.com/v1.0/me/calendars/x/events?$deltatoken=abcdef123";

// ---------------------------------------------------------------------------
// Microsoft Graph API mock events
// ---------------------------------------------------------------------------

function makeMicrosoftEvent(overrides?: Record<string, unknown>) {
  return {
    id: "AAMkADQ0ZGJm_evt_100",
    subject: "Standup",
    body: { contentType: "text", content: "Daily sync" },
    location: { displayName: "Teams" },
    start: { dateTime: "2026-02-15T09:00:00.0000000", timeZone: "UTC" },
    end: { dateTime: "2026-02-15T09:30:00.0000000", timeZone: "UTC" },
    isAllDay: false,
    isCancelled: false,
    showAs: "busy",
    sensitivity: "normal",
    ...overrides,
  };
}

function makeMsManagedMirrorEvent(overrides?: Record<string, unknown>) {
  return {
    id: "AAMkADQ0ZGJm_evt_mirror_200",
    subject: "Busy",
    start: { dateTime: "2026-02-15T11:00:00.0000000", timeZone: "UTC" },
    end: { dateTime: "2026-02-15T12:00:00.0000000", timeZone: "UTC" },
    isCancelled: false,
    extensions: [
      {
        "@odata.type": "microsoft.graph.openExtension",
        extensionName: "com.tminus.metadata",
        tminus: "true",
        managed: "true",
        canonicalId: "evt_01HXYZ00000000000000000001",
        originAccount: "acc_01HXYZ0000000000000000000B",
      },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Microsoft Graph API fetch mock factory
// ---------------------------------------------------------------------------

function createOnboardingMicrosoftApiFetch(options: {
  calendars?: Array<{
    id: string;
    name: string;
    isDefaultCalendar?: boolean;
    canEdit?: boolean;
  }>;
  overlayCalendarId?: string;
  eventPages?: Array<{
    events: unknown[];
    nextLink?: string;
    deltaLink?: string;
  }>;
  subscriptionResponse?: {
    id: string;
    resource: string;
    expirationDateTime: string;
  };
}) {
  let eventsCallIndex = 0;

  return async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const method =
      (typeof input === "object" && "method" in input
        ? (input as Request).method
        : init?.method) ?? "GET";

    // GET /me/calendars (list calendars)
    if (url.endsWith("/me/calendars") && method === "GET") {
      return new Response(
        JSON.stringify({
          value:
            options.calendars ?? [
              {
                id: MS_PRIMARY_CALENDAR_ID,
                name: "Calendar",
                isDefaultCalendar: true,
                canEdit: true,
              },
            ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // POST /me/calendars (create calendar)
    if (url.endsWith("/me/calendars") && method === "POST") {
      return new Response(
        JSON.stringify({
          id: options.overlayCalendarId ?? MS_OVERLAY_CALENDAR_ID,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // POST /subscriptions (watch events)
    if (url.endsWith("/subscriptions") && method === "POST") {
      const subResp = options.subscriptionResponse ?? {
        id: MS_SUBSCRIPTION_ID,
        resource: MS_SUBSCRIPTION_RESOURCE,
        expirationDateTime: MS_SUBSCRIPTION_EXPIRY,
      };
      return new Response(JSON.stringify(subResp), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // GET /me/calendars/{id}/events (list events) -- with optional $expand for extensions
    if (url.includes("/me/calendars/") && url.includes("/events") && method === "GET") {
      const pages = options.eventPages ?? [
        {
          events: [makeMicrosoftEvent()],
          deltaLink: MS_SYNC_TOKEN,
        },
      ];
      const page = pages[eventsCallIndex] ?? pages[pages.length - 1];
      eventsCallIndex++;

      return new Response(
        JSON.stringify({
          value: page.events,
          "@odata.nextLink": page.nextLink,
          "@odata.deltaLink": page.deltaLink,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response("Not found", { status: 404 });
  };
}

describe("OnboardingWorkflow -- Microsoft account integration tests", () => {
  let db: DatabaseType;
  let d1: D1Database;
  let writeQueue: Queue & { messages: unknown[] };
  let accountDOState: AccountDOState;
  let userGraphDOState: UserGraphDOState;
  let env: OnboardingEnv;

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

    // Seed Microsoft account (provider='microsoft' -- critical for the fix)
    db.prepare(
      "INSERT INTO accounts (account_id, user_id, provider, provider_subject, email, status) VALUES (?, ?, ?, ?, ?, 'pending')",
    ).run(
      MS_ACCOUNT.account_id,
      MS_ACCOUNT.user_id,
      MS_ACCOUNT.provider,
      MS_ACCOUNT.provider_subject,
      MS_ACCOUNT.email,
    );

    d1 = createRealD1(db);
    writeQueue = createMockQueue();

    accountDOState = {
      accessToken: MS_ACCESS_TOKEN,
      setSyncTokenCalls: [],
      markSyncSuccessCalls: [],
      storeWatchChannelCalls: [],
      createMsSubscriptionCalls: [],
    };

    userGraphDOState = {
      applyDeltaCalls: [],
      storeCalendarsCalls: [],
      ensureDefaultPolicyCalls: [],
      recomputeProjectionsCalls: 0,
    };

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
  // MS-1. Full Microsoft onboarding flow happy path
  // -------------------------------------------------------------------------

  it("full Microsoft onboarding: calendar setup, sync, subscription, activate", async () => {
    const msFetch = createOnboardingMicrosoftApiFetch({
      eventPages: [
        {
          events: [makeMicrosoftEvent()],
          deltaLink: MS_SYNC_TOKEN,
        },
      ],
    });

    const workflow = new OnboardingWorkflow(env, { fetchFn: msFetch });
    const params: OnboardingParams = {
      account_id: MS_ACCOUNT.account_id,
      user_id: TEST_USER.user_id,
    };

    const result = await workflow.run(params);

    // Calendar setup
    expect(result.calendarSetup.primaryCalendarId).toBe(MS_PRIMARY_CALENDAR_ID);
    expect(result.calendarSetup.overlayCalendarId).toBe(MS_OVERLAY_CALENDAR_ID);
    expect(result.calendarSetup.allCalendars).toHaveLength(1);

    // Event sync
    expect(result.eventSync.totalEvents).toBe(1);
    expect(result.eventSync.totalDeltas).toBe(1);
    expect(result.eventSync.syncToken).toBe(MS_SYNC_TOKEN);
    expect(result.eventSync.pagesProcessed).toBe(1);
    expect(accountDOState.markSyncSuccessCalls).toHaveLength(1);

    // Watch registration (subscription)
    expect(result.watchRegistration.channelId).toBe(MS_SUBSCRIPTION_ID);
    expect(result.watchRegistration.resourceId).toBe(MS_SUBSCRIPTION_RESOURCE);
    expect(result.watchRegistration.expiration).toBe(MS_SUBSCRIPTION_EXPIRY);
    expect(accountDOState.createMsSubscriptionCalls).toHaveLength(1);
    expect(accountDOState.createMsSubscriptionCalls[0].calendar_id).toBe(MS_PRIMARY_CALENDAR_ID);
    expect(accountDOState.createMsSubscriptionCalls[0].webhook_url).toBe(
      "https://webhook.tminus.dev/v1/microsoft",
    );
    expect(accountDOState.storeWatchChannelCalls).toHaveLength(0);

    // Account activated
    expect(result.accountActivated).toBe(true);

    // Verify account is active in D1
    const accountRow = db
      .prepare("SELECT status FROM accounts WHERE account_id = ?")
      .get(MS_ACCOUNT.account_id) as { status: string };
    expect(accountRow.status).toBe("active");

    // Projection triggered
    expect(result.projectionEnqueued).toBe(true);
  });

  it("reuses existing overlay calendar on Microsoft onboarding retries", async () => {
    const existingOverlayId = "AAMkADQ0ZGJmExistingOverlayCalId";
    let insertCalled = false;

    const msFetch = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const method =
        (typeof input === "object" && "method" in input
          ? (input as Request).method
          : init?.method) ?? "GET";

      if (url.endsWith("/me/calendars") && method === "GET") {
        return new Response(
          JSON.stringify({
            value: [
              {
                id: MS_PRIMARY_CALENDAR_ID,
                name: "Calendar",
                isDefaultCalendar: true,
                canEdit: true,
              },
              {
                id: existingOverlayId,
                name: BUSY_OVERLAY_CALENDAR_NAME,
                isDefaultCalendar: false,
                canEdit: true,
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.endsWith("/me/calendars") && method === "POST") {
        insertCalled = true;
        return new Response("calendar-create-should-not-run", { status: 500 });
      }

      if (url.includes("/me/calendars/") && url.includes("/events") && method === "GET") {
        return new Response(
          JSON.stringify({
            value: [makeMicrosoftEvent()],
            "@odata.deltaLink": MS_SYNC_TOKEN,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response("Not found", { status: 404 });
    };

    const workflow = new OnboardingWorkflow(env, { fetchFn: msFetch });
    const result = await workflow.run({
      account_id: MS_ACCOUNT.account_id,
      user_id: TEST_USER.user_id,
    });

    expect(result.calendarSetup.overlayCalendarId).toBe(existingOverlayId);
    expect(insertCalled).toBe(false);
  });

  // -------------------------------------------------------------------------
  // MS-2. Microsoft events normalized correctly (subject -> title, etc.)
  // -------------------------------------------------------------------------

  it("Microsoft events normalized with correct field mappings", async () => {
    const msEvent = makeMicrosoftEvent({
      id: "AAMkADQ0_detailed_evt",
      subject: "Sprint Review",
      body: { contentType: "text", content: "End of sprint demo" },
      location: { displayName: "Room 42" },
      start: { dateTime: "2026-03-01T14:00:00.0000000", timeZone: "Pacific Standard Time" },
      end: { dateTime: "2026-03-01T16:00:00.0000000", timeZone: "Pacific Standard Time" },
      showAs: "busy",
      sensitivity: "private",
    });

    const msFetch = createOnboardingMicrosoftApiFetch({
      eventPages: [{ events: [msEvent], deltaLink: MS_SYNC_TOKEN }],
    });

    const workflow = new OnboardingWorkflow(env, { fetchFn: msFetch });
    await workflow.run({
      account_id: MS_ACCOUNT.account_id,
      user_id: TEST_USER.user_id,
    });

    const delta = userGraphDOState.applyDeltaCalls[0].deltas[0] as Record<string, unknown>;
    expect(delta.type).toBe("updated");
    expect(delta.origin_event_id).toBe("AAMkADQ0_detailed_evt");
    expect(delta.origin_account_id).toBe(MS_ACCOUNT.account_id);

    const eventPayload = delta.event as Record<string, unknown>;
    expect(eventPayload.title).toBe("Sprint Review");
    expect(eventPayload.description).toBe("End of sprint demo");
    expect(eventPayload.location).toBe("Room 42");
    expect(eventPayload.start).toEqual({
      dateTime: "2026-03-01T14:00:00.0000000",
      timeZone: "Pacific Standard Time",
    });
    expect(eventPayload.transparency).toBe("opaque");
    expect(eventPayload.visibility).toBe("private");
  });

  // -------------------------------------------------------------------------
  // MS-3. Microsoft managed mirrors filtered (Invariant E)
  // -------------------------------------------------------------------------

  it("Microsoft managed mirrors filtered out during onboarding (Invariant E)", async () => {
    const msFetch = createOnboardingMicrosoftApiFetch({
      eventPages: [
        {
          events: [
            makeMicrosoftEvent({ id: "real_ms_evt_1", subject: "Real Event" }),
            makeMsManagedMirrorEvent(), // Should be filtered
            makeMicrosoftEvent({ id: "real_ms_evt_2", subject: "Another Event" }),
          ],
          deltaLink: MS_SYNC_TOKEN,
        },
      ],
    });

    const workflow = new OnboardingWorkflow(env, { fetchFn: msFetch });
    const result = await workflow.run({
      account_id: MS_ACCOUNT.account_id,
      user_id: TEST_USER.user_id,
    });

    // 3 events fetched, but only 2 deltas (mirror filtered out)
    expect(result.eventSync.totalEvents).toBe(3);
    expect(result.eventSync.totalDeltas).toBe(2);

    // Only origin events passed to UserGraphDO
    const deltas = userGraphDOState.applyDeltaCalls[0].deltas;
    expect(deltas).toHaveLength(2);
    const eventIds = deltas.map(
      (d: unknown) => (d as Record<string, unknown>).origin_event_id,
    );
    expect(eventIds).toContain("real_ms_evt_1");
    expect(eventIds).toContain("real_ms_evt_2");
    expect(eventIds).not.toContain("AAMkADQ0ZGJm_evt_mirror_200");
  });

  // -------------------------------------------------------------------------
  // MS-4. Microsoft subscription expiry stored as ISO string (not Unix ms)
  // -------------------------------------------------------------------------

  it("Microsoft subscription expiry stored correctly as ISO string", async () => {
    const msFetch = createOnboardingMicrosoftApiFetch({});

    const workflow = new OnboardingWorkflow(env, { fetchFn: msFetch });
    await workflow.run({
      account_id: MS_ACCOUNT.account_id,
      user_id: TEST_USER.user_id,
    });

    // channel_expiry_ts should preserve the ISO timestamp returned by AccountDO
    // (not be corrupted by numeric parsing).
    const accountRow = db
      .prepare("SELECT channel_expiry_ts FROM accounts WHERE account_id = ?")
      .get(MS_ACCOUNT.account_id) as { channel_expiry_ts: string };
    expect(accountRow.channel_expiry_ts).toBe(MS_SUBSCRIPTION_EXPIRY);
    expect(Number.isNaN(Date.parse(accountRow.channel_expiry_ts))).toBe(false);
  });

  // -------------------------------------------------------------------------
  // MS-5. Error handling: Microsoft API failure marks account as error
  // -------------------------------------------------------------------------

  it("account marked as error when Microsoft API fails", async () => {
    const failingFetch = async (): Promise<Response> => {
      return new Response(
        JSON.stringify({ error: { code: "InvalidAuthenticationToken", message: "Access token has expired" } }),
        { status: 401 },
      );
    };

    const workflow = new OnboardingWorkflow(env, { fetchFn: failingFetch });

    await expect(
      workflow.run({
        account_id: MS_ACCOUNT.account_id,
        user_id: TEST_USER.user_id,
      }),
    ).rejects.toThrow();

    // Account should be marked as error in D1
    const accountRow = db
      .prepare("SELECT status FROM accounts WHERE account_id = ?")
      .get(MS_ACCOUNT.account_id) as { status: string };
    expect(accountRow.status).toBe("error");
  });

  // -------------------------------------------------------------------------
  // MS-6. Cross-provider policy edges: Google + Microsoft accounts
  // -------------------------------------------------------------------------

  it("creates bidirectional policy edges between Google and Microsoft accounts", async () => {
    // Add an existing Google account for the same user
    db.prepare(
      "INSERT INTO accounts (account_id, user_id, provider, provider_subject, email, status) VALUES (?, ?, ?, ?, ?, 'active')",
    ).run(
      ACCOUNT_NEW.account_id,
      ACCOUNT_NEW.user_id,
      ACCOUNT_NEW.provider,
      ACCOUNT_NEW.provider_subject,
      ACCOUNT_NEW.email,
    );

    const msFetch = createOnboardingMicrosoftApiFetch({});
    const workflow = new OnboardingWorkflow(env, { fetchFn: msFetch });

    const result = await workflow.run({
      account_id: MS_ACCOUNT.account_id,
      user_id: TEST_USER.user_id,
    });

    expect(result.policyEdgesCreated).toBe(true);

    // UserGraphDO received ensureDefaultPolicy with both accounts
    expect(userGraphDOState.ensureDefaultPolicyCalls).toHaveLength(1);
    const policyCall = userGraphDOState.ensureDefaultPolicyCalls[0];
    expect(policyCall.accounts).toHaveLength(2);
    expect(policyCall.accounts).toContain(MS_ACCOUNT.account_id);
    expect(policyCall.accounts).toContain(ACCOUNT_NEW.account_id);
  });

  // -------------------------------------------------------------------------
  // MS-7. Unsupported provider throws descriptive error
  // -------------------------------------------------------------------------

  it("throws descriptive error for unsupported provider", async () => {
    // Insert an account with a bogus provider
    const bogusAccountId = "acc_01HXYZ0000000000000000BOGX" as AccountId;
    db.prepare(
      "INSERT INTO accounts (account_id, user_id, provider, provider_subject, email, status) VALUES (?, ?, ?, ?, ?, 'pending')",
    ).run(bogusAccountId, TEST_USER.user_id, "yahoo", "yahoo-sub", "user@yahoo.com");

    const msFetch = createOnboardingMicrosoftApiFetch({});
    const workflow = new OnboardingWorkflow(env, { fetchFn: msFetch });

    await expect(
      workflow.run({
        account_id: bogusAccountId,
        user_id: TEST_USER.user_id,
      }),
    ).rejects.toThrow(/Unsupported provider/);

    // Account should be marked as error
    const accountRow = db
      .prepare("SELECT status FROM accounts WHERE account_id = ?")
      .get(bogusAccountId) as { status: string };
    expect(accountRow.status).toBe("error");
  });

  // -------------------------------------------------------------------------
  // MS-8. Account not found in D1 throws
  // -------------------------------------------------------------------------

  it("throws when account does not exist in D1", async () => {
    const nonexistentId = "acc_01HXYZ000000000000000NOTEX" as AccountId;
    const msFetch = createOnboardingMicrosoftApiFetch({});
    const workflow = new OnboardingWorkflow(env, { fetchFn: msFetch });

    await expect(
      workflow.run({
        account_id: nonexistentId,
        user_id: TEST_USER.user_id,
      }),
    ).rejects.toThrow(/Account not found/);
  });
});
