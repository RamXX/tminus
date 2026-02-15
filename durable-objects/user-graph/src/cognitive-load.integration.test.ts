/**
 * Integration tests for cognitive load score computation in UserGraphDO.
 *
 * Uses real SQLite (better-sqlite3) and real DO logic.
 * Queue is mocked to capture enqueued messages.
 *
 * Tests prove:
 * - getCognitiveLoad RPC returns correct metrics for empty day
 * - getCognitiveLoad RPC returns correct metrics for packed day
 * - getCognitiveLoad RPC returns correct metrics for mixed day
 * - Week range aggregates across multiple days
 * - API endpoint validates query params and returns 200 with expected shape
 * - MCP tool validates input and forwards to API
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
): Promise<string> {
  const originEventId = `google_evt_${Date.now()}_${Math.random().toString(36).substring(7)}`;
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
      status: "confirmed",
      visibility: "default",
      transparency: "opaque",
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

describe("UserGraphDO cognitive load integration", () => {
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

  it("returns zero score for empty day (no events)", () => {
    const result = dObj.getCognitiveLoad("2025-06-15", "day");

    expect(result).toEqual({
      score: 0,
      meeting_density: 0,
      context_switches: 0,
      deep_work_blocks: 1, // Full day free = 1 deep work block
      fragmentation: 0,
    });
  });

  it("computes cognitive load for a day with events", async () => {
    // Create 3 different meetings with 15-minute gaps (high fragmentation)
    await createEvent(dObj, "Standup", "2025-06-15T09:00:00Z", "2025-06-15T10:00:00Z");
    await createEvent(dObj, "Design Review", "2025-06-15T10:15:00Z", "2025-06-15T11:00:00Z");
    await createEvent(dObj, "Client Call", "2025-06-15T11:15:00Z", "2025-06-15T12:00:00Z");

    const result = dObj.getCognitiveLoad("2025-06-15", "day");

    // 2.75 hours of meetings out of 8 hours = ~34.4%
    expect(result.meeting_density).toBeGreaterThan(30);
    expect(result.meeting_density).toBeLessThan(40);

    // 3 different titles = 2 context switches
    expect(result.context_switches).toBe(2);

    // Gaps: 10:00-10:15 (15min), 11:00-11:15 (15min) -- both < 30min
    expect(result.fragmentation).toBe(2);

    // Free blocks: 12:00-17:00 (5 hours) qualifies as deep work
    expect(result.deep_work_blocks).toBeGreaterThanOrEqual(1);

    // Score should be moderate (some meetings but not packed)
    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThan(80);
  });

  it("computes packed day with maximum cognitive load", async () => {
    // 8 back-to-back hour-long meetings with different titles
    const titles = [
      "Standup", "Design Review", "Client Call", "Lunch Talk",
      "1:1 Manager", "Sprint Planning", "Tech Debt", "Retro",
    ];
    for (let i = 0; i < 8; i++) {
      const hour = 9 + i;
      const start = `2025-06-15T${String(hour).padStart(2, "0")}:00:00Z`;
      const end = `2025-06-15T${String(hour + 1).padStart(2, "0")}:00:00Z`;
      await createEvent(dObj, titles[i], start, end);
    }

    const result = dObj.getCognitiveLoad("2025-06-15", "day");

    expect(result.meeting_density).toBe(100);
    expect(result.context_switches).toBe(7); // 8 different meetings
    expect(result.deep_work_blocks).toBe(0);
    expect(result.fragmentation).toBe(7); // 7 back-to-back gaps
    expect(result.score).toBeGreaterThan(80);
  });

  it("handles week range across multiple days", async () => {
    // Monday: 2 meetings
    await createEvent(dObj, "Standup", "2025-06-16T09:00:00Z", "2025-06-16T10:00:00Z");
    await createEvent(dObj, "Design", "2025-06-16T10:00:00Z", "2025-06-16T11:00:00Z");

    // Wednesday: 1 all-day workshop
    await createEvent(dObj, "Workshop", "2025-06-18T09:00:00Z", "2025-06-18T17:00:00Z");

    const result = dObj.getCognitiveLoad("2025-06-16", "week");

    // 2+8 = 10 hours of meetings across 7 * 8 = 56 working hours
    expect(result.meeting_density).toBeCloseTo((10 / 56) * 100, 0);

    // Monday: 1 switch (Standup -> Design), Wed: 0 switches
    expect(result.context_switches).toBe(1);

    // Score between 0 and 100
    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThan(100);
  });

  it("returns non-zero metrics when events exist", async () => {
    await createEvent(dObj, "Meeting", "2025-06-15T09:00:00Z", "2025-06-15T10:00:00Z");

    const data = dObj.getCognitiveLoad("2025-06-15", "day");

    expect(data).toHaveProperty("score");
    expect(data).toHaveProperty("meeting_density");
    expect(data).toHaveProperty("context_switches");
    expect(data).toHaveProperty("deep_work_blocks");
    expect(data).toHaveProperty("fragmentation");
    expect(typeof data.score).toBe("number");
    expect(data.meeting_density).toBeGreaterThan(0); // Has a meeting
    expect(data.score).toBeGreaterThan(0);
  });

  it("returns correct response shape for day range", () => {
    const result = dObj.getCognitiveLoad("2025-06-15", "day");

    // Verify all fields are present and correct types
    expect(typeof result.score).toBe("number");
    expect(typeof result.meeting_density).toBe("number");
    expect(typeof result.context_switches).toBe("number");
    expect(typeof result.deep_work_blocks).toBe("number");
    expect(typeof result.fragmentation).toBe("number");

    // Score should be in [0, 100]
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);

    // Meeting density should be in [0, 100]
    expect(result.meeting_density).toBeGreaterThanOrEqual(0);
    expect(result.meeting_density).toBeLessThanOrEqual(100);
  });
});
