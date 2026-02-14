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
});
