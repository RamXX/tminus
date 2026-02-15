/**
 * Integration tests for GroupScheduleDO multi-user scheduling coordination (TM-82s.1).
 *
 * Uses real SQLite (better-sqlite3) to test the full multi-user flow:
 * 1. Two users with separate UserGraphDOs
 * 2. GroupScheduleDO gathers availability from both
 * 3. Mutually available times proposed
 * 4. Holds created in both users' calendars
 * 5. Atomic commit: events created in all calendars
 * 6. Privacy: no cross-user event details leaked
 *
 * Each user gets their own in-memory SQLite database, simulating the
 * real architecture where each UserGraphDO has its own DO SQLite storage.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import type { SqlStorageLike, SqlStorageCursorLike, AccountId } from "@tminus/shared";
import { UserGraphDO } from "@tminus/do-user-graph";
import type { QueueLike } from "@tminus/do-user-graph";
import { GroupScheduleDO } from "./index";
import type { GroupSessionParams } from "./index";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const ALICE_USER_ID = "usr_01ALICE00000000000000001";
const BOB_USER_ID = "usr_01BOB0000000000000000001";
const ALICE_ACCOUNT_ID = "acc_01ALICE_ACCT00000000001" as AccountId;
const BOB_ACCOUNT_ID = "acc_01BOB___ACCT00000000001" as AccountId;

// ---------------------------------------------------------------------------
// SqlStorage adapter
// ---------------------------------------------------------------------------

function createSqlStorageAdapter(db: DatabaseType): SqlStorageLike {
  return {
    exec<T extends Record<string, unknown>>(
      query: string,
      ...bindings: unknown[]
    ): SqlStorageCursorLike<T> {
      const trimmed = query.trim().toUpperCase();
      const isSelect =
        trimmed.startsWith("SELECT") ||
        trimmed.startsWith("PRAGMA") ||
        trimmed.startsWith("EXPLAIN");

      if (isSelect) {
        const stmt = db.prepare(query);
        const rows = stmt.all(...bindings) as T[];
        return {
          toArray(): T[] {
            return rows;
          },
          one(): T {
            if (rows.length === 0) {
              throw new Error("Expected at least one row, got none");
            }
            return rows[0];
          },
        };
      }

      if (bindings.length === 0) {
        db.exec(query);
      } else {
        db.prepare(query).run(...bindings);
      }

      return {
        toArray(): T[] {
          return [];
        },
        one(): T {
          throw new Error("No rows returned from non-SELECT statement");
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// MockQueue
// ---------------------------------------------------------------------------

class MockQueue implements QueueLike {
  messages: unknown[] = [];
  async send(message: unknown): Promise<void> {
    this.messages.push(message);
  }
  async sendBatch(messages: { body: unknown }[]): Promise<void> {
    for (const m of messages) {
      this.messages.push(m.body);
    }
  }
  clear(): void {
    this.messages = [];
  }
}

// ---------------------------------------------------------------------------
// Fake DurableObjectNamespace -- routes to per-user UserGraphDO instances
// ---------------------------------------------------------------------------

class FakeDOStub {
  private doInstance: UserGraphDO;

  constructor(doInstance: UserGraphDO) {
    this.doInstance = doInstance;
  }

  async fetch(request: Request | string, init?: RequestInit): Promise<Response> {
    const req = typeof request === "string" ? new Request(request, init) : request;
    return this.doInstance.handleFetch(req);
  }
}

/**
 * Creates a FakeNamespace that routes DO stubs to the correct
 * UserGraphDO instance based on the idFromName key (user ID).
 */
function createMultiUserNamespace(
  userDOs: Map<string, UserGraphDO>,
): DurableObjectNamespace {
  return {
    idFromName(name: string) {
      // Store the name on the ID object for later lookup
      return { name } as unknown as DurableObjectId;
    },
    get(id: DurableObjectId) {
      const name = (id as unknown as { name: string }).name;
      const doInstance = userDOs.get(name);
      if (!doInstance) {
        throw new Error(`No UserGraphDO found for user: ${name}`);
      }
      return new FakeDOStub(doInstance) as unknown as DurableObjectStub;
    },
    idFromString(_id: string) {
      return {} as DurableObjectId;
    },
    newUniqueId() {
      return {} as DurableObjectId;
    },
    jurisdiction(_jd: string) {
      return this;
    },
  } as unknown as DurableObjectNamespace;
}

// ---------------------------------------------------------------------------
// Fake D1Database -- in-memory for cross-user session registry
// ---------------------------------------------------------------------------

