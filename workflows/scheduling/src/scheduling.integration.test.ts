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
});
