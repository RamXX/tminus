/**
 * E2E validation: bidirectional sync with loop prevention proof.
 *
 * Story TM-dhg -- Final Phase 1 validation proving the complete pipeline
 * works end-to-end with comprehensive integration tests.
 *
 * 7 Scenarios:
 * 1. Create propagation: A -> webhook -> sync -> projection -> write -> Busy in B
 * 2. Update propagation: Move event in A -> updated Busy in B
 * 3. Delete propagation: Delete event in A -> Busy removed from B
 * 4. Bidirectional sync: Create in B -> Busy appears in A
 * 5. Loop prevention: Mirror in B does NOT trigger re-sync back to A
 * 6. Three-account topology: A<->B, A<->C, B<->C all work without loops
 * 7. Drift reconciliation: Manually delete mirror, run reconcile, verify recreation
 *
 * What is mocked (external service boundaries ONLY):
 * - Google Calendar API (events.list, events.insert, events.patch, events.delete,
 *   calendars.insert)
 * - Queue runtime (message capture instead of Cloudflare queues)
 *
 * What is real:
 * - D1 registry (better-sqlite3)
 * - UserGraphDO SQL state (better-sqlite3 via SqlStorageLike adapter)
 * - AccountDO SQL state (better-sqlite3 via SqlStorageLike adapter)
 * - Event classification (classifyEvent) and normalization (normalizeGoogleEvent)
 * - Policy compilation (compileProjection) and projection hashing
 * - WriteConsumer business logic
 * - Token encryption/decryption in AccountDO
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { createHandler } from "../../webhook/src/index";
import { UserGraphDO } from "../../../durable-objects/user-graph/src/index";
import type { QueueLike } from "../../../durable-objects/user-graph/src/index";
import { AccountDO } from "../../../durable-objects/account/src/index";
import { WriteConsumer } from "./write-consumer";
import type {
  MirrorStore,
  MirrorRow,
  MirrorUpdate,
  TokenProvider,
} from "./write-consumer";
import { MIGRATION_0001_INITIAL_SCHEMA } from "@tminus/d1-registry";
import {
  BUSY_OVERLAY_CALENDAR_NAME,
  classifyEvent,
  normalizeGoogleEvent,
} from "@tminus/shared";
import type {
  UpsertMirrorMessage,
  DeleteMirrorMessage,
  AccountId,
  GoogleCalendarEvent,
  ProjectedEvent,
  CalendarProvider,
} from "@tminus/shared";

// ---------------------------------------------------------------------------
// Test fixture IDs (valid ULID: prefix + 26 Crockford Base32)
// ---------------------------------------------------------------------------

const TEST_ORG = {
  org_id: "org_01JE2ETEST00000000000001",
  name: "E2E Bidirectional Sync Org",
} as const;

const TEST_USER = {
  user_id: "usr_01JE2ETEST00000000000001",
  email: "e2e@example.com",
} as const;

const ACCOUNT_A = {
  account_id: "acc_01JE2ETESTACCOUNTA000001" as AccountId,
  provider: "google",
  provider_subject: "google-sub-e2e-a",
  email: "alice@gmail.com",
  channel_token: "secret-e2e-token-a",
} as const;

const ACCOUNT_B = {
  account_id: "acc_01JE2ETESTACCOUNTB000001" as AccountId,
  provider: "google",
  provider_subject: "google-sub-e2e-b",
  email: "alice-work@gmail.com",
  channel_token: "secret-e2e-token-b",
} as const;

const ACCOUNT_C = {
  account_id: "acc_01JE2ETESTACCOUNTC000001" as AccountId,
  provider: "google",
  provider_subject: "google-sub-e2e-c",
  email: "alice-personal@gmail.com",
  channel_token: "secret-e2e-token-c",
} as const;

const TEST_MASTER_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const MOCK_SYNC_TOKEN = "CAAL==mock-e2e-sync-token";

// ---------------------------------------------------------------------------
// Google Calendar events for testing
// ---------------------------------------------------------------------------

const BOARD_MEETING: GoogleCalendarEvent = {
  id: "google_evt_board_meeting_e2e",
  summary: "Board Meeting",
  start: { dateTime: "2026-02-15T14:00:00Z" },
  end: { dateTime: "2026-02-15T15:00:00Z" },
  status: "confirmed",
  visibility: "default",
  transparency: "opaque",
};

const BOARD_MEETING_UPDATED: GoogleCalendarEvent = {
  id: "google_evt_board_meeting_e2e",
  summary: "Board Meeting (Moved)",
  start: { dateTime: "2026-02-15T16:00:00Z" },
  end: { dateTime: "2026-02-15T17:00:00Z" },
  status: "confirmed",
  visibility: "default",
  transparency: "opaque",
};

const BOARD_MEETING_DELETED: GoogleCalendarEvent = {
  id: "google_evt_board_meeting_e2e",
  status: "cancelled",
};

const TEAM_STANDUP: GoogleCalendarEvent = {
  id: "google_evt_team_standup_e2e",
  summary: "Team Standup",
  start: { dateTime: "2026-02-16T09:00:00Z" },
  end: { dateTime: "2026-02-16T09:30:00Z" },
  status: "confirmed",
  visibility: "default",
  transparency: "opaque",
};

const PERSONAL_APPT: GoogleCalendarEvent = {
  id: "google_evt_personal_appt_e2e",
  summary: "Doctor Appointment",
  start: { dateTime: "2026-02-17T10:00:00Z" },
  end: { dateTime: "2026-02-17T11:00:00Z" },
  status: "confirmed",
  visibility: "private",
  transparency: "opaque",
};

// ---------------------------------------------------------------------------
// SqlStorageLike adapter for better-sqlite3
// ---------------------------------------------------------------------------

function createSqlStorageLike(db: DatabaseType) {
  return {
    exec<T extends Record<string, unknown>>(
      query: string,
      ...bindings: unknown[]
    ) {
      if (query.trim().toUpperCase().startsWith("PRAGMA")) {
        db.exec(query);
        return { toArray: () => [] as T[], one: () => ({}) as T };
      }

      try {
        const stmt = db.prepare(query);
        const trimmed = query.trim().toUpperCase();
        if (trimmed.startsWith("SELECT") || trimmed.startsWith("WITH")) {
          const rows = stmt.all(...bindings) as T[];
          return { toArray: () => rows, one: () => rows[0] };
        }
        stmt.run(...bindings);
        return { toArray: () => [] as T[], one: () => ({}) as T };
      } catch (err) {
        if (
          err instanceof Error &&
          err.message.includes("more than one")
        ) {
          db.exec(query);
          return { toArray: () => [] as T[], one: () => ({}) as T };
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
// SqlMirrorStore -- real SQLite implementation for write-consumer
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
    const calendarId = `cal_01JE2EAUTO${accountId.slice(-10)}01`;
    this.db
      .prepare(
        `INSERT OR REPLACE INTO calendars
         (calendar_id, account_id, provider_calendar_id, role, kind, display_name)
         VALUES (?, ?, ?, 'writer', 'BUSY_OVERLAY', ?)`,
      )
      .run(
        calendarId,
        accountId,
        providerCalendarId,
        BUSY_OVERLAY_CALENDAR_NAME,
      );
  }
}

// ---------------------------------------------------------------------------
// Mock Calendar Provider that captures operations
// ---------------------------------------------------------------------------

interface CalendarCapture {
  insertedEvents: Array<{ calendarId: string; event: ProjectedEvent }>;
  patchedEvents: Array<{
    calendarId: string;
    eventId: string;
    event: ProjectedEvent;
  }>;
  deletedEvents: Array<{ calendarId: string; eventId: string }>;
  createdCalendars: Array<{ summary: string }>;
}

function createMockCalendarProvider(
  capture: CalendarCapture,
  providerEventIdPrefix: string,
  calendarIdPrefix: string,
): CalendarProvider {
  let insertCounter = 0;
  let calendarCounter = 0;
  return {
    async listEvents() {
      throw new Error("Not used");
    },
    async insertEvent(calendarId: string, event: ProjectedEvent) {
      insertCounter++;
      const id = `${providerEventIdPrefix}_${insertCounter}`;
      capture.insertedEvents.push({ calendarId, event });
      return id;
    },
    async patchEvent(
      calendarId: string,
      eventId: string,
      event: ProjectedEvent,
    ) {
      capture.patchedEvents.push({ calendarId, eventId, event });
    },
    async deleteEvent(calendarId: string, eventId: string) {
      capture.deletedEvents.push({ calendarId, eventId });
    },
    async listCalendars() {
      return [];
    },
    async insertCalendar(summary: string) {
      calendarCounter++;
      const id = `${calendarIdPrefix}_${calendarCounter}@group.calendar.google.com`;
      capture.createdCalendars.push({ summary });
      return id;
    },
    async watchEvents() {
      throw new Error("Not used");
    },
    async stopChannel() {},
  };
}

// ---------------------------------------------------------------------------
// Helper: simulate the full sync pipeline for an account
// ---------------------------------------------------------------------------

/**
 * Simulates what happens when a webhook fires for an account:
 * 1. Classify and normalize events from Google
 * 2. Apply deltas to UserGraphDO (creates canonical events + enqueues mirrors)
 * 3. Process resulting write-queue messages via WriteConsumer
 *
 * Returns: write-queue messages that were produced.
 */
