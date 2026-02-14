/**
 * Integration tests for UserGraphDO.
 *
 * Uses real SQLite (better-sqlite3) and real crypto (Node.js crypto.subtle).
 * Queue is mocked to capture enqueued messages.
 *
 * Tests prove:
 * - applyProviderDelta: create, update, delete flows
 * - Journal entries for all mutations (ADR-5)
 * - Projection and mirror enqueuing via policy edges
 * - Write-skipping when projection hash is unchanged (Invariant C)
 * - Hard delete with mirror cleanup (BR-7)
 * - Cursor-based pagination for listCanonicalEvents
 * - getCanonicalEvent returns event with mirrors
 * - recomputeProjections re-enqueues for changed projections
 * - Version increments on updates
 * - getSyncHealth returns correct counts
 * - upsertCanonicalEvent and deleteCanonicalEvent (user-initiated)
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
const OTHER_ACCOUNT_ID = "acc_01TESTACCOUNT0000000000002" as AccountId;

function makeCreatedDelta(overrides?: Partial<ProviderDelta>): ProviderDelta {
  return {
    type: "created",
    origin_event_id: "google_evt_001",
    origin_account_id: TEST_ACCOUNT_ID,
    event: {
      origin_account_id: TEST_ACCOUNT_ID,
      origin_event_id: "google_evt_001",
      title: "Team Standup",
      description: "Daily standup meeting",
      location: "Conference Room A",
      start: { dateTime: "2026-02-15T09:00:00Z" },
      end: { dateTime: "2026-02-15T09:30:00Z" },
      all_day: false,
      status: "confirmed",
      visibility: "default",
      transparency: "opaque",
    },
    ...overrides,
  };
}

function makeUpdatedDelta(overrides?: Partial<ProviderDelta>): ProviderDelta {
  return {
    type: "updated",
    origin_event_id: "google_evt_001",
    origin_account_id: TEST_ACCOUNT_ID,
    event: {
      origin_account_id: TEST_ACCOUNT_ID,
      origin_event_id: "google_evt_001",
      title: "Team Standup (Moved)",
      description: "Daily standup meeting - new time",
      location: "Conference Room B",
      start: { dateTime: "2026-02-15T10:00:00Z" },
      end: { dateTime: "2026-02-15T10:30:00Z" },
      all_day: false,
      status: "confirmed",
      visibility: "default",
      transparency: "opaque",
    },
    ...overrides,
  };
}

function makeDeletedDelta(overrides?: Partial<ProviderDelta>): ProviderDelta {
  return {
    type: "deleted",
    origin_event_id: "google_evt_001",
    origin_account_id: TEST_ACCOUNT_ID,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// SqlStorage adapter (same pattern as AccountDO tests)
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
// MockQueue -- captures enqueued messages for assertion
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
// Helper: insert a policy edge directly into DB
// ---------------------------------------------------------------------------

function insertPolicyEdge(
  db: DatabaseType,
  opts: {
    policyId: string;
    fromAccountId: string;
    toAccountId: string;
    detailLevel?: string;
    calendarKind?: string;
  },
): void {
  // Ensure policy row exists
  db.prepare(
    `INSERT OR IGNORE INTO policies (policy_id, name) VALUES (?, ?)`,
  ).run(opts.policyId, "test-policy");

  db.prepare(
    `INSERT INTO policy_edges (policy_id, from_account_id, to_account_id, detail_level, calendar_kind)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    opts.policyId,
    opts.fromAccountId,
    opts.toAccountId,
    opts.detailLevel ?? "BUSY",
    opts.calendarKind ?? "BUSY_OVERLAY",
  );
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("UserGraphDO integration", () => {
  let db: DatabaseType;
  let sql: SqlStorageLike;
  let queue: MockQueue;
  let ug: UserGraphDO;

  beforeEach(() => {
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
  // applyProviderDelta -- created
  // -------------------------------------------------------------------------

  describe("applyProviderDelta with 'created' delta", () => {
    it("inserts canonical event and journal entry", async () => {
      const delta = makeCreatedDelta();
      const result = await ug.applyProviderDelta(TEST_ACCOUNT_ID, [delta]);

      expect(result.created).toBe(1);
      expect(result.updated).toBe(0);
      expect(result.deleted).toBe(0);
      expect(result.errors).toHaveLength(0);

      // Verify canonical event was inserted
      const events = db
        .prepare("SELECT * FROM canonical_events")
        .all() as Array<Record<string, unknown>>;
      expect(events).toHaveLength(1);
      expect(events[0].origin_event_id).toBe("google_evt_001");
      expect(events[0].title).toBe("Team Standup");
      expect(events[0].start_ts).toBe("2026-02-15T09:00:00Z");
      expect(events[0].version).toBe(1);
      expect(events[0].source).toBe("provider");

      // Verify canonical_event_id is a ULID with evt_ prefix (Invariant B)
      const evtId = events[0].canonical_event_id as string;
      expect(evtId).toMatch(/^evt_[0-9A-Z]{26}$/);

      // Verify journal entry was created (ADR-5)
      const journal = db
        .prepare("SELECT * FROM event_journal")
        .all() as Array<Record<string, unknown>>;
      expect(journal).toHaveLength(1);
      expect(journal[0].change_type).toBe("created");
      expect(journal[0].actor).toBe(`provider:${TEST_ACCOUNT_ID}`);
      expect((journal[0].journal_id as string).startsWith("jrn_")).toBe(true);
    });

    it("generates unique canonical_event_id for each delta", async () => {
      const delta1 = makeCreatedDelta({
        origin_event_id: "google_evt_001",
      });
      const delta2 = makeCreatedDelta({
        origin_event_id: "google_evt_002",
        event: {
          ...makeCreatedDelta().event!,
          origin_event_id: "google_evt_002",
        },
      });

      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [delta1, delta2]);

      const events = db
        .prepare("SELECT canonical_event_id FROM canonical_events ORDER BY canonical_event_id")
        .all() as Array<{ canonical_event_id: string }>;
      expect(events).toHaveLength(2);
      expect(events[0].canonical_event_id).not.toBe(events[1].canonical_event_id);
    });
  });

  // -------------------------------------------------------------------------
  // applyProviderDelta -- updated
  // -------------------------------------------------------------------------

  describe("applyProviderDelta with 'updated' delta", () => {
    it("updates canonical event and bumps version", async () => {
      // First create the event
      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [makeCreatedDelta()]);

      // Then update it
      const result = await ug.applyProviderDelta(TEST_ACCOUNT_ID, [
        makeUpdatedDelta(),
      ]);

      expect(result.created).toBe(0);
      expect(result.updated).toBe(1);
      expect(result.errors).toHaveLength(0);

      // Verify the event was updated
      const events = db
        .prepare("SELECT * FROM canonical_events")
        .all() as Array<Record<string, unknown>>;
      expect(events).toHaveLength(1);
      expect(events[0].title).toBe("Team Standup (Moved)");
      expect(events[0].start_ts).toBe("2026-02-15T10:00:00Z");
      expect(events[0].version).toBe(2);

      // Verify journal has both entries
      const journal = db
        .prepare("SELECT * FROM event_journal ORDER BY journal_id")
        .all() as Array<Record<string, unknown>>;
      expect(journal).toHaveLength(2);
      expect(journal[0].change_type).toBe("created");
      expect(journal[1].change_type).toBe("updated");
    });

    it("treats update for non-existent event as create", async () => {
      // Update without prior create
      const result = await ug.applyProviderDelta(TEST_ACCOUNT_ID, [
        makeUpdatedDelta(),
      ]);

      // Should be counted as an update (the method returns the id, update counter increments)
      // But the event is created since it did not exist
      expect(result.errors).toHaveLength(0);

      const events = db
        .prepare("SELECT * FROM canonical_events")
        .all() as Array<Record<string, unknown>>;
      expect(events).toHaveLength(1);
      expect(events[0].title).toBe("Team Standup (Moved)");
    });
  });

  // -------------------------------------------------------------------------
  // applyProviderDelta -- deleted
  // -------------------------------------------------------------------------

  describe("applyProviderDelta with 'deleted' delta", () => {
    it("removes canonical event and writes journal entry", async () => {
      // Create first
      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [makeCreatedDelta()]);

      // Delete
      const result = await ug.applyProviderDelta(TEST_ACCOUNT_ID, [
        makeDeletedDelta(),
      ]);

      expect(result.deleted).toBe(1);
      expect(result.errors).toHaveLength(0);

      // Verify event is gone (hard delete per BR-7)
      const events = db
        .prepare("SELECT * FROM canonical_events")
        .all();
      expect(events).toHaveLength(0);

      // Journal should have both create and delete entries
      const journal = db
        .prepare("SELECT * FROM event_journal ORDER BY journal_id")
        .all() as Array<Record<string, unknown>>;
      expect(journal).toHaveLength(2);
      expect(journal[1].change_type).toBe("deleted");
    });

    it("ignores delete for non-existent event", async () => {
      const result = await ug.applyProviderDelta(TEST_ACCOUNT_ID, [
        makeDeletedDelta(),
      ]);

      expect(result.deleted).toBe(0);
      expect(result.errors).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Policy edge projection and mirror enqueuing
  // -------------------------------------------------------------------------

  describe("applyProviderDelta with policy edges", () => {
    it("enqueues UPSERT_MIRROR when policy edge exists and hash differs", async () => {
      // Trigger migration first
      ug.getSyncHealth();

      // Insert a policy edge: TEST_ACCOUNT -> OTHER_ACCOUNT
      insertPolicyEdge(db, {
        policyId: "pol_01TEST000000000000000000001",
        fromAccountId: TEST_ACCOUNT_ID,
        toAccountId: OTHER_ACCOUNT_ID,
        detailLevel: "BUSY",
        calendarKind: "BUSY_OVERLAY",
      });

      const delta = makeCreatedDelta();
      const result = await ug.applyProviderDelta(TEST_ACCOUNT_ID, [delta]);

      expect(result.mirrors_enqueued).toBe(1);
      expect(queue.messages).toHaveLength(1);

      const msg = queue.messages[0] as Record<string, unknown>;
      expect(msg.type).toBe("UPSERT_MIRROR");
      expect(msg.target_account_id).toBe(OTHER_ACCOUNT_ID);
      expect(msg.canonical_event_id).toBeDefined();
      expect(msg.idempotency_key).toBeDefined();

      // Verify projected_payload is a BUSY projection
      const payload = msg.projected_payload as Record<string, unknown>;
      expect(payload.summary).toBe("Busy");
      expect(payload.visibility).toBe("private");

      // Verify mirror row was created in DB
      const mirrors = db
        .prepare("SELECT * FROM event_mirrors")
        .all() as Array<Record<string, unknown>>;
      expect(mirrors).toHaveLength(1);
      expect(mirrors[0].state).toBe("PENDING");
      expect(mirrors[0].last_projected_hash).toBeDefined();
    });

    it("enqueues with TITLE detail level", async () => {
      ug.getSyncHealth();

      insertPolicyEdge(db, {
        policyId: "pol_01TEST000000000000000000001",
        fromAccountId: TEST_ACCOUNT_ID,
        toAccountId: OTHER_ACCOUNT_ID,
        detailLevel: "TITLE",
        calendarKind: "BUSY_OVERLAY",
      });

      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [makeCreatedDelta()]);

      expect(queue.messages).toHaveLength(1);
      const msg = queue.messages[0] as Record<string, unknown>;
      const payload = msg.projected_payload as Record<string, unknown>;
      expect(payload.summary).toBe("Team Standup");
      expect(payload.visibility).toBe("default");
    });
  });

  // -------------------------------------------------------------------------
  // Projection hash comparison -- write-skipping (Invariant C)
  // -------------------------------------------------------------------------

  describe("projection hash comparison (Invariant C)", () => {
    it("skips write when applying same delta twice (hash unchanged)", async () => {
      ug.getSyncHealth();

      insertPolicyEdge(db, {
        policyId: "pol_01TEST000000000000000000001",
        fromAccountId: TEST_ACCOUNT_ID,
        toAccountId: OTHER_ACCOUNT_ID,
      });

      const delta = makeCreatedDelta();
      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [delta]);

      expect(queue.messages).toHaveLength(1);

      // Clear queue
      queue.clear();

      // Apply an update with the SAME content (should not re-enqueue)
      // Use same title/time so projection hash is identical
      const updateSameContent: ProviderDelta = {
        type: "updated",
        origin_event_id: "google_evt_001",
        origin_account_id: TEST_ACCOUNT_ID,
        event: {
          origin_account_id: TEST_ACCOUNT_ID,
          origin_event_id: "google_evt_001",
          title: "Team Standup",
          description: "Daily standup meeting",
          location: "Conference Room A",
          start: { dateTime: "2026-02-15T09:00:00Z" },
          end: { dateTime: "2026-02-15T09:30:00Z" },
          all_day: false,
          status: "confirmed",
          visibility: "default",
          transparency: "opaque",
        },
      };

      const result = await ug.applyProviderDelta(TEST_ACCOUNT_ID, [
        updateSameContent,
      ]);

      // Update should succeed but no new mirror enqueue
      expect(result.updated).toBe(1);
      expect(result.mirrors_enqueued).toBe(0);
      expect(queue.messages).toHaveLength(0);
    });

    it("enqueues when content actually changes", async () => {
      ug.getSyncHealth();

      insertPolicyEdge(db, {
        policyId: "pol_01TEST000000000000000000001",
        fromAccountId: TEST_ACCOUNT_ID,
        toAccountId: OTHER_ACCOUNT_ID,
      });

      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [makeCreatedDelta()]);
      queue.clear();

      // Update with different content
      const result = await ug.applyProviderDelta(TEST_ACCOUNT_ID, [
        makeUpdatedDelta(),
      ]);

      expect(result.updated).toBe(1);
      expect(result.mirrors_enqueued).toBe(1);
      expect(queue.messages).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Delete with existing mirrors
  // -------------------------------------------------------------------------

  describe("delete with existing mirrors", () => {
    it("enqueues DELETE_MIRROR for each mirror", async () => {
      ug.getSyncHealth();

      insertPolicyEdge(db, {
        policyId: "pol_01TEST000000000000000000001",
        fromAccountId: TEST_ACCOUNT_ID,
        toAccountId: OTHER_ACCOUNT_ID,
      });

      // Create event (will create mirror)
      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [makeCreatedDelta()]);
      expect(queue.messages).toHaveLength(1); // UPSERT_MIRROR

      queue.clear();

      // Delete event
      const result = await ug.applyProviderDelta(TEST_ACCOUNT_ID, [
        makeDeletedDelta(),
      ]);

      expect(result.deleted).toBe(1);
      expect(result.mirrors_enqueued).toBe(1);
      expect(queue.messages).toHaveLength(1);

      const msg = queue.messages[0] as Record<string, unknown>;
      expect(msg.type).toBe("DELETE_MIRROR");
      expect(msg.target_account_id).toBe(OTHER_ACCOUNT_ID);

      // Mirror row should be cleaned up
      const mirrors = db.prepare("SELECT * FROM event_mirrors").all();
      expect(mirrors).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // listCanonicalEvents with time range filter
  // -------------------------------------------------------------------------

  describe("listCanonicalEvents", () => {
    it("filters by time range", async () => {
      // Create events at different times
      const delta1 = makeCreatedDelta({
        origin_event_id: "evt_morning",
        event: {
          ...makeCreatedDelta().event!,
          origin_event_id: "evt_morning",
          title: "Morning",
          start: { dateTime: "2026-02-15T08:00:00Z" },
          end: { dateTime: "2026-02-15T09:00:00Z" },
        },
      });
      const delta2 = makeCreatedDelta({
        origin_event_id: "evt_afternoon",
        event: {
          ...makeCreatedDelta().event!,
          origin_event_id: "evt_afternoon",
          title: "Afternoon",
          start: { dateTime: "2026-02-15T14:00:00Z" },
          end: { dateTime: "2026-02-15T15:00:00Z" },
        },
      });
      const delta3 = makeCreatedDelta({
        origin_event_id: "evt_evening",
        event: {
          ...makeCreatedDelta().event!,
          origin_event_id: "evt_evening",
          title: "Evening",
          start: { dateTime: "2026-02-15T19:00:00Z" },
          end: { dateTime: "2026-02-15T20:00:00Z" },
        },
      });

      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [delta1, delta2, delta3]);

      // Query for events in the afternoon window only
      const result = ug.listCanonicalEvents({
        time_min: "2026-02-15T13:00:00Z",
        time_max: "2026-02-15T16:00:00Z",
      });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].title).toBe("Afternoon");
      expect(result.has_more).toBe(false);
    });

    it("filters by origin_account_id", async () => {
      const delta1 = makeCreatedDelta({
        origin_event_id: "evt_acct1",
      });
      const delta2 = makeCreatedDelta({
        origin_event_id: "evt_acct2",
        origin_account_id: OTHER_ACCOUNT_ID,
        event: {
          ...makeCreatedDelta().event!,
          origin_account_id: OTHER_ACCOUNT_ID,
          origin_event_id: "evt_acct2",
          title: "Other Account Event",
        },
      });

      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [delta1]);
      await ug.applyProviderDelta(OTHER_ACCOUNT_ID, [delta2]);

      const result = ug.listCanonicalEvents({
        origin_account_id: OTHER_ACCOUNT_ID,
      });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].title).toBe("Other Account Event");
    });
  });

  // -------------------------------------------------------------------------
  // Cursor-based pagination
  // -------------------------------------------------------------------------

  describe("cursor-based pagination", () => {
    it("pages through many events", async () => {
      // Insert 5 events
      const deltas: ProviderDelta[] = [];
      for (let i = 0; i < 5; i++) {
        const hour = (8 + i).toString().padStart(2, "0");
        deltas.push(
          makeCreatedDelta({
            origin_event_id: `evt_page_${i}`,
            event: {
              ...makeCreatedDelta().event!,
              origin_event_id: `evt_page_${i}`,
              title: `Event ${i}`,
              start: { dateTime: `2026-02-15T${hour}:00:00Z` },
              end: { dateTime: `2026-02-15T${hour}:30:00Z` },
            },
          }),
        );
      }

      await ug.applyProviderDelta(TEST_ACCOUNT_ID, deltas);

      // Page 1: 2 items
      const page1 = ug.listCanonicalEvents({ limit: 2 });
      expect(page1.items).toHaveLength(2);
      expect(page1.has_more).toBe(true);
      expect(page1.cursor).toBeDefined();
      expect(page1.items[0].title).toBe("Event 0");
      expect(page1.items[1].title).toBe("Event 1");

      // Page 2: next 2 items
      const page2 = ug.listCanonicalEvents({
        limit: 2,
        cursor: page1.cursor!,
      });
      expect(page2.items).toHaveLength(2);
      expect(page2.has_more).toBe(true);
      expect(page2.items[0].title).toBe("Event 2");
      expect(page2.items[1].title).toBe("Event 3");

      // Page 3: last item
      const page3 = ug.listCanonicalEvents({
        limit: 2,
        cursor: page2.cursor!,
      });
      expect(page3.items).toHaveLength(1);
      expect(page3.has_more).toBe(false);
      expect(page3.cursor).toBeNull();
      expect(page3.items[0].title).toBe("Event 4");
    });
  });

  // -------------------------------------------------------------------------
  // Journal entries for all mutation types
  // -------------------------------------------------------------------------

  describe("journal entries", () => {
    it("creates journal entries for create, update, and delete", async () => {
      // Create
      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [makeCreatedDelta()]);
      // Update
      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [makeUpdatedDelta()]);
      // Delete
      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [makeDeletedDelta()]);

      const journal = ug.queryJournal();
      expect(journal.items).toHaveLength(3);

      const types = journal.items.map((j) => j.change_type);
      expect(types).toEqual(["created", "updated", "deleted"]);

      // All should have provider actor
      for (const entry of journal.items) {
        expect(entry.actor).toBe(`provider:${TEST_ACCOUNT_ID}`);
        expect(entry.journal_id.startsWith("jrn_")).toBe(true);
      }
    });

    it("queryJournal filters by canonical_event_id", async () => {
      const delta1 = makeCreatedDelta({ origin_event_id: "evt_a" });
      const delta2 = makeCreatedDelta({
        origin_event_id: "evt_b",
        event: {
          ...makeCreatedDelta().event!,
          origin_event_id: "evt_b",
          title: "Other event",
        },
      });

      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [delta1, delta2]);

      // Get the canonical_event_id for the first event
      const events = db
        .prepare(
          "SELECT canonical_event_id FROM canonical_events WHERE origin_event_id = ?",
        )
        .all("evt_a") as Array<{ canonical_event_id: string }>;
      expect(events).toHaveLength(1);

      const journal = ug.queryJournal({
        canonical_event_id: events[0].canonical_event_id,
      });
      expect(journal.items).toHaveLength(1);
      expect(journal.items[0].change_type).toBe("created");
    });
  });

  // -------------------------------------------------------------------------
  // recomputeProjections
  // -------------------------------------------------------------------------

  describe("recomputeProjections", () => {
    it("re-enqueues for changed projections when policy changes", async () => {
      ug.getSyncHealth();

      // Create policy edge with BUSY level
      insertPolicyEdge(db, {
        policyId: "pol_01TEST000000000000000000001",
        fromAccountId: TEST_ACCOUNT_ID,
        toAccountId: OTHER_ACCOUNT_ID,
        detailLevel: "BUSY",
        calendarKind: "BUSY_OVERLAY",
      });

      // Create event
      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [makeCreatedDelta()]);
      expect(queue.messages).toHaveLength(1); // Initial UPSERT_MIRROR
      queue.clear();

      // Change policy to TITLE detail level (simulating a policy update)
      db.prepare(
        `UPDATE policy_edges SET detail_level = 'TITLE'
         WHERE from_account_id = ? AND to_account_id = ?`,
      ).run(TEST_ACCOUNT_ID, OTHER_ACCOUNT_ID);

      // Recompute projections -- hash should differ since detail_level changed
      const enqueued = await ug.recomputeProjections();
      expect(enqueued).toBe(1);
      expect(queue.messages).toHaveLength(1);

      const msg = queue.messages[0] as Record<string, unknown>;
      expect(msg.type).toBe("UPSERT_MIRROR");
      const payload = msg.projected_payload as Record<string, unknown>;
      expect(payload.summary).toBe("Team Standup"); // TITLE level shows actual title
    });

    it("skips when projections have not changed", async () => {
      ug.getSyncHealth();

      insertPolicyEdge(db, {
        policyId: "pol_01TEST000000000000000000001",
        fromAccountId: TEST_ACCOUNT_ID,
        toAccountId: OTHER_ACCOUNT_ID,
      });

      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [makeCreatedDelta()]);
      queue.clear();

      // Recompute without changing anything -- should skip
      const enqueued = await ug.recomputeProjections();
      expect(enqueued).toBe(0);
      expect(queue.messages).toHaveLength(0);
    });

    it("recomputes for a single event", async () => {
      ug.getSyncHealth();

      insertPolicyEdge(db, {
        policyId: "pol_01TEST000000000000000000001",
        fromAccountId: TEST_ACCOUNT_ID,
        toAccountId: OTHER_ACCOUNT_ID,
      });

      // Create two events
      const delta1 = makeCreatedDelta({ origin_event_id: "evt_x" });
      const delta2 = makeCreatedDelta({
        origin_event_id: "evt_y",
        event: {
          ...makeCreatedDelta().event!,
          origin_event_id: "evt_y",
          title: "Other Event",
        },
      });

      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [delta1, delta2]);
      queue.clear();

      // Change policy
      db.prepare(`UPDATE policy_edges SET detail_level = 'FULL'`).run();

      // Recompute only for first event
      const events = db
        .prepare(
          "SELECT canonical_event_id FROM canonical_events WHERE origin_event_id = ?",
        )
        .all("evt_x") as Array<{ canonical_event_id: string }>;

      const enqueued = await ug.recomputeProjections({
        canonical_event_id: events[0].canonical_event_id,
      });
      expect(enqueued).toBe(1);
      expect(queue.messages).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Version increments on updates
  // -------------------------------------------------------------------------

  describe("version tracking", () => {
    it("increments version on each update", async () => {
      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [makeCreatedDelta()]);

      let events = db
        .prepare("SELECT version FROM canonical_events")
        .all() as Array<{ version: number }>;
      expect(events[0].version).toBe(1);

      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [makeUpdatedDelta()]);
      events = db
        .prepare("SELECT version FROM canonical_events")
        .all() as Array<{ version: number }>;
      expect(events[0].version).toBe(2);

      // Third update
      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [
        makeUpdatedDelta(),
      ]);
      events = db
        .prepare("SELECT version FROM canonical_events")
        .all() as Array<{ version: number }>;
      expect(events[0].version).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  // getCanonicalEvent -- returns event with mirrors
  // -------------------------------------------------------------------------

  describe("getCanonicalEvent", () => {
    it("returns event with mirrors", async () => {
      ug.getSyncHealth();

      insertPolicyEdge(db, {
        policyId: "pol_01TEST000000000000000000001",
        fromAccountId: TEST_ACCOUNT_ID,
        toAccountId: OTHER_ACCOUNT_ID,
      });

      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [makeCreatedDelta()]);

      // Get the canonical_event_id
      const events = db
        .prepare("SELECT canonical_event_id FROM canonical_events")
        .all() as Array<{ canonical_event_id: string }>;

      const result = ug.getCanonicalEvent(events[0].canonical_event_id);
      expect(result).not.toBeNull();
      expect(result!.event.title).toBe("Team Standup");
      expect(result!.event.origin_event_id).toBe("google_evt_001");
      expect(result!.mirrors).toHaveLength(1);
      expect(result!.mirrors[0].target_account_id).toBe(OTHER_ACCOUNT_ID);
      expect(result!.mirrors[0].state).toBe("PENDING");
    });

    it("returns null for non-existent event", () => {
      // Trigger migration
      ug.getSyncHealth();

      const result = ug.getCanonicalEvent("evt_nonexistent");
      expect(result).toBeNull();
    });

    it("returns event with empty mirrors when no policy edges", async () => {
      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [makeCreatedDelta()]);

      const events = db
        .prepare("SELECT canonical_event_id FROM canonical_events")
        .all() as Array<{ canonical_event_id: string }>;

      const result = ug.getCanonicalEvent(events[0].canonical_event_id);
      expect(result).not.toBeNull();
      expect(result!.mirrors).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // getSyncHealth
  // -------------------------------------------------------------------------

  describe("getSyncHealth", () => {
    it("returns correct counts", async () => {
      ug.getSyncHealth(); // trigger migration

      insertPolicyEdge(db, {
        policyId: "pol_01TEST000000000000000000001",
        fromAccountId: TEST_ACCOUNT_ID,
        toAccountId: OTHER_ACCOUNT_ID,
      });

      // Create 3 events
      const deltas: ProviderDelta[] = [
        makeCreatedDelta({ origin_event_id: "evt_1" }),
        makeCreatedDelta({
          origin_event_id: "evt_2",
          event: {
            ...makeCreatedDelta().event!,
            origin_event_id: "evt_2",
            title: "Event 2",
          },
        }),
        makeCreatedDelta({
          origin_event_id: "evt_3",
          event: {
            ...makeCreatedDelta().event!,
            origin_event_id: "evt_3",
            title: "Event 3",
          },
        }),
      ];

      await ug.applyProviderDelta(TEST_ACCOUNT_ID, deltas);

      const health = ug.getSyncHealth();
      expect(health.total_events).toBe(3);
      expect(health.total_mirrors).toBe(3); // 1 mirror per event (1 policy edge)
      expect(health.total_journal_entries).toBe(3);
      expect(health.pending_mirrors).toBe(3);
      expect(health.error_mirrors).toBe(0);
      expect(health.last_journal_ts).toBeDefined();
    });

    it("returns zeros when empty", () => {
      const health = ug.getSyncHealth();
      expect(health.total_events).toBe(0);
      expect(health.total_mirrors).toBe(0);
      expect(health.total_journal_entries).toBe(0);
      expect(health.pending_mirrors).toBe(0);
      expect(health.error_mirrors).toBe(0);
      expect(health.last_journal_ts).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // upsertCanonicalEvent (user-initiated)
  // -------------------------------------------------------------------------

  describe("upsertCanonicalEvent", () => {
    it("inserts new event from user source", async () => {
      const event = {
        canonical_event_id: "evt_01USER00000000000000000001",
        origin_account_id: TEST_ACCOUNT_ID,
        origin_event_id: "user_created_001",
        title: "User Created Event",
        start: { dateTime: "2026-02-20T10:00:00Z" },
        end: { dateTime: "2026-02-20T11:00:00Z" },
        all_day: false,
        status: "confirmed" as const,
        visibility: "default" as const,
        transparency: "opaque" as const,
        source: "ui" as const,
        version: 1,
        created_at: "2026-02-14T00:00:00Z",
        updated_at: "2026-02-14T00:00:00Z",
      };

      const id = await ug.upsertCanonicalEvent(event as any, "user:usr_test");

      expect(id).toBe("evt_01USER00000000000000000001");

      const result = ug.getCanonicalEvent(id);
      expect(result).not.toBeNull();
      expect(result!.event.title).toBe("User Created Event");
      expect(result!.event.source).toBe("ui");

      // Journal should record creation
      const journal = ug.queryJournal();
      expect(journal.items).toHaveLength(1);
      expect(journal.items[0].actor).toBe("user:usr_test");
      expect(journal.items[0].change_type).toBe("created");
    });

    it("updates existing event and bumps version", async () => {
      const event = {
        canonical_event_id: "evt_01USER00000000000000000001",
        origin_account_id: TEST_ACCOUNT_ID,
        origin_event_id: "user_created_001",
        title: "Original Title",
        start: { dateTime: "2026-02-20T10:00:00Z" },
        end: { dateTime: "2026-02-20T11:00:00Z" },
        all_day: false,
        status: "confirmed" as const,
        visibility: "default" as const,
        transparency: "opaque" as const,
        source: "ui" as const,
        version: 1,
        created_at: "2026-02-14T00:00:00Z",
        updated_at: "2026-02-14T00:00:00Z",
      };

      await ug.upsertCanonicalEvent(event as any, "user:usr_test");

      // Update it
      const updatedEvent = { ...event, title: "Updated Title" };
      await ug.upsertCanonicalEvent(updatedEvent as any, "user:usr_test");

      const result = ug.getCanonicalEvent(event.canonical_event_id);
      expect(result!.event.title).toBe("Updated Title");
      expect(result!.event.version).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // deleteCanonicalEvent (user-initiated)
  // -------------------------------------------------------------------------

  describe("deleteCanonicalEvent", () => {
    it("deletes event and enqueues DELETE_MIRROR", async () => {
      ug.getSyncHealth();

      insertPolicyEdge(db, {
        policyId: "pol_01TEST000000000000000000001",
        fromAccountId: TEST_ACCOUNT_ID,
        toAccountId: OTHER_ACCOUNT_ID,
      });

      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [makeCreatedDelta()]);
      queue.clear();

      const events = db
        .prepare("SELECT canonical_event_id FROM canonical_events")
        .all() as Array<{ canonical_event_id: string }>;

      const deleted = await ug.deleteCanonicalEvent(
        events[0].canonical_event_id,
        "user:usr_test",
      );

      expect(deleted).toBe(true);

      // Event should be gone
      const remaining = db.prepare("SELECT * FROM canonical_events").all();
      expect(remaining).toHaveLength(0);

      // Mirror should be gone
      const mirrors = db.prepare("SELECT * FROM event_mirrors").all();
      expect(mirrors).toHaveLength(0);

      // DELETE_MIRROR should be enqueued
      expect(queue.messages).toHaveLength(1);
      const msg = queue.messages[0] as Record<string, unknown>;
      expect(msg.type).toBe("DELETE_MIRROR");

      // Journal should have delete entry
      const journal = ug.queryJournal();
      const deleteEntries = journal.items.filter(
        (j) => j.change_type === "deleted" && j.actor === "user:usr_test",
      );
      expect(deleteEntries).toHaveLength(1);
    });

    it("returns false for non-existent event", async () => {
      ug.getSyncHealth();
      const deleted = await ug.deleteCanonicalEvent("evt_nonexistent", "user:usr_test");
      expect(deleted).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Schema migration
  // -------------------------------------------------------------------------

  describe("schema migration", () => {
    it("auto-applies migration on first operation", () => {
      const tablesBefore = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_schema%' ORDER BY name",
        )
        .all() as Array<{ name: string }>;
      expect(tablesBefore).toHaveLength(0);

      // Any operation triggers migration
      ug.getSyncHealth();

      const tablesAfter = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_schema%' ORDER BY name",
        )
        .all() as Array<{ name: string }>;

      // Should include at minimum: canonical_events, event_mirrors, event_journal, policy_edges
      const tableNames = tablesAfter.map((t) => t.name);
      expect(tableNames).toContain("canonical_events");
      expect(tableNames).toContain("event_mirrors");
      expect(tableNames).toContain("event_journal");
      expect(tableNames).toContain("policy_edges");
      expect(tableNames).toContain("policies");
    });

    it("migration is idempotent", async () => {
      const ug1 = new UserGraphDO(sql, queue);
      await ug1.applyProviderDelta(TEST_ACCOUNT_ID, [makeCreatedDelta()]);

      // Create second instance (simulates DO wake-up)
      const ug2 = new UserGraphDO(sql, queue);
      const health = ug2.getSyncHealth();
      expect(health.total_events).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  describe("edge cases", () => {
    it("handles batch of mixed delta types", async () => {
      // Create event A
      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [
        makeCreatedDelta({ origin_event_id: "evt_a" }),
      ]);

      // Batch: create B, update A, delete A
      const result = await ug.applyProviderDelta(TEST_ACCOUNT_ID, [
        makeCreatedDelta({
          origin_event_id: "evt_b",
          event: {
            ...makeCreatedDelta().event!,
            origin_event_id: "evt_b",
            title: "Event B",
          },
        }),
        makeUpdatedDelta({ origin_event_id: "evt_a" }),
        makeDeletedDelta({ origin_event_id: "evt_a" }),
      ]);

      expect(result.created).toBe(1);
      expect(result.updated).toBe(1);
      expect(result.deleted).toBe(1);

      // Only event B should remain
      const events = db
        .prepare("SELECT * FROM canonical_events")
        .all() as Array<Record<string, unknown>>;
      expect(events).toHaveLength(1);
      expect(events[0].origin_event_id).toBe("evt_b");
    });

    it("handles all-day events correctly", async () => {
      const delta = makeCreatedDelta({
        origin_event_id: "evt_allday",
        event: {
          ...makeCreatedDelta().event!,
          origin_event_id: "evt_allday",
          title: "All Day Event",
          start: { date: "2026-02-15" },
          end: { date: "2026-02-16" },
          all_day: true,
        },
      });

      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [delta]);

      const events = db
        .prepare("SELECT * FROM canonical_events")
        .all() as Array<Record<string, unknown>>;
      expect(events[0].all_day).toBe(1);
      expect(events[0].start_ts).toBe("2026-02-15");

      // getCanonicalEvent should reconstruct all_day format
      const result = ug.getCanonicalEvent(events[0].canonical_event_id as string);
      expect(result!.event.all_day).toBe(true);
      expect(result!.event.start.date).toBe("2026-02-15");
      expect(result!.event.start.dateTime).toBeUndefined();
    });

    it("error in one delta does not stop processing of others", async () => {
      // Create a delta that will succeed and one that will fail
      // (created without event payload should fail)
      const goodDelta = makeCreatedDelta({ origin_event_id: "good_evt" });
      const badDelta: ProviderDelta = {
        type: "created",
        origin_event_id: "bad_evt",
        origin_account_id: TEST_ACCOUNT_ID,
        // Missing event payload -- should cause error
      };

      const result = await ug.applyProviderDelta(TEST_ACCOUNT_ID, [
        goodDelta,
        badDelta,
      ]);

      expect(result.created).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].origin_event_id).toBe("bad_evt");
    });
  });

  // -------------------------------------------------------------------------
  // Policy CRUD
  // -------------------------------------------------------------------------

  describe("createPolicy + getPolicy round-trip", () => {
    it("creates a policy and retrieves it with edges", async () => {
      const policy = await ug.createPolicy("My Custom Policy");

      expect(policy.policy_id).toMatch(/^pol_[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(policy.name).toBe("My Custom Policy");
      expect(policy.is_default).toBe(false);
      expect(policy.created_at).toBeDefined();

      // getPolicy should return policy with empty edges
      const fetched = await ug.getPolicy(policy.policy_id);
      expect(fetched).not.toBeNull();
      expect(fetched!.policy_id).toBe(policy.policy_id);
      expect(fetched!.name).toBe("My Custom Policy");
      expect(fetched!.edges).toHaveLength(0);
    });

    it("returns null for non-existent policy", async () => {
      // Trigger migration first
      ug.getSyncHealth();

      const fetched = await ug.getPolicy("pol_01NONEXISTENT0000000000000");
      expect(fetched).toBeNull();
    });
  });

  describe("listPolicies", () => {
    it("lists all policies", async () => {
      const p1 = await ug.createPolicy("Policy A");
      const p2 = await ug.createPolicy("Policy B");

      const policies = await ug.listPolicies();
      expect(policies).toHaveLength(2);

      const names = policies.map((p) => p.name);
      expect(names).toContain("Policy A");
      expect(names).toContain("Policy B");
    });

    it("returns empty array when no policies", async () => {
      // Trigger migration
      ug.getSyncHealth();

      const policies = await ug.listPolicies();
      expect(policies).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // setPolicyEdges -- replace all edges
  // -------------------------------------------------------------------------

  describe("setPolicyEdges", () => {
    it("replaces all edges for a policy", async () => {
      const policy = await ug.createPolicy("Test Policy");

      // Set initial edges
      await ug.setPolicyEdges(policy.policy_id, [
        {
          from_account_id: TEST_ACCOUNT_ID,
          to_account_id: OTHER_ACCOUNT_ID,
          detail_level: "BUSY",
          calendar_kind: "BUSY_OVERLAY",
        },
      ]);

      let fetched = await ug.getPolicy(policy.policy_id);
      expect(fetched!.edges).toHaveLength(1);
      expect(fetched!.edges[0].from_account_id).toBe(TEST_ACCOUNT_ID);
      expect(fetched!.edges[0].to_account_id).toBe(OTHER_ACCOUNT_ID);

      // Replace with different edges
      const THIRD_ACCOUNT_ID = "acc_01TESTACCOUNT0000000000003" as AccountId;
      await ug.setPolicyEdges(policy.policy_id, [
        {
          from_account_id: TEST_ACCOUNT_ID,
          to_account_id: THIRD_ACCOUNT_ID,
          detail_level: "TITLE",
          calendar_kind: "BUSY_OVERLAY",
        },
        {
          from_account_id: THIRD_ACCOUNT_ID,
          to_account_id: TEST_ACCOUNT_ID,
          detail_level: "FULL",
          calendar_kind: "TRUE_MIRROR",
        },
      ]);

      fetched = await ug.getPolicy(policy.policy_id);
      expect(fetched!.edges).toHaveLength(2);

      // Verify old edge is gone
      const oldEdge = fetched!.edges.find(
        (e) => e.to_account_id === OTHER_ACCOUNT_ID,
      );
      expect(oldEdge).toBeUndefined();

      // Verify new edges
      const edge1 = fetched!.edges.find(
        (e) =>
          e.from_account_id === TEST_ACCOUNT_ID &&
          e.to_account_id === THIRD_ACCOUNT_ID,
      );
      expect(edge1).toBeDefined();
      expect(edge1!.detail_level).toBe("TITLE");

      const edge2 = fetched!.edges.find(
        (e) =>
          e.from_account_id === THIRD_ACCOUNT_ID &&
          e.to_account_id === TEST_ACCOUNT_ID,
      );
      expect(edge2).toBeDefined();
      expect(edge2!.detail_level).toBe("FULL");
      expect(edge2!.calendar_kind).toBe("TRUE_MIRROR");
    });

    it("triggers recomputeProjections after setting edges", async () => {
      const policy = await ug.createPolicy("Projection Policy");

      // Create an event first (so there is something to project)
      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [makeCreatedDelta()]);

      // No edges yet, so no mirrors
      expect(queue.messages).toHaveLength(0);

      // Set edges -- should trigger recompute and enqueue mirrors
      await ug.setPolicyEdges(policy.policy_id, [
        {
          from_account_id: TEST_ACCOUNT_ID,
          to_account_id: OTHER_ACCOUNT_ID,
          detail_level: "BUSY",
          calendar_kind: "BUSY_OVERLAY",
        },
      ]);

      // recomputeProjections should have enqueued an UPSERT_MIRROR
      expect(queue.messages.length).toBeGreaterThanOrEqual(1);
      const upsertMsg = queue.messages.find(
        (m) => (m as Record<string, unknown>).type === "UPSERT_MIRROR",
      );
      expect(upsertMsg).toBeDefined();
      expect((upsertMsg as Record<string, unknown>).target_account_id).toBe(
        OTHER_ACCOUNT_ID,
      );
    });

    it("rejects self-loop edges (from === to)", async () => {
      const policy = await ug.createPolicy("Self Loop Policy");

      await expect(
        ug.setPolicyEdges(policy.policy_id, [
          {
            from_account_id: TEST_ACCOUNT_ID,
            to_account_id: TEST_ACCOUNT_ID,
            detail_level: "BUSY",
            calendar_kind: "BUSY_OVERLAY",
          },
        ]),
      ).rejects.toThrow(/self-loop/i);
    });

    it("rejects invalid detail_level", async () => {
      const policy = await ug.createPolicy("Invalid Detail Policy");

      await expect(
        ug.setPolicyEdges(policy.policy_id, [
          {
            from_account_id: TEST_ACCOUNT_ID,
            to_account_id: OTHER_ACCOUNT_ID,
            detail_level: "INVALID" as any,
            calendar_kind: "BUSY_OVERLAY",
          },
        ]),
      ).rejects.toThrow(/detail_level/i);
    });

    it("throws when policy does not exist", async () => {
      // Trigger migration
      ug.getSyncHealth();

      await expect(
        ug.setPolicyEdges("pol_01NONEXISTENT0000000000000", [
          {
            from_account_id: TEST_ACCOUNT_ID,
            to_account_id: OTHER_ACCOUNT_ID,
            detail_level: "BUSY",
            calendar_kind: "BUSY_OVERLAY",
          },
        ]),
      ).rejects.toThrow(/not found/i);
    });
  });

  // -------------------------------------------------------------------------
  // ensureDefaultPolicy
  // -------------------------------------------------------------------------

  describe("ensureDefaultPolicy", () => {
    it("creates bidirectional BUSY overlay edges between all accounts", async () => {
      await ug.ensureDefaultPolicy([TEST_ACCOUNT_ID, OTHER_ACCOUNT_ID]);

      // Should have 1 default policy
      const policies = await ug.listPolicies();
      expect(policies).toHaveLength(1);
      expect(policies[0].is_default).toBe(true);
      expect(policies[0].name).toBe("Default Policy");

      // Should have 2 edges (bidirectional)
      const policy = await ug.getPolicy(policies[0].policy_id);
      expect(policy!.edges).toHaveLength(2);

      // Edge: TEST_ACCOUNT -> OTHER_ACCOUNT
      const edge1 = policy!.edges.find(
        (e) =>
          e.from_account_id === TEST_ACCOUNT_ID &&
          e.to_account_id === OTHER_ACCOUNT_ID,
      );
      expect(edge1).toBeDefined();
      expect(edge1!.detail_level).toBe("BUSY");
      expect(edge1!.calendar_kind).toBe("BUSY_OVERLAY");

      // Edge: OTHER_ACCOUNT -> TEST_ACCOUNT
      const edge2 = policy!.edges.find(
        (e) =>
          e.from_account_id === OTHER_ACCOUNT_ID &&
          e.to_account_id === TEST_ACCOUNT_ID,
      );
      expect(edge2).toBeDefined();
      expect(edge2!.detail_level).toBe("BUSY");
      expect(edge2!.calendar_kind).toBe("BUSY_OVERLAY");
    });

    it("adding a third account extends default policy with new edges", async () => {
      const THIRD_ACCOUNT_ID = "acc_01TESTACCOUNT0000000000003" as AccountId;

      // Initial: 2 accounts
      await ug.ensureDefaultPolicy([TEST_ACCOUNT_ID, OTHER_ACCOUNT_ID]);

      // Add third account
      await ug.ensureDefaultPolicy([
        TEST_ACCOUNT_ID,
        OTHER_ACCOUNT_ID,
        THIRD_ACCOUNT_ID,
      ]);

      // Should still be 1 policy
      const policies = await ug.listPolicies();
      expect(policies).toHaveLength(1);

      // Should have 6 edges (3 accounts * 2 directions each pair = 3 pairs * 2 = 6)
      const policy = await ug.getPolicy(policies[0].policy_id);
      expect(policy!.edges).toHaveLength(6);

      // Check new edges involving THIRD_ACCOUNT
      const thirdEdges = policy!.edges.filter(
        (e) =>
          e.from_account_id === THIRD_ACCOUNT_ID ||
          e.to_account_id === THIRD_ACCOUNT_ID,
      );
      expect(thirdEdges).toHaveLength(4); // 2 to/from TEST, 2 to/from OTHER

      // All edges should be BUSY / BUSY_OVERLAY
      for (const edge of policy!.edges) {
        expect(edge.detail_level).toBe("BUSY");
        expect(edge.calendar_kind).toBe("BUSY_OVERLAY");
      }
    });

    it("is idempotent -- calling twice with same accounts does not duplicate edges", async () => {
      await ug.ensureDefaultPolicy([TEST_ACCOUNT_ID, OTHER_ACCOUNT_ID]);
      await ug.ensureDefaultPolicy([TEST_ACCOUNT_ID, OTHER_ACCOUNT_ID]);

      const policies = await ug.listPolicies();
      expect(policies).toHaveLength(1);

      const policy = await ug.getPolicy(policies[0].policy_id);
      expect(policy!.edges).toHaveLength(2);
    });

    it("does not create edges for a single account", async () => {
      await ug.ensureDefaultPolicy([TEST_ACCOUNT_ID]);

      const policies = await ug.listPolicies();
      expect(policies).toHaveLength(1);

      const policy = await ug.getPolicy(policies[0].policy_id);
      expect(policy!.edges).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // unlinkAccount -- cascade deletion
  // -------------------------------------------------------------------------

  describe("unlinkAccount", () => {
    const THIRD_ACCOUNT_ID = "acc_01TESTACCOUNT0000000000003" as AccountId;

    it("executes full unlink cascade: events, mirrors, policies, calendars, journal", async () => {
      // Setup: default policy with bidirectional edges between TEST and OTHER
      await ug.ensureDefaultPolicy([TEST_ACCOUNT_ID, OTHER_ACCOUNT_ID]);

      // Create events from TEST_ACCOUNT
      const delta1 = makeCreatedDelta({ origin_event_id: "evt_unlink_1" });
      const delta2 = makeCreatedDelta({
        origin_event_id: "evt_unlink_2",
        event: {
          ...makeCreatedDelta().event!,
          origin_event_id: "evt_unlink_2",
          title: "Second Event",
          start: { dateTime: "2026-02-16T09:00:00Z" },
          end: { dateTime: "2026-02-16T09:30:00Z" },
        },
      });
      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [delta1, delta2]);

      // Create events from OTHER_ACCOUNT (should NOT be deleted)
      const otherDelta = makeCreatedDelta({
        origin_event_id: "evt_other_1",
        origin_account_id: OTHER_ACCOUNT_ID,
        event: {
          ...makeCreatedDelta().event!,
          origin_account_id: OTHER_ACCOUNT_ID,
          origin_event_id: "evt_other_1",
          title: "Other Account Event",
          start: { dateTime: "2026-02-17T09:00:00Z" },
          end: { dateTime: "2026-02-17T09:30:00Z" },
        },
      });
      await ug.applyProviderDelta(OTHER_ACCOUNT_ID, [otherDelta]);

      // Insert a calendar entry for TEST_ACCOUNT
      db.prepare(
        `INSERT INTO calendars (calendar_id, account_id, provider_calendar_id, display_name)
         VALUES (?, ?, ?, ?)`,
      ).run(
        "cal_01TESTCALENDAR000000000001",
        TEST_ACCOUNT_ID,
        "primary",
        "Test Calendar",
      );

      // Clear queue so we only see unlink messages
      queue.clear();

      // Pre-assertions
      const preEvents = db
        .prepare("SELECT * FROM canonical_events")
        .all() as Array<Record<string, unknown>>;
      expect(preEvents).toHaveLength(3); // 2 from TEST + 1 from OTHER

      const preMirrors = db
        .prepare("SELECT * FROM event_mirrors")
        .all() as Array<Record<string, unknown>>;
      expect(preMirrors.length).toBeGreaterThan(0);

      // ACT: Unlink TEST_ACCOUNT
      const result = await ug.unlinkAccount(TEST_ACCOUNT_ID);

      expect(result.events_deleted).toBe(2);
      expect(result.mirrors_deleted).toBeGreaterThan(0);
      expect(result.policy_edges_removed).toBeGreaterThan(0);

      // Canonical events from TEST_ACCOUNT are gone (hard delete BR-7)
      const postEvents = db
        .prepare("SELECT * FROM canonical_events WHERE origin_account_id = ?")
        .all(TEST_ACCOUNT_ID);
      expect(postEvents).toHaveLength(0);

      // Other account's events remain
      const otherEvents = db
        .prepare("SELECT * FROM canonical_events WHERE origin_account_id = ?")
        .all(OTHER_ACCOUNT_ID);
      expect(otherEvents).toHaveLength(1);

      // All mirrors referencing TEST_ACCOUNT (as target) are gone
      const targetMirrors = db
        .prepare("SELECT * FROM event_mirrors WHERE target_account_id = ?")
        .all(TEST_ACCOUNT_ID);
      expect(targetMirrors).toHaveLength(0);

      // All mirrors from events belonging to TEST_ACCOUNT are gone
      // (because those canonical events were deleted)
      const sourceMirrors = db
        .prepare(
          `SELECT em.* FROM event_mirrors em
           WHERE em.canonical_event_id NOT IN (SELECT canonical_event_id FROM canonical_events)`,
        )
        .all();
      expect(sourceMirrors).toHaveLength(0);

      // Policy edges referencing TEST_ACCOUNT are gone
      const edges = db
        .prepare(
          "SELECT * FROM policy_edges WHERE from_account_id = ? OR to_account_id = ?",
        )
        .all(TEST_ACCOUNT_ID, TEST_ACCOUNT_ID);
      expect(edges).toHaveLength(0);

      // Calendar entries for TEST_ACCOUNT are gone
      const calendars = db
        .prepare("SELECT * FROM calendars WHERE account_id = ?")
        .all(TEST_ACCOUNT_ID);
      expect(calendars).toHaveLength(0);

      // Journal records the unlinking
      const journal = ug.queryJournal({ limit: 100 });
      const unlinkEntries = journal.items.filter(
        (j) => j.change_type === "account_unlinked",
      );
      expect(unlinkEntries.length).toBeGreaterThanOrEqual(1);
      expect(unlinkEntries[0].actor).toBe("system");
    });

    it("deletes canonical events from unlinked account (BR-7 hard delete)", async () => {
      // Create 3 events from TEST_ACCOUNT
      const deltas: ProviderDelta[] = [];
      for (let i = 0; i < 3; i++) {
        deltas.push(
          makeCreatedDelta({
            origin_event_id: `evt_harddel_${i}`,
            event: {
              ...makeCreatedDelta().event!,
              origin_event_id: `evt_harddel_${i}`,
              title: `Hard Delete Event ${i}`,
              start: { dateTime: `2026-02-15T${(8 + i).toString().padStart(2, "0")}:00:00Z` },
              end: { dateTime: `2026-02-15T${(8 + i).toString().padStart(2, "0")}:30:00Z` },
            },
          }),
        );
      }
      await ug.applyProviderDelta(TEST_ACCOUNT_ID, deltas);

      const preCnt = db
        .prepare("SELECT COUNT(*) as cnt FROM canonical_events WHERE origin_account_id = ?")
        .get(TEST_ACCOUNT_ID) as { cnt: number };
      expect(preCnt.cnt).toBe(3);

      await ug.unlinkAccount(TEST_ACCOUNT_ID);

      const postCnt = db
        .prepare("SELECT COUNT(*) as cnt FROM canonical_events WHERE origin_account_id = ?")
        .get(TEST_ACCOUNT_ID) as { cnt: number };
      expect(postCnt.cnt).toBe(0);
    });

    it("enqueues DELETE_MIRROR for mirrors FROM the unlinked account", async () => {
      // Setup policy edge so mirrors are created
      await ug.ensureDefaultPolicy([TEST_ACCOUNT_ID, OTHER_ACCOUNT_ID]);

      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [makeCreatedDelta()]);
      queue.clear();

      await ug.unlinkAccount(TEST_ACCOUNT_ID);

      // Should have enqueued DELETE_MIRROR messages
      const deleteMsgs = queue.messages.filter(
        (m) => (m as Record<string, unknown>).type === "DELETE_MIRROR",
      );
      expect(deleteMsgs.length).toBeGreaterThanOrEqual(1);

      // All should target OTHER_ACCOUNT (the mirror target)
      for (const msg of deleteMsgs) {
        const m = msg as Record<string, unknown>;
        expect(m.target_account_id).toBe(OTHER_ACCOUNT_ID);
      }
    });

    it("deletes mirrors TO the unlinked account (tombstoned on failure)", async () => {
      // Setup: OTHER_ACCOUNT events mirrored TO TEST_ACCOUNT
      await ug.ensureDefaultPolicy([TEST_ACCOUNT_ID, OTHER_ACCOUNT_ID]);

      await ug.applyProviderDelta(OTHER_ACCOUNT_ID, [
        makeCreatedDelta({
          origin_event_id: "evt_other_mirror",
          origin_account_id: OTHER_ACCOUNT_ID,
          event: {
            ...makeCreatedDelta().event!,
            origin_account_id: OTHER_ACCOUNT_ID,
            origin_event_id: "evt_other_mirror",
            title: "Other's Event",
          },
        }),
      ]);

      // Verify mirrors to TEST_ACCOUNT exist
      const preMirrors = db
        .prepare("SELECT * FROM event_mirrors WHERE target_account_id = ?")
        .all(TEST_ACCOUNT_ID);
      expect(preMirrors.length).toBeGreaterThan(0);

      queue.clear();
      await ug.unlinkAccount(TEST_ACCOUNT_ID);

      // Mirrors TO TEST_ACCOUNT should be deleted from DB
      const postMirrors = db
        .prepare("SELECT * FROM event_mirrors WHERE target_account_id = ?")
        .all(TEST_ACCOUNT_ID);
      expect(postMirrors).toHaveLength(0);

      // Other account's canonical event should still exist
      const otherEvents = db
        .prepare("SELECT * FROM canonical_events WHERE origin_account_id = ?")
        .all(OTHER_ACCOUNT_ID);
      expect(otherEvents).toHaveLength(1);
    });

    it("removes policy edges and triggers recomputeProjections", async () => {
      // Setup: 3 accounts with default policy (6 edges total)
      await ug.ensureDefaultPolicy([
        TEST_ACCOUNT_ID,
        OTHER_ACCOUNT_ID,
        THIRD_ACCOUNT_ID,
      ]);

      const preEdges = db
        .prepare("SELECT * FROM policy_edges")
        .all() as Array<Record<string, unknown>>;
      expect(preEdges).toHaveLength(6);

      // Create an event from THIRD_ACCOUNT that would mirror to TEST and OTHER
      await ug.applyProviderDelta(THIRD_ACCOUNT_ID, [
        makeCreatedDelta({
          origin_event_id: "evt_third_1",
          origin_account_id: THIRD_ACCOUNT_ID,
          event: {
            ...makeCreatedDelta().event!,
            origin_account_id: THIRD_ACCOUNT_ID,
            origin_event_id: "evt_third_1",
            title: "Third Account Event",
          },
        }),
      ]);

      queue.clear();

      // Unlink TEST_ACCOUNT
      await ug.unlinkAccount(TEST_ACCOUNT_ID);

      // Edges referencing TEST_ACCOUNT should be gone
      const postEdges = db
        .prepare(
          "SELECT * FROM policy_edges WHERE from_account_id = ? OR to_account_id = ?",
        )
        .all(TEST_ACCOUNT_ID, TEST_ACCOUNT_ID);
      expect(postEdges).toHaveLength(0);

      // Remaining edges should be only THIRD <-> OTHER (2 edges)
      const remainingEdges = db
        .prepare("SELECT * FROM policy_edges")
        .all() as Array<Record<string, unknown>>;
      expect(remainingEdges).toHaveLength(2);
    });

    it("creates journal entries recording the unlink", async () => {
      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [makeCreatedDelta()]);

      // Clear queue before unlink
      queue.clear();

      await ug.unlinkAccount(TEST_ACCOUNT_ID);

      // Check journal for the unlink entry
      const journal = ug.queryJournal({ limit: 100 });
      const unlinkEntries = journal.items.filter(
        (j) => j.change_type === "account_unlinked",
      );
      expect(unlinkEntries).toHaveLength(1);
      expect(unlinkEntries[0].actor).toBe("system");

      // Also verify individual event deletion journal entries exist
      const deleteEntries = journal.items.filter(
        (j) => j.change_type === "deleted",
      );
      expect(deleteEntries).toHaveLength(1); // 1 event was deleted
    });

    it("returns zero counts when account has no data", async () => {
      // Trigger migration
      ug.getSyncHealth();

      const result = await ug.unlinkAccount(TEST_ACCOUNT_ID);

      expect(result.events_deleted).toBe(0);
      expect(result.mirrors_deleted).toBe(0);
      expect(result.policy_edges_removed).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // handleFetch -- ReconcileWorkflow RPC endpoints
  // -------------------------------------------------------------------------

  describe("handleFetch: ReconcileWorkflow RPC endpoints", () => {
    // Helper to make a fetch request to handleFetch
    async function rpc(path: string, body: unknown): Promise<Response> {
      return ug.handleFetch(
        new Request(`https://user-graph.internal${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    }

    // -----------------------------------------------------------------------
    // /findCanonicalByOrigin
    // -----------------------------------------------------------------------

    describe("/findCanonicalByOrigin", () => {
      it("returns canonical event when found by origin keys", async () => {
        // Create a canonical event first
        await ug.applyProviderDelta(TEST_ACCOUNT_ID, [makeCreatedDelta()]);

        const resp = await rpc("/findCanonicalByOrigin", {
          origin_account_id: TEST_ACCOUNT_ID,
          origin_event_id: "google_evt_001",
        });

        expect(resp.status).toBe(200);
        const data = (await resp.json()) as { event: Record<string, unknown> | null };
        expect(data.event).not.toBeNull();
        expect(data.event!.canonical_event_id).toBeDefined();
        expect(data.event!.origin_account_id).toBe(TEST_ACCOUNT_ID);
        expect(data.event!.origin_event_id).toBe("google_evt_001");
        expect(data.event!.title).toBe("Team Standup");
      });

      it("returns null event when not found", async () => {
        // Trigger migration
        ug.getSyncHealth();

        const resp = await rpc("/findCanonicalByOrigin", {
          origin_account_id: TEST_ACCOUNT_ID,
          origin_event_id: "nonexistent_evt",
        });

        expect(resp.status).toBe(200);
        const data = (await resp.json()) as { event: null };
        expect(data.event).toBeNull();
      });
    });

    // -----------------------------------------------------------------------
    // /getPolicyEdges
    // -----------------------------------------------------------------------

    describe("/getPolicyEdges", () => {
      it("returns policy edges for a from_account_id", async () => {
        // Trigger migration
        ug.getSyncHealth();

        // Insert a policy edge directly
        insertPolicyEdge(db, {
          policyId: "pol_01TEST000000000000000000001",
          fromAccountId: TEST_ACCOUNT_ID,
          toAccountId: OTHER_ACCOUNT_ID,
          detailLevel: "BUSY",
          calendarKind: "BUSY_OVERLAY",
        });

        const resp = await rpc("/getPolicyEdges", {
          from_account_id: TEST_ACCOUNT_ID,
        });

        expect(resp.status).toBe(200);
        const data = (await resp.json()) as { edges: Array<Record<string, unknown>> };
        expect(data.edges).toHaveLength(1);
        expect(data.edges[0].from_account_id).toBe(TEST_ACCOUNT_ID);
        expect(data.edges[0].to_account_id).toBe(OTHER_ACCOUNT_ID);
        expect(data.edges[0].detail_level).toBe("BUSY");
        expect(data.edges[0].calendar_kind).toBe("BUSY_OVERLAY");
        expect(data.edges[0].policy_id).toBe("pol_01TEST000000000000000000001");
      });

      it("returns empty array when no edges exist for account", async () => {
        // Trigger migration
        ug.getSyncHealth();

        const resp = await rpc("/getPolicyEdges", {
          from_account_id: "acc_01NONEXISTENT000000000000",
        });

        expect(resp.status).toBe(200);
        const data = (await resp.json()) as { edges: Array<Record<string, unknown>> };
        expect(data.edges).toHaveLength(0);
      });

      it("returns multiple edges when multiple policies reference same from_account", async () => {
        // Trigger migration
        ug.getSyncHealth();

        const THIRD_ACCOUNT_ID = "acc_01TESTACCOUNT0000000000003" as AccountId;

        insertPolicyEdge(db, {
          policyId: "pol_01TEST000000000000000000001",
          fromAccountId: TEST_ACCOUNT_ID,
          toAccountId: OTHER_ACCOUNT_ID,
          detailLevel: "BUSY",
          calendarKind: "BUSY_OVERLAY",
        });
        insertPolicyEdge(db, {
          policyId: "pol_01TEST000000000000000000002",
          fromAccountId: TEST_ACCOUNT_ID,
          toAccountId: THIRD_ACCOUNT_ID,
          detailLevel: "TITLE",
          calendarKind: "BUSY_OVERLAY",
        });

        const resp = await rpc("/getPolicyEdges", {
          from_account_id: TEST_ACCOUNT_ID,
        });

        expect(resp.status).toBe(200);
        const data = (await resp.json()) as { edges: Array<Record<string, unknown>> };
        expect(data.edges).toHaveLength(2);
      });
    });

    // -----------------------------------------------------------------------
    // /getActiveMirrors
    // -----------------------------------------------------------------------

    describe("/getActiveMirrors", () => {
      it("returns ACTIVE mirrors targeting a specific account", async () => {
        // Trigger migration and set up policy edges
        ug.getSyncHealth();

        insertPolicyEdge(db, {
          policyId: "pol_01TEST000000000000000000001",
          fromAccountId: TEST_ACCOUNT_ID,
          toAccountId: OTHER_ACCOUNT_ID,
          detailLevel: "BUSY",
          calendarKind: "BUSY_OVERLAY",
        });

        // Create event with mirror
        await ug.applyProviderDelta(TEST_ACCOUNT_ID, [makeCreatedDelta()]);

        // Mirror is PENDING by default; update to ACTIVE
        const mirrors = db
          .prepare("SELECT * FROM event_mirrors WHERE target_account_id = ?")
          .all(OTHER_ACCOUNT_ID) as Array<Record<string, unknown>>;
        expect(mirrors).toHaveLength(1);

        db.prepare(
          "UPDATE event_mirrors SET state = 'ACTIVE', provider_event_id = 'google_mirror_999' WHERE target_account_id = ?",
        ).run(OTHER_ACCOUNT_ID);

        const resp = await rpc("/getActiveMirrors", {
          target_account_id: OTHER_ACCOUNT_ID,
        });

        expect(resp.status).toBe(200);
        const data = (await resp.json()) as { mirrors: Array<Record<string, unknown>> };
        expect(data.mirrors).toHaveLength(1);
        expect(data.mirrors[0].target_account_id).toBe(OTHER_ACCOUNT_ID);
        expect(data.mirrors[0].state).toBe("ACTIVE");
        expect(data.mirrors[0].provider_event_id).toBe("google_mirror_999");
      });

      it("returns empty array when no ACTIVE mirrors exist", async () => {
        // Trigger migration
        ug.getSyncHealth();

        const resp = await rpc("/getActiveMirrors", {
          target_account_id: OTHER_ACCOUNT_ID,
        });

        expect(resp.status).toBe(200);
        const data = (await resp.json()) as { mirrors: Array<Record<string, unknown>> };
        expect(data.mirrors).toHaveLength(0);
      });

      it("excludes non-ACTIVE mirrors (PENDING, ERROR, TOMBSTONED)", async () => {
        ug.getSyncHealth();

        insertPolicyEdge(db, {
          policyId: "pol_01TEST000000000000000000001",
          fromAccountId: TEST_ACCOUNT_ID,
          toAccountId: OTHER_ACCOUNT_ID,
        });

        // Create event with a PENDING mirror
        await ug.applyProviderDelta(TEST_ACCOUNT_ID, [makeCreatedDelta()]);

        // Mirror should be PENDING by default
        const mirrors = db
          .prepare("SELECT * FROM event_mirrors WHERE target_account_id = ?")
          .all(OTHER_ACCOUNT_ID) as Array<Record<string, unknown>>;
        expect(mirrors).toHaveLength(1);
        expect(mirrors[0].state).toBe("PENDING");

        const resp = await rpc("/getActiveMirrors", {
          target_account_id: OTHER_ACCOUNT_ID,
        });

        expect(resp.status).toBe(200);
        const data = (await resp.json()) as { mirrors: Array<Record<string, unknown>> };
        expect(data.mirrors).toHaveLength(0); // PENDING is not ACTIVE
      });
    });

    // -----------------------------------------------------------------------
    // /logReconcileDiscrepancy
    // -----------------------------------------------------------------------

    describe("/logReconcileDiscrepancy", () => {
      it("writes a journal entry for a drift discrepancy", async () => {
        // Trigger migration
        ug.getSyncHealth();

        const resp = await rpc("/logReconcileDiscrepancy", {
          canonical_event_id: "evt_01RECONCILE000000000000001",
          discrepancy_type: "missing_canonical",
          details: {
            origin_event_id: "google_evt_missing",
            account_id: TEST_ACCOUNT_ID,
          },
        });

        expect(resp.status).toBe(200);
        const data = (await resp.json()) as { ok: boolean };
        expect(data.ok).toBe(true);

        // Verify journal entry was created
        const journal = ug.queryJournal();
        expect(journal.items).toHaveLength(1);
        expect(journal.items[0].canonical_event_id).toBe("evt_01RECONCILE000000000000001");
        expect(journal.items[0].change_type).toBe("reconcile:missing_canonical");
        expect(journal.items[0].actor).toBe("reconcile");

        // Verify details are stored in patch_json
        const patch = JSON.parse(journal.items[0].patch_json!);
        expect(patch.origin_event_id).toBe("google_evt_missing");
        expect(patch.account_id).toBe(TEST_ACCOUNT_ID);
      });

      it("writes separate journal entries for different discrepancy types", async () => {
        ug.getSyncHealth();

        // Log two discrepancies
        await rpc("/logReconcileDiscrepancy", {
          canonical_event_id: "evt_01RECONCILE000000000000001",
          discrepancy_type: "orphaned_mirror",
          details: { provider_event_id: "google_orphan_1" },
        });

        await rpc("/logReconcileDiscrepancy", {
          canonical_event_id: "evt_01RECONCILE000000000000002",
          discrepancy_type: "stale_mirror",
          details: { provider_event_id: "google_stale_1" },
        });

        const journal = ug.queryJournal();
        expect(journal.items).toHaveLength(2);

        const types = journal.items.map((j) => j.change_type);
        expect(types).toContain("reconcile:orphaned_mirror");
        expect(types).toContain("reconcile:stale_mirror");
      });
    });

    // -----------------------------------------------------------------------
    // handleFetch: existing endpoint /recomputeProjections (reconcile uses it)
    // -----------------------------------------------------------------------

    describe("/recomputeProjections via handleFetch", () => {
      it("is accessible via handleFetch and returns enqueued count", async () => {
        ug.getSyncHealth();

        insertPolicyEdge(db, {
          policyId: "pol_01TEST000000000000000000001",
          fromAccountId: TEST_ACCOUNT_ID,
          toAccountId: OTHER_ACCOUNT_ID,
        });

        // Create an event
        await ug.applyProviderDelta(TEST_ACCOUNT_ID, [makeCreatedDelta()]);
        queue.clear();

        // Change policy so hash differs
        db.prepare(`UPDATE policy_edges SET detail_level = 'TITLE'`).run();

        // Get event ID for scoped recompute
        const events = db
          .prepare("SELECT canonical_event_id FROM canonical_events")
          .all() as Array<{ canonical_event_id: string }>;

        const resp = await rpc("/recomputeProjections", {
          canonical_event_id: events[0].canonical_event_id,
        });

        expect(resp.status).toBe(200);
        const data = (await resp.json()) as { enqueued: number };
        expect(data.enqueued).toBe(1);
      });
    });
  });
});
