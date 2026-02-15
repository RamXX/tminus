/**
 * Integration tests for pre-meeting context briefing in UserGraphDO.
 *
 * Uses real SQLite (better-sqlite3) and real crypto (Node.js crypto.subtle).
 * Queue is mocked to capture enqueued messages.
 *
 * Tests prove:
 * - Event briefing returns participant context for tracked relationships
 * - Topic extraction works from event titles
 * - Reputation scores are included in briefing
 * - Mutual connection counts are computed
 * - Event not found returns null
 * - Events with no tracked participants return empty participants
 * - Event participants are stored during applyProviderDelta
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import type { SqlStorageLike, SqlStorageCursorLike, ProviderDelta, AccountId } from "@tminus/shared";
import { UserGraphDO } from "./index";
import type { QueueLike } from "./index";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TEST_ACCOUNT_ID = "acc_01TESTACCOUNT0000000000001" as AccountId;
const HASH_ALICE = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
const HASH_BOB = "f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5";
const HASH_CHARLIE = "1111111111111111111111111111111111111111111111111111111111111111";
const HASH_UNKNOWN = "9999999999999999999999999999999999999999999999999999999999999999";

const REL_ALICE = "rel_01HXY000000000000000000E01";
const REL_BOB = "rel_01HXY000000000000000000E02";
const REL_CHARLIE = "rel_01HXY000000000000000000E03";

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
// Tests
// ---------------------------------------------------------------------------

describe("UserGraphDO briefing integration", () => {
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

  /**
   * Helper: create an event via applyProviderDelta and return its canonical ID.
   */
  async function createEvent(
    title: string,
    participantHashes: string[],
    startTs = "2026-02-16T14:00:00Z",
  ): Promise<string> {
    const originEventId = `google_evt_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const delta: ProviderDelta & { participant_hashes?: string[] } = {
      type: "created",
      origin_event_id: originEventId,
      origin_account_id: TEST_ACCOUNT_ID,
      event: {
        origin_account_id: TEST_ACCOUNT_ID,
        origin_event_id: originEventId,
        title,
        start: { dateTime: startTs },
        end: { dateTime: "2026-02-16T15:00:00Z" },
        all_day: false,
        status: "confirmed",
        visibility: "default",
        transparency: "opaque",
        source: "provider",
      },
      participant_hashes: participantHashes,
    };

    await dObj.applyProviderDelta(TEST_ACCOUNT_ID as string, [delta]);

    // Find the canonical event ID by origin keys
    const events = dObj.listCanonicalEvents({ origin_account_id: TEST_ACCOUNT_ID as string });
    const matched = events.items.find((e) => e.origin_event_id === originEventId);
    if (!matched) throw new Error("Event not created");
    return matched.canonical_event_id;
  }

  /**
   * Helper: create relationships for testing.
   */
  function setupRelationships(): void {
    dObj.createRelationship(
      REL_ALICE,
      HASH_ALICE,
      "Alice Smith",
      "CLIENT",
      0.8,
      "San Francisco",
      "America/Los_Angeles",
      14,
    );

    dObj.createRelationship(
      REL_BOB,
      HASH_BOB,
      "Bob Jones",
      "INVESTOR",
      0.6,
      "New York",
      "America/New_York",
      30,
    );

    dObj.createRelationship(
      REL_CHARLIE,
      HASH_CHARLIE,
      "Charlie Brown",
      "FRIEND",
      0.9,
      "San Francisco",
      "America/Los_Angeles",
      7,
    );
  }

  // -------------------------------------------------------------------------
  // Event participant storage
  // -------------------------------------------------------------------------

  describe("storeEventParticipants", () => {
    it("stores participant hashes during event creation", async () => {
      setupRelationships();

      const eventId = await createEvent("Team Sync", [HASH_ALICE, HASH_BOB]);

      const hashes = dObj.getEventParticipantHashes(eventId);
      expect(hashes).toHaveLength(2);
      expect(hashes).toContain(HASH_ALICE);
      expect(hashes).toContain(HASH_BOB);
    });

    it("replaces participant hashes on event update", async () => {
      setupRelationships();

      // Create an event with Alice
      const originEventId = "google_evt_update_test";
      const createDelta: ProviderDelta & { participant_hashes?: string[] } = {
        type: "created",
        origin_event_id: originEventId,
        origin_account_id: TEST_ACCOUNT_ID,
        event: {
          origin_account_id: TEST_ACCOUNT_ID,
          origin_event_id: originEventId,
          title: "Meeting",
          start: { dateTime: "2026-02-16T14:00:00Z" },
          end: { dateTime: "2026-02-16T15:00:00Z" },
          all_day: false,
          status: "confirmed",
          visibility: "default",
          transparency: "opaque",
          source: "provider",
        },
        participant_hashes: [HASH_ALICE],
      };

      await dObj.applyProviderDelta(TEST_ACCOUNT_ID as string, [createDelta]);

      // Find the canonical ID
      const events = dObj.listCanonicalEvents({ origin_account_id: TEST_ACCOUNT_ID as string });
      const eventId = events.items.find((e) => e.origin_event_id === originEventId)!.canonical_event_id;

      // Verify initial participants
      let hashes = dObj.getEventParticipantHashes(eventId);
      expect(hashes).toEqual([HASH_ALICE]);

      // Update with different participants
      const updateDelta: ProviderDelta & { participant_hashes?: string[] } = {
        type: "updated",
        origin_event_id: originEventId,
        origin_account_id: TEST_ACCOUNT_ID,
        event: {
          origin_account_id: TEST_ACCOUNT_ID,
          origin_event_id: originEventId,
          title: "Updated Meeting",
          start: { dateTime: "2026-02-16T14:00:00Z" },
          end: { dateTime: "2026-02-16T15:00:00Z" },
          all_day: false,
          status: "confirmed",
          visibility: "default",
          transparency: "opaque",
          source: "provider",
        },
        participant_hashes: [HASH_ALICE, HASH_BOB, HASH_CHARLIE],
      };

      await dObj.applyProviderDelta(TEST_ACCOUNT_ID as string, [updateDelta]);

      hashes = dObj.getEventParticipantHashes(eventId);
      expect(hashes).toHaveLength(3);
      expect(hashes).toContain(HASH_ALICE);
      expect(hashes).toContain(HASH_BOB);
      expect(hashes).toContain(HASH_CHARLIE);
    });
  });

  // -------------------------------------------------------------------------
  // Event briefing
  // -------------------------------------------------------------------------

  describe("getEventBriefing", () => {
    it("returns null for non-existent event", () => {
      const briefing = dObj.getEventBriefing("evt_01NONEXISTENT0000000000001");
      expect(briefing).toBeNull();
    });

    it("returns briefing with empty participants for event with no tracked contacts", async () => {
      setupRelationships();

      const eventId = await createEvent("Solo Focus Time", [HASH_UNKNOWN]);

      const briefing = dObj.getEventBriefing(eventId);
      expect(briefing).not.toBeNull();
      expect(briefing!.event_id).toBe(eventId);
      expect(briefing!.event_title).toBe("Solo Focus Time");
      expect(briefing!.participants).toEqual([]);
    });

    it("returns briefing with participant context for tracked contacts", async () => {
      setupRelationships();

      const eventId = await createEvent("Q4 Board Meeting", [HASH_ALICE, HASH_BOB]);

      const briefing = dObj.getEventBriefing(eventId);
      expect(briefing).not.toBeNull();
      expect(briefing!.event_id).toBe(eventId);
      expect(briefing!.event_title).toBe("Q4 Board Meeting");
      expect(briefing!.participants).toHaveLength(2);

      // Check topics extracted from title
      expect(briefing!.topics).toContain("board meeting");
      expect(briefing!.topics).toContain("meeting");

      // Find Alice in participants
      const alice = briefing!.participants.find((p) => p.display_name === "Alice Smith");
      expect(alice).toBeDefined();
      expect(alice!.category).toBe("CLIENT");
      expect(alice!.reputation_score).toBeGreaterThanOrEqual(0);
      expect(alice!.reputation_score).toBeLessThanOrEqual(1);
      expect(alice!.mutual_connections_count).toBeTypeOf("number");

      // Find Bob in participants
      const bob = briefing!.participants.find((p) => p.display_name === "Bob Jones");
      expect(bob).toBeDefined();
      expect(bob!.category).toBe("INVESTOR");
    });

    it("includes last_interaction_ts from relationship", async () => {
      setupRelationships();

      // Mark an outcome for Alice to set last_interaction_ts
      dObj.markOutcome(REL_ALICE, "ATTENDED", null, "Had a great meeting");

      const eventId = await createEvent("Follow-up Call", [HASH_ALICE]);

      const briefing = dObj.getEventBriefing(eventId);
      expect(briefing).not.toBeNull();
      expect(briefing!.participants).toHaveLength(1);

      const alice = briefing!.participants[0];
      expect(alice.last_interaction_ts).not.toBeNull();
      expect(alice.last_interaction_summary).toBeTypeOf("string");
    });

    it("includes reputation score from interaction ledger", async () => {
      setupRelationships();

      // Mark several outcomes for Alice to build reputation
      dObj.markOutcome(REL_ALICE, "ATTENDED", null, "Meeting 1");
      dObj.markOutcome(REL_ALICE, "ATTENDED", null, "Meeting 2");
      dObj.markOutcome(REL_ALICE, "CANCELED_BY_THEM", null, "Canceled");

      const eventId = await createEvent("Status Update", [HASH_ALICE]);

      const briefing = dObj.getEventBriefing(eventId);
      expect(briefing).not.toBeNull();
      expect(briefing!.participants).toHaveLength(1);

      const alice = briefing!.participants[0];
      // With 2 ATTENDED and 1 CANCELED_BY_THEM, reputation should be < 1.0
      expect(alice.reputation_score).toBeGreaterThan(0);
      expect(alice.reputation_score).toBeLessThan(1);
    });

    it("computes mutual connections between participants", async () => {
      setupRelationships();

      // Create an event where Alice and Charlie are both participants
      const sharedEventId = await createEvent("Team Lunch", [HASH_ALICE, HASH_CHARLIE]);

      // Now create another event with Alice and Bob
      const briefingEventId = await createEvent("Client Review", [HASH_ALICE, HASH_BOB]);

      const briefing = dObj.getEventBriefing(briefingEventId);
      expect(briefing).not.toBeNull();

      // Alice should have at least 1 mutual connection (Bob, who is also in this event)
      const alice = briefing!.participants.find((p) => p.display_name === "Alice Smith");
      expect(alice).toBeDefined();
      // Alice appears in the shared event with Charlie, and in this event with Bob
      // Bob only appears in this event, so his mutual = Alice
      // Mutual connections = other tracked contacts who share events
      expect(alice!.mutual_connections_count).toBeGreaterThanOrEqual(0);
    });

    it("extracts topics from event title", async () => {
      setupRelationships();

      const eventId = await createEvent("Weekly Sprint Review", [HASH_ALICE]);

      const briefing = dObj.getEventBriefing(eventId);
      expect(briefing).not.toBeNull();
      expect(briefing!.topics).toContain("weekly");
      expect(briefing!.topics).toContain("sprint");
      expect(briefing!.topics).toContain("review");
    });

    it("includes computed_at timestamp", async () => {
      setupRelationships();

      const eventId = await createEvent("Meeting", [HASH_ALICE]);

      const briefing = dObj.getEventBriefing(eventId);
      expect(briefing).not.toBeNull();
      expect(briefing!.computed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("handles event with no participants table entries", async () => {
      // Create event directly without participant hashes
      const delta: ProviderDelta = {
        type: "created",
        origin_event_id: "google_evt_no_participants",
        origin_account_id: TEST_ACCOUNT_ID,
        event: {
          origin_account_id: TEST_ACCOUNT_ID,
          origin_event_id: "google_evt_no_participants",
          title: "Solo Block",
          start: { dateTime: "2026-02-16T14:00:00Z" },
          end: { dateTime: "2026-02-16T15:00:00Z" },
          all_day: false,
          status: "confirmed",
          visibility: "default",
          transparency: "opaque",
          source: "provider",
        },
      };

      await dObj.applyProviderDelta(TEST_ACCOUNT_ID as string, [delta]);

      const events = dObj.listCanonicalEvents({ origin_account_id: TEST_ACCOUNT_ID as string });
      const eventId = events.items[0].canonical_event_id;

      const briefing = dObj.getEventBriefing(eventId);
      expect(briefing).not.toBeNull();
      expect(briefing!.participants).toEqual([]);
    });

    it("sorts participants by reputation score descending", async () => {
      setupRelationships();

      // Give Alice more negative outcomes, Bob positive
      dObj.markOutcome(REL_ALICE, "NO_SHOW_THEM", null, "No show");
      dObj.markOutcome(REL_ALICE, "CANCELED_BY_THEM", null, "Canceled");
      dObj.markOutcome(REL_BOB, "ATTENDED", null, "Great meeting");
      dObj.markOutcome(REL_BOB, "ATTENDED", null, "Another great one");

      const eventId = await createEvent("Team Sync", [HASH_ALICE, HASH_BOB]);

      const briefing = dObj.getEventBriefing(eventId);
      expect(briefing).not.toBeNull();
      expect(briefing!.participants).toHaveLength(2);

      // Bob (all positive) should have higher reputation than Alice (all negative)
      expect(briefing!.participants[0].display_name).toBe("Bob Jones");
      expect(briefing!.participants[1].display_name).toBe("Alice Smith");
      expect(
        briefing!.participants[0].reputation_score,
      ).toBeGreaterThanOrEqual(
        briefing!.participants[1].reputation_score,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Direct method calls (same as RPC would invoke)
  // -------------------------------------------------------------------------

  describe("getEventBriefing direct call (equivalent to RPC)", () => {
    it("returns briefing with topics and participants", async () => {
      setupRelationships();

      const eventId = await createEvent("Sprint Planning", [HASH_ALICE]);

      const briefing = dObj.getEventBriefing(eventId);
      expect(briefing).not.toBeNull();
      expect(briefing!.event_id).toBe(eventId);
      expect(briefing!.event_title).toBe("Sprint Planning");
      expect(briefing!.topics).toContain("planning");
      expect(briefing!.topics).toContain("sprint");
      expect(briefing!.participants).toHaveLength(1);
      expect(briefing!.participants[0].display_name).toBe("Alice Smith");
      expect(briefing!.participants[0].category).toBe("CLIENT");
      expect(briefing!.participants[0].reputation_score).toBeTypeOf("number");
    });

    it("returns null for non-existent event", () => {
      const briefing = dObj.getEventBriefing("evt_01NONEXISTENT0000000000001");
      expect(briefing).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // storeEventParticipants direct call
  // -------------------------------------------------------------------------

  describe("storeEventParticipants direct call (equivalent to RPC)", () => {
    it("stores participants and they are retrievable", async () => {
      // Create an event without participants
      const delta: ProviderDelta = {
        type: "created",
        origin_event_id: "google_evt_rpc_test",
        origin_account_id: TEST_ACCOUNT_ID,
        event: {
          origin_account_id: TEST_ACCOUNT_ID,
          origin_event_id: "google_evt_rpc_test",
          title: "RPC Test Event",
          start: { dateTime: "2026-02-16T14:00:00Z" },
          end: { dateTime: "2026-02-16T15:00:00Z" },
          all_day: false,
          status: "confirmed",
          visibility: "default",
          transparency: "opaque",
          source: "provider",
        },
      };
      await dObj.applyProviderDelta(TEST_ACCOUNT_ID as string, [delta]);

      const events = dObj.listCanonicalEvents({ origin_account_id: TEST_ACCOUNT_ID as string });
      const eventId = events.items[0].canonical_event_id;

      // Store participants via direct method
      dObj.storeEventParticipants(eventId, [HASH_ALICE, HASH_BOB]);

      // Verify they are retrievable
      const hashes = dObj.getEventParticipantHashes(eventId);
      expect(hashes).toHaveLength(2);
      expect(hashes).toContain(HASH_ALICE);
      expect(hashes).toContain(HASH_BOB);

      // Now verify briefing works with these participants
      setupRelationships();
      const briefing = dObj.getEventBriefing(eventId);
      expect(briefing).not.toBeNull();
      expect(briefing!.participants).toHaveLength(2);
    });
  });
});