async function runSyncPipeline(opts: {
  googleEvents: GoogleCalendarEvent[];
  accountId: AccountId;
  userGraphDO: UserGraphDO;
  writeQueue: QueueLike & { messages: unknown[] };
  writeConsumer: WriteConsumer;
}): Promise<{
  deltas: ReturnType<typeof normalizeGoogleEvent>[];
  applyResult: { created: number; updated: number; deleted: number; mirrors_enqueued: number; errors: unknown[] };
  writeResults: Array<{ success: boolean; action: string }>;
}> {
  const { googleEvents, accountId, userGraphDO, writeQueue, writeConsumer } =
    opts;

  // Step 1: Classify and normalize
  const deltas = googleEvents
    .map((event) => {
      const classification = classifyEvent(event);
      if (classification === "managed_mirror") return null;
      return normalizeGoogleEvent(event, accountId, classification);
    })
    .filter((d) => d !== null);

  // Step 2: Apply to UserGraphDO
  const prevMsgCount = writeQueue.messages.length;
  const applyResult = await userGraphDO.applyProviderDelta(
    accountId,
    deltas as any,
  );

  // Step 3: Process write-queue messages produced by this sync
  const newMessages = writeQueue.messages.slice(prevMsgCount);
  const writeResults: Array<{ success: boolean; action: string }> = [];

  for (const msg of newMessages) {
    const typedMsg = msg as UpsertMirrorMessage | DeleteMirrorMessage;
    const result = await writeConsumer.processMessage(typedMsg);
    writeResults.push({ success: result.success, action: result.action });
  }

  return { deltas, applyResult, writeResults };
}

// ---------------------------------------------------------------------------
// E2E bidirectional sync test suite
// ---------------------------------------------------------------------------

