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
import { UserGraphDO, mergeIntervals, computeFreeIntervals, expandWorkingHoursToOutsideBusy, expandBuffersToBusy } from "./index";
import type { QueueLike, BusyInterval, FreeInterval, AvailabilityQuery, AvailabilityResult, Constraint, WorkingHoursConfig, BufferConfig } from "./index";

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

function insertCalendar(
  db: DatabaseType,
  opts: {
    calendarId: string;
    accountId: string;
    providerCalendarId: string;
    role?: string;
    kind?: string;
    displayName?: string;
  },
): void {
  db.prepare(
    `INSERT INTO calendars (calendar_id, account_id, provider_calendar_id, role, kind, display_name)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.calendarId,
    opts.accountId,
    opts.providerCalendarId,
    opts.role ?? "primary",
    opts.kind ?? "PRIMARY",
    opts.displayName ?? null,
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
  // applyProviderDelta -- event deduplication (TM-sqr4)
  // -------------------------------------------------------------------------

  describe("applyProviderDelta event deduplication", () => {
    it("deduplicates when same 'created' delta is applied twice for same origin keys", async () => {
      const delta = makeCreatedDelta();

      // First apply -- should insert
      const result1 = await ug.applyProviderDelta(TEST_ACCOUNT_ID, [delta]);
      expect(result1.created).toBe(1);
      expect(result1.errors).toHaveLength(0);

      // Second apply with same origin_event_id -- should NOT crash, should update
      const result2 = await ug.applyProviderDelta(TEST_ACCOUNT_ID, [delta]);
      expect(result2.created).toBe(1); // Counter still reports delta type
      expect(result2.errors).toHaveLength(0);

      // Only ONE canonical event should exist (not two)
      const events = db
        .prepare("SELECT * FROM canonical_events")
        .all() as Array<Record<string, unknown>>;
      expect(events).toHaveLength(1);
      expect(events[0].origin_event_id).toBe("google_evt_001");
      expect(events[0].title).toBe("Team Standup");
      // Version should be bumped because dedup performed an update
      expect(events[0].version).toBe(2);
    });

    it("preserves canonical_event_id on dedup (Invariant B: ULID stable)", async () => {
      const delta = makeCreatedDelta();

      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [delta]);

      const eventsBefore = db
        .prepare("SELECT canonical_event_id FROM canonical_events")
        .all() as Array<{ canonical_event_id: string }>;
      const originalId = eventsBefore[0].canonical_event_id;

      // Apply same delta again
      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [delta]);

      const eventsAfter = db
        .prepare("SELECT canonical_event_id FROM canonical_events")
        .all() as Array<{ canonical_event_id: string }>;
      expect(eventsAfter).toHaveLength(1);
      // canonical_event_id must be the SAME (not a new ULID)
      expect(eventsAfter[0].canonical_event_id).toBe(originalId);
    });

    it("updates event data on dedup when payload differs", async () => {
      const delta1 = makeCreatedDelta();
      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [delta1]);

      // Second "created" delta with updated title and time
      const delta2 = makeCreatedDelta({
        event: {
          ...makeCreatedDelta().event!,
          title: "Team Standup v2",
          start: { dateTime: "2026-02-15T11:00:00Z" },
          end: { dateTime: "2026-02-15T11:30:00Z" },
        },
      });
      const result = await ug.applyProviderDelta(TEST_ACCOUNT_ID, [delta2]);
      expect(result.errors).toHaveLength(0);

      const events = db
        .prepare("SELECT * FROM canonical_events")
        .all() as Array<Record<string, unknown>>;
      expect(events).toHaveLength(1);
      expect(events[0].title).toBe("Team Standup v2");
      expect(events[0].start_ts).toBe("2026-02-15T11:00:00Z");
    });

    it("writes dedup journal entry on duplicate create", async () => {
      const delta = makeCreatedDelta();

      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [delta]);
      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [delta]);

      const journal = db
        .prepare("SELECT * FROM event_journal ORDER BY journal_id")
        .all() as Array<Record<string, unknown>>;
      // First entry: "created", second entry: "updated" (dedup)
      expect(journal).toHaveLength(2);
      expect(journal[0].change_type).toBe("created");
      expect(journal[1].change_type).toBe("updated");

      // The dedup journal entry should note it was a dedup
      const patchJson = JSON.parse(journal[1].patch_json as string);
      expect(patchJson.dedup).toBe(true);
    });

    it("handles batch with mixed new and duplicate events", async () => {
      // Insert first event
      const delta1 = makeCreatedDelta({ origin_event_id: "google_evt_001" });
      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [delta1]);

      // Batch with duplicate of first + new second
      const delta1Again = makeCreatedDelta({ origin_event_id: "google_evt_001" });
      const delta2 = makeCreatedDelta({
        origin_event_id: "google_evt_002",
        event: {
          ...makeCreatedDelta().event!,
          origin_event_id: "google_evt_002",
          title: "Lunch Break",
        },
      });
      const result = await ug.applyProviderDelta(TEST_ACCOUNT_ID, [
        delta1Again,
        delta2,
      ]);

      expect(result.created).toBe(2); // Both processed as "created" deltas
      expect(result.errors).toHaveLength(0);

      // Should have exactly 2 events (not 3)
      const events = db
        .prepare("SELECT * FROM canonical_events ORDER BY origin_event_id")
        .all() as Array<Record<string, unknown>>;
      expect(events).toHaveLength(2);
      expect(events[0].origin_event_id).toBe("google_evt_001");
      expect(events[1].origin_event_id).toBe("google_evt_002");
    });

    it("does not create duplicates from different account for same origin_event_id", async () => {
      // Two different accounts syncing the same provider event ID
      // (this is the legitimate case where the same Google event shows
      // up via two different accounts)
      const delta1 = makeCreatedDelta({
        origin_account_id: TEST_ACCOUNT_ID,
        origin_event_id: "shared_evt_001",
        event: {
          ...makeCreatedDelta().event!,
          origin_account_id: TEST_ACCOUNT_ID,
          origin_event_id: "shared_evt_001",
          title: "Shared Meeting",
        },
      });
      const delta2 = makeCreatedDelta({
        origin_account_id: OTHER_ACCOUNT_ID,
        origin_event_id: "shared_evt_001",
        event: {
          ...makeCreatedDelta().event!,
          origin_account_id: OTHER_ACCOUNT_ID,
          origin_event_id: "shared_evt_001",
          title: "Shared Meeting",
        },
      });

      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [delta1]);
      await ug.applyProviderDelta(OTHER_ACCOUNT_ID, [delta2]);

      // These ARE different origin keys (different account_id), so two events
      // is correct. The dedup only prevents duplicates within the same account.
      const events = db
        .prepare("SELECT * FROM canonical_events ORDER BY origin_account_id")
        .all() as Array<Record<string, unknown>>;
      expect(events).toHaveLength(2);
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

    it("rebinds orphaned legacy origin account on update (prevents stale twins)", async () => {
      const sharedOriginId = "legacy_rebind_update_001";

      // Ensure schema is created before direct table inserts.
      ug.getSyncHealth();

      // Rebind only activates for accounts with calendar metadata.
      insertCalendar(db, {
        calendarId: "cal_test_primary_for_rebind_update",
        accountId: TEST_ACCOUNT_ID,
        providerCalendarId: "primary",
      });

      // Seed a legacy event under a now-orphaned account ID.
      await ug.applyProviderDelta(OTHER_ACCOUNT_ID, [
        makeCreatedDelta({
          origin_account_id: OTHER_ACCOUNT_ID,
          origin_event_id: sharedOriginId,
          event: {
            ...makeCreatedDelta().event!,
            origin_account_id: OTHER_ACCOUNT_ID,
            origin_event_id: sharedOriginId,
            title: "Legacy Copy",
          },
        }),
      ]);

      // Update arrives from the current account for the same provider event.
      const result = await ug.applyProviderDelta(TEST_ACCOUNT_ID, [
        makeUpdatedDelta({
          origin_account_id: TEST_ACCOUNT_ID,
          origin_event_id: sharedOriginId,
          event: {
            ...makeUpdatedDelta().event!,
            origin_account_id: TEST_ACCOUNT_ID,
            origin_event_id: sharedOriginId,
            title: "Current Truth",
          },
        }),
      ]);

      expect(result.updated).toBe(1);
      expect(result.errors).toHaveLength(0);

      const events = db
        .prepare("SELECT origin_account_id, title FROM canonical_events WHERE origin_event_id = ?")
        .all(sharedOriginId) as Array<{ origin_account_id: string; title: string }>;
      expect(events).toHaveLength(1);
      expect(events[0].origin_account_id).toBe(TEST_ACCOUNT_ID);
      expect(events[0].title).toBe("Current Truth");

      const journal = db
        .prepare("SELECT patch_json FROM event_journal ORDER BY rowid DESC LIMIT 1")
        .get() as { patch_json: string };
      const patch = JSON.parse(journal.patch_json) as Record<string, unknown>;
      expect(patch.legacy_rebind_from).toBe(OTHER_ACCOUNT_ID);
    });

    it("does not rebind when matching origin_event_id belongs to a non-orphan account", async () => {
      const sharedOriginId = "shared_non_orphan_001";

      await ug.applyProviderDelta(OTHER_ACCOUNT_ID, [
        makeCreatedDelta({
          origin_account_id: OTHER_ACCOUNT_ID,
          origin_event_id: sharedOriginId,
          event: {
            ...makeCreatedDelta().event!,
            origin_account_id: OTHER_ACCOUNT_ID,
            origin_event_id: sharedOriginId,
          },
        }),
      ]);

      // Mark OTHER_ACCOUNT_ID as active in graph metadata (calendar row present).
      insertCalendar(db, {
        calendarId: "cal_other_primary",
        accountId: OTHER_ACCOUNT_ID,
        providerCalendarId: "primary",
      });

      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [
        makeUpdatedDelta({
          origin_account_id: TEST_ACCOUNT_ID,
          origin_event_id: sharedOriginId,
          event: {
            ...makeUpdatedDelta().event!,
            origin_account_id: TEST_ACCOUNT_ID,
            origin_event_id: sharedOriginId,
            title: "Second Account Copy",
          },
        }),
      ]);

      const events = db
        .prepare("SELECT origin_account_id FROM canonical_events WHERE origin_event_id = ? ORDER BY origin_account_id")
        .all(sharedOriginId) as Array<{ origin_account_id: string }>;
      expect(events).toHaveLength(2);
      const owners = events.map((e) => e.origin_account_id).sort();
      expect(owners).toEqual([OTHER_ACCOUNT_ID, TEST_ACCOUNT_ID].sort());
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

    it("deletes orphaned legacy copy when delete arrives from current account", async () => {
      const sharedOriginId = "legacy_rebind_delete_001";

      // Ensure schema is created before direct table inserts.
      ug.getSyncHealth();

      // Rebind only activates for accounts with calendar metadata.
      insertCalendar(db, {
        calendarId: "cal_test_primary_for_rebind_delete",
        accountId: TEST_ACCOUNT_ID,
        providerCalendarId: "primary",
      });

      await ug.applyProviderDelta(OTHER_ACCOUNT_ID, [
        makeCreatedDelta({
          origin_account_id: OTHER_ACCOUNT_ID,
          origin_event_id: sharedOriginId,
          event: {
            ...makeCreatedDelta().event!,
            origin_account_id: OTHER_ACCOUNT_ID,
            origin_event_id: sharedOriginId,
          },
        }),
      ]);

      const result = await ug.applyProviderDelta(TEST_ACCOUNT_ID, [
        makeDeletedDelta({
          origin_account_id: TEST_ACCOUNT_ID,
          origin_event_id: sharedOriginId,
        }),
      ]);

      expect(result.deleted).toBe(1);
      expect(result.errors).toHaveLength(0);

      const events = db
        .prepare("SELECT canonical_event_id FROM canonical_events WHERE origin_event_id = ?")
        .all(sharedOriginId);
      expect(events).toHaveLength(0);

      const journal = db
        .prepare("SELECT patch_json FROM event_journal ORDER BY rowid DESC LIMIT 1")
        .get() as { patch_json: string };
      const patch = JSON.parse(journal.patch_json) as Record<string, unknown>;
      expect(patch.legacy_rebind_from).toBe(OTHER_ACCOUNT_ID);
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

    it("filters by origin_event_id (exact match)", async () => {
      const delta1 = makeCreatedDelta({
        origin_event_id: "google_evt_abc",
        event: {
          ...makeCreatedDelta().event!,
          origin_event_id: "google_evt_abc",
          title: "Target Event",
        },
      });
      const delta2 = makeCreatedDelta({
        origin_event_id: "google_evt_def",
        event: {
          ...makeCreatedDelta().event!,
          origin_event_id: "google_evt_def",
          title: "Other Event",
          start: { dateTime: "2026-02-15T10:00:00Z" },
          end: { dateTime: "2026-02-15T10:30:00Z" },
        },
      });

      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [delta1, delta2]);

      const result = ug.listCanonicalEvents({
        origin_event_id: "google_evt_abc",
      });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].title).toBe("Target Event");
      expect(result.items[0].origin_event_id).toBe("google_evt_abc");
    });

    it("filters by updated_after timestamp", async () => {
      // Create two events -- both get created_at/updated_at = datetime('now')
      const delta1 = makeCreatedDelta({
        origin_event_id: "evt_old",
        event: {
          ...makeCreatedDelta().event!,
          origin_event_id: "evt_old",
          title: "Old Event",
        },
      });
      const delta2 = makeCreatedDelta({
        origin_event_id: "evt_new",
        event: {
          ...makeCreatedDelta().event!,
          origin_event_id: "evt_new",
          title: "New Event",
          start: { dateTime: "2026-02-15T10:00:00Z" },
          end: { dateTime: "2026-02-15T10:30:00Z" },
        },
      });

      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [delta1, delta2]);

      // All events were just created, so updated_after = a past timestamp
      // should return all of them
      const resultAll = ug.listCanonicalEvents({
        updated_after: "2020-01-01T00:00:00Z",
      });
      expect(resultAll.items).toHaveLength(2);

      // A future timestamp should return none
      const resultNone = ug.listCanonicalEvents({
        updated_after: "2099-01-01T00:00:00Z",
      });
      expect(resultNone.items).toHaveLength(0);
    });

    it("filters by source", async () => {
      // Provider events are created via applyProviderDelta (source = "provider")
      const delta = makeCreatedDelta({
        origin_event_id: "evt_provider",
        event: {
          ...makeCreatedDelta().event!,
          origin_event_id: "evt_provider",
          title: "Provider Event",
        },
      });

      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [delta]);

      // Create a user-initiated event via upsertCanonicalEvent (source = "api")
      await ug.upsertCanonicalEvent(
        {
          canonical_event_id: "evt_01HXYZ00000000000000000099" as import("@tminus/shared").EventId,
          origin_account_id: TEST_ACCOUNT_ID,
          origin_event_id: "evt_api",
          title: "API Event",
          start: { dateTime: "2026-02-15T11:00:00Z" },
          end: { dateTime: "2026-02-15T11:30:00Z" },
          all_day: false,
          status: "confirmed",
          visibility: "default",
          transparency: "opaque",
          source: "ui",
          version: 1,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        "api",
      );

      // Filter for provider-only events
      const providerResult = ug.listCanonicalEvents({ source: "provider" });
      expect(providerResult.items).toHaveLength(1);
      expect(providerResult.items[0].title).toBe("Provider Event");

      // All events (no source filter)
      const allResult = ug.listCanonicalEvents({});
      expect(allResult.items.length).toBeGreaterThanOrEqual(2);
    });

    it("combines multiple filters", async () => {
      const delta1 = makeCreatedDelta({
        origin_event_id: "evt_combo_1",
        event: {
          ...makeCreatedDelta().event!,
          origin_event_id: "evt_combo_1",
          title: "Morning Provider Event",
          start: { dateTime: "2026-02-15T08:00:00Z" },
          end: { dateTime: "2026-02-15T09:00:00Z" },
        },
      });
      const delta2 = makeCreatedDelta({
        origin_event_id: "evt_combo_2",
        event: {
          ...makeCreatedDelta().event!,
          origin_event_id: "evt_combo_2",
          title: "Afternoon Provider Event",
          start: { dateTime: "2026-02-15T14:00:00Z" },
          end: { dateTime: "2026-02-15T15:00:00Z" },
        },
      });

      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [delta1, delta2]);

      // Combine origin_event_id + time range
      const result = ug.listCanonicalEvents({
        origin_event_id: "evt_combo_1",
        time_min: "2026-02-15T07:00:00Z",
        time_max: "2026-02-15T10:00:00Z",
      });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].title).toBe("Morning Provider Event");

      // Combine with non-matching time range -- should return empty
      const resultEmpty = ug.listCanonicalEvents({
        origin_event_id: "evt_combo_1",
        time_min: "2026-02-15T12:00:00Z",
        time_max: "2026-02-15T16:00:00Z",
      });
      expect(resultEmpty.items).toHaveLength(0);
    });

    it("returns empty when origin_event_id does not exist", async () => {
      const delta = makeCreatedDelta();
      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [delta]);

      const result = ug.listCanonicalEvents({
        origin_event_id: "nonexistent_event_id",
      });

      expect(result.items).toHaveLength(0);
      expect(result.has_more).toBe(false);
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

    it("force_requeue_non_active re-enqueues unchanged non-active mirrors", async () => {
      ug.getSyncHealth();

      insertPolicyEdge(db, {
        policyId: "pol_01TEST000000000000000000001",
        fromAccountId: TEST_ACCOUNT_ID,
        toAccountId: OTHER_ACCOUNT_ID,
      });

      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [makeCreatedDelta()]);
      expect(queue.messages).toHaveLength(1); // initial enqueue
      queue.clear();

      // Mirror remains non-ACTIVE until write-consumer processes it.
      const mirrors = db
        .prepare(
          `SELECT state FROM event_mirrors
           WHERE target_account_id = ?`,
        )
        .all(OTHER_ACCOUNT_ID) as Array<{ state: string }>;
      expect(mirrors).toHaveLength(1);
      expect(mirrors[0].state).toBe("PENDING");

      // Default recompute keeps write-skipping behavior for unchanged hashes.
      const skipped = await ug.recomputeProjections();
      expect(skipped).toBe(0);
      expect(queue.messages).toHaveLength(0);

      // Forced recompute re-enqueues unchanged non-ACTIVE mirrors.
      const forced = await ug.recomputeProjections({
        force_requeue_non_active: true,
      });
      expect(forced).toBe(1);
      expect(queue.messages).toHaveLength(1);
      const msg = queue.messages[0] as Record<string, unknown>;
      expect(msg.type).toBe("UPSERT_MIRROR");
      expect(msg.target_account_id).toBe(OTHER_ACCOUNT_ID);
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

    it("generates canonical_event_id when not provided (API-created event)", async () => {
      // Simulates what happens when POST /v1/events forwards raw user body
      // without canonical_event_id, origin_account_id, or origin_event_id
      const apiEvent = {
        title: "API Created Event",
        start: { dateTime: "2026-02-20T14:00:00Z" },
        end: { dateTime: "2026-02-20T15:00:00Z" },
        all_day: false,
        status: "confirmed" as const,
        visibility: "default" as const,
        transparency: "opaque" as const,
      };

      const id = await ug.upsertCanonicalEvent(apiEvent as any, "api");

      // Must return a valid evt_ prefixed ID
      expect(id).toBeTruthy();
      expect(id).toMatch(/^evt_/);

      // Must be retrievable
      const result = ug.getCanonicalEvent(id);
      expect(result).not.toBeNull();
      expect(result!.event.title).toBe("API Created Event");
      expect(result!.event.canonical_event_id).toBe(id);
      // origin_account_id defaults to "api" when not provided
      expect(result!.event.origin_account_id).toBe("api");
      // source defaults to the source parameter when event.source is not set
      expect(result!.event.source).toBe("api");

      // Journal should record creation
      const journal = ug.queryJournal();
      const createEntry = journal.items.find(
        (j: any) => j.canonical_event_id === id && j.change_type === "created",
      );
      expect(createEntry).toBeDefined();
      expect(createEntry!.actor).toBe("api");
    });

    it("uses provided canonical_event_id when present (backward compatibility)", async () => {
      const event = {
        canonical_event_id: "evt_01COMPAT000000000000000001",
        origin_account_id: TEST_ACCOUNT_ID,
        origin_event_id: "compat_001",
        title: "Compat Event",
        start: { dateTime: "2026-02-20T16:00:00Z" },
        end: { dateTime: "2026-02-20T17:00:00Z" },
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

      // Must use the provided ID, not generate a new one
      expect(id).toBe("evt_01COMPAT000000000000000001");

      const result = ug.getCanonicalEvent(id);
      expect(result).not.toBeNull();
      expect(result!.event.origin_account_id).toBe(TEST_ACCOUNT_ID);
      expect(result!.event.origin_event_id).toBe("compat_001");
    });

    it("creates then updates API event via upsert", async () => {
      // Create without IDs (API path)
      const apiEvent = {
        title: "Will Be Updated",
        start: { dateTime: "2026-02-21T09:00:00Z" },
        end: { dateTime: "2026-02-21T10:00:00Z" },
        all_day: false,
        status: "confirmed" as const,
        visibility: "default" as const,
        transparency: "opaque" as const,
      };

      const id = await ug.upsertCanonicalEvent(apiEvent as any, "api");
      expect(id).toMatch(/^evt_/);

      // Now update using the returned ID (like PATCH /v1/events/:id does)
      const updateEvent = {
        canonical_event_id: id,
        title: "Updated Via Patch",
        start: { dateTime: "2026-02-21T09:00:00Z" },
        end: { dateTime: "2026-02-21T10:00:00Z" },
        all_day: false,
        status: "confirmed" as const,
        visibility: "default" as const,
        transparency: "opaque" as const,
      };

      const updatedId = await ug.upsertCanonicalEvent(updateEvent as any, "api");
      expect(updatedId).toBe(id);

      const result = ug.getCanonicalEvent(id);
      expect(result!.event.title).toBe("Updated Via Patch");
      expect(result!.event.version).toBe(2);
    });

    it("does not crash when start/end are omitted (TM-8diu defensive guard)", async () => {
      // Create a full event first
      const fullEvent = {
        canonical_event_id: "evt_01PARTIAL0000000000000001",
        origin_account_id: TEST_ACCOUNT_ID,
        origin_event_id: "partial_001",
        title: "Original Title",
        start: { dateTime: "2026-03-01T09:00:00Z" },
        end: { dateTime: "2026-03-01T10:00:00Z" },
        all_day: false,
        status: "confirmed" as const,
        visibility: "default" as const,
        transparency: "opaque" as const,
        source: "api" as const,
        version: 1,
        created_at: "2026-02-14T00:00:00Z",
        updated_at: "2026-02-14T00:00:00Z",
      };
      await ug.upsertCanonicalEvent(fullEvent as any, "api");

      // Upsert with partial body (title only, no start/end) -- should NOT throw
      const partialEvent = {
        canonical_event_id: "evt_01PARTIAL0000000000000001",
        title: "Updated Title Only",
      };
      const updatedId = await ug.upsertCanonicalEvent(partialEvent as any, "api");
      expect(updatedId).toBe("evt_01PARTIAL0000000000000001");

      // Title should be updated, start/end become empty (the handler merges;
      // this test verifies the DO does not crash even without the merge).
      const result = ug.getCanonicalEvent(updatedId);
      expect(result).not.toBeNull();
      expect(result!.event.title).toBe("Updated Title Only");
      expect(result!.event.version).toBe(2);
    });

    it("creates event without start/end (defensive guard, insert path)", async () => {
      // Simulates worst case: completely missing start/end on insert.
      // Should not throw TypeError; fields default to empty strings.
      const minimalEvent = {
        title: "No Times Event",
        all_day: false,
        status: "confirmed" as const,
        visibility: "default" as const,
        transparency: "opaque" as const,
      };

      const id = await ug.upsertCanonicalEvent(minimalEvent as any, "api");
      expect(id).toMatch(/^evt_/);

      const result = ug.getCanonicalEvent(id);
      expect(result).not.toBeNull();
      expect(result!.event.title).toBe("No Times Event");
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

    it("preserves customized existing edges when extending defaults", async () => {
      const THIRD_ACCOUNT_ID = "acc_01TESTACCOUNT0000000000003" as AccountId;

      await ug.ensureDefaultPolicy([TEST_ACCOUNT_ID, OTHER_ACCOUNT_ID]);
      const initialPolicy = (await ug.listPolicies())[0];

      // Simulate user customization away from BUSY defaults.
      await ug.setPolicyEdges(initialPolicy.policy_id, [
        {
          from_account_id: TEST_ACCOUNT_ID,
          to_account_id: OTHER_ACCOUNT_ID,
          detail_level: "TITLE",
          calendar_kind: "BUSY_OVERLAY",
        },
        {
          from_account_id: OTHER_ACCOUNT_ID,
          to_account_id: TEST_ACCOUNT_ID,
          detail_level: "FULL",
          calendar_kind: "TRUE_MIRROR",
        },
      ]);

      // Add a third account. Existing custom edges must not be reset.
      await ug.ensureDefaultPolicy([
        TEST_ACCOUNT_ID,
        OTHER_ACCOUNT_ID,
        THIRD_ACCOUNT_ID,
      ]);

      const policy = await ug.getPolicy(initialPolicy.policy_id);
      expect(policy!.edges).toHaveLength(6);

      const aToB = policy!.edges.find(
        (e) =>
          e.from_account_id === TEST_ACCOUNT_ID &&
          e.to_account_id === OTHER_ACCOUNT_ID,
      );
      expect(aToB?.detail_level).toBe("TITLE");
      expect(aToB?.calendar_kind).toBe("BUSY_OVERLAY");

      const bToA = policy!.edges.find(
        (e) =>
          e.from_account_id === OTHER_ACCOUNT_ID &&
          e.to_account_id === TEST_ACCOUNT_ID,
      );
      expect(bToA?.detail_level).toBe("FULL");
      expect(bToA?.calendar_kind).toBe("TRUE_MIRROR");

      // Newly added account links should get BUSY defaults.
      const edgeWithThird = policy!.edges.filter(
        (e) =>
          e.from_account_id === THIRD_ACCOUNT_ID ||
          e.to_account_id === THIRD_ACCOUNT_ID,
      );
      expect(edgeWithThird).toHaveLength(4);
      for (const edge of edgeWithThird) {
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

    async function rpcGet(path: string): Promise<Response> {
      return ug.handleFetch(
        new Request(`https://user-graph.internal${path}`, {
          method: "GET",
        }),
      );
    }

    // -----------------------------------------------------------------------
    // /listPolicies and /getPolicy
    // -----------------------------------------------------------------------

    describe("/listPolicies and /getPolicy", () => {
      it("returns policies via /listPolicies", async () => {
        ug.getSyncHealth();
        const created = await ug.createPolicy("Policy via RPC");

        const resp = await rpcGet("/listPolicies");
        expect(resp.status).toBe(200);

        const data = (await resp.json()) as Array<{ policy_id: string; name: string }>;
        expect(data.some((p) => p.policy_id === created.policy_id)).toBe(true);
      });

      it("returns a policy with edges via /getPolicy", async () => {
        ug.getSyncHealth();
        const policy = await ug.createPolicy("Policy detail");
        await ug.setPolicyEdges(policy.policy_id, [
          {
            from_account_id: TEST_ACCOUNT_ID,
            to_account_id: OTHER_ACCOUNT_ID,
            detail_level: "BUSY",
            calendar_kind: "BUSY_OVERLAY",
          },
        ]);

        const resp = await rpc("/getPolicy", { policy_id: policy.policy_id });
        expect(resp.status).toBe(200);

        const data = (await resp.json()) as {
          policy_id: string;
          edges: Array<{ from_account_id: string; to_account_id: string }>;
        };
        expect(data.policy_id).toBe(policy.policy_id);
        expect(data.edges).toHaveLength(1);
        expect(data.edges[0].from_account_id).toBe(TEST_ACCOUNT_ID);
        expect(data.edges[0].to_account_id).toBe(OTHER_ACCOUNT_ID);
      });
    });

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

  // -------------------------------------------------------------------------
  // computeAvailability -- unified free/busy computation
  // -------------------------------------------------------------------------

  describe("computeAvailability", () => {
    it("returns busy and free intervals for a single account", async () => {
      // Create two events with a gap between them
      const delta1 = makeCreatedDelta({
        origin_event_id: "evt_avail_1",
        event: {
          ...makeCreatedDelta().event!,
          origin_event_id: "evt_avail_1",
          title: "Morning Meeting",
          start: { dateTime: "2026-02-15T09:00:00Z" },
          end: { dateTime: "2026-02-15T10:00:00Z" },
        },
      });
      const delta2 = makeCreatedDelta({
        origin_event_id: "evt_avail_2",
        event: {
          ...makeCreatedDelta().event!,
          origin_event_id: "evt_avail_2",
          title: "Afternoon Meeting",
          start: { dateTime: "2026-02-15T14:00:00Z" },
          end: { dateTime: "2026-02-15T15:00:00Z" },
        },
      });

      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [delta1, delta2]);

      const result = ug.computeAvailability({
        start: "2026-02-15T08:00:00Z",
        end: "2026-02-15T16:00:00Z",
      });

      // Should have 2 busy intervals
      expect(result.busy_intervals).toHaveLength(2);
      expect(result.busy_intervals[0].start).toBe("2026-02-15T09:00:00Z");
      expect(result.busy_intervals[0].end).toBe("2026-02-15T10:00:00Z");
      expect(result.busy_intervals[0].account_ids).toContain(TEST_ACCOUNT_ID);
      expect(result.busy_intervals[1].start).toBe("2026-02-15T14:00:00Z");
      expect(result.busy_intervals[1].end).toBe("2026-02-15T15:00:00Z");

      // Should have 3 free intervals: before first, between, after last
      expect(result.free_intervals).toHaveLength(3);
      expect(result.free_intervals[0].start).toBe("2026-02-15T08:00:00Z");
      expect(result.free_intervals[0].end).toBe("2026-02-15T09:00:00Z");
      expect(result.free_intervals[1].start).toBe("2026-02-15T10:00:00Z");
      expect(result.free_intervals[1].end).toBe("2026-02-15T14:00:00Z");
      expect(result.free_intervals[2].start).toBe("2026-02-15T15:00:00Z");
      expect(result.free_intervals[2].end).toBe("2026-02-15T16:00:00Z");
    });

    it("merges overlapping events across multiple accounts", async () => {
      // Account 1: event from 9-11
      const delta1 = makeCreatedDelta({
        origin_event_id: "evt_overlap_1",
        event: {
          ...makeCreatedDelta().event!,
          origin_event_id: "evt_overlap_1",
          title: "Account 1 Meeting",
          start: { dateTime: "2026-02-15T09:00:00Z" },
          end: { dateTime: "2026-02-15T11:00:00Z" },
        },
      });

      // Account 2: event from 10-12 (overlaps with account 1)
      const delta2 = makeCreatedDelta({
        origin_event_id: "evt_overlap_2",
        origin_account_id: OTHER_ACCOUNT_ID,
        event: {
          ...makeCreatedDelta().event!,
          origin_account_id: OTHER_ACCOUNT_ID,
          origin_event_id: "evt_overlap_2",
          title: "Account 2 Meeting",
          start: { dateTime: "2026-02-15T10:00:00Z" },
          end: { dateTime: "2026-02-15T12:00:00Z" },
        },
      });

      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [delta1]);
      await ug.applyProviderDelta(OTHER_ACCOUNT_ID, [delta2]);

      const result = ug.computeAvailability({
        start: "2026-02-15T08:00:00Z",
        end: "2026-02-15T13:00:00Z",
      });

      // Should merge into a single busy interval from 9-12
      expect(result.busy_intervals).toHaveLength(1);
      expect(result.busy_intervals[0].start).toBe("2026-02-15T09:00:00Z");
      expect(result.busy_intervals[0].end).toBe("2026-02-15T12:00:00Z");
      // Both accounts should be listed
      expect(result.busy_intervals[0].account_ids).toContain(TEST_ACCOUNT_ID);
      expect(result.busy_intervals[0].account_ids).toContain(OTHER_ACCOUNT_ID);

      // Free intervals: before (8-9) and after (12-13)
      expect(result.free_intervals).toHaveLength(2);
      expect(result.free_intervals[0].start).toBe("2026-02-15T08:00:00Z");
      expect(result.free_intervals[0].end).toBe("2026-02-15T09:00:00Z");
      expect(result.free_intervals[1].start).toBe("2026-02-15T12:00:00Z");
      expect(result.free_intervals[1].end).toBe("2026-02-15T13:00:00Z");
    });

    it("handles all-day events correctly", async () => {
      const delta = makeCreatedDelta({
        origin_event_id: "evt_allday_avail",
        event: {
          ...makeCreatedDelta().event!,
          origin_event_id: "evt_allday_avail",
          title: "All Day Conference",
          start: { date: "2026-02-15" },
          end: { date: "2026-02-16" },
          all_day: true,
        },
      });

      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [delta]);

      const result = ug.computeAvailability({
        start: "2026-02-15T00:00:00Z",
        end: "2026-02-16T00:00:00Z",
      });

      // All-day event should occupy the full day
      expect(result.busy_intervals).toHaveLength(1);
      expect(result.busy_intervals[0].start).toBe("2026-02-15");
      expect(result.busy_intervals[0].end).toBe("2026-02-16");
      expect(result.busy_intervals[0].account_ids).toContain(TEST_ACCOUNT_ID);

      // No free intervals since the entire day is busy
      expect(result.free_intervals).toHaveLength(0);
    });

    it("returns all-free when no events in time range", async () => {
      // Trigger migration but add no events
      ug.getSyncHealth();

      const result = ug.computeAvailability({
        start: "2026-02-15T08:00:00Z",
        end: "2026-02-15T17:00:00Z",
      });

      expect(result.busy_intervals).toHaveLength(0);
      expect(result.free_intervals).toHaveLength(1);
      expect(result.free_intervals[0].start).toBe("2026-02-15T08:00:00Z");
      expect(result.free_intervals[0].end).toBe("2026-02-15T17:00:00Z");
    });

    it("filters by account when accounts array is provided", async () => {
      // Create events on both accounts
      const delta1 = makeCreatedDelta({
        origin_event_id: "evt_filter_1",
        event: {
          ...makeCreatedDelta().event!,
          origin_event_id: "evt_filter_1",
          title: "Account 1 Only",
          start: { dateTime: "2026-02-15T09:00:00Z" },
          end: { dateTime: "2026-02-15T10:00:00Z" },
        },
      });
      const delta2 = makeCreatedDelta({
        origin_event_id: "evt_filter_2",
        origin_account_id: OTHER_ACCOUNT_ID,
        event: {
          ...makeCreatedDelta().event!,
          origin_account_id: OTHER_ACCOUNT_ID,
          origin_event_id: "evt_filter_2",
          title: "Account 2 Only",
          start: { dateTime: "2026-02-15T14:00:00Z" },
          end: { dateTime: "2026-02-15T15:00:00Z" },
        },
      });

      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [delta1]);
      await ug.applyProviderDelta(OTHER_ACCOUNT_ID, [delta2]);

      // Query only for TEST_ACCOUNT_ID
      const result = ug.computeAvailability({
        start: "2026-02-15T08:00:00Z",
        end: "2026-02-15T16:00:00Z",
        accounts: [TEST_ACCOUNT_ID],
      });

      // Should only see account 1's event
      expect(result.busy_intervals).toHaveLength(1);
      expect(result.busy_intervals[0].start).toBe("2026-02-15T09:00:00Z");
      expect(result.busy_intervals[0].end).toBe("2026-02-15T10:00:00Z");
      expect(result.busy_intervals[0].account_ids).toEqual([TEST_ACCOUNT_ID]);
    });

    it("returns all accounts when accounts array is omitted", async () => {
      const delta1 = makeCreatedDelta({
        origin_event_id: "evt_all_1",
        event: {
          ...makeCreatedDelta().event!,
          origin_event_id: "evt_all_1",
          title: "Account 1 Event",
          start: { dateTime: "2026-02-15T09:00:00Z" },
          end: { dateTime: "2026-02-15T10:00:00Z" },
        },
      });
      const delta2 = makeCreatedDelta({
        origin_event_id: "evt_all_2",
        origin_account_id: OTHER_ACCOUNT_ID,
        event: {
          ...makeCreatedDelta().event!,
          origin_account_id: OTHER_ACCOUNT_ID,
          origin_event_id: "evt_all_2",
          title: "Account 2 Event",
          start: { dateTime: "2026-02-15T14:00:00Z" },
          end: { dateTime: "2026-02-15T15:00:00Z" },
        },
      });

      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [delta1]);
      await ug.applyProviderDelta(OTHER_ACCOUNT_ID, [delta2]);

      // Query without accounts filter
      const result = ug.computeAvailability({
        start: "2026-02-15T08:00:00Z",
        end: "2026-02-15T16:00:00Z",
      });

      // Should see both accounts' events
      expect(result.busy_intervals).toHaveLength(2);
    });

    it("excludes transparent events from busy intervals", async () => {
      const delta1 = makeCreatedDelta({
        origin_event_id: "evt_opaque",
        event: {
          ...makeCreatedDelta().event!,
          origin_event_id: "evt_opaque",
          title: "Opaque (Blocks Time)",
          start: { dateTime: "2026-02-15T09:00:00Z" },
          end: { dateTime: "2026-02-15T10:00:00Z" },
          transparency: "opaque",
        },
      });
      const delta2 = makeCreatedDelta({
        origin_event_id: "evt_transparent",
        event: {
          ...makeCreatedDelta().event!,
          origin_event_id: "evt_transparent",
          title: "Transparent (Does Not Block)",
          start: { dateTime: "2026-02-15T11:00:00Z" },
          end: { dateTime: "2026-02-15T12:00:00Z" },
          transparency: "transparent",
        },
      });

      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [delta1, delta2]);

      const result = ug.computeAvailability({
        start: "2026-02-15T08:00:00Z",
        end: "2026-02-15T13:00:00Z",
      });

      // Only the opaque event should appear as busy
      expect(result.busy_intervals).toHaveLength(1);
      expect(result.busy_intervals[0].start).toBe("2026-02-15T09:00:00Z");
      expect(result.busy_intervals[0].end).toBe("2026-02-15T10:00:00Z");
    });

    it("excludes cancelled events from busy intervals", async () => {
      const delta = makeCreatedDelta({
        origin_event_id: "evt_cancelled",
        event: {
          ...makeCreatedDelta().event!,
          origin_event_id: "evt_cancelled",
          title: "Cancelled Event",
          start: { dateTime: "2026-02-15T09:00:00Z" },
          end: { dateTime: "2026-02-15T10:00:00Z" },
          status: "cancelled",
        },
      });

      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [delta]);

      const result = ug.computeAvailability({
        start: "2026-02-15T08:00:00Z",
        end: "2026-02-15T11:00:00Z",
      });

      expect(result.busy_intervals).toHaveLength(0);
      expect(result.free_intervals).toHaveLength(1);
    });

    it("accessible via handleFetch at /computeAvailability", async () => {
      // Create an event
      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [
        makeCreatedDelta({
          origin_event_id: "evt_fetch_avail",
          event: {
            ...makeCreatedDelta().event!,
            origin_event_id: "evt_fetch_avail",
            title: "Fetch Test Event",
            start: { dateTime: "2026-02-15T09:00:00Z" },
            end: { dateTime: "2026-02-15T10:00:00Z" },
          },
        }),
      ]);

      const resp = await ug.handleFetch(
        new Request("https://user-graph.internal/computeAvailability", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            start: "2026-02-15T08:00:00Z",
            end: "2026-02-15T11:00:00Z",
          }),
        }),
      );

      expect(resp.status).toBe(200);
      const data = (await resp.json()) as AvailabilityResult;
      expect(data.busy_intervals).toHaveLength(1);
      expect(data.busy_intervals[0].start).toBe("2026-02-15T09:00:00Z");
      expect(data.free_intervals).toHaveLength(2);
    });
  });
});

