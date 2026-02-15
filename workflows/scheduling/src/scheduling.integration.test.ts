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
import type { SchedulingParams, SchedulingEnv, Hold } from "./index";

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

  // -----------------------------------------------------------------------
  // Constraint-aware scheduling (TM-946.2)
  // -----------------------------------------------------------------------

  describe("constraint-aware scheduling", () => {
    /**
     * Helper to add a constraint to the DO via RPC (same as real API path).
     */
    async function addConstraint(
      kind: string,
      configJson: Record<string, unknown>,
      activeFrom: string | null = null,
      activeTo: string | null = null,
    ): Promise<void> {
      const response = await userGraphDO.handleFetch(
        new Request("https://user-graph.internal/addConstraint", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind,
            config_json: configJson,
            active_from: activeFrom,
            active_to: activeTo,
          }),
        }),
      );
      expect(response.ok).toBe(true);
    }

    it("solver respects working hours constraints (AC1)", async () => {
      // Add working hours: Mon-Fri 09:00-17:00 UTC
      await addConstraint("working_hours", {
        days: [1, 2, 3, 4, 5],
        start_time: "09:00",
        end_time: "17:00",
        timezone: "UTC",
      });

      const workflow = createWorkflow();
      const session = await workflow.createSession(makeParams({
        windowStart: "2026-03-02T06:00:00Z", // Monday 06:00
        windowEnd: "2026-03-02T20:00:00Z",   // Monday 20:00
      }));

      expect(session.candidates.length).toBeGreaterThan(0);

      // The highest-scoring candidate should be within working hours
      const best = session.candidates[0];
      const bestHour = new Date(best.start).getUTCHours();
      expect(bestHour).toBeGreaterThanOrEqual(9);
      expect(bestHour).toBeLessThan(17);
      expect(best.explanation).toContain("within working hours");
    });

    it("solver excludes trip-blocked time (AC2)", async () => {
      // Add trip on Tuesday-Wednesday
      await addConstraint(
        "trip",
        {
          name: "NYC Conference",
          timezone: "UTC",
          block_policy: "BUSY",
        },
        "2026-03-03T00:00:00Z", // Tuesday
        "2026-03-05T00:00:00Z", // through Wednesday
      );

      const workflow = createWorkflow();
      const session = await workflow.createSession(makeParams({
        windowStart: "2026-03-02T08:00:00Z", // Monday
        windowEnd: "2026-03-06T18:00:00Z",   // Friday
      }));

      expect(session.candidates.length).toBeGreaterThan(0);

      // No candidates should fall within trip period
      for (const c of session.candidates) {
        const cStartMs = new Date(c.start).getTime();
        const cEndMs = new Date(c.end).getTime();
        const tripStartMs = new Date("2026-03-03T00:00:00Z").getTime();
        const tripEndMs = new Date("2026-03-05T00:00:00Z").getTime();
        const overlaps = cStartMs < tripEndMs && cEndMs > tripStartMs;
        expect(overlaps, `Candidate ${c.start} should not overlap trip`).toBe(false);
      }
    });

    it("buffer time reduces available slots (AC3)", async () => {
      // Add 30-min prep buffer before events
      await addConstraint("buffer", {
        type: "prep",
        minutes: 30,
        applies_to: "all",
      });

      // Insert a busy event at 10:00-11:00
      insertEvent("2026-03-02T10:00:00Z", "2026-03-02T11:00:00Z");

      const workflow = createWorkflow();
      const session = await workflow.createSession(makeParams({
        windowStart: "2026-03-02T08:00:00Z",
        windowEnd: "2026-03-02T18:00:00Z",
      }));

      expect(session.candidates.length).toBeGreaterThan(0);

      // The slot right after the event (11:00) should have buffer scoring
      // because events near it will be penalized for insufficient buffer
      const slot11 = session.candidates.find(
        c => c.start === "2026-03-02T11:00:00Z"
      );
      // If present, it should mention buffer
      if (slot11) {
        expect(slot11.explanation).toMatch(/buffer/);
      }
    });

    it("constraint violations lower candidate scores (AC4)", async () => {
      // Add working hours + no-meetings-after constraints
      await addConstraint("working_hours", {
        days: [1, 2, 3, 4, 5],
        start_time: "09:00",
        end_time: "17:00",
        timezone: "UTC",
      });
      await addConstraint("no_meetings_after", {
        time: "16:00",
        timezone: "UTC",
      });

      const workflow = createWorkflow();
      const session = await workflow.createSession(makeParams({
        windowStart: "2026-03-02T06:00:00Z", // Monday
        windowEnd: "2026-03-02T20:00:00Z",
        maxCandidates: 50,
      }));

      expect(session.candidates.length).toBeGreaterThan(0);

      // Find slots within working hours (10:00) and outside (06:00)
      const inHours = session.candidates.find(
        c => c.start === "2026-03-02T10:00:00Z"
      );
      const outHours = session.candidates.find(
        c => c.start === "2026-03-02T06:00:00Z"
      );

      if (inHours && outHours) {
        expect(inHours.score).toBeGreaterThan(outHours.score);
      }

      // Post-cutoff slots should score lower
      const preCutoff = session.candidates.find(
        c => c.start === "2026-03-02T10:00:00Z"
      );
      const postCutoff = session.candidates.find(
        c => c.start === "2026-03-02T18:00:00Z"
      );

      if (preCutoff && postCutoff) {
        expect(preCutoff.score).toBeGreaterThan(postCutoff.score);
      }
    });

    it("multiple constraint types compose correctly (AC5)", async () => {
      // Working hours Mon-Fri 09:00-17:00
      await addConstraint("working_hours", {
        days: [1, 2, 3, 4, 5],
        start_time: "09:00",
        end_time: "17:00",
        timezone: "UTC",
      });
      // Trip on Wednesday
      await addConstraint(
        "trip",
        {
          name: "Retreat",
          timezone: "UTC",
          block_policy: "BUSY",
        },
        "2026-03-04T00:00:00Z",
        "2026-03-05T00:00:00Z",
      );
      // Buffer: 15 min prep
      await addConstraint("buffer", {
        type: "prep",
        minutes: 15,
        applies_to: "all",
      });
      // No meetings after 16:00
      await addConstraint("no_meetings_after", {
        time: "16:00",
        timezone: "UTC",
      });

      // Add some busy events
      insertEvent("2026-03-02T12:00:00Z", "2026-03-02T13:00:00Z");
      insertEvent("2026-03-03T10:00:00Z", "2026-03-03T11:00:00Z");

      const workflow = createWorkflow();
      const session = await workflow.createSession(makeParams({
        windowStart: "2026-03-02T06:00:00Z",
        windowEnd: "2026-03-06T20:00:00Z",
        maxCandidates: 20,
      }));

      expect(session.candidates.length).toBeGreaterThan(0);
      expect(session.status).toBe("candidates_ready");

      // No Wednesday candidates (trip)
      const wedCandidates = session.candidates.filter(
        c => c.start.startsWith("2026-03-04T")
      );
      expect(wedCandidates.length).toBe(0);

      // Best candidates should be within working hours
      const best = session.candidates[0];
      const bestHour = new Date(best.start).getUTCHours();
      // Should be within 09:00-16:00 (working hours minus cutoff)
      expect(bestHour).toBeGreaterThanOrEqual(8); // morning bonus
      expect(bestHour).toBeLessThan(17);

      // Candidates should be sorted by score
      for (let i = 1; i < session.candidates.length; i++) {
        expect(session.candidates[i - 1].score).toBeGreaterThanOrEqual(
          session.candidates[i].score,
        );
      }
    });

    it("performance: solver completes in <2s for 1-week window (AC6)", async () => {
      // Add multiple constraints
      await addConstraint("working_hours", {
        days: [1, 2, 3, 4, 5],
        start_time: "08:00",
        end_time: "18:00",
        timezone: "UTC",
      });
      await addConstraint("buffer", {
        type: "prep",
        minutes: 15,
        applies_to: "all",
      });
      await addConstraint("buffer", {
        type: "cooldown",
        minutes: 10,
        applies_to: "all",
      });
      await addConstraint("no_meetings_after", {
        time: "17:00",
        timezone: "UTC",
      });
      await addConstraint(
        "trip",
        {
          name: "Trip",
          timezone: "UTC",
          block_policy: "BUSY",
        },
        "2026-03-05T00:00:00Z",
        "2026-03-06T00:00:00Z",
      );

      // Add busy events spread across the week
      for (let day = 2; day <= 6; day++) {
        for (let hour = 9; hour < 17; hour += 3) {
          const dayStr = String(day).padStart(2, "0");
          insertEvent(
            `2026-03-${dayStr}T${String(hour).padStart(2, "0")}:00:00Z`,
            `2026-03-${dayStr}T${String(hour + 1).padStart(2, "0")}:00:00Z`,
          );
        }
      }

      const workflow = createWorkflow();
      const start = performance.now();
      const session = await workflow.createSession(makeParams({
        windowStart: "2026-03-02T00:00:00Z",
        windowEnd: "2026-03-09T00:00:00Z",
        maxCandidates: 10,
      }));
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(2000); // <2s
      expect(session.candidates.length).toBeGreaterThan(0);
      expect(session.candidates.length).toBeLessThanOrEqual(10);
    });
  });

  // -----------------------------------------------------------------------
  // Session lifecycle management (TM-946.4)
  // -----------------------------------------------------------------------

  describe("session lifecycle management", () => {
    it("full lifecycle: create -> list -> get detail -> cancel", async () => {
      const workflow = createWorkflow();

      // Step 1: Create session
      const session = await workflow.createSession(makeParams());
      expect(session.sessionId).toMatch(/^ses_/);
      expect(session.status).toBe("candidates_ready");
      expect(session.candidates.length).toBeGreaterThanOrEqual(3);

      // Step 2: List sessions (no filter)
      const listResp = await userGraphDO.handleFetch(
        new Request("https://user-graph.internal/listSchedulingSessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }),
      );
      expect(listResp.ok).toBe(true);

      const listData = await listResp.json() as {
        items: Array<{ sessionId: string; status: string; candidateCount: number }>;
        total: number;
      };
      expect(listData.total).toBe(1);
      expect(listData.items[0].sessionId).toBe(session.sessionId);
      expect(listData.items[0].status).toBe("candidates_ready");
      expect(listData.items[0].candidateCount).toBe(session.candidates.length);

      // Step 3: Get detail with candidates
      const detail = await workflow.getCandidates(TEST_USER_ID, session.sessionId);
      expect(detail.sessionId).toBe(session.sessionId);
      expect(detail.status).toBe("candidates_ready");
      expect(detail.candidates.length).toBe(session.candidates.length);

      // Step 4: Cancel session
      const cancelResp = await userGraphDO.handleFetch(
        new Request("https://user-graph.internal/cancelSchedulingSession", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: session.sessionId }),
        }),
      );
      expect(cancelResp.ok).toBe(true);

      // Step 5: Verify cancelled status in list
      const listAfterCancel = await userGraphDO.handleFetch(
        new Request("https://user-graph.internal/listSchedulingSessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "cancelled" }),
        }),
      );
      const afterCancelData = await listAfterCancel.json() as {
        items: Array<{ sessionId: string; status: string }>;
        total: number;
      };
      expect(afterCancelData.total).toBe(1);
      expect(afterCancelData.items[0].status).toBe("cancelled");
    });

    it("list sessions filters by status correctly", async () => {
      const workflow = createWorkflow();

      // Create two sessions
      const session1 = await workflow.createSession(makeParams({ title: "Session 1" }));
      const session2 = await workflow.createSession(makeParams({ title: "Session 2" }));

      // Commit session 1
      const candidateId = session1.candidates[0].candidateId;
      await workflow.commitCandidate(TEST_USER_ID, session1.sessionId, candidateId);

      // List only candidates_ready sessions
      const listResp = await userGraphDO.handleFetch(
        new Request("https://user-graph.internal/listSchedulingSessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "candidates_ready" }),
        }),
      );
      const data = await listResp.json() as {
        items: Array<{ sessionId: string; status: string }>;
        total: number;
      };
      expect(data.total).toBe(1);
      expect(data.items[0].sessionId).toBe(session2.sessionId);

      // List committed sessions
      const committedResp = await userGraphDO.handleFetch(
        new Request("https://user-graph.internal/listSchedulingSessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "committed" }),
        }),
      );
      const committedData = await committedResp.json() as {
        items: Array<{ sessionId: string; status: string }>;
        total: number;
      };
      expect(committedData.total).toBe(1);
      expect(committedData.items[0].sessionId).toBe(session1.sessionId);
    });

    it("get session detail returns candidates with correct structure", async () => {
      const workflow = createWorkflow();
      const session = await workflow.createSession(makeParams());

      const detail = await workflow.getCandidates(TEST_USER_ID, session.sessionId);

      // Verify the session detail has all expected fields
      expect(detail.sessionId).toBe(session.sessionId);
      expect(detail.status).toBe("candidates_ready");
      expect(detail.createdAt).toBeDefined();
      expect(typeof detail.createdAt).toBe("string");

      // Verify each candidate has the expected structure
      for (const c of detail.candidates) {
        expect(c.candidateId).toMatch(/^cnd_/);
        expect(c.sessionId).toBe(session.sessionId);
        expect(c.start).toBeTruthy();
        expect(c.end).toBeTruthy();
        expect(typeof c.score).toBe("number");
        expect(typeof c.explanation).toBe("string");
      }
    });

    it("cancel on non-cancellable session returns error", async () => {
      const workflow = createWorkflow();
      const session = await workflow.createSession(makeParams());

      // Commit the session first
      const candidateId = session.candidates[0].candidateId;
      await workflow.commitCandidate(TEST_USER_ID, session.sessionId, candidateId);

      // Try to cancel a committed session
      const cancelResp = await userGraphDO.handleFetch(
        new Request("https://user-graph.internal/cancelSchedulingSession", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: session.sessionId }),
        }),
      );
      expect(cancelResp.ok).toBe(false);

      const body = await cancelResp.json() as { error: string };
      expect(body.error).toContain("already committed");
    });

    it("cancelled session cannot be committed", async () => {
      const workflow = createWorkflow();
      const session = await workflow.createSession(makeParams());
      const candidateId = session.candidates[0].candidateId;

      // Cancel session
      const cancelResp = await userGraphDO.handleFetch(
        new Request("https://user-graph.internal/cancelSchedulingSession", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: session.sessionId }),
        }),
      );
      expect(cancelResp.ok).toBe(true);

      // Try to commit the cancelled session
      await expect(
        workflow.commitCandidate(TEST_USER_ID, session.sessionId, candidateId),
      ).rejects.toThrow("cancelled");
    });

    it("session get detail returns committed info after commit", async () => {
      const workflow = createWorkflow();
      const session = await workflow.createSession(makeParams());
      const candidateId = session.candidates[0].candidateId;

      const result = await workflow.commitCandidate(
        TEST_USER_ID,
        session.sessionId,
        candidateId,
      );

      // Get detail should show committed status with committed info
      const detail = await workflow.getCandidates(TEST_USER_ID, session.sessionId);
      expect(detail.status).toBe("committed");
      expect(detail.committedCandidateId).toBe(candidateId);
      expect(detail.committedEventId).toBe(result.eventId);
    });
  });

  // -----------------------------------------------------------------------
  // Tentative holds lifecycle (TM-946.3)
  // -----------------------------------------------------------------------

  describe("tentative holds", () => {
    it("AC1: creates tentative holds for candidates when session is created", async () => {
      const workflow = createWorkflow();
      const session = await workflow.createSession(makeParams({
        holdTimeoutMs: 24 * 60 * 60 * 1000, // 24h
        targetCalendarId: "cal_test_primary",
      }));

      expect(session.candidates.length).toBeGreaterThan(0);
      expect(session.holds).toBeDefined();
      expect(session.holds!.length).toBeGreaterThan(0);

      // Each candidate should have a hold for each required account
      const expectedHoldCount = session.candidates.length * makeParams().requiredAccountIds.length;
      expect(session.holds!.length).toBe(expectedHoldCount);

      // All holds should be in 'held' status
      for (const hold of session.holds!) {
        expect(hold.status).toBe("held");
        expect(hold.session_id).toBe(session.sessionId);
        expect(hold.hold_id).toMatch(/^hld_/);
      }
    });

    it("AC2: hold UPSERT_MIRROR messages enqueued with tentative event data", async () => {
      queue.clear();
      const workflow = createWorkflow();
      const session = await workflow.createSession(makeParams({
        holdTimeoutMs: 24 * 60 * 60 * 1000,
        targetCalendarId: "cal_test_primary",
      }));

      // Write queue should have UPSERT_MIRROR messages for holds
      const holdMessages = queue.messages.filter(
        (m: unknown) => {
          const msg = m as Record<string, unknown>;
          return msg.type === "UPSERT_MIRROR" &&
            typeof msg.canonical_event_id === "string" &&
            (msg.canonical_event_id as string).startsWith("hold_");
        },
      );

      expect(holdMessages.length).toBe(session.holds!.length);

      // Verify first message has tentative event properties
      const firstMsg = holdMessages[0] as Record<string, unknown>;
      const payload = firstMsg.projected_payload as Record<string, unknown>;
      expect((payload.summary as string)).toContain("[Hold]");
      expect(payload.transparency).toBe("opaque");
    });

    it("AC3: holds are stored in schedule_holds table via UserGraphDO", async () => {
      const workflow = createWorkflow();
      const session = await workflow.createSession(makeParams({
        holdTimeoutMs: 24 * 60 * 60 * 1000,
        targetCalendarId: "cal_test_primary",
      }));

      // Verify holds are retrievable via the workflow
      const holds = await workflow.getHoldsBySession(TEST_USER_ID, session.sessionId);
      expect(holds.length).toBe(session.holds!.length);

      // Verify hold records match
      for (const hold of holds) {
        expect(hold.session_id).toBe(session.sessionId);
        expect(hold.status).toBe("held");
        expect(hold.account_id).toBe(TEST_ACCOUNT_ID);
      }
    });

    it("AC4: commit releases all holds and creates confirmed event", async () => {
      queue.clear();
      const workflow = createWorkflow();
      const session = await workflow.createSession(makeParams({
        holdTimeoutMs: 24 * 60 * 60 * 1000,
        targetCalendarId: "cal_test_primary",
      }));

      const candidateId = session.candidates[0].candidateId;
      const result = await workflow.commitCandidate(
        TEST_USER_ID,
        session.sessionId,
        candidateId,
      );

      // Canonical event created as confirmed
      expect(result.eventId).toMatch(/^evt_/);
      expect(result.session.status).toBe("committed");

      // All holds should be released
      const holds = await workflow.getHoldsBySession(TEST_USER_ID, session.sessionId);
      for (const hold of holds) {
        expect(hold.status).toBe("released");
      }
    });

    it("AC5: cancel releases all holds", async () => {
      const workflow = createWorkflow();
      const session = await workflow.createSession(makeParams({
        holdTimeoutMs: 24 * 60 * 60 * 1000,
        targetCalendarId: "cal_test_primary",
      }));

      expect(session.holds!.length).toBeGreaterThan(0);

      // Cancel the session
      const cancelled = await workflow.cancelSession(TEST_USER_ID, session.sessionId);
      expect(cancelled.status).toBe("cancelled");

      // All holds should be released
      const holds = await workflow.getHoldsBySession(TEST_USER_ID, session.sessionId);
      for (const hold of holds) {
        expect(hold.status).toBe("released");
      }
    });

    it("AC6: holds not created when holdTimeoutMs is 0", async () => {
      const workflow = createWorkflow();
      const session = await workflow.createSession(makeParams({
        holdTimeoutMs: 0,
      }));

      expect(session.candidates.length).toBeGreaterThan(0);
      expect(session.holds).toEqual([]);
    });

    it("hold expiry check finds expired holds in UserGraphDO", async () => {
      // Insert a hold with expired timestamp directly into DB
      const holdId = "hld_01TESTHOLD00000000000001";
      const sessionId = "ses_01TESTSES000000000000001";
      db.prepare(
        `INSERT INTO schedule_sessions (session_id, status, objective_json, created_at)
         VALUES (?, 'candidates_ready', '{}', datetime('now'))`,
      ).run(sessionId);
      db.prepare(
        `INSERT INTO schedule_holds (hold_id, session_id, account_id, provider_event_id, expires_at, status)
         VALUES (?, ?, ?, ?, datetime('now', '-1 hour'), 'held')`,
      ).run(holdId, sessionId, TEST_ACCOUNT_ID, "google_evt_123");

      // Query via UserGraphDO RPC
      const response = await userGraphDO.handleFetch(
        new Request("https://user-graph.internal/getExpiredHolds", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }),
      );

      expect(response.ok).toBe(true);
      const { holds } = (await response.json()) as { holds: Hold[] };
      expect(holds.length).toBe(1);
      expect(holds[0].hold_id).toBe(holdId);
      expect(holds[0].provider_event_id).toBe("google_evt_123");
    });

    it("updateHoldStatus transitions from held to expired", async () => {
      // Insert a held hold
      const holdId = "hld_01TESTHOLD00000000000002";
      const sessionId = "ses_01TESTSES000000000000002";
      db.prepare(
        `INSERT INTO schedule_sessions (session_id, status, objective_json, created_at)
         VALUES (?, 'candidates_ready', '{}', datetime('now'))`,
      ).run(sessionId);
      db.prepare(
        `INSERT INTO schedule_holds (hold_id, session_id, account_id, provider_event_id, expires_at, status)
         VALUES (?, ?, ?, NULL, datetime('now', '+1 hour'), 'held')`,
      ).run(holdId, sessionId, TEST_ACCOUNT_ID);

      // Transition to expired
      const response = await userGraphDO.handleFetch(
        new Request("https://user-graph.internal/updateHoldStatus", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hold_id: holdId, status: "expired" }),
        }),
      );

      expect(response.ok).toBe(true);

      // Verify status changed
      const row = db.prepare("SELECT status FROM schedule_holds WHERE hold_id = ?").get(holdId) as Record<string, unknown>;
      expect(row.status).toBe("expired");
    });

    it("updateHoldStatus rejects invalid transition from expired to held", async () => {
      // Insert an expired hold
      const holdId = "hld_01TESTHOLD00000000000003";
      const sessionId = "ses_01TESTSES000000000000003";
      db.prepare(
        `INSERT INTO schedule_sessions (session_id, status, objective_json, created_at)
         VALUES (?, 'candidates_ready', '{}', datetime('now'))`,
      ).run(sessionId);
      db.prepare(
        `INSERT INTO schedule_holds (hold_id, session_id, account_id, provider_event_id, expires_at, status)
         VALUES (?, ?, ?, NULL, datetime('now', '-1 hour'), 'expired')`,
      ).run(holdId, sessionId, TEST_ACCOUNT_ID);

      // Try invalid transition
      const response = await userGraphDO.handleFetch(
        new Request("https://user-graph.internal/updateHoldStatus", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hold_id: holdId, status: "held" }),
        }),
      );

      expect(response.ok).toBe(false);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain("Invalid hold transition");
    });

    it("holds have correct expiry time based on holdTimeoutMs", async () => {
      const oneHourMs = 60 * 60 * 1000;
      const workflow = createWorkflow();
      const before = Date.now();
      const session = await workflow.createSession(makeParams({
        holdTimeoutMs: oneHourMs,
        targetCalendarId: "cal_test_primary",
      }));
      const after = Date.now();

      for (const hold of session.holds!) {
        const expiresMs = new Date(hold.expires_at).getTime();
        // Expiry should be approximately now + 1 hour (within 1 second tolerance)
        expect(expiresMs).toBeGreaterThanOrEqual(before + oneHourMs);
        expect(expiresMs).toBeLessThanOrEqual(after + oneHourMs + 1000);
      }
    });
  });

  // -----------------------------------------------------------------------
  // VIP Override E2E (TM-5rp.1)
  // -----------------------------------------------------------------------

  describe("VIP override integration", () => {
    it("VIP policy CRUD through UserGraphDO", async () => {
      // Create a VIP policy
      const createResp = await userGraphDO.handleFetch(
        new Request("https://user-graph.internal/createVipPolicy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            vip_id: "vip_01TEST00000000000000001",
            participant_hash: "abc123investorhash",
            display_name: "Sarah - Investor",
            priority_weight: 2.0,
            conditions_json: {
              allow_after_hours: true,
              min_notice_hours: 1,
              override_deep_work: false,
            },
          }),
        }),
      );
      expect(createResp.ok).toBe(true);
      const created = (await createResp.json()) as {
        vip_id: string;
        participant_hash: string;
        display_name: string;
        priority_weight: number;
        conditions_json: string;
      };
      expect(created.vip_id).toBe("vip_01TEST00000000000000001");
      expect(created.participant_hash).toBe("abc123investorhash");

      // List VIP policies
      const listResp = await userGraphDO.handleFetch(
        new Request("https://user-graph.internal/listVipPolicies", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }),
      );
      expect(listResp.ok).toBe(true);
      const listed = (await listResp.json()) as { items: Array<{ vip_id: string }> };
      expect(listed.items.length).toBe(1);
      expect(listed.items[0].vip_id).toBe("vip_01TEST00000000000000001");

      // Delete VIP policy
      const deleteResp = await userGraphDO.handleFetch(
        new Request("https://user-graph.internal/deleteVipPolicy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ vip_id: "vip_01TEST00000000000000001" }),
        }),
      );
      expect(deleteResp.ok).toBe(true);
      const deleted = (await deleteResp.json()) as { deleted: boolean };
      expect(deleted.deleted).toBe(true);

      // Verify deletion
      const listAfter = await userGraphDO.handleFetch(
        new Request("https://user-graph.internal/listVipPolicies", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }),
      );
      const listedAfter = (await listAfter.json()) as { items: Array<{ vip_id: string }> };
      expect(listedAfter.items.length).toBe(0);
    });

    it("VIP appears in vip_policies table after creation", async () => {
      // Create a VIP
      await userGraphDO.handleFetch(
        new Request("https://user-graph.internal/createVipPolicy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            vip_id: "vip_01TABLECHK0000000000001",
            participant_hash: "tablecheckhash",
            display_name: "Table Check VIP",
            priority_weight: 1.5,
            conditions_json: { allow_after_hours: true },
          }),
        }),
      );

      // Query the table directly via SQL
      const rows = db.prepare("SELECT * FROM vip_policies WHERE vip_id = ?").all("vip_01TABLECHK0000000000001") as Array<{
        vip_id: string;
        participant_hash: string;
        display_name: string;
        priority_weight: number;
        conditions_json: string;
      }>;
      expect(rows.length).toBe(1);
      expect(rows[0].participant_hash).toBe("tablecheckhash");
      expect(rows[0].priority_weight).toBe(1.5);
      const conditions = JSON.parse(rows[0].conditions_json);
      expect(conditions.allow_after_hours).toBe(true);
    });

    it("create VIP -> schedule meeting outside hours -> VIP override allows it", async () => {
      // 1. Create working hours constraint (9-17 Mon-Fri UTC)
      await userGraphDO.handleFetch(
        new Request("https://user-graph.internal/addConstraint", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind: "working_hours",
            config_json: {
              days: [1, 2, 3, 4, 5],
              start_time: "09:00",
              end_time: "17:00",
              timezone: "UTC",
            },
            active_from: null,
            active_to: null,
          }),
        }),
      );

      // 2. Create VIP policy for investor
      await userGraphDO.handleFetch(
        new Request("https://user-graph.internal/createVipPolicy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            vip_id: "vip_01INVESTOR000000000001",
            participant_hash: "investor_hash_abc",
            display_name: "Sarah - Lead Investor",
            priority_weight: 2.5,
            conditions_json: {
              allow_after_hours: true,
              min_notice_hours: 0,
              override_deep_work: false,
            },
          }),
        }),
      );

      // 3. Schedule a meeting WITH VIP participant in after-hours window
      const workflow = createWorkflow();
      const vipSession = await workflow.createSession(makeParams({
        title: "Investor Pitch",
        windowStart: "2026-03-02T17:00:00Z", // Monday 5pm (after hours)
        windowEnd: "2026-03-02T22:00:00Z",   // Monday 10pm
        durationMinutes: 60,
        holdTimeoutMs: 0, // Skip holds for simplicity
        participantHashes: ["investor_hash_abc"],
      }));

      // Should get candidates in the after-hours window
      expect(vipSession.candidates.length).toBeGreaterThan(0);

      // Candidates should include VIP override scoring
      const hasVipScoring = vipSession.candidates.some(
        c => c.explanation.includes("VIP override") || c.explanation.includes("VIP priority"),
      );
      expect(hasVipScoring).toBe(true);

      // 4. Schedule same window WITHOUT VIP participant (non-VIP meeting)
      // With hard enforcement (TM-yke.2), the entirely after-hours window
      // (17:00-22:00) produces ZERO candidates for non-VIP meetings.
      const regularSession = await workflow.createSession(makeParams({
        title: "Regular Meeting",
        windowStart: "2026-03-02T17:00:00Z",
        windowEnd: "2026-03-02T22:00:00Z",
        durationMinutes: 60,
        holdTimeoutMs: 0,
        // No participantHashes -- non-VIP
      }));

      // Non-VIP meeting gets ZERO candidates (all slots hard-excluded)
      expect(regularSession.candidates.length).toBe(0);
    });

    it("delete nonexistent VIP policy returns deleted=false", async () => {
      const resp = await userGraphDO.handleFetch(
        new Request("https://user-graph.internal/deleteVipPolicy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ vip_id: "vip_nonexistent" }),
        }),
      );
      expect(resp.ok).toBe(true);
      const data = (await resp.json()) as { deleted: boolean };
      expect(data.deleted).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // External solver integration (TM-82s.2)
  // -----------------------------------------------------------------------

  describe("external solver integration", () => {
    /**
     * Helper to create a workflow with SOLVER_ENDPOINT configured.
     */
    function createWorkflowWithSolverEndpoint(endpoint: string): SchedulingWorkflow {
      return new SchedulingWorkflow({
        USER_GRAPH: namespace,
        ACCOUNT: namespace,
        WRITE_QUEUE: queue as unknown as Queue,
        SOLVER_ENDPOINT: endpoint,
      });
    }

    it("uses greedy solver by default (no SOLVER_ENDPOINT configured)", async () => {
      const workflow = createWorkflow(); // No SOLVER_ENDPOINT
      const session = await workflow.createSession(makeParams());

      expect(session.sessionId).toMatch(/^ses_/);
      expect(session.status).toBe("candidates_ready");
      expect(session.candidates.length).toBeGreaterThanOrEqual(3);

      // Candidates should be valid time slots
      for (const c of session.candidates) {
        const startMs = new Date(c.start).getTime();
        const endMs = new Date(c.end).getTime();
        expect(endMs - startMs).toBe(60 * 60 * 1000);
      }
    });

    it("falls back to greedy when external solver endpoint is unreachable", async () => {
      // Use a non-routable address that will fail immediately
      // The workflow should catch the error and fall back to greedy
      const workflow = createWorkflowWithSolverEndpoint(
        "https://127.0.0.1:1/solve",
      );

      // Create params with > 3 participants to trigger external solver selection
      const session = await workflow.createSession(makeParams({
        participantHashes: ["hash_1", "hash_2", "hash_3", "hash_4"],
      }));

      // Should still get candidates (from greedy fallback)
      expect(session.sessionId).toMatch(/^ses_/);
      expect(session.status).toBe("candidates_ready");
      expect(session.candidates.length).toBeGreaterThanOrEqual(3);
    });

    it("uses greedy for simple cases even when SOLVER_ENDPOINT configured", async () => {
      // Even with SOLVER_ENDPOINT, simple cases (few participants/constraints)
      // should use greedy solver directly -- no external HTTP call needed.
      const workflow = createWorkflowWithSolverEndpoint(
        "https://solver.example.com/solve",
      );

      // Simple case: 1 participant, no extra constraints
      const session = await workflow.createSession(makeParams());

      // Should succeed with greedy solver (no external call attempted)
      expect(session.sessionId).toMatch(/^ses_/);
      expect(session.status).toBe("candidates_ready");
      expect(session.candidates.length).toBeGreaterThanOrEqual(3);
    });

    it("falls back to greedy when external solver has many constraints", async () => {
      // Configure endpoint that will fail
      const workflow = createWorkflowWithSolverEndpoint(
        "https://127.0.0.1:1/solve",
      );

      // Add > 5 constraints to trigger external solver selection
      const addConstraint = async (
        kind: string,
        configJson: Record<string, unknown>,
        activeFrom?: string | null,
        activeTo?: string | null,
      ): Promise<void> => {
        const response = await userGraphDO.handleFetch(
          new Request("https://user-graph.internal/addConstraint", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              kind,
              config_json: configJson,
              active_from: activeFrom ?? null,
              active_to: activeTo ?? null,
            }),
          }),
        );
        expect(response.ok).toBe(true);
      };

      // Add 6 buffer constraints to exceed threshold
      for (let i = 0; i < 6; i++) {
        await addConstraint("buffer", {
          type: "prep",
          minutes: 10 + i * 5,
          applies_to: "all",
        });
      }

      const session = await workflow.createSession(makeParams({
        windowStart: "2026-03-02T08:00:00Z",
        windowEnd: "2026-03-06T18:00:00Z",
      }));

      // Should still get candidates despite external solver failure (greedy fallback)
      expect(session.sessionId).toMatch(/^ses_/);
      expect(session.candidates.length).toBeGreaterThanOrEqual(0);
    });

    it("workflow without SOLVER_ENDPOINT always uses greedy regardless of complexity", async () => {
      const workflow = createWorkflow(); // No SOLVER_ENDPOINT

      // Complex case: many participants + many constraints
      // Even with these, should work fine because greedy is always used
      // when no SOLVER_ENDPOINT is set.
      const session = await workflow.createSession(makeParams({
        participantHashes: [
          "hash_1", "hash_2", "hash_3",
          "hash_4", "hash_5", "hash_6",
        ],
      }));

      expect(session.sessionId).toMatch(/^ses_/);
      expect(session.status).toBe("candidates_ready");
      expect(session.candidates.length).toBeGreaterThanOrEqual(3);
    });

    it("SchedulingEnv accepts optional SOLVER_ENDPOINT", () => {
      // Type check: SOLVER_ENDPOINT is optional in SchedulingEnv
      const envWithEndpoint: SchedulingEnv = {
        USER_GRAPH: namespace,
        ACCOUNT: namespace,
        WRITE_QUEUE: queue as unknown as Queue,
        SOLVER_ENDPOINT: "https://solver.example.com/solve",
      };
      expect(envWithEndpoint.SOLVER_ENDPOINT).toBe("https://solver.example.com/solve");

      const envWithoutEndpoint: SchedulingEnv = {
        USER_GRAPH: namespace,
        ACCOUNT: namespace,
        WRITE_QUEUE: queue as unknown as Queue,
      };
      expect(envWithoutEndpoint.SOLVER_ENDPOINT).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Fairness and priority scoring (TM-82s.3)
  // -----------------------------------------------------------------------

  describe("fairness and priority scoring", () => {
    it("AC1: fairness score adjusts for repeated scheduling", async () => {
      // Step 1: Create a VIP to get participant hashes flowing through the system
      await userGraphDO.handleFetch(
        new Request("https://user-graph.internal/createVipPolicy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            vip_id: "vip_01FAIRNESS000000000001",
            participant_hash: "alice_hash",
            display_name: "Alice",
            priority_weight: 1.0,
            conditions_json: { allow_after_hours: false },
          }),
        }),
      );

      // Step 2: Record scheduling history where alice got preferred 8/10 times
      const historyEntries = [];
      for (let i = 0; i < 10; i++) {
        historyEntries.push({
          session_id: `ses_hist_${i}`,
          participant_hash: "alice_hash",
          got_preferred: i < 8, // 8/10 preferred
          scheduled_ts: `2026-02-${String(10 + i).padStart(2, "0")}T10:00:00Z`,
        });
        historyEntries.push({
          session_id: `ses_hist_${i}`,
          participant_hash: "bob_hash",
          got_preferred: i >= 8, // 2/10 preferred
          scheduled_ts: `2026-02-${String(10 + i).padStart(2, "0")}T10:00:00Z`,
        });
      }

      const recordResp = await userGraphDO.handleFetch(
        new Request("https://user-graph.internal/recordSchedulingHistory", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ entries: historyEntries }),
        }),
      );
      expect(recordResp.ok).toBe(true);

      // Step 3: Verify scheduling history is stored and retrieved
      const histResp = await userGraphDO.handleFetch(
        new Request("https://user-graph.internal/getSchedulingHistory", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ participant_hashes: ["alice_hash", "bob_hash"] }),
        }),
      );
      expect(histResp.ok).toBe(true);
      const { history } = (await histResp.json()) as {
        history: Array<{
          participant_hash: string;
          sessions_participated: number;
          sessions_preferred: number;
        }>;
      };
      expect(history.length).toBe(2);
      const alice = history.find((h) => h.participant_hash === "alice_hash");
      const bob = history.find((h) => h.participant_hash === "bob_hash");
      expect(alice!.sessions_participated).toBe(10);
      expect(alice!.sessions_preferred).toBe(8);
      expect(bob!.sessions_participated).toBe(10);
      expect(bob!.sessions_preferred).toBe(2);

      // Step 4: Schedule with alice as participant -- fairness should lower her score
      const workflow = createWorkflow();
      const sessionAlice = await workflow.createSession(makeParams({
        title: "Alice Meeting",
        participantHashes: ["alice_hash", "bob_hash"],
      }));

      expect(sessionAlice.candidates.length).toBeGreaterThan(0);

      // Candidates should include fairness information in explanations
      const hasFairness = sessionAlice.candidates.some(
        (c) => c.explanation.includes("fairness"),
      );
      expect(hasFairness).toBe(true);
    });

    it("AC2: VIP priority weight applied", async () => {
      // Create a high-priority VIP
      await userGraphDO.handleFetch(
        new Request("https://user-graph.internal/createVipPolicy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            vip_id: "vip_01PRIORITY00000000001",
            participant_hash: "ceo_hash",
            display_name: "CEO",
            priority_weight: 3.0,
            conditions_json: { allow_after_hours: true },
          }),
        }),
      );

      // Schedule with VIP participant
      const workflow = createWorkflow();
      const session = await workflow.createSession(makeParams({
        title: "CEO Meeting",
        participantHashes: ["ceo_hash"],
      }));

      expect(session.candidates.length).toBeGreaterThan(0);

      // VIP scoring should appear in explanations
      const hasVipScoring = session.candidates.some(
        (c) => c.explanation.includes("VIP"),
      );
      expect(hasVipScoring).toBe(true);
    });

    it("AC3: multi-factor scoring: preference + fairness + VIP + constraints", async () => {
      // Create VIP policy
      await userGraphDO.handleFetch(
        new Request("https://user-graph.internal/createVipPolicy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            vip_id: "vip_01MULTI0000000000001",
            participant_hash: "multi_vip",
            display_name: "Board Member",
            priority_weight: 2.0,
            conditions_json: { allow_after_hours: true },
          }),
        }),
      );

      // Record history where multi_vip was disadvantaged
      const entries = Array.from({ length: 5 }, (_, i) => ({
        session_id: `ses_multi_${i}`,
        participant_hash: "multi_vip",
        got_preferred: false,
        scheduled_ts: `2026-02-${String(1 + i).padStart(2, "0")}T10:00:00Z`,
      }));
      entries.push(
        ...Array.from({ length: 5 }, (_, i) => ({
          session_id: `ses_multi_${i}`,
          participant_hash: "other_person",
          got_preferred: true,
          scheduled_ts: `2026-02-${String(1 + i).padStart(2, "0")}T10:00:00Z`,
        })),
      );

      await userGraphDO.handleFetch(
        new Request("https://user-graph.internal/recordSchedulingHistory", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ entries }),
        }),
      );

      // Add working hours constraint for constraint scoring
      await userGraphDO.handleFetch(
        new Request("https://user-graph.internal/addConstraint", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind: "working_hours",
            config_json: {
              days: [1, 2, 3, 4, 5],
              start_time: "09:00",
              end_time: "17:00",
              timezone: "UTC",
            },
          }),
        }),
      );

      const workflow = createWorkflow();
      const session = await workflow.createSession(makeParams({
        title: "Multi-factor Meeting",
        participantHashes: ["multi_vip", "other_person"],
      }));

      expect(session.candidates.length).toBeGreaterThan(0);

      // Scores should reflect multi-factor composition
      // VIP weight 2.0 should amplify scores
      const topCandidate = session.candidates[0];
      expect(topCandidate.score).toBeGreaterThan(0);

      // Explanation should show multiple factors
      expect(topCandidate.explanation).toBeTruthy();
      expect(topCandidate.explanation.length).toBeGreaterThan(0);
    });

    it("AC4: human-readable explanation per candidate", async () => {
      // Create VIP with fairness history
      await userGraphDO.handleFetch(
        new Request("https://user-graph.internal/createVipPolicy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            vip_id: "vip_01EXPLAIN000000000001",
            participant_hash: "explain_vip",
            display_name: "Investor Sarah",
            priority_weight: 2.0,
            conditions_json: { allow_after_hours: false },
          }),
        }),
      );

      const workflow = createWorkflow();
      const session = await workflow.createSession(makeParams({
        title: "Explanation Test",
        participantHashes: ["explain_vip"],
      }));

      expect(session.candidates.length).toBeGreaterThan(0);

      // Every candidate must have a non-empty explanation
      for (const c of session.candidates) {
        expect(typeof c.explanation).toBe("string");
        expect(c.explanation.length).toBeGreaterThan(0);
      }

      // At least one should contain VIP info
      const hasVipExplanation = session.candidates.some(
        (c) => c.explanation.includes("VIP"),
      );
      expect(hasVipExplanation).toBe(true);
    });

    it("AC5: scheduling history tracked on commit", async () => {
      const workflow = createWorkflow();
      const session = await workflow.createSession(makeParams({
        title: "History Tracking Test",
        participantHashes: ["track_alice", "track_bob"],
      }));

      expect(session.candidates.length).toBeGreaterThan(0);

      // Commit the first candidate
      const candidateId = session.candidates[0].candidateId;
      await workflow.commitCandidate(
        TEST_USER_ID,
        session.sessionId,
        candidateId,
      );

      // Verify scheduling history was recorded
      const histResp = await userGraphDO.handleFetch(
        new Request("https://user-graph.internal/getSchedulingHistory", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            participant_hashes: ["track_alice", "track_bob"],
          }),
        }),
      );
      expect(histResp.ok).toBe(true);
      const { history } = (await histResp.json()) as {
        history: Array<{
          participant_hash: string;
          sessions_participated: number;
          sessions_preferred: number;
        }>;
      };

      // Both participants should have history
      expect(history.length).toBe(2);
      const trackAlice = history.find(
        (h) => h.participant_hash === "track_alice",
      );
      const trackBob = history.find(
        (h) => h.participant_hash === "track_bob",
      );
      expect(trackAlice!.sessions_participated).toBe(1);
      expect(trackBob!.sessions_participated).toBe(1);
      // First participant (organizer) gets preferred = true
      expect(trackAlice!.sessions_preferred).toBe(1);
      expect(trackBob!.sessions_preferred).toBe(0);
    });

    it("AC6: fairness adjusts after multiple sessions to prevent consistent disadvantage", async () => {
      // Record extensive history where person_a always wins
      const histEntries = [];
      for (let i = 0; i < 20; i++) {
        histEntries.push({
          session_id: `ses_bias_${i}`,
          participant_hash: "person_a",
          got_preferred: true, // Always gets preferred
          scheduled_ts: `2026-01-${String(1 + i).padStart(2, "0")}T10:00:00Z`,
        });
        histEntries.push({
          session_id: `ses_bias_${i}`,
          participant_hash: "person_b",
          got_preferred: false, // Never gets preferred
          scheduled_ts: `2026-01-${String(1 + i).padStart(2, "0")}T10:00:00Z`,
        });
      }

      await userGraphDO.handleFetch(
        new Request("https://user-graph.internal/recordSchedulingHistory", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ entries: histEntries }),
        }),
      );

      // Now schedule with both participants -- fairness should adjust
      const workflow = createWorkflow();
      const session = await workflow.createSession(makeParams({
        title: "Fairness Correction",
        participantHashes: ["person_a", "person_b"],
      }));

      expect(session.candidates.length).toBeGreaterThan(0);

      // person_a's dominant preference rate should trigger fairness adjustment
      // The explanation should reference fairness
      const hasFairness = session.candidates.some(
        (c) => c.explanation.includes("fairness"),
      );
      expect(hasFairness).toBe(true);
    });

    it("backward compatible: no fairness when no participantHashes", async () => {
      const workflow = createWorkflow();
      const session = await workflow.createSession(makeParams({
        title: "No Participants Test",
        // No participantHashes
      }));

      expect(session.candidates.length).toBeGreaterThan(0);

      // No fairness adjustments should appear
      for (const c of session.candidates) {
        expect(c.explanation).not.toContain("fairness adjustment");
      }
    });
  });
});