function createFakeD1(db: DatabaseType): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind(...bindings: unknown[]) {
          return {
            async run() {
              db.prepare(sql).run(...bindings);
              return { success: true, meta: {} };
            },
            async first<T>(): Promise<T | null> {
              const row = db.prepare(sql).get(...bindings);
              return (row as T) ?? null;
            },
            async all<T>(): Promise<{ results: T[] }> {
              const rows = db.prepare(sql).all(...bindings);
              return { results: rows as T[] };
            },
          };
        },
        async run() {
          db.exec(sql);
          return { success: true, meta: {} };
        },
        async first<T>(): Promise<T | null> {
          const row = db.prepare(sql).get();
          return (row as T) ?? null;
        },
        async all<T>(): Promise<{ results: T[] }> {
          const rows = db.prepare(sql).all();
          return { results: rows as T[] };
        },
      };
    },
    async exec(sql: string) {
      db.exec(sql);
      return { count: 0, duration: 0 };
    },
    async batch() {
      return [];
    },
    async dump() {
      return new ArrayBuffer(0);
    },
  } as unknown as D1Database;
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let aliceDb: DatabaseType;
let bobDb: DatabaseType;
let d1Db: DatabaseType;
let queue: MockQueue;
let aliceDO: UserGraphDO;
let bobDO: UserGraphDO;
let userGraphNamespace: DurableObjectNamespace;
let fakeD1: D1Database;

function createGroupDO(): GroupScheduleDO {
  return new GroupScheduleDO({
    USER_GRAPH: userGraphNamespace,
    WRITE_QUEUE: queue as unknown as Queue,
    DB: fakeD1,
  });
}

function makeGroupParams(overrides: Partial<GroupSessionParams> = {}): GroupSessionParams {
  return {
    creatorUserId: ALICE_USER_ID,
    participantUserIds: [ALICE_USER_ID, BOB_USER_ID],
    title: "Team Sync",
    durationMinutes: 30,
    windowStart: "2026-03-02T08:00:00Z",
    windowEnd: "2026-03-06T18:00:00Z",
    ...overrides,
  };
}

function insertEvent(
  db: DatabaseType,
  accountId: string,
  startTs: string,
  endTs: string,
  title = "Existing Meeting",
): void {
  const eventId = `evt_test_${Math.random().toString(36).slice(2, 10)}`;
  db.prepare(
    `INSERT INTO canonical_events (
      canonical_event_id, origin_account_id, origin_event_id,
      title, start_ts, end_ts, all_day, status, visibility,
      transparency, source, version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 0, 'confirmed', 'default', 'opaque', 'provider', 1, datetime('now'), datetime('now'))`,
  ).run(eventId, accountId, `origin_${eventId}`, title, startTs, endTs);
}

