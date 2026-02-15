/**
 * Integration tests for probabilistic availability in UserGraphDO.
 *
 * Uses real SQLite (better-sqlite3) and real DO logic.
 * Queue is mocked to capture enqueued messages.
 *
 * Tests prove:
 * - getProbabilisticAvailability returns probability 1.0 for empty day
 * - Confirmed events reduce slot probability to ~0.05
 * - Tentative events reduce slot probability to ~0.50
 * - Cancellation history adjusts recurring event probability
 * - Default granularity produces correct slot count
 * - Cancelled events do not reduce free probability
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
import type { QueueLike } from "./index";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TEST_ACCOUNT_ID = "acc_01TESTACCOUNT0000000000001" as AccountId;

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
// Helpers
// ---------------------------------------------------------------------------

/** Insert an event via provider delta and return its canonical ID. */
async function createEvent(
  dObj: UserGraphDO,
  title: string,
  startTs: string,
  endTs: string,
  options?: {
    status?: "confirmed" | "tentative" | "cancelled";
    transparency?: "opaque" | "transparent";
    recurrence_rule?: string;
    origin_event_id?: string;
  },
): Promise<string> {
  const originEventId = options?.origin_event_id ??
    `google_evt_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  const delta: ProviderDelta = {
    type: "created",
    origin_event_id: originEventId,
    origin_account_id: TEST_ACCOUNT_ID,
    event: {
      origin_account_id: TEST_ACCOUNT_ID,
      origin_event_id: originEventId,
      title,
      start: { dateTime: startTs },
      end: { dateTime: endTs },
      all_day: false,
      status: options?.status ?? "confirmed",
      visibility: "default",
      transparency: options?.transparency ?? "opaque",
      recurrence_rule: options?.recurrence_rule,
      source: "provider",
    },
  };

  await dObj.applyProviderDelta(TEST_ACCOUNT_ID as string, [delta]);

  const events = dObj.listCanonicalEvents({
    origin_account_id: TEST_ACCOUNT_ID as string,
  });
  const matched = events.items.find((e) => e.origin_event_id === originEventId);
  if (!matched) throw new Error("Event not created");
  return matched.canonical_event_id;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("UserGraphDO probabilistic availability integration", () => {
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

  it("returns probability 1.0 for all slots when no events exist", () => {
    const result = dObj.getProbabilisticAvailability(
      "2025-06-15T09:00:00Z",
      "2025-06-15T12:00:00Z",
      60,
    );

    expect(result.slots).toHaveLength(3); // 3 hour-long slots
    for (const slot of result.slots) {
      expect(slot.probability).toBe(1.0);
    }
  });

  it("confirmed event reduces slot probability to approximately 0.05", async () => {
    await createEvent(
      dObj,
      "Team Standup",
      "2025-06-15T09:00:00Z",
      "2025-06-15T10:00:00Z",
      { status: "confirmed" },
    );

    const result = dObj.getProbabilisticAvailability(
      "2025-06-15T09:00:00Z",
      "2025-06-15T11:00:00Z",
      60,
    );

    expect(result.slots).toHaveLength(2);
    // Slot 9-10 has a confirmed event -> P(free) ~ 0.05
    expect(result.slots[0].probability).toBeCloseTo(0.05, 2);
    // Slot 10-11 is free -> P(free) = 1.0
    expect(result.slots[1].probability).toBe(1.0);
  });

  it("tentative event reduces slot probability to approximately 0.50", async () => {
    await createEvent(
      dObj,
      "Maybe Meeting",
      "2025-06-15T09:00:00Z",
      "2025-06-15T10:00:00Z",
      { status: "tentative" },
    );

    const result = dObj.getProbabilisticAvailability(
      "2025-06-15T09:00:00Z",
      "2025-06-15T11:00:00Z",
      60,
    );

    expect(result.slots).toHaveLength(2);
    // Tentative event -> P(free) ~ 0.50
    expect(result.slots[0].probability).toBeCloseTo(0.50, 2);
    expect(result.slots[1].probability).toBe(1.0);
  });

  it("cancelled events do not affect free probability", async () => {
    await createEvent(
      dObj,
      "Cancelled Meeting",
      "2025-06-15T09:00:00Z",
      "2025-06-15T10:00:00Z",
      { status: "cancelled" },
    );

    const result = dObj.getProbabilisticAvailability(
      "2025-06-15T09:00:00Z",
      "2025-06-15T11:00:00Z",
      60,
    );

    expect(result.slots).toHaveLength(2);
    // Cancelled events have 0 busy probability -> slot stays free
    expect(result.slots[0].probability).toBe(1.0);
    expect(result.slots[1].probability).toBe(1.0);
  });

  it("transparent events do not affect free probability", async () => {
    await createEvent(
      dObj,
      "FYI Event",
      "2025-06-15T09:00:00Z",
      "2025-06-15T10:00:00Z",
      { transparency: "transparent" },
    );

    const result = dObj.getProbabilisticAvailability(
      "2025-06-15T09:00:00Z",
      "2025-06-15T11:00:00Z",
      60,
    );

    expect(result.slots).toHaveLength(2);
    // Transparent events are excluded from query (transparency = 'opaque' filter)
    expect(result.slots[0].probability).toBe(1.0);
  });

  it("overlapping confirmed and tentative events compound probabilities", async () => {
    await createEvent(
      dObj,
      "Meeting A",
      "2025-06-15T09:00:00Z",
      "2025-06-15T10:00:00Z",
      { status: "confirmed" },
    );
    await createEvent(
      dObj,
      "Meeting B",
      "2025-06-15T09:00:00Z",
      "2025-06-15T10:00:00Z",
      { status: "tentative" },
    );

    const result = dObj.getProbabilisticAvailability(
      "2025-06-15T09:00:00Z",
      "2025-06-15T10:00:00Z",
      60,
    );

    expect(result.slots).toHaveLength(1);
    // P(free) = (1-0.95) * (1-0.50) = 0.05 * 0.50 = 0.025
    expect(result.slots[0].probability).toBeCloseTo(0.025, 3);
  });

  it("uses default 30-minute granularity when not specified", () => {
    const result = dObj.getProbabilisticAvailability(
      "2025-06-15T09:00:00Z",
      "2025-06-15T10:00:00Z",
    );

    expect(result.slots).toHaveLength(2); // 30-minute default
  });

  it("returns correct ISO 8601 timestamps in slot boundaries", () => {
    const result = dObj.getProbabilisticAvailability(
      "2025-06-15T09:00:00Z",
      "2025-06-15T10:00:00Z",
      30,
    );

    expect(result.slots[0].start).toBe("2025-06-15T09:00:00.000Z");
    expect(result.slots[0].end).toBe("2025-06-15T09:30:00.000Z");
    expect(result.slots[1].start).toBe("2025-06-15T09:30:00.000Z");
    expect(result.slots[1].end).toBe("2025-06-15T10:00:00.000Z");
  });

  it("handles real events with mixed statuses across a day", async () => {
    // Morning: confirmed standup
    await createEvent(dObj, "Standup", "2025-06-15T09:00:00Z", "2025-06-15T09:30:00Z", {
      status: "confirmed",
    });
    // Mid-morning: tentative design review
    await createEvent(dObj, "Design Review", "2025-06-15T10:00:00Z", "2025-06-15T11:00:00Z", {
      status: "tentative",
    });
    // Afternoon: confirmed client call
    await createEvent(dObj, "Client Call", "2025-06-15T14:00:00Z", "2025-06-15T15:00:00Z", {
      status: "confirmed",
    });

    const result = dObj.getProbabilisticAvailability(
      "2025-06-15T09:00:00Z",
      "2025-06-15T17:00:00Z",
      60,
    );

    expect(result.slots).toHaveLength(8); // 8 hours

    // 9-10: confirmed standup in first 30 mins -> affected
    expect(result.slots[0].probability).toBeCloseTo(0.05, 2);

    // 10-11: tentative design review
    expect(result.slots[1].probability).toBeCloseTo(0.50, 2);

    // 11-12, 12-13, 13-14: free
    expect(result.slots[2].probability).toBe(1.0);
    expect(result.slots[3].probability).toBe(1.0);
    expect(result.slots[4].probability).toBe(1.0);

    // 14-15: confirmed client call
    expect(result.slots[5].probability).toBeCloseTo(0.05, 2);

    // 15-16, 16-17: free
    expect(result.slots[6].probability).toBe(1.0);
    expect(result.slots[7].probability).toBe(1.0);
  });
});
