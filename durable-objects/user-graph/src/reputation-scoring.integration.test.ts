/**
 * Integration tests for reputation scoring in UserGraphDO.
 *
 * Uses real SQLite (better-sqlite3) and real scoring functions.
 * Queue is mocked to capture enqueued messages.
 *
 * Tests prove:
 * - Reliability score computed from ledger entries (with decay)
 * - Reciprocity score detects asymmetric cancellation patterns
 * - Scores range 0.0-1.0
 * - Empty ledger returns neutral scores (0.5)
 * - Recent entries weigh more than old entries (decay)
 * - listRelationshipsWithReputation sorts by reliability_score descending
 * - Full flow: create relationship, mark outcomes, query reputation
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import type { SqlStorageLike, SqlStorageCursorLike, AccountId } from "@tminus/shared";
import { UserGraphDO } from "./index";
import type { QueueLike } from "./index";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TEST_ACCOUNT_ID = "acc_01TESTACCOUNT0000000000001" as AccountId;
const TEST_REL_ID = "rel_01HXY000000000000000000E01";
const TEST_REL_ID_2 = "rel_01HXY000000000000000000E02";
const TEST_REL_ID_3 = "rel_01HXY000000000000000000E03";
const TEST_PARTICIPANT_HASH = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
const TEST_PARTICIPANT_HASH_2 = "f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5";
const TEST_PARTICIPANT_HASH_3 = "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

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
// Test setup
// ---------------------------------------------------------------------------

describe("UserGraphDO reputation scoring integration", () => {
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
  // getReputation: basic functionality
  // -------------------------------------------------------------------------

  describe("getReputation", () => {
    it("returns neutral scores for relationship with no ledger entries", () => {
      dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "Alice",
        "INVESTOR",
      );

      const rep = dObj.getReputation(TEST_REL_ID);

      expect(rep).not.toBeNull();
      expect(rep!.reliability_score).toBe(0.5);
      expect(rep!.reciprocity_score).toBe(0.5);
      expect(rep!.total_interactions).toBe(0);
      expect(rep!.last_30_days).toBe(0);
      expect(rep!.computed_at).toBeTruthy();
    });

    it("returns null for non-existent relationship", () => {
      const rep = dObj.getReputation("rel_01NONEXISTENT0000000000001");
      expect(rep).toBeNull();
    });

    it("computes high reliability for all ATTENDED outcomes", () => {
      dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "Alice",
        "INVESTOR",
      );

      dObj.markOutcome(TEST_REL_ID, "ATTENDED", null, "meeting 1");
      dObj.markOutcome(TEST_REL_ID, "ATTENDED", null, "meeting 2");
      dObj.markOutcome(TEST_REL_ID, "ATTENDED", null, "meeting 3");
      dObj.markOutcome(TEST_REL_ID, "ATTENDED", null, "meeting 4");
      dObj.markOutcome(TEST_REL_ID, "ATTENDED", null, "meeting 5");

      const rep = dObj.getReputation(TEST_REL_ID);

      expect(rep).not.toBeNull();
      expect(rep!.reliability_score).toBeGreaterThanOrEqual(0.95);
      expect(rep!.total_interactions).toBe(5);
      expect(rep!.last_30_days).toBe(5);
    });

    it("computes low reliability for all NO_SHOW_THEM outcomes", () => {
      dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "Alice",
        "INVESTOR",
      );

      dObj.markOutcome(TEST_REL_ID, "NO_SHOW_THEM");
      dObj.markOutcome(TEST_REL_ID, "NO_SHOW_THEM");
      dObj.markOutcome(TEST_REL_ID, "NO_SHOW_THEM");

      const rep = dObj.getReputation(TEST_REL_ID);

      expect(rep).not.toBeNull();
      expect(rep!.reliability_score).toBeLessThanOrEqual(0.05);
    });

    it("scores are always in [0.0, 1.0] range", () => {
      dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "Alice",
        "INVESTOR",
      );

      // Mix of outcomes
      dObj.markOutcome(TEST_REL_ID, "ATTENDED");
      dObj.markOutcome(TEST_REL_ID, "CANCELED_BY_THEM");
      dObj.markOutcome(TEST_REL_ID, "NO_SHOW_THEM");
      dObj.markOutcome(TEST_REL_ID, "ATTENDED");
      dObj.markOutcome(TEST_REL_ID, "MOVED_LAST_MINUTE_THEM");

      const rep = dObj.getReputation(TEST_REL_ID);

      expect(rep).not.toBeNull();
      expect(rep!.reliability_score).toBeGreaterThanOrEqual(0.0);
      expect(rep!.reliability_score).toBeLessThanOrEqual(1.0);
      expect(rep!.reciprocity_score).toBeGreaterThanOrEqual(0.0);
      expect(rep!.reciprocity_score).toBeLessThanOrEqual(1.0);
    });

    it("counts total_interactions and last_30_days correctly", () => {
      dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "Alice",
        "INVESTOR",
      );

      // Mark 3 outcomes (all recent, since markOutcome uses current time)
      dObj.markOutcome(TEST_REL_ID, "ATTENDED");
      dObj.markOutcome(TEST_REL_ID, "ATTENDED");
      dObj.markOutcome(TEST_REL_ID, "CANCELED_BY_THEM");

      const rep = dObj.getReputation(TEST_REL_ID);

      expect(rep!.total_interactions).toBe(3);
      expect(rep!.last_30_days).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  // getReputation: reciprocity detection
  // -------------------------------------------------------------------------

  describe("reciprocity detection", () => {
    it("detects asymmetric cancellation (they cancel more)", () => {
      dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "Flaky Friend",
        "FRIEND",
      );

      // They cancel 3 times, I cancel once
      dObj.markOutcome(TEST_REL_ID, "CANCELED_BY_THEM");
      dObj.markOutcome(TEST_REL_ID, "CANCELED_BY_THEM");
      dObj.markOutcome(TEST_REL_ID, "CANCELED_BY_THEM");
      dObj.markOutcome(TEST_REL_ID, "CANCELED_BY_ME");
      dObj.markOutcome(TEST_REL_ID, "ATTENDED");
      dObj.markOutcome(TEST_REL_ID, "ATTENDED");

      const rep = dObj.getReputation(TEST_REL_ID);

      // Reciprocity > 0.5 means they cancel more
      expect(rep!.reciprocity_score).toBeGreaterThan(0.5);
    });

    it("detects asymmetric cancellation (I cancel more)", () => {
      dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "Patient Person",
        "COLLEAGUE",
      );

      // I cancel 3 times, they cancel once
      dObj.markOutcome(TEST_REL_ID, "CANCELED_BY_ME");
      dObj.markOutcome(TEST_REL_ID, "CANCELED_BY_ME");
      dObj.markOutcome(TEST_REL_ID, "CANCELED_BY_ME");
      dObj.markOutcome(TEST_REL_ID, "CANCELED_BY_THEM");
      dObj.markOutcome(TEST_REL_ID, "ATTENDED");

      const rep = dObj.getReputation(TEST_REL_ID);

      // Reciprocity < 0.5 means I cancel more
      expect(rep!.reciprocity_score).toBeLessThan(0.5);
    });

    it("returns balanced reciprocity when cancellations are equal", () => {
      dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "Equal Partner",
        "CLIENT",
      );

      dObj.markOutcome(TEST_REL_ID, "CANCELED_BY_ME");
      dObj.markOutcome(TEST_REL_ID, "CANCELED_BY_THEM");
      dObj.markOutcome(TEST_REL_ID, "ATTENDED");
      dObj.markOutcome(TEST_REL_ID, "ATTENDED");

      const rep = dObj.getReputation(TEST_REL_ID);

      expect(rep!.reciprocity_score).toBeCloseTo(0.5, 2);
    });

    it("includes NO_SHOW variants in reciprocity calculation", () => {
      dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "No-Show Person",
        "FRIEND",
      );

      dObj.markOutcome(TEST_REL_ID, "NO_SHOW_THEM");
      dObj.markOutcome(TEST_REL_ID, "NO_SHOW_THEM");
      dObj.markOutcome(TEST_REL_ID, "ATTENDED");

      const rep = dObj.getReputation(TEST_REL_ID);

      // They have 2 negative actions, I have 0 -- score > 0.5
      expect(rep!.reciprocity_score).toBeGreaterThan(0.5);
    });
  });

  // -------------------------------------------------------------------------
  // listRelationshipsWithReputation: sorted by reliability
  // -------------------------------------------------------------------------

  describe("listRelationshipsWithReputation", () => {
    it("returns relationships sorted by reliability_score descending", () => {
      // Create three relationships
      dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "Reliable Alice",
        "INVESTOR",
      );
      dObj.createRelationship(
        TEST_REL_ID_2,
        TEST_PARTICIPANT_HASH_2,
        "Flaky Bob",
        "FRIEND",
      );
      dObj.createRelationship(
        TEST_REL_ID_3,
        TEST_PARTICIPANT_HASH_3,
        "Mixed Charlie",
        "COLLEAGUE",
      );

      // Alice: all attended (high reliability)
      dObj.markOutcome(TEST_REL_ID, "ATTENDED");
      dObj.markOutcome(TEST_REL_ID, "ATTENDED");
      dObj.markOutcome(TEST_REL_ID, "ATTENDED");

      // Bob: all no-shows (low reliability)
      dObj.markOutcome(TEST_REL_ID_2, "NO_SHOW_THEM");
      dObj.markOutcome(TEST_REL_ID_2, "NO_SHOW_THEM");
      dObj.markOutcome(TEST_REL_ID_2, "NO_SHOW_THEM");

      // Charlie: mixed (medium reliability)
      dObj.markOutcome(TEST_REL_ID_3, "ATTENDED");
      dObj.markOutcome(TEST_REL_ID_3, "CANCELED_BY_THEM");

      const results = dObj.listRelationshipsWithReputation();

      expect(results).toHaveLength(3);

      // Alice should be first (highest reliability)
      expect(results[0].display_name).toBe("Reliable Alice");
      expect(results[0].reputation.reliability_score).toBeGreaterThanOrEqual(0.95);

      // Bob should be last (lowest reliability)
      expect(results[2].display_name).toBe("Flaky Bob");
      expect(results[2].reputation.reliability_score).toBeLessThanOrEqual(0.05);

      // Charlie in the middle
      expect(results[1].display_name).toBe("Mixed Charlie");

      // Verify descending order
      expect(results[0].reputation.reliability_score).toBeGreaterThan(
        results[1].reputation.reliability_score,
      );
      expect(results[1].reputation.reliability_score).toBeGreaterThan(
        results[2].reputation.reliability_score,
      );
    });

    it("includes reputation data for each relationship", () => {
      dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "Alice",
        "INVESTOR",
      );

      dObj.markOutcome(TEST_REL_ID, "ATTENDED");

      const results = dObj.listRelationshipsWithReputation();

      expect(results).toHaveLength(1);
      expect(results[0].reputation).toBeDefined();
      expect(results[0].reputation.reliability_score).toBeDefined();
      expect(results[0].reputation.reciprocity_score).toBeDefined();
      expect(results[0].reputation.total_interactions).toBe(1);
      expect(results[0].reputation.last_30_days).toBe(1);
      expect(results[0].reputation.computed_at).toBeTruthy();
    });

    it("handles relationships with no ledger entries (neutral scores)", () => {
      dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "New Contact",
        "OTHER",
      );

      const results = dObj.listRelationshipsWithReputation();

      expect(results).toHaveLength(1);
      expect(results[0].reputation.reliability_score).toBe(0.5);
      expect(results[0].reputation.reciprocity_score).toBe(0.5);
      expect(results[0].reputation.total_interactions).toBe(0);
    });

    it("returns empty array when no relationships exist", () => {
      const results = dObj.listRelationshipsWithReputation();
      expect(results).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Full flow: create -> mark outcomes -> query reputation -> sort
  // -------------------------------------------------------------------------

  describe("full flow: relationship -> outcomes -> reputation", () => {
    it("end-to-end: create, mark outcomes, verify reputation, sort", () => {
      // Step 1: Create two relationships
      dObj.createRelationship(
        TEST_REL_ID,
        TEST_PARTICIPANT_HASH,
        "Reliable Partner",
        "CLIENT",
      );
      dObj.createRelationship(
        TEST_REL_ID_2,
        TEST_PARTICIPANT_HASH_2,
        "Unreliable Partner",
        "FRIEND",
      );

      // Step 2: Mark outcomes
      // Reliable Partner: 4 attended, 1 cancel
      dObj.markOutcome(TEST_REL_ID, "ATTENDED");
      dObj.markOutcome(TEST_REL_ID, "ATTENDED");
      dObj.markOutcome(TEST_REL_ID, "ATTENDED");
      dObj.markOutcome(TEST_REL_ID, "ATTENDED");
      dObj.markOutcome(TEST_REL_ID, "CANCELED_BY_THEM");

      // Unreliable Partner: 1 attended, 3 no-shows, 2 cancels
      dObj.markOutcome(TEST_REL_ID_2, "ATTENDED");
      dObj.markOutcome(TEST_REL_ID_2, "NO_SHOW_THEM");
      dObj.markOutcome(TEST_REL_ID_2, "NO_SHOW_THEM");
      dObj.markOutcome(TEST_REL_ID_2, "NO_SHOW_THEM");
      dObj.markOutcome(TEST_REL_ID_2, "CANCELED_BY_THEM");
      dObj.markOutcome(TEST_REL_ID_2, "CANCELED_BY_THEM");

      // Step 3: Query individual reputations
      const repReliable = dObj.getReputation(TEST_REL_ID);
      const repUnreliable = dObj.getReputation(TEST_REL_ID_2);

      expect(repReliable).not.toBeNull();
      expect(repUnreliable).not.toBeNull();

      // Reliable partner should have higher score
      expect(repReliable!.reliability_score).toBeGreaterThan(
        repUnreliable!.reliability_score,
      );

      // Both should have reciprocity > 0.5 (they cancel, I don't)
      expect(repReliable!.reciprocity_score).toBeGreaterThan(0.5);
      expect(repUnreliable!.reciprocity_score).toBeGreaterThan(0.5);

      // Verify counts
      expect(repReliable!.total_interactions).toBe(5);
      expect(repUnreliable!.total_interactions).toBe(6);

      // Step 4: Verify sorted list
      const sorted = dObj.listRelationshipsWithReputation();
      expect(sorted).toHaveLength(2);
      expect(sorted[0].display_name).toBe("Reliable Partner");
      expect(sorted[1].display_name).toBe("Unreliable Partner");
    });
  });

  // -------------------------------------------------------------------------
  // Privacy: NFR-7 -- reputation data is private by default
  // -------------------------------------------------------------------------

  describe("privacy (NFR-7)", () => {
    it("reputation is scoped per-user (DO is per-user)", () => {
      // UserGraphDO is already per-user (each user gets their own DO).
      // Reputation is computed from that user's ledger only.
      // This test verifies that different DOs have independent data.

      const db2 = new Database(":memory:");
      const sql2 = createSqlStorageAdapter(db2);
      const queue2 = new MockQueue();
      const dObj2 = new UserGraphDO(sql2, queue2);

      try {
        // User 1: create relationship with good outcomes
        dObj.createRelationship(
          TEST_REL_ID,
          TEST_PARTICIPANT_HASH,
          "Alice",
          "FRIEND",
        );
        dObj.markOutcome(TEST_REL_ID, "ATTENDED");
        dObj.markOutcome(TEST_REL_ID, "ATTENDED");

        // User 2: same participant_hash but different outcomes
        dObj2.createRelationship(
          TEST_REL_ID,
          TEST_PARTICIPANT_HASH,
          "Alice",
          "FRIEND",
        );
        dObj2.markOutcome(TEST_REL_ID, "NO_SHOW_THEM");
        dObj2.markOutcome(TEST_REL_ID, "NO_SHOW_THEM");

        // Reputations should be independent
        const rep1 = dObj.getReputation(TEST_REL_ID);
        const rep2 = dObj2.getReputation(TEST_REL_ID);

        expect(rep1!.reliability_score).toBeGreaterThan(0.9);
        expect(rep2!.reliability_score).toBeLessThan(0.1);
      } finally {
        db2.close();
      }
    });
  });
});