// Note: No insertAccount needed. The DO schema (UserGraphDO SQLite) does not
// have an accounts table -- that lives in D1. computeAvailability only queries
// canonical_events by origin_account_id, so we just need events with the
// correct origin_account_id to generate busy intervals.

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("GroupScheduleDO integration", () => {
  beforeEach(async () => {
    queue = new MockQueue();

    // Create separate SQLite databases for each user (simulates DO storage)
    aliceDb = new Database(":memory:");
    bobDb = new Database(":memory:");
    d1Db = new Database(":memory:");

    // Create the D1 group_scheduling_sessions table
    d1Db.exec(`
      CREATE TABLE group_scheduling_sessions (
        session_id           TEXT PRIMARY KEY,
        creator_user_id      TEXT NOT NULL,
        participant_ids_json TEXT NOT NULL,
        title                TEXT NOT NULL,
        status               TEXT NOT NULL DEFAULT 'gathering',
        created_at           TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    const aliceSql = createSqlStorageAdapter(aliceDb);
    const bobSql = createSqlStorageAdapter(bobDb);

    aliceDO = new UserGraphDO(aliceSql, queue);
    bobDO = new UserGraphDO(bobSql, queue);

    // Trigger lazy migration so DO tables exist before direct DB access.
    // UserGraphDO applies schema migrations on the first handleFetch call.
    await aliceDO.handleFetch(
      new Request("https://user-graph.internal/getSyncHealth"),
    );
    await bobDO.handleFetch(
      new Request("https://user-graph.internal/getSyncHealth"),
    );

    // Create the multi-user namespace
    const userDOs = new Map<string, UserGraphDO>();
    userDOs.set(ALICE_USER_ID, aliceDO);
    userDOs.set(BOB_USER_ID, bobDO);
    userGraphNamespace = createMultiUserNamespace(userDOs);

    fakeD1 = createFakeD1(d1Db);
  });

  // -----------------------------------------------------------------------
  // AC1: GroupScheduleDO coordinates multi-user session
  // -----------------------------------------------------------------------

  it("creates a group session with two participants", async () => {
    const groupDO = createGroupDO();
    const session = await groupDO.createGroupSession(makeGroupParams());

    expect(session.sessionId).toBeTruthy();
    expect(session.status).toBe("candidates_ready");
    expect(session.params.participantUserIds).toEqual([ALICE_USER_ID, BOB_USER_ID]);
    expect(session.candidates.length).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // AC2: Availability gathered from all participants
  // -----------------------------------------------------------------------

  it("gathers availability from both users and finds mutually free times", async () => {
    // Alice is busy 9-10 on Monday
    insertEvent(aliceDb, ALICE_ACCOUNT_ID, "2026-03-02T09:00:00Z", "2026-03-02T10:00:00Z", "Alice Meeting");
    // Bob is busy 10-11 on Monday
    insertEvent(bobDb, BOB_ACCOUNT_ID, "2026-03-02T10:00:00Z", "2026-03-02T11:00:00Z", "Bob Meeting");

    const groupDO = createGroupDO();
    const session = await groupDO.createGroupSession(makeGroupParams());

    expect(session.candidates.length).toBeGreaterThan(0);

    // None of the candidates should overlap with Alice's 9-10 or Bob's 10-11
    for (const candidate of session.candidates) {
      const start = new Date(candidate.start).getTime();
      const end = new Date(candidate.end).getTime();
      const aliceBusyStart = new Date("2026-03-02T09:00:00Z").getTime();
      const aliceBusyEnd = new Date("2026-03-02T10:00:00Z").getTime();
      const bobBusyStart = new Date("2026-03-02T10:00:00Z").getTime();
      const bobBusyEnd = new Date("2026-03-02T11:00:00Z").getTime();

      // No overlap with Alice's busy time
      const overlapsAlice = start < aliceBusyEnd && end > aliceBusyStart;
      // No overlap with Bob's busy time
      const overlapsBob = start < bobBusyEnd && end > bobBusyStart;

      expect(overlapsAlice).toBe(false);
      expect(overlapsBob).toBe(false);
    }
  });

  // -----------------------------------------------------------------------
  // AC3: Mutually available times proposed
  // -----------------------------------------------------------------------

  it("proposes scored candidates sorted by score", async () => {
    const groupDO = createGroupDO();
    const session = await groupDO.createGroupSession(makeGroupParams({
      maxCandidates: 3,
    }));

    expect(session.candidates.length).toBeLessThanOrEqual(3);
    expect(session.candidates.length).toBeGreaterThan(0);

    // Candidates should be sorted by score descending
    for (let i = 1; i < session.candidates.length; i++) {
      expect(session.candidates[i - 1].score).toBeGreaterThanOrEqual(session.candidates[i].score);
    }

    // Each candidate should have a human-readable explanation
    for (const c of session.candidates) {
      expect(c.explanation).toBeTruthy();
      expect(c.candidateId).toBeTruthy();
    }
  });

  // -----------------------------------------------------------------------
  // AC4: Tentative holds in all calendars
  // -----------------------------------------------------------------------

  it("creates holds for both participants via write queue", async () => {
    queue.clear();
    const groupDO = createGroupDO();
    const session = await groupDO.createGroupSession(makeGroupParams());

    // Write queue should have UPSERT_MIRROR messages for holds
    expect(queue.messages.length).toBeGreaterThan(0);

    // Each candidate creates holds for BOTH participants
    // So total messages = candidates * participants
    const expectedMessages = session.candidates.length * 2; // 2 participants
    expect(queue.messages.length).toBe(expectedMessages);

    // All messages should be UPSERT_MIRROR type
    for (const msg of queue.messages) {
      const m = msg as { type: string };
      expect(m.type).toBe("UPSERT_MIRROR");
    }
  });

  // -----------------------------------------------------------------------
  // AC5: Atomic commit (all or none)
  // -----------------------------------------------------------------------

  it("commits a candidate and creates events in both users' calendars", async () => {
    const groupDO = createGroupDO();
    const session = await groupDO.createGroupSession(makeGroupParams());
    expect(session.candidates.length).toBeGreaterThan(0);

    const candidateId = session.candidates[0].candidateId;
    const result = await groupDO.commitGroupSession(
      session.sessionId,
      candidateId,
      ALICE_USER_ID,
    );

    expect(result.eventIds[ALICE_USER_ID]).toBeTruthy();
    expect(result.eventIds[BOB_USER_ID]).toBeTruthy();
    expect(result.session.status).toBe("committed");

    // Verify events exist in Alice's DB
    const aliceEvents = aliceDb
      .prepare("SELECT * FROM canonical_events WHERE title = ?")
      .all("Team Sync");
    expect(aliceEvents.length).toBeGreaterThanOrEqual(1);

    // Verify events exist in Bob's DB
    const bobEvents = bobDb
      .prepare("SELECT * FROM canonical_events WHERE title = ?")
      .all("Team Sync");
    expect(bobEvents.length).toBeGreaterThanOrEqual(1);
  });

  it("prevents double commit", async () => {
    const groupDO = createGroupDO();
    const session = await groupDO.createGroupSession(makeGroupParams());
    const candidateId = session.candidates[0].candidateId;

    // First commit should succeed
    await groupDO.commitGroupSession(session.sessionId, candidateId, ALICE_USER_ID);

    // Second commit should fail
    await expect(
      groupDO.commitGroupSession(session.sessionId, candidateId, ALICE_USER_ID),
    ).rejects.toThrow(/already committed/);
  });

  // -----------------------------------------------------------------------
  // AC6: Privacy -- no cross-user event details shared
  // -----------------------------------------------------------------------

  it("does not leak event details across users", async () => {
    // Give Alice a secret meeting
    insertEvent(aliceDb, ALICE_ACCOUNT_ID, "2026-03-02T09:00:00Z", "2026-03-02T10:00:00Z", "Alice Secret Salary Review");
    // Give Bob a secret meeting
    insertEvent(bobDb, BOB_ACCOUNT_ID, "2026-03-02T14:00:00Z", "2026-03-02T15:00:00Z", "Bob Secret Medical Appointment");

    const groupDO = createGroupDO();
    const session = await groupDO.createGroupSession(makeGroupParams());

    // Session data should NOT contain any event titles from either user
    const sessionJson = JSON.stringify(session);
    expect(sessionJson).not.toContain("Alice Secret");
    expect(sessionJson).not.toContain("Salary Review");
    expect(sessionJson).not.toContain("Bob Secret");
    expect(sessionJson).not.toContain("Medical Appointment");

    // Only the meeting title should be present
    expect(sessionJson).toContain("Team Sync");
  });

  // -----------------------------------------------------------------------
  // AC7: Session registered in D1 for cross-user discovery
  // -----------------------------------------------------------------------

  it("registers session in D1 for cross-user lookup", async () => {
    const groupDO = createGroupDO();
    const session = await groupDO.createGroupSession(makeGroupParams());

    // Query D1 directly
    const row = d1Db.prepare(
      "SELECT * FROM group_scheduling_sessions WHERE session_id = ?",
    ).get(session.sessionId) as {
      session_id: string;
      creator_user_id: string;
      participant_ids_json: string;
      status: string;
    };

    expect(row).toBeTruthy();
    expect(row.creator_user_id).toBe(ALICE_USER_ID);
    expect(JSON.parse(row.participant_ids_json)).toEqual([ALICE_USER_ID, BOB_USER_ID]);
    expect(row.status).toBe("candidates_ready");
  });

  it("retrieves session by ID for a participant", async () => {
    const groupDO = createGroupDO();
    const session = await groupDO.createGroupSession(makeGroupParams());

    // Both Alice and Bob should be able to get the session
    const aliceView = await groupDO.getGroupSession(session.sessionId, ALICE_USER_ID);
    expect(aliceView.sessionId).toBe(session.sessionId);

    const bobView = await groupDO.getGroupSession(session.sessionId, BOB_USER_ID);
    expect(bobView.sessionId).toBe(session.sessionId);
  });

  it("rejects session access for non-participant", async () => {
    const groupDO = createGroupDO();
    const session = await groupDO.createGroupSession(makeGroupParams());

    await expect(
      groupDO.getGroupSession(session.sessionId, "usr_01STRANGER000000000000001"),
    ).rejects.toThrow(/not a participant/);
  });

  // -----------------------------------------------------------------------
  // Validation
  // -----------------------------------------------------------------------

  it("rejects group session with fewer than 2 participants", async () => {
    const groupDO = createGroupDO();

    await expect(
      groupDO.createGroupSession(makeGroupParams({
        participantUserIds: [ALICE_USER_ID],
      })),
    ).rejects.toThrow(/At least two/);
  });

  it("rejects group session when creator not in participant list", async () => {
    const groupDO = createGroupDO();

    await expect(
      groupDO.createGroupSession(makeGroupParams({
        creatorUserId: "usr_01STRANGER000000000000001",
        participantUserIds: [ALICE_USER_ID, BOB_USER_ID],
      })),
    ).rejects.toThrow(/Creator must be included/);
  });

  it("rejects commit for non-existent candidate", async () => {
    const groupDO = createGroupDO();
    const session = await groupDO.createGroupSession(makeGroupParams());

    await expect(
      groupDO.commitGroupSession(session.sessionId, "candidate_bogus", ALICE_USER_ID),
    ).rejects.toThrow(/not found/);
  });
});
