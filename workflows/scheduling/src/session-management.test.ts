/**
 * Unit tests for scheduling session management (TM-946.4).
 *
 * Tests the session lifecycle state machine via UserGraphDO RPCs:
 * - Session status transitions: open -> candidates_ready -> committed/cancelled/expired
 * - Invalid transitions rejected with descriptive errors
 * - listSchedulingSessions with optional status filter
 * - cancelSchedulingSession releases holds
 * - expireStaleSchedulingSessions marks old sessions as expired
 * - Lazy expiry on getSchedulingSession
 *
 * Uses real SQLite (better-sqlite3) to exercise the actual SQL logic.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import type { SqlStorageLike, SqlStorageCursorLike } from "@tminus/shared";
import { UserGraphDO } from "@tminus/do-user-graph";
import type { QueueLike } from "@tminus/do-user-graph";

// ---------------------------------------------------------------------------
// SqlStorage adapter (same pattern as other integration tests)
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
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const SESSION_DEFAULTS = {
  status: "candidates_ready",
  objective_json: JSON.stringify({
    userId: "usr_test",
    title: "Team Meeting",
    durationMinutes: 60,
    windowStart: "2026-03-02T08:00:00Z",
    windowEnd: "2026-03-06T18:00:00Z",
    requiredAccountIds: ["acc_test"],
  }),
};

function insertSession(
  db: DatabaseType,
  sessionId: string,
  overrides: Partial<typeof SESSION_DEFAULTS & { created_at: string }> = {},
): void {
  const status = overrides.status ?? SESSION_DEFAULTS.status;
  const objectiveJson = overrides.objective_json ?? SESSION_DEFAULTS.objective_json;
  const createdAt = overrides.created_at ?? new Date().toISOString();

  db.prepare(
    `INSERT INTO schedule_sessions (session_id, status, objective_json, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(sessionId, status, objectiveJson, createdAt);
}

function insertCandidate(
  db: DatabaseType,
  candidateId: string,
  sessionId: string,
  opts: { start?: string; end?: string; score?: number; explanation?: string } = {},
): void {
  db.prepare(
    `INSERT INTO schedule_candidates (candidate_id, session_id, start_ts, end_ts, score, explanation, created_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
  ).run(
    candidateId,
    sessionId,
    opts.start ?? "2026-03-02T10:00:00Z",
    opts.end ?? "2026-03-02T11:00:00Z",
    opts.score ?? 80,
    opts.explanation ?? "Good slot",
  );
}

function insertHold(
  db: DatabaseType,
  holdId: string,
  sessionId: string,
  opts: { status?: string; expiresAt?: string } = {},
): void {
  db.prepare(
    `INSERT INTO schedule_holds (hold_id, session_id, account_id, provider_event_id, expires_at, status)
     VALUES (?, ?, 'acc_test', NULL, ?, ?)`,
  ).run(
    holdId,
    sessionId,
    opts.expiresAt ?? "2026-03-10T00:00:00Z",
    opts.status ?? "held",
  );
}

// ---------------------------------------------------------------------------
// DO RPC helpers
// ---------------------------------------------------------------------------

async function callDO(
  userGraphDO: UserGraphDO,
  path: string,
  body?: unknown,
): Promise<Response> {
  return userGraphDO.handleFetch(
    new Request(`https://user-graph.internal${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : "{}",
    }),
  );
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let db: DatabaseType;
let sql: SqlStorageLike;
let queue: MockQueue;
let userGraphDO: UserGraphDO;

describe("Scheduling session management", () => {
  beforeEach(async () => {
    db = new Database(":memory:");
    sql = createSqlStorageAdapter(db);
    queue = new MockQueue();
    userGraphDO = new UserGraphDO(sql, queue);

    // Trigger migration so tables exist
    await callDO(userGraphDO, "/getSyncHealth");
  });

  afterEach(() => {
    db.close();
  });

  // -----------------------------------------------------------------------
  // listSchedulingSessions
  // -----------------------------------------------------------------------

  describe("listSchedulingSessions", () => {
    it("returns empty list when no sessions exist", async () => {
      const resp = await callDO(userGraphDO, "/listSchedulingSessions", {});
      expect(resp.ok).toBe(true);

      const data = await resp.json() as { items: unknown[]; total: number };
      expect(data.items).toEqual([]);
      expect(data.total).toBe(0);
    });

    it("returns all sessions ordered by created_at DESC", async () => {
      insertSession(db, "ses_01", { created_at: "2026-03-01T10:00:00Z" });
      insertSession(db, "ses_02", { created_at: "2026-03-02T10:00:00Z" });
      insertSession(db, "ses_03", { created_at: "2026-03-03T10:00:00Z" });

      const resp = await callDO(userGraphDO, "/listSchedulingSessions", {});
      expect(resp.ok).toBe(true);

      const data = await resp.json() as { items: Array<{ sessionId: string }>; total: number };
      expect(data.total).toBe(3);
      expect(data.items.length).toBe(3);
      // Most recent first
      expect(data.items[0].sessionId).toBe("ses_03");
      expect(data.items[1].sessionId).toBe("ses_02");
      expect(data.items[2].sessionId).toBe("ses_01");
    });

    it("filters by status when provided", async () => {
      insertSession(db, "ses_01", { status: "open" });
      insertSession(db, "ses_02", { status: "candidates_ready" });
      insertSession(db, "ses_03", { status: "cancelled" });
      insertSession(db, "ses_04", { status: "committed" });

      const resp = await callDO(userGraphDO, "/listSchedulingSessions", {
        status: "candidates_ready",
      });
      expect(resp.ok).toBe(true);

      const data = await resp.json() as { items: Array<{ sessionId: string; status: string }>; total: number };
      expect(data.total).toBe(1);
      expect(data.items[0].sessionId).toBe("ses_02");
      expect(data.items[0].status).toBe("candidates_ready");
    });

    it("respects limit and offset pagination", async () => {
      for (let i = 1; i <= 5; i++) {
        insertSession(db, `ses_${String(i).padStart(2, "0")}`, {
          created_at: `2026-03-${String(i).padStart(2, "0")}T10:00:00Z`,
        });
      }

      const resp = await callDO(userGraphDO, "/listSchedulingSessions", {
        limit: 2,
        offset: 1,
      });
      const data = await resp.json() as { items: Array<{ sessionId: string }>; total: number };
      expect(data.total).toBe(5);
      expect(data.items.length).toBe(2);
      // Offset 1 = skip most recent (ses_05), get ses_04, ses_03
      expect(data.items[0].sessionId).toBe("ses_04");
      expect(data.items[1].sessionId).toBe("ses_03");
    });

    it("includes candidate count for each session", async () => {
      insertSession(db, "ses_01");
      insertCandidate(db, "cnd_01", "ses_01");
      insertCandidate(db, "cnd_02", "ses_01");
      insertCandidate(db, "cnd_03", "ses_01");

      insertSession(db, "ses_02");
      // No candidates for ses_02

      const resp = await callDO(userGraphDO, "/listSchedulingSessions", {});
      const data = await resp.json() as {
        items: Array<{ sessionId: string; candidateCount: number }>;
      };

      const ses01 = data.items.find((s) => s.sessionId === "ses_01");
      const ses02 = data.items.find((s) => s.sessionId === "ses_02");
      expect(ses01?.candidateCount).toBe(3);
      expect(ses02?.candidateCount).toBe(0);
    });

    it("parses objective_json into params (strips internal fields)", async () => {
      const objWithInternal = JSON.stringify({
        title: "Test",
        durationMinutes: 30,
        _committedCandidateId: "cnd_01",
        _committedEventId: "evt_01",
      });
      insertSession(db, "ses_01", {
        status: "committed",
        objective_json: objWithInternal,
      });

      const resp = await callDO(userGraphDO, "/listSchedulingSessions", {});
      const data = await resp.json() as {
        items: Array<{ sessionId: string; params: Record<string, unknown> }>;
      };

      expect(data.items[0].params.title).toBe("Test");
      expect(data.items[0].params.durationMinutes).toBe(30);
      // Internal fields should be stripped
      expect(data.items[0].params._committedCandidateId).toBeUndefined();
      expect(data.items[0].params._committedEventId).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // cancelSchedulingSession
  // -----------------------------------------------------------------------

  describe("cancelSchedulingSession", () => {
    it("cancels an open session", async () => {
      insertSession(db, "ses_01", { status: "open" });

      const resp = await callDO(userGraphDO, "/cancelSchedulingSession", {
        session_id: "ses_01",
      });
      expect(resp.ok).toBe(true);

      // Verify status changed
      const row = db.prepare("SELECT status FROM schedule_sessions WHERE session_id = ?").get("ses_01") as { status: string };
      expect(row.status).toBe("cancelled");
    });

    it("cancels a candidates_ready session", async () => {
      insertSession(db, "ses_01", { status: "candidates_ready" });

      const resp = await callDO(userGraphDO, "/cancelSchedulingSession", {
        session_id: "ses_01",
      });
      expect(resp.ok).toBe(true);

      const row = db.prepare("SELECT status FROM schedule_sessions WHERE session_id = ?").get("ses_01") as { status: string };
      expect(row.status).toBe("cancelled");
    });

    it("releases held holds when session is cancelled", async () => {
      insertSession(db, "ses_01", { status: "candidates_ready" });
      insertHold(db, "hld_01", "ses_01", { status: "held" });
      insertHold(db, "hld_02", "ses_01", { status: "held" });

      const resp = await callDO(userGraphDO, "/cancelSchedulingSession", {
        session_id: "ses_01",
      });
      expect(resp.ok).toBe(true);

      // All holds should be released
      const holds = db.prepare(
        "SELECT status FROM schedule_holds WHERE session_id = ?",
      ).all("ses_01") as Array<{ status: string }>;

      expect(holds.length).toBe(2);
      for (const h of holds) {
        expect(h.status).toBe("released");
      }
    });

    it("does not release already-released holds", async () => {
      insertSession(db, "ses_01", { status: "candidates_ready" });
      insertHold(db, "hld_01", "ses_01", { status: "released" });
      insertHold(db, "hld_02", "ses_01", { status: "held" });

      await callDO(userGraphDO, "/cancelSchedulingSession", {
        session_id: "ses_01",
      });

      const holds = db.prepare(
        "SELECT hold_id, status FROM schedule_holds WHERE session_id = ? ORDER BY hold_id",
      ).all("ses_01") as Array<{ hold_id: string; status: string }>;

      // Both should be released (one was already, one is newly released)
      expect(holds[0].status).toBe("released");
      expect(holds[1].status).toBe("released");
    });

    it("rejects cancel on already-cancelled session", async () => {
      insertSession(db, "ses_01", { status: "cancelled" });

      const resp = await callDO(userGraphDO, "/cancelSchedulingSession", {
        session_id: "ses_01",
      });
      expect(resp.ok).toBe(false);
      expect(resp.status).toBe(500);

      const body = await resp.json() as { error: string };
      expect(body.error).toContain("already cancelled");
    });

    it("rejects cancel on committed session", async () => {
      insertSession(db, "ses_01", { status: "committed" });

      const resp = await callDO(userGraphDO, "/cancelSchedulingSession", {
        session_id: "ses_01",
      });
      expect(resp.ok).toBe(false);

      const body = await resp.json() as { error: string };
      expect(body.error).toContain("already committed");
    });

    it("rejects cancel on expired session", async () => {
      insertSession(db, "ses_01", { status: "expired" });

      const resp = await callDO(userGraphDO, "/cancelSchedulingSession", {
        session_id: "ses_01",
      });
      expect(resp.ok).toBe(false);

      const body = await resp.json() as { error: string };
      expect(body.error).toContain("expired");
    });

    it("returns 500 for nonexistent session", async () => {
      const resp = await callDO(userGraphDO, "/cancelSchedulingSession", {
        session_id: "ses_NONEXISTENT",
      });
      expect(resp.ok).toBe(false);
      expect(resp.status).toBe(500);

      const body = await resp.json() as { error: string };
      expect(body.error).toContain("not found");
    });
  });

  // -----------------------------------------------------------------------
  // expireStaleSchedulingSessions
  // -----------------------------------------------------------------------

  describe("expireStaleSchedulingSessions", () => {
    it("expires sessions older than max_age_hours", async () => {
      // Insert a session created 48 hours ago
      const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
      insertSession(db, "ses_01", { status: "open", created_at: oldDate });
      insertSession(db, "ses_02", { status: "candidates_ready", created_at: oldDate });

      const resp = await callDO(userGraphDO, "/expireStaleSchedulingSessions", {
        max_age_hours: 24,
      });
      expect(resp.ok).toBe(true);

      const body = await resp.json() as { expired_count: number };
      expect(body.expired_count).toBe(2);

      // Verify status changed
      const rows = db.prepare(
        "SELECT session_id, status FROM schedule_sessions ORDER BY session_id",
      ).all() as Array<{ session_id: string; status: string }>;

      expect(rows[0].status).toBe("expired");
      expect(rows[1].status).toBe("expired");
    });

    it("does not expire recent sessions", async () => {
      // Insert a session created just now
      insertSession(db, "ses_01", { status: "candidates_ready" });

      const resp = await callDO(userGraphDO, "/expireStaleSchedulingSessions", {
        max_age_hours: 24,
      });
      expect(resp.ok).toBe(true);

      const body = await resp.json() as { expired_count: number };
      expect(body.expired_count).toBe(0);

      const row = db.prepare("SELECT status FROM schedule_sessions WHERE session_id = ?").get("ses_01") as { status: string };
      expect(row.status).toBe("candidates_ready");
    });

    it("does not expire committed or cancelled sessions", async () => {
      const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
      insertSession(db, "ses_01", { status: "committed", created_at: oldDate });
      insertSession(db, "ses_02", { status: "cancelled", created_at: oldDate });
      insertSession(db, "ses_03", { status: "expired", created_at: oldDate });

      const resp = await callDO(userGraphDO, "/expireStaleSchedulingSessions", {
        max_age_hours: 24,
      });

      const body = await resp.json() as { expired_count: number };
      expect(body.expired_count).toBe(0);
    });

    it("releases held holds when expiring sessions", async () => {
      const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
      insertSession(db, "ses_01", { status: "candidates_ready", created_at: oldDate });
      insertHold(db, "hld_01", "ses_01", { status: "held" });

      await callDO(userGraphDO, "/expireStaleSchedulingSessions", {
        max_age_hours: 24,
      });

      const hold = db.prepare("SELECT status FROM schedule_holds WHERE hold_id = ?").get("hld_01") as { status: string };
      expect(hold.status).toBe("released");
    });

    it("defaults to 24 hours when max_age_hours not provided", async () => {
      // 25 hours ago -- should be expired with default 24h
      const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      insertSession(db, "ses_01", { status: "open", created_at: oldDate });

      const resp = await callDO(userGraphDO, "/expireStaleSchedulingSessions", {});
      const body = await resp.json() as { expired_count: number };
      expect(body.expired_count).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Session status transition validation (state machine)
  // -----------------------------------------------------------------------

  describe("status transition validation", () => {
    it("open -> cancelled is valid", async () => {
      insertSession(db, "ses_01", { status: "open" });

      const resp = await callDO(userGraphDO, "/cancelSchedulingSession", {
        session_id: "ses_01",
      });
      expect(resp.ok).toBe(true);
    });

    it("candidates_ready -> cancelled is valid", async () => {
      insertSession(db, "ses_01", { status: "candidates_ready" });

      const resp = await callDO(userGraphDO, "/cancelSchedulingSession", {
        session_id: "ses_01",
      });
      expect(resp.ok).toBe(true);
    });

    it("committed -> cancelled is invalid", async () => {
      insertSession(db, "ses_01", { status: "committed" });

      const resp = await callDO(userGraphDO, "/cancelSchedulingSession", {
        session_id: "ses_01",
      });
      expect(resp.ok).toBe(false);
    });

    it("expired -> cancelled is invalid", async () => {
      insertSession(db, "ses_01", { status: "expired" });

      const resp = await callDO(userGraphDO, "/cancelSchedulingSession", {
        session_id: "ses_01",
      });
      expect(resp.ok).toBe(false);
    });

    it("cancelled -> cancelled is invalid (idempotency not assumed)", async () => {
      insertSession(db, "ses_01", { status: "cancelled" });

      const resp = await callDO(userGraphDO, "/cancelSchedulingSession", {
        session_id: "ses_01",
      });
      expect(resp.ok).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Lazy expiry on getSchedulingSession
  // -----------------------------------------------------------------------

  describe("lazy expiry on get", () => {
    it("auto-expires stale session when fetched via getSchedulingSession", async () => {
      // Insert a session that is older than 24h
      const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      insertSession(db, "ses_01", { status: "candidates_ready", created_at: oldDate });
      insertCandidate(db, "cnd_01", "ses_01");

      const resp = await callDO(userGraphDO, "/getSchedulingSession", {
        session_id: "ses_01",
      });
      expect(resp.ok).toBe(true);

      const data = await resp.json() as { status: string; sessionId: string };
      expect(data.status).toBe("expired");

      // Verify DB was updated
      const row = db.prepare("SELECT status FROM schedule_sessions WHERE session_id = ?").get("ses_01") as { status: string };
      expect(row.status).toBe("expired");
    });

    it("does not expire recent sessions when fetched", async () => {
      insertSession(db, "ses_01", { status: "candidates_ready" });
      insertCandidate(db, "cnd_01", "ses_01");

      const resp = await callDO(userGraphDO, "/getSchedulingSession", {
        session_id: "ses_01",
      });
      expect(resp.ok).toBe(true);

      const data = await resp.json() as { status: string };
      expect(data.status).toBe("candidates_ready");
    });

    it("does not expire committed sessions even if old", async () => {
      const oldDate = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
      insertSession(db, "ses_01", { status: "committed", created_at: oldDate });

      const resp = await callDO(userGraphDO, "/getSchedulingSession", {
        session_id: "ses_01",
      });
      expect(resp.ok).toBe(true);

      const data = await resp.json() as { status: string };
      expect(data.status).toBe("committed");
    });

    it("releases holds when lazy-expiring on get", async () => {
      const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      insertSession(db, "ses_01", { status: "candidates_ready", created_at: oldDate });
      insertHold(db, "hld_01", "ses_01", { status: "held" });

      await callDO(userGraphDO, "/getSchedulingSession", {
        session_id: "ses_01",
      });

      const hold = db.prepare("SELECT status FROM schedule_holds WHERE hold_id = ?").get("hld_01") as { status: string };
      expect(hold.status).toBe("released");
    });
  });

  // -----------------------------------------------------------------------
  // listSchedulingSessions triggers lazy expiry
  // -----------------------------------------------------------------------

  describe("lazy expiry on list", () => {
    it("expired sessions appear as expired in list results", async () => {
      const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      insertSession(db, "ses_01", { status: "candidates_ready", created_at: oldDate });
      insertSession(db, "ses_02", { status: "open", created_at: oldDate });
      insertSession(db, "ses_03", { status: "candidates_ready" }); // recent

      const resp = await callDO(userGraphDO, "/listSchedulingSessions", {});
      const data = await resp.json() as {
        items: Array<{ sessionId: string; status: string }>;
        total: number;
      };

      // Stale sessions should have been expired before listing
      const ses01 = data.items.find((s) => s.sessionId === "ses_01");
      const ses02 = data.items.find((s) => s.sessionId === "ses_02");
      const ses03 = data.items.find((s) => s.sessionId === "ses_03");

      expect(ses01?.status).toBe("expired");
      expect(ses02?.status).toBe("expired");
      expect(ses03?.status).toBe("candidates_ready");
    });
  });
});