describe("E2E validation: bidirectional sync with loop prevention", () => {
  // D1 registry database
  let d1Db: DatabaseType;
  let d1: D1Database;

  // UserGraphDO state
  let userGraphDb: DatabaseType;
  let userGraphDO: UserGraphDO;
  let writeQueue: QueueLike & { messages: unknown[] };
  let mirrorStore: SqlMirrorStore;

  // AccountDOs
  let accountADb: DatabaseType;
  let accountADO: AccountDO;
  let accountBDb: DatabaseType;
  let accountBDO: AccountDO;
  let accountCDb: DatabaseType;
  let accountCDO: AccountDO;

  // Queue capture
  let syncQueue: Queue & { messages: unknown[] };

  // Calendar provider capture
  let calendarCapture: CalendarCapture;
  let writeConsumer: WriteConsumer;

  // Token provider that delegates to real AccountDOs
  let tokenProvider: TokenProvider;

  beforeEach(async () => {
    // ----- D1 Registry -----
    d1Db = new Database(":memory:");
    d1Db.pragma("foreign_keys = ON");
    d1Db.exec(MIGRATION_0001_INITIAL_SCHEMA);

    d1Db
      .prepare("INSERT INTO orgs (org_id, name) VALUES (?, ?)")
      .run(TEST_ORG.org_id, TEST_ORG.name);
    d1Db
      .prepare(
        "INSERT INTO users (user_id, org_id, email) VALUES (?, ?, ?)",
      )
      .run(TEST_USER.user_id, TEST_ORG.org_id, TEST_USER.email);

    for (const acct of [ACCOUNT_A, ACCOUNT_B, ACCOUNT_C]) {
      d1Db
        .prepare(
          `INSERT INTO accounts (account_id, user_id, provider, provider_subject, email, channel_token)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          acct.account_id,
          TEST_USER.user_id,
          acct.provider,
          acct.provider_subject,
          acct.email,
          acct.channel_token,
        );
    }

    d1 = createRealD1(d1Db);
    syncQueue = createMockQueue();

    // ----- UserGraphDO -----
    writeQueue = createQueueLike();
    userGraphDb = new Database(":memory:");
    const userGraphSql = createSqlStorageLike(userGraphDb);
    userGraphDO = new UserGraphDO(userGraphSql, writeQueue);
    mirrorStore = new SqlMirrorStore(userGraphDb);

    // ----- AccountDOs (no Google API fetch needed for token tests) -----
    const noopFetch = async () =>
      new Response("Not found", { status: 404 });

    accountADb = new Database(":memory:");
    accountADO = new AccountDO(
      createSqlStorageLike(accountADb),
      TEST_MASTER_KEY,
      noopFetch,
    );
    await accountADO.initialize(
      {
        access_token: "ya29.mock-access-token-account-a",
        refresh_token: "1//mock-refresh-token-account-a",
        expiry: new Date(Date.now() + 3600 * 1000).toISOString(),
      },
      "https://www.googleapis.com/auth/calendar",
    );
    await accountADO.setSyncToken(MOCK_SYNC_TOKEN);

    accountBDb = new Database(":memory:");
    accountBDO = new AccountDO(
      createSqlStorageLike(accountBDb),
      TEST_MASTER_KEY,
      noopFetch,
    );
    await accountBDO.initialize(
      {
        access_token: "ya29.mock-access-token-account-b",
        refresh_token: "1//mock-refresh-token-account-b",
        expiry: new Date(Date.now() + 3600 * 1000).toISOString(),
      },
      "https://www.googleapis.com/auth/calendar",
    );
    await accountBDO.setSyncToken(MOCK_SYNC_TOKEN);

    accountCDb = new Database(":memory:");
    accountCDO = new AccountDO(
      createSqlStorageLike(accountCDb),
      TEST_MASTER_KEY,
      noopFetch,
    );
    await accountCDO.initialize(
      {
        access_token: "ya29.mock-access-token-account-c",
        refresh_token: "1//mock-refresh-token-account-c",
        expiry: new Date(Date.now() + 3600 * 1000).toISOString(),
      },
      "https://www.googleapis.com/auth/calendar",
    );
    await accountCDO.setSyncToken(MOCK_SYNC_TOKEN);

    // ----- Token provider using real AccountDOs -----
    const accountDOs: Record<string, AccountDO> = {
      [ACCOUNT_A.account_id]: accountADO,
      [ACCOUNT_B.account_id]: accountBDO,
      [ACCOUNT_C.account_id]: accountCDO,
    };

    tokenProvider = {
      async getAccessToken(accountId: string): Promise<string> {
        const ado = accountDOs[accountId];
        if (!ado) throw new Error(`Unknown account: ${accountId}`);
        return ado.getAccessToken();
      },
    };

    // ----- Calendar provider capture -----
    calendarCapture = {
      insertedEvents: [],
      patchedEvents: [],
      deletedEvents: [],
      createdCalendars: [],
    };

    writeConsumer = new WriteConsumer({
      mirrorStore,
      tokenProvider,
      calendarClientFactory: () =>
        createMockCalendarProvider(
          calendarCapture,
          "gcal_mirror_evt",
          "e2e-busy-overlay",
        ),
    });
  });

  afterEach(() => {
    d1Db.close();
    userGraphDb.close();
    accountADb.close();
    accountBDb.close();
    accountCDb.close();
  });

  // -------------------------------------------------------------------------
  // Scenario 1: Create propagation A -> B
  // AC1: Create in Account A produces Busy in Account B
  // -------------------------------------------------------------------------

  it("Scenario 1 (AC1): event created in Account A produces Busy overlay in Account B", async () => {
    // Set up bidirectional policy A<->B
    await userGraphDO.ensureDefaultPolicy([
      ACCOUNT_A.account_id,
      ACCOUNT_B.account_id,
    ]);

    const { deltas, applyResult, writeResults } = await runSyncPipeline({
      googleEvents: [BOARD_MEETING],
      accountId: ACCOUNT_A.account_id,
      userGraphDO,
      writeQueue,
      writeConsumer,
    });

    // Classification: origin event (no extended properties)
    expect(deltas).toHaveLength(1);
    expect(deltas[0]!.type).toBe("updated"); // Google treats all as "updated"
    expect(deltas[0]!.event?.title).toBe("Board Meeting");

    // UserGraphDO created a canonical event and enqueued 1 mirror (A->B)
    expect(applyResult.created + applyResult.updated).toBe(1);
    expect(applyResult.mirrors_enqueued).toBe(1);
    expect(applyResult.errors).toHaveLength(0);

    // WriteConsumer created the mirror event
    expect(writeResults).toHaveLength(1);
    expect(writeResults[0].success).toBe(true);
    expect(writeResults[0].action).toBe("created");

    // Verify the Busy overlay calendar was auto-created
    expect(calendarCapture.createdCalendars).toHaveLength(1);
    expect(calendarCapture.createdCalendars[0].summary).toBe(
      BUSY_OVERLAY_CALENDAR_NAME,
    );

    // Verify the inserted event is a Busy block with correct times
    expect(calendarCapture.insertedEvents).toHaveLength(1);
    const busyEvent = calendarCapture.insertedEvents[0];
    expect(busyEvent.event.summary).toBe("Busy");
    expect(busyEvent.event.start.dateTime).toBe("2026-02-15T14:00:00Z");
    expect(busyEvent.event.end.dateTime).toBe("2026-02-15T15:00:00Z");

    // Verify extended properties for loop prevention
    expect(busyEvent.event.extendedProperties.private.tminus).toBe("true");
    expect(busyEvent.event.extendedProperties.private.managed).toBe("true");
    expect(
      busyEvent.event.extendedProperties.private.canonical_event_id,
    ).toBeTruthy();
    expect(
      busyEvent.event.extendedProperties.private.origin_account_id,
    ).toBe(ACCOUNT_A.account_id);

    // Verify mirror state is ACTIVE in the DB
    const upsertMsg = writeQueue.messages[0] as UpsertMirrorMessage;
    const mirror = mirrorStore.getMirror(
      upsertMsg.canonical_event_id as string,
      ACCOUNT_B.account_id,
    );
    expect(mirror).not.toBeNull();
    expect(mirror!.state).toBe("ACTIVE");
    expect(mirror!.provider_event_id).toBeTruthy();
    expect(mirror!.last_write_ts).toBeTruthy();

    // Verify canonical event in UserGraphDO
    const health = userGraphDO.getSyncHealth();
    expect(health.total_events).toBe(1);
    expect(health.total_mirrors).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Scenario 2: Update propagation
  // AC2: Updates propagate correctly
  // -------------------------------------------------------------------------

  it("Scenario 2 (AC2): updating event in Account A updates Busy overlay in Account B", async () => {
    await userGraphDO.ensureDefaultPolicy([
      ACCOUNT_A.account_id,
      ACCOUNT_B.account_id,
    ]);

    // First: create the event
    await runSyncPipeline({
      googleEvents: [BOARD_MEETING],
      accountId: ACCOUNT_A.account_id,
      userGraphDO,
      writeQueue,
      writeConsumer,
    });

    // Record state before update
    const insertedCountBefore = calendarCapture.insertedEvents.length;

    // Now: update the event (moved time)
    const { applyResult, writeResults } = await runSyncPipeline({
      googleEvents: [BOARD_MEETING_UPDATED],
      accountId: ACCOUNT_A.account_id,
      userGraphDO,
      writeQueue,
      writeConsumer,
    });

    // UserGraphDO updated the existing canonical event
    expect(applyResult.updated).toBe(1);
    expect(applyResult.created).toBe(0);
    expect(applyResult.mirrors_enqueued).toBe(1);

    // WriteConsumer patched the mirror (not inserted a new one)
    expect(writeResults).toHaveLength(1);
    expect(writeResults[0].success).toBe(true);
    expect(writeResults[0].action).toBe("updated");

    // Verify PATCH was called (not INSERT)
    expect(calendarCapture.patchedEvents).toHaveLength(1);
    const patchedEvent = calendarCapture.patchedEvents[0];
    expect(patchedEvent.event.summary).toBe("Busy");
    expect(patchedEvent.event.start.dateTime).toBe("2026-02-15T16:00:00Z");
    expect(patchedEvent.event.end.dateTime).toBe("2026-02-15T17:00:00Z");

    // No new events were inserted for the update
    expect(calendarCapture.insertedEvents.length).toBe(insertedCountBefore);

    // Mirror state is still ACTIVE
    const upsertMsg = writeQueue.messages.find(
      (m) => (m as UpsertMirrorMessage).type === "UPSERT_MIRROR",
    ) as UpsertMirrorMessage;
    const mirror = mirrorStore.getMirror(
      upsertMsg.canonical_event_id as string,
      ACCOUNT_B.account_id,
    );
    expect(mirror!.state).toBe("ACTIVE");
  });

  // -------------------------------------------------------------------------
  // Scenario 3: Delete propagation
  // AC3: Deletes propagate correctly
  // -------------------------------------------------------------------------

  it("Scenario 3 (AC3): deleting event in Account A removes Busy overlay from Account B", async () => {
    await userGraphDO.ensureDefaultPolicy([
      ACCOUNT_A.account_id,
      ACCOUNT_B.account_id,
    ]);

    // Create the event first
    await runSyncPipeline({
      googleEvents: [BOARD_MEETING],
      accountId: ACCOUNT_A.account_id,
      userGraphDO,
      writeQueue,
      writeConsumer,
    });

    // Verify event exists before deletion
    const healthBefore = userGraphDO.getSyncHealth();
    expect(healthBefore.total_events).toBe(1);
    expect(healthBefore.total_mirrors).toBe(1);

    // Delete the event
    const { deltas, applyResult, writeResults } = await runSyncPipeline({
      googleEvents: [BOARD_MEETING_DELETED],
      accountId: ACCOUNT_A.account_id,
      userGraphDO,
      writeQueue,
      writeConsumer,
    });

    // Classification: deleted event
    expect(deltas).toHaveLength(1);
    expect(deltas[0]!.type).toBe("deleted");

    // UserGraphDO hard-deleted the canonical event (BR-7) and enqueued mirror deletion
    expect(applyResult.deleted).toBe(1);

    // WriteConsumer processed the DELETE_MIRROR
    expect(writeResults).toHaveLength(1);
    expect(writeResults[0].success).toBe(true);
    expect(writeResults[0].action).toBe("deleted");

    // Verify delete was called on the Google API
    expect(calendarCapture.deletedEvents).toHaveLength(1);

    // Verify canonical event store is empty
    const healthAfter = userGraphDO.getSyncHealth();
    expect(healthAfter.total_events).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Scenario 4: Bidirectional sync
  // AC4: Bidirectional sync works (B->A and A->B)
  // -------------------------------------------------------------------------

  it("Scenario 4 (AC4): bidirectional sync -- events in B produce Busy in A", async () => {
    await userGraphDO.ensureDefaultPolicy([
      ACCOUNT_A.account_id,
      ACCOUNT_B.account_id,
    ]);

    // Create event in Account B
    const { applyResult, writeResults } = await runSyncPipeline({
      googleEvents: [TEAM_STANDUP],
      accountId: ACCOUNT_B.account_id,
      userGraphDO,
      writeQueue,
      writeConsumer,
    });

    // Mirror should go B->A
    expect(applyResult.mirrors_enqueued).toBe(1);
    expect(writeResults).toHaveLength(1);
    expect(writeResults[0].success).toBe(true);
    expect(writeResults[0].action).toBe("created");

    // Verify the UPSERT_MIRROR targets Account A (not B)
    const upsertMsg = writeQueue.messages[0] as UpsertMirrorMessage;
    expect(upsertMsg.target_account_id).toBe(ACCOUNT_A.account_id);

    // Verify busy event was inserted for Account A
    expect(calendarCapture.insertedEvents).toHaveLength(1);
    const busyEvent = calendarCapture.insertedEvents[0];
    expect(busyEvent.event.summary).toBe("Busy");
    expect(busyEvent.event.start.dateTime).toBe("2026-02-16T09:00:00Z");
    expect(busyEvent.event.end.dateTime).toBe("2026-02-16T09:30:00Z");
    expect(busyEvent.event.extendedProperties.private.origin_account_id).toBe(
      ACCOUNT_B.account_id,
    );

    // Verify both directions work: now create event in A
    const resultA = await runSyncPipeline({
      googleEvents: [BOARD_MEETING],
      accountId: ACCOUNT_A.account_id,
      userGraphDO,
      writeQueue,
      writeConsumer,
    });

    // Mirror should go A->B
    expect(resultA.applyResult.mirrors_enqueued).toBe(1);
    expect(resultA.writeResults).toHaveLength(1);
    expect(resultA.writeResults[0].success).toBe(true);

    // Total: 2 canonical events, 2 mirrors
    const health = userGraphDO.getSyncHealth();
    expect(health.total_events).toBe(2);
    expect(health.total_mirrors).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Scenario 5: Loop prevention (CRITICAL)
  // AC5: NO sync loops under any sequence of creates/updates/deletes
  // -------------------------------------------------------------------------

  it("Scenario 5 (AC5): mirror creation in B does NOT trigger re-sync back to A -- classifyEvent returns managed_mirror", async () => {
    await userGraphDO.ensureDefaultPolicy([
      ACCOUNT_A.account_id,
      ACCOUNT_B.account_id,
    ]);

    // Step 1: Create event in A -> produces Busy mirror in B
    const { applyResult } = await runSyncPipeline({
      googleEvents: [BOARD_MEETING],
      accountId: ACCOUNT_A.account_id,
      userGraphDO,
      writeQueue,
      writeConsumer,
    });

    expect(applyResult.mirrors_enqueued).toBe(1);

    // Step 2: Simulate Account B's webhook firing because the Busy event
    // was created in B's calendar. The event from B's perspective has
    // the tminus/managed extended properties.
    const upsertMsg = writeQueue.messages[0] as UpsertMirrorMessage;
    const mirrorEventInB: GoogleCalendarEvent = {
      id: "gcal_mirror_evt_1", // The provider_event_id from the mock
      summary: "Busy",
      start: { dateTime: "2026-02-15T14:00:00Z" },
      end: { dateTime: "2026-02-15T15:00:00Z" },
      status: "confirmed",
      extendedProperties: {
        private: {
          tminus: "true",
          managed: "true",
          canonical_event_id: upsertMsg.canonical_event_id as string,
          origin_account_id: ACCOUNT_A.account_id,
        },
      },
    };

    // CRITICAL: classifyEvent must return "managed_mirror"
    const classification = classifyEvent(mirrorEventInB);
    expect(classification).toBe("managed_mirror");

    // The sync pipeline filters out managed_mirror events before calling
    // UserGraphDO.applyProviderDelta, producing zero deltas.
    const mirrorDeltas = [mirrorEventInB]
      .map((event) => {
        const cls = classifyEvent(event);
        if (cls === "managed_mirror") return null;
        return normalizeGoogleEvent(event, ACCOUNT_B.account_id, cls);
      })
      .filter((d) => d !== null);

    expect(mirrorDeltas).toHaveLength(0);

    // Clear write queue to check for spurious entries
    const prevCount = writeQueue.messages.length;

    // Even if we call applyProviderDelta with empty deltas, no mirrors enqueued
    const applyEmpty = await userGraphDO.applyProviderDelta(
      ACCOUNT_B.account_id,
      [],
    );
    expect(applyEmpty.created).toBe(0);
    expect(applyEmpty.updated).toBe(0);
    expect(applyEmpty.deleted).toBe(0);
    expect(applyEmpty.mirrors_enqueued).toBe(0);

    // No new messages in write queue
    expect(writeQueue.messages.length).toBe(prevCount);
  });

  it("Scenario 5 (AC5): loop prevention under rapid create/update/delete sequence", async () => {
    await userGraphDO.ensureDefaultPolicy([
      ACCOUNT_A.account_id,
      ACCOUNT_B.account_id,
    ]);

    // Create -> Update -> Delete in rapid succession from Account A
    // After each step, simulate B's webhook with the mirror event.
    // No loops should occur at any point.

    // CREATE
    await runSyncPipeline({
      googleEvents: [BOARD_MEETING],
      accountId: ACCOUNT_A.account_id,
      userGraphDO,
      writeQueue,
      writeConsumer,
    });

    const upsertMsg1 = writeQueue.messages[0] as UpsertMirrorMessage;
    const mirrorInB_create: GoogleCalendarEvent = {
      id: "gcal_mirror_evt_1",
      summary: "Busy",
      start: { dateTime: "2026-02-15T14:00:00Z" },
      end: { dateTime: "2026-02-15T15:00:00Z" },
      status: "confirmed",
      extendedProperties: {
        private: {
          tminus: "true",
          managed: "true",
          canonical_event_id: upsertMsg1.canonical_event_id as string,
          origin_account_id: ACCOUNT_A.account_id,
        },
      },
    };
    expect(classifyEvent(mirrorInB_create)).toBe("managed_mirror");

    // UPDATE
    await runSyncPipeline({
      googleEvents: [BOARD_MEETING_UPDATED],
      accountId: ACCOUNT_A.account_id,
      userGraphDO,
      writeQueue,
      writeConsumer,
    });

    const mirrorInB_update: GoogleCalendarEvent = {
      ...mirrorInB_create,
      start: { dateTime: "2026-02-15T16:00:00Z" },
      end: { dateTime: "2026-02-15T17:00:00Z" },
    };
    expect(classifyEvent(mirrorInB_update)).toBe("managed_mirror");

    // DELETE
    await runSyncPipeline({
      googleEvents: [BOARD_MEETING_DELETED],
      accountId: ACCOUNT_A.account_id,
      userGraphDO,
      writeQueue,
      writeConsumer,
    });

    const mirrorInB_delete: GoogleCalendarEvent = {
      ...mirrorInB_create,
      status: "cancelled",
    };
    // Even cancelled events with tminus markers are managed_mirror
    expect(classifyEvent(mirrorInB_delete)).toBe("managed_mirror");

    // After the full sequence, the canonical store should be empty
    const health = userGraphDO.getSyncHealth();
    expect(health.total_events).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Scenario 6: Three-account topology
  // AC6: Three-account topology works
  // -------------------------------------------------------------------------

  it("Scenario 6 (AC6): three-account topology A<->B, A<->C, B<->C all sync without loops", async () => {
    // Set up full mesh: A<->B, A<->C, B<->C
    await userGraphDO.ensureDefaultPolicy([
      ACCOUNT_A.account_id,
      ACCOUNT_B.account_id,
      ACCOUNT_C.account_id,
    ]);

    // Event in A -> should produce mirrors in B and C
    const resultA = await runSyncPipeline({
      googleEvents: [BOARD_MEETING],
      accountId: ACCOUNT_A.account_id,
      userGraphDO,
      writeQueue,
      writeConsumer,
    });

    expect(resultA.applyResult.mirrors_enqueued).toBe(2);
    expect(resultA.writeResults).toHaveLength(2);
    expect(resultA.writeResults.every((r) => r.success)).toBe(true);

    // Event in B -> should produce mirrors in A and C
    const resultB = await runSyncPipeline({
      googleEvents: [TEAM_STANDUP],
      accountId: ACCOUNT_B.account_id,
      userGraphDO,
      writeQueue,
      writeConsumer,
    });

    expect(resultB.applyResult.mirrors_enqueued).toBe(2);
    expect(resultB.writeResults).toHaveLength(2);
    expect(resultB.writeResults.every((r) => r.success)).toBe(true);

    // Event in C -> should produce mirrors in A and B
    const resultC = await runSyncPipeline({
      googleEvents: [PERSONAL_APPT],
      accountId: ACCOUNT_C.account_id,
      userGraphDO,
      writeQueue,
      writeConsumer,
    });

    expect(resultC.applyResult.mirrors_enqueued).toBe(2);
    expect(resultC.writeResults).toHaveLength(2);
    expect(resultC.writeResults.every((r) => r.success)).toBe(true);

    // Total: 3 canonical events, 6 mirrors (each event mirrored to 2 others)
    const health = userGraphDO.getSyncHealth();
    expect(health.total_events).toBe(3);
    expect(health.total_mirrors).toBe(6);

    // Loop prevention: simulate all 6 mirror events appearing in their
    // target accounts' webhooks. None should produce deltas.
    for (const msg of writeQueue.messages) {
      const typedMsg = msg as UpsertMirrorMessage;
      if (typedMsg.type !== "UPSERT_MIRROR") continue;

      const mirrorEvent: GoogleCalendarEvent = {
        id: `gcal_mirror_response_${typedMsg.canonical_event_id}`,
        summary: typedMsg.projected_payload.summary,
        start: typedMsg.projected_payload.start,
        end: typedMsg.projected_payload.end,
        status: "confirmed",
        extendedProperties: {
          private: {
            tminus: "true",
            managed: "true",
            canonical_event_id:
              typedMsg.projected_payload.extendedProperties.private
                .canonical_event_id,
            origin_account_id:
              typedMsg.projected_payload.extendedProperties.private
                .origin_account_id,
          },
        },
      };

      // Every mirror event must be classified as managed_mirror
      const cls = classifyEvent(mirrorEvent);
      expect(cls).toBe("managed_mirror");
    }

    // Verify journal records all operations
    const journal = userGraphDO.queryJournal({ limit: 100 });
    expect(journal.items.length).toBeGreaterThanOrEqual(3);
  });

  // -------------------------------------------------------------------------
  // Scenario 7: Drift reconciliation
  // AC7: Drift reconciliation detects and repairs
  // -------------------------------------------------------------------------

  it("Scenario 7 (AC7): drift reconciliation -- deleted mirror is recreated by recomputeProjections", async () => {
    await userGraphDO.ensureDefaultPolicy([
      ACCOUNT_A.account_id,
      ACCOUNT_B.account_id,
    ]);

    // Create event and mirror
    await runSyncPipeline({
      googleEvents: [BOARD_MEETING],
      accountId: ACCOUNT_A.account_id,
      userGraphDO,
      writeQueue,
      writeConsumer,
    });

    // Verify mirror is ACTIVE
    const upsertMsg = writeQueue.messages[0] as UpsertMirrorMessage;
    const canonicalEventId = upsertMsg.canonical_event_id as string;
    let mirror = mirrorStore.getMirror(canonicalEventId, ACCOUNT_B.account_id);
    expect(mirror).not.toBeNull();
    expect(mirror!.state).toBe("ACTIVE");

    // Simulate drift: manually delete the mirror row
    userGraphDb
      .prepare(
        `DELETE FROM event_mirrors WHERE canonical_event_id = ? AND target_account_id = ?`,
      )
      .run(canonicalEventId, ACCOUNT_B.account_id);

    // Verify mirror is gone
    mirror = mirrorStore.getMirror(canonicalEventId, ACCOUNT_B.account_id);
    expect(mirror).toBeNull();

    const healthDrifted = userGraphDO.getSyncHealth();
    expect(healthDrifted.total_mirrors).toBe(0);

    // Reconcile: recomputeProjections should detect the missing mirror and re-enqueue
    const prevMsgCount = writeQueue.messages.length;
    const enqueuedCount = await userGraphDO.recomputeProjections();

    expect(enqueuedCount).toBe(1);

    // Process the new mirror write
    const newMsg = writeQueue.messages[
      writeQueue.messages.length - 1
    ] as UpsertMirrorMessage;
    expect(newMsg.type).toBe("UPSERT_MIRROR");
    expect(newMsg.target_account_id).toBe(ACCOUNT_B.account_id);

    const writeResult = await writeConsumer.processMessage(newMsg);
    expect(writeResult.success).toBe(true);
    expect(writeResult.action).toBe("created");

    // Verify mirror is recreated with ACTIVE state
    mirror = mirrorStore.getMirror(canonicalEventId, ACCOUNT_B.account_id);
    expect(mirror).not.toBeNull();
    expect(mirror!.state).toBe("ACTIVE");
    expect(mirror!.provider_event_id).toBeTruthy();

    const healthReconciled = userGraphDO.getSyncHealth();
    expect(healthReconciled.total_mirrors).toBe(1);
  });

  // -------------------------------------------------------------------------
  // AC8: All operations are idempotent
  // -------------------------------------------------------------------------

  it("AC8: duplicate UPSERT_MIRROR messages are idempotent", async () => {
    await userGraphDO.ensureDefaultPolicy([
      ACCOUNT_A.account_id,
      ACCOUNT_B.account_id,
    ]);

    // Create event
    await runSyncPipeline({
      googleEvents: [BOARD_MEETING],
      accountId: ACCOUNT_A.account_id,
      userGraphDO,
      writeQueue,
      writeConsumer,
    });

    // Get the UPSERT_MIRROR message
    const upsertMsg = writeQueue.messages[0] as UpsertMirrorMessage;

    // Process the same message again (simulate queue retry)
    const result2 = await writeConsumer.processMessage(upsertMsg);
    // Second attempt: mirror is already ACTIVE, should skip
    expect(result2.success).toBe(true);
    expect(result2.action).toBe("skipped");

    // Should still have only 1 inserted event (not 2)
    expect(calendarCapture.insertedEvents).toHaveLength(1);

    // Mirror state unchanged
    const mirror = mirrorStore.getMirror(
      upsertMsg.canonical_event_id as string,
      ACCOUNT_B.account_id,
    );
    expect(mirror!.state).toBe("ACTIVE");
  });

  it("AC8: applying the same provider delta twice is idempotent (write-skipping)", async () => {
    await userGraphDO.ensureDefaultPolicy([
      ACCOUNT_A.account_id,
      ACCOUNT_B.account_id,
    ]);

    // First sync: creates event + mirror
    await runSyncPipeline({
      googleEvents: [BOARD_MEETING],
      accountId: ACCOUNT_A.account_id,
      userGraphDO,
      writeQueue,
      writeConsumer,
    });

    const msgCountAfterFirst = writeQueue.messages.length;

    // Second sync with the SAME event: should skip mirror enqueue (hash match)
    const { applyResult } = await runSyncPipeline({
      googleEvents: [BOARD_MEETING],
      accountId: ACCOUNT_A.account_id,
      userGraphDO,
      writeQueue,
      writeConsumer,
    });

    // Event was "updated" (upsert), but NO mirrors enqueued (hash identical)
    expect(applyResult.updated).toBe(1);
    expect(applyResult.mirrors_enqueued).toBe(0);

    // No new messages in write queue
    expect(writeQueue.messages.length).toBe(msgCountAfterFirst);
  });

  // -------------------------------------------------------------------------
  // AC9: Token refresh works automatically
  // -------------------------------------------------------------------------

  it("AC9: token refresh works via AccountDO -- expired token triggers refresh", async () => {
    // Create an AccountDO with an already-expired token and a mock
    // fetch that returns a new token on refresh.
    const expiredDb = new Database(":memory:");
    const mockRefreshFetch = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;

      // Handle token refresh request
      if (url.includes("oauth2.googleapis.com/token")) {
        return new Response(
          JSON.stringify({
            access_token: "ya29.refreshed-token-abc",
            expires_in: 3600,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("Not found", { status: 404 });
    };

    const expiredAccountDO = new AccountDO(
      createSqlStorageLike(expiredDb),
      TEST_MASTER_KEY,
      mockRefreshFetch,
    );

    // Initialize with an EXPIRED token
    await expiredAccountDO.initialize(
      {
        access_token: "ya29.expired-old-token",
        refresh_token: "1//mock-refresh-token-for-refresh-test",
        expiry: new Date(Date.now() - 3600 * 1000).toISOString(), // 1 hour ago
      },
      "https://www.googleapis.com/auth/calendar",
    );

    // getAccessToken should trigger refresh and return the new token
    const token = await expiredAccountDO.getAccessToken();
    expect(token).toBe("ya29.refreshed-token-abc");

    expiredDb.close();
  });

  // -------------------------------------------------------------------------
  // AC10: Sync status shows healthy for all accounts
  // -------------------------------------------------------------------------

  it("AC10: sync health shows correct state after successful operations", async () => {
    await userGraphDO.ensureDefaultPolicy([
      ACCOUNT_A.account_id,
      ACCOUNT_B.account_id,
    ]);

    // Initial health: empty
    const healthEmpty = userGraphDO.getSyncHealth();
    expect(healthEmpty.total_events).toBe(0);
    expect(healthEmpty.total_mirrors).toBe(0);
    expect(healthEmpty.pending_mirrors).toBe(0);
    expect(healthEmpty.error_mirrors).toBe(0);

    // Sync an event
    await runSyncPipeline({
      googleEvents: [BOARD_MEETING],
      accountId: ACCOUNT_A.account_id,
      userGraphDO,
      writeQueue,
      writeConsumer,
    });

    // Health after sync: 1 event, 1 active mirror, 0 pending, 0 error
    const healthAfter = userGraphDO.getSyncHealth();
    expect(healthAfter.total_events).toBe(1);
    expect(healthAfter.total_mirrors).toBe(1);
    expect(healthAfter.pending_mirrors).toBe(0); // WriteConsumer set it to ACTIVE
    expect(healthAfter.error_mirrors).toBe(0);
    expect(healthAfter.total_journal_entries).toBeGreaterThanOrEqual(1);
    expect(healthAfter.last_journal_ts).toBeTruthy();

    // AccountDO health checks
    for (const ado of [accountADO, accountBDO]) {
      const health = await ado.getHealth();
      // fullSyncNeeded is false because we set sync tokens during init
      expect(health.fullSyncNeeded).toBe(false);
    }

    // Mark sync success on Account A
    await accountADO.markSyncSuccess(new Date().toISOString());
    const healthA = await accountADO.getHealth();
    expect(healthA.lastSuccessTs).toBeTruthy();
    expect(healthA.lastSyncTs).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // ULID format verification
  // -------------------------------------------------------------------------

  it("all entity IDs use valid ULID format with correct prefixes", async () => {
    await userGraphDO.ensureDefaultPolicy([
      ACCOUNT_A.account_id,
      ACCOUNT_B.account_id,
    ]);

    await runSyncPipeline({
      googleEvents: [BOARD_MEETING],
      accountId: ACCOUNT_A.account_id,
      userGraphDO,
      writeQueue,
      writeConsumer,
    });

    // Check canonical_event_id format (evt_ prefix)
    const upsertMsg = writeQueue.messages[0] as UpsertMirrorMessage;
    const eventId = upsertMsg.canonical_event_id as string;
    expect(eventId).toMatch(/^evt_[0-9A-Z]{26}$/);

    // Check journal entry IDs (jrn_ prefix)
    const journal = userGraphDO.queryJournal();
    for (const entry of journal.items) {
      expect(entry.journal_id).toMatch(/^jrn_[0-9A-Z]{26}$/);
    }

    // Check idempotency_key format (hex SHA-256)
    expect(upsertMsg.idempotency_key).toMatch(/^[0-9a-f]{64}$/);
  });

  // -------------------------------------------------------------------------
  // Webhook integration
  // -------------------------------------------------------------------------

  it("webhook handler enqueues SYNC_INCREMENTAL with correct account_id", async () => {
    const webhookHandler = createHandler();
    const webhookRequest = new Request(
      "https://webhook.tminus.dev/webhook/google",
      {
        method: "POST",
        headers: {
          "X-Goog-Channel-ID": "channel-uuid-e2e-001",
          "X-Goog-Resource-ID": "resource-id-e2e-001",
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

    expect(webhookResponse.status).toBe(200);
    expect(syncQueue.messages).toHaveLength(1);

    const syncMsg = syncQueue.messages[0] as {
      type: string;
      account_id: string;
    };
    expect(syncMsg.type).toBe("SYNC_INCREMENTAL");
    expect(syncMsg.account_id).toBe(ACCOUNT_A.account_id);
  });

  // -------------------------------------------------------------------------
  // Edge case: event with partial extended properties is still origin
  // -------------------------------------------------------------------------

  it("event with only tminus=true (no managed=true) is classified as origin, not managed_mirror", () => {
    const partialEvent: GoogleCalendarEvent = {
      id: "google_evt_partial",
      summary: "Partial Props Event",
      start: { dateTime: "2026-02-18T10:00:00Z" },
      end: { dateTime: "2026-02-18T11:00:00Z" },
      status: "confirmed",
      extendedProperties: {
        private: {
          tminus: "true",
          // managed is MISSING
        },
      },
    };

    expect(classifyEvent(partialEvent)).toBe("origin");
  });

  it("event with managed=true but no tminus=true is classified as origin", () => {
    const partialEvent: GoogleCalendarEvent = {
      id: "google_evt_partial_2",
      summary: "Partial Props Event 2",
      start: { dateTime: "2026-02-18T12:00:00Z" },
      end: { dateTime: "2026-02-18T13:00:00Z" },
      status: "confirmed",
      extendedProperties: {
        private: {
          managed: "true",
          // tminus is MISSING
        },
      },
    };

    expect(classifyEvent(partialEvent)).toBe("origin");
  });
});