// ---------------------------------------------------------------------------
// Unit tests for interval merging and gap computation (pure functions)
// ---------------------------------------------------------------------------

describe("mergeIntervals (pure function)", () => {
  it("returns empty array for empty input", () => {
    const result = mergeIntervals([]);
    expect(result).toHaveLength(0);
  });

  it("returns single interval unchanged", () => {
    const result = mergeIntervals([
      { start: "2026-02-15T09:00:00Z", end: "2026-02-15T10:00:00Z", account_ids: ["acc_1"] },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].start).toBe("2026-02-15T09:00:00Z");
    expect(result[0].end).toBe("2026-02-15T10:00:00Z");
  });

  it("merges two overlapping intervals", () => {
    const result = mergeIntervals([
      { start: "2026-02-15T09:00:00Z", end: "2026-02-15T11:00:00Z", account_ids: ["acc_1"] },
      { start: "2026-02-15T10:00:00Z", end: "2026-02-15T12:00:00Z", account_ids: ["acc_2"] },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].start).toBe("2026-02-15T09:00:00Z");
    expect(result[0].end).toBe("2026-02-15T12:00:00Z");
    expect(result[0].account_ids).toContain("acc_1");
    expect(result[0].account_ids).toContain("acc_2");
  });

  it("merges adjacent intervals (end === start)", () => {
    const result = mergeIntervals([
      { start: "2026-02-15T09:00:00Z", end: "2026-02-15T10:00:00Z", account_ids: ["acc_1"] },
      { start: "2026-02-15T10:00:00Z", end: "2026-02-15T11:00:00Z", account_ids: ["acc_2"] },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].start).toBe("2026-02-15T09:00:00Z");
    expect(result[0].end).toBe("2026-02-15T11:00:00Z");
  });

  it("does not merge non-overlapping intervals", () => {
    const result = mergeIntervals([
      { start: "2026-02-15T09:00:00Z", end: "2026-02-15T10:00:00Z", account_ids: ["acc_1"] },
      { start: "2026-02-15T11:00:00Z", end: "2026-02-15T12:00:00Z", account_ids: ["acc_2"] },
    ]);
    expect(result).toHaveLength(2);
  });

  it("handles unsorted input correctly", () => {
    const result = mergeIntervals([
      { start: "2026-02-15T14:00:00Z", end: "2026-02-15T15:00:00Z", account_ids: ["acc_2"] },
      { start: "2026-02-15T09:00:00Z", end: "2026-02-15T10:00:00Z", account_ids: ["acc_1"] },
    ]);
    expect(result).toHaveLength(2);
    expect(result[0].start).toBe("2026-02-15T09:00:00Z");
    expect(result[1].start).toBe("2026-02-15T14:00:00Z");
  });

  it("merges multiple overlapping intervals into one", () => {
    const result = mergeIntervals([
      { start: "2026-02-15T09:00:00Z", end: "2026-02-15T10:00:00Z", account_ids: ["acc_1"] },
      { start: "2026-02-15T09:30:00Z", end: "2026-02-15T10:30:00Z", account_ids: ["acc_2"] },
      { start: "2026-02-15T10:00:00Z", end: "2026-02-15T11:00:00Z", account_ids: ["acc_3"] },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].start).toBe("2026-02-15T09:00:00Z");
    expect(result[0].end).toBe("2026-02-15T11:00:00Z");
    expect(result[0].account_ids).toContain("acc_1");
    expect(result[0].account_ids).toContain("acc_2");
    expect(result[0].account_ids).toContain("acc_3");
  });

  it("deduplicates account_ids when same account has multiple overlapping events", () => {
    const result = mergeIntervals([
      { start: "2026-02-15T09:00:00Z", end: "2026-02-15T10:00:00Z", account_ids: ["acc_1"] },
      { start: "2026-02-15T09:30:00Z", end: "2026-02-15T10:30:00Z", account_ids: ["acc_1"] },
    ]);
    expect(result).toHaveLength(1);
    // account_ids should not contain duplicates
    expect(result[0].account_ids).toEqual(["acc_1"]);
  });
});

