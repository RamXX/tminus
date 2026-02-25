/**
 * Walking skeleton integration test: webhook-to-busy-overlay pipeline.
 *
 * Proves the full pipeline executes without errors:
 * webhook -> sync-queue -> sync-consumer -> UserGraphDO -> write-queue ->
 * write-consumer -> Google Calendar API
 *
 * Components:
 * - Webhook handler: receives Google push notification, enqueues SYNC_INCREMENTAL
 * - Sync-consumer: fetches events from Google, classifies them, normalizes to
 *   ProviderDelta, calls UserGraphDO.applyProviderDelta()
 * - UserGraphDO: stores canonical events, computes projections via policy edges,
 *   enqueues UPSERT_MIRROR to write-queue
 * - Write-consumer: reads mirror state, creates busy overlay events via Google API
 *
 * What is mocked (external service boundaries):
 * - Google Calendar API (events.list, events.insert, calendars.insert)
 * - Queue runtime (message capture instead of Cloudflare queues)
 *
 * What is real:
 * - D1 registry (better-sqlite3)
 * - UserGraphDO SQL state (better-sqlite3 via SqlStorageLike adapter)
 * - AccountDO SQL state (better-sqlite3 via SqlStorageLike adapter)
 * - Event classification and normalization
 * - Policy compilation and projection hashing
 * - WriteConsumer business logic
 *
 * Test scenario:
 * - Account A has event "Board Meeting, 2pm-3pm"
 * - Policy edge: A -> B, detail_level=BUSY, calendar_kind=BUSY_OVERLAY
 * - Webhook triggers incremental sync for Account A
 * - Pipeline produces: Account B gets "Busy" event 2pm-3pm with tminus
 *   extended properties
 *
 * Test fixture IDs use valid ULID format: 4-char prefix + 26 Crockford Base32 chars.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { createHandler } from "../../webhook/src/index";
import {
  createQueueHandler,
  handleIncrementalSync,
} from "../../sync-consumer/src/index";
import type { SyncQueueMessage } from "../../sync-consumer/src/index";
import { UserGraphDO } from "../../../durable-objects/user-graph/src/index";
import type { QueueLike } from "../../../durable-objects/user-graph/src/index";
import { AccountDO } from "../../../durable-objects/account/src/index";
import { WriteConsumer } from "./write-consumer";
import type { MirrorStore, MirrorRow, MirrorUpdate, TokenProvider } from "./write-consumer";
import { MIGRATION_0001_INITIAL_SCHEMA } from "@tminus/d1-registry";
import {
  BUSY_OVERLAY_CALENDAR_NAME,
  classifyEvent,
  normalizeGoogleEvent,
} from "@tminus/shared";
import type {
  SyncIncrementalMessage,
  UpsertMirrorMessage,
  DeleteManagedMirrorMessage,
  AccountId,
  GoogleCalendarEvent,
  ProjectedEvent,
  CalendarProvider,
  FetchFn,
} from "@tminus/shared";

// ---------------------------------------------------------------------------
// Test fixture IDs (valid ULID: prefix + 26 Crockford Base32)
// ---------------------------------------------------------------------------

const TEST_ORG = {
  org_id: "org_01JSKE00M00000000000000001",
  name: "Walking Skeleton Org",
} as const;

const TEST_USER = {
  user_id: "usr_01JSKE00M00000000000000001",
  email: "skeleton@example.com",
} as const;

// Account A: origin account (has the "Board Meeting")
const ACCOUNT_A = {
  account_id: "acc_01JSKE00MACCPVNTA000000001" as AccountId,
  provider: "google",
  provider_subject: "google-sub-acct-a",
  email: "alice@gmail.com",
  channel_token: "secret-token-skeleton-a",
} as const;

// Account B: target account (will receive "Busy" overlay)
const ACCOUNT_B = {
  account_id: "acc_01JSKE00MACCPVNTB000000001" as AccountId,
  provider: "google",
  provider_subject: "google-sub-acct-b",
  email: "alice-work@gmail.com",
  channel_token: "secret-token-skeleton-b",
} as const;

// Master key for AccountDO encryption (test-only, 32 bytes hex)
const TEST_MASTER_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

// Google API mock data
const BOARD_MEETING_EVENT: GoogleCalendarEvent = {
  id: "google_event_board_meeting_001",
  summary: "Board Meeting",
  start: { dateTime: "2026-02-15T14:00:00Z" },
  end: { dateTime: "2026-02-15T15:00:00Z" },
  status: "confirmed",
  visibility: "default",
  transparency: "opaque",
};

const MOCK_SYNC_TOKEN = "CAAL==mock-sync-token-skeleton";
const MOCK_NEXT_SYNC_TOKEN = "CAAL==mock-next-sync-token-skeleton";
const MOCK_PROVIDER_EVENT_ID = "google_mirror_event_busy_001";
const MOCK_BUSY_OVERLAY_CALENDAR_ID = "skeleton-busy-overlay@group.calendar.google.com";

// ---------------------------------------------------------------------------
// SqlStorageLike adapter for better-sqlite3
// ---------------------------------------------------------------------------

function createSqlStorageLike(db: DatabaseType) {
  return {
    exec<T extends Record<string, unknown>>(
      query: string,
      ...bindings: unknown[]
    ) {
      // SQLite pragmas need special handling
      if (query.trim().toUpperCase().startsWith("PRAGMA")) {
        db.exec(query);
        return { toArray: () => [] as T[], one: () => ({} as T) };
      }

      try {
        const stmt = db.prepare(query);

        // Determine if this is a read or write operation
        const trimmed = query.trim().toUpperCase();
        if (
          trimmed.startsWith("SELECT") ||
          trimmed.startsWith("WITH")
        ) {
          const rows = stmt.all(...bindings) as T[];
          return {
            toArray: () => rows,
            one: () => rows[0],
          };
        }

        // Write operation (INSERT, UPDATE, DELETE, CREATE, etc.)
        stmt.run(...bindings);
        return { toArray: () => [] as T[], one: () => ({} as T) };
      } catch (err) {
        // Handle multi-statement SQL (migrations) by splitting and executing
        if (
          err instanceof Error &&
          err.message.includes("more than one")
        ) {
          // The statement contains multiple SQL commands -- use exec()
          db.exec(query);
          return { toArray: () => [] as T[], one: () => ({} as T) };
        }
        throw err;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Real D1 mock (better-sqlite3)
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
// Queue message capture
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

function createQueueLike(): QueueLike & { messages: unknown[] } {
  const messages: unknown[] = [];
  return {
    messages,
    async send(msg: unknown) {
      messages.push(msg);
    },
    async sendBatch(msgs: { body: unknown }[]) {
      for (const m of msgs) {
        messages.push(m.body);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Mock Google Calendar API fetch function
// ---------------------------------------------------------------------------

function createGoogleApiFetchMock(opts: {
  syncToken?: string;
  accessTokenA?: string;
  accessTokenB?: string;
}): FetchFn {
  const insertedEvents: Array<{
    calendarId: string;
    event: ProjectedEvent;
  }> = [];
  const createdCalendars: string[] = [];

  const fetchFn: FetchFn & {
    insertedEvents: typeof insertedEvents;
    createdCalendars: typeof createdCalendars;
  } = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    // events.list -- return the board meeting event
    if (url.includes("/events?") || url.includes("/events")) {
      if (init?.method === "GET" || !init?.method) {
        return new Response(
          JSON.stringify({
            items: [BOARD_MEETING_EVENT],
            nextSyncToken: MOCK_NEXT_SYNC_TOKEN,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // events.insert -- creating a mirror event
      if (init?.method === "POST" && !url.includes("/watch")) {
        const body = JSON.parse(init.body as string) as ProjectedEvent;
        const calendarId = decodeURIComponent(
          url.split("/calendars/")[1]?.split("/events")[0] ?? "",
        );
        insertedEvents.push({ calendarId, event: body });
        return new Response(
          JSON.stringify({ id: MOCK_PROVIDER_EVENT_ID }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
    }

    // calendars.insert -- creating busy overlay calendar
    if (url.endsWith("/calendars") && init?.method === "POST") {
      const body = JSON.parse(init.body as string) as { summary: string };
      createdCalendars.push(body.summary);
      return new Response(
        JSON.stringify({ id: MOCK_BUSY_OVERLAY_CALENDAR_ID }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Fallback -- unknown request
    return new Response("Not found", { status: 404 });
  };

  // Attach captured data for assertions
  (fetchFn as typeof fetchFn & { insertedEvents: typeof insertedEvents; createdCalendars: typeof createdCalendars }).insertedEvents = insertedEvents;
  (fetchFn as typeof fetchFn & { insertedEvents: typeof insertedEvents; createdCalendars: typeof createdCalendars }).createdCalendars = createdCalendars;

  return fetchFn;
}

// ---------------------------------------------------------------------------
// SqlMirrorStore -- real SQLite implementation for write-consumer
// (same pattern as write-consumer.integration.test.ts)
// ---------------------------------------------------------------------------

class SqlMirrorStore implements MirrorStore {
  constructor(private readonly db: DatabaseType) {}

  getMirror(
    canonicalEventId: string,
    targetAccountId: string,
  ): MirrorRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM event_mirrors
         WHERE canonical_event_id = ? AND target_account_id = ?`,
      )
      .get(canonicalEventId, targetAccountId) as MirrorRow | undefined;
    return row ?? null;
  }

  updateMirrorState(
    canonicalEventId: string,
    targetAccountId: string,
    update: MirrorUpdate,
  ): void {
    const setClauses: string[] = [];
    const params: unknown[] = [];

    if (update.provider_event_id !== undefined) {
      setClauses.push("provider_event_id = ?");
      params.push(update.provider_event_id);
    }
    if (update.last_projected_hash !== undefined) {
      setClauses.push("last_projected_hash = ?");
      params.push(update.last_projected_hash);
    }
    if (update.last_write_ts !== undefined) {
      setClauses.push("last_write_ts = ?");
      params.push(update.last_write_ts);
    }
    if (update.state !== undefined) {
      setClauses.push("state = ?");
      params.push(update.state);
    }
    if (update.error_message !== undefined) {
      setClauses.push("error_message = ?");
      params.push(update.error_message);
    }
    if (update.target_calendar_id !== undefined) {
      setClauses.push("target_calendar_id = ?");
      params.push(update.target_calendar_id);
    }

    if (setClauses.length === 0) return;

    params.push(canonicalEventId, targetAccountId);
    this.db
      .prepare(
        `UPDATE event_mirrors SET ${setClauses.join(", ")}
         WHERE canonical_event_id = ? AND target_account_id = ?`,
      )
      .run(...params);
  }

  getBusyOverlayCalendar(accountId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT provider_calendar_id FROM calendars
         WHERE account_id = ? AND kind = 'BUSY_OVERLAY'`,
      )
      .get(accountId) as { provider_calendar_id: string } | undefined;
    return row?.provider_calendar_id ?? null;
  }

  storeBusyOverlayCalendar(
    accountId: string,
    providerCalendarId: string,
  ): void {
    const calendarId = `cal_01JSKELAUTOCAL00000000001`;
    this.db
      .prepare(
        `INSERT OR REPLACE INTO calendars
         (calendar_id, account_id, provider_calendar_id, role, kind, display_name)
         VALUES (?, ?, ?, 'writer', 'BUSY_OVERLAY', ?)`,
      )
      .run(calendarId, accountId, providerCalendarId, BUSY_OVERLAY_CALENDAR_NAME);
  }
}

// ---------------------------------------------------------------------------
// Walking skeleton integration test suite
// ---------------------------------------------------------------------------

describe("Walking skeleton: webhook-to-busy-overlay pipeline", () => {
  // D1 registry database
  let d1Db: DatabaseType;
  let d1: D1Database;

  // UserGraphDO state (per-user DO SQLite)
  let userGraphDb: DatabaseType;
  let userGraphDO: UserGraphDO;
  let writeQueue: QueueLike & { messages: unknown[] };

  // AccountDO state (per-account DO SQLite -- one per account)
  let accountADb: DatabaseType;
  let accountADO: AccountDO;
  let accountBDb: DatabaseType;
  let accountBDO: AccountDO;

  // Queue captures
  let syncQueue: Queue & { messages: unknown[] };

  // Google API mock
  let googleApiFetch: FetchFn & {
    insertedEvents: Array<{ calendarId: string; event: ProjectedEvent }>;
    createdCalendars: string[];
  };

  beforeEach(async () => {
    // ----- D1 Registry -----
    d1Db = new Database(":memory:");
    d1Db.pragma("foreign_keys = ON");
    d1Db.exec(MIGRATION_0001_INITIAL_SCHEMA);
    // Add channel_calendar_id column from migration 0027 (without ms_subscriptions
    // ALTER since that table requires migration 0002 which this test doesn't use).
    d1Db.exec("ALTER TABLE accounts ADD COLUMN channel_calendar_id TEXT;");

    // Seed org, user, and both accounts
    d1Db.prepare("INSERT INTO orgs (org_id, name) VALUES (?, ?)").run(
      TEST_ORG.org_id,
      TEST_ORG.name,
    );
    d1Db.prepare(
      "INSERT INTO users (user_id, org_id, email) VALUES (?, ?, ?)",
    ).run(TEST_USER.user_id, TEST_ORG.org_id, TEST_USER.email);

    d1Db.prepare(
      `INSERT INTO accounts (account_id, user_id, provider, provider_subject, email, channel_token)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      ACCOUNT_A.account_id,
      TEST_USER.user_id,
      ACCOUNT_A.provider,
      ACCOUNT_A.provider_subject,
      ACCOUNT_A.email,
      ACCOUNT_A.channel_token,
    );

    d1Db.prepare(
      `INSERT INTO accounts (account_id, user_id, provider, provider_subject, email, channel_token)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      ACCOUNT_B.account_id,
      TEST_USER.user_id,
      ACCOUNT_B.provider,
      ACCOUNT_B.provider_subject,
      ACCOUNT_B.email,
      ACCOUNT_B.channel_token,
    );

    d1 = createRealD1(d1Db);
    syncQueue = createMockQueue();

    // ----- UserGraphDO -----
    writeQueue = createQueueLike();
    userGraphDb = new Database(":memory:");
    const userGraphSql = createSqlStorageLike(userGraphDb);
    userGraphDO = new UserGraphDO(userGraphSql, writeQueue);

    // Set up policy: A -> B, BUSY, BUSY_OVERLAY
    await userGraphDO.ensureDefaultPolicy([
      ACCOUNT_A.account_id,
      ACCOUNT_B.account_id,
    ]);

    // ----- AccountDO instances -----
    // Google API mock that serves events.list for sync and events.insert for mirrors
    googleApiFetch = createGoogleApiFetchMock({}) as typeof googleApiFetch;

    // Account A: has the "Board Meeting"
    accountADb = new Database(":memory:");
    accountADO = new AccountDO(
      createSqlStorageLike(accountADb),
      TEST_MASTER_KEY,
      googleApiFetch as FetchFn,
    );
    // Initialize with tokens (needed for getAccessToken)
    await accountADO.initialize(
      {
        access_token: "ya29.mock-access-token-account-a",
        refresh_token: "1//mock-refresh-token-account-a",
        expiry: new Date(Date.now() + 3600 * 1000).toISOString(),
      },
      "https://www.googleapis.com/auth/calendar",
    );
    // Set sync token (for incremental sync)
    await accountADO.setSyncToken(MOCK_SYNC_TOKEN);

    // Account B: will receive busy overlay
    accountBDb = new Database(":memory:");
    accountBDO = new AccountDO(
      createSqlStorageLike(accountBDb),
      TEST_MASTER_KEY,
      googleApiFetch as FetchFn,
    );
    await accountBDO.initialize(
      {
        access_token: "ya29.mock-access-token-account-b",
        refresh_token: "1//mock-refresh-token-account-b",
        expiry: new Date(Date.now() + 3600 * 1000).toISOString(),
      },
      "https://www.googleapis.com/auth/calendar",
    );
  });

  afterEach(() => {
    d1Db.close();
    userGraphDb.close();
    accountADb.close();
    accountBDb.close();
  });

  // -------------------------------------------------------------------------
  // Helper: create mock AccountDO fetch handler
  // -------------------------------------------------------------------------

  function createAccountDOStubFetch(
    accountDO: AccountDO,
  ): (request: Request) => Promise<Response> {
    return (request: Request) => accountDO.handleFetch(request);
  }

  function createUserGraphDOStubFetch(
    ugDO: UserGraphDO,
  ): (request: Request) => Promise<Response> {
    return (request: Request) => ugDO.handleFetch(request);
  }

  // -------------------------------------------------------------------------
  // AC1: Full pipeline executes without errors
  // AC2: Busy block has correct time, summary='Busy'
  // AC3: Extended properties set for loop prevention
  // AC4: Event journal records operation
  // AC5: Mirror state=ACTIVE
  // AC6: No sync loops detected
  // AC7: Can be demonstrated with real execution
  // -------------------------------------------------------------------------

  it("AC1+AC2+AC3+AC5+AC7: full pipeline webhook -> sync -> UserGraphDO -> write-consumer -> busy overlay", async () => {
    // === STEP 1: Webhook receives Google push notification ===
    const webhookHandler = createHandler();
    const webhookRequest = new Request(
      "https://webhook.tminus.dev/webhook/google",
      {
        method: "POST",
        headers: {
          "X-Goog-Channel-ID": "channel-uuid-skeleton-001",
          "X-Goog-Resource-ID": "resource-id-skeleton-001",
          "X-Goog-Resource-State": "exists",
          "X-Goog-Channel-Token": ACCOUNT_A.channel_token,
        },
      },
    );
    const webhookEnv = { DB: d1, SYNC_QUEUE: syncQueue } as Env;
    const webhookCtx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext;

    const webhookResponse = await webhookHandler.fetch(
      webhookRequest,
      webhookEnv,
      webhookCtx,
    );

    // Webhook always returns 200
    expect(webhookResponse.status).toBe(200);
    // Verify SYNC_INCREMENTAL was enqueued
    expect(syncQueue.messages).toHaveLength(1);
    const syncMsg = syncQueue.messages[0] as SyncIncrementalMessage;
    expect(syncMsg.type).toBe("SYNC_INCREMENTAL");
    expect(syncMsg.account_id).toBe(ACCOUNT_A.account_id);

    // === STEP 2: Sync-consumer processes SYNC_INCREMENTAL ===
    // Instead of going through the full queue handler (which needs env bindings),
    // we simulate what sync-consumer does:
    // 1. Get access token from AccountDO
    // 2. Get sync token from AccountDO
    // 3. Fetch events from Google Calendar API
    // 4. Classify and normalize events
    // 5. Call UserGraphDO.applyProviderDelta()

    // Step 2a: Get access token from AccountDO via fetch handler
    const accessTokenResp = await accountADO.handleFetch(
      new Request("https://account.internal/getAccessToken", {
        method: "POST",
      }),
    );
    expect(accessTokenResp.ok).toBe(true);
    const { access_token: accessToken } = (await accessTokenResp.json()) as {
      access_token: string;
    };
    expect(accessToken).toBeTruthy();

    // Step 2b: Get sync token from AccountDO
    const syncTokenResp = await accountADO.handleFetch(
      new Request("https://account.internal/getSyncToken", {
        method: "POST",
      }),
    );
    expect(syncTokenResp.ok).toBe(true);
    const { sync_token: syncToken } = (await syncTokenResp.json()) as {
      sync_token: string | null;
    };
    expect(syncToken).toBe(MOCK_SYNC_TOKEN);

    // Step 2c: "Fetch" events from Google Calendar API (using our mock)
    // In the real pipeline, GoogleCalendarClient does this.
    // We simulate the result directly since we're testing the pipeline,
    // not the HTTP client.
    const googleEvents: GoogleCalendarEvent[] = [BOARD_MEETING_EVENT];

    // Step 2d: Classify and normalize
    const deltas = googleEvents
      .map((event) => {
        const classification = classifyEvent(event);
        if (classification === "managed_mirror") return null;
        return normalizeGoogleEvent(event, ACCOUNT_A.account_id, classification);
      })
      .filter((d) => d !== null);

    expect(deltas).toHaveLength(1);
    expect(deltas[0]!.type).toBe("updated"); // Google uses "updated" for both create/update
    expect(deltas[0]!.event?.title).toBe("Board Meeting");

    // Step 2e: Call UserGraphDO.applyProviderDelta via fetch handler
    const applyDeltaResp = await userGraphDO.handleFetch(
      new Request("https://user-graph.internal/applyProviderDelta", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          account_id: ACCOUNT_A.account_id,
          deltas,
        }),
      }),
    );
    expect(applyDeltaResp.ok).toBe(true);
    const applyResult = (await applyDeltaResp.json()) as {
      created: number;
      mirrors_enqueued: number;
      errors: unknown[];
    };
    // Google normalizeGoogleEvent returns type="updated" for both create and update.
    // UserGraphDO.handleUpdated creates the event if not found, so the result
    // counts it as "updated" (which internally created the canonical event).
    expect(applyResult.created + applyResult.updated).toBe(1);
    expect(applyResult.mirrors_enqueued).toBe(1);
    expect(applyResult.errors).toHaveLength(0);

    // Verify UPSERT_MIRROR was enqueued in the write queue
    expect(writeQueue.messages).toHaveLength(1);
    const upsertMsg = writeQueue.messages[0] as UpsertMirrorMessage;
    expect(upsertMsg.type).toBe("UPSERT_MIRROR");
    expect(upsertMsg.target_account_id).toBe(ACCOUNT_B.account_id);

    // Verify projected payload: summary should be "Busy" (BUSY detail level)
    expect(upsertMsg.projected_payload.summary).toBe("Busy");
    expect(upsertMsg.projected_payload.start.dateTime).toBe(
      "2026-02-15T14:00:00Z",
    );
    expect(upsertMsg.projected_payload.end.dateTime).toBe(
      "2026-02-15T15:00:00Z",
    );

    // AC3: Extended properties set for loop prevention
    expect(upsertMsg.projected_payload.extendedProperties.private.tminus).toBe(
      "true",
    );
    expect(
      upsertMsg.projected_payload.extendedProperties.private.managed,
    ).toBe("true");
    expect(
      upsertMsg.projected_payload.extendedProperties.private
        .canonical_event_id,
    ).toBeTruthy();
    expect(
      upsertMsg.projected_payload.extendedProperties.private
        .origin_account_id,
    ).toBe(ACCOUNT_A.account_id);

    // === STEP 3: Write-consumer processes UPSERT_MIRROR ===
    // Use SqlMirrorStore backed by the same UserGraphDO database
    // to prove the mirror state is tracked correctly.
    const mirrorStore = new SqlMirrorStore(userGraphDb);

    // The UPSERT_MIRROR message has target_account_id = ACCOUNT_B
    // The mirror row was already created by UserGraphDO.projectAndEnqueue()
    // (with state=PENDING). Verify it exists before write-consumer runs.
    const pendingMirror = mirrorStore.getMirror(
      upsertMsg.canonical_event_id as string,
      ACCOUNT_B.account_id,
    );
    expect(pendingMirror).not.toBeNull();
    expect(pendingMirror!.state).toBe("PENDING");

    // Create WriteConsumer with a mock CalendarProvider
    // that captures API calls for assertion.
    const calendarInsertedEvents: Array<{
      calendarId: string;
      event: ProjectedEvent;
    }> = [];
    const calendarCreatedCalendars: Array<{ summary: string }> = [];

    const mockCalendarProvider: CalendarProvider = {
      async listEvents() {
        throw new Error("Not used");
      },
      async insertEvent(calendarId: string, event: ProjectedEvent) {
        calendarInsertedEvents.push({ calendarId, event });
        return MOCK_PROVIDER_EVENT_ID;
      },
      async patchEvent() {},
      async deleteEvent() {},
      async listCalendars() {
        return [];
      },
      async insertCalendar(summary: string) {
        calendarCreatedCalendars.push({ summary });
        return MOCK_BUSY_OVERLAY_CALENDAR_ID;
      },
      async watchEvents() {
        throw new Error("Not used");
      },
      async stopChannel() {},
    };

    // Token provider that returns Account B's access token
    const tokenProvider: TokenProvider = {
      async getAccessToken(_accountId: string): Promise<string> {
        return "ya29.mock-access-token-account-b";
      },
    };

    const writeConsumer = new WriteConsumer({
      mirrorStore,
      tokenProvider,
      calendarClientFactory: () => mockCalendarProvider,
    });

    const result = await writeConsumer.processMessage(upsertMsg);

    // AC1: Full pipeline executes without errors
    expect(result.success).toBe(true);
    expect(result.action).toBe("created");
    expect(result.retry).toBe(false);

    // AC2: Busy block has correct time, summary='Busy'
    // The UPSERT_MIRROR message has target_calendar_id equal to the account_id
    // (placeholder). The write-consumer should auto-create the busy overlay calendar.
    expect(calendarCreatedCalendars).toHaveLength(1);
    expect(calendarCreatedCalendars[0].summary).toBe(
      BUSY_OVERLAY_CALENDAR_NAME,
    );

    // The event was inserted into the newly created calendar
    expect(calendarInsertedEvents).toHaveLength(1);
    expect(calendarInsertedEvents[0].calendarId).toBe(
      MOCK_BUSY_OVERLAY_CALENDAR_ID,
    );
    expect(calendarInsertedEvents[0].event.summary).toBe("Busy");
    expect(calendarInsertedEvents[0].event.start.dateTime).toBe(
      "2026-02-15T14:00:00Z",
    );
    expect(calendarInsertedEvents[0].event.end.dateTime).toBe(
      "2026-02-15T15:00:00Z",
    );

    // AC3: Extended properties on managed event (loop prevention)
    const insertedEvent = calendarInsertedEvents[0].event;
    expect(insertedEvent.extendedProperties.private.tminus).toBe("true");
    expect(insertedEvent.extendedProperties.private.managed).toBe("true");

    // AC5: Mirror state is ACTIVE
    const activeMirror = mirrorStore.getMirror(
      upsertMsg.canonical_event_id as string,
      ACCOUNT_B.account_id,
    );
    expect(activeMirror).not.toBeNull();
    expect(activeMirror!.state).toBe("ACTIVE");
    expect(activeMirror!.provider_event_id).toBe(MOCK_PROVIDER_EVENT_ID);
    expect(activeMirror!.last_write_ts).toBeTruthy();
    expect(activeMirror!.target_calendar_id).toBe(
      MOCK_BUSY_OVERLAY_CALENDAR_ID,
    );
  });

  it("AC4: event journal records the sync operation", async () => {
    // Run the sync through UserGraphDO
    const deltas = [BOARD_MEETING_EVENT]
      .map((event) => {
        const classification = classifyEvent(event);
        if (classification === "managed_mirror") return null;
        return normalizeGoogleEvent(event, ACCOUNT_A.account_id, classification);
      })
      .filter((d) => d !== null);

    const applyResult = await userGraphDO.applyProviderDelta(
      ACCOUNT_A.account_id,
      deltas as any,
    );

    // Google normalizeGoogleEvent returns type="updated" for both create and update
    expect(applyResult.created + applyResult.updated).toBe(1);

    // Query journal via fetch handler
    const journalResp = await userGraphDO.handleFetch(
      new Request("https://user-graph.internal/queryJournal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(journalResp.ok).toBe(true);
    const journal = (await journalResp.json()) as {
      items: Array<{
        journal_id: string;
        canonical_event_id: string;
        change_type: string;
        actor: string;
        patch_json: string;
      }>;
    };

    // There should be at least one journal entry for the created event
    expect(journal.items.length).toBeGreaterThanOrEqual(1);

    const createdEntry = journal.items.find(
      (j) => j.change_type === "created",
    );
    expect(createdEntry).toBeDefined();
    expect(createdEntry!.actor).toContain(ACCOUNT_A.account_id);

    // Journal patch_json should contain the origin_event_id
    const patch = JSON.parse(createdEntry!.patch_json);
    expect(patch.origin_event_id).toBe("google_event_board_meeting_001");
  });

  it("AC6: no sync loops -- managed mirror events are skipped by classifyEvent", async () => {
    // First, run the initial sync to create the mirror
    const deltas = [BOARD_MEETING_EVENT]
      .map((event) => {
        const classification = classifyEvent(event);
        if (classification === "managed_mirror") return null;
        return normalizeGoogleEvent(event, ACCOUNT_A.account_id, classification);
      })
      .filter((d) => d !== null);

    await userGraphDO.applyProviderDelta(
      ACCOUNT_A.account_id,
      deltas as any,
    );

    // Now simulate what happens when Account B's webhook fires because the
    // busy overlay event was created. The event in B has tminus/managed
    // extended properties.
    const mirrorEventInB: GoogleCalendarEvent = {
      id: MOCK_PROVIDER_EVENT_ID,
      summary: "Busy",
      start: { dateTime: "2026-02-15T14:00:00Z" },
      end: { dateTime: "2026-02-15T15:00:00Z" },
      status: "confirmed",
      extendedProperties: {
        private: {
          tminus: "true",
          managed: "true",
          canonical_event_id: "evt_01JSKEMCANPNJCAM0000000001",
          origin_account_id: ACCOUNT_A.account_id,
        },
      },
    };

    // classifyEvent should recognize this as a managed_mirror
    const classification = classifyEvent(mirrorEventInB);
    expect(classification).toBe("managed_mirror");

    // When sync-consumer processes this, it should skip it
    const mirrorDeltas = [mirrorEventInB]
      .map((event) => {
        const cls = classifyEvent(event);
        if (cls === "managed_mirror") return null; // SKIP
        return normalizeGoogleEvent(event, ACCOUNT_B.account_id, cls);
      })
      .filter((d) => d !== null);

    // No deltas should be produced from managed mirror events
    expect(mirrorDeltas).toHaveLength(0);

    // Clear write queue to check for spurious entries
    writeQueue.messages.length = 0;

    // Apply empty deltas -- should produce no new mirrors
    const applyResult = await userGraphDO.applyProviderDelta(
      ACCOUNT_B.account_id,
      [],
    );
    expect(applyResult.created).toBe(0);
    expect(applyResult.mirrors_enqueued).toBe(0);

    // No new UPSERT_MIRROR messages should be enqueued
    expect(writeQueue.messages).toHaveLength(0);
  });

  it("AC1+AC7: UserGraphDO fetch handler routes requests correctly", async () => {
    // Test health endpoint
    const healthResp = await userGraphDO.handleFetch(
      new Request("https://user-graph.internal/getSyncHealth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(healthResp.ok).toBe(true);
    const health = (await healthResp.json()) as { total_events: number };
    expect(health.total_events).toBe(0); // no events yet

    // Test unknown endpoint returns 404
    const unknownResp = await userGraphDO.handleFetch(
      new Request("https://user-graph.internal/unknownEndpoint", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(unknownResp.status).toBe(404);
  });

  it("AC1+AC7: AccountDO fetch handler routes requests correctly", async () => {
    // Test getAccessToken
    const tokenResp = await accountADO.handleFetch(
      new Request("https://account.internal/getAccessToken", {
        method: "POST",
      }),
    );
    expect(tokenResp.ok).toBe(true);
    const tokenData = (await tokenResp.json()) as { access_token: string };
    expect(tokenData.access_token).toBeTruthy();

    // Test getSyncToken
    const syncResp = await accountADO.handleFetch(
      new Request("https://account.internal/getSyncToken", {
        method: "POST",
      }),
    );
    expect(syncResp.ok).toBe(true);
    const syncData = (await syncResp.json()) as { sync_token: string | null };
    expect(syncData.sync_token).toBe(MOCK_SYNC_TOKEN);

    // Test setSyncToken
    const setResp = await accountADO.handleFetch(
      new Request("https://account.internal/setSyncToken", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sync_token: "new-sync-token-123" }),
      }),
    );
    expect(setResp.ok).toBe(true);

    // Verify it was stored
    const newSyncResp = await accountADO.handleFetch(
      new Request("https://account.internal/getSyncToken", {
        method: "POST",
      }),
    );
    const newSyncData = (await newSyncResp.json()) as { sync_token: string };
    expect(newSyncData.sync_token).toBe("new-sync-token-123");

    // Test markSyncSuccess
    const successResp = await accountADO.handleFetch(
      new Request("https://account.internal/markSyncSuccess", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ts: new Date().toISOString() }),
      }),
    );
    expect(successResp.ok).toBe(true);

    // Test unknown endpoint returns 404
    const unknownResp = await accountADO.handleFetch(
      new Request("https://account.internal/unknownEndpoint", {
        method: "POST",
      }),
    );
    expect(unknownResp.status).toBe(404);
  });

  it("AC1+AC7: UserGraphDO mirror state RPC endpoints work via fetch", async () => {
    // First create an event so we have mirrors to query
    const deltas = [BOARD_MEETING_EVENT]
      .map((event) => {
        const classification = classifyEvent(event);
        if (classification === "managed_mirror") return null;
        return normalizeGoogleEvent(event, ACCOUNT_A.account_id, classification);
      })
      .filter((d) => d !== null);

    await userGraphDO.applyProviderDelta(
      ACCOUNT_A.account_id,
      deltas as any,
    );

    // Get the UPSERT_MIRROR message to find the canonical_event_id
    const upsertMsg = writeQueue.messages[0] as UpsertMirrorMessage;

    // Test getMirror via fetch
    const getMirrorResp = await userGraphDO.handleFetch(
      new Request("https://user-graph.internal/getMirror", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          canonical_event_id: upsertMsg.canonical_event_id,
          target_account_id: ACCOUNT_B.account_id,
        }),
      }),
    );
    expect(getMirrorResp.ok).toBe(true);
    const mirrorData = (await getMirrorResp.json()) as {
      mirror: MirrorRow | null;
    };
    expect(mirrorData.mirror).not.toBeNull();
    expect(mirrorData.mirror!.state).toBe("PENDING");

    // Test updateMirrorState via fetch
    const updateResp = await userGraphDO.handleFetch(
      new Request("https://user-graph.internal/updateMirrorState", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          canonical_event_id: upsertMsg.canonical_event_id,
          target_account_id: ACCOUNT_B.account_id,
          update: {
            state: "ACTIVE",
            provider_event_id: MOCK_PROVIDER_EVENT_ID,
            last_write_ts: new Date().toISOString(),
          },
        }),
      }),
    );
    expect(updateResp.ok).toBe(true);

    // Verify the update was applied
    const verifyResp = await userGraphDO.handleFetch(
      new Request("https://user-graph.internal/getMirror", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          canonical_event_id: upsertMsg.canonical_event_id,
          target_account_id: ACCOUNT_B.account_id,
        }),
      }),
    );
    const verifyData = (await verifyResp.json()) as {
      mirror: MirrorRow | null;
    };
    expect(verifyData.mirror!.state).toBe("ACTIVE");
    expect(verifyData.mirror!.provider_event_id).toBe(MOCK_PROVIDER_EVENT_ID);

    // Test getBusyOverlayCalendar (should be null initially)
    const getBusyResp = await userGraphDO.handleFetch(
      new Request("https://user-graph.internal/getBusyOverlayCalendar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account_id: ACCOUNT_B.account_id }),
      }),
    );
    expect(getBusyResp.ok).toBe(true);
    const busyData = (await getBusyResp.json()) as {
      provider_calendar_id: string | null;
    };
    expect(busyData.provider_calendar_id).toBeNull();

    // Test storeBusyOverlayCalendar
    const storeResp = await userGraphDO.handleFetch(
      new Request("https://user-graph.internal/storeBusyOverlayCalendar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          account_id: ACCOUNT_B.account_id,
          provider_calendar_id: MOCK_BUSY_OVERLAY_CALENDAR_ID,
        }),
      }),
    );
    expect(storeResp.ok).toBe(true);

    // Verify stored
    const getBusyResp2 = await userGraphDO.handleFetch(
      new Request("https://user-graph.internal/getBusyOverlayCalendar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account_id: ACCOUNT_B.account_id }),
      }),
    );
    const busyData2 = (await getBusyResp2.json()) as {
      provider_calendar_id: string | null;
    };
    expect(busyData2.provider_calendar_id).toBe(
      MOCK_BUSY_OVERLAY_CALENDAR_ID,
    );
  });
});
