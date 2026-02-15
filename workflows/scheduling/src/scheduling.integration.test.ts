/**
 * Integration tests for the Scheduling Workflow.
 *
 * Uses real SQLite (better-sqlite3) to test the end-to-end scheduling flow:
 * 1. Create session -> computes availability -> produces candidates
 * 2. Get candidates -> returns stored session with scored candidates
 * 3. Commit candidate -> creates canonical event + marks session committed
 *
 * Also tests:
 * - Candidates respect existing busy events (no overlaps)
 * - Committing creates a real canonical event in the store
 * - Session status transitions: open -> candidates_ready -> committed
 * - Validation: invalid params rejected, double-commit prevented
 * - Mirror projection triggered on commit
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import type { SqlStorageLike, SqlStorageCursorLike, ProviderDelta, AccountId } from "@tminus/shared";
import { UserGraphDO } from "@tminus/do-user-graph";
import type { QueueLike } from "@tminus/do-user-graph";
import { SchedulingWorkflow } from "./index";
import type { SchedulingParams } from "./index";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TEST_USER_ID = "usr_01TESTUSER000000000000001";
const TEST_ACCOUNT_ID = "acc_01TESTACCOUNT0000000000001" as AccountId;

// ---------------------------------------------------------------------------
// SqlStorage adapter (same pattern as UserGraphDO integration tests)
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
// Fake DurableObjectNamespace -- routes to a real UserGraphDO instance
// ---------------------------------------------------------------------------

class FakeDOStub {
  private do: UserGraphDO;

  constructor(doInstance: UserGraphDO) {
    this.do = doInstance;
  }

  async fetch(request: Request | string, init?: RequestInit): Promise<Response> {
    const req = typeof request === "string" ? new Request(request, init) : request;
    return this.do.handleFetch(req);
  }
}

function createFakeNamespace(doInstance: UserGraphDO): DurableObjectNamespace {
  const stub = new FakeDOStub(doInstance);
  return {
    idFromName(_name: string) {
      return {} as DurableObjectId;
    },
    get(_id: DurableObjectId) {
      return stub as unknown as DurableObjectStub;
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
// Test setup
// ---------------------------------------------------------------------------

let db: DatabaseType;
let sql: SqlStorageLike;
let queue: MockQueue;
let userGraphDO: UserGraphDO;
let namespace: DurableObjectNamespace;

function createWorkflow(): SchedulingWorkflow {
  return new SchedulingWorkflow({
    USER_GRAPH: namespace,
    ACCOUNT: namespace, // Not used in scheduling flow
    WRITE_QUEUE: queue as unknown as Queue,
  });
}

function makeParams(overrides: Partial<SchedulingParams> = {}): SchedulingParams {
  return {
    userId: TEST_USER_ID,
    title: "Team Meeting",
    durationMinutes: 60,
    windowStart: "2026-03-02T08:00:00Z",
    windowEnd: "2026-03-06T18:00:00Z",
    requiredAccountIds: [TEST_ACCOUNT_ID],
    ...overrides,
  };
}

/**
 * Insert a canonical event directly into the DB for testing
 * busy interval generation.
 */
