/**
 * Integration tests for SchedulingMixin (extracted from UserGraphDO).
 *
 * Uses real SQLite (better-sqlite3), NO mocks on the storage layer.
 * Tests exercise the scheduling methods through the full UserGraphDO
 * class to prove the mixin delegation works end-to-end.
 *
 * Covers:
 * - Session lifecycle: store, get, list, commit, cancel, expire
 * - Hold lifecycle: store, getBySession, updateStatus, extend, commit, release
 * - Error cases: not found, invalid transitions
 * - Expire stale sessions and terminal hold detection
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import type { SqlStorageLike, SqlStorageCursorLike } from "@tminus/shared";
import { UserGraphDO } from "./index";
import type { QueueLike } from "./index";

// ---------------------------------------------------------------------------
// Test fixtures
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
// Helper: send RPC request to the DO
// ---------------------------------------------------------------------------

function rpc(do_: UserGraphDO, path: string, body: unknown = {}): Promise<Response> {
  return do_.handleFetch(
    new Request(`https://fake-host${path}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SchedulingMixin integration (via UserGraphDO)", () => {
  let db: DatabaseType;
  let sql: SqlStorageLike;
  let queue: MockQueue;
  let do_: UserGraphDO;

  beforeEach(() => {
    db = new Database(":memory:");
    sql = createSqlStorageAdapter(db);
    queue = new MockQueue();
    do_ = new UserGraphDO(sql, queue);
  });

  afterEach(() => {
    db.close();
  });

  // -----------------------------------------------------------------------
  // Session lifecycle
  // -----------------------------------------------------------------------

  describe("scheduling session lifecycle", () => {
    const sessionData = {
      session_id: "sched_001",
      status: "open",
      objective_json: JSON.stringify({ title: "Team sync", duration: 30 }),
      candidates: [
        {
          candidateId: "cand_001",
          sessionId: "sched_001",
          start: "2026-02-20T10:00:00Z",
          end: "2026-02-20T10:30:00Z",
          score: 0.95,
          explanation: "Best match for all participants",
        },
        {
          candidateId: "cand_002",
          sessionId: "sched_001",
          start: "2026-02-20T14:00:00Z",
          end: "2026-02-20T14:30:00Z",
          score: 0.80,
          explanation: "Second best option",
        },
      ],
      created_at: new Date().toISOString(),
    };

    it("stores and retrieves a scheduling session with candidates", async () => {
      const storeResp = await rpc(do_, "/storeSchedulingSession", sessionData);
      expect(storeResp.status).toBe(200);
      const storeJson = await storeResp.json();
      expect(storeJson).toEqual({ ok: true });

      const getResp = await rpc(do_, "/getSchedulingSession", { session_id: "sched_001" });
      expect(getResp.status).toBe(200);
      const session = await getResp.json() as Record<string, unknown>;
      expect(session.sessionId).toBe("sched_001");
      expect(session.status).toBe("open");
      expect(session.params).toEqual({ title: "Team sync", duration: 30 });
      expect(session.candidates).toHaveLength(2);
      // Candidates are ordered by score DESC
      expect((session.candidates as Array<{ candidateId: string }>)[0].candidateId).toBe("cand_001");
      expect((session.candidates as Array<{ candidateId: string }>)[1].candidateId).toBe("cand_002");
    });

    it("lists scheduling sessions", async () => {
      await rpc(do_, "/storeSchedulingSession", sessionData);
      await rpc(do_, "/storeSchedulingSession", {
        ...sessionData,
        session_id: "sched_002",
        status: "candidates_ready",
        candidates: [],
      });

      const listResp = await rpc(do_, "/listSchedulingSessions", {});
      expect(listResp.status).toBe(200);
      const list = await listResp.json() as { items: unknown[]; total: number };
      expect(list.total).toBe(2);
      expect(list.items).toHaveLength(2);
    });

    it("lists scheduling sessions with status filter", async () => {
      await rpc(do_, "/storeSchedulingSession", sessionData);
      await rpc(do_, "/storeSchedulingSession", {
        ...sessionData,
        session_id: "sched_002",
        status: "committed",
        candidates: [],
      });

      const listResp = await rpc(do_, "/listSchedulingSessions", { status: "open" });
      const list = await listResp.json() as { items: Array<{ sessionId: string }>; total: number };
      expect(list.total).toBe(1);
      expect(list.items[0].sessionId).toBe("sched_001");
    });

    it("commits a scheduling session", async () => {
      await rpc(do_, "/storeSchedulingSession", sessionData);

      const commitResp = await rpc(do_, "/commitSchedulingSession", {
        session_id: "sched_001",
        candidate_id: "cand_001",
        event_id: "evt_confirmed_001",
      });
      expect(commitResp.status).toBe(200);

      const getResp = await rpc(do_, "/getSchedulingSession", { session_id: "sched_001" });
      const session = await getResp.json() as Record<string, unknown>;
      expect(session.status).toBe("committed");
      expect(session.committedCandidateId).toBe("cand_001");
      expect(session.committedEventId).toBe("evt_confirmed_001");
    });

    it("cancels a scheduling session", async () => {
      await rpc(do_, "/storeSchedulingSession", sessionData);

      const cancelResp = await rpc(do_, "/cancelSchedulingSession", {
        session_id: "sched_001",
      });
      expect(cancelResp.status).toBe(200);

      const getResp = await rpc(do_, "/getSchedulingSession", { session_id: "sched_001" });
      const session = await getResp.json() as Record<string, unknown>;
      expect(session.status).toBe("cancelled");
    });

    it("rejects cancellation of already committed session", async () => {
      await rpc(do_, "/storeSchedulingSession", sessionData);
      await rpc(do_, "/commitSchedulingSession", {
        session_id: "sched_001",
        candidate_id: "cand_001",
        event_id: "evt_001",
      });

      const cancelResp = await rpc(do_, "/cancelSchedulingSession", {
        session_id: "sched_001",
      });
      expect(cancelResp.status).toBe(500);
      const err = await cancelResp.json() as { error: string };
      expect(err.error).toContain("committed and cannot be cancelled");
    });

    it("rejects cancellation of already cancelled session", async () => {
      await rpc(do_, "/storeSchedulingSession", sessionData);
      await rpc(do_, "/cancelSchedulingSession", { session_id: "sched_001" });

      const cancelResp = await rpc(do_, "/cancelSchedulingSession", {
        session_id: "sched_001",
      });
      expect(cancelResp.status).toBe(500);
      const err = await cancelResp.json() as { error: string };
      expect(err.error).toContain("already cancelled");
    });

    it("returns 500 for non-existent session", async () => {
      const getResp = await rpc(do_, "/getSchedulingSession", {
        session_id: "nonexistent",
      });
      expect(getResp.status).toBe(500);
      const err = await getResp.json() as { error: string };
      expect(err.error).toContain("not found");
    });

    it("expires stale scheduling sessions", async () => {
      // Store a session with a created_at far in the past
      const pastDate = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
      await rpc(do_, "/storeSchedulingSession", {
        ...sessionData,
        created_at: pastDate,
      });

      const expireResp = await rpc(do_, "/expireStaleSchedulingSessions", {
        max_age_hours: 24,
      });
      expect(expireResp.status).toBe(200);
      const result = await expireResp.json() as { expired_count: number };
      expect(result.expired_count).toBe(1);

      // Verify session is now expired
      const getResp = await rpc(do_, "/getSchedulingSession", { session_id: "sched_001" });
      const session = await getResp.json() as Record<string, unknown>;
      expect(session.status).toBe("expired");
    });
  });

  // -----------------------------------------------------------------------
  // Hold lifecycle
  // -----------------------------------------------------------------------

  describe("tentative hold lifecycle", () => {
    const sessionData = {
      session_id: "sched_hold_001",
      status: "candidates_ready",
      objective_json: JSON.stringify({ title: "Meeting" }),
      candidates: [],
      created_at: new Date().toISOString(),
    };

    const holdsData = [
      {
        hold_id: "hold_001",
        session_id: "sched_hold_001",
        account_id: "acc_001",
        provider_event_id: null,
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        status: "held",
      },
      {
        hold_id: "hold_002",
        session_id: "sched_hold_001",
        account_id: "acc_001",
        provider_event_id: "google_evt_tentative",
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        status: "held",
      },
    ];

    it("stores and retrieves holds for a session", async () => {
      await rpc(do_, "/storeSchedulingSession", sessionData);
      const storeResp = await rpc(do_, "/storeHolds", { holds: holdsData });
      expect(storeResp.status).toBe(200);

      const getResp = await rpc(do_, "/getHoldsBySession", {
        session_id: "sched_hold_001",
      });
      expect(getResp.status).toBe(200);
      const result = await getResp.json() as { holds: Array<{ hold_id: string }> };
      expect(result.holds).toHaveLength(2);
      expect(result.holds[0].hold_id).toBe("hold_001");
      expect(result.holds[1].hold_id).toBe("hold_002");
    });

    it("updates hold status", async () => {
      await rpc(do_, "/storeSchedulingSession", sessionData);
      await rpc(do_, "/storeHolds", { holds: holdsData });

      const updateResp = await rpc(do_, "/updateHoldStatus", {
        hold_id: "hold_001",
        status: "released",
      });
      expect(updateResp.status).toBe(200);

      const getResp = await rpc(do_, "/getHoldsBySession", {
        session_id: "sched_hold_001",
      });
      const result = await getResp.json() as { holds: Array<{ hold_id: string; status: string }> };
      const hold = result.holds.find((h) => h.hold_id === "hold_001");
      expect(hold?.status).toBe("released");
    });

    it("updates hold status with provider_event_id", async () => {
      await rpc(do_, "/storeSchedulingSession", sessionData);
      await rpc(do_, "/storeHolds", { holds: holdsData });

      const updateResp = await rpc(do_, "/updateHoldStatus", {
        hold_id: "hold_001",
        status: "committed",
        provider_event_id: "google_confirmed_001",
      });
      expect(updateResp.status).toBe(200);

      const getResp = await rpc(do_, "/getHoldsBySession", {
        session_id: "sched_hold_001",
      });
      const result = await getResp.json() as { holds: Array<{ hold_id: string; status: string; provider_event_id: string | null }> };
      const hold = result.holds.find((h) => h.hold_id === "hold_001");
      expect(hold?.status).toBe("committed");
      expect(hold?.provider_event_id).toBe("google_confirmed_001");
    });

    it("rejects invalid hold status transitions", async () => {
      await rpc(do_, "/storeSchedulingSession", sessionData);
      await rpc(do_, "/storeHolds", { holds: holdsData });

      // Release first, then try to commit (released -> committed is invalid)
      await rpc(do_, "/updateHoldStatus", {
        hold_id: "hold_001",
        status: "released",
      });

      const updateResp = await rpc(do_, "/updateHoldStatus", {
        hold_id: "hold_001",
        status: "committed",
      });
      expect(updateResp.status).toBe(500);
      const err = await updateResp.json() as { error: string };
      expect(err.error).toContain("Invalid hold transition");
    });

    it("rejects update for non-existent hold", async () => {
      const updateResp = await rpc(do_, "/updateHoldStatus", {
        hold_id: "nonexistent",
        status: "released",
      });
      expect(updateResp.status).toBe(500);
      const err = await updateResp.json() as { error: string };
      expect(err.error).toContain("not found");
    });

    it("commits session holds (releases all held)", async () => {
      await rpc(do_, "/storeSchedulingSession", sessionData);
      await rpc(do_, "/storeHolds", { holds: holdsData });

      const commitResp = await rpc(do_, "/commitSessionHolds", {
        session_id: "sched_hold_001",
        committed_candidate_id: "cand_001",
      });
      expect(commitResp.status).toBe(200);
      const commitResult = await commitResp.json() as {
        holds: { committed: unknown[]; released: Array<{ hold_id: string; status: string }> };
      };
      expect(commitResult.holds.released).toHaveLength(2);
      expect(commitResult.holds.released[0].status).toBe("released");
      expect(commitResult.holds.released[1].status).toBe("released");
    });

    it("releases session holds", async () => {
      await rpc(do_, "/storeSchedulingSession", sessionData);
      await rpc(do_, "/storeHolds", { holds: holdsData });

      const releaseResp = await rpc(do_, "/releaseSessionHolds", {
        session_id: "sched_hold_001",
      });
      expect(releaseResp.status).toBe(200);

      // Verify all holds released
      const getResp = await rpc(do_, "/getHoldsBySession", {
        session_id: "sched_hold_001",
      });
      const result = await getResp.json() as { holds: Array<{ status: string }> };
      for (const h of result.holds) {
        expect(h.status).toBe("released");
      }
    });

    it("extends hold expiry", async () => {
      await rpc(do_, "/storeSchedulingSession", sessionData);
      await rpc(do_, "/storeHolds", { holds: holdsData });

      const newExpiry = new Date(Date.now() + 7200000).toISOString();
      const extendResp = await rpc(do_, "/extendHolds", {
        session_id: "sched_hold_001",
        holds: [
          { hold_id: "hold_001", new_expires_at: newExpiry },
        ],
      });
      expect(extendResp.status).toBe(200);
      const extendResult = await extendResp.json() as { ok: boolean; extended: number };
      expect(extendResult.extended).toBe(1);

      // Verify the hold's expiry was updated
      const getResp = await rpc(do_, "/getHoldsBySession", {
        session_id: "sched_hold_001",
      });
      const result = await getResp.json() as { holds: Array<{ hold_id: string; expires_at: string }> };
      const hold = result.holds.find((h) => h.hold_id === "hold_001");
      expect(hold?.expires_at).toBe(newExpiry);
    });

    it("does not extend holds for wrong session", async () => {
      await rpc(do_, "/storeSchedulingSession", sessionData);
      await rpc(do_, "/storeHolds", { holds: holdsData });

      const newExpiry = new Date(Date.now() + 7200000).toISOString();
      const extendResp = await rpc(do_, "/extendHolds", {
        session_id: "wrong_session",
        holds: [
          { hold_id: "hold_001", new_expires_at: newExpiry },
        ],
      });
      expect(extendResp.status).toBe(200);
      const extendResult = await extendResp.json() as { ok: boolean; extended: number };
      expect(extendResult.extended).toBe(0);
    });

    it("expires session when all holds are terminal", async () => {
      await rpc(do_, "/storeSchedulingSession", sessionData);
      await rpc(do_, "/storeHolds", { holds: holdsData });

      // Release all holds
      await rpc(do_, "/releaseSessionHolds", { session_id: "sched_hold_001" });

      const expireResp = await rpc(do_, "/expireSessionIfAllHoldsTerminal", {
        session_id: "sched_hold_001",
      });
      expect(expireResp.status).toBe(200);
      const result = await expireResp.json() as { ok: boolean; expired: boolean };
      expect(result.expired).toBe(true);

      // Verify session is expired
      const getResp = await rpc(do_, "/getSchedulingSession", {
        session_id: "sched_hold_001",
      });
      const session = await getResp.json() as Record<string, unknown>;
      expect(session.status).toBe("expired");
    });

    it("does not expire session when holds are still active", async () => {
      await rpc(do_, "/storeSchedulingSession", sessionData);
      await rpc(do_, "/storeHolds", { holds: holdsData });

      const expireResp = await rpc(do_, "/expireSessionIfAllHoldsTerminal", {
        session_id: "sched_hold_001",
      });
      expect(expireResp.status).toBe(200);
      const result = await expireResp.json() as { ok: boolean; expired: boolean };
      expect(result.expired).toBe(false);
    });

    it("cancelling a session releases its holds", async () => {
      await rpc(do_, "/storeSchedulingSession", sessionData);
      await rpc(do_, "/storeHolds", { holds: holdsData });

      await rpc(do_, "/cancelSchedulingSession", { session_id: "sched_hold_001" });

      const getResp = await rpc(do_, "/getHoldsBySession", {
        session_id: "sched_hold_001",
      });
      const result = await getResp.json() as { holds: Array<{ status: string }> };
      for (const h of result.holds) {
        expect(h.status).toBe("released");
      }
    });
  });

  // -----------------------------------------------------------------------
  // Expired holds query
  // -----------------------------------------------------------------------

  describe("expired holds query", () => {
    it("returns holds past their expiry", async () => {
      const sessionData = {
        session_id: "sched_expired_001",
        status: "candidates_ready",
        objective_json: JSON.stringify({ title: "Meeting" }),
        candidates: [],
        created_at: new Date().toISOString(),
      };
      await rpc(do_, "/storeSchedulingSession", sessionData);

      // Store holds with past expiry using ISO 8601 format (as produced by
      // JavaScript's Date.toISOString()). The SQL wraps expires_at in
      // datetime() so the comparison works regardless of format.
      const pastExpiry = "2020-01-01T00:00:00.000Z";
      await rpc(do_, "/storeHolds", {
        holds: [
          {
            hold_id: "hold_expired_001",
            session_id: "sched_expired_001",
            account_id: "acc_001",
            provider_event_id: null,
            expires_at: pastExpiry,
            status: "held",
          },
        ],
      });

      const expiredResp = await rpc(do_, "/getExpiredHolds");
      expect(expiredResp.status).toBe(200);
      const result = await expiredResp.json() as { holds: Array<{ hold_id: string }> };
      expect(result.holds).toHaveLength(1);
      expect(result.holds[0].hold_id).toBe("hold_expired_001");
    });

    it("does not return holds that are not past expiry", async () => {
      const sessionData = {
        session_id: "sched_active_001",
        status: "candidates_ready",
        objective_json: JSON.stringify({ title: "Meeting" }),
        candidates: [],
        created_at: new Date().toISOString(),
      };
      await rpc(do_, "/storeSchedulingSession", sessionData);

      const futureExpiry = new Date(Date.now() + 3600000).toISOString();
      await rpc(do_, "/storeHolds", {
        holds: [
          {
            hold_id: "hold_active_001",
            session_id: "sched_active_001",
            account_id: "acc_001",
            provider_event_id: null,
            expires_at: futureExpiry,
            status: "held",
          },
        ],
      });

      const expiredResp = await rpc(do_, "/getExpiredHolds");
      const result = await expiredResp.json() as { holds: unknown[] };
      expect(result.holds).toHaveLength(0);
    });
  });
});
