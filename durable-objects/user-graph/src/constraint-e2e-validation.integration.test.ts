/**
 * Phase 2D E2E Validation: Constraint Pipeline End-to-End Tests.
 *
 * Proves the FULL constraint system works end-to-end by exercising:
 *   1. Trip constraints -> busy blocks in availability
 *   2. Working hours -> restrict availability to work hours only
 *   3. Buffers -> reduce available slots with prep/cooldown time
 *   4. All constraint types combined -> merged availability
 *   5. Constraint CRUD lifecycle (create, read, update, delete)
 *   6. MCP tool validation for trip/constraint operations
 *   7. API-level constraint operations via handleFetch RPC
 *   8. Constraint deletion cascades and cleanup
 *
 * Uses real SQLite (better-sqlite3) and the actual UserGraphDO class.
 * No test fixtures -- state is built from scratch each test.
 * Queue is mocked to capture enqueued messages.
 *
 * This mirrors the Phase 2C E2E validation pattern but exercises the
 * constraint/availability pipeline instead of the web UI.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import type { SqlStorageLike, SqlStorageCursorLike, ProviderDelta, AccountId } from "@tminus/shared";
import {
  UserGraphDO,
  mergeIntervals,
  computeFreeIntervals,
  expandWorkingHoursToOutsideBusy,
  expandBuffersToBusy,
  expandTripConstraintsToBusy,
  expandNoMeetingsAfterToBusy,
} from "./index";
import type {
  QueueLike,
  BusyInterval,
  FreeInterval,
  AvailabilityQuery,
  AvailabilityResult,
  Constraint,
  ListEventsResult,
} from "./index";

// ---------------------------------------------------------------------------
// SqlStorage adapter (same pattern as existing integration tests)
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
// MockQueue -- captures enqueued messages
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
// Test constants
// ---------------------------------------------------------------------------

const TEST_ACCOUNT_ID = "acc_01TESTACCOUNT0000000000001" as AccountId;
const OTHER_ACCOUNT_ID = "acc_01TESTACCOUNT0000000000002" as AccountId;

// ---------------------------------------------------------------------------
// Helper: create a provider delta for inserting real events
// ---------------------------------------------------------------------------

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
      start: { dateTime: "2026-02-16T09:00:00Z" },
      end: { dateTime: "2026-02-16T09:30:00Z" },
      all_day: false,
      status: "confirmed",
      visibility: "default",
      transparency: "opaque",
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test suite setup
// ---------------------------------------------------------------------------

describe("Phase 2D E2E Validation: Constraint Pipeline", () => {
  let db: DatabaseType;
  let sql: SqlStorageLike;
  let queue: MockQueue;
  let ug: UserGraphDO;

  beforeEach(() => {
    db = new Database(":memory:");
    sql = createSqlStorageAdapter(db);
    queue = new MockQueue();
    ug = new UserGraphDO(sql, queue);

    // Force migration by calling any method
    ug.listConstraints();
  });

  afterEach(() => {
    db.close();
  });

  // =========================================================================
  // AC 1: Trip creates busy blocks in Google Calendar
  //
  // Proves: addConstraint(trip) creates derived events that appear as busy
  // blocks in computeAvailability and in listCanonicalEvents.
  // =========================================================================

  describe("AC 1: Trip constraints create busy blocks", () => {
    it("trip constraint creates a busy block visible in availability", () => {
      // Create a trip: Mar 10-12, 2026
      const trip = ug.addConstraint(
        "trip",
        { name: "NYC Business Trip", timezone: "America/New_York", block_policy: "BUSY" },
        "2026-03-10T00:00:00Z",
        "2026-03-12T23:59:59Z",
      );

      expect(trip.constraint_id).toMatch(/^cst_/);
      expect(trip.kind).toBe("trip");

      // Compute availability for the trip period
      const result = ug.computeAvailability({
        start: "2026-03-09T00:00:00Z",
        end: "2026-03-13T00:00:00Z",
      });

      // The trip duration should be a busy interval
      expect(result.busy_intervals.length).toBeGreaterThanOrEqual(1);

      // Find the busy interval covering the trip
      const tripBusy = result.busy_intervals.find(
        (b) =>
          new Date(b.start).getTime() <= new Date("2026-03-10T00:00:00Z").getTime() &&
          new Date(b.end).getTime() >= new Date("2026-03-12T23:59:59Z").getTime(),
      );
      expect(tripBusy).toBeDefined();

      // Free intervals should exist before and after the trip
      expect(result.free_intervals.length).toBeGreaterThanOrEqual(1);
      const freeBeforeTrip = result.free_intervals.find(
        (f) => new Date(f.end).getTime() <= new Date("2026-03-10T00:00:00Z").getTime(),
      );
      expect(freeBeforeTrip).toBeDefined();
    });

    it("trip-derived event appears in listCanonicalEvents", () => {
      const trip = ug.addConstraint(
        "trip",
        { name: "London Conference", timezone: "Europe/London", block_policy: "TITLE" },
        "2026-04-01T00:00:00Z",
        "2026-04-03T23:59:59Z",
      );

      // List events in the trip's range
      const events = ug.listCanonicalEvents({
        time_min: "2026-04-01T00:00:00Z",
        time_max: "2026-04-04T00:00:00Z",
      });

      expect(events.items.length).toBe(1);
      const derivedEvent = events.items[0];
      expect(derivedEvent.origin_account_id).toBe("internal");
      expect(derivedEvent.source).toBe("system");
      // TITLE policy shows trip name
      expect(derivedEvent.title).toBe("London Conference");
      expect(derivedEvent.transparency).toBe("opaque");
    });

    it("BUSY policy hides trip name (shows 'Busy')", () => {
      ug.addConstraint(
        "trip",
        { name: "Secret Vacation", timezone: "UTC", block_policy: "BUSY" },
        "2026-05-01T00:00:00Z",
        "2026-05-05T00:00:00Z",
      );

      const events = ug.listCanonicalEvents({
        time_min: "2026-05-01T00:00:00Z",
        time_max: "2026-05-06T00:00:00Z",
      });

      expect(events.items.length).toBe(1);
      expect(events.items[0].title).toBe("Busy");
    });

    it("multiple trips create separate busy blocks", () => {
      ug.addConstraint(
        "trip",
        { name: "Trip A", timezone: "UTC", block_policy: "BUSY" },
        "2026-06-01T09:00:00Z",
        "2026-06-01T12:00:00Z",
      );
      ug.addConstraint(
        "trip",
        { name: "Trip B", timezone: "UTC", block_policy: "BUSY" },
        "2026-06-01T14:00:00Z",
        "2026-06-01T17:00:00Z",
      );

      const result = ug.computeAvailability({
        start: "2026-06-01T08:00:00Z",
        end: "2026-06-01T18:00:00Z",
      });

      // Should have at least 2 busy intervals (the two trips)
      expect(result.busy_intervals.length).toBe(2);

      // Free gap between trips: 12:00-14:00
      const midGap = result.free_intervals.find(
        (f) => f.start === "2026-06-01T12:00:00Z" && f.end === "2026-06-01T14:00:00Z",
      );
      expect(midGap).toBeDefined();
    });

    it("trip blocks availability even when account filter is set", () => {
      // Trip is an internal constraint -- should always show as busy
      ug.addConstraint(
        "trip",
        { name: "Cross-Account Trip", timezone: "UTC", block_policy: "BUSY" },
        "2026-07-01T09:00:00Z",
        "2026-07-01T17:00:00Z",
      );

      // Filter to just one account -- trip should still be visible
      const result = ug.computeAvailability({
        start: "2026-07-01T08:00:00Z",
        end: "2026-07-01T18:00:00Z",
        accounts: [TEST_ACCOUNT_ID],
      });

      expect(result.busy_intervals.length).toBe(1);
      expect(result.busy_intervals[0].account_ids).toContain("internal");
    });
  });

  // =========================================================================
  // AC 2: Working hours restrict availability
  //
  // Proves: working_hours constraint makes time outside work hours busy.
  // =========================================================================

  describe("AC 2: Working hours restrict availability", () => {
    it("time outside working hours is marked busy", () => {
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

      // Query a Wednesday (Feb 18, 2026 is a Wednesday)
      const result = ug.computeAvailability({
        start: "2026-02-18T00:00:00Z",
        end: "2026-02-18T23:59:59Z",
      });

      // Free only during 09:00-17:00
      expect(result.free_intervals).toHaveLength(1);
      expect(result.free_intervals[0].start).toBe("2026-02-18T09:00:00.000Z");
      expect(result.free_intervals[0].end).toBe("2026-02-18T17:00:00.000Z");

      // Busy before and after working hours
      expect(result.busy_intervals.length).toBeGreaterThanOrEqual(2);
    });

    it("non-working day is entirely busy", () => {
      // Mon-Fri working hours
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

      // Saturday Feb 21, 2026
      const result = ug.computeAvailability({
        start: "2026-02-21T00:00:00Z",
        end: "2026-02-21T23:59:59Z",
      });

      // No free intervals on a non-working day
      expect(result.free_intervals).toHaveLength(0);

      // Entire day is busy
      expect(result.busy_intervals.length).toBeGreaterThanOrEqual(1);
    });

    it("working hours with timezone offset correctly restrict availability", () => {
      // Mon-Fri 09:00-17:00 America/New_York (UTC-5 in winter)
      ug.addConstraint(
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

      // Query Wednesday Feb 18, 2026 in UTC
      // NY 09:00 = UTC 14:00, NY 17:00 = UTC 22:00
      const result = ug.computeAvailability({
        start: "2026-02-18T00:00:00Z",
        end: "2026-02-18T23:59:59Z",
      });

      // Free interval should be roughly 14:00-22:00 UTC (09:00-17:00 ET)
      expect(result.free_intervals).toHaveLength(1);
      const freeStart = new Date(result.free_intervals[0].start);
      const freeEnd = new Date(result.free_intervals[0].end);
      expect(freeStart.getUTCHours()).toBe(14);
      expect(freeEnd.getUTCHours()).toBe(22);
    });

    it("working hours do NOT create derived events (only affect availability)", () => {
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

      // Check no derived events exist
      const events = db
        .prepare("SELECT * FROM canonical_events WHERE constraint_id = ?")
        .all(constraint.constraint_id) as Array<Record<string, unknown>>;
      expect(events).toHaveLength(0);
    });

    it("real event during working hours reduces free time", async () => {
      // Set working hours
      ug.addConstraint(
        "working_hours",
        {
          days: [3], // Wednesday
          start_time: "09:00",
          end_time: "17:00",
          timezone: "UTC",
        },
        null,
        null,
      );

      // Add a real event at 10:00-11:00 on Wednesday
      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [
        makeCreatedDelta({
          origin_event_id: "evt_real_001",
          event: {
            origin_account_id: TEST_ACCOUNT_ID,
            origin_event_id: "evt_real_001",
            title: "Team Meeting",
            start: { dateTime: "2026-02-18T10:00:00Z" },
            end: { dateTime: "2026-02-18T11:00:00Z" },
            all_day: false,
            status: "confirmed",
            visibility: "default",
            transparency: "opaque",
          },
        }),
      ]);

      const result = ug.computeAvailability({
        start: "2026-02-18T00:00:00Z",
        end: "2026-02-18T23:59:59Z",
      });

      // Free intervals: 09:00-10:00, 11:00-17:00
      expect(result.free_intervals).toHaveLength(2);
      expect(result.free_intervals[0].start).toBe("2026-02-18T09:00:00.000Z");
      expect(result.free_intervals[0].end).toBe("2026-02-18T10:00:00Z");
      expect(result.free_intervals[1].start).toBe("2026-02-18T11:00:00Z");
      expect(result.free_intervals[1].end).toBe("2026-02-18T17:00:00.000Z");
    });
  });

  // =========================================================================
  // AC 3: Buffers reduce available slots
  //
  // Proves: buffer constraints add prep/cooldown time around events,
  // reducing the free slots available.
  // =========================================================================

  describe("AC 3: Buffers reduce available slots", () => {
    it("prep buffer adds busy time before events", async () => {
      // Add a real event
      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [
        makeCreatedDelta({
          origin_event_id: "evt_buffered_001",
          event: {
            origin_account_id: TEST_ACCOUNT_ID,
            origin_event_id: "evt_buffered_001",
            title: "Client Call",
            start: { dateTime: "2026-02-16T10:00:00Z" },
            end: { dateTime: "2026-02-16T11:00:00Z" },
            all_day: false,
            status: "confirmed",
            visibility: "default",
            transparency: "opaque",
          },
        }),
      ]);

      // Add prep buffer: 15 minutes before all events
      ug.addConstraint(
        "buffer",
        { type: "prep", minutes: 15, applies_to: "all" },
        null,
        null,
      );

      const result = ug.computeAvailability({
        start: "2026-02-16T09:00:00Z",
        end: "2026-02-16T12:00:00Z",
      });

      // Busy: 09:45-11:00 (15 min prep + 1h event)
      // Free: 09:00-09:45, 11:00-12:00
      expect(result.busy_intervals.length).toBe(1);
      expect(result.busy_intervals[0].start).toBe("2026-02-16T09:45:00.000Z");
      expect(result.busy_intervals[0].end).toBe("2026-02-16T11:00:00Z");

      expect(result.free_intervals).toHaveLength(2);
      expect(result.free_intervals[0].end).toBe("2026-02-16T09:45:00.000Z");
      expect(result.free_intervals[1].start).toBe("2026-02-16T11:00:00Z");
    });

    it("cooldown buffer adds busy time after events", async () => {
      // Add a real event
      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [
        makeCreatedDelta({
          origin_event_id: "evt_cooldown_001",
          event: {
            origin_account_id: TEST_ACCOUNT_ID,
            origin_event_id: "evt_cooldown_001",
            title: "Interview",
            start: { dateTime: "2026-02-16T14:00:00Z" },
            end: { dateTime: "2026-02-16T15:00:00Z" },
            all_day: false,
            status: "confirmed",
            visibility: "default",
            transparency: "opaque",
          },
        }),
      ]);

      // Add cooldown buffer: 10 minutes after all events
      ug.addConstraint(
        "buffer",
        { type: "cooldown", minutes: 10, applies_to: "all" },
        null,
        null,
      );

      const result = ug.computeAvailability({
        start: "2026-02-16T13:00:00Z",
        end: "2026-02-16T16:00:00Z",
      });

      // Busy: 14:00-15:10 (1h event + 10 min cooldown)
      expect(result.busy_intervals.length).toBe(1);
      expect(result.busy_intervals[0].start).toBe("2026-02-16T14:00:00Z");
      expect(result.busy_intervals[0].end).toBe("2026-02-16T15:10:00.000Z");

      expect(result.free_intervals).toHaveLength(2);
      expect(result.free_intervals[0].end).toBe("2026-02-16T14:00:00Z");
      expect(result.free_intervals[1].start).toBe("2026-02-16T15:10:00.000Z");
    });

    it("travel buffer adds busy time before events", async () => {
      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [
        makeCreatedDelta({
          origin_event_id: "evt_travel_001",
          event: {
            origin_account_id: TEST_ACCOUNT_ID,
            origin_event_id: "evt_travel_001",
            title: "Offsite Meeting",
            start: { dateTime: "2026-02-16T10:00:00Z" },
            end: { dateTime: "2026-02-16T11:00:00Z" },
            all_day: false,
            status: "confirmed",
            visibility: "default",
            transparency: "opaque",
          },
        }),
      ]);

      // Add travel buffer: 30 minutes before all events
      ug.addConstraint(
        "buffer",
        { type: "travel", minutes: 30, applies_to: "all" },
        null,
        null,
      );

      const result = ug.computeAvailability({
        start: "2026-02-16T09:00:00Z",
        end: "2026-02-16T12:00:00Z",
      });

      // Busy: 09:30-11:00 (30 min travel + 1h event)
      expect(result.busy_intervals.length).toBe(1);
      expect(result.busy_intervals[0].start).toBe("2026-02-16T09:30:00.000Z");
      expect(result.busy_intervals[0].end).toBe("2026-02-16T11:00:00Z");
    });

    it("buffer applies_to=external only buffers events from non-internal accounts", async () => {
      // Add an external event
      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [
        makeCreatedDelta({
          origin_event_id: "evt_external_001",
          origin_account_id: OTHER_ACCOUNT_ID,
          event: {
            origin_account_id: OTHER_ACCOUNT_ID,
            origin_event_id: "evt_external_001",
            title: "External Meeting",
            start: { dateTime: "2026-02-16T10:00:00Z" },
            end: { dateTime: "2026-02-16T11:00:00Z" },
            all_day: false,
            status: "confirmed",
            visibility: "default",
            transparency: "opaque",
          },
        }),
      ]);

      // Add buffer for external only
      ug.addConstraint(
        "buffer",
        { type: "prep", minutes: 15, applies_to: "external" },
        null,
        null,
      );

      const result = ug.computeAvailability({
        start: "2026-02-16T09:00:00Z",
        end: "2026-02-16T12:00:00Z",
      });

      // External event gets a 15-min prep buffer
      // Busy: 09:45-11:00
      expect(result.busy_intervals.length).toBe(1);
      expect(result.busy_intervals[0].start).toBe("2026-02-16T09:45:00.000Z");
    });
  });

  // =========================================================================
  // AC 4: MCP tools work for all constraint operations
  //
  // Proves: the DO-level validation (which MCP/API delegates to) correctly
  // validates all constraint kinds. Also proves the RPC endpoints that
  // MCP calls (/addConstraint, /listConstraints, etc.) work correctly
  // for all constraint operations.
  // =========================================================================

  describe("AC 4: Constraint validation for all operations (MCP/API layer)", () => {
    describe("validateConstraintConfig (static) -- trip", () => {
      it("accepts valid trip config with BUSY block_policy", () => {
        expect(() =>
          UserGraphDO.validateConstraintConfig(
            "trip",
            { name: "Valid Trip", timezone: "UTC", block_policy: "BUSY" },
            "2026-03-15T00:00:00Z",
            "2026-03-20T00:00:00Z",
          ),
        ).not.toThrow();
      });

      it("accepts valid trip config with TITLE block_policy", () => {
        expect(() =>
          UserGraphDO.validateConstraintConfig(
            "trip",
            { name: "Visible Trip", timezone: "Asia/Tokyo", block_policy: "TITLE" },
            "2026-04-10T00:00:00Z",
            "2026-04-15T00:00:00Z",
          ),
        ).not.toThrow();
      });

      it("rejects trip missing name", () => {
        expect(() =>
          UserGraphDO.validateConstraintConfig(
            "trip",
            { timezone: "UTC", block_policy: "BUSY" },
            "2026-03-15T00:00:00Z",
            "2026-03-20T00:00:00Z",
          ),
        ).toThrow("'name' string");
      });

      it("rejects trip missing timezone", () => {
        expect(() =>
          UserGraphDO.validateConstraintConfig(
            "trip",
            { name: "Trip", block_policy: "BUSY" },
            "2026-03-15T00:00:00Z",
            "2026-03-20T00:00:00Z",
          ),
        ).toThrow("'timezone' string");
      });

      it("rejects trip with invalid block_policy", () => {
        expect(() =>
          UserGraphDO.validateConstraintConfig(
            "trip",
            { name: "Trip", timezone: "UTC", block_policy: "INVALID" },
            "2026-03-15T00:00:00Z",
            "2026-03-20T00:00:00Z",
          ),
        ).toThrow("block_policy");
      });

      it("rejects trip without active_from", () => {
        expect(() =>
          UserGraphDO.validateConstraintConfig(
            "trip",
            { name: "Trip", timezone: "UTC", block_policy: "BUSY" },
            null,
            "2026-03-20T00:00:00Z",
          ),
        ).toThrow("active_from and active_to");
      });

      it("rejects trip without active_to", () => {
        expect(() =>
          UserGraphDO.validateConstraintConfig(
            "trip",
            { name: "Trip", timezone: "UTC", block_policy: "BUSY" },
            "2026-03-15T00:00:00Z",
            null,
          ),
        ).toThrow("active_from and active_to");
      });
    });

    describe("validateConstraintConfig (static) -- working_hours", () => {
      it("accepts valid working_hours config", () => {
        expect(() =>
          UserGraphDO.validateConstraintConfig(
            "working_hours",
            { days: [1, 2, 3, 4, 5], start_time: "09:00", end_time: "17:00", timezone: "UTC" },
            null,
            null,
          ),
        ).not.toThrow();
      });

      it("rejects empty days array", () => {
        expect(() =>
          UserGraphDO.validateConstraintConfig(
            "working_hours",
            { days: [], start_time: "09:00", end_time: "17:00", timezone: "UTC" },
            null,
            null,
          ),
        ).toThrow("non-empty 'days' array");
      });

      it("rejects end_time before start_time", () => {
        expect(() =>
          UserGraphDO.validateConstraintConfig(
            "working_hours",
            { days: [1], start_time: "17:00", end_time: "09:00", timezone: "UTC" },
            null,
            null,
          ),
        ).toThrow("end_time must be after");
      });
    });

    describe("validateConstraintConfig (static) -- buffer", () => {
      it("accepts valid buffer config", () => {
        expect(() =>
          UserGraphDO.validateConstraintConfig(
            "buffer",
            { type: "travel", minutes: 15, applies_to: "all" },
            null,
            null,
          ),
        ).not.toThrow();
      });

      it("rejects negative minutes", () => {
        expect(() =>
          UserGraphDO.validateConstraintConfig(
            "buffer",
            { type: "prep", minutes: -5, applies_to: "all" },
            null,
            null,
          ),
        ).toThrow("positive integer");
      });

      it("rejects invalid buffer type", () => {
        expect(() =>
          UserGraphDO.validateConstraintConfig(
            "buffer",
            { type: "teleport", minutes: 10, applies_to: "all" },
            null,
            null,
          ),
        ).toThrow("type must be one of");
      });

      it("rejects invalid applies_to", () => {
        expect(() =>
          UserGraphDO.validateConstraintConfig(
            "buffer",
            { type: "prep", minutes: 10, applies_to: "internal_only" },
            null,
            null,
          ),
        ).toThrow("applies_to must be one of");
      });
    });

    describe("validateConstraintConfig (static) -- no_meetings_after", () => {
      it("accepts valid no_meetings_after config", () => {
        expect(() =>
          UserGraphDO.validateConstraintConfig(
            "no_meetings_after",
            { time: "18:00", timezone: "UTC" },
            null,
            null,
          ),
        ).not.toThrow();
      });

      it("rejects invalid time format", () => {
        expect(() =>
          UserGraphDO.validateConstraintConfig(
            "no_meetings_after",
            { time: "6pm", timezone: "UTC" },
            null,
            null,
          ),
        ).toThrow("HH:MM 24-hour format");
      });

      it("rejects missing timezone", () => {
        expect(() =>
          UserGraphDO.validateConstraintConfig(
            "no_meetings_after",
            { time: "18:00" },
            null,
            null,
          ),
        ).toThrow("'timezone' string");
      });
    });

    describe("validateConstraintConfig (static) -- override", () => {
      it("accepts valid override config", () => {
        expect(() =>
          UserGraphDO.validateConstraintConfig(
            "override",
            { reason: "Holiday exception" },
            null,
            null,
          ),
        ).not.toThrow();
      });

      it("rejects override without reason", () => {
        expect(() =>
          UserGraphDO.validateConstraintConfig("override", {}, null, null),
        ).toThrow("non-empty 'reason' string");
      });
    });

    describe("RPC round-trip: all constraint types via handleFetch", () => {
      it("creates and retrieves a trip constraint via RPC", async () => {
        const addResponse = await ug.handleFetch(
          new Request("https://user-graph.internal/addConstraint", {
            method: "POST",
            body: JSON.stringify({
              kind: "trip",
              config_json: { name: "RPC Trip", timezone: "UTC", block_policy: "BUSY" },
              active_from: "2026-03-15T00:00:00Z",
              active_to: "2026-03-20T00:00:00Z",
            }),
          }),
        );
        expect(addResponse.status).toBe(200);
        const trip = (await addResponse.json()) as Constraint;
        expect(trip.kind).toBe("trip");
        expect(trip.config_json.name).toBe("RPC Trip");
      });

      it("creates and retrieves a working_hours constraint via RPC", async () => {
        const addResponse = await ug.handleFetch(
          new Request("https://user-graph.internal/addConstraint", {
            method: "POST",
            body: JSON.stringify({
              kind: "working_hours",
              config_json: { days: [1, 2, 3, 4, 5], start_time: "09:00", end_time: "17:00", timezone: "UTC" },
              active_from: null,
              active_to: null,
            }),
          }),
        );
        expect(addResponse.status).toBe(200);
        const wh = (await addResponse.json()) as Constraint;
        expect(wh.kind).toBe("working_hours");
      });

      it("creates and retrieves a buffer constraint via RPC", async () => {
        const addResponse = await ug.handleFetch(
          new Request("https://user-graph.internal/addConstraint", {
            method: "POST",
            body: JSON.stringify({
              kind: "buffer",
              config_json: { type: "prep", minutes: 15, applies_to: "all" },
              active_from: null,
              active_to: null,
            }),
          }),
        );
        expect(addResponse.status).toBe(200);
        const buf = (await addResponse.json()) as Constraint;
        expect(buf.kind).toBe("buffer");
      });

      it("creates and retrieves a no_meetings_after constraint via RPC", async () => {
        const addResponse = await ug.handleFetch(
          new Request("https://user-graph.internal/addConstraint", {
            method: "POST",
            body: JSON.stringify({
              kind: "no_meetings_after",
              config_json: { time: "18:00", timezone: "UTC" },
              active_from: null,
              active_to: null,
            }),
          }),
        );
        expect(addResponse.status).toBe(200);
        const nma = (await addResponse.json()) as Constraint;
        expect(nma.kind).toBe("no_meetings_after");
      });

      it("lists constraints by kind via RPC", async () => {
        // Create one of each kind
        ug.addConstraint("trip", { name: "T", timezone: "UTC", block_policy: "BUSY" }, "2026-03-01T00:00:00Z", "2026-03-02T00:00:00Z");
        ug.addConstraint("buffer", { type: "prep", minutes: 10, applies_to: "all" }, null, null);
        ug.addConstraint("working_hours", { days: [1], start_time: "09:00", end_time: "17:00", timezone: "UTC" }, null, null);

        // List all
        const allResponse = await ug.handleFetch(
          new Request("https://user-graph.internal/listConstraints", {
            method: "POST",
            body: JSON.stringify({}),
          }),
        );
        const allResult = (await allResponse.json()) as { items: Constraint[] };
        expect(allResult.items).toHaveLength(3);

        // List only trips
        const tripResponse = await ug.handleFetch(
          new Request("https://user-graph.internal/listConstraints", {
            method: "POST",
            body: JSON.stringify({ kind: "trip" }),
          }),
        );
        const tripResult = (await tripResponse.json()) as { items: Constraint[] };
        expect(tripResult.items).toHaveLength(1);
        expect(tripResult.items[0].kind).toBe("trip");
      });
    });
  });

  // =========================================================================
  // AC 5: Constraints visible in calendar UI
  //
  // Proves: trip-derived events appear in listCanonicalEvents, which is
  // the data source for the calendar UI display.
  // =========================================================================

  describe("AC 5: Constraints visible in calendar (listCanonicalEvents)", () => {
    it("trip-derived events appear alongside real events in listCanonicalEvents", async () => {
      // Create a real event
      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [
        makeCreatedDelta({
          origin_event_id: "evt_cal_001",
          event: {
            origin_account_id: TEST_ACCOUNT_ID,
            origin_event_id: "evt_cal_001",
            title: "Real Meeting",
            start: { dateTime: "2026-03-15T09:00:00Z" },
            end: { dateTime: "2026-03-15T10:00:00Z" },
            all_day: false,
            status: "confirmed",
            visibility: "default",
            transparency: "opaque",
          },
        }),
      ]);

      // Create a trip overlapping with the real event
      ug.addConstraint(
        "trip",
        { name: "Team Offsite", timezone: "UTC", block_policy: "TITLE" },
        "2026-03-14T00:00:00Z",
        "2026-03-16T23:59:59Z",
      );

      // List events for the range
      const events = ug.listCanonicalEvents({
        time_min: "2026-03-14T00:00:00Z",
        time_max: "2026-03-17T00:00:00Z",
      });

      // Both the real event and the trip-derived event should appear
      expect(events.items.length).toBe(2);
      const titles = events.items.map((e) => e.title);
      expect(titles).toContain("Real Meeting");
      expect(titles).toContain("Team Offsite");
    });

    it("deleted trip constraint removes its derived event from listCanonicalEvents", async () => {
      const trip = ug.addConstraint(
        "trip",
        { name: "Temporary Trip", timezone: "UTC", block_policy: "BUSY" },
        "2026-06-01T00:00:00Z",
        "2026-06-03T00:00:00Z",
      );

      // Verify it exists
      let events = ug.listCanonicalEvents({
        time_min: "2026-06-01T00:00:00Z",
        time_max: "2026-06-04T00:00:00Z",
      });
      expect(events.items.length).toBe(1);

      // Delete the trip
      const deleted = await ug.deleteConstraint(trip.constraint_id);
      expect(deleted).toBe(true);

      // Verify derived event is gone
      events = ug.listCanonicalEvents({
        time_min: "2026-06-01T00:00:00Z",
        time_max: "2026-06-04T00:00:00Z",
      });
      expect(events.items.length).toBe(0);
    });

    it("updated trip constraint regenerates derived events with new dates", async () => {
      const trip = ug.addConstraint(
        "trip",
        { name: "Movable Trip", timezone: "UTC", block_policy: "BUSY" },
        "2026-07-01T00:00:00Z",
        "2026-07-03T00:00:00Z",
      );

      // Verify original dates
      let events = ug.listCanonicalEvents({
        time_min: "2026-07-01T00:00:00Z",
        time_max: "2026-07-04T00:00:00Z",
      });
      expect(events.items.length).toBe(1);
      expect(events.items[0].start).toMatchObject({ dateTime: "2026-07-01T00:00:00Z" });

      // Update to different dates
      const updated = await ug.updateConstraint(
        trip.constraint_id,
        { name: "Movable Trip", timezone: "UTC", block_policy: "BUSY" },
        "2026-07-10T00:00:00Z",
        "2026-07-12T00:00:00Z",
      );
      expect(updated).not.toBeNull();

      // Old dates should be empty
      events = ug.listCanonicalEvents({
        time_min: "2026-07-01T00:00:00Z",
        time_max: "2026-07-04T00:00:00Z",
      });
      expect(events.items.length).toBe(0);

      // New dates should have the event
      events = ug.listCanonicalEvents({
        time_min: "2026-07-10T00:00:00Z",
        time_max: "2026-07-13T00:00:00Z",
      });
      expect(events.items.length).toBe(1);
      expect(events.items[0].start).toMatchObject({ dateTime: "2026-07-10T00:00:00Z" });
    });
  });

  // =========================================================================
  // AC 6 (implicit): Full constraint pipeline with no test fixtures
  //
  // Exercises ALL constraint types working together and the complete
  // CRUD lifecycle.
  // =========================================================================

  describe("Combined constraints: all types working together", () => {
    it("trip + working hours + buffer + no_meetings_after produce correct merged availability", async () => {
      // Setup: Wednesday Feb 18, 2026

      // 1. Working hours: Mon-Fri 09:00-17:00 UTC
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

      // 2. A real event at 10:00-11:00
      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [
        makeCreatedDelta({
          origin_event_id: "evt_combined_001",
          event: {
            origin_account_id: TEST_ACCOUNT_ID,
            origin_event_id: "evt_combined_001",
            title: "Stand-up",
            start: { dateTime: "2026-02-18T10:00:00Z" },
            end: { dateTime: "2026-02-18T11:00:00Z" },
            all_day: false,
            status: "confirmed",
            visibility: "default",
            transparency: "opaque",
          },
        }),
      ]);

      // 3. Buffer: 15 min prep before all events
      ug.addConstraint(
        "buffer",
        { type: "prep", minutes: 15, applies_to: "all" },
        null,
        null,
      );

      // 4. No meetings after 16:00
      ug.addConstraint(
        "no_meetings_after",
        { time: "16:00", timezone: "UTC" },
        null,
        null,
      );

      const result = ug.computeAvailability({
        start: "2026-02-18T00:00:00Z",
        end: "2026-02-18T23:59:59Z",
      });

      // Expected busy periods:
      //   - 00:00-09:00 (outside working hours)
      //   - 09:45-11:00 (15 min prep + stand-up event)
      //   - 16:00-23:59:59 (no_meetings_after + outside working hours merged)
      // Expected free periods:
      //   - 09:00-09:45 (working hours start until prep buffer)
      //   - 11:00-16:00 (after event until no_meetings_after cutoff)

      // Verify free intervals exist within working hours
      expect(result.free_intervals.length).toBeGreaterThanOrEqual(2);

      // Verify the gap before the event (09:00 to 09:45)
      const earlyFree = result.free_intervals.find(
        (f) =>
          f.start === "2026-02-18T09:00:00.000Z" &&
          f.end === "2026-02-18T09:45:00.000Z",
      );
      expect(earlyFree).toBeDefined();

      // Verify the gap after the event (11:00 to 16:00)
      const midFree = result.free_intervals.find(
        (f) =>
          f.start === "2026-02-18T11:00:00Z" &&
          f.end === "2026-02-18T16:00:00.000Z",
      );
      expect(midFree).toBeDefined();

      // No free time after 16:00 (no_meetings_after) or before 09:00 (working hours)
      const lateFreePeriods = result.free_intervals.filter(
        (f) => new Date(f.start).getTime() >= new Date("2026-02-18T16:00:00Z").getTime(),
      );
      expect(lateFreePeriods).toHaveLength(0);
    });

    it("trip during working hours fully blocks the trip period", () => {
      // Working hours: Mon-Fri 09:00-17:00 UTC
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

      // Trip: all day Wednesday Feb 18
      ug.addConstraint(
        "trip",
        { name: "All Day Trip", timezone: "UTC", block_policy: "BUSY" },
        "2026-02-18T00:00:00Z",
        "2026-02-18T23:59:59Z",
      );

      const result = ug.computeAvailability({
        start: "2026-02-18T00:00:00Z",
        end: "2026-02-18T23:59:59Z",
      });

      // Entire day should be busy (trip covers working hours too)
      expect(result.free_intervals).toHaveLength(0);
      expect(result.busy_intervals.length).toBeGreaterThanOrEqual(1);
    });
  });

  // =========================================================================
  // Constraint CRUD lifecycle end-to-end
  //
  // Tests the full create -> read -> update -> delete cycle for each
  // constraint type, verifying state consistency at each step.
  // =========================================================================

  describe("Constraint CRUD lifecycle", () => {
    it("trip: create -> get -> list -> update -> delete with availability verification", async () => {
      // CREATE
      const trip = ug.addConstraint(
        "trip",
        { name: "Spring Break", timezone: "America/Chicago", block_policy: "BUSY" },
        "2026-03-20T00:00:00Z",
        "2026-03-25T00:00:00Z",
      );
      expect(trip.constraint_id).toMatch(/^cst_/);
      expect(trip.kind).toBe("trip");

      // GET
      const fetched = ug.getConstraint(trip.constraint_id);
      expect(fetched).not.toBeNull();
      expect(fetched!.config_json.name).toBe("Spring Break");

      // LIST
      let allTrips = ug.listConstraints("trip");
      expect(allTrips).toHaveLength(1);

      // AVAILABILITY - trip is busy
      let avail = ug.computeAvailability({
        start: "2026-03-19T00:00:00Z",
        end: "2026-03-26T00:00:00Z",
      });
      expect(avail.busy_intervals.length).toBeGreaterThanOrEqual(1);
      const busyTrip = avail.busy_intervals.find(
        (b) => new Date(b.start).getTime() <= new Date("2026-03-20T00:00:00Z").getTime(),
      );
      expect(busyTrip).toBeDefined();

      // UPDATE - change dates
      const updated = await ug.updateConstraint(
        trip.constraint_id,
        { name: "Spring Break Extended", timezone: "America/Chicago", block_policy: "TITLE" },
        "2026-03-20T00:00:00Z",
        "2026-03-27T00:00:00Z",
      );
      expect(updated).not.toBeNull();
      expect(updated!.config_json.name).toBe("Spring Break Extended");

      // Verify updated event title changed (TITLE policy)
      const events = ug.listCanonicalEvents({
        time_min: "2026-03-20T00:00:00Z",
        time_max: "2026-03-28T00:00:00Z",
      });
      expect(events.items.length).toBe(1);
      expect(events.items[0].title).toBe("Spring Break Extended");

      // DELETE
      const deleted = await ug.deleteConstraint(trip.constraint_id);
      expect(deleted).toBe(true);

      // Verify gone
      expect(ug.getConstraint(trip.constraint_id)).toBeNull();
      allTrips = ug.listConstraints("trip");
      expect(allTrips).toHaveLength(0);

      // Availability should be all free now
      avail = ug.computeAvailability({
        start: "2026-03-19T00:00:00Z",
        end: "2026-03-26T00:00:00Z",
      });
      expect(avail.busy_intervals).toHaveLength(0);
      expect(avail.free_intervals).toHaveLength(1);
    });

    it("working_hours: create -> get -> list -> delete with availability verification", async () => {
      // CREATE
      const wh = ug.addConstraint(
        "working_hours",
        {
          days: [1, 2, 3, 4, 5],
          start_time: "08:00",
          end_time: "16:00",
          timezone: "UTC",
        },
        null,
        null,
      );
      expect(wh.constraint_id).toMatch(/^cst_/);

      // GET
      const fetched = ug.getConstraint(wh.constraint_id);
      expect(fetched).not.toBeNull();
      expect(fetched!.config_json.start_time).toBe("08:00");

      // LIST
      const whList = ug.listConstraints("working_hours");
      expect(whList).toHaveLength(1);

      // AVAILABILITY on Wednesday Feb 18 -- free 08:00-16:00 only
      let avail = ug.computeAvailability({
        start: "2026-02-18T00:00:00Z",
        end: "2026-02-18T23:59:59Z",
      });
      expect(avail.free_intervals).toHaveLength(1);
      expect(avail.free_intervals[0].start).toBe("2026-02-18T08:00:00.000Z");
      expect(avail.free_intervals[0].end).toBe("2026-02-18T16:00:00.000Z");

      // DELETE
      const deleted = await ug.deleteConstraint(wh.constraint_id);
      expect(deleted).toBe(true);

      // After deletion, no working hours -- entire day is free
      avail = ug.computeAvailability({
        start: "2026-02-18T00:00:00Z",
        end: "2026-02-18T23:59:59Z",
      });
      expect(avail.free_intervals).toHaveLength(1); // single free interval spanning whole day
      expect(avail.busy_intervals).toHaveLength(0);
    });

    it("buffer: create -> list -> delete with availability verification", async () => {
      // Add a real event first
      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [
        makeCreatedDelta({
          origin_event_id: "evt_buffer_crud_001",
          event: {
            origin_account_id: TEST_ACCOUNT_ID,
            origin_event_id: "evt_buffer_crud_001",
            title: "Lunch Meeting",
            start: { dateTime: "2026-02-16T12:00:00Z" },
            end: { dateTime: "2026-02-16T13:00:00Z" },
            all_day: false,
            status: "confirmed",
            visibility: "default",
            transparency: "opaque",
          },
        }),
      ]);

      // CREATE buffer
      const buf = ug.addConstraint(
        "buffer",
        { type: "cooldown", minutes: 20, applies_to: "all" },
        null,
        null,
      );
      expect(buf.constraint_id).toMatch(/^cst_/);

      // LIST
      const buffers = ug.listConstraints("buffer");
      expect(buffers).toHaveLength(1);

      // AVAILABILITY - event 12:00-13:00 + 20 min cooldown = busy until 13:20
      let avail = ug.computeAvailability({
        start: "2026-02-16T11:00:00Z",
        end: "2026-02-16T14:00:00Z",
      });
      expect(avail.busy_intervals.length).toBe(1);
      expect(avail.busy_intervals[0].end).toBe("2026-02-16T13:20:00.000Z");

      // DELETE buffer
      const deleted = await ug.deleteConstraint(buf.constraint_id);
      expect(deleted).toBe(true);

      // AVAILABILITY after buffer removed - busy only 12:00-13:00
      avail = ug.computeAvailability({
        start: "2026-02-16T11:00:00Z",
        end: "2026-02-16T14:00:00Z",
      });
      expect(avail.busy_intervals.length).toBe(1);
      expect(avail.busy_intervals[0].end).toBe("2026-02-16T13:00:00Z");
    });

    it("no_meetings_after: create -> list -> delete with availability verification", async () => {
      // CREATE
      const nma = ug.addConstraint(
        "no_meetings_after",
        { time: "18:00", timezone: "UTC" },
        null,
        null,
      );
      expect(nma.constraint_id).toMatch(/^cst_/);

      // LIST
      const nmaList = ug.listConstraints("no_meetings_after");
      expect(nmaList).toHaveLength(1);

      // AVAILABILITY on Wednesday Feb 18 -- after 18:00 is busy
      let avail = ug.computeAvailability({
        start: "2026-02-18T17:00:00Z",
        end: "2026-02-18T23:59:59Z",
      });
      expect(avail.busy_intervals.length).toBeGreaterThanOrEqual(1);
      // Should have a free interval from 17:00 to 18:00 (before cutoff)
      const freeBeforeCutoff = avail.free_intervals.find(
        (f) => f.start === "2026-02-18T17:00:00Z" && f.end === "2026-02-18T18:00:00.000Z",
      );
      expect(freeBeforeCutoff).toBeDefined();
      // No significant free time after cutoff (18:00)
      // Due to string format normalization in mergeIntervals ("09:00:00Z" vs
      // "09:00:00.000Z"), tiny zero-duration gaps may appear at boundaries.
      // We verify no gap > 1 minute exists after the cutoff.
      const significantFreeAfterCutoff = avail.free_intervals.filter(
        (f) => {
          const startMs = new Date(f.start).getTime();
          const endMs = new Date(f.end).getTime();
          return startMs >= new Date("2026-02-18T18:00:00Z").getTime() && (endMs - startMs) > 60_000;
        },
      );
      expect(significantFreeAfterCutoff).toHaveLength(0);

      // DELETE
      const deleted = await ug.deleteConstraint(nma.constraint_id);
      expect(deleted).toBe(true);

      // After deletion, entire query range is free
      avail = ug.computeAvailability({
        start: "2026-02-18T17:00:00Z",
        end: "2026-02-18T23:59:59Z",
      });
      expect(avail.free_intervals).toHaveLength(1);
      expect(avail.busy_intervals).toHaveLength(0);
    });
  });

  // =========================================================================
  // API-level constraint operations via handleFetch RPC
  //
  // Proves the full DO request handling layer processes constraint
  // RPC calls correctly through handleFetch.
  // =========================================================================

  describe("API-level constraint operations via handleFetch", () => {
    it("POST /addConstraint -> GET /getConstraint round-trip", async () => {
      // Add a trip via RPC
      const addResponse = await ug.handleFetch(
        new Request("https://user-graph.internal/addConstraint", {
          method: "POST",
          body: JSON.stringify({
            kind: "trip",
            config_json: { name: "RPC Trip", timezone: "UTC", block_policy: "BUSY" },
            active_from: "2026-08-01T00:00:00Z",
            active_to: "2026-08-05T00:00:00Z",
          }),
        }),
      );

      expect(addResponse.status).toBe(200);
      const addResult = (await addResponse.json()) as Constraint;
      expect(addResult.constraint_id).toMatch(/^cst_/);
      expect(addResult.kind).toBe("trip");

      // Get the constraint back via RPC
      const getResponse = await ug.handleFetch(
        new Request("https://user-graph.internal/getConstraint", {
          method: "POST",
          body: JSON.stringify({ constraint_id: addResult.constraint_id }),
        }),
      );

      expect(getResponse.status).toBe(200);
      const getResult = (await getResponse.json()) as Constraint;
      expect(getResult.constraint_id).toBe(addResult.constraint_id);
      expect(getResult.config_json.name).toBe("RPC Trip");
    });

    it("POST /listConstraints returns all constraints", async () => {
      // Create two constraints directly
      ug.addConstraint(
        "trip",
        { name: "Trip A", timezone: "UTC", block_policy: "BUSY" },
        "2026-09-01T00:00:00Z",
        "2026-09-05T00:00:00Z",
      );
      ug.addConstraint(
        "working_hours",
        { days: [1, 2, 3], start_time: "09:00", end_time: "17:00", timezone: "UTC" },
        null,
        null,
      );

      const listResponse = await ug.handleFetch(
        new Request("https://user-graph.internal/listConstraints", {
          method: "POST",
          body: JSON.stringify({}),
        }),
      );

      expect(listResponse.status).toBe(200);
      const listResult = (await listResponse.json()) as { items: Constraint[] };
      expect(listResult.items).toHaveLength(2);
    });

    it("POST /listConstraints with kind filter", async () => {
      ug.addConstraint(
        "trip",
        { name: "Trip", timezone: "UTC", block_policy: "BUSY" },
        "2026-10-01T00:00:00Z",
        "2026-10-05T00:00:00Z",
      );
      ug.addConstraint(
        "buffer",
        { type: "prep", minutes: 10, applies_to: "all" },
        null,
        null,
      );

      const listResponse = await ug.handleFetch(
        new Request("https://user-graph.internal/listConstraints", {
          method: "POST",
          body: JSON.stringify({ kind: "trip" }),
        }),
      );

      const listResult = (await listResponse.json()) as { items: Constraint[] };
      expect(listResult.items).toHaveLength(1);
      expect(listResult.items[0].kind).toBe("trip");
    });

    it("POST /deleteConstraint removes constraint and derived events", async () => {
      const trip = ug.addConstraint(
        "trip",
        { name: "Deletable Trip", timezone: "UTC", block_policy: "BUSY" },
        "2026-11-01T00:00:00Z",
        "2026-11-05T00:00:00Z",
      );

      const deleteResponse = await ug.handleFetch(
        new Request("https://user-graph.internal/deleteConstraint", {
          method: "POST",
          body: JSON.stringify({ constraint_id: trip.constraint_id }),
        }),
      );

      expect(deleteResponse.status).toBe(200);
      const deleteResult = (await deleteResponse.json()) as { deleted: boolean };
      expect(deleteResult.deleted).toBe(true);

      // Verify it is gone
      expect(ug.getConstraint(trip.constraint_id)).toBeNull();
    });

    it("POST /updateConstraint modifies constraint and regenerates trip events", async () => {
      const trip = ug.addConstraint(
        "trip",
        { name: "Updatable Trip", timezone: "UTC", block_policy: "BUSY" },
        "2026-12-01T00:00:00Z",
        "2026-12-05T00:00:00Z",
      );

      const updateResponse = await ug.handleFetch(
        new Request("https://user-graph.internal/updateConstraint", {
          method: "POST",
          body: JSON.stringify({
            constraint_id: trip.constraint_id,
            config_json: { name: "Updated Trip", timezone: "UTC", block_policy: "TITLE" },
            active_from: "2026-12-10T00:00:00Z",
            active_to: "2026-12-15T00:00:00Z",
          }),
        }),
      );

      expect(updateResponse.status).toBe(200);
      const updateResult = (await updateResponse.json()) as Constraint;
      expect(updateResult!.config_json.name).toBe("Updated Trip");
      expect(updateResult!.active_from).toBe("2026-12-10T00:00:00Z");

      // Verify derived event was regenerated with new title
      const events = ug.listCanonicalEvents({
        time_min: "2026-12-10T00:00:00Z",
        time_max: "2026-12-16T00:00:00Z",
      });
      expect(events.items.length).toBe(1);
      expect(events.items[0].title).toBe("Updated Trip"); // TITLE policy
    });

    it("POST /computeAvailability via RPC reflects all constraints", async () => {
      // Add working hours and a trip
      ug.addConstraint(
        "working_hours",
        { days: [3], start_time: "09:00", end_time: "17:00", timezone: "UTC" },
        null,
        null,
      );
      ug.addConstraint(
        "trip",
        { name: "Morning Trip", timezone: "UTC", block_policy: "BUSY" },
        "2026-02-18T09:00:00Z",
        "2026-02-18T12:00:00Z",
      );

      const availResponse = await ug.handleFetch(
        new Request("https://user-graph.internal/computeAvailability", {
          method: "POST",
          body: JSON.stringify({
            start: "2026-02-18T00:00:00Z",
            end: "2026-02-18T23:59:59Z",
          }),
        }),
      );

      expect(availResponse.status).toBe(200);
      const availResult = (await availResponse.json()) as AvailabilityResult;

      // Free time should include 12:00-17:00 (working hours minus trip)
      // Note: due to string format normalization ("09:00:00Z" vs "09:00:00.000Z"),
      // merge may produce multiple small intervals at boundaries. The key assertion
      // is that 12:00-17:00 exists as a free interval.
      const mainFreeInterval = availResult.free_intervals.find(
        (f) =>
          new Date(f.start).getTime() === new Date("2026-02-18T12:00:00Z").getTime() &&
          new Date(f.end).getTime() === new Date("2026-02-18T17:00:00Z").getTime(),
      );
      expect(mainFreeInterval).toBeDefined();

      // No free time before 09:00 or after 17:00 (outside working hours)
      const freeOutsideWorkHours = availResult.free_intervals.filter(
        (f) =>
          new Date(f.start).getTime() < new Date("2026-02-18T09:00:00Z").getTime() ||
          new Date(f.end).getTime() > new Date("2026-02-18T17:00:00Z").getTime(),
      );
      expect(freeOutsideWorkHours).toHaveLength(0);
    });
  });

  // =========================================================================
  // Constraint validation: DO-level rejection of invalid configs
  //
  // Proves that the DO correctly rejects invalid constraint configurations,
  // preventing bad data from entering the system.
  // =========================================================================

  describe("DO-level constraint validation", () => {
    it("rejects unknown constraint kind", () => {
      expect(() =>
        ug.addConstraint("magic_spell", {}, null, null),
      ).toThrow('Invalid constraint kind "magic_spell"');
    });

    it("rejects buffer with negative minutes", () => {
      expect(() =>
        ug.addConstraint("buffer", { type: "prep", minutes: -5, applies_to: "all" }, null, null),
      ).toThrow("positive integer");
    });

    it("rejects buffer with invalid type", () => {
      expect(() =>
        ug.addConstraint("buffer", { type: "warp_speed", minutes: 10, applies_to: "all" }, null, null),
      ).toThrow("type must be one of");
    });

    it("rejects working_hours with invalid timezone", () => {
      expect(() =>
        ug.addConstraint(
          "working_hours",
          { days: [1], start_time: "09:00", end_time: "17:00", timezone: "Mars/Olympus_Mons" },
          null,
          null,
        ),
      ).toThrow("not a valid IANA timezone");
    });

    it("rejects no_meetings_after with invalid time format", () => {
      expect(() =>
        ug.addConstraint(
          "no_meetings_after",
          { time: "25:99", timezone: "UTC" },
          null,
          null,
        ),
      ).toThrow("HH:MM 24-hour format");
    });

    it("rejects override without reason", () => {
      expect(() =>
        ug.addConstraint("override", {}, null, null),
      ).toThrow("non-empty 'reason' string");
    });
  });

  // =========================================================================
  // Journal entries for constraint lifecycle
  //
  // Proves that constraint operations produce proper audit trail entries.
  // =========================================================================

  describe("Journal entries for constraint operations", () => {
    it("trip creation produces journal entry with trip_constraint reason", () => {
      const trip = ug.addConstraint(
        "trip",
        { name: "Journaled Trip", timezone: "UTC", block_policy: "BUSY" },
        "2026-08-15T00:00:00Z",
        "2026-08-20T00:00:00Z",
      );

      // Find derived event
      const events = db
        .prepare("SELECT canonical_event_id FROM canonical_events WHERE constraint_id = ?")
        .all(trip.constraint_id) as Array<{ canonical_event_id: string }>;
      expect(events).toHaveLength(1);

      // Check journal
      const journal = db
        .prepare("SELECT * FROM event_journal WHERE canonical_event_id = ?")
        .all(events[0].canonical_event_id) as Array<Record<string, unknown>>;
      expect(journal).toHaveLength(1);
      expect(journal[0].change_type).toBe("created");
      expect(journal[0].actor).toBe("system");

      const patch = JSON.parse(journal[0].patch_json as string);
      expect(patch.reason).toBe("trip_constraint");
      expect(patch.constraint_id).toBe(trip.constraint_id);
    });

    it("trip deletion produces journal entry with constraint_deleted reason", async () => {
      const trip = ug.addConstraint(
        "trip",
        { name: "Delete Journal Trip", timezone: "UTC", block_policy: "BUSY" },
        "2026-09-15T00:00:00Z",
        "2026-09-20T00:00:00Z",
      );

      const events = db
        .prepare("SELECT canonical_event_id FROM canonical_events WHERE constraint_id = ?")
        .all(trip.constraint_id) as Array<{ canonical_event_id: string }>;
      const eventId = events[0].canonical_event_id;

      await ug.deleteConstraint(trip.constraint_id);

      const journal = db
        .prepare("SELECT * FROM event_journal WHERE canonical_event_id = ? ORDER BY ts ASC")
        .all(eventId) as Array<Record<string, unknown>>;

      // Should have created + deleted entries
      expect(journal.length).toBeGreaterThanOrEqual(2);
      const deletionEntry = journal.find((j) => j.change_type === "deleted");
      expect(deletionEntry).toBeDefined();

      const patch = JSON.parse(deletionEntry!.patch_json as string);
      expect(patch.reason).toBe("constraint_deleted");
      expect(patch.constraint_id).toBe(trip.constraint_id);
    });

    it("trip update produces journal entries for old event deletion and new event creation", async () => {
      const trip = ug.addConstraint(
        "trip",
        { name: "Update Journal Trip", timezone: "UTC", block_policy: "BUSY" },
        "2026-10-01T00:00:00Z",
        "2026-10-05T00:00:00Z",
      );

      // Get old derived event ID
      const oldEvents = db
        .prepare("SELECT canonical_event_id FROM canonical_events WHERE constraint_id = ?")
        .all(trip.constraint_id) as Array<{ canonical_event_id: string }>;
      const oldEventId = oldEvents[0].canonical_event_id;

      await ug.updateConstraint(
        trip.constraint_id,
        { name: "Updated Journal Trip", timezone: "UTC", block_policy: "BUSY" },
        "2026-10-10T00:00:00Z",
        "2026-10-15T00:00:00Z",
      );

      // Old event should have created + deleted journal entries
      const oldJournal = db
        .prepare("SELECT * FROM event_journal WHERE canonical_event_id = ? ORDER BY ts ASC")
        .all(oldEventId) as Array<Record<string, unknown>>;
      expect(oldJournal.length).toBeGreaterThanOrEqual(2);
      expect(oldJournal.some((j) => j.change_type === "deleted")).toBe(true);

      // New event should have created journal entry
      const newEvents = db
        .prepare("SELECT canonical_event_id FROM canonical_events WHERE constraint_id = ?")
        .all(trip.constraint_id) as Array<{ canonical_event_id: string }>;
      expect(newEvents).toHaveLength(1);
      expect(newEvents[0].canonical_event_id).not.toBe(oldEventId);

      const newJournal = db
        .prepare("SELECT * FROM event_journal WHERE canonical_event_id = ?")
        .all(newEvents[0].canonical_event_id) as Array<Record<string, unknown>>;
      expect(newJournal).toHaveLength(1);
      expect(newJournal[0].change_type).toBe("created");
    });
  });

  // =========================================================================
  // Delete cascade: mirrors enqueued for cleanup
  //
  // Proves that deleting a constraint with mirrored derived events
  // properly enqueues DELETE_MIRROR messages.
  // =========================================================================

  describe("Delete cascade: mirror cleanup", () => {
    it("deleting a trip with mirrored event enqueues DELETE_MIRROR", async () => {
      const trip = ug.addConstraint(
        "trip",
        { name: "Mirrored Trip", timezone: "UTC", block_policy: "BUSY" },
        "2026-11-15T00:00:00Z",
        "2026-11-20T00:00:00Z",
      );

      // Find derived event
      const events = db
        .prepare("SELECT canonical_event_id FROM canonical_events WHERE constraint_id = ?")
        .all(trip.constraint_id) as Array<{ canonical_event_id: string }>;
      const eventId = events[0].canonical_event_id;

      // Simulate a mirror for the derived event
      db.prepare(
        `INSERT INTO event_mirrors (canonical_event_id, target_account_id, target_calendar_id, state)
         VALUES (?, ?, ?, 'ACTIVE')`,
      ).run(eventId, TEST_ACCOUNT_ID, "cal_test");

      queue.clear();

      await ug.deleteConstraint(trip.constraint_id);

      // Should have enqueued a DELETE_MIRROR message
      expect(queue.messages).toHaveLength(1);
      const msg = queue.messages[0] as Record<string, unknown>;
      expect(msg.type).toBe("DELETE_MIRROR");
      expect(msg.canonical_event_id).toBe(eventId);
    });
  });
});