describe("computeFreeIntervals (pure function)", () => {
  it("returns full range when no busy intervals", () => {
    const result = computeFreeIntervals(
      [],
      "2026-02-15T08:00:00Z",
      "2026-02-15T17:00:00Z",
    );
    expect(result).toHaveLength(1);
    expect(result[0].start).toBe("2026-02-15T08:00:00Z");
    expect(result[0].end).toBe("2026-02-15T17:00:00Z");
  });

  it("returns gaps between busy intervals", () => {
    const result = computeFreeIntervals(
      [
        { start: "2026-02-15T09:00:00Z", end: "2026-02-15T10:00:00Z", account_ids: [] },
        { start: "2026-02-15T14:00:00Z", end: "2026-02-15T15:00:00Z", account_ids: [] },
      ],
      "2026-02-15T08:00:00Z",
      "2026-02-15T16:00:00Z",
    );
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ start: "2026-02-15T08:00:00Z", end: "2026-02-15T09:00:00Z" });
    expect(result[1]).toEqual({ start: "2026-02-15T10:00:00Z", end: "2026-02-15T14:00:00Z" });
    expect(result[2]).toEqual({ start: "2026-02-15T15:00:00Z", end: "2026-02-15T16:00:00Z" });
  });

  it("returns empty when busy covers entire range", () => {
    const result = computeFreeIntervals(
      [
        { start: "2026-02-15T08:00:00Z", end: "2026-02-15T17:00:00Z", account_ids: [] },
      ],
      "2026-02-15T08:00:00Z",
      "2026-02-15T17:00:00Z",
    );
    expect(result).toHaveLength(0);
  });

  it("handles busy starting at range start", () => {
    const result = computeFreeIntervals(
      [
        { start: "2026-02-15T08:00:00Z", end: "2026-02-15T10:00:00Z", account_ids: [] },
      ],
      "2026-02-15T08:00:00Z",
      "2026-02-15T12:00:00Z",
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ start: "2026-02-15T10:00:00Z", end: "2026-02-15T12:00:00Z" });
  });

  it("handles busy ending at range end", () => {
    const result = computeFreeIntervals(
      [
        { start: "2026-02-15T15:00:00Z", end: "2026-02-15T17:00:00Z", account_ids: [] },
      ],
      "2026-02-15T08:00:00Z",
      "2026-02-15T17:00:00Z",
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ start: "2026-02-15T08:00:00Z", end: "2026-02-15T15:00:00Z" });
  });
});

