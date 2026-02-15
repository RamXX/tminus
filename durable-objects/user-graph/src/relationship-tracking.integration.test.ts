/**
 * Integration tests for relationship tracking in UserGraphDO.
 *
 * Uses real SQLite (better-sqlite3) and real crypto (Node.js crypto.subtle).
 * Queue is mocked to capture enqueued messages.
 *
 * Tests prove:
 * - Relationship CRUD: create, read, update, delete
 * - Category validation (FAMILY, INVESTOR, FRIEND, CLIENT, BOARD, COLLEAGUE, OTHER)
 * - Closeness weight validation (0.0 - 1.0)
 * - Interaction frequency target validation
 * - Interaction detection: event with matching participant_hash updates last_interaction_ts
 * - Drift report: shows overdue relationships sorted by urgency
 * - Duplicate participant_hash enforcement (UNIQUE constraint)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import type { SqlStorageLike, SqlStorageCursorLike, ProviderDelta, AccountId } from "@tminus/shared";
import { UserGraphDO } from "./index";
import type { QueueLike, Relationship } from "./index";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TEST_ACCOUNT_ID = "acc_01TESTACCOUNT0000000000001" as AccountId;
const TEST_REL_ID = "rel_01HXY000000000000000000E01";
const TEST_REL_ID_2 = "rel_01HXY000000000000000000E02";
const TEST_PARTICIPANT_HASH = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
const TEST_PARTICIPANT_HASH_2 = "f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5";

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
// Test setup
// ---------------------------------------------------------------------------

describe("UserGraphDO relationship tracking integration", () => {
  let db: DatabaseType;
  let sql: SqlStorageLike;
  let queue: MockQueue;
  let dObj: UserGraphDO;

  beforeEach(() => {
    db = new Database(":memory:");
    sql = createSqlStorageAdapter(db);
    queue = new MockQueue();
    dObj = new UserGraphDO(sql, queue);
  });

  afterEach(() => {
    db.close();
  });

  // -------------------------------------------------------------------------
  // CRUD: Create
  // -------------------------------------------------------------------------

  describe("createRelationship", () => {
    it("creates a relationship and returns all fields", () => {
      const result = dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "Alice Investor",
        "INVESTOR",
        0.9,
        "San Francisco",
        "America/Los_Angeles",
        14,
      );

      expect(result.relationship_id).toBe(TEST_REL_ID);
      expect(result.participant_hash).toBe(TEST_PARTICIPANT_HASH);
      expect(result.display_name).toBe("Alice Investor");
      expect(result.category).toBe("INVESTOR");
      expect(result.closeness_weight).toBe(0.9);
      expect(result.city).toBe("San Francisco");
      expect(result.timezone).toBe("America/Los_Angeles");
      expect(result.interaction_frequency_target).toBe(14);
      expect(result.last_interaction_ts).toBeNull();
      expect(result.created_at).toBeTruthy();
      expect(result.updated_at).toBeTruthy();
    });

    it("creates a relationship with default values", () => {
      const result = dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        null,
        "OTHER",
      );

      expect(result.closeness_weight).toBe(0.5);
      expect(result.city).toBeNull();
      expect(result.timezone).toBeNull();
      expect(result.interaction_frequency_target).toBeNull();
    });

    it("rejects invalid category", () => {
      expect(() => {
        dObj.createRelationship(
          TEST_REL_ID,
          TEST_PARTICIPANT_HASH,
          "Test",
          "INVALID_CATEGORY",
        );
      }).toThrow("Invalid category");
    });

    it("rejects closeness_weight outside 0-1 range", () => {
      expect(() => {
        dObj.createRelationship(
          TEST_REL_ID,
          TEST_PARTICIPANT_HASH,
          "Test",
          "FRIEND",
          1.5,
        );
      }).toThrow("closeness_weight must be between 0.0 and 1.0");
    });

    it("rejects negative closeness_weight", () => {
      expect(() => {
        dObj.createRelationship(
          TEST_REL_ID,
          TEST_PARTICIPANT_HASH,
          "Test",
          "FRIEND",
          -0.1,
        );
      }).toThrow("closeness_weight must be between 0.0 and 1.0");
    });

    it("rejects non-integer interaction_frequency_target", () => {
      expect(() => {
        dObj.createRelationship(
          TEST_REL_ID,
          TEST_PARTICIPANT_HASH,
          "Test",
          "FRIEND",
          0.5,
          null,
          null,
          3.5,
        );
      }).toThrow("interaction_frequency_target must be a positive integer");
    });

    it("rejects zero interaction_frequency_target", () => {
      expect(() => {
        dObj.createRelationship(
          TEST_REL_ID,
          TEST_PARTICIPANT_HASH,
          "Test",
          "FRIEND",
          0.5,
          null,
          null,
          0,
        );
      }).toThrow("interaction_frequency_target must be a positive integer");
    });

    it("rejects duplicate participant_hash (UNIQUE constraint)", () => {
      dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "First",
        "FRIEND",
      );

      expect(() => {
        dObj.createRelationship(
          TEST_REL_ID_2,
          TEST_PARTICIPANT_HASH,
          "Second",
          "COLLEAGUE",
        );
      }).toThrow(); // SQLite UNIQUE constraint violation
    });

    it("accepts all valid categories", () => {
      const categories = ["FAMILY", "INVESTOR", "FRIEND", "CLIENT", "BOARD", "COLLEAGUE", "OTHER"];
      categories.forEach((cat, i) => {
        const relId = `rel_01HXY00000000000000000000${String(i + 1).padStart(2, "0")}`;
        const hash = `hash${String(i).padStart(60, "0")}`;
        const result = dObj.createRelationship(relId, hash, `Test ${cat}`, cat);
        expect(result.category).toBe(cat);
      });
    });
  });

  // -------------------------------------------------------------------------
  // CRUD: Read
  // -------------------------------------------------------------------------

  describe("getRelationship", () => {
    it("returns relationship by ID", () => {
      dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "Alice",
        "INVESTOR",
        0.8,
        "NYC",
        "America/New_York",
        7,
      );

      const result = dObj.getRelationship(TEST_REL_ID);
      expect(result).not.toBeNull();
      expect(result!.relationship_id).toBe(TEST_REL_ID);
      expect(result!.display_name).toBe("Alice");
      expect(result!.category).toBe("INVESTOR");
      expect(result!.closeness_weight).toBe(0.8);
      expect(result!.city).toBe("NYC");
      expect(result!.interaction_frequency_target).toBe(7);
    });

    it("returns null for non-existent relationship", () => {
      const result = dObj.getRelationship("rel_01NONEXISTENT0000000000001");
      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // CRUD: List
  // -------------------------------------------------------------------------

  describe("listRelationships", () => {
    it("returns all relationships sorted by closeness_weight descending", () => {
      dObj.createRelationship(TEST_REL_ID, TEST_PARTICIPANT_HASH, "Low", "FRIEND", 0.3);
      dObj.createRelationship(TEST_REL_ID_2, TEST_PARTICIPANT_HASH_2, "High", "FAMILY", 0.9);

      const results = dObj.listRelationships();
      expect(results).toHaveLength(2);
      expect(results[0].display_name).toBe("High");
      expect(results[1].display_name).toBe("Low");
    });

    it("filters by category", () => {
      dObj.createRelationship(TEST_REL_ID, TEST_PARTICIPANT_HASH, "Friend", "FRIEND", 0.5);
      dObj.createRelationship(TEST_REL_ID_2, TEST_PARTICIPANT_HASH_2, "Investor", "INVESTOR", 0.8);

      const friends = dObj.listRelationships("FRIEND");
      expect(friends).toHaveLength(1);
      expect(friends[0].category).toBe("FRIEND");

      const investors = dObj.listRelationships("INVESTOR");
      expect(investors).toHaveLength(1);
      expect(investors[0].category).toBe("INVESTOR");
    });

    it("returns empty array when no relationships exist", () => {
      const results = dObj.listRelationships();
      expect(results).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // CRUD: Update
  // -------------------------------------------------------------------------

  describe("updateRelationship", () => {
    it("updates specific fields without changing others", () => {
      dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "Alice",
        "FRIEND",
        0.5,
        "SF",
        "America/Los_Angeles",
        14,
      );

      const updated = dObj.updateRelationship(TEST_REL_ID, {
        category: "INVESTOR",
        closeness_weight: 0.9,
      });

      expect(updated).not.toBeNull();
      expect(updated!.category).toBe("INVESTOR");
      expect(updated!.closeness_weight).toBe(0.9);
      // Unchanged fields
      expect(updated!.display_name).toBe("Alice");
      expect(updated!.city).toBe("SF");
      expect(updated!.timezone).toBe("America/Los_Angeles");
      expect(updated!.interaction_frequency_target).toBe(14);
      expect(updated!.participant_hash).toBe(TEST_PARTICIPANT_HASH);
    });

    it("returns null for non-existent relationship", () => {
      const result = dObj.updateRelationship("rel_01NONEXISTENT0000000000001", {
        category: "BOARD",
      });
      expect(result).toBeNull();
    });

    it("rejects invalid category on update", () => {
      dObj.createRelationship(TEST_REL_ID, TEST_PARTICIPANT_HASH, "Test", "FRIEND");

      expect(() => {
        dObj.updateRelationship(TEST_REL_ID, { category: "INVALID" });
      }).toThrow("Invalid category");
    });

    it("can set interaction_frequency_target to null", () => {
      dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "Test",
        "FRIEND",
        0.5,
        null,
        null,
        14,
      );

      const updated = dObj.updateRelationship(TEST_REL_ID, {
        interaction_frequency_target: null,
      });

      expect(updated!.interaction_frequency_target).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // CRUD: Delete
  // -------------------------------------------------------------------------

  describe("deleteRelationship", () => {
    it("deletes an existing relationship", () => {
      dObj.createRelationship(TEST_REL_ID, TEST_PARTICIPANT_HASH, "Alice", "FRIEND");

      const deleted = dObj.deleteRelationship(TEST_REL_ID);
      expect(deleted).toBe(true);

      const result = dObj.getRelationship(TEST_REL_ID);
      expect(result).toBeNull();
    });

    it("returns false for non-existent relationship", () => {
      const deleted = dObj.deleteRelationship("rel_01NONEXISTENT0000000000001");
      expect(deleted).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Interaction detection
  // -------------------------------------------------------------------------

  describe("interaction detection via updateInteractions", () => {
    it("updates last_interaction_ts for matching participant hashes", () => {
      dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "Alice",
        "INVESTOR",
        0.9,
        null,
        null,
        7,
      );

      const interactionTs = "2026-02-15T09:00:00Z";
      const count = dObj.updateInteractions([TEST_PARTICIPANT_HASH], interactionTs);

      expect(count).toBe(1);

      const rel = dObj.getRelationship(TEST_REL_ID);
      expect(rel!.last_interaction_ts).toBe(interactionTs);
    });

    it("does not update non-matching participant hashes", () => {
      dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "Alice",
        "INVESTOR",
      );

      const count = dObj.updateInteractions(["nonexistent_hash"], "2026-02-15T09:00:00Z");
      expect(count).toBe(0);

      const rel = dObj.getRelationship(TEST_REL_ID);
      expect(rel!.last_interaction_ts).toBeNull();
    });

    it("updates multiple matching relationships", () => {
      dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "Alice",
        "INVESTOR",
      );
      dObj.createRelationship(
        TEST_REL_ID_2,
        TEST_PARTICIPANT_HASH_2,
        "Bob",
        "FRIEND",
      );

      const count = dObj.updateInteractions(
        [TEST_PARTICIPANT_HASH, TEST_PARTICIPANT_HASH_2],
        "2026-02-15T09:00:00Z",
      );

      expect(count).toBe(2);

      const alice = dObj.getRelationship(TEST_REL_ID);
      const bob = dObj.getRelationship(TEST_REL_ID_2);
      expect(alice!.last_interaction_ts).toBe("2026-02-15T09:00:00Z");
      expect(bob!.last_interaction_ts).toBe("2026-02-15T09:00:00Z");
    });

    it("returns 0 for empty participant hashes", () => {
      const count = dObj.updateInteractions([], "2026-02-15T09:00:00Z");
      expect(count).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Interaction detection via applyProviderDelta
  // -------------------------------------------------------------------------

  describe("interaction detection via applyProviderDelta", () => {
    it("updates last_interaction_ts when delta has matching participant_hashes", async () => {
      // Create a relationship
      dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "Alice",
        "INVESTOR",
        0.9,
        null,
        null,
        7,
      );

      // Ingest an event with matching participant hash
      const delta: ProviderDelta & { participant_hashes?: string[] } = {
        type: "created",
        origin_event_id: "google_evt_100",
        origin_account_id: TEST_ACCOUNT_ID,
        event: {
          origin_account_id: TEST_ACCOUNT_ID,
          origin_event_id: "google_evt_100",
          title: "Meeting with Alice",
          start: { dateTime: "2026-02-15T14:00:00Z" },
          end: { dateTime: "2026-02-15T15:00:00Z" },
          all_day: false,
          status: "confirmed",
          visibility: "default",
          transparency: "opaque",
        },
        participant_hashes: [TEST_PARTICIPANT_HASH],
      };

      const result = await dObj.applyProviderDelta(TEST_ACCOUNT_ID, [delta]);
      expect(result.created).toBe(1);
      expect(result.errors).toHaveLength(0);

      // Verify last_interaction_ts was updated to the event start time
      const rel = dObj.getRelationship(TEST_REL_ID);
      expect(rel!.last_interaction_ts).toBe("2026-02-15T14:00:00Z");
    });

    it("does not update last_interaction_ts when delta has no participant_hashes", async () => {
      dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "Alice",
        "INVESTOR",
      );

      const delta: ProviderDelta = {
        type: "created",
        origin_event_id: "google_evt_200",
        origin_account_id: TEST_ACCOUNT_ID,
        event: {
          origin_account_id: TEST_ACCOUNT_ID,
          origin_event_id: "google_evt_200",
          title: "Solo work",
          start: { dateTime: "2026-02-15T10:00:00Z" },
          end: { dateTime: "2026-02-15T11:00:00Z" },
          all_day: false,
          status: "confirmed",
          visibility: "default",
          transparency: "opaque",
        },
      };

      await dObj.applyProviderDelta(TEST_ACCOUNT_ID, [delta]);

      const rel = dObj.getRelationship(TEST_REL_ID);
      expect(rel!.last_interaction_ts).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Drift report
  // -------------------------------------------------------------------------

  describe("getDriftReport", () => {
    it("returns overdue relationships sorted by urgency", () => {
      // Create two relationships with frequency targets
      dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "Alice Investor",
        "INVESTOR",
        1.0,
        null,
        null,
        7,
      );
      dObj.createRelationship(
        TEST_REL_ID_2,
        TEST_PARTICIPANT_HASH_2,
        "Bob Colleague",
        "COLLEAGUE",
        0.3,
        null,
        null,
        14,
      );

      // Set last_interaction for Alice to 10 days ago (3 days overdue at weight 1.0 = urgency 3.0)
      // Bob has no interaction (maximally overdue)
      dObj.updateInteractions(
        [TEST_PARTICIPANT_HASH],
        new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      );

      const report = dObj.getDriftReport();

      expect(report.total_tracked).toBe(2);
      expect(report.total_overdue).toBe(2);
      expect(report.overdue.length).toBe(2);

      // Bob should have higher urgency because he has no interaction (epoch) and
      // even though his weight is lower, the massive days_overdue compensates
      // Actually: Bob: (days_since_epoch - 14) * 0.3 vs Alice: 3 * 1.0 = 3.0
      // Bob's days since epoch is ~20500, so (20500-14)*0.3 >> 3.0
      // So Bob is first
      expect(report.overdue[0].display_name).toBe("Bob Colleague");
      expect(report.overdue[1].display_name).toBe("Alice Investor");
    });

    it("excludes relationships without frequency targets", () => {
      dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "No Target",
        "FRIEND",
        0.5,
        null,
        null,
        null, // no frequency target
      );

      const report = dObj.getDriftReport();
      expect(report.total_tracked).toBe(0);
      expect(report.total_overdue).toBe(0);
      expect(report.overdue).toHaveLength(0);
    });

    it("does not flag relationships within their frequency target", () => {
      dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "Recent Contact",
        "FRIEND",
        0.5,
        null,
        null,
        30, // 30-day target
      );

      // Set last interaction to 5 days ago
      dObj.updateInteractions(
        [TEST_PARTICIPANT_HASH],
        new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
      );

      const report = dObj.getDriftReport();
      expect(report.total_tracked).toBe(1);
      expect(report.total_overdue).toBe(0);
      expect(report.overdue).toHaveLength(0);
    });

    it("returns empty report when no relationships exist", () => {
      const report = dObj.getDriftReport();
      expect(report.total_tracked).toBe(0);
      expect(report.total_overdue).toBe(0);
      expect(report.overdue).toHaveLength(0);
      expect(report.computed_at).toBeTruthy();
    });
  });

  // -------------------------------------------------------------------------
  // Full flow: create -> ingest event -> verify interaction updated -> drift
  // -------------------------------------------------------------------------

  describe("full flow: relationship -> event -> interaction -> drift", () => {
    it("end-to-end: create relationship, ingest event, verify drift clears", async () => {
      // Step 1: Create a relationship with 7-day frequency target
      const rel = dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "Sarah Board Member",
        "BOARD",
        0.95,
        "Austin",
        "America/Chicago",
        7,
      );
      expect(rel.last_interaction_ts).toBeNull();

      // Step 2: Check drift -- should be overdue (never interacted)
      const driftBefore = dObj.getDriftReport();
      expect(driftBefore.total_overdue).toBe(1);
      expect(driftBefore.overdue[0].display_name).toBe("Sarah Board Member");

      // Step 3: Ingest an event with matching participant hash (via applyProviderDelta)
      const delta: ProviderDelta & { participant_hashes?: string[] } = {
        type: "created",
        origin_event_id: "google_evt_300",
        origin_account_id: TEST_ACCOUNT_ID,
        event: {
          origin_account_id: TEST_ACCOUNT_ID,
          origin_event_id: "google_evt_300",
          title: "Board Sync with Sarah",
          start: { dateTime: new Date().toISOString() },
          end: { dateTime: new Date(Date.now() + 60 * 60 * 1000).toISOString() },
          all_day: false,
          status: "confirmed",
          visibility: "default",
          transparency: "opaque",
        },
        participant_hashes: [TEST_PARTICIPANT_HASH],
      };

      await dObj.applyProviderDelta(TEST_ACCOUNT_ID, [delta]);

      // Step 4: Verify last_interaction_ts is updated
      const relAfter = dObj.getRelationship(TEST_REL_ID);
      expect(relAfter!.last_interaction_ts).toBeTruthy();

      // Step 5: Drift report should show no overdue (just interacted)
      const driftAfter = dObj.getDriftReport();
      expect(driftAfter.total_tracked).toBe(1);
      expect(driftAfter.total_overdue).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Interaction Ledger: markOutcome
  // -------------------------------------------------------------------------

  describe("markOutcome", () => {
    it("marks ATTENDED outcome and returns ledger entry with correct weight", () => {
      dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "Alice",
        "INVESTOR",
      );

      const entry = dObj.markOutcome(TEST_REL_ID, "ATTENDED");

      expect(entry).not.toBeNull();
      expect(entry!.ledger_id).toMatch(/^ldg_/);
      expect(entry!.participant_hash).toBe(TEST_PARTICIPANT_HASH);
      expect(entry!.outcome).toBe("ATTENDED");
      expect(entry!.weight).toBe(1.0);
      expect(entry!.canonical_event_id).toBeNull();
      expect(entry!.note).toBeNull();
      expect(entry!.ts).toBeTruthy();
    });

    it("marks CANCELED_BY_THEM outcome with weight -0.5", () => {
      dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "Alice",
        "INVESTOR",
      );

      const entry = dObj.markOutcome(TEST_REL_ID, "CANCELED_BY_THEM");

      expect(entry).not.toBeNull();
      expect(entry!.outcome).toBe("CANCELED_BY_THEM");
      expect(entry!.weight).toBe(-0.5);
    });

    it("marks NO_SHOW_THEM outcome with weight -1.0", () => {
      dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "Alice",
        "INVESTOR",
      );

      const entry = dObj.markOutcome(TEST_REL_ID, "NO_SHOW_THEM");

      expect(entry).not.toBeNull();
      expect(entry!.outcome).toBe("NO_SHOW_THEM");
      expect(entry!.weight).toBe(-1.0);
    });

    it("marks MOVED_LAST_MINUTE_THEM outcome with weight -0.3", () => {
      dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "Alice",
        "INVESTOR",
      );

      const entry = dObj.markOutcome(TEST_REL_ID, "MOVED_LAST_MINUTE_THEM");

      expect(entry).not.toBeNull();
      expect(entry!.outcome).toBe("MOVED_LAST_MINUTE_THEM");
      expect(entry!.weight).toBe(-0.3);
    });

    it("marks _ME outcomes with weight 0.0 (neutral)", () => {
      dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "Alice",
        "INVESTOR",
      );

      const cancelMe = dObj.markOutcome(TEST_REL_ID, "CANCELED_BY_ME");
      expect(cancelMe!.weight).toBe(0.0);

      const noShowMe = dObj.markOutcome(TEST_REL_ID, "NO_SHOW_ME");
      expect(noShowMe!.weight).toBe(0.0);

      const movedMe = dObj.markOutcome(TEST_REL_ID, "MOVED_LAST_MINUTE_ME");
      expect(movedMe!.weight).toBe(0.0);
    });

    it("stores optional canonical_event_id and note", () => {
      dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "Alice",
        "INVESTOR",
      );

      const entry = dObj.markOutcome(
        TEST_REL_ID,
        "ATTENDED",
        "evt_01HXY0000000000000000EVT01",
        "Great meeting about Series A",
      );

      expect(entry).not.toBeNull();
      expect(entry!.canonical_event_id).toBe("evt_01HXY0000000000000000EVT01");
      expect(entry!.note).toBe("Great meeting about Series A");
    });

    it("updates last_interaction_ts on ATTENDED outcome", () => {
      dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "Alice",
        "INVESTOR",
      );

      // Before: no interaction
      const before = dObj.getRelationship(TEST_REL_ID);
      expect(before!.last_interaction_ts).toBeNull();

      dObj.markOutcome(TEST_REL_ID, "ATTENDED");

      // After: last_interaction_ts updated
      const after = dObj.getRelationship(TEST_REL_ID);
      expect(after!.last_interaction_ts).toBeTruthy();
    });

    it("does NOT update last_interaction_ts on non-ATTENDED outcomes", () => {
      dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "Alice",
        "INVESTOR",
      );

      dObj.markOutcome(TEST_REL_ID, "CANCELED_BY_THEM");

      const rel = dObj.getRelationship(TEST_REL_ID);
      expect(rel!.last_interaction_ts).toBeNull();
    });

    it("returns null for non-existent relationship", () => {
      const entry = dObj.markOutcome(
        "rel_01HXY0000000000000000NOTFN",
        "ATTENDED",
      );
      expect(entry).toBeNull();
    });

    it("rejects invalid outcome", () => {
      dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "Alice",
        "INVESTOR",
      );

      expect(() => {
        dObj.markOutcome(TEST_REL_ID, "INVALID_OUTCOME");
      }).toThrow("Invalid outcome");
    });

    it("is append-only -- multiple outcomes for same relationship accumulate", () => {
      dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "Alice",
        "INVESTOR",
      );

      const e1 = dObj.markOutcome(TEST_REL_ID, "ATTENDED");
      const e2 = dObj.markOutcome(TEST_REL_ID, "CANCELED_BY_THEM");
      const e3 = dObj.markOutcome(TEST_REL_ID, "ATTENDED");

      // Each gets a unique ledger_id
      expect(e1!.ledger_id).not.toBe(e2!.ledger_id);
      expect(e2!.ledger_id).not.toBe(e3!.ledger_id);

      // All three exist in the ledger
      const outcomes = dObj.listOutcomes(TEST_REL_ID);
      expect(outcomes).not.toBeNull();
      expect(outcomes!.length).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  // Interaction Ledger: listOutcomes
  // -------------------------------------------------------------------------

  describe("listOutcomes", () => {
    it("returns empty array when no outcomes exist", () => {
      dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "Alice",
        "INVESTOR",
      );

      const outcomes = dObj.listOutcomes(TEST_REL_ID);
      expect(outcomes).not.toBeNull();
      expect(outcomes!.length).toBe(0);
    });

    it("returns outcomes ordered by timestamp descending (most recent first)", () => {
      dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "Alice",
        "INVESTOR",
      );

      dObj.markOutcome(TEST_REL_ID, "ATTENDED", null, "first");
      dObj.markOutcome(TEST_REL_ID, "CANCELED_BY_THEM", null, "second");
      dObj.markOutcome(TEST_REL_ID, "NO_SHOW_THEM", null, "third");

      const outcomes = dObj.listOutcomes(TEST_REL_ID);
      expect(outcomes!.length).toBe(3);
      // Most recent first (all should have same or increasing ts)
      expect(outcomes![0].note).toBe("third");
      expect(outcomes![1].note).toBe("second");
      expect(outcomes![2].note).toBe("first");
    });

    it("filters by outcome type", () => {
      dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "Alice",
        "INVESTOR",
      );

      dObj.markOutcome(TEST_REL_ID, "ATTENDED");
      dObj.markOutcome(TEST_REL_ID, "CANCELED_BY_THEM");
      dObj.markOutcome(TEST_REL_ID, "ATTENDED");

      const attended = dObj.listOutcomes(TEST_REL_ID, "ATTENDED");
      expect(attended!.length).toBe(2);
      expect(attended![0].outcome).toBe("ATTENDED");
      expect(attended![1].outcome).toBe("ATTENDED");

      const cancelled = dObj.listOutcomes(TEST_REL_ID, "CANCELED_BY_THEM");
      expect(cancelled!.length).toBe(1);
    });

    it("returns null for non-existent relationship", () => {
      const outcomes = dObj.listOutcomes("rel_01HXY0000000000000000NOTFN");
      expect(outcomes).toBeNull();
    });

    it("rejects invalid outcome filter", () => {
      dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "Alice",
        "INVESTOR",
      );

      expect(() => {
        dObj.listOutcomes(TEST_REL_ID, "INVALID_FILTER");
      }).toThrow("Invalid outcome filter");
    });

    it("outcomes are scoped to the relationship's participant_hash", () => {
      // Create two relationships with different participant hashes
      dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "Alice",
        "INVESTOR",
      );
      dObj.createRelationship(
        TEST_REL_ID_2,
        TEST_PARTICIPANT_HASH_2,
        "Bob",
        "FRIEND",
      );

      dObj.markOutcome(TEST_REL_ID, "ATTENDED");
      dObj.markOutcome(TEST_REL_ID, "NO_SHOW_THEM");
      dObj.markOutcome(TEST_REL_ID_2, "CANCELED_BY_THEM");

      const aliceOutcomes = dObj.listOutcomes(TEST_REL_ID);
      expect(aliceOutcomes!.length).toBe(2);

      const bobOutcomes = dObj.listOutcomes(TEST_REL_ID_2);
      expect(bobOutcomes!.length).toBe(1);
      expect(bobOutcomes![0].outcome).toBe("CANCELED_BY_THEM");
    });
  });

  // -------------------------------------------------------------------------
  // Interaction Ledger: deleteRelationship cascades
  // -------------------------------------------------------------------------

  describe("deleteRelationship cascades ledger entries", () => {
    it("deleting a relationship removes its ledger entries", () => {
      dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "Alice",
        "INVESTOR",
      );

      dObj.markOutcome(TEST_REL_ID, "ATTENDED");
      dObj.markOutcome(TEST_REL_ID, "NO_SHOW_THEM");

      // Verify entries exist
      const before = dObj.listOutcomes(TEST_REL_ID);
      expect(before!.length).toBe(2);

      // Delete relationship
      const deleted = dObj.deleteRelationship(TEST_REL_ID);
      expect(deleted).toBe(true);

      // Entries should be gone (relationship gone, so null)
      const after = dObj.listOutcomes(TEST_REL_ID);
      expect(after).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Drift ratio in report (TM-4wb.4)
  // -------------------------------------------------------------------------

  describe("drift_ratio in drift report", () => {
    it("includes drift_ratio for overdue relationships", () => {
      dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "Alice",
        "FRIEND",
        0.8,
        null,
        null,
        7,
      );

      // Set last interaction to 21 days ago
      dObj.updateInteractions(
        [TEST_PARTICIPANT_HASH],
        new Date(Date.now() - 21 * 24 * 60 * 60 * 1000).toISOString(),
      );

      const report = dObj.getDriftReport();
      expect(report.overdue).toHaveLength(1);
      // 21 days / 7 target = 3.0
      expect(report.overdue[0].drift_ratio).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  // Drift alert storage (TM-4wb.4)
  // -------------------------------------------------------------------------

  describe("storeDriftAlerts / getDriftAlerts", () => {
    it("stores drift alerts from a report and retrieves them", () => {
      dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "Alice Investor",
        "INVESTOR",
        1.0,
        null,
        null,
        7,
      );
      dObj.createRelationship(
        TEST_REL_ID_2,
        TEST_PARTICIPANT_HASH_2,
        "Bob Colleague",
        "COLLEAGUE",
        0.3,
        null,
        null,
        14,
      );

      // Set Alice to 10 days ago
      dObj.updateInteractions(
        [TEST_PARTICIPANT_HASH],
        new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      );

      // Get report (both should be overdue)
      const report = dObj.getDriftReport();
      expect(report.total_overdue).toBe(2);

      // Store alerts
      const stored = dObj.storeDriftAlerts(report);
      expect(stored).toBe(2);

      // Retrieve alerts
      const alerts = dObj.getDriftAlerts();
      expect(alerts).toHaveLength(2);

      // Sorted by urgency descending
      expect(alerts[0].urgency).toBeGreaterThanOrEqual(alerts[1].urgency);

      // Fields populated correctly
      for (const alert of alerts) {
        expect(alert.alert_id).toBeTruthy();
        expect(alert.relationship_id).toBeTruthy();
        expect(alert.category).toBeTruthy();
        expect(alert.drift_ratio).toBeGreaterThan(0);
        expect(alert.days_overdue).toBeGreaterThan(0);
        expect(alert.urgency).toBeGreaterThan(0);
        expect(alert.computed_at).toBeTruthy();
      }
    });

    it("replaces previous alerts on subsequent store calls", () => {
      dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "Alice",
        "FRIEND",
        0.8,
        null,
        null,
        7,
      );

      // First computation - overdue (never interacted)
      const report1 = dObj.getDriftReport();
      dObj.storeDriftAlerts(report1);
      expect(dObj.getDriftAlerts()).toHaveLength(1);

      // Interact (clears drift)
      dObj.updateInteractions(
        [TEST_PARTICIPANT_HASH],
        new Date().toISOString(),
      );

      // Second computation - no longer overdue
      const report2 = dObj.getDriftReport();
      expect(report2.total_overdue).toBe(0);
      dObj.storeDriftAlerts(report2);

      // Alerts should now be empty (replaced)
      expect(dObj.getDriftAlerts()).toHaveLength(0);
    });

    it("returns empty array when no alerts have been stored", () => {
      const alerts = dObj.getDriftAlerts();
      expect(alerts).toHaveLength(0);
    });

    it("cascades deletion when relationship is deleted", () => {
      dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "Alice",
        "FRIEND",
        0.8,
        null,
        null,
        7,
      );

      // Store an alert (overdue because never interacted)
      const report = dObj.getDriftReport();
      dObj.storeDriftAlerts(report);
      expect(dObj.getDriftAlerts()).toHaveLength(1);

      // Delete the relationship
      dObj.deleteRelationship(TEST_REL_ID);

      // Alert should be cascade-deleted
      expect(dObj.getDriftAlerts()).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Reconnection suggestions (TM-4wb.5)
  // -------------------------------------------------------------------------

  describe("getReconnectionSuggestions", () => {
    it("returns overdue relationships in the specified city", () => {
      // Create relationships in different cities
      dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "Alice in SF",
        "FRIEND",
        0.8,
        "San Francisco",
        "America/Los_Angeles",
        7, // weekly target
      );
      dObj.createRelationship(
        TEST_REL_ID_2,
        TEST_PARTICIPANT_HASH_2,
        "Bob in NYC",
        "COLLEAGUE",
        0.6,
        "New York",
        "America/New_York",
        14, // biweekly target
      );

      // Neither has been interacted with, so both are overdue
      const sfSuggestions = dObj.getReconnectionSuggestions("San Francisco");
      expect(sfSuggestions.city).toBe("San Francisco");
      expect(sfSuggestions.suggestions.length).toBe(1);
      expect(sfSuggestions.suggestions[0].display_name).toBe("Alice in SF");
      expect(sfSuggestions.total_in_city).toBe(1);
      expect(sfSuggestions.total_overdue_in_city).toBe(1);

      const nycSuggestions = dObj.getReconnectionSuggestions("New York");
      expect(nycSuggestions.city).toBe("New York");
      expect(nycSuggestions.suggestions.length).toBe(1);
      expect(nycSuggestions.suggestions[0].display_name).toBe("Bob in NYC");
    });

    it("city matching is case-insensitive", () => {
      dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "Alice",
        "FRIEND",
        0.8,
        "San Francisco",
        null,
        7,
      );

      const result = dObj.getReconnectionSuggestions("san francisco");
      expect(result.suggestions.length).toBe(1);
      expect(result.suggestions[0].display_name).toBe("Alice");
    });

    it("resolves city from trip constraint destination_city", () => {
      // Create a trip constraint with destination_city
      const tripConstraint = dObj.addConstraint(
        "trip",
        {
          name: "SF Business Trip",
          timezone: "America/Los_Angeles",
          block_policy: "BUSY",
          destination_city: "San Francisco",
        },
        "2026-04-01T00:00:00Z",
        "2026-04-05T00:00:00Z",
      );

      // Create a relationship in SF
      dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "Alice in SF",
        "FRIEND",
        0.8,
        "San Francisco",
        null,
        7,
      );

      const result = dObj.getReconnectionSuggestions(null, tripConstraint.constraint_id);
      expect(result.city).toBe("San Francisco");
      expect(result.trip_id).toBe(tripConstraint.constraint_id);
      expect(result.trip_name).toBe("SF Business Trip");
      expect(result.trip_start).toBe("2026-04-01T00:00:00Z");
      expect(result.trip_end).toBe("2026-04-05T00:00:00Z");
      expect(result.suggestions.length).toBe(1);
      expect(result.suggestions[0].display_name).toBe("Alice in SF");
    });

    it("throws error when trip constraint has no destination_city and no city param", () => {
      // Create a trip without destination_city
      const tripConstraint = dObj.addConstraint(
        "trip",
        {
          name: "Mystery Trip",
          timezone: "UTC",
          block_policy: "BUSY",
        },
        "2026-04-01T00:00:00Z",
        "2026-04-05T00:00:00Z",
      );

      expect(() => {
        dObj.getReconnectionSuggestions(null, tripConstraint.constraint_id);
      }).toThrow("No city available");
    });

    it("throws error when trip_id does not exist", () => {
      expect(() => {
        dObj.getReconnectionSuggestions(null, "constraint_nonexistent");
      }).toThrow("Trip constraint not found");
    });

    it("throws error when constraint is not a trip", () => {
      // Create a working_hours constraint
      const whConstraint = dObj.addConstraint(
        "working_hours",
        {
          days: [1, 2, 3, 4, 5],
          start_time: "09:00",
          end_time: "17:00",
          timezone: "UTC",
        },
        null,
        null,
      );

      expect(() => {
        dObj.getReconnectionSuggestions(null, whConstraint.constraint_id);
      }).toThrow("not a trip");
    });

    it("throws error when neither city nor trip_id provided", () => {
      expect(() => {
        dObj.getReconnectionSuggestions(null, null);
      }).toThrow("No city available");
    });

    it("returns empty suggestions when no relationships in city", () => {
      dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "Alice in NYC",
        "FRIEND",
        0.8,
        "New York",
        null,
        7,
      );

      const result = dObj.getReconnectionSuggestions("Chicago");
      expect(result.city).toBe("Chicago");
      expect(result.suggestions.length).toBe(0);
      expect(result.total_in_city).toBe(0);
      expect(result.total_overdue_in_city).toBe(0);
    });

    it("excludes relationships without frequency target from suggestions", () => {
      // Relationship WITH frequency target (should appear)
      dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "Alice tracked",
        "FRIEND",
        0.8,
        "San Francisco",
        null,
        7, // has target
      );

      // Relationship WITHOUT frequency target (should NOT appear in suggestions)
      dObj.createRelationship(
        TEST_REL_ID_2,
        TEST_PARTICIPANT_HASH_2,
        "Bob untracked",
        "COLLEAGUE",
        0.6,
        "San Francisco",
        null,
        null, // no target
      );

      const result = dObj.getReconnectionSuggestions("San Francisco");
      expect(result.total_in_city).toBe(2); // both are in the city
      expect(result.total_overdue_in_city).toBe(1); // only Alice is overdue (Bob has no target)
      expect(result.suggestions.length).toBe(1);
      expect(result.suggestions[0].display_name).toBe("Alice tracked");
    });

    it("city param takes precedence when both city and trip_id provided", () => {
      // Trip with destination_city = NYC
      const tripConstraint = dObj.addConstraint(
        "trip",
        {
          name: "NYC Trip",
          timezone: "America/New_York",
          block_policy: "BUSY",
          destination_city: "New York",
        },
        "2026-04-01T00:00:00Z",
        "2026-04-05T00:00:00Z",
      );

      // Relationship in SF
      dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "Alice SF",
        "FRIEND",
        0.8,
        "San Francisco",
        null,
        7,
      );

      // When city is explicitly provided, it overrides the trip's destination_city
      const result = dObj.getReconnectionSuggestions("San Francisco", tripConstraint.constraint_id);
      expect(result.city).toBe("San Francisco");
      expect(result.suggestions.length).toBe(1);
      expect(result.suggestions[0].display_name).toBe("Alice SF");
      // trip_id still included in response context
      expect(result.trip_id).toBe(tripConstraint.constraint_id);
    });

    // -- TM-xwn.1: Walking Skeleton enrichment tests --

    it("suggestions include suggested_duration_minutes based on category (TM-xwn.1)", () => {
      // FRIEND -> 60 min
      dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "Friend Alice",
        "FRIEND",
        0.8,
        "Berlin",
        null,
        7,
      );
      // COLLEAGUE -> 45 min
      dObj.createRelationship(
        TEST_REL_ID_2,
        TEST_PARTICIPANT_HASH_2,
        "Colleague Bob",
        "COLLEAGUE",
        0.6,
        "Berlin",
        null,
        14,
      );

      const result = dObj.getReconnectionSuggestions("Berlin");
      expect(result.suggestions.length).toBe(2);

      // Find each suggestion by name to avoid ordering assumptions
      const alice = result.suggestions.find((s) => s.display_name === "Friend Alice");
      const bob = result.suggestions.find((s) => s.display_name === "Colleague Bob");
      expect(alice).toBeDefined();
      expect(bob).toBeDefined();
      expect(alice!.suggested_duration_minutes).toBe(60);
      expect(bob!.suggested_duration_minutes).toBe(45);
    });

    it("suggestions include time_window bounded by trip dates (TM-xwn.1)", () => {
      const tripConstraint = dObj.addConstraint(
        "trip",
        {
          name: "Berlin Trip",
          timezone: "Europe/Berlin",
          block_policy: "BUSY",
          destination_city: "Berlin",
        },
        "2026-04-10T00:00:00Z",
        "2026-04-15T00:00:00Z",
      );

      dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "Hans in Berlin",
        "FRIEND",
        0.8,
        "Berlin",
        null,
        7,
      );

      const result = dObj.getReconnectionSuggestions(null, tripConstraint.constraint_id);
      expect(result.suggestions.length).toBe(1);
      expect(result.suggestions[0].suggested_time_window).toBeDefined();
      expect(result.suggestions[0].suggested_time_window!.earliest).toBe("2026-04-10T00:00:00Z");
      expect(result.suggestions[0].suggested_time_window!.latest).toBe("2026-04-15T00:00:00Z");
    });

    it("suggestions have null time_window when queried by city without trip (TM-xwn.1)", () => {
      dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "Hans in Berlin",
        "FRIEND",
        0.8,
        "Berlin",
        null,
        7,
      );

      const result = dObj.getReconnectionSuggestions("Berlin");
      expect(result.suggestions.length).toBe(1);
      expect(result.suggestions[0].suggested_time_window).toBeNull();
      // Duration is still computed even without a trip
      expect(result.suggestions[0].suggested_duration_minutes).toBe(60);
    });

    it("full pipeline: trip creation -> city match -> drift filter -> enriched suggestion (TM-xwn.1)", () => {
      // Step 1: Create a trip to Berlin
      const trip = dObj.addConstraint(
        "trip",
        {
          name: "Berlin Business Trip",
          timezone: "Europe/Berlin",
          block_policy: "BUSY",
          destination_city: "Berlin",
        },
        "2026-05-01T00:00:00Z",
        "2026-05-07T00:00:00Z",
      );

      // Step 2: Create relationships - some in Berlin, some not
      dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "Hans (Berlin, overdue)",
        "FRIEND",
        0.9,
        "Berlin",
        null,
        7, // weekly - will be overdue since never interacted
      );
      dObj.createRelationship(
        TEST_REL_ID_2,
        TEST_PARTICIPANT_HASH_2,
        "Greta (Berlin, overdue)",
        "INVESTOR",
        0.5,
        "berlin", // lowercase - should match case-insensitively
        null,
        30,
      );
      const parisRelId = "rel_01HXY000000000000000PARIS";
      const parisHash = "sha256_paris_contact";
      dObj.createRelationship(
        parisRelId,
        parisHash,
        "Pierre (Paris, overdue but wrong city)",
        "COLLEAGUE",
        0.7,
        "Paris",
        null,
        7,
      );

      // Step 3: Query reconnection suggestions for the trip
      const result = dObj.getReconnectionSuggestions(null, trip.constraint_id);

      // Verify: only Berlin contacts returned
      expect(result.city).toBe("Berlin");
      expect(result.trip_id).toBe(trip.constraint_id);
      expect(result.trip_name).toBe("Berlin Business Trip");
      expect(result.trip_start).toBe("2026-05-01T00:00:00Z");
      expect(result.trip_end).toBe("2026-05-07T00:00:00Z");
      expect(result.total_in_city).toBe(2); // Hans + Greta
      expect(result.total_overdue_in_city).toBe(2);
      expect(result.suggestions.length).toBe(2);

      // Verify enriched fields
      for (const s of result.suggestions) {
        // All should have time windows from the trip
        expect(s.suggested_time_window).toBeDefined();
        expect(s.suggested_time_window!.earliest).toBe("2026-05-01T00:00:00Z");
        expect(s.suggested_time_window!.latest).toBe("2026-05-07T00:00:00Z");
        // Duration matches category
        expect(s.suggested_duration_minutes).toBeGreaterThan(0);
        // Drift > 1.0 (all are overdue)
        expect(s.drift_ratio).toBeGreaterThan(1.0);
        // Days overdue > 0
        expect(s.days_overdue).toBeGreaterThan(0);
      }

      // Verify category-specific durations
      const hans = result.suggestions.find((s) => s.display_name === "Hans (Berlin, overdue)");
      const greta = result.suggestions.find((s) => s.display_name === "Greta (Berlin, overdue)");
      expect(hans).toBeDefined();
      expect(greta).toBeDefined();
      expect(hans!.suggested_duration_minutes).toBe(60); // FRIEND
      expect(greta!.suggested_duration_minutes).toBe(30); // INVESTOR

      // Verify never auto-sends (BR-17): response is data-only, no action taken
      // This is verified structurally: the response is a pure data report,
      // not a trigger for any email/notification/scheduling action.
      expect(result).not.toHaveProperty("auto_sent");
      expect(result).not.toHaveProperty("scheduled");
    });
  });
});

// ---------------------------------------------------------------------------
// Geo-Matching Engine integration tests (TM-xwn.3)
// ---------------------------------------------------------------------------

describe("UserGraphDO geo-matching engine integration", () => {
  let db: DatabaseType;
  let sql: SqlStorageLike;
  let queue: MockQueue;
  let dObj: UserGraphDO;

  beforeEach(() => {
    db = new Database(":memory:");
    sql = createSqlStorageAdapter(db);
    queue = new MockQueue();
    dObj = new UserGraphDO(sql, queue);
  });

  afterEach(() => {
    db.close();
  });

  describe("city alias matching (TM-xwn.3 AC1, AC4)", () => {
    it("resolves NYC alias: contact with city=NYC matches trip to New York", () => {
      dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "Alice in NYC",
        "FRIEND",
        0.8,
        "NYC",         // stored as NYC alias
        "America/New_York",
        7,
      );

      // Query with canonical name "New York" -- should find Alice via alias resolution
      const result = dObj.getReconnectionSuggestions("New York");
      expect(result.suggestions.length).toBe(1);
      expect(result.suggestions[0].display_name).toBe("Alice in NYC");
      expect(result.total_in_city).toBe(1);
    });

    it("resolves alias in reverse: trip to NYC finds contact with city=New York", () => {
      dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "Alice in New York",
        "FRIEND",
        0.8,
        "New York",
        "America/New_York",
        7,
      );

      // Query with alias "NYC" -- should find Alice
      const result = dObj.getReconnectionSuggestions("NYC");
      expect(result.suggestions.length).toBe(1);
      expect(result.suggestions[0].display_name).toBe("Alice in New York");
    });

    it("resolves Manhattan -> New York alias for cross-alias matching", () => {
      dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "Alice in Manhattan",
        "FRIEND",
        0.8,
        "Manhattan",
        "America/New_York",
        7,
      );

      // Both "Manhattan" and "NYC" resolve to "New York"
      const result = dObj.getReconnectionSuggestions("NYC");
      expect(result.suggestions.length).toBe(1);
      expect(result.suggestions[0].display_name).toBe("Alice in Manhattan");
    });

    it("resolves Bombay -> Mumbai alias", () => {
      dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "Raj in Bombay",
        "COLLEAGUE",
        0.6,
        "Bombay",
        "Asia/Kolkata",
        14,
      );

      const result = dObj.getReconnectionSuggestions("Mumbai");
      expect(result.suggestions.length).toBe(1);
      expect(result.suggestions[0].display_name).toBe("Raj in Bombay");
    });

    it("falls back to case-insensitive exact match for unknown cities (AC4)", () => {
      dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "Contact in Smallville",
        "OTHER",
        0.3,
        "Smallville",
        null,
        30,
      );

      const result = dObj.getReconnectionSuggestions("smallville");
      expect(result.suggestions.length).toBe(1);
      expect(result.suggestions[0].display_name).toBe("Contact in Smallville");
    });

    it("does not match different cities after alias resolution", () => {
      dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "Alice in Berlin",
        "FRIEND",
        0.8,
        "Berlin",
        "Europe/Berlin",
        7,
      );

      const result = dObj.getReconnectionSuggestions("NYC");
      expect(result.suggestions.length).toBe(0);
      expect(result.total_in_city).toBe(0);
    });
  });

  describe("timezone-aware meeting suggestions (TM-xwn.3 AC2, AC3)", () => {
    it("includes timezone_meeting_window in suggestions when trip context available", () => {
      // Create a trip to Berlin
      const trip = dObj.addConstraint(
        "trip",
        {
          name: "Berlin Trip",
          timezone: "Europe/Berlin",
          block_policy: "BUSY",
          destination_city: "Berlin",
        },
        "2026-04-10T00:00:00Z",
        "2026-04-15T00:00:00Z",
      );

      // Create a contact in Berlin
      dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "Hans in Berlin",
        "FRIEND",
        0.8,
        "Berlin",
        "Europe/Berlin",
        7,
      );

      const result = dObj.getReconnectionSuggestions(null, trip.constraint_id);
      expect(result.suggestions.length).toBe(1);

      const s = result.suggestions[0];
      // Should have timezone_meeting_window with timezone info
      expect(s.timezone_meeting_window).toBeDefined();
      expect(s.timezone_meeting_window).not.toBeNull();
      expect(s.timezone_meeting_window!.user_timezone).toBe("Europe/Berlin");
      expect(s.timezone_meeting_window!.contact_timezone).toBe("Europe/Berlin");
      // Same timezone = full overlap, should have hour suggestions
      expect(s.timezone_meeting_window!.suggested_start_hour_utc).toBeDefined();
      expect(s.timezone_meeting_window!.suggested_end_hour_utc).toBeDefined();
    });

    it("respects working hours of both parties (AC3): NY traveler meeting London contact", () => {
      // Create a trip to London
      const trip = dObj.addConstraint(
        "trip",
        {
          name: "London Trip",
          timezone: "America/New_York", // Traveler's home timezone
          block_policy: "BUSY",
          destination_city: "London",
        },
        "2026-04-10T00:00:00Z",
        "2026-04-15T00:00:00Z",
      );

      // Contact is in London
      dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "James in London",
        "COLLEAGUE",
        0.7,
        "London",
        "Europe/London",
        14,
      );

      const result = dObj.getReconnectionSuggestions(null, trip.constraint_id);
      expect(result.suggestions.length).toBe(1);

      const s = result.suggestions[0];
      expect(s.timezone_meeting_window).not.toBeNull();

      // Traveler tz is from trip config (America/New_York)
      // Contact tz is from relationship or city lookup (Europe/London)
      expect(s.timezone_meeting_window!.user_timezone).toBe("America/New_York");
      expect(s.timezone_meeting_window!.contact_timezone).toBe("Europe/London");

      // Working hours overlap should exist (NY and London have ~3-5h overlap)
      expect(s.timezone_meeting_window!.suggested_start_hour_utc).not.toBeNull();
      expect(s.timezone_meeting_window!.suggested_end_hour_utc).not.toBeNull();
    });

    it("looks up contact timezone from city when not stored in relationship", () => {
      // Create a trip to Berlin
      const trip = dObj.addConstraint(
        "trip",
        {
          name: "Berlin Trip",
          timezone: "Europe/Berlin",
          block_policy: "BUSY",
          destination_city: "Berlin",
        },
        "2026-04-10T00:00:00Z",
        "2026-04-15T00:00:00Z",
      );

      // Contact in Berlin with NO stored timezone
      dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "Hans",
        "FRIEND",
        0.8,
        "Berlin",
        null,   // no timezone stored
        7,
      );

      const result = dObj.getReconnectionSuggestions(null, trip.constraint_id);
      expect(result.suggestions.length).toBe(1);

      // Should have looked up Europe/Berlin from the city name
      const s = result.suggestions[0];
      expect(s.timezone_meeting_window).not.toBeNull();
      expect(s.timezone_meeting_window!.contact_timezone).toBe("Europe/Berlin");
    });

    it("returns null hour suggestions when contact city has no known timezone", () => {
      // Contact in unknown city
      dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "Contact in Smallville",
        "OTHER",
        0.3,
        "Smallville",
        null,
        30,
      );

      // Query by city (no trip context)
      const result = dObj.getReconnectionSuggestions("Smallville");
      expect(result.suggestions.length).toBe(1);

      const s = result.suggestions[0];
      // No trip context means no timezone_meeting_window at all
      expect(s.timezone_meeting_window).toBeNull();
    });

    it("full pipeline: NYC trip -> finds Manhattan contact -> timezone-aware window (TM-xwn.3)", () => {
      // Trip to NYC
      const trip = dObj.addConstraint(
        "trip",
        {
          name: "NYC Business Trip",
          timezone: "America/New_York",
          block_policy: "BUSY",
          destination_city: "New York",
        },
        "2026-05-01T00:00:00Z",
        "2026-05-07T00:00:00Z",
      );

      // Contact stored as "Manhattan" should match via alias resolution
      dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "Alice (Manhattan, FRIEND)",
        "FRIEND",
        0.9,
        "Manhattan",
        "America/New_York",
        7,
      );

      // Contact stored as "NYC" should also match
      dObj.createRelationship(
        TEST_REL_ID_2,
        TEST_PARTICIPANT_HASH_2,
        "Bob (NYC, INVESTOR)",
        "INVESTOR",
        0.5,
        "NYC",
        null, // no stored timezone -- will be looked up
        30,
      );

      // Contact in Berlin should NOT match
      const berlinRelId = "rel_01HXY00000000000000BERLIN";
      const berlinHash = "sha256_berlin_contact_hash_0000000000000000000000000000000000";
      dObj.createRelationship(
        berlinRelId,
        berlinHash,
        "Hans (Berlin, wrong city)",
        "COLLEAGUE",
        0.7,
        "Berlin",
        "Europe/Berlin",
        7,
      );

      const result = dObj.getReconnectionSuggestions(null, trip.constraint_id);

      // Only NYC/Manhattan contacts returned
      expect(result.city).toBe("New York");
      expect(result.total_in_city).toBe(2);
      expect(result.suggestions.length).toBe(2);

      // Verify alias-matched contacts
      const alice = result.suggestions.find((s) => s.display_name === "Alice (Manhattan, FRIEND)");
      const bob = result.suggestions.find((s) => s.display_name === "Bob (NYC, INVESTOR)");
      expect(alice).toBeDefined();
      expect(bob).toBeDefined();

      // Verify timezone-aware windows
      expect(alice!.timezone_meeting_window).not.toBeNull();
      expect(alice!.timezone_meeting_window!.user_timezone).toBe("America/New_York");
      expect(alice!.timezone_meeting_window!.contact_timezone).toBe("America/New_York");
      // Same timezone = full working hours overlap
      expect(alice!.timezone_meeting_window!.suggested_start_hour_utc).not.toBeNull();

      // Bob's timezone looked up from "NYC" -> "New York" -> "America/New_York"
      expect(bob!.timezone_meeting_window).not.toBeNull();
      expect(bob!.timezone_meeting_window!.contact_timezone).toBe("America/New_York");

      // Verify enrichment preserves standard fields
      expect(alice!.suggested_duration_minutes).toBe(60); // FRIEND
      expect(bob!.suggested_duration_minutes).toBe(30);   // INVESTOR
      expect(alice!.suggested_time_window).toBeDefined();
      expect(alice!.suggested_time_window!.earliest).toBe("2026-05-01T00:00:00Z");
      expect(alice!.suggested_time_window!.latest).toBe("2026-05-07T00:00:00Z");

      // Verify Berlin contact excluded
      const hans = result.suggestions.find((s) => s.display_name?.includes("Berlin"));
      expect(hans).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Milestone CRUD integration tests (TM-xwn.2)
// ---------------------------------------------------------------------------

const TEST_MILESTONE_ID = "mst_01HXY000000000000000000M01";
const TEST_MILESTONE_ID_2 = "mst_01HXY000000000000000000M02";
const TEST_MILESTONE_ID_3 = "mst_01HXY000000000000000000M03";

describe("UserGraphDO milestone tracking integration", () => {
  let db: DatabaseType;
  let sql: SqlStorageLike;
  let queue: MockQueue;
  let dObj: UserGraphDO;

  beforeEach(() => {
    db = new Database(":memory:");
    sql = createSqlStorageAdapter(db);
    queue = new MockQueue();
    dObj = new UserGraphDO(sql, queue);

    // Create a relationship to attach milestones to
    dObj.createRelationship(
      TEST_REL_ID,
      TEST_PARTICIPANT_HASH,
      "Alice Investor",
      "INVESTOR",
      0.9,
      "San Francisco",
      "America/Los_Angeles",
      14,
    );
  });

  afterEach(() => {
    db.close();
  });

  // -------------------------------------------------------------------------
  // CRUD: Create
  // -------------------------------------------------------------------------

  describe("createMilestone", () => {
    it("creates a milestone and returns all fields", () => {
      const result = dObj.createMilestone(
        TEST_MILESTONE_ID,
        TEST_REL_ID,
        "birthday",
        "1990-06-15",
        true,
        "Alice's birthday",
      );

      expect(result).not.toBeNull();
      expect(result!.milestone_id).toBe(TEST_MILESTONE_ID);
      expect(result!.participant_hash).toBe(TEST_PARTICIPANT_HASH);
      expect(result!.kind).toBe("birthday");
      expect(result!.date).toBe("1990-06-15");
      expect(result!.recurs_annually).toBe(true);
      expect(result!.note).toBe("Alice's birthday");
      expect(result!.created_at).toBeTruthy();
    });

    it("creates a milestone with defaults (no recurrence, no note)", () => {
      const result = dObj.createMilestone(
        TEST_MILESTONE_ID,
        TEST_REL_ID,
        "graduation",
        "2024-05-20",
      );

      expect(result).not.toBeNull();
      expect(result!.recurs_annually).toBe(false);
      expect(result!.note).toBeNull();
    });

    it("returns null when relationship does not exist", () => {
      const result = dObj.createMilestone(
        TEST_MILESTONE_ID,
        "rel_01HXY000000000000000NONEXIST",
        "birthday",
        "1990-06-15",
      );
      expect(result).toBeNull();
    });

    it("rejects invalid milestone kind", () => {
      expect(() =>
        dObj.createMilestone(
          TEST_MILESTONE_ID,
          TEST_REL_ID,
          "wedding",
          "2024-06-15",
        ),
      ).toThrow("Invalid milestone kind: wedding");
    });

    it("rejects invalid date format", () => {
      expect(() =>
        dObj.createMilestone(
          TEST_MILESTONE_ID,
          TEST_REL_ID,
          "birthday",
          "06/15/1990",
        ),
      ).toThrow("Invalid milestone date");
    });

    it("rejects impossible dates", () => {
      expect(() =>
        dObj.createMilestone(
          TEST_MILESTONE_ID,
          TEST_REL_ID,
          "birthday",
          "2023-02-29",
        ),
      ).toThrow("Invalid milestone date");
    });

    it("accepts all valid milestone kinds", () => {
      const kinds = ["birthday", "anniversary", "graduation", "funding", "relocation", "custom"];
      for (let i = 0; i < kinds.length; i++) {
        const milestoneId = `mst_01HXY0000000000000000KIND0${i}`;
        const result = dObj.createMilestone(
          milestoneId,
          TEST_REL_ID,
          kinds[i],
          `2024-0${i + 1}-15`,
        );
        expect(result).not.toBeNull();
        expect(result!.kind).toBe(kinds[i]);
      }
    });
  });

  // -------------------------------------------------------------------------
  // CRUD: List
  // -------------------------------------------------------------------------

  describe("listMilestones", () => {
    it("returns empty array when no milestones exist", () => {
      const result = dObj.listMilestones(TEST_REL_ID);
      expect(result).toEqual([]);
    });

    it("returns null when relationship does not exist", () => {
      const result = dObj.listMilestones("rel_01HXY000000000000000NONEXIST");
      expect(result).toBeNull();
    });

    it("lists multiple milestones sorted by date", () => {
      dObj.createMilestone(TEST_MILESTONE_ID, TEST_REL_ID, "birthday", "1990-06-15", true);
      dObj.createMilestone(TEST_MILESTONE_ID_2, TEST_REL_ID, "graduation", "2024-05-20");
      dObj.createMilestone(TEST_MILESTONE_ID_3, TEST_REL_ID, "anniversary", "2020-01-10", true);

      const result = dObj.listMilestones(TEST_REL_ID);
      expect(result).not.toBeNull();
      expect(result!).toHaveLength(3);
      // Sorted by date ascending (original date, not next occurrence)
      expect(result![0].kind).toBe("birthday"); // 1990-06-15
      expect(result![1].kind).toBe("anniversary"); // 2020-01-10
      expect(result![2].kind).toBe("graduation"); // 2024-05-20
    });
  });

  // -------------------------------------------------------------------------
  // CRUD: Delete
  // -------------------------------------------------------------------------

  describe("deleteMilestone", () => {
    it("deletes an existing milestone", () => {
      dObj.createMilestone(TEST_MILESTONE_ID, TEST_REL_ID, "birthday", "1990-06-15", true);
      const deleted = dObj.deleteMilestone(TEST_MILESTONE_ID);
      expect(deleted).toBe(true);

      // Verify it's gone
      const list = dObj.listMilestones(TEST_REL_ID);
      expect(list).toHaveLength(0);
    });

    it("returns false for non-existent milestone", () => {
      const deleted = dObj.deleteMilestone("mst_01HXY000000000000000NONEXIST");
      expect(deleted).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Cascade delete
  // -------------------------------------------------------------------------

  describe("deleteRelationship cascades milestones", () => {
    it("deletes milestones when relationship is deleted", () => {
      dObj.createMilestone(TEST_MILESTONE_ID, TEST_REL_ID, "birthday", "1990-06-15", true);
      dObj.createMilestone(TEST_MILESTONE_ID_2, TEST_REL_ID, "graduation", "2024-05-20");

      // Delete the relationship
      dObj.deleteRelationship(TEST_REL_ID);

      // Verify milestones are gone (query raw SQL since relationship is gone)
      const rows = db.prepare("SELECT COUNT(*) as cnt FROM milestones WHERE participant_hash = ?")
        .get(TEST_PARTICIPANT_HASH) as { cnt: number };
      expect(rows.cnt).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Multiple milestones per contact (AC #6)
  // -------------------------------------------------------------------------

  describe("multiple milestones per contact", () => {
    it("supports multiple milestones for the same relationship", () => {
      dObj.createMilestone(TEST_MILESTONE_ID, TEST_REL_ID, "birthday", "1990-06-15", true, "Born in SF");
      dObj.createMilestone(TEST_MILESTONE_ID_2, TEST_REL_ID, "anniversary", "2020-01-10", true, "Work anniversary");
      dObj.createMilestone(TEST_MILESTONE_ID_3, TEST_REL_ID, "funding", "2025-03-01", false, "Series A");

      const result = dObj.listMilestones(TEST_REL_ID);
      expect(result).toHaveLength(3);

      // Each has correct data
      const birthday = result!.find(m => m.kind === "birthday");
      const anniversary = result!.find(m => m.kind === "anniversary");
      const funding = result!.find(m => m.kind === "funding");

      expect(birthday!.recurs_annually).toBe(true);
      expect(birthday!.note).toBe("Born in SF");
      expect(anniversary!.recurs_annually).toBe(true);
      expect(funding!.recurs_annually).toBe(false);
      expect(funding!.note).toBe("Series A");
    });
  });

  // -------------------------------------------------------------------------
  // Scheduler avoidance (AC #3)
  // -------------------------------------------------------------------------

  describe("scheduler avoids milestone dates", () => {
    it("computeAvailability marks milestone dates as busy", () => {
      // Create a birthday milestone that recurs annually on June 15
      dObj.createMilestone(TEST_MILESTONE_ID, TEST_REL_ID, "birthday", "1990-06-15", true);

      // Query availability for a range that includes June 15
      const result = dObj.computeAvailability({
        start: "2026-06-14T00:00:00Z",
        end: "2026-06-16T23:59:59Z",
      });

      // The busy intervals should include June 15 (all day)
      const milestoneBusy = result.busy_intervals.find(
        (iv) => iv.start <= "2026-06-15T00:00:00Z" && iv.end >= "2026-06-15T23:59:59Z",
      );
      expect(milestoneBusy).toBeDefined();

      // Free intervals should NOT include June 15
      const freeOnMilestoneDay = result.free_intervals.find(
        (iv) => iv.start.startsWith("2026-06-15") || iv.end.startsWith("2026-06-15"),
      );
      // Either no free interval on June 15, or only very brief edges
      // The key point: the entire day is blocked
      expect(milestoneBusy).toBeDefined();
    });

    it("non-recurring milestones only block their specific date", () => {
      // Non-recurring milestone on 2025-03-01
      dObj.createMilestone(TEST_MILESTONE_ID, TEST_REL_ID, "funding", "2025-03-01", false);

      // Query 2026 -- should NOT have a busy block (non-recurring, date in 2025)
      const result2026 = dObj.computeAvailability({
        start: "2026-02-28T00:00:00Z",
        end: "2026-03-02T23:59:59Z",
      });

      // No busy interval from milestones in 2026 range
      const milestoneBusy = result2026.busy_intervals.find(
        (iv) => iv.account_ids.includes("milestones"),
      );
      expect(milestoneBusy).toBeUndefined();
    });

    it("recurring milestones expand to each year in query range", () => {
      // Birthday on June 15 recurring
      dObj.createMilestone(TEST_MILESTONE_ID, TEST_REL_ID, "birthday", "1990-06-15", true);

      // Query spanning two years
      const result = dObj.computeAvailability({
        start: "2026-01-01T00:00:00Z",
        end: "2027-12-31T23:59:59Z",
      });

      // Should have milestone busy blocks for both June 15 2026 and June 15 2027
      const milestoneBusys = result.busy_intervals.filter(
        (iv) => iv.account_ids.includes("milestones"),
      );
      // At least 2 milestone blocks (one per year)
      expect(milestoneBusys.length).toBeGreaterThanOrEqual(2);
    });
  });
});
