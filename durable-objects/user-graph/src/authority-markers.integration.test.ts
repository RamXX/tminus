/**
 * Integration tests for authority markers and conflict detection in
 * applyProviderDelta.
 *
 * Uses real SQLite (better-sqlite3) and real DO logic. Tests prove:
 * - authority_markers column is populated on every INSERT
 * - authority_markers are updated on every UPDATE
 * - conflict detection when a provider modifies a tminus-owned field
 * - conflict journal entries with conflict_type and resolution
 * - backward compatibility: existing events with empty markers work
 * - no conflict when same provider modifies own fields
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
import { USER_GRAPH_DO_MIGRATIONS } from "@tminus/shared";
import { UserGraphDO } from "./index";
import type { QueueLike, AuthorityMarkers } from "./index";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const ACCOUNT_A = "acc_01AUTHORITY_A_00000000001" as AccountId;
const ACCOUNT_B = "acc_01AUTHORITY_B_00000000002" as AccountId;

function makeCreatedDelta(overrides?: Partial<ProviderDelta>): ProviderDelta {
  return {
    type: "created",
    origin_event_id: "evt_origin_001",
    origin_account_id: ACCOUNT_A,
    event: {
      origin_account_id: ACCOUNT_A,
      origin_event_id: "evt_origin_001",
      title: "Morning Standup",
      description: "Daily sync",
      location: "Room Alpha",
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
    origin_event_id: "evt_origin_001",
    origin_account_id: ACCOUNT_A,
    event: {
      origin_account_id: ACCOUNT_A,
      origin_event_id: "evt_origin_001",
      title: "Morning Standup (Moved)",
      description: "Daily sync - new time",
      location: "Room Beta",
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
// Test suite
// ---------------------------------------------------------------------------

describe("Authority markers integration", () => {
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
  // AC1: authority_markers populated on every INSERT
  // -------------------------------------------------------------------------

  describe("authority_markers on INSERT", () => {
    it("populates authority_markers with provider ownership for all non-null fields", async () => {
      const delta = makeCreatedDelta();
      await ug.applyProviderDelta(ACCOUNT_A, [delta]);

      const row = db
        .prepare("SELECT authority_markers FROM canonical_events LIMIT 1")
        .get() as { authority_markers: string };

      expect(row.authority_markers).toBeTruthy();
      const markers: AuthorityMarkers = JSON.parse(row.authority_markers);

      expect(markers.title).toBe(`provider:${ACCOUNT_A}`);
      expect(markers.description).toBe(`provider:${ACCOUNT_A}`);
      expect(markers.location).toBe(`provider:${ACCOUNT_A}`);
      expect(markers.start_ts).toBe(`provider:${ACCOUNT_A}`);
      expect(markers.end_ts).toBe(`provider:${ACCOUNT_A}`);
      expect(markers.status).toBe(`provider:${ACCOUNT_A}`);
      expect(markers.visibility).toBe(`provider:${ACCOUNT_A}`);
      expect(markers.transparency).toBe(`provider:${ACCOUNT_A}`);
    });

    it("does not include null fields (recurrence_rule) in markers", async () => {
      const delta = makeCreatedDelta();
      await ug.applyProviderDelta(ACCOUNT_A, [delta]);

      const row = db
        .prepare("SELECT authority_markers FROM canonical_events LIMIT 1")
        .get() as { authority_markers: string };
      const markers: AuthorityMarkers = JSON.parse(row.authority_markers);

      // recurrence_rule was not set, should not be in markers
      expect(markers.recurrence_rule).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // AC1 continued: authority_markers updated on every UPDATE
  // -------------------------------------------------------------------------

  describe("authority_markers on UPDATE", () => {
    it("updates authority_markers when same provider updates event", async () => {
      // Create the event
      await ug.applyProviderDelta(ACCOUNT_A, [makeCreatedDelta()]);

      // Update the event with same provider
      await ug.applyProviderDelta(ACCOUNT_A, [makeUpdatedDelta()]);

      const row = db
        .prepare("SELECT authority_markers FROM canonical_events LIMIT 1")
        .get() as { authority_markers: string };
      const markers: AuthorityMarkers = JSON.parse(row.authority_markers);

      // All fields should still be owned by ACCOUNT_A
      expect(markers.title).toBe(`provider:${ACCOUNT_A}`);
      expect(markers.location).toBe(`provider:${ACCOUNT_A}`);
    });

    it("updates authority_markers when dedup-update occurs on duplicate create", async () => {
      // Create the event
      await ug.applyProviderDelta(ACCOUNT_A, [makeCreatedDelta()]);

      // Send another "created" delta for the same event (dedup path)
      await ug.applyProviderDelta(ACCOUNT_A, [
        makeCreatedDelta({
          event: {
            ...makeCreatedDelta().event!,
            title: "Dedup Updated Title",
          },
        }),
      ]);

      const row = db
        .prepare("SELECT authority_markers, title FROM canonical_events LIMIT 1")
        .get() as { authority_markers: string; title: string };
      const markers: AuthorityMarkers = JSON.parse(row.authority_markers);

      expect(row.title).toBe("Dedup Updated Title");
      expect(markers.title).toBe(`provider:${ACCOUNT_A}`);
    });
  });

  // -------------------------------------------------------------------------
  // AC2: event_journal records conflict_type and resolution
  // -------------------------------------------------------------------------

  describe("conflict detection and journal recording", () => {
    it("records conflict_type and resolution when provider overrides tminus-owned field", async () => {
      // Step 1: Create event with ACCOUNT_A
      await ug.applyProviderDelta(ACCOUNT_A, [makeCreatedDelta()]);

      // Step 2: Manually set tminus authority on the title field
      // (simulating what would happen when T-Minus modifies a field via policy)
      const currentMarkers = db
        .prepare("SELECT authority_markers FROM canonical_events LIMIT 1")
        .get() as { authority_markers: string };
      const markers: AuthorityMarkers = JSON.parse(currentMarkers.authority_markers);
      markers.title = "tminus";
      db.prepare("UPDATE canonical_events SET authority_markers = ?").run(
        JSON.stringify(markers),
      );

      // Step 3: Provider update arrives that changes title
      await ug.applyProviderDelta(ACCOUNT_A, [
        makeUpdatedDelta({
          event: {
            ...makeUpdatedDelta().event!,
            title: "Provider Override Title",
          },
        }),
      ]);

      // Verify event was updated (provider wins)
      const event = db
        .prepare("SELECT title FROM canonical_events LIMIT 1")
        .get() as { title: string };
      expect(event.title).toBe("Provider Override Title");

      // Verify conflict was recorded in journal
      const conflictEntries = db
        .prepare(
          "SELECT conflict_type, resolution, change_type FROM event_journal WHERE conflict_type != 'none' ORDER BY rowid DESC",
        )
        .all() as Array<{
        conflict_type: string;
        resolution: string;
        change_type: string;
      }>;

      expect(conflictEntries.length).toBeGreaterThanOrEqual(1);
      const entry = conflictEntries[0];
      expect(entry.conflict_type).toBe("field_override");
      expect(entry.change_type).toBe("authority_conflict");

      const resolution = JSON.parse(entry.resolution);
      expect(resolution.strategy).toBe("provider_wins");
      expect(resolution.conflicts).toHaveLength(1);
      expect(resolution.conflicts[0].field).toBe("title");
      expect(resolution.conflicts[0].current_authority).toBe("tminus");
      expect(resolution.conflicts[0].incoming_authority).toBe(`provider:${ACCOUNT_A}`);
      expect(resolution.conflicts[0].old_value).toBe("Morning Standup");
      expect(resolution.conflicts[0].new_value).toBe("Provider Override Title");
    });

    it("records no conflict journal entry when same provider modifies own fields", async () => {
      // Create and update with same provider
      await ug.applyProviderDelta(ACCOUNT_A, [makeCreatedDelta()]);
      await ug.applyProviderDelta(ACCOUNT_A, [makeUpdatedDelta()]);

      // Check no conflict entries exist
      const conflictEntries = db
        .prepare(
          "SELECT * FROM event_journal WHERE conflict_type != 'none'",
        )
        .all();

      expect(conflictEntries).toHaveLength(0);
    });

    it("default conflict_type is 'none' for normal journal entries", async () => {
      await ug.applyProviderDelta(ACCOUNT_A, [makeCreatedDelta()]);

      const entries = db
        .prepare("SELECT conflict_type, resolution FROM event_journal")
        .all() as Array<{ conflict_type: string; resolution: string | null }>;

      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        expect(entry.conflict_type).toBe("none");
        expect(entry.resolution).toBeNull();
      }
    });
  });

  // -------------------------------------------------------------------------
  // AC3: applyProviderDelta detects tminus-owned field override
  // -------------------------------------------------------------------------

  describe("full conflict detection flow", () => {
    it("detects multiple field conflicts in a single update", async () => {
      // Create event
      await ug.applyProviderDelta(ACCOUNT_A, [makeCreatedDelta()]);

      // Set multiple fields as tminus-owned
      const raw = db
        .prepare("SELECT authority_markers FROM canonical_events LIMIT 1")
        .get() as { authority_markers: string };
      const markers: AuthorityMarkers = JSON.parse(raw.authority_markers);
      markers.title = "tminus";
      markers.description = "tminus";
      markers.location = "tminus";
      db.prepare("UPDATE canonical_events SET authority_markers = ?").run(
        JSON.stringify(markers),
      );

      // Provider updates all three tminus-owned fields
      await ug.applyProviderDelta(ACCOUNT_A, [
        makeUpdatedDelta({
          event: {
            ...makeUpdatedDelta().event!,
            title: "Override 1",
            description: "Override 2",
            location: "Override 3",
          },
        }),
      ]);

      // Verify all three conflicts recorded
      const conflictEntries = db
        .prepare(
          "SELECT resolution FROM event_journal WHERE conflict_type = 'field_override'",
        )
        .all() as Array<{ resolution: string }>;

      expect(conflictEntries).toHaveLength(1); // Single conflict entry with all 3 fields
      const resolution = JSON.parse(conflictEntries[0].resolution);
      expect(resolution.conflicts).toHaveLength(3);

      const fields = resolution.conflicts.map(
        (c: { field: string }) => c.field,
      ).sort();
      expect(fields).toEqual(["description", "location", "title"]);
    });

    it("does not produce conflict when field value is unchanged even with different authority", async () => {
      // Create event
      await ug.applyProviderDelta(ACCOUNT_A, [makeCreatedDelta()]);

      // Set title as tminus-owned
      const raw = db
        .prepare("SELECT authority_markers FROM canonical_events LIMIT 1")
        .get() as { authority_markers: string };
      const markers: AuthorityMarkers = JSON.parse(raw.authority_markers);
      markers.title = "tminus";
      db.prepare("UPDATE canonical_events SET authority_markers = ?").run(
        JSON.stringify(markers),
      );

      // Provider sends update with SAME title (no actual change)
      await ug.applyProviderDelta(ACCOUNT_A, [
        makeUpdatedDelta({
          event: {
            ...makeCreatedDelta().event!, // same values as original
          },
        }),
      ]);

      // No conflict should be recorded because the value didn't change
      const conflictEntries = db
        .prepare(
          "SELECT * FROM event_journal WHERE conflict_type = 'field_override'",
        )
        .all();

      expect(conflictEntries).toHaveLength(0);
    });

    it("provider wins and authority transfers to incoming provider on conflict", async () => {
      // Create event with ACCOUNT_A
      await ug.applyProviderDelta(ACCOUNT_A, [makeCreatedDelta()]);

      // Set title as tminus-owned
      const raw = db
        .prepare("SELECT authority_markers FROM canonical_events LIMIT 1")
        .get() as { authority_markers: string };
      const markers: AuthorityMarkers = JSON.parse(raw.authority_markers);
      markers.title = "tminus";
      db.prepare("UPDATE canonical_events SET authority_markers = ?").run(
        JSON.stringify(markers),
      );

      // Provider overrides tminus-owned title
      await ug.applyProviderDelta(ACCOUNT_A, [
        makeUpdatedDelta({
          event: {
            ...makeUpdatedDelta().event!,
            title: "Provider Wins",
          },
        }),
      ]);

      // Verify authority transferred to the provider
      const updated = db
        .prepare("SELECT authority_markers FROM canonical_events LIMIT 1")
        .get() as { authority_markers: string };
      const updatedMarkers: AuthorityMarkers = JSON.parse(
        updated.authority_markers,
      );

      expect(updatedMarkers.title).toBe(`provider:${ACCOUNT_A}`);
    });
  });

  // -------------------------------------------------------------------------
  // AC4: Backward compatibility
  // -------------------------------------------------------------------------

  describe("backward compatibility", () => {
    it("existing events with default empty markers are treated as provider-owned", async () => {
      // Create event (will have markers)
      await ug.applyProviderDelta(ACCOUNT_A, [makeCreatedDelta()]);

      // Simulate legacy: wipe authority_markers to empty default
      db.prepare("UPDATE canonical_events SET authority_markers = '{}'").run();

      // Update with same provider should produce no conflicts
      await ug.applyProviderDelta(ACCOUNT_A, [makeUpdatedDelta()]);

      const conflictEntries = db
        .prepare(
          "SELECT * FROM event_journal WHERE conflict_type != 'none'",
        )
        .all();

      expect(conflictEntries).toHaveLength(0);
    });

    it("legacy events get authority markers populated after first update", async () => {
      // Create event
      await ug.applyProviderDelta(ACCOUNT_A, [makeCreatedDelta()]);

      // Simulate legacy: wipe authority_markers
      db.prepare("UPDATE canonical_events SET authority_markers = '{}'").run();

      // Update event
      await ug.applyProviderDelta(ACCOUNT_A, [makeUpdatedDelta()]);

      // After update, markers should be populated
      const row = db
        .prepare("SELECT authority_markers FROM canonical_events LIMIT 1")
        .get() as { authority_markers: string };
      const markers: AuthorityMarkers = JSON.parse(row.authority_markers);

      expect(Object.keys(markers).length).toBeGreaterThan(0);
      expect(markers.title).toBe(`provider:${ACCOUNT_A}`);
    });
  });

  // -------------------------------------------------------------------------
  // AC5: All existing DO integration tests pass unchanged
  // (covered by running existing test suite -- this section adds schema
  // verification to confirm migration v8 applied correctly)
  // -------------------------------------------------------------------------

  describe("schema migration v8", () => {
    it("canonical_events table has authority_markers column", async () => {
      // Trigger migration by calling any DO method
      await ug.applyProviderDelta(ACCOUNT_A, [makeCreatedDelta()]);

      const columns = db
        .prepare("PRAGMA table_info(canonical_events)")
        .all() as Array<{ name: string; dflt_value: string | null }>;

      const authorityCol = columns.find((c) => c.name === "authority_markers");
      expect(authorityCol).toBeDefined();
      expect(authorityCol!.dflt_value).toBe("'{}'");
    });

    it("event_journal table has conflict_type and resolution columns", async () => {
      // Trigger migration
      await ug.applyProviderDelta(ACCOUNT_A, [makeCreatedDelta()]);

      const columns = db
        .prepare("PRAGMA table_info(event_journal)")
        .all() as Array<{ name: string; dflt_value: string | null }>;

      const conflictCol = columns.find((c) => c.name === "conflict_type");
      expect(conflictCol).toBeDefined();
      expect(conflictCol!.dflt_value).toBe("'none'");

      const resolutionCol = columns.find((c) => c.name === "resolution");
      expect(resolutionCol).toBeDefined();
    });

    it("schema_meta reports latest schema version", async () => {
      // Trigger migration
      await ug.applyProviderDelta(ACCOUNT_A, [makeCreatedDelta()]);

      const meta = db
        .prepare("SELECT value FROM _schema_meta WHERE key = 'user_graph_version'")
        .get() as { value: string };
      expect(parseInt(meta.value, 10)).toBe(
        USER_GRAPH_DO_MIGRATIONS[USER_GRAPH_DO_MIGRATIONS.length - 1].version,
      );
    });
  });

  // -------------------------------------------------------------------------
  // TM-teqr AC1: Canonical event API responses include authority_markers
  // -------------------------------------------------------------------------

  describe("authority_markers in API responses (TM-teqr AC1)", () => {
    it("getCanonicalEvent includes parsed authority_markers", async () => {
      await ug.applyProviderDelta(ACCOUNT_A, [makeCreatedDelta()]);

      // Get the canonical event ID
      const row = db
        .prepare("SELECT canonical_event_id FROM canonical_events LIMIT 1")
        .get() as { canonical_event_id: string };

      const result = ug.getCanonicalEvent(row.canonical_event_id);

      expect(result).not.toBeNull();
      expect(result!.event.authority_markers).toBeDefined();
      expect(result!.event.authority_markers!.title).toBe(
        `provider:${ACCOUNT_A}`,
      );
      expect(result!.event.authority_markers!.start_ts).toBe(
        `provider:${ACCOUNT_A}`,
      );
    });

    it("listCanonicalEvents includes authority_markers on each event", async () => {
      await ug.applyProviderDelta(ACCOUNT_A, [makeCreatedDelta()]);

      const result = ug.listCanonicalEvents({});

      expect(result.items).toHaveLength(1);
      expect(result.items[0].authority_markers).toBeDefined();
      expect(result.items[0].authority_markers!.title).toBe(
        `provider:${ACCOUNT_A}`,
      );
    });

    it("authority_markers reflect updated ownership after provider update", async () => {
      await ug.applyProviderDelta(ACCOUNT_A, [makeCreatedDelta()]);

      // Set title as tminus-owned
      const raw = db
        .prepare("SELECT authority_markers FROM canonical_events LIMIT 1")
        .get() as { authority_markers: string };
      const markers: AuthorityMarkers = JSON.parse(raw.authority_markers);
      markers.title = "tminus";
      db.prepare("UPDATE canonical_events SET authority_markers = ?").run(
        JSON.stringify(markers),
      );

      // Provider updates (overwrites tminus title)
      await ug.applyProviderDelta(ACCOUNT_A, [
        makeUpdatedDelta({
          event: {
            ...makeUpdatedDelta().event!,
            title: "Provider Won",
          },
        }),
      ]);

      const row = db
        .prepare("SELECT canonical_event_id FROM canonical_events LIMIT 1")
        .get() as { canonical_event_id: string };
      const result = ug.getCanonicalEvent(row.canonical_event_id);

      // After provider wins, authority should transfer back to provider
      expect(result!.event.authority_markers!.title).toBe(
        `provider:${ACCOUNT_A}`,
      );
    });
  });

  // -------------------------------------------------------------------------
  // TM-teqr AC2: Conflict journal entries queryable via getEventConflicts
  // -------------------------------------------------------------------------

  describe("getEventConflicts endpoint (TM-teqr AC2)", () => {
    it("returns conflict entries for an event with authority conflicts", async () => {
      // Create event
      await ug.applyProviderDelta(ACCOUNT_A, [makeCreatedDelta()]);

      // Set title as tminus-owned
      const raw = db
        .prepare(
          "SELECT canonical_event_id, authority_markers FROM canonical_events LIMIT 1",
        )
        .get() as { canonical_event_id: string; authority_markers: string };
      const markers: AuthorityMarkers = JSON.parse(raw.authority_markers);
      markers.title = "tminus";
      db.prepare("UPDATE canonical_events SET authority_markers = ?").run(
        JSON.stringify(markers),
      );

      // Provider overrides tminus-owned field
      await ug.applyProviderDelta(ACCOUNT_A, [
        makeUpdatedDelta({
          event: {
            ...makeUpdatedDelta().event!,
            title: "Provider Override",
          },
        }),
      ]);

      const result = ug.getEventConflicts({
        canonical_event_id: raw.canonical_event_id,
      });

      expect(result.items.length).toBeGreaterThanOrEqual(1);
      expect(result.items[0].conflict_type).toBe("field_override");
      expect(result.items[0].resolution).toBeTruthy();

      const resolution = JSON.parse(result.items[0].resolution!);
      expect(resolution.strategy).toBe("provider_wins");
      expect(resolution.conflicts).toHaveLength(1);
      expect(resolution.conflicts[0].field).toBe("title");
      expect(resolution.conflicts[0].current_authority).toBe("tminus");
      expect(resolution.conflicts[0].incoming_authority).toBe(
        `provider:${ACCOUNT_A}`,
      );
    });

    it("returns empty array for event with no conflicts", async () => {
      // Create and update with same provider -- no conflicts
      await ug.applyProviderDelta(ACCOUNT_A, [makeCreatedDelta()]);
      await ug.applyProviderDelta(ACCOUNT_A, [makeUpdatedDelta()]);

      const row = db
        .prepare("SELECT canonical_event_id FROM canonical_events LIMIT 1")
        .get() as { canonical_event_id: string };

      const result = ug.getEventConflicts({
        canonical_event_id: row.canonical_event_id,
      });

      expect(result.items).toHaveLength(0);
      expect(result.has_more).toBe(false);
    });

    it("supports pagination with cursor and limit", async () => {
      // Create event
      await ug.applyProviderDelta(ACCOUNT_A, [makeCreatedDelta()]);

      const row = db
        .prepare(
          "SELECT canonical_event_id, authority_markers FROM canonical_events LIMIT 1",
        )
        .get() as { canonical_event_id: string; authority_markers: string };

      // Generate multiple conflicts by repeatedly overriding tminus-owned fields
      for (let i = 0; i < 3; i++) {
        // Set title as tminus-owned each time
        const markers: AuthorityMarkers = JSON.parse(
          (
            db
              .prepare("SELECT authority_markers FROM canonical_events LIMIT 1")
              .get() as { authority_markers: string }
          ).authority_markers,
        );
        markers.title = "tminus";
        db.prepare("UPDATE canonical_events SET authority_markers = ?").run(
          JSON.stringify(markers),
        );

        // Provider overrides
        await ug.applyProviderDelta(ACCOUNT_A, [
          makeUpdatedDelta({
            event: {
              ...makeUpdatedDelta().event!,
              title: `Override ${i}`,
            },
          }),
        ]);
      }

      // Fetch with limit=1
      const page1 = ug.getEventConflicts({
        canonical_event_id: row.canonical_event_id,
        limit: 1,
      });

      expect(page1.items).toHaveLength(1);
      expect(page1.has_more).toBe(true);
      expect(page1.cursor).toBeTruthy();

      // Fetch next page
      const page2 = ug.getEventConflicts({
        canonical_event_id: row.canonical_event_id,
        limit: 1,
        cursor: page1.cursor!,
      });

      expect(page2.items).toHaveLength(1);
      expect(page2.has_more).toBe(true);
      // Different entry than page 1
      expect(page2.items[0].journal_id).not.toBe(page1.items[0].journal_id);
    });

    it("is accessible via handleFetch dispatch", async () => {
      // Create event with a conflict
      await ug.applyProviderDelta(ACCOUNT_A, [makeCreatedDelta()]);

      const row = db
        .prepare(
          "SELECT canonical_event_id, authority_markers FROM canonical_events LIMIT 1",
        )
        .get() as { canonical_event_id: string; authority_markers: string };

      // Set tminus authority and trigger conflict
      const markers: AuthorityMarkers = JSON.parse(row.authority_markers);
      markers.title = "tminus";
      db.prepare("UPDATE canonical_events SET authority_markers = ?").run(
        JSON.stringify(markers),
      );
      await ug.applyProviderDelta(ACCOUNT_A, [
        makeUpdatedDelta({
          event: { ...makeUpdatedDelta().event!, title: "Override" },
        }),
      ]);

      // Call via handleFetch (the same path API workers use)
      const request = new Request("https://do/getEventConflicts", {
        method: "POST",
        body: JSON.stringify({
          canonical_event_id: row.canonical_event_id,
        }),
      });

      const response = await ug.handleFetch(request);
      expect(response.status).toBe(200);

      const data = (await response.json()) as {
        items: Array<{
          conflict_type: string;
          resolution: string;
        }>;
        has_more: boolean;
      };

      expect(data.items.length).toBeGreaterThanOrEqual(1);
      expect(data.items[0].conflict_type).toBe("field_override");
    });
  });

  // -------------------------------------------------------------------------
  // TM-teqr AC1 continued: queryJournal now includes conflict_type/resolution
  // -------------------------------------------------------------------------

  describe("queryJournal includes conflict fields (TM-teqr)", () => {
    it("returns conflict_type and resolution in journal entries", async () => {
      // Create event, generate conflict
      await ug.applyProviderDelta(ACCOUNT_A, [makeCreatedDelta()]);

      const raw = db
        .prepare(
          "SELECT canonical_event_id, authority_markers FROM canonical_events LIMIT 1",
        )
        .get() as { canonical_event_id: string; authority_markers: string };

      const markers: AuthorityMarkers = JSON.parse(raw.authority_markers);
      markers.title = "tminus";
      db.prepare("UPDATE canonical_events SET authority_markers = ?").run(
        JSON.stringify(markers),
      );

      await ug.applyProviderDelta(ACCOUNT_A, [
        makeUpdatedDelta({
          event: { ...makeUpdatedDelta().event!, title: "Override" },
        }),
      ]);

      const result = ug.queryJournal({
        canonical_event_id: raw.canonical_event_id,
      });

      // Should have normal entries (conflict_type = "none") and conflict entries
      const normalEntries = result.items.filter(
        (e) => e.conflict_type === "none",
      );
      const conflictEntries = result.items.filter(
        (e) => e.conflict_type !== "none",
      );

      expect(normalEntries.length).toBeGreaterThan(0);
      expect(conflictEntries.length).toBeGreaterThan(0);

      // Normal entries have null resolution
      expect(normalEntries[0].resolution).toBeNull();

      // Conflict entries have resolution JSON
      expect(conflictEntries[0].conflict_type).toBe("field_override");
      expect(conflictEntries[0].resolution).toBeTruthy();
    });
  });
});