// ===========================================================================
// Constraint CRUD Tests (TM-gj5.1)
// ===========================================================================

describe("UserGraphDO constraint CRUD", () => {
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
  // addConstraint -- trip constraint creation
  // -------------------------------------------------------------------------

  describe("addConstraint with kind=trip", () => {
    it("creates a constraint row and derived canonical event", () => {
      const constraint = ug.addConstraint(
        "trip",
        { name: "Paris Vacation", timezone: "Europe/Paris", block_policy: "BUSY" },
        "2026-03-01T00:00:00Z",
        "2026-03-08T00:00:00Z",
      );

      // Verify constraint was created
      expect(constraint.constraint_id).toMatch(/^cst_/);
      expect(constraint.kind).toBe("trip");
      expect(constraint.config_json).toEqual({
        name: "Paris Vacation",
        timezone: "Europe/Paris",
        block_policy: "BUSY",
      });
      expect(constraint.active_from).toBe("2026-03-01T00:00:00Z");
      expect(constraint.active_to).toBe("2026-03-08T00:00:00Z");

      // Verify derived canonical event was created
      const events = db
        .prepare("SELECT * FROM canonical_events WHERE constraint_id = ?")
        .all(constraint.constraint_id) as Array<Record<string, unknown>>;

      expect(events).toHaveLength(1);
      const event = events[0];
      expect(event.origin_account_id).toBe("internal");
      expect(event.origin_event_id).toBe(`constraint:${constraint.constraint_id}`);
      expect(event.source).toBe("system");
      expect(event.title).toBe("Busy"); // BUSY policy hides title
      expect(event.start_ts).toBe("2026-03-01T00:00:00Z");
      expect(event.end_ts).toBe("2026-03-08T00:00:00Z");
      expect(event.timezone).toBe("Europe/Paris");
      expect(event.transparency).toBe("opaque");
    });

    it("uses trip name as title when block_policy is TITLE", () => {
      const constraint = ug.addConstraint(
        "trip",
        { name: "Tokyo Conference", timezone: "Asia/Tokyo", block_policy: "TITLE" },
        "2026-04-10T00:00:00Z",
        "2026-04-15T00:00:00Z",
      );

      const events = db
        .prepare("SELECT * FROM canonical_events WHERE constraint_id = ?")
        .all(constraint.constraint_id) as Array<Record<string, unknown>>;

      expect(events).toHaveLength(1);
      expect(events[0].title).toBe("Tokyo Conference");
    });

    it("creates journal entry for derived event", () => {
      const constraint = ug.addConstraint(
        "trip",
        { name: "Test Trip", timezone: "UTC", block_policy: "BUSY" },
        "2026-05-01T00:00:00Z",
        "2026-05-05T00:00:00Z",
      );

      const events = db
        .prepare("SELECT canonical_event_id FROM canonical_events WHERE constraint_id = ?")
        .all(constraint.constraint_id) as Array<{ canonical_event_id: string }>;

      const journal = db
        .prepare("SELECT * FROM event_journal WHERE canonical_event_id = ?")
        .all(events[0].canonical_event_id) as Array<Record<string, unknown>>;

      expect(journal).toHaveLength(1);
      expect(journal[0].change_type).toBe("created");
      expect(journal[0].actor).toBe("system");
      const patch = JSON.parse(journal[0].patch_json as string);
      expect(patch.reason).toBe("trip_constraint");
      expect(patch.constraint_id).toBe(constraint.constraint_id);
    });
  });

  // -------------------------------------------------------------------------
  // addConstraint -- validation
  // -------------------------------------------------------------------------

  describe("addConstraint validation", () => {
    it("rejects invalid constraint kind", () => {
      expect(() =>
        ug.addConstraint("invalid_kind", {}, null, null),
      ).toThrow('Invalid constraint kind "invalid_kind"');
    });

    it("rejects trip without name in config_json", () => {
      expect(() =>
        ug.addConstraint(
          "trip",
          { timezone: "UTC", block_policy: "BUSY" },
          "2026-03-01T00:00:00Z",
          "2026-03-08T00:00:00Z",
        ),
      ).toThrow("config_json must include a 'name' string");
    });

    it("rejects trip without timezone in config_json", () => {
      expect(() =>
        ug.addConstraint(
          "trip",
          { name: "Trip", block_policy: "BUSY" },
          "2026-03-01T00:00:00Z",
          "2026-03-08T00:00:00Z",
        ),
      ).toThrow("config_json must include a 'timezone' string");
    });

    it("rejects trip with invalid block_policy", () => {
      expect(() =>
        ug.addConstraint(
          "trip",
          { name: "Trip", timezone: "UTC", block_policy: "INVALID" },
          "2026-03-01T00:00:00Z",
          "2026-03-08T00:00:00Z",
        ),
      ).toThrow("block_policy must be one of: BUSY, TITLE");
    });

    it("rejects trip without active_from", () => {
      expect(() =>
        ug.addConstraint(
          "trip",
          { name: "Trip", timezone: "UTC", block_policy: "BUSY" },
          null,
          "2026-03-08T00:00:00Z",
        ),
      ).toThrow("Trip constraint must have active_from and active_to");
    });

    it("rejects trip without active_to", () => {
      expect(() =>
        ug.addConstraint(
          "trip",
          { name: "Trip", timezone: "UTC", block_policy: "BUSY" },
          "2026-03-01T00:00:00Z",
          null,
        ),
      ).toThrow("Trip constraint must have active_from and active_to");
    });
  });

  // -------------------------------------------------------------------------
  // listConstraints
  // -------------------------------------------------------------------------

  describe("listConstraints", () => {
    it("returns empty array when no constraints exist", () => {
      const constraints = ug.listConstraints();
      expect(constraints).toEqual([]);
    });

    it("returns all constraints ordered by created_at", () => {
      ug.addConstraint(
        "trip",
        { name: "Trip A", timezone: "UTC", block_policy: "BUSY" },
        "2026-03-01T00:00:00Z",
        "2026-03-05T00:00:00Z",
      );
      ug.addConstraint(
        "trip",
        { name: "Trip B", timezone: "UTC", block_policy: "TITLE" },
        "2026-04-01T00:00:00Z",
        "2026-04-05T00:00:00Z",
      );

      const constraints = ug.listConstraints();
      expect(constraints).toHaveLength(2);
      expect(constraints[0].config_json.name).toBe("Trip A");
      expect(constraints[1].config_json.name).toBe("Trip B");
    });

    it("filters by kind", () => {
      ug.addConstraint(
        "trip",
        { name: "Trip A", timezone: "UTC", block_policy: "BUSY" },
        "2026-03-01T00:00:00Z",
        "2026-03-05T00:00:00Z",
      );

      const trips = ug.listConstraints("trip");
      expect(trips).toHaveLength(1);
      expect(trips[0].kind).toBe("trip");

      const workingHours = ug.listConstraints("working_hours");
      expect(workingHours).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // getConstraint
  // -------------------------------------------------------------------------

  describe("getConstraint", () => {
    it("returns constraint by ID", () => {
      const created = ug.addConstraint(
        "trip",
        { name: "Test Trip", timezone: "UTC", block_policy: "BUSY" },
        "2026-06-01T00:00:00Z",
        "2026-06-05T00:00:00Z",
      );

      const found = ug.getConstraint(created.constraint_id);
      expect(found).not.toBeNull();
      expect(found!.constraint_id).toBe(created.constraint_id);
      expect(found!.kind).toBe("trip");
      expect(found!.config_json.name).toBe("Test Trip");
    });

    it("returns null for non-existent constraint", () => {
      const found = ug.getConstraint("cst_NONEXISTENT000000000000000");
      expect(found).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // deleteConstraint -- cascade deletion
  // -------------------------------------------------------------------------

  describe("deleteConstraint cascade", () => {
    it("deletes constraint and its derived events", async () => {
      const constraint = ug.addConstraint(
        "trip",
        { name: "Delete Me Trip", timezone: "UTC", block_policy: "BUSY" },
        "2026-07-01T00:00:00Z",
        "2026-07-05T00:00:00Z",
      );

      // Verify event exists before deletion
      const eventsBefore = db
        .prepare("SELECT * FROM canonical_events WHERE constraint_id = ?")
        .all(constraint.constraint_id) as Array<Record<string, unknown>>;
      expect(eventsBefore).toHaveLength(1);

      // Delete the constraint
      const deleted = await ug.deleteConstraint(constraint.constraint_id);
      expect(deleted).toBe(true);

      // Verify constraint is gone
      const constraintRow = db
        .prepare("SELECT * FROM constraints WHERE constraint_id = ?")
        .all(constraint.constraint_id);
      expect(constraintRow).toHaveLength(0);

      // Verify derived events are gone
      const eventsAfter = db
        .prepare("SELECT * FROM canonical_events WHERE constraint_id = ?")
        .all(constraint.constraint_id) as Array<Record<string, unknown>>;
      expect(eventsAfter).toHaveLength(0);
    });

    it("creates journal entry for deleted derived events", async () => {
      const constraint = ug.addConstraint(
        "trip",
        { name: "Journaled Trip", timezone: "UTC", block_policy: "BUSY" },
        "2026-08-01T00:00:00Z",
        "2026-08-05T00:00:00Z",
      );

      // Get the derived event ID
      const events = db
        .prepare("SELECT canonical_event_id FROM canonical_events WHERE constraint_id = ?")
        .all(constraint.constraint_id) as Array<{ canonical_event_id: string }>;
      const eventId = events[0].canonical_event_id;

      await ug.deleteConstraint(constraint.constraint_id);

      // Journal should have created + deleted entries for the derived event
      const journal = db
        .prepare("SELECT * FROM event_journal WHERE canonical_event_id = ? ORDER BY ts ASC")
        .all(eventId) as Array<Record<string, unknown>>;

      expect(journal.length).toBeGreaterThanOrEqual(2);
      const deletionEntry = journal.find((j) => j.change_type === "deleted");
      expect(deletionEntry).toBeDefined();
      const patch = JSON.parse(deletionEntry!.patch_json as string);
      expect(patch.reason).toBe("constraint_deleted");
      expect(patch.constraint_id).toBe(constraint.constraint_id);
    });

    it("returns false for non-existent constraint", async () => {
      const deleted = await ug.deleteConstraint("cst_NONEXISTENT000000000000000");
      expect(deleted).toBe(false);
    });

    it("enqueues DELETE_MIRROR for mirrors on derived events", async () => {
      const constraint = ug.addConstraint(
        "trip",
        { name: "Mirrored Trip", timezone: "UTC", block_policy: "BUSY" },
        "2026-09-01T00:00:00Z",
        "2026-09-05T00:00:00Z",
      );

      // Get derived event ID
      const events = db
        .prepare("SELECT canonical_event_id FROM canonical_events WHERE constraint_id = ?")
        .all(constraint.constraint_id) as Array<{ canonical_event_id: string }>;
      const eventId = events[0].canonical_event_id;

      // Simulate a mirror existing for the derived event
      db.prepare(
        `INSERT INTO event_mirrors (canonical_event_id, target_account_id, target_calendar_id, state)
         VALUES (?, ?, ?, 'ACTIVE')`,
      ).run(eventId, "acc_01TESTACCOUNT0000000000001", "cal_test");

      queue.clear();

      await ug.deleteConstraint(constraint.constraint_id);

      // Should have enqueued a DELETE_MIRROR message
      expect(queue.messages).toHaveLength(1);
      const msg = queue.messages[0] as Record<string, unknown>;
      expect(msg.type).toBe("DELETE_MIRROR");
      expect(msg.canonical_event_id).toBe(eventId);
    });
  });

  // -------------------------------------------------------------------------
  // Derived events appear in computeAvailability
  // -------------------------------------------------------------------------

  describe("trip derived events in availability", () => {
    it("trip busy block shows up as busy in availability computation", () => {
      ug.addConstraint(
        "trip",
        { name: "Busy Trip", timezone: "UTC", block_policy: "BUSY" },
        "2026-03-10T09:00:00Z",
        "2026-03-10T17:00:00Z",
      );

      const result = ug.computeAvailability({
        start: "2026-03-10T08:00:00Z",
        end: "2026-03-10T18:00:00Z",
      });

      expect(result.busy_intervals).toHaveLength(1);
      expect(result.busy_intervals[0].start).toBe("2026-03-10T09:00:00Z");
      expect(result.busy_intervals[0].end).toBe("2026-03-10T17:00:00Z");

      expect(result.free_intervals).toHaveLength(2);
      expect(result.free_intervals[0].start).toBe("2026-03-10T08:00:00Z");
      expect(result.free_intervals[0].end).toBe("2026-03-10T09:00:00Z");
      expect(result.free_intervals[1].start).toBe("2026-03-10T17:00:00Z");
      expect(result.free_intervals[1].end).toBe("2026-03-10T18:00:00Z");
    });
  });

  // -------------------------------------------------------------------------
  // addConstraint -- working_hours constraint creation and validation
  // -------------------------------------------------------------------------

  describe("addConstraint with kind=working_hours", () => {
    it("creates a working_hours constraint with valid config", () => {
      const constraint = ug.addConstraint(
        "working_hours",
        {
          days: [1, 2, 3, 4, 5],
          start_time: "09:00",
          end_time: "17:00",
          timezone: "America/New_York",
        },
        null,
        null,
      );

      expect(constraint.constraint_id).toMatch(/^cst_/);
      expect(constraint.kind).toBe("working_hours");
      expect(constraint.config_json).toEqual({
        days: [1, 2, 3, 4, 5],
        start_time: "09:00",
        end_time: "17:00",
        timezone: "America/New_York",
      });
      // working_hours constraints do not require active_from/active_to
      expect(constraint.active_from).toBeNull();
      expect(constraint.active_to).toBeNull();
    });

    it("does NOT create derived canonical events (unlike trip)", () => {
      const constraint = ug.addConstraint(
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

      // No derived events should exist
      const events = db
        .prepare("SELECT * FROM canonical_events WHERE constraint_id = ?")
        .all(constraint.constraint_id) as Array<Record<string, unknown>>;
      expect(events).toHaveLength(0);
    });

    it("supports weekend working hours (e.g. Saturday=6, Sunday=0)", () => {
      const constraint = ug.addConstraint(
        "working_hours",
        {
          days: [0, 6],
          start_time: "10:00",
          end_time: "14:00",
          timezone: "UTC",
        },
        null,
        null,
      );

      expect(constraint.kind).toBe("working_hours");
      expect(constraint.config_json.days).toEqual([0, 6]);
    });

    it("supports single-day working hours", () => {
      const constraint = ug.addConstraint(
        "working_hours",
        {
          days: [3],
          start_time: "08:00",
          end_time: "12:00",
          timezone: "Europe/London",
        },
        null,
        null,
      );

      expect(constraint.config_json.days).toEqual([3]);
    });
  });

  describe("addConstraint working_hours validation", () => {
    it("rejects missing days array", () => {
      expect(() =>
        ug.addConstraint(
          "working_hours",
          { start_time: "09:00", end_time: "17:00", timezone: "UTC" },
          null,
          null,
        ),
      ).toThrow("non-empty 'days' array");
    });

    it("rejects empty days array", () => {
      expect(() =>
        ug.addConstraint(
          "working_hours",
          { days: [], start_time: "09:00", end_time: "17:00", timezone: "UTC" },
          null,
          null,
        ),
      ).toThrow("non-empty 'days' array");
    });

    it("rejects day value less than 0", () => {
      expect(() =>
        ug.addConstraint(
          "working_hours",
          { days: [-1], start_time: "09:00", end_time: "17:00", timezone: "UTC" },
          null,
          null,
        ),
      ).toThrow("integers 0-6");
    });

    it("rejects day value greater than 6", () => {
      expect(() =>
        ug.addConstraint(
          "working_hours",
          { days: [7], start_time: "09:00", end_time: "17:00", timezone: "UTC" },
          null,
          null,
        ),
      ).toThrow("integers 0-6");
    });

    it("rejects non-integer day values", () => {
      expect(() =>
        ug.addConstraint(
          "working_hours",
          { days: [1.5], start_time: "09:00", end_time: "17:00", timezone: "UTC" },
          null,
          null,
        ),
      ).toThrow("integers 0-6");
    });

    it("rejects duplicate day values", () => {
      expect(() =>
        ug.addConstraint(
          "working_hours",
          { days: [1, 2, 1], start_time: "09:00", end_time: "17:00", timezone: "UTC" },
          null,
          null,
        ),
      ).toThrow("must not contain duplicates");
    });

    it("rejects missing start_time", () => {
      expect(() =>
        ug.addConstraint(
          "working_hours",
          { days: [1], end_time: "17:00", timezone: "UTC" },
          null,
          null,
        ),
      ).toThrow("'start_time' in HH:MM");
    });

    it("rejects invalid start_time format", () => {
      expect(() =>
        ug.addConstraint(
          "working_hours",
          { days: [1], start_time: "9am", end_time: "17:00", timezone: "UTC" },
          null,
          null,
        ),
      ).toThrow("'start_time' in HH:MM");
    });

    it("rejects start_time with invalid hour (25:00)", () => {
      expect(() =>
        ug.addConstraint(
          "working_hours",
          { days: [1], start_time: "25:00", end_time: "17:00", timezone: "UTC" },
          null,
          null,
        ),
      ).toThrow("'start_time' in HH:MM");
    });

    it("rejects start_time with invalid minutes (09:60)", () => {
      expect(() =>
        ug.addConstraint(
          "working_hours",
          { days: [1], start_time: "09:60", end_time: "17:00", timezone: "UTC" },
          null,
          null,
        ),
      ).toThrow("'start_time' in HH:MM");
    });

    it("rejects missing end_time", () => {
      expect(() =>
        ug.addConstraint(
          "working_hours",
          { days: [1], start_time: "09:00", timezone: "UTC" },
          null,
          null,
        ),
      ).toThrow("'end_time' in HH:MM");
    });

    it("rejects invalid end_time format", () => {
      expect(() =>
        ug.addConstraint(
          "working_hours",
          { days: [1], start_time: "09:00", end_time: "5pm", timezone: "UTC" },
          null,
          null,
        ),
      ).toThrow("'end_time' in HH:MM");
    });

    it("rejects end_time equal to start_time", () => {
      expect(() =>
        ug.addConstraint(
          "working_hours",
          { days: [1], start_time: "09:00", end_time: "09:00", timezone: "UTC" },
          null,
          null,
        ),
      ).toThrow("end_time must be after start_time");
    });

    it("rejects end_time before start_time", () => {
      expect(() =>
        ug.addConstraint(
          "working_hours",
          { days: [1], start_time: "17:00", end_time: "09:00", timezone: "UTC" },
          null,
          null,
        ),
      ).toThrow("end_time must be after start_time");
    });

    it("rejects missing timezone", () => {
      expect(() =>
        ug.addConstraint(
          "working_hours",
          { days: [1], start_time: "09:00", end_time: "17:00" },
          null,
          null,
        ),
      ).toThrow("must include a 'timezone' string");
    });

    it("rejects empty timezone string", () => {
      expect(() =>
        ug.addConstraint(
          "working_hours",
          { days: [1], start_time: "09:00", end_time: "17:00", timezone: "" },
          null,
          null,
        ),
      ).toThrow("must include a 'timezone' string");
    });

    it("rejects invalid IANA timezone", () => {
      expect(() =>
        ug.addConstraint(
          "working_hours",
          { days: [1], start_time: "09:00", end_time: "17:00", timezone: "Not/A/Timezone" },
          null,
          null,
        ),
      ).toThrow("not a valid IANA timezone");
    });
  });

  describe("listConstraints with working_hours", () => {
    it("filters by kind=working_hours", () => {
      ug.addConstraint(
        "trip",
        { name: "Trip A", timezone: "UTC", block_policy: "BUSY" },
        "2026-03-01T00:00:00Z",
        "2026-03-05T00:00:00Z",
      );
      ug.addConstraint(
        "working_hours",
        { days: [1, 2, 3, 4, 5], start_time: "09:00", end_time: "17:00", timezone: "UTC" },
        null,
        null,
      );

      const trips = ug.listConstraints("trip");
      expect(trips).toHaveLength(1);
      expect(trips[0].kind).toBe("trip");

      const wh = ug.listConstraints("working_hours");
      expect(wh).toHaveLength(1);
      expect(wh[0].kind).toBe("working_hours");

      const all = ug.listConstraints();
      expect(all).toHaveLength(2);
    });
  });

  describe("deleteConstraint working_hours", () => {
    it("deletes a working_hours constraint (no derived events to cascade)", async () => {
      const constraint = ug.addConstraint(
        "working_hours",
        { days: [1, 2, 3, 4, 5], start_time: "09:00", end_time: "17:00", timezone: "UTC" },
        null,
        null,
      );

      const deleted = await ug.deleteConstraint(constraint.constraint_id);
      expect(deleted).toBe(true);

      const found = ug.getConstraint(constraint.constraint_id);
      expect(found).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Working hours influence on availability computation
  // -------------------------------------------------------------------------

  describe("working hours in availability computation", () => {
    it("marks time outside working hours as busy (UTC, single weekday)", () => {
      // Wednesday Feb 18, 2026 is a Wednesday (day 3)
      ug.addConstraint(
        "working_hours",
        {
          days: [3], // Wednesday only
          start_time: "09:00",
          end_time: "17:00",
          timezone: "UTC",
        },
        null,
        null,
      );

      // Query: Wednesday 2026-02-18 00:00 to 23:59:59 UTC
      const result = ug.computeAvailability({
        start: "2026-02-18T00:00:00Z",
        end: "2026-02-18T23:59:59Z",
      });

      // Should have busy intervals before 09:00 and after 17:00
      expect(result.busy_intervals.length).toBeGreaterThanOrEqual(2);

      // Free interval should be 09:00-17:00 (the working hours)
      expect(result.free_intervals).toHaveLength(1);
      expect(result.free_intervals[0].start).toBe("2026-02-18T09:00:00.000Z");
      expect(result.free_intervals[0].end).toBe("2026-02-18T17:00:00.000Z");
    });

    it("entire day is busy when it is not a working day", () => {
      // Saturday Feb 21, 2026 is a Saturday (day 6)
      ug.addConstraint(
        "working_hours",
        {
          days: [1, 2, 3, 4, 5], // Mon-Fri only
          start_time: "09:00",
          end_time: "17:00",
          timezone: "UTC",
        },
        null,
        null,
      );

      // Query: Saturday 2026-02-21
      const result = ug.computeAvailability({
        start: "2026-02-21T00:00:00Z",
        end: "2026-02-21T23:59:59Z",
      });

      // Entire day should be busy (one big busy interval)
      expect(result.busy_intervals).toHaveLength(1);
      expect(result.busy_intervals[0].start).toBe("2026-02-21T00:00:00Z");
      expect(result.busy_intervals[0].end).toBe("2026-02-21T23:59:59Z");

      // No free intervals
      expect(result.free_intervals).toHaveLength(0);
    });

    it("merges working hours busy with event busy correctly", async () => {
      // Monday Feb 16, 2026 is a Monday (day 1)
      ug.addConstraint(
        "working_hours",
        {
          days: [1], // Monday only
          start_time: "09:00",
          end_time: "17:00",
          timezone: "UTC",
        },
        null,
        null,
      );

      // Add a meeting during working hours: 10:00-11:00
      const delta = makeCreatedDelta({
        origin_event_id: "evt_wh_meeting",
        event: {
          ...makeCreatedDelta().event!,
          origin_event_id: "evt_wh_meeting",
          title: "Team Standup",
          start: { dateTime: "2026-02-16T10:00:00Z" },
          end: { dateTime: "2026-02-16T11:00:00Z" },
        },
      });
      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [delta]);

      const result = ug.computeAvailability({
        start: "2026-02-16T08:00:00Z",
        end: "2026-02-16T18:00:00Z",
      });

      // Outside working hours: 08:00-09:00 and 17:00-18:00 are busy
      // Meeting: 10:00-11:00 is busy
      // Free: 09:00-10:00 and 11:00-17:00
      expect(result.free_intervals).toHaveLength(2);
      expect(result.free_intervals[0].start).toBe("2026-02-16T09:00:00.000Z");
      expect(result.free_intervals[0].end).toBe("2026-02-16T10:00:00Z");
      expect(result.free_intervals[1].start).toBe("2026-02-16T11:00:00Z");
      expect(result.free_intervals[1].end).toBe("2026-02-16T17:00:00.000Z");
    });

    it("multiple working_hours constraints union their working periods", () => {
      // Two constraints for the same day but different hours
      // Constraint 1: Mon-Fri 09:00-12:00
      // Constraint 2: Mon-Fri 14:00-18:00
      // Combined working hours: 09:00-12:00 and 14:00-18:00
      ug.addConstraint(
        "working_hours",
        {
          days: [1, 2, 3, 4, 5],
          start_time: "09:00",
          end_time: "12:00",
          timezone: "UTC",
        },
        null,
        null,
      );
      ug.addConstraint(
        "working_hours",
        {
          days: [1, 2, 3, 4, 5],
          start_time: "14:00",
          end_time: "18:00",
          timezone: "UTC",
        },
        null,
        null,
      );

      // Monday Feb 16, 2026
      const result = ug.computeAvailability({
        start: "2026-02-16T08:00:00Z",
        end: "2026-02-16T19:00:00Z",
      });

      // Outside working hours: 08:00-09:00, 12:00-14:00, 18:00-19:00
      // Free (working hours): 09:00-12:00 and 14:00-18:00
      expect(result.free_intervals).toHaveLength(2);
      expect(result.free_intervals[0].start).toBe("2026-02-16T09:00:00.000Z");
      expect(result.free_intervals[0].end).toBe("2026-02-16T12:00:00.000Z");
      expect(result.free_intervals[1].start).toBe("2026-02-16T14:00:00.000Z");
      expect(result.free_intervals[1].end).toBe("2026-02-16T18:00:00.000Z");
    });

    it("no working_hours constraints means no restriction on availability", async () => {
      // No working hours constraints -- just event-based availability
      const delta = makeCreatedDelta({
        origin_event_id: "evt_no_wh",
        event: {
          ...makeCreatedDelta().event!,
          origin_event_id: "evt_no_wh",
          title: "Meeting",
          start: { dateTime: "2026-02-16T10:00:00Z" },
          end: { dateTime: "2026-02-16T11:00:00Z" },
        },
      });
      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [delta]);

      const result = ug.computeAvailability({
        start: "2026-02-16T08:00:00Z",
        end: "2026-02-16T18:00:00Z",
      });

      // Only the meeting should be busy
      expect(result.busy_intervals).toHaveLength(1);
      expect(result.busy_intervals[0].start).toBe("2026-02-16T10:00:00Z");
      expect(result.busy_intervals[0].end).toBe("2026-02-16T11:00:00Z");

      // Free before and after
      expect(result.free_intervals).toHaveLength(2);
    });

    it("multi-day range applies working hours to each day correctly", () => {
      // Mon-Fri 09:00-17:00 UTC
      ug.addConstraint(
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

      // Monday Feb 16 to Tuesday Feb 17, 2026
      const result = ug.computeAvailability({
        start: "2026-02-16T08:00:00Z",
        end: "2026-02-17T18:00:00Z",
      });

      // Free intervals should be the working hours of each day:
      // Mon 09:00-17:00 and Tue 09:00-17:00
      expect(result.free_intervals).toHaveLength(2);
      expect(result.free_intervals[0].start).toBe("2026-02-16T09:00:00.000Z");
      expect(result.free_intervals[0].end).toBe("2026-02-16T17:00:00.000Z");
      expect(result.free_intervals[1].start).toBe("2026-02-17T09:00:00.000Z");
      expect(result.free_intervals[1].end).toBe("2026-02-17T17:00:00.000Z");
    });
  });
});

// ---------------------------------------------------------------------------
// Pure function tests: expandWorkingHoursToOutsideBusy
// ---------------------------------------------------------------------------

describe("expandWorkingHoursToOutsideBusy (pure function)", () => {
  it("returns empty array when no constraints provided", () => {
    const result = expandWorkingHoursToOutsideBusy(
      [],
      "2026-02-16T08:00:00Z",
      "2026-02-16T18:00:00Z",
    );
    expect(result).toEqual([]);
  });

  it("marks entire range as busy when day is not a working day", () => {
    // Saturday Feb 21, 2026 -- constraint only covers Mon-Fri
    const result = expandWorkingHoursToOutsideBusy(
      [{
        config_json: {
          days: [1, 2, 3, 4, 5],
          start_time: "09:00",
          end_time: "17:00",
          timezone: "UTC",
        },
      }],
      "2026-02-21T10:00:00Z",
      "2026-02-21T14:00:00Z",
    );

    // Entire range is outside working hours
    expect(result).toHaveLength(1);
    expect(result[0].start).toBe("2026-02-21T10:00:00Z");
    expect(result[0].end).toBe("2026-02-21T14:00:00Z");
    expect(result[0].account_ids).toContain("working_hours");
  });

  it("produces correct busy intervals for UTC working day", () => {
    // Monday Feb 16, 2026 in UTC
    const result = expandWorkingHoursToOutsideBusy(
      [{
        config_json: {
          days: [1], // Monday
          start_time: "09:00",
          end_time: "17:00",
          timezone: "UTC",
        },
      }],
      "2026-02-16T00:00:00Z",
      "2026-02-16T23:59:59Z",
    );

    // Should have 2 busy intervals: before 09:00 and after 17:00
    expect(result).toHaveLength(2);
    expect(result[0].end).toBe("2026-02-16T09:00:00.000Z");
    expect(result[1].start).toBe("2026-02-16T17:00:00.000Z");
  });

  it("handles multiple constraints by unioning working periods", () => {
    // Monday Feb 16, 2026
    // Constraint 1: morning shift 06:00-12:00
    // Constraint 2: afternoon shift 14:00-20:00
    const result = expandWorkingHoursToOutsideBusy(
      [
        {
          config_json: {
            days: [1],
            start_time: "06:00",
            end_time: "12:00",
            timezone: "UTC",
          },
        },
        {
          config_json: {
            days: [1],
            start_time: "14:00",
            end_time: "20:00",
            timezone: "UTC",
          },
        },
      ],
      "2026-02-16T00:00:00Z",
      "2026-02-16T23:59:59Z",
    );

    // Busy periods: 00:00-06:00, 12:00-14:00, 20:00-23:59:59
    expect(result).toHaveLength(3);
    expect(result[0].end).toBe("2026-02-16T06:00:00.000Z");
    expect(result[1].start).toBe("2026-02-16T12:00:00.000Z");
    expect(result[1].end).toBe("2026-02-16T14:00:00.000Z");
    expect(result[2].start).toBe("2026-02-16T20:00:00.000Z");
  });

  it("handles overlapping constraint periods by merging", () => {
    // Monday Feb 16, 2026
    // Constraint 1: 08:00-13:00
    // Constraint 2: 11:00-17:00
    // Union: 08:00-17:00
    const result = expandWorkingHoursToOutsideBusy(
      [
        {
          config_json: {
            days: [1],
            start_time: "08:00",
            end_time: "13:00",
            timezone: "UTC",
          },
        },
        {
          config_json: {
            days: [1],
            start_time: "11:00",
            end_time: "17:00",
            timezone: "UTC",
          },
        },
      ],
      "2026-02-16T06:00:00Z",
      "2026-02-16T20:00:00Z",
    );

    // Busy periods: 06:00-08:00 and 17:00-20:00
    expect(result).toHaveLength(2);
    expect(result[0].start).toBe("2026-02-16T06:00:00.000Z");
    expect(result[0].end).toBe("2026-02-16T08:00:00.000Z");
    expect(result[1].start).toBe("2026-02-16T17:00:00.000Z");
    expect(result[1].end).toBe("2026-02-16T20:00:00Z");
  });
});

// ---------------------------------------------------------------------------
// Static validation method tests
// ---------------------------------------------------------------------------

describe("UserGraphDO.validateWorkingHoursConfig (static)", () => {
  it("accepts a valid config", () => {
    expect(() =>
      UserGraphDO.validateWorkingHoursConfig({
        days: [1, 2, 3, 4, 5],
        start_time: "09:00",
        end_time: "17:00",
        timezone: "America/New_York",
      }),
    ).not.toThrow();
  });

  it("accepts edge case times (00:00, 23:59)", () => {
    expect(() =>
      UserGraphDO.validateWorkingHoursConfig({
        days: [0],
        start_time: "00:00",
        end_time: "23:59",
        timezone: "UTC",
      }),
    ).not.toThrow();
  });

  it("accepts all valid IANA timezones", () => {
    const validTimezones = [
      "UTC",
      "America/New_York",
      "America/Los_Angeles",
      "Europe/London",
      "Europe/Paris",
      "Asia/Tokyo",
      "Australia/Sydney",
    ];
    for (const tz of validTimezones) {
      expect(() =>
        UserGraphDO.validateWorkingHoursConfig({
          days: [1],
          start_time: "09:00",
          end_time: "17:00",
          timezone: tz,
        }),
      ).not.toThrow();
    }
  });

  it("rejects string day values", () => {
    expect(() =>
      UserGraphDO.validateWorkingHoursConfig({
        days: ["Monday"],
        start_time: "09:00",
        end_time: "17:00",
        timezone: "UTC",
      }),
    ).toThrow("integers 0-6");
  });

  it("rejects null days", () => {
    expect(() =>
      UserGraphDO.validateWorkingHoursConfig({
        days: null,
        start_time: "09:00",
        end_time: "17:00",
        timezone: "UTC",
      }),
    ).toThrow("non-empty 'days' array");
  });
});

// ---------------------------------------------------------------------------
// Buffer constraint integration tests
// ---------------------------------------------------------------------------

describe("UserGraphDO buffer constraints", () => {
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
  // addConstraint with kind=buffer
  // -------------------------------------------------------------------------

  describe("addConstraint with kind=buffer", () => {
    it("creates a travel buffer constraint", () => {
      const constraint = ug.addConstraint(
        "buffer",
        { type: "travel", minutes: 15, applies_to: "all" },
        null,
        null,
      );

      expect(constraint.kind).toBe("buffer");
      expect(constraint.config_json).toEqual({
        type: "travel",
        minutes: 15,
        applies_to: "all",
      });
      expect(constraint.constraint_id).toMatch(/^cst_/);
    });

    it("creates a prep buffer constraint", () => {
      const constraint = ug.addConstraint(
        "buffer",
        { type: "prep", minutes: 30, applies_to: "external" },
        null,
        null,
      );

      expect(constraint.kind).toBe("buffer");
      expect(constraint.config_json).toEqual({
        type: "prep",
        minutes: 30,
        applies_to: "external",
      });
    });

    it("creates a cooldown buffer constraint", () => {
      const constraint = ug.addConstraint(
        "buffer",
        { type: "cooldown", minutes: 10, applies_to: "all" },
        null,
        null,
      );

      expect(constraint.kind).toBe("buffer");
      expect(constraint.config_json).toEqual({
        type: "cooldown",
        minutes: 10,
        applies_to: "all",
      });
    });

    it("does NOT create any derived calendar events", () => {
      ug.addConstraint(
        "buffer",
        { type: "travel", minutes: 15, applies_to: "all" },
        null,
        null,
      );

      // Verify no canonical events were created
      const events = ug.listCanonicalEvents({});
      expect(events.items).toHaveLength(0);
    });

    it("rejects invalid buffer type", () => {
      expect(() =>
        ug.addConstraint(
          "buffer",
          { type: "nap", minutes: 15, applies_to: "all" },
          null,
          null,
        ),
      ).toThrow("type must be one of: travel, prep, cooldown");
    });

    it("rejects zero minutes", () => {
      expect(() =>
        ug.addConstraint(
          "buffer",
          { type: "travel", minutes: 0, applies_to: "all" },
          null,
          null,
        ),
      ).toThrow("minutes must be a positive integer");
    });

    it("rejects invalid applies_to", () => {
      expect(() =>
        ug.addConstraint(
          "buffer",
          { type: "travel", minutes: 15, applies_to: "internal" },
          null,
          null,
        ),
      ).toThrow("applies_to must be one of: all, external");
    });
  });

  // -------------------------------------------------------------------------
  // Buffer constraints in listConstraints
  // -------------------------------------------------------------------------

  describe("listConstraints with buffer", () => {
    it("lists buffer constraints filtered by kind", () => {
      ug.addConstraint(
        "buffer",
        { type: "travel", minutes: 15, applies_to: "all" },
        null,
        null,
      );
      ug.addConstraint(
        "buffer",
        { type: "cooldown", minutes: 10, applies_to: "external" },
        null,
        null,
      );

      const buffers = ug.listConstraints("buffer");
      expect(buffers).toHaveLength(2);
      expect(buffers[0].kind).toBe("buffer");
      expect(buffers[1].kind).toBe("buffer");
    });
  });

  // -------------------------------------------------------------------------
  // deleteConstraint for buffer
  // -------------------------------------------------------------------------

  describe("deleteConstraint buffer", () => {
    it("deletes a buffer constraint without cascade (no derived events)", async () => {
      const constraint = ug.addConstraint(
        "buffer",
        { type: "travel", minutes: 15, applies_to: "all" },
        null,
        null,
      );

      const deleted = await ug.deleteConstraint(constraint.constraint_id);
      expect(deleted).toBe(true);

      const remaining = ug.listConstraints("buffer");
      expect(remaining).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Buffer in availability computation -- travel (before)
  // -------------------------------------------------------------------------

  describe("buffer in availability computation -- travel (before events)", () => {
    it("reduces available slot by adding travel buffer before event", async () => {
      // Add a 15-minute travel buffer
      ug.addConstraint(
        "buffer",
        { type: "travel", minutes: 15, applies_to: "all" },
        null,
        null,
      );

      // Add a meeting at 10:00-11:00
      const delta = makeCreatedDelta({
        origin_event_id: "evt_buf_travel_1",
        event: {
          ...makeCreatedDelta().event!,
          origin_event_id: "evt_buf_travel_1",
          title: "Client Meeting",
          start: { dateTime: "2026-02-16T10:00:00Z" },
          end: { dateTime: "2026-02-16T11:00:00Z" },
        },
      });
      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [delta]);

      const result = ug.computeAvailability({
        start: "2026-02-16T09:00:00Z",
        end: "2026-02-16T12:00:00Z",
      });

      // Buffer (09:45-10:00) + Event (10:00-11:00) merge into single busy: 09:45-11:00
      // Free: 09:00-09:45, 11:00-12:00
      expect(result.free_intervals).toHaveLength(2);
      expect(result.free_intervals[0].start).toBe("2026-02-16T09:00:00Z");
      expect(result.free_intervals[0].end).toBe("2026-02-16T09:45:00.000Z");
      expect(result.free_intervals[1].start).toBe("2026-02-16T11:00:00Z");
      expect(result.free_intervals[1].end).toBe("2026-02-16T12:00:00Z");
    });

    it("applies travel buffer to multiple events", async () => {
      ug.addConstraint(
        "buffer",
        { type: "travel", minutes: 30, applies_to: "all" },
        null,
        null,
      );

      // Two meetings with a gap
      const delta1 = makeCreatedDelta({
        origin_event_id: "evt_buf_multi_1",
        event: {
          ...makeCreatedDelta().event!,
          origin_event_id: "evt_buf_multi_1",
          title: "Morning Meeting",
          start: { dateTime: "2026-02-16T10:00:00Z" },
          end: { dateTime: "2026-02-16T11:00:00Z" },
        },
      });
      const delta2 = makeCreatedDelta({
        origin_event_id: "evt_buf_multi_2",
        event: {
          ...makeCreatedDelta().event!,
          origin_event_id: "evt_buf_multi_2",
          title: "Afternoon Meeting",
          start: { dateTime: "2026-02-16T14:00:00Z" },
          end: { dateTime: "2026-02-16T15:00:00Z" },
        },
      });
      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [delta1, delta2]);

      const result = ug.computeAvailability({
        start: "2026-02-16T09:00:00Z",
        end: "2026-02-16T16:00:00Z",
      });

      // Busy: 09:30-11:00 (buffer+event1), 13:30-15:00 (buffer+event2)
      // Free: 09:00-09:30, 11:00-13:30, 15:00-16:00
      expect(result.free_intervals).toHaveLength(3);
      expect(result.free_intervals[0].start).toBe("2026-02-16T09:00:00Z");
      expect(result.free_intervals[0].end).toBe("2026-02-16T09:30:00.000Z");
      expect(result.free_intervals[1].start).toBe("2026-02-16T11:00:00Z");
      expect(result.free_intervals[1].end).toBe("2026-02-16T13:30:00.000Z");
      expect(result.free_intervals[2].start).toBe("2026-02-16T15:00:00Z");
      expect(result.free_intervals[2].end).toBe("2026-02-16T16:00:00Z");
    });
  });

  // -------------------------------------------------------------------------
  // Buffer in availability computation -- prep (before)
  // -------------------------------------------------------------------------

  describe("buffer in availability computation -- prep (before events)", () => {
    it("reduces available slot by adding prep buffer before event", async () => {
      ug.addConstraint(
        "buffer",
        { type: "prep", minutes: 10, applies_to: "all" },
        null,
        null,
      );

      const delta = makeCreatedDelta({
        origin_event_id: "evt_buf_prep_1",
        event: {
          ...makeCreatedDelta().event!,
          origin_event_id: "evt_buf_prep_1",
          title: "Presentation",
          start: { dateTime: "2026-02-16T14:00:00Z" },
          end: { dateTime: "2026-02-16T15:00:00Z" },
        },
      });
      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [delta]);

      const result = ug.computeAvailability({
        start: "2026-02-16T13:00:00Z",
        end: "2026-02-16T16:00:00Z",
      });

      // Buffer (13:50-14:00) + Event (14:00-15:00) merge into 13:50-15:00
      // Free: 13:00-13:50, 15:00-16:00
      expect(result.free_intervals).toHaveLength(2);
      expect(result.free_intervals[0].start).toBe("2026-02-16T13:00:00Z");
      expect(result.free_intervals[0].end).toBe("2026-02-16T13:50:00.000Z");
      expect(result.free_intervals[1].start).toBe("2026-02-16T15:00:00Z");
      expect(result.free_intervals[1].end).toBe("2026-02-16T16:00:00Z");
    });
  });

  // -------------------------------------------------------------------------
  // Buffer in availability computation -- cooldown (after)
  // -------------------------------------------------------------------------

  describe("buffer in availability computation -- cooldown (after events)", () => {
    it("reduces available slot by adding cooldown buffer after event", async () => {
      ug.addConstraint(
        "buffer",
        { type: "cooldown", minutes: 15, applies_to: "all" },
        null,
        null,
      );

      const delta = makeCreatedDelta({
        origin_event_id: "evt_buf_cd_1",
        event: {
          ...makeCreatedDelta().event!,
          origin_event_id: "evt_buf_cd_1",
          title: "Intense Meeting",
          start: { dateTime: "2026-02-16T10:00:00Z" },
          end: { dateTime: "2026-02-16T11:00:00Z" },
        },
      });
      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [delta]);

      const result = ug.computeAvailability({
        start: "2026-02-16T09:00:00Z",
        end: "2026-02-16T12:00:00Z",
      });

      // Event (10:00-11:00) + Cooldown (11:00-11:15) merge into 10:00-11:15
      // Free: 09:00-10:00, 11:15-12:00
      expect(result.free_intervals).toHaveLength(2);
      expect(result.free_intervals[0].start).toBe("2026-02-16T09:00:00Z");
      expect(result.free_intervals[0].end).toBe("2026-02-16T10:00:00Z");
      expect(result.free_intervals[1].start).toBe("2026-02-16T11:15:00.000Z");
      expect(result.free_intervals[1].end).toBe("2026-02-16T12:00:00Z");
    });
  });

  // -------------------------------------------------------------------------
  // Buffer with applies_to='external' filtering
  // -------------------------------------------------------------------------

  describe("buffer applies_to external filtering in availability", () => {
    it("external buffer skips internal (system-generated) events", async () => {
      // Create a trip constraint (generates an internal event)
      ug.addConstraint(
        "trip",
        { name: "Conference", timezone: "UTC", block_policy: "BUSY" },
        "2026-02-16T08:00:00Z",
        "2026-02-16T12:00:00Z",
      );

      // Add a travel buffer for external events only
      ug.addConstraint(
        "buffer",
        { type: "travel", minutes: 15, applies_to: "external" },
        null,
        null,
      );

      const result = ug.computeAvailability({
        start: "2026-02-16T07:00:00Z",
        end: "2026-02-16T13:00:00Z",
      });

      // Trip event is 08:00-12:00 (origin_account_id='internal')
      // Buffer should NOT apply to the trip event since applies_to='external'
      // So busy is just 08:00-12:00
      // Free: 07:00-08:00, 12:00-13:00
      expect(result.free_intervals).toHaveLength(2);
      expect(result.free_intervals[0].start).toBe("2026-02-16T07:00:00Z");
      expect(result.free_intervals[0].end).toBe("2026-02-16T08:00:00Z");
      expect(result.free_intervals[1].start).toBe("2026-02-16T12:00:00Z");
      expect(result.free_intervals[1].end).toBe("2026-02-16T13:00:00Z");
    });

    it("external buffer applies to external calendar events", async () => {
      // Add a real calendar event (external)
      const delta = makeCreatedDelta({
        origin_event_id: "evt_buf_ext_1",
        event: {
          ...makeCreatedDelta().event!,
          origin_event_id: "evt_buf_ext_1",
          title: "External Call",
          start: { dateTime: "2026-02-16T10:00:00Z" },
          end: { dateTime: "2026-02-16T11:00:00Z" },
        },
      });
      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [delta]);

      // Add a travel buffer for external events only
      ug.addConstraint(
        "buffer",
        { type: "travel", minutes: 15, applies_to: "external" },
        null,
        null,
      );

      const result = ug.computeAvailability({
        start: "2026-02-16T09:00:00Z",
        end: "2026-02-16T12:00:00Z",
      });

      // Buffer (09:45-10:00) + Event (10:00-11:00) = busy 09:45-11:00
      // Free: 09:00-09:45, 11:00-12:00
      expect(result.free_intervals).toHaveLength(2);
      expect(result.free_intervals[0].start).toBe("2026-02-16T09:00:00Z");
      expect(result.free_intervals[0].end).toBe("2026-02-16T09:45:00.000Z");
      expect(result.free_intervals[1].start).toBe("2026-02-16T11:00:00Z");
      expect(result.free_intervals[1].end).toBe("2026-02-16T12:00:00Z");
    });
  });

  // -------------------------------------------------------------------------
  // Combined buffer constraints (travel + cooldown)
  // -------------------------------------------------------------------------

  describe("multiple buffer constraints in availability", () => {
    it("stacks travel before and cooldown after the same event", async () => {
      ug.addConstraint(
        "buffer",
        { type: "travel", minutes: 15, applies_to: "all" },
        null,
        null,
      );
      ug.addConstraint(
        "buffer",
        { type: "cooldown", minutes: 10, applies_to: "all" },
        null,
        null,
      );

      const delta = makeCreatedDelta({
        origin_event_id: "evt_buf_stack_1",
        event: {
          ...makeCreatedDelta().event!,
          origin_event_id: "evt_buf_stack_1",
          title: "Important Meeting",
          start: { dateTime: "2026-02-16T10:00:00Z" },
          end: { dateTime: "2026-02-16T11:00:00Z" },
        },
      });
      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [delta]);

      const result = ug.computeAvailability({
        start: "2026-02-16T09:00:00Z",
        end: "2026-02-16T12:00:00Z",
      });

      // Travel buffer: 09:45-10:00 (before)
      // Event: 10:00-11:00
      // Cooldown buffer: 11:00-11:10 (after)
      // All merge into: 09:45-11:10
      // Free: 09:00-09:45, 11:10-12:00
      expect(result.free_intervals).toHaveLength(2);
      expect(result.free_intervals[0].start).toBe("2026-02-16T09:00:00Z");
      expect(result.free_intervals[0].end).toBe("2026-02-16T09:45:00.000Z");
      expect(result.free_intervals[1].start).toBe("2026-02-16T11:10:00.000Z");
      expect(result.free_intervals[1].end).toBe("2026-02-16T12:00:00Z");
    });
  });

  // -------------------------------------------------------------------------
  // Verify buffers do NOT create calendar events
  // -------------------------------------------------------------------------

  describe("buffer does not create calendar events", () => {
    it("adding buffer constraint + events leaves only the real events in DB", async () => {
      // Add buffer constraints
      ug.addConstraint(
        "buffer",
        { type: "travel", minutes: 15, applies_to: "all" },
        null,
        null,
      );
      ug.addConstraint(
        "buffer",
        { type: "cooldown", minutes: 10, applies_to: "all" },
        null,
        null,
      );

      // Add events
      const delta1 = makeCreatedDelta({
        origin_event_id: "evt_no_cal_1",
        event: {
          ...makeCreatedDelta().event!,
          origin_event_id: "evt_no_cal_1",
          title: "Real Meeting 1",
          start: { dateTime: "2026-02-16T10:00:00Z" },
          end: { dateTime: "2026-02-16T11:00:00Z" },
        },
      });
      const delta2 = makeCreatedDelta({
        origin_event_id: "evt_no_cal_2",
        event: {
          ...makeCreatedDelta().event!,
          origin_event_id: "evt_no_cal_2",
          title: "Real Meeting 2",
          start: { dateTime: "2026-02-16T14:00:00Z" },
          end: { dateTime: "2026-02-16T15:00:00Z" },
        },
      });
      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [delta1, delta2]);

      // Verify only the 2 real events exist in canonical_events
      const allEvents = ug.listCanonicalEvents({});
      expect(allEvents.items).toHaveLength(2);
      expect(allEvents.items.map((e) => e.title).sort()).toEqual([
        "Real Meeting 1",
        "Real Meeting 2",
      ]);

      // Verify computeAvailability still shows buffer-reduced slots
      const result = ug.computeAvailability({
        start: "2026-02-16T09:00:00Z",
        end: "2026-02-16T16:00:00Z",
      });

      // With buffers, availability is reduced even though no extra events exist
      // Travel (09:45-10:00) + Event1 (10:00-11:00) + Cooldown (11:00-11:10) = 09:45-11:10
      // Travel (13:45-14:00) + Event2 (14:00-15:00) + Cooldown (15:00-15:10) = 13:45-15:10
      // Free: 09:00-09:45, 11:10-13:45, 15:10-16:00
      expect(result.free_intervals).toHaveLength(3);
      expect(result.free_intervals[0].start).toBe("2026-02-16T09:00:00Z");
      expect(result.free_intervals[0].end).toBe("2026-02-16T09:45:00.000Z");
      expect(result.free_intervals[1].start).toBe("2026-02-16T11:10:00.000Z");
      expect(result.free_intervals[1].end).toBe("2026-02-16T13:45:00.000Z");
      expect(result.free_intervals[2].start).toBe("2026-02-16T15:10:00.000Z");
      expect(result.free_intervals[2].end).toBe("2026-02-16T16:00:00Z");

      // Verify no new events were created by checking count again
      const postCheck = ug.listCanonicalEvents({});
      expect(postCheck.items).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // Buffer with working hours interaction
  // -------------------------------------------------------------------------

  describe("buffer interacts correctly with working hours", () => {
    it("buffers apply within working hours context", async () => {
      // Working hours: Mon 09:00-17:00 UTC
      // Monday Feb 16, 2026
      ug.addConstraint(
        "working_hours",
        {
          days: [1],
          start_time: "09:00",
          end_time: "17:00",
          timezone: "UTC",
        },
        null,
        null,
      );

      // Travel buffer: 15 min before
      ug.addConstraint(
        "buffer",
        { type: "travel", minutes: 15, applies_to: "all" },
        null,
        null,
      );

      // Meeting at 10:00-11:00
      const delta = makeCreatedDelta({
        origin_event_id: "evt_buf_wh_1",
        event: {
          ...makeCreatedDelta().event!,
          origin_event_id: "evt_buf_wh_1",
          title: "Morning Meeting",
          start: { dateTime: "2026-02-16T10:00:00Z" },
          end: { dateTime: "2026-02-16T11:00:00Z" },
        },
      });
      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [delta]);

      const result = ug.computeAvailability({
        start: "2026-02-16T08:00:00Z",
        end: "2026-02-16T18:00:00Z",
      });

      // Outside working hours: 08:00-09:00 and 17:00-18:00 are busy
      // Travel buffer: 09:45-10:00 (before meeting)
      // Meeting: 10:00-11:00
      // Merged busy: 08:00-09:00, 09:45-11:00, 17:00-18:00
      // Free: 09:00-09:45, 11:00-17:00
      expect(result.free_intervals).toHaveLength(2);
      expect(result.free_intervals[0].start).toBe("2026-02-16T09:00:00.000Z");
      expect(result.free_intervals[0].end).toBe("2026-02-16T09:45:00.000Z");
      expect(result.free_intervals[1].start).toBe("2026-02-16T11:00:00Z");
      expect(result.free_intervals[1].end).toBe("2026-02-16T17:00:00.000Z");
    });
  });

  // -------------------------------------------------------------------------
  // Constraint-aware availability (TM-gj5.4)
  // All constraint types combined in computeAvailability
  // -------------------------------------------------------------------------

  describe("constraint-aware availability (TM-gj5.4)", () => {
    it("AC1/AC2: availability reflects all active constraints (working hours + trip + buffer)", async () => {
      // Monday 2026-02-16
      // Working hours: Mon-Fri 09:00-17:00 UTC
      ug.addConstraint(
        "working_hours",
        { days: [1, 2, 3, 4, 5], start_time: "09:00", end_time: "17:00", timezone: "UTC" },
        null,
        null,
      );

      // Trip: 14:00-16:00 UTC (2-hour meeting trip)
      ug.addConstraint(
        "trip",
        { name: "Client Visit", timezone: "UTC", block_policy: "BUSY" },
        "2026-02-16T14:00:00Z",
        "2026-02-16T16:00:00Z",
      );

      // Buffer: 15 min travel before events
      ug.addConstraint(
        "buffer",
        { type: "travel", minutes: 15, applies_to: "all" },
        null,
        null,
      );

      // Regular meeting at 10:00-11:00
      const delta = makeCreatedDelta({
        origin_event_id: "evt_all_constraints_1",
        event: {
          ...makeCreatedDelta().event!,
          origin_event_id: "evt_all_constraints_1",
          title: "Morning Standup",
          start: { dateTime: "2026-02-16T10:00:00Z" },
          end: { dateTime: "2026-02-16T11:00:00Z" },
        },
      });
      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [delta]);

      const result = ug.computeAvailability({
        start: "2026-02-16T00:00:00Z",
        end: "2026-02-17T00:00:00Z",
      });

      // Expected busy intervals (after merging):
      // 00:00-09:00 -- outside working hours
      // 09:45-11:00 -- buffer (09:45-10:00) + meeting (10:00-11:00)
      // 14:00-16:00 -- trip block (derived event)
      // 17:00-00:00 -- outside working hours
      //
      // Expected free intervals:
      // 09:00-09:45 -- between working hours start and buffer
      // 11:00-14:00 -- between meeting end and trip start
      // 16:00-17:00 -- between trip end and working hours end

      expect(result.free_intervals.length).toBeGreaterThanOrEqual(3);

      // Verify the three free gaps exist
      const freeGap1 = result.free_intervals.find((f) =>
        new Date(f.start).getTime() >= new Date("2026-02-16T09:00:00Z").getTime() &&
        new Date(f.end).getTime() <= new Date("2026-02-16T10:00:00Z").getTime(),
      );
      expect(freeGap1).toBeDefined();
      // Should end at buffer start (09:45)
      expect(new Date(freeGap1!.end).getTime()).toBe(
        new Date("2026-02-16T09:45:00.000Z").getTime(),
      );

      const freeGap2 = result.free_intervals.find((f) =>
        new Date(f.start).getTime() >= new Date("2026-02-16T11:00:00Z").getTime() &&
        new Date(f.end).getTime() <= new Date("2026-02-16T14:00:00Z").getTime(),
      );
      expect(freeGap2).toBeDefined();
      // Should be 11:00 - 13:45 (free between meeting end and trip's travel buffer)
      // Trip at 14:00 with 15min travel buffer starts the busy zone at 13:45
      expect(new Date(freeGap2!.start).getTime()).toBe(
        new Date("2026-02-16T11:00:00Z").getTime(),
      );
      expect(new Date(freeGap2!.end).getTime()).toBe(
        new Date("2026-02-16T13:45:00.000Z").getTime(),
      );

      const freeGap3 = result.free_intervals.find((f) =>
        new Date(f.start).getTime() >= new Date("2026-02-16T16:00:00Z").getTime() &&
        new Date(f.end).getTime() <= new Date("2026-02-16T17:00:00Z").getTime(),
      );
      expect(freeGap3).toBeDefined();
    });

    it("AC3: constraint evaluation order is correct (working hours before trips before buffers)", async () => {
      // This test verifies the ORDER matters:
      // A buffer should apply to events BEFORE working hours restricts them
      // but AFTER trips are placed.

      // Monday 2026-02-16
      // Working hours: 09:00-17:00 UTC
      ug.addConstraint(
        "working_hours",
        { days: [1, 2, 3, 4, 5], start_time: "09:00", end_time: "17:00", timezone: "UTC" },
        null,
        null,
      );

      // Buffer: 30 min cooldown after events
      ug.addConstraint(
        "buffer",
        { type: "cooldown", minutes: 30, applies_to: "all" },
        null,
        null,
      );

      // Meeting at 16:00-16:30 -- cooldown extends to 17:00, which is working hours end
      const delta = makeCreatedDelta({
        origin_event_id: "evt_order_test_1",
        event: {
          ...makeCreatedDelta().event!,
          origin_event_id: "evt_order_test_1",
          title: "Late Meeting",
          start: { dateTime: "2026-02-16T16:00:00Z" },
          end: { dateTime: "2026-02-16T16:30:00Z" },
        },
      });
      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [delta]);

      const result = ug.computeAvailability({
        start: "2026-02-16T08:00:00Z",
        end: "2026-02-16T18:00:00Z",
      });

      // Expected: 08:00-09:00 busy (outside working hours)
      //           09:00-16:00 free
      //           16:00-17:00 busy (meeting 16:00-16:30 + cooldown 16:30-17:00 merged)
      //           17:00-18:00 busy (outside working hours, merges with cooldown)
      // So free intervals: 09:00-16:00 only

      const morningFree = result.free_intervals.find((f) =>
        new Date(f.start).getTime() >= new Date("2026-02-16T09:00:00Z").getTime() &&
        new Date(f.start).getTime() < new Date("2026-02-16T10:00:00Z").getTime(),
      );
      expect(morningFree).toBeDefined();
      expect(new Date(morningFree!.start).getTime()).toBe(
        new Date("2026-02-16T09:00:00.000Z").getTime(),
      );
      // Free period should extend to 16:00 (meeting start)
      expect(new Date(morningFree!.end).getTime()).toBe(
        new Date("2026-02-16T16:00:00Z").getTime(),
      );
    });

    it("AC2: no_meetings_after constraint applied in availability", async () => {
      // Monday 2026-02-16
      // Working hours: 09:00-17:00 UTC
      ug.addConstraint(
        "working_hours",
        { days: [1, 2, 3, 4, 5], start_time: "09:00", end_time: "17:00", timezone: "UTC" },
        null,
        null,
      );

      // No meetings after 15:00 UTC
      ug.addConstraint(
        "no_meetings_after",
        { time: "15:00", timezone: "UTC" },
        null,
        null,
      );

      const result = ug.computeAvailability({
        start: "2026-02-16T08:00:00Z",
        end: "2026-02-16T18:00:00Z",
      });

      // Expected:
      // 08:00-09:00 busy (outside working hours)
      // 09:00-15:00 free
      // 15:00-17:00 busy (no_meetings_after overridden by working hours: merged)
      // 17:00-18:00 busy (outside working hours)
      //
      // So the only free period should be 09:00-15:00

      // All free intervals should be within 09:00-15:00
      for (const f of result.free_intervals) {
        expect(new Date(f.start).getTime()).toBeGreaterThanOrEqual(
          new Date("2026-02-16T09:00:00Z").getTime(),
        );
        expect(new Date(f.end).getTime()).toBeLessThanOrEqual(
          new Date("2026-02-16T15:00:00Z").getTime(),
        );
      }

      // Should have exactly one free interval: 09:00-15:00
      const mainFree = result.free_intervals.find((f) =>
        new Date(f.start).getTime() <= new Date("2026-02-16T09:00:00Z").getTime() + 1000 &&
        new Date(f.end).getTime() >= new Date("2026-02-16T15:00:00Z").getTime() - 1000,
      );
      expect(mainFree).toBeDefined();
    });

    it("AC5: integration test with multiple constraint types simultaneously", async () => {
      // Full integration: working_hours + trip + buffer + no_meetings_after + events
      // Wednesday 2026-02-18

      // Working hours: 08:00-18:00 UTC
      ug.addConstraint(
        "working_hours",
        { days: [1, 2, 3, 4, 5], start_time: "08:00", end_time: "18:00", timezone: "UTC" },
        null,
        null,
      );

      // Trip: 12:00-14:00 UTC (lunch meeting across town)
      ug.addConstraint(
        "trip",
        { name: "Lunch Meeting", timezone: "UTC", block_policy: "TITLE" },
        "2026-02-18T12:00:00Z",
        "2026-02-18T14:00:00Z",
      );

      // Buffer: 10 min travel before, 5 min cooldown after
      ug.addConstraint(
        "buffer",
        { type: "travel", minutes: 10, applies_to: "all" },
        null,
        null,
      );
      ug.addConstraint(
        "buffer",
        { type: "cooldown", minutes: 5, applies_to: "all" },
        null,
        null,
      );

      // No meetings after 17:00 UTC
      ug.addConstraint(
        "no_meetings_after",
        { time: "17:00", timezone: "UTC" },
        null,
        null,
      );

      // Morning meeting 09:00-10:00
      const delta1 = makeCreatedDelta({
        origin_event_id: "evt_multi_1",
        event: {
          ...makeCreatedDelta().event!,
          origin_event_id: "evt_multi_1",
          title: "Morning Review",
          start: { dateTime: "2026-02-18T09:00:00Z" },
          end: { dateTime: "2026-02-18T10:00:00Z" },
        },
      });
      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [delta1]);

      // Afternoon meeting 15:00-16:00
      const delta2 = makeCreatedDelta({
        origin_event_id: "evt_multi_2",
        event: {
          ...makeCreatedDelta().event!,
          origin_event_id: "evt_multi_2",
          title: "Code Review",
          start: { dateTime: "2026-02-18T15:00:00Z" },
          end: { dateTime: "2026-02-18T16:00:00Z" },
        },
      });
      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [delta2]);

      const result = ug.computeAvailability({
        start: "2026-02-18T07:00:00Z",
        end: "2026-02-18T19:00:00Z",
      });

      // Expected busy intervals (before merging):
      // 07:00-08:00 -- outside working hours
      // 08:50-10:05 -- buffer(08:50-09:00) + meeting(09:00-10:00) + cooldown(10:00-10:05)
      // 11:50-14:05 -- buffer(11:50-12:00) + trip(12:00-14:00) + cooldown(14:00-14:05)
      // 14:50-16:05 -- buffer(14:50-15:00) + meeting(15:00-16:00) + cooldown(16:00-16:05)
      // 17:00-19:00 -- no_meetings_after(17:00-00:00) + outside_working_hours(18:00-19:00)
      //
      // Expected free intervals:
      // 08:00-08:50  (between working hours start and morning meeting buffer)
      // 10:05-11:50  (between morning meeting cooldown and trip buffer)
      // 14:05-14:50  (between trip cooldown and afternoon meeting buffer)
      // 16:05-17:00  (between afternoon cooldown and no_meetings_after)

      // Verify multiple free intervals exist
      expect(result.free_intervals.length).toBeGreaterThanOrEqual(3);

      // All free intervals should be within working hours (08:00-17:00)
      // and respect no_meetings_after (17:00)
      for (const f of result.free_intervals) {
        // Free time must be within working hours and before no-meetings-after cutoff
        expect(new Date(f.start).getTime()).toBeGreaterThanOrEqual(
          new Date("2026-02-18T08:00:00Z").getTime() - 1000,
        );
        expect(new Date(f.end).getTime()).toBeLessThanOrEqual(
          new Date("2026-02-18T17:00:00Z").getTime() + 1000,
        );
      }

      // Verify that the trip block is reflected (no free time 12:00-14:00)
      for (const f of result.free_intervals) {
        const freeStart = new Date(f.start).getTime();
        const freeEnd = new Date(f.end).getTime();
        const tripStart = new Date("2026-02-18T12:00:00Z").getTime();
        const tripEnd = new Date("2026-02-18T14:00:00Z").getTime();
        // No free interval should fully overlap with the trip
        const overlapStart = Math.max(freeStart, tripStart);
        const overlapEnd = Math.min(freeEnd, tripEnd);
        if (overlapStart < overlapEnd) {
          // This would mean there's free time during the trip -- should NOT happen
          expect(overlapEnd - overlapStart).toBeLessThan(60_000); // Allow 1 min tolerance
        }
      }

      // Verify that buffers are reflected (no free time at exact meeting boundaries)
      // Morning meeting buffer: 08:50 should be busy
      const freeAt0850 = result.free_intervals.find((f) => {
        const s = new Date(f.start).getTime();
        const e = new Date(f.end).getTime();
        const t = new Date("2026-02-18T08:50:00Z").getTime();
        return s <= t && e > t;
      });
      // 08:50 should be in a busy zone (travel buffer), so no free interval should contain it
      expect(freeAt0850).toBeUndefined();
    });

    it("AC1: trip blocks survive account filtering", async () => {
      // Trip constraint creates internal derived events
      ug.addConstraint(
        "trip",
        { name: "NYC Trip", timezone: "UTC", block_policy: "BUSY" },
        "2026-02-16T10:00:00Z",
        "2026-02-16T15:00:00Z",
      );

      // Regular event on a specific account
      const delta = makeCreatedDelta({
        origin_event_id: "evt_account_filter_1",
        event: {
          ...makeCreatedDelta().event!,
          origin_event_id: "evt_account_filter_1",
          title: "Team Meeting",
          start: { dateTime: "2026-02-16T09:00:00Z" },
          end: { dateTime: "2026-02-16T09:30:00Z" },
        },
      });
      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [delta]);

      // Query with account filter -- trip should still appear
      const result = ug.computeAvailability({
        start: "2026-02-16T08:00:00Z",
        end: "2026-02-16T18:00:00Z",
        accounts: [TEST_ACCOUNT_ID],
      });

      // Trip block at 10:00-15:00 should be in busy intervals
      // (even though we filtered to TEST_ACCOUNT_ID only)
      const tripBusy = result.busy_intervals.find((b) => {
        const s = new Date(b.start).getTime();
        const e = new Date(b.end).getTime();
        return s <= new Date("2026-02-16T10:00:00Z").getTime() &&
               e >= new Date("2026-02-16T15:00:00Z").getTime();
      });
      expect(tripBusy).toBeDefined();

      // Also verify the regular meeting is busy
      const meetingBusy = result.busy_intervals.find((b) => {
        const s = new Date(b.start).getTime();
        return s <= new Date("2026-02-16T09:00:00Z").getTime();
      });
      expect(meetingBusy).toBeDefined();
    });

    it("AC4: performance under 500ms for 1-week range with 10+ constraints", async () => {
      // Create 10+ constraints of various types
      ug.addConstraint(
        "working_hours",
        { days: [1, 2, 3, 4, 5], start_time: "09:00", end_time: "17:00", timezone: "UTC" },
        null,
        null,
      );
      ug.addConstraint(
        "working_hours",
        { days: [6], start_time: "10:00", end_time: "14:00", timezone: "UTC" },
        null,
        null,
      );

      // Add 3 trip constraints across the week
      ug.addConstraint(
        "trip",
        { name: "Monday Trip", timezone: "UTC", block_policy: "BUSY" },
        "2026-02-16T14:00:00Z",
        "2026-02-16T16:00:00Z",
      );
      ug.addConstraint(
        "trip",
        { name: "Wednesday Trip", timezone: "UTC", block_policy: "TITLE" },
        "2026-02-18T10:00:00Z",
        "2026-02-18T12:00:00Z",
      );
      ug.addConstraint(
        "trip",
        { name: "Friday Trip", timezone: "UTC", block_policy: "BUSY" },
        "2026-02-20T13:00:00Z",
        "2026-02-20T15:00:00Z",
      );

      // Add 3 buffer constraints
      ug.addConstraint(
        "buffer",
        { type: "travel", minutes: 15, applies_to: "all" },
        null,
        null,
      );
      ug.addConstraint(
        "buffer",
        { type: "cooldown", minutes: 10, applies_to: "all" },
        null,
        null,
      );
      ug.addConstraint(
        "buffer",
        { type: "prep", minutes: 5, applies_to: "external" },
        null,
        null,
      );

      // Add 2 no_meetings_after constraints
      ug.addConstraint(
        "no_meetings_after",
        { time: "18:00", timezone: "UTC" },
        null,
        null,
      );
      ug.addConstraint(
        "no_meetings_after",
        { time: "16:00", timezone: "America/New_York" },
        null,
        null,
      );

      // Add events across the week (20 events)
      for (let day = 16; day <= 20; day++) {
        for (let hour = 9; hour <= 12; hour++) {
          const evtId = `evt_perf_${day}_${hour}`;
          const delta = makeCreatedDelta({
            origin_event_id: evtId,
            event: {
              ...makeCreatedDelta().event!,
              origin_event_id: evtId,
              title: `Meeting ${day}-${hour}`,
              start: { dateTime: `2026-02-${day}T${hour.toString().padStart(2, "0")}:00:00Z` },
              end: { dateTime: `2026-02-${day}T${hour.toString().padStart(2, "0")}:30:00Z` },
            },
          });
          await ug.applyProviderDelta(TEST_ACCOUNT_ID, [delta]);
        }
      }

      // Verify constraint count >= 10
      const allConstraints = ug.listConstraints();
      expect(allConstraints.length).toBeGreaterThanOrEqual(10);

      // Measure performance: 1-week range
      const startTime = performance.now();
      const result = ug.computeAvailability({
        start: "2026-02-16T00:00:00Z",
        end: "2026-02-23T00:00:00Z",
      });
      const elapsed = performance.now() - startTime;

      // AC4: Must complete in under 500ms
      expect(elapsed).toBeLessThan(500);

      // Verify results are non-empty (the computation actually ran)
      expect(result.busy_intervals.length).toBeGreaterThan(0);
      expect(result.free_intervals.length).toBeGreaterThan(0);

      // Verify all constraint types contributed
      // (busy intervals should exist from working hours, trips, buffers, events)
      const totalBusyMs = result.busy_intervals.reduce((sum, b) =>
        sum + (new Date(b.end).getTime() - new Date(b.start).getTime()), 0,
      );
      // A full week is 7 * 24 * 60 * 60 * 1000 = 604800000ms
      // With working hours (only 5 weekdays * 8 hours = 40 hours working),
      // most of the week should be busy. Total busy > 60% of the week.
      expect(totalBusyMs).toBeGreaterThan(604800000 * 0.5);
    });

    it("AC3: buffers apply to trip-derived events", async () => {
      // A trip creates a derived event. Buffers should apply around it.
      ug.addConstraint(
        "trip",
        { name: "Office Trip", timezone: "UTC", block_policy: "BUSY" },
        "2026-02-16T10:00:00Z",
        "2026-02-16T14:00:00Z",
      );

      // 30 min travel buffer before all events
      ug.addConstraint(
        "buffer",
        { type: "travel", minutes: 30, applies_to: "all" },
        null,
        null,
      );

      const result = ug.computeAvailability({
        start: "2026-02-16T08:00:00Z",
        end: "2026-02-16T16:00:00Z",
      });

      // Trip: 10:00-14:00. Travel buffer: 09:30-10:00.
      // Merged: 09:30-14:00 busy.
      // Free: 08:00-09:30, 14:00-16:00

      const firstFree = result.free_intervals[0];
      expect(firstFree).toBeDefined();
      expect(new Date(firstFree.start).getTime()).toBe(
        new Date("2026-02-16T08:00:00Z").getTime(),
      );
      // First free period should end at 09:30 (buffer start)
      expect(new Date(firstFree.end).getTime()).toBe(
        new Date("2026-02-16T09:30:00.000Z").getTime(),
      );
    });
  });
});