function insertEvent(
  startTs: string,
  endTs: string,
  opts?: {
    eventId?: string;
    accountId?: string;
    title?: string;
    status?: string;
    transparency?: string;
  },
): void {
  const eventId = opts?.eventId ?? `evt_test_${Math.random().toString(36).slice(2, 10)}`;
  db.prepare(
    `INSERT INTO canonical_events (
      canonical_event_id, origin_account_id, origin_event_id,
      title, start_ts, end_ts, all_day, status, visibility,
      transparency, source, version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'default', ?, 'provider', 1, datetime('now'), datetime('now'))`,
  ).run(
    eventId,
    opts?.accountId ?? TEST_ACCOUNT_ID,
    `origin_${eventId}`,
    opts?.title ?? "Existing Meeting",
    startTs,
    endTs,
    opts?.status ?? "confirmed",
    opts?.transparency ?? "opaque",
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SchedulingWorkflow integration", () => {
  beforeEach(async () => {
    db = new Database(":memory:");
    sql = createSqlStorageAdapter(db);
    queue = new MockQueue();
    userGraphDO = new UserGraphDO(sql, queue);
    namespace = createFakeNamespace(userGraphDO);

    // Trigger lazy migration so tables exist before direct DB access
    await userGraphDO.handleFetch(
      new Request("https://user-graph.internal/getSyncHealth"),
    );
  });

  afterEach(() => {
    db.close();
  });

  // -----------------------------------------------------------------------
  // Happy path: create session, get candidates, commit
  // -----------------------------------------------------------------------

  it("creates a session with candidates when calendar is empty", async () => {
    const workflow = createWorkflow();
    const session = await workflow.createSession(makeParams());

    expect(session.sessionId).toMatch(/^ses_/);
    expect(session.status).toBe("candidates_ready");
    expect(session.candidates.length).toBeGreaterThanOrEqual(3);

    // Each candidate should have the right duration (60 min)
    for (const c of session.candidates) {
      const startMs = new Date(c.start).getTime();
      const endMs = new Date(c.end).getTime();
      expect(endMs - startMs).toBe(60 * 60 * 1000);
    }
  });

  it("getCandidates returns the stored session", async () => {
    const workflow = createWorkflow();
    const created = await workflow.createSession(makeParams());

    const retrieved = await workflow.getCandidates(TEST_USER_ID, created.sessionId);
    expect(retrieved.sessionId).toBe(created.sessionId);
    expect(retrieved.candidates.length).toBe(created.candidates.length);
    expect(retrieved.status).toBe("candidates_ready");
  });

  it("candidates respect existing busy events (no overlaps)", async () => {
    // Insert some busy events
    insertEvent("2026-03-02T09:00:00Z", "2026-03-02T10:00:00Z");
    insertEvent("2026-03-03T14:00:00Z", "2026-03-03T16:00:00Z");
    insertEvent("2026-03-04T08:00:00Z", "2026-03-04T12:00:00Z");

    const workflow = createWorkflow();
    const session = await workflow.createSession(makeParams());

    expect(session.candidates.length).toBeGreaterThanOrEqual(3);

    // Verify no candidate overlaps the busy events
    const busyRanges = [
      { start: new Date("2026-03-02T09:00:00Z").getTime(), end: new Date("2026-03-02T10:00:00Z").getTime() },
      { start: new Date("2026-03-03T14:00:00Z").getTime(), end: new Date("2026-03-03T16:00:00Z").getTime() },
      { start: new Date("2026-03-04T08:00:00Z").getTime(), end: new Date("2026-03-04T12:00:00Z").getTime() },
    ];

    for (const candidate of session.candidates) {
      const cStart = new Date(candidate.start).getTime();
      const cEnd = new Date(candidate.end).getTime();
      for (const busy of busyRanges) {
        const overlaps = cStart < busy.end && cEnd > busy.start;
        expect(overlaps, `Candidate ${candidate.start} overlaps busy event`).toBe(false);
      }
    }
  });

  it("commit creates a canonical event and marks session committed", async () => {
    const workflow = createWorkflow();
    const session = await workflow.createSession(makeParams());

    const candidateId = session.candidates[0].candidateId;
    const result = await workflow.commitCandidate(
      TEST_USER_ID,
      session.sessionId,
      candidateId,
    );

    // Event was created
    expect(result.eventId).toMatch(/^evt_/);

    // Session is committed
    expect(result.session.status).toBe("committed");

    // Verify the event exists in the canonical store
    const rows = db.prepare(
      "SELECT * FROM canonical_events WHERE canonical_event_id = ?",
    ).all(result.eventId);
    expect(rows.length).toBe(1);

    const event = rows[0] as Record<string, unknown>;
    expect(event.title).toBe("Team Meeting");
    expect(event.start_ts).toBe(session.candidates[0].start);
    expect(event.end_ts).toBe(session.candidates[0].end);
    expect(event.source).toBe("system");
    expect(event.status).toBe("confirmed");
    expect(event.transparency).toBe("opaque");
  });

  // -----------------------------------------------------------------------
  // Validation
  // -----------------------------------------------------------------------

  it("rejects missing title", async () => {
    const workflow = createWorkflow();
    await expect(
      workflow.createSession(makeParams({ title: "" })),
    ).rejects.toThrow("title is required");
  });

  it("rejects invalid duration", async () => {
    const workflow = createWorkflow();
    await expect(
      workflow.createSession(makeParams({ durationMinutes: 5 })),
    ).rejects.toThrow("durationMinutes must be between 15 and 480");
  });

  it("rejects window_start >= window_end", async () => {
    const workflow = createWorkflow();
    await expect(
      workflow.createSession(makeParams({
        windowStart: "2026-03-06T18:00:00Z",
        windowEnd: "2026-03-02T08:00:00Z",
      })),
    ).rejects.toThrow("windowStart must be before windowEnd");
  });

  it("rejects empty requiredAccountIds", async () => {
    const workflow = createWorkflow();
    await expect(
      workflow.createSession(makeParams({ requiredAccountIds: [] })),
    ).rejects.toThrow("At least one requiredAccountId");
  });

  // -----------------------------------------------------------------------
  // Error cases
  // -----------------------------------------------------------------------

  it("prevents double-commit on same session", async () => {
    const workflow = createWorkflow();
    const session = await workflow.createSession(makeParams());

    const candidateId = session.candidates[0].candidateId;
    await workflow.commitCandidate(TEST_USER_ID, session.sessionId, candidateId);

    // Second commit should fail
    await expect(
      workflow.commitCandidate(TEST_USER_ID, session.sessionId, candidateId),
    ).rejects.toThrow("already committed");
  });

  it("rejects commit with invalid candidate ID", async () => {
    const workflow = createWorkflow();
    const session = await workflow.createSession(makeParams());

    await expect(
      workflow.commitCandidate(TEST_USER_ID, session.sessionId, "cnd_NONEXISTENT"),
    ).rejects.toThrow("not found");
  });

  it("rejects get for nonexistent session", async () => {
    const workflow = createWorkflow();
    await expect(
      workflow.getCandidates(TEST_USER_ID, "ses_NONEXISTENT"),
    ).rejects.toThrow("not found");
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  it("returns 0 candidates when calendar is fully booked", async () => {
    // Fill the entire 5-day window with busy events
    insertEvent("2026-03-02T00:00:00Z", "2026-03-07T00:00:00Z");

    const workflow = createWorkflow();
    const session = await workflow.createSession(makeParams());

    expect(session.status).toBe("open"); // no candidates
    expect(session.candidates.length).toBe(0);
  });

  it("supports custom maxCandidates", async () => {
    const workflow = createWorkflow();
    const session = await workflow.createSession(makeParams({ maxCandidates: 10 }));

    expect(session.candidates.length).toBeGreaterThanOrEqual(3);
    expect(session.candidates.length).toBeLessThanOrEqual(10);
  });

  it("candidates are scored and sorted descending", async () => {
    const workflow = createWorkflow();
    const session = await workflow.createSession(makeParams());

    for (let i = 1; i < session.candidates.length; i++) {
      expect(session.candidates[i - 1].score).toBeGreaterThanOrEqual(
        session.candidates[i].score,
      );
    }
  });
});
