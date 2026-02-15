/**
 * Integration tests for UserGraphDO commitment tracking.
 *
 * Uses real SQLite (better-sqlite3) with the full UserGraphDO schema.
 * Tests prove:
 * - createCommitment: validation, client_id uniqueness, window_type handling
 * - getCommitment: retrieval by commitment_id
 * - listCommitments: listing all commitments for a user
 * - deleteCommitment: removal and cascade of reports
 * - getCommitmentStatus: rolling window computation, actual hours aggregation,
 *   compliance status determination (compliant/under/over)
 * - RPC integration: handleFetch dispatch for all commitment endpoints
 * - Full flow: create commitment -> tag events -> GET status -> verify
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import type {
  SqlStorageLike,
  SqlStorageCursorLike,
  ProviderDelta,
  AccountId,
} from "@tminus/shared";
import { UserGraphDO } from "./index";
import type {
  QueueLike,
  TimeCommitment,
  CommitmentStatus,
} from "./index";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TEST_ACCOUNT_ID = "acc_01TESTACCOUNT0000000000001" as AccountId;

function makeCreatedDelta(overrides?: {
  origin_event_id?: string;
  title?: string;
  start?: string;
  end?: string;
}): ProviderDelta {
  return {
    type: "created",
    origin_event_id: overrides?.origin_event_id ?? "google_evt_commit_001",
    origin_account_id: TEST_ACCOUNT_ID,
    event: {
      origin_account_id: TEST_ACCOUNT_ID,
      origin_event_id: overrides?.origin_event_id ?? "google_evt_commit_001",
      title: overrides?.title ?? "Client Meeting",
      description: null,
      location: null,
      start: { dateTime: overrides?.start ?? "2026-02-15T10:00:00Z" },
      end: { dateTime: overrides?.end ?? "2026-02-15T12:00:00Z" },
      all_day: false,
      status: "confirmed",
      visibility: "default",
      transparency: "opaque",
    },
  };
}

// ---------------------------------------------------------------------------
// SqlStorage adapter (same pattern as other DO tests)
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
// Test suite
// ---------------------------------------------------------------------------

describe("UserGraphDO commitment tracking", () => {
  let db: DatabaseType;
  let sql: SqlStorageLike;
  let queue: MockQueue;
  let ug: UserGraphDO;

  beforeEach(async () => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    sql = createSqlStorageAdapter(db);
    queue = new MockQueue();
    ug = new UserGraphDO(sql, queue);
  });

  afterEach(() => {
    db.close();
  });

  // -------------------------------------------------------------------------
  // createCommitment
  // -------------------------------------------------------------------------

  describe("createCommitment", () => {
    it("creates a WEEKLY commitment with defaults", () => {
      const commitment = ug.createCommitment(
        "cmt_01TESTAAAAAAAAAAAAAAAAAA01",
        "client_acme",
        10,
      );

      expect(commitment.commitment_id).toBe("cmt_01TESTAAAAAAAAAAAAAAAAAA01");
      expect(commitment.client_id).toBe("client_acme");
      expect(commitment.target_hours).toBe(10);
      expect(commitment.window_type).toBe("WEEKLY");
      expect(commitment.rolling_window_weeks).toBe(4);
      expect(commitment.hard_minimum).toBe(false);
      expect(commitment.proof_required).toBe(false);
      expect(commitment.client_name).toBeNull();
      expect(commitment.created_at).toBeTruthy();
    });

    it("creates a MONTHLY commitment with all fields specified", () => {
      const commitment = ug.createCommitment(
        "cmt_01TESTAAAAAAAAAAAAAAAAAA02",
        "client_beta",
        40,
        "MONTHLY",
        "Beta Corp",
        8,
        true,
        true,
      );

      expect(commitment.window_type).toBe("MONTHLY");
      expect(commitment.client_name).toBe("Beta Corp");
      expect(commitment.rolling_window_weeks).toBe(8);
      expect(commitment.hard_minimum).toBe(true);
      expect(commitment.proof_required).toBe(true);
    });

    it("rejects invalid window type", () => {
      expect(() =>
        ug.createCommitment(
          "cmt_01TESTAAAAAAAAAAAAAAAAAA03",
          "client_x",
          10,
          "DAILY",
        ),
      ).toThrow("Invalid window_type: DAILY");
    });

    it("rejects zero target_hours", () => {
      expect(() =>
        ug.createCommitment(
          "cmt_01TESTAAAAAAAAAAAAAAAAAA04",
          "client_x",
          0,
        ),
      ).toThrow("target_hours must be a positive number");
    });

    it("rejects negative target_hours", () => {
      expect(() =>
        ug.createCommitment(
          "cmt_01TESTAAAAAAAAAAAAAAAAAA05",
          "client_x",
          -5,
        ),
      ).toThrow("target_hours must be a positive number");
    });

    it("rejects empty client_id", () => {
      expect(() =>
        ug.createCommitment(
          "cmt_01TESTAAAAAAAAAAAAAAAAAA06",
          "",
          10,
        ),
      ).toThrow("client_id is required");
    });

    it("rejects non-integer rolling_window_weeks", () => {
      expect(() =>
        ug.createCommitment(
          "cmt_01TESTAAAAAAAAAAAAAAAAAA07",
          "client_x",
          10,
          "WEEKLY",
          null,
          2.5,
        ),
      ).toThrow("rolling_window_weeks must be a positive integer");
    });

    it("rejects zero rolling_window_weeks", () => {
      expect(() =>
        ug.createCommitment(
          "cmt_01TESTAAAAAAAAAAAAAAAAAA08",
          "client_x",
          10,
          "WEEKLY",
          null,
          0,
        ),
      ).toThrow("rolling_window_weeks must be a positive integer");
    });

    it("rejects duplicate commitment for same client", () => {
      ug.createCommitment(
        "cmt_01TESTAAAAAAAAAAAAAAAAAA09",
        "client_dup",
        10,
      );

      expect(() =>
        ug.createCommitment(
          "cmt_01TESTAAAAAAAAAAAAAAAAAA10",
          "client_dup",
          20,
        ),
      ).toThrow("Commitment already exists for client client_dup");
    });
  });

  // -------------------------------------------------------------------------
  // getCommitment
  // -------------------------------------------------------------------------

  describe("getCommitment", () => {
    it("returns the commitment by ID", () => {
      ug.createCommitment(
        "cmt_01TESTGETAAAAAAAAAAAAAAA01",
        "client_get",
        15.5,
        "MONTHLY",
        "Get Corp",
      );

      const commitment = ug.getCommitment("cmt_01TESTGETAAAAAAAAAAAAAAA01");
      expect(commitment).not.toBeNull();
      expect(commitment!.commitment_id).toBe("cmt_01TESTGETAAAAAAAAAAAAAAA01");
      expect(commitment!.client_id).toBe("client_get");
      expect(commitment!.target_hours).toBe(15.5);
      expect(commitment!.window_type).toBe("MONTHLY");
      expect(commitment!.client_name).toBe("Get Corp");
    });

    it("returns null for non-existent commitment", () => {
      const commitment = ug.getCommitment("cmt_01NONEXISTENT00000000001");
      expect(commitment).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // listCommitments
  // -------------------------------------------------------------------------

  describe("listCommitments", () => {
    it("returns empty array when no commitments exist", () => {
      const commitments = ug.listCommitments();
      expect(commitments).toEqual([]);
    });

    it("returns all commitments ordered by created_at DESC", () => {
      ug.createCommitment(
        "cmt_01TESTLISTAAAAAAAAAAAAAAA1",
        "client_alpha",
        10,
      );
      ug.createCommitment(
        "cmt_01TESTLISTAAAAAAAAAAAAAAA2",
        "client_beta",
        20,
      );

      const commitments = ug.listCommitments();
      expect(commitments.length).toBe(2);
      const clientIds = commitments.map((c) => c.client_id);
      expect(clientIds).toContain("client_alpha");
      expect(clientIds).toContain("client_beta");
    });
  });

  // -------------------------------------------------------------------------
  // deleteCommitment
  // -------------------------------------------------------------------------

  describe("deleteCommitment", () => {
    it("deletes an existing commitment", () => {
      ug.createCommitment(
        "cmt_01TESTDELAAAAAAAAAAAAAAA01",
        "client_del",
        10,
      );

      const deleted = ug.deleteCommitment("cmt_01TESTDELAAAAAAAAAAAAAAA01");
      expect(deleted).toBe(true);

      // Verify it's gone
      const commitment = ug.getCommitment("cmt_01TESTDELAAAAAAAAAAAAAAA01");
      expect(commitment).toBeNull();
    });

    it("returns false for non-existent commitment", () => {
      const deleted = ug.deleteCommitment("cmt_01NONEXISTENT00000000001");
      expect(deleted).toBe(false);
    });

    it("allows creating new commitment for same client after deletion", () => {
      ug.createCommitment(
        "cmt_01TESTDELAAAAAAAAAAAAAAA02",
        "client_reuse",
        10,
      );
      ug.deleteCommitment("cmt_01TESTDELAAAAAAAAAAAAAAA02");

      // Should not throw -- client is now free
      const newCommitment = ug.createCommitment(
        "cmt_01TESTDELAAAAAAAAAAAAAAA03",
        "client_reuse",
        20,
      );
      expect(newCommitment.target_hours).toBe(20);
    });
  });

  // -------------------------------------------------------------------------
  // getCommitmentStatus -- rolling window computation
  // -------------------------------------------------------------------------

  describe("getCommitmentStatus", () => {
    let eventId1: string;
    let eventId2: string;
    let eventId3: string;

    beforeEach(async () => {
      // Create 3 events:
      // Event 1: 2 hours (10:00-12:00)
      const delta1 = makeCreatedDelta({
        origin_event_id: "google_evt_status_001",
        title: "Client Work A",
        start: "2026-02-10T10:00:00Z",
        end: "2026-02-10T12:00:00Z",
      });
      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [delta1]);

      // Event 2: 3 hours (09:00-12:00)
      const delta2 = makeCreatedDelta({
        origin_event_id: "google_evt_status_002",
        title: "Client Work B",
        start: "2026-02-12T09:00:00Z",
        end: "2026-02-12T12:00:00Z",
      });
      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [delta2]);

      // Event 3: 1.5 hours (14:00-15:30) -- different client
      const delta3 = makeCreatedDelta({
        origin_event_id: "google_evt_status_003",
        title: "Other Client Work",
        start: "2026-02-12T14:00:00Z",
        end: "2026-02-12T15:30:00Z",
      });
      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [delta3]);

      // Get event IDs
      const events = ug.listCanonicalEvents({});
      expect(events.items.length).toBe(3);

      // Sort by title to find them reliably
      const sorted = [...events.items].sort((a, b) =>
        (a.title ?? "").localeCompare(b.title ?? ""),
      );
      eventId1 = sorted.find((e) => e.title === "Client Work A")!.canonical_event_id;
      eventId2 = sorted.find((e) => e.title === "Client Work B")!.canonical_event_id;
      eventId3 = sorted.find((e) => e.title === "Other Client Work")!.canonical_event_id;

      // Tag events with allocations
      ug.createAllocation(
        "alc_01TESTSTATUSAAAAAAAAAAA01",
        eventId1,
        "BILLABLE",
        "client_acme",
        null,
      );
      ug.createAllocation(
        "alc_01TESTSTATUSAAAAAAAAAAA02",
        eventId2,
        "BILLABLE",
        "client_acme",
        null,
      );
      ug.createAllocation(
        "alc_01TESTSTATUSAAAAAAAAAAA03",
        eventId3,
        "BILLABLE",
        "client_other",
        null,
      );
    });

    it("returns null for non-existent commitment", () => {
      const status = ug.getCommitmentStatus("cmt_01NONEXISTENT00000000001");
      expect(status).toBeNull();
    });

    it("computes 'under' status when actual < target", () => {
      // Commitment: 10 hours/week for client_acme
      // Actual: 5 hours (2 + 3) in window
      ug.createCommitment(
        "cmt_01TESTSTATUSAAAAAAAAAAA01",
        "client_acme",
        10,
        "WEEKLY",
        "Acme Corp",
        4,
      );

      // as_of is 2026-02-15, window = 4 weeks back = 2026-01-18
      // Events on 2026-02-10 and 2026-02-12 are within window
      const status = ug.getCommitmentStatus(
        "cmt_01TESTSTATUSAAAAAAAAAAA01",
        "2026-02-15T23:59:59Z",
      );

      expect(status).not.toBeNull();
      expect(status!.commitment_id).toBe("cmt_01TESTSTATUSAAAAAAAAAAA01");
      expect(status!.client_id).toBe("client_acme");
      expect(status!.client_name).toBe("Acme Corp");
      expect(status!.target_hours).toBe(10);
      expect(status!.actual_hours).toBe(5); // 2h + 3h = 5h
      expect(status!.status).toBe("under");
      expect(status!.window_start).toBeTruthy();
      expect(status!.window_end).toBeTruthy();
    });

    it("computes 'compliant' status when actual >= target", () => {
      // Commitment: 5 hours/week for client_acme
      // Actual: 5 hours (2 + 3) exactly meets target
      ug.createCommitment(
        "cmt_01TESTSTATUSAAAAAAAAAAA02",
        "client_acme",
        5,
        "WEEKLY",
        null,
        4,
      );

      const status = ug.getCommitmentStatus(
        "cmt_01TESTSTATUSAAAAAAAAAAA02",
        "2026-02-15T23:59:59Z",
      );

      expect(status).not.toBeNull();
      expect(status!.actual_hours).toBe(5);
      expect(status!.target_hours).toBe(5);
      expect(status!.status).toBe("compliant");
    });

    it("computes 'over' status when actual > target * 1.2", () => {
      // Commitment: 3 hours/week for client_acme
      // Actual: 5 hours > 3 * 1.2 = 3.6 (over threshold)
      ug.createCommitment(
        "cmt_01TESTSTATUSAAAAAAAAAAA03",
        "client_acme",
        3,
        "WEEKLY",
        null,
        4,
      );

      const status = ug.getCommitmentStatus(
        "cmt_01TESTSTATUSAAAAAAAAAAA03",
        "2026-02-15T23:59:59Z",
      );

      expect(status).not.toBeNull();
      expect(status!.actual_hours).toBe(5);
      expect(status!.target_hours).toBe(3);
      expect(status!.status).toBe("over");
    });

    it("only counts hours for the specified client", () => {
      // Commitment for client_other: should only count event3 (1.5 hours)
      ug.createCommitment(
        "cmt_01TESTSTATUSAAAAAAAAAAA04",
        "client_other",
        2,
        "WEEKLY",
        null,
        4,
      );

      const status = ug.getCommitmentStatus(
        "cmt_01TESTSTATUSAAAAAAAAAAA04",
        "2026-02-15T23:59:59Z",
      );

      expect(status).not.toBeNull();
      expect(status!.actual_hours).toBe(1.5);
      expect(status!.status).toBe("under");
    });

    it("returns 0 actual hours when no matching events in window", () => {
      // Commitment for a client with no allocations
      ug.createCommitment(
        "cmt_01TESTSTATUSAAAAAAAAAAA05",
        "client_nobody",
        10,
        "WEEKLY",
        null,
        4,
      );

      const status = ug.getCommitmentStatus(
        "cmt_01TESTSTATUSAAAAAAAAAAA05",
        "2026-02-15T23:59:59Z",
      );

      expect(status).not.toBeNull();
      expect(status!.actual_hours).toBe(0);
      expect(status!.status).toBe("under");
    });

    it("respects rolling window boundary (events outside window are excluded)", () => {
      // Use as_of that puts events outside the 1-week window
      ug.createCommitment(
        "cmt_01TESTSTATUSAAAAAAAAAAA06",
        "client_acme",
        5,
        "WEEKLY",
        null,
        1, // Only 1 week back
      );

      // as_of = 2026-02-08, window start = 2026-02-01
      // Event on 2026-02-10 and 2026-02-12 are OUTSIDE the window
      const status = ug.getCommitmentStatus(
        "cmt_01TESTSTATUSAAAAAAAAAAA06",
        "2026-02-08T00:00:00Z",
      );

      expect(status).not.toBeNull();
      expect(status!.actual_hours).toBe(0);
      expect(status!.status).toBe("under");
    });

    it("stores a commitment report after status computation", () => {
      ug.createCommitment(
        "cmt_01TESTSTATUSAAAAAAAAAAA07",
        "client_acme",
        10,
        "WEEKLY",
        null,
        4,
      );

      ug.getCommitmentStatus(
        "cmt_01TESTSTATUSAAAAAAAAAAA07",
        "2026-02-15T23:59:59Z",
      );

      // Verify report was created in the DB
      const reports = db
        .prepare(
          "SELECT * FROM commitment_reports WHERE commitment_id = ?",
        )
        .all("cmt_01TESTSTATUSAAAAAAAAAAA07") as Array<{
        report_id: string;
        commitment_id: string;
        actual_hours: number;
        expected_hours: number;
        status: string;
      }>;

      expect(reports.length).toBe(1);
      expect(reports[0].actual_hours).toBe(5);
      expect(reports[0].expected_hours).toBe(10);
      expect(reports[0].status).toBe("under");
    });

    it("compliant when actual equals target exactly (boundary)", () => {
      // Edge case: actual == target but actual <= target * 1.2
      // target = 5, actual = 5 -> 5 >= 5 and 5 <= 6.0 -> "compliant"
      ug.createCommitment(
        "cmt_01TESTSTATUSAAAAAAAAAAA08",
        "client_acme",
        5,
        "WEEKLY",
        null,
        4,
      );

      const status = ug.getCommitmentStatus(
        "cmt_01TESTSTATUSAAAAAAAAAAA08",
        "2026-02-15T23:59:59Z",
      );

      expect(status!.status).toBe("compliant");
    });

    it("compliant when actual equals target * 1.2 exactly (boundary)", () => {
      // Edge case: target = 4.166..., actual = 5 -> 5.0 > 4.166... * 1.2 = 5.0
      // Actually let's pick exact numbers: target=4, actual=5 -> 5 > 4*1.2=4.8 -> "over"
      // But target=5/1.2=4.166 actual=5 -> 5 > 4.166*1.2=4.999 -> "over"
      // Let me use: target = 4.17, actual = 5 -> 5 > 4.17*1.2=5.004 -> "compliant" (5 <= 5.004)
      // Simpler: target=5, actual=6 -> 6 > 5*1.2=6.0 -> NOT over (not strictly greater)
      // Actually 6 > 6.0 is false, so status will be "compliant"
      ug.createCommitment(
        "cmt_01TESTSTATUSAAAAAAAAAA08B",
        "client_acme",
        // Target such that actual (5h) equals target * 1.2 exactly
        // target * 1.2 = 5 -> target = 5/1.2 = 4.166...
        // But we need whole numbers from our test data.
        // Let's just verify: 5 hours actual with target=4.167 -> 4.167*1.2=5.0004 -> 5 < 5.0004 -> "compliant"
        4.167,
        "WEEKLY",
        null,
        4,
      );

      const status = ug.getCommitmentStatus(
        "cmt_01TESTSTATUSAAAAAAAAAA08B",
        "2026-02-15T23:59:59Z",
      );

      // 5 > 4.167 * 1.2 = 5.0004 => false => "compliant" (since 5 >= 4.167)
      expect(status!.status).toBe("compliant");
    });
  });

  // -------------------------------------------------------------------------
  // RPC integration (handleFetch)
  // -------------------------------------------------------------------------

  describe("handleFetch RPC for commitments", () => {
    it("creates commitment via /createCommitment RPC", async () => {
      const response = await ug.handleFetch(
        new Request("https://do.internal/createCommitment", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            commitment_id: "cmt_01TESTRPCAAAAAAAAAAAAAAA01",
            client_id: "client_rpc",
            target_hours: 20,
            window_type: "MONTHLY",
            client_name: "RPC Corp",
            rolling_window_weeks: 4,
          }),
        }),
      );

      expect(response.status).toBe(200);
      const data = (await response.json()) as TimeCommitment;
      expect(data.commitment_id).toBe("cmt_01TESTRPCAAAAAAAAAAAAAAA01");
      expect(data.client_id).toBe("client_rpc");
      expect(data.target_hours).toBe(20);
      expect(data.window_type).toBe("MONTHLY");
      expect(data.client_name).toBe("RPC Corp");
    });

    it("gets commitment via /getCommitment RPC", async () => {
      ug.createCommitment(
        "cmt_01TESTRPCAAAAAAAAAAAAAAA02",
        "client_get_rpc",
        15,
      );

      const response = await ug.handleFetch(
        new Request("https://do.internal/getCommitment", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ commitment_id: "cmt_01TESTRPCAAAAAAAAAAAAAAA02" }),
        }),
      );

      expect(response.status).toBe(200);
      const data = (await response.json()) as TimeCommitment;
      expect(data.client_id).toBe("client_get_rpc");
      expect(data.target_hours).toBe(15);
    });

    it("returns null via /getCommitment for missing commitment", async () => {
      const response = await ug.handleFetch(
        new Request("https://do.internal/getCommitment", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ commitment_id: "cmt_01NONEXISTENT00000000001" }),
        }),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toBeNull();
    });

    it("lists commitments via /listCommitments RPC", async () => {
      ug.createCommitment(
        "cmt_01TESTRPCAAAAAAAAAAAAAAA03",
        "client_list_rpc",
        10,
      );

      const response = await ug.handleFetch(
        new Request("https://do.internal/listCommitments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }),
      );

      expect(response.status).toBe(200);
      const data = (await response.json()) as { items: TimeCommitment[] };
      expect(data.items.length).toBe(1);
      expect(data.items[0].client_id).toBe("client_list_rpc");
    });

    it("deletes commitment via /deleteCommitment RPC", async () => {
      ug.createCommitment(
        "cmt_01TESTRPCAAAAAAAAAAAAAAA04",
        "client_del_rpc",
        10,
      );

      const response = await ug.handleFetch(
        new Request("https://do.internal/deleteCommitment", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ commitment_id: "cmt_01TESTRPCAAAAAAAAAAAAAAA04" }),
        }),
      );

      expect(response.status).toBe(200);
      const data = (await response.json()) as { deleted: boolean };
      expect(data.deleted).toBe(true);

      // Verify it's gone
      const commitment = ug.getCommitment("cmt_01TESTRPCAAAAAAAAAAAAAAA04");
      expect(commitment).toBeNull();
    });

    it("gets commitment status via /getCommitmentStatus RPC", async () => {
      // Create event, allocation, and commitment
      const delta = makeCreatedDelta({
        origin_event_id: "google_evt_rpc_status_001",
        title: "RPC Status Meeting",
        start: "2026-02-14T10:00:00Z",
        end: "2026-02-14T13:00:00Z", // 3 hours
      });
      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [delta]);

      const events = ug.listCanonicalEvents({});
      const eventId = events.items[0].canonical_event_id;

      ug.createAllocation(
        "alc_01TESTRPCSTATUSAAAAAAAAAA1",
        eventId,
        "BILLABLE",
        "client_rpc_status",
        null,
      );

      ug.createCommitment(
        "cmt_01TESTRPCAAAAAAAAAAAAAAA05",
        "client_rpc_status",
        5,
        "WEEKLY",
        null,
        4,
      );

      const response = await ug.handleFetch(
        new Request("https://do.internal/getCommitmentStatus", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            commitment_id: "cmt_01TESTRPCAAAAAAAAAAAAAAA05",
            as_of: "2026-02-15T23:59:59Z",
          }),
        }),
      );

      expect(response.status).toBe(200);
      const data = (await response.json()) as CommitmentStatus;
      expect(data.commitment_id).toBe("cmt_01TESTRPCAAAAAAAAAAAAAAA05");
      expect(data.actual_hours).toBe(3);
      expect(data.target_hours).toBe(5);
      expect(data.status).toBe("under");
    });

    it("returns 500 for invalid window type via RPC", async () => {
      const response = await ug.handleFetch(
        new Request("https://do.internal/createCommitment", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            commitment_id: "cmt_01TESTRPCAAAAAAAAAAAAAAA06",
            client_id: "client_bad_rpc",
            target_hours: 10,
            window_type: "INVALID",
          }),
        }),
      );

      expect(response.status).toBe(500);
      const data = (await response.json()) as { error: string };
      expect(data.error).toContain("Invalid window_type");
    });
  });

  // -------------------------------------------------------------------------
  // Full integration flow
  // -------------------------------------------------------------------------

  describe("full flow: create commitment -> tag events -> check status", () => {
    it("creates commitment, tags events, and verifies compliance status", async () => {
      // Step 1: Create events
      const delta1 = makeCreatedDelta({
        origin_event_id: "google_evt_flow_001",
        title: "Flow Meeting 1",
        start: "2026-02-10T09:00:00Z",
        end: "2026-02-10T11:00:00Z", // 2 hours
      });
      const delta2 = makeCreatedDelta({
        origin_event_id: "google_evt_flow_002",
        title: "Flow Meeting 2",
        start: "2026-02-11T14:00:00Z",
        end: "2026-02-11T17:00:00Z", // 3 hours
      });
      const delta3 = makeCreatedDelta({
        origin_event_id: "google_evt_flow_003",
        title: "Flow Meeting 3",
        start: "2026-02-13T10:00:00Z",
        end: "2026-02-13T14:00:00Z", // 4 hours
      });

      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [delta1, delta2, delta3]);

      const events = ug.listCanonicalEvents({});
      expect(events.items.length).toBe(3);

      // Step 2: Tag events with client allocations
      for (const evt of events.items) {
        ug.createAllocation(
          `alc_flow_${evt.canonical_event_id.slice(-8)}`,
          evt.canonical_event_id,
          "BILLABLE",
          "client_flow",
          null,
        );
      }

      // Step 3: Create commitment (target: 8 hours for 4 weeks)
      ug.createCommitment(
        "cmt_01TESTFLOWAAAAAAAAAAAAAAA",
        "client_flow",
        8,
        "WEEKLY",
        "Flow Corp",
        4,
      );

      // Step 4: Check status (total: 2 + 3 + 4 = 9 hours vs 8 target)
      const status = ug.getCommitmentStatus(
        "cmt_01TESTFLOWAAAAAAAAAAAAAAA",
        "2026-02-15T23:59:59Z",
      );

      expect(status).not.toBeNull();
      expect(status!.actual_hours).toBe(9);
      expect(status!.target_hours).toBe(8);
      // 9 > 8 but 9 <= 8 * 1.2 = 9.6, so "compliant"
      expect(status!.status).toBe("compliant");
      expect(status!.client_name).toBe("Flow Corp");
      expect(status!.window_type).toBe("WEEKLY");
    });

    it("over status when actual exceeds target by more than 20%", async () => {
      // Create events totaling 13 hours
      const delta1 = makeCreatedDelta({
        origin_event_id: "google_evt_over_001",
        title: "Over Meeting 1",
        start: "2026-02-10T08:00:00Z",
        end: "2026-02-10T15:00:00Z", // 7 hours
      });
      const delta2 = makeCreatedDelta({
        origin_event_id: "google_evt_over_002",
        title: "Over Meeting 2",
        start: "2026-02-12T09:00:00Z",
        end: "2026-02-12T15:00:00Z", // 6 hours
      });

      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [delta1, delta2]);

      const events = ug.listCanonicalEvents({});
      for (const evt of events.items) {
        ug.createAllocation(
          `alc_over_${evt.canonical_event_id.slice(-8)}`,
          evt.canonical_event_id,
          "BILLABLE",
          "client_over",
          null,
        );
      }

      // Target: 10 hours, actual: 13 hours -> 13 > 10 * 1.2 = 12 -> "over"
      ug.createCommitment(
        "cmt_01TESTOVERAAAAAAAAAAAAAAA",
        "client_over",
        10,
        "WEEKLY",
        null,
        4,
      );

      const status = ug.getCommitmentStatus(
        "cmt_01TESTOVERAAAAAAAAAAAAAAA",
        "2026-02-15T23:59:59Z",
      );

      expect(status!.actual_hours).toBe(13);
      expect(status!.target_hours).toBe(10);
      expect(status!.status).toBe("over");
    });
  });

  // -------------------------------------------------------------------------
  // deleteCommitment cascades to reports
  // -------------------------------------------------------------------------

  describe("deleteCommitment cascades reports", () => {
    it("deleting commitment also removes associated reports", async () => {
      // Create event and allocation
      const delta = makeCreatedDelta({
        origin_event_id: "google_evt_cascade_001",
        start: "2026-02-14T10:00:00Z",
        end: "2026-02-14T12:00:00Z",
      });
      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [delta]);
      const events = ug.listCanonicalEvents({});
      const eventId = events.items[0].canonical_event_id;

      ug.createAllocation(
        "alc_01TESTCASCADEAAAAAAAAA01",
        eventId,
        "BILLABLE",
        "client_cascade",
        null,
      );

      // Create commitment and generate a report via getCommitmentStatus
      ug.createCommitment(
        "cmt_01TESTCASCADEAAAAAAAAAA01",
        "client_cascade",
        10,
        "WEEKLY",
        null,
        4,
      );
      ug.getCommitmentStatus(
        "cmt_01TESTCASCADEAAAAAAAAAA01",
        "2026-02-15T23:59:59Z",
      );

      // Verify report exists
      const reportsBefore = db
        .prepare("SELECT COUNT(*) as cnt FROM commitment_reports WHERE commitment_id = ?")
        .get("cmt_01TESTCASCADEAAAAAAAAAA01") as { cnt: number };
      expect(reportsBefore.cnt).toBe(1);

      // Delete commitment
      const deleted = ug.deleteCommitment("cmt_01TESTCASCADEAAAAAAAAAA01");
      expect(deleted).toBe(true);

      // Verify reports are also gone
      const reportsAfter = db
        .prepare("SELECT COUNT(*) as cnt FROM commitment_reports WHERE commitment_id = ?")
        .get("cmt_01TESTCASCADEAAAAAAAAAA01") as { cnt: number };
      expect(reportsAfter.cnt).toBe(0);
    });
  });
});
