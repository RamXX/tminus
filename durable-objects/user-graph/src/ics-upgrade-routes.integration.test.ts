/**
 * Integration tests for UserGraphDO ICS upgrade flow routes (TM-1rs).
 *
 * Tests prove:
 * - /getAccountEvents route exists and returns events for an account
 * - /getAccountEvents returns empty array for non-existent account
 * - /executeUpgrade route exists and executes the upgrade plan
 * - /executeUpgrade deletes ICS events, inserts merged + new + orphaned events
 * - /executeUpgrade creates journal entries for all mutations (ADR-5)
 * - Route registry completeness (per TM-946 learning)
 *
 * Uses real SQLite (better-sqlite3), no mocks for DO internals.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import type {
  SqlStorageLike,
  SqlStorageCursorLike,
  ProviderDelta,
  AccountId,
  CanonicalEvent,
} from "@tminus/shared";
import type { MergedEvent, ProviderEvent, IcsEvent } from "@tminus/shared";
import { UserGraphDO } from "./index";
import type { QueueLike } from "./index";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const ICS_ACCOUNT_ID = "acc_01ICSACCOUNT00000000000001" as AccountId;
const OAUTH_ACCOUNT_ID = "acc_01OAUTHACCOUNT000000000001" as AccountId;

// ---------------------------------------------------------------------------
// SqlStorage adapter (same pattern as other integration tests)
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
// RPC helper
// ---------------------------------------------------------------------------

function rpc(ug: UserGraphDO, path: string, body: unknown): Promise<Response> {
  return ug.handleFetch(
    new Request(`https://user-graph.internal${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

// ---------------------------------------------------------------------------
// Helper: seed ICS events via applyProviderDelta
// ---------------------------------------------------------------------------

function makeIcsDelta(
  originEventId: string,
  title: string,
  startTs: string,
  endTs: string,
): ProviderDelta {
  return {
    type: "created",
    origin_event_id: originEventId,
    origin_account_id: ICS_ACCOUNT_ID,
    event: {
      origin_account_id: ICS_ACCOUNT_ID,
      origin_event_id: originEventId,
      title,
      start: { dateTime: startTs },
      end: { dateTime: endTs },
      all_day: false,
      status: "confirmed",
      visibility: "default",
      transparency: "opaque",
      source: "ics_feed",
    },
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("UserGraphDO ICS upgrade routes (TM-1rs)", () => {
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
  // /getAccountEvents
  // -------------------------------------------------------------------------

  describe("/getAccountEvents", () => {
    it("returns events for a given account_id", async () => {
      // Seed two events for the ICS account
      await ug.applyProviderDelta(ICS_ACCOUNT_ID, [
        makeIcsDelta("ics_evt_001", "Morning Standup", "2026-02-15T09:00:00Z", "2026-02-15T09:30:00Z"),
        makeIcsDelta("ics_evt_002", "Sprint Review", "2026-02-15T14:00:00Z", "2026-02-15T15:00:00Z"),
      ]);

      const resp = await rpc(ug, "/getAccountEvents", {
        account_id: ICS_ACCOUNT_ID,
      });

      expect(resp.status).toBe(200);
      const data = (await resp.json()) as { events: CanonicalEvent[] };
      expect(data.events).toHaveLength(2);

      // Events should be ordered by start_ts ASC
      expect(data.events[0].title).toBe("Morning Standup");
      expect(data.events[0].origin_account_id).toBe(ICS_ACCOUNT_ID);
      expect(data.events[0].origin_event_id).toBe("ics_evt_001");

      expect(data.events[1].title).toBe("Sprint Review");
      expect(data.events[1].origin_account_id).toBe(ICS_ACCOUNT_ID);
      expect(data.events[1].origin_event_id).toBe("ics_evt_002");
    });

    it("returns empty array when account has no events", async () => {
      // Trigger migration by touching the DO
      ug.getSyncHealth();

      const resp = await rpc(ug, "/getAccountEvents", {
        account_id: "acc_NONEXISTENT00000000000001",
      });

      expect(resp.status).toBe(200);
      const data = (await resp.json()) as { events: CanonicalEvent[] };
      expect(data.events).toHaveLength(0);
    });

    it("only returns events for the requested account, not others", async () => {
      // Seed events for two different accounts
      await ug.applyProviderDelta(ICS_ACCOUNT_ID, [
        makeIcsDelta("ics_evt_001", "ICS Event", "2026-02-15T09:00:00Z", "2026-02-15T09:30:00Z"),
      ]);

      const otherAccountId = "acc_01OTHER0000000000000000001" as AccountId;
      await ug.applyProviderDelta(otherAccountId, [
        {
          type: "created",
          origin_event_id: "other_evt_001",
          origin_account_id: otherAccountId,
          event: {
            origin_account_id: otherAccountId,
            origin_event_id: "other_evt_001",
            title: "Other Account Event",
            start: { dateTime: "2026-02-15T10:00:00Z" },
            end: { dateTime: "2026-02-15T10:30:00Z" },
            all_day: false,
            status: "confirmed",
            visibility: "default",
            transparency: "opaque",
          },
        },
      ]);

      const resp = await rpc(ug, "/getAccountEvents", {
        account_id: ICS_ACCOUNT_ID,
      });

      expect(resp.status).toBe(200);
      const data = (await resp.json()) as { events: CanonicalEvent[] };
      expect(data.events).toHaveLength(1);
      expect(data.events[0].title).toBe("ICS Event");
    });
  });

  // -------------------------------------------------------------------------
  // /executeUpgrade
  // -------------------------------------------------------------------------

  describe("/executeUpgrade", () => {
    it("deletes ICS events, inserts merged events, and returns ok: true", async () => {
      // Seed ICS events
      await ug.applyProviderDelta(ICS_ACCOUNT_ID, [
        makeIcsDelta("shared_uid_001", "Meeting Alpha", "2026-02-15T09:00:00Z", "2026-02-15T10:00:00Z"),
        makeIcsDelta("ics_only_001", "ICS Only Event", "2026-02-15T11:00:00Z", "2026-02-15T12:00:00Z"),
      ]);

      // Verify ICS events exist before upgrade
      const beforeResp = await rpc(ug, "/getAccountEvents", { account_id: ICS_ACCOUNT_ID });
      const beforeData = (await beforeResp.json()) as { events: CanonicalEvent[] };
      expect(beforeData.events).toHaveLength(2);

      // Define the upgrade plan
      const mergedEvent: MergedEvent = {
        origin_event_id: "shared_uid_001",
        origin_account_id: OAUTH_ACCOUNT_ID,
        title: "Meeting Alpha (enriched)",
        start: { dateTime: "2026-02-15T09:00:00Z" },
        end: { dateTime: "2026-02-15T10:00:00Z" },
        all_day: false,
        status: "confirmed",
        visibility: "default",
        transparency: "opaque",
        source: "provider",
        matched_by: "ical_uid",
        confidence: 1.0,
        enriched_fields: ["attendees", "meeting_url"],
      };

      const newProviderEvent: ProviderEvent = {
        origin_event_id: "provider_new_001",
        origin_account_id: OAUTH_ACCOUNT_ID,
        title: "New Provider Event",
        start: { dateTime: "2026-02-15T15:00:00Z" },
        end: { dateTime: "2026-02-15T16:00:00Z" },
        all_day: false,
        status: "confirmed",
        visibility: "default",
        transparency: "opaque",
        source: "provider",
      };

      const orphanedIcsEvent: IcsEvent = {
        origin_event_id: "ics_only_001",
        origin_account_id: ICS_ACCOUNT_ID,
        title: "ICS Only Event",
        start: { dateTime: "2026-02-15T11:00:00Z" },
        end: { dateTime: "2026-02-15T12:00:00Z" },
        all_day: false,
        status: "confirmed",
        visibility: "default",
        transparency: "opaque",
        source: "ics_feed",
      };

      // Execute the upgrade
      const upgradeResp = await rpc(ug, "/executeUpgrade", {
        ics_account_id: ICS_ACCOUNT_ID,
        oauth_account_id: OAUTH_ACCOUNT_ID,
        merged_events: [mergedEvent],
        new_events: [newProviderEvent],
        orphaned_events: [orphanedIcsEvent],
      });

      expect(upgradeResp.status).toBe(200);
      const upgradeData = (await upgradeResp.json()) as { ok: boolean };
      expect(upgradeData.ok).toBe(true);

      // Verify ICS events are deleted
      const icsAfterResp = await rpc(ug, "/getAccountEvents", { account_id: ICS_ACCOUNT_ID });
      const icsAfterData = (await icsAfterResp.json()) as { events: CanonicalEvent[] };
      expect(icsAfterData.events).toHaveLength(0);

      // Verify OAuth account now has merged + new + orphaned events
      const oauthResp = await rpc(ug, "/getAccountEvents", { account_id: OAUTH_ACCOUNT_ID });
      const oauthData = (await oauthResp.json()) as { events: CanonicalEvent[] };
      expect(oauthData.events).toHaveLength(3);

      // Find each event by title
      const titles = oauthData.events.map((e: CanonicalEvent) => e.title);
      expect(titles).toContain("Meeting Alpha (enriched)");
      expect(titles).toContain("New Provider Event");
      expect(titles).toContain("ICS Only Event");

      // Verify merged event has the correct origin
      const merged = oauthData.events.find((e: CanonicalEvent) => e.title === "Meeting Alpha (enriched)");
      expect(merged).toBeDefined();
      expect(merged!.origin_account_id).toBe(OAUTH_ACCOUNT_ID);
      expect(merged!.origin_event_id).toBe("shared_uid_001");
      expect(merged!.source).toBe("provider");

      // Verify orphaned event is preserved under OAuth account (BR-1)
      const orphan = oauthData.events.find((e: CanonicalEvent) => e.title === "ICS Only Event");
      expect(orphan).toBeDefined();
      expect(orphan!.origin_account_id).toBe(OAUTH_ACCOUNT_ID);
      expect(orphan!.source).toBe("ics_feed");
    });

    it("creates journal entries for all upgrade operations (ADR-5)", async () => {
      // Seed one ICS event
      await ug.applyProviderDelta(ICS_ACCOUNT_ID, [
        makeIcsDelta("ics_evt_001", "ICS Event", "2026-02-15T09:00:00Z", "2026-02-15T10:00:00Z"),
      ]);

      // Clear existing journal entries from seeding
      const journalBefore = db.prepare("SELECT COUNT(*) as cnt FROM event_journal").get() as { cnt: number };
      const countBefore = journalBefore.cnt;

      // Execute upgrade with one merged event
      const mergedEvent: MergedEvent = {
        origin_event_id: "ics_evt_001",
        origin_account_id: OAUTH_ACCOUNT_ID,
        title: "ICS Event (enriched)",
        start: { dateTime: "2026-02-15T09:00:00Z" },
        end: { dateTime: "2026-02-15T10:00:00Z" },
        all_day: false,
        status: "confirmed",
        visibility: "default",
        transparency: "opaque",
        source: "provider",
        matched_by: "ical_uid",
        confidence: 1.0,
        enriched_fields: [],
      };

      await rpc(ug, "/executeUpgrade", {
        ics_account_id: ICS_ACCOUNT_ID,
        oauth_account_id: OAUTH_ACCOUNT_ID,
        merged_events: [mergedEvent],
        new_events: [],
        orphaned_events: [],
      });

      // Verify journal entries were created for the upgrade
      const journalAfter = db.prepare("SELECT COUNT(*) as cnt FROM event_journal").get() as { cnt: number };
      const newJournalEntries = journalAfter.cnt - countBefore;

      // Should have at least 2: one delete (ICS event) + one create (merged event)
      expect(newJournalEntries).toBeGreaterThanOrEqual(2);

      // Verify upgrade-specific journal entries
      const upgradeJournals = db.prepare(
        "SELECT * FROM event_journal WHERE reason = 'ics_upgrade' ORDER BY ts DESC",
      ).all() as Array<Record<string, unknown>>;

      expect(upgradeJournals.length).toBeGreaterThanOrEqual(2);

      // Should have a 'deleted' entry for the ICS event
      const deleteEntries = upgradeJournals.filter(
        (j) => j.change_type === "deleted",
      );
      expect(deleteEntries.length).toBeGreaterThanOrEqual(1);

      // Should have a 'created' entry for the merged event
      const createEntries = upgradeJournals.filter(
        (j) => j.change_type === "created",
      );
      expect(createEntries.length).toBeGreaterThanOrEqual(1);

      // Verify patch_json contains upgrade-specific metadata
      const createdPatch = JSON.parse(createEntries[0].patch_json as string);
      expect(createdPatch.reason).toBe("ics_upgrade_merged");
      expect(createdPatch.matched_by).toBe("ical_uid");
    });

    it("handles empty merged/new/orphaned arrays gracefully", async () => {
      // Trigger migration
      ug.getSyncHealth();

      const resp = await rpc(ug, "/executeUpgrade", {
        ics_account_id: ICS_ACCOUNT_ID,
        oauth_account_id: OAUTH_ACCOUNT_ID,
        merged_events: [],
        new_events: [],
        orphaned_events: [],
      });

      expect(resp.status).toBe(200);
      const data = (await resp.json()) as { ok: boolean };
      expect(data.ok).toBe(true);
    });

    it("handles upgrade with only new provider events (no matching ICS events)", async () => {
      // Trigger migration
      ug.getSyncHealth();

      const newEvent: ProviderEvent = {
        origin_event_id: "provider_001",
        origin_account_id: OAUTH_ACCOUNT_ID,
        title: "Brand New Event",
        start: { dateTime: "2026-02-15T09:00:00Z" },
        end: { dateTime: "2026-02-15T10:00:00Z" },
        all_day: false,
        status: "confirmed",
        visibility: "default",
        transparency: "opaque",
        source: "provider",
      };

      const resp = await rpc(ug, "/executeUpgrade", {
        ics_account_id: ICS_ACCOUNT_ID,
        oauth_account_id: OAUTH_ACCOUNT_ID,
        merged_events: [],
        new_events: [newEvent],
        orphaned_events: [],
      });

      expect(resp.status).toBe(200);

      // Verify new event was created
      const eventsResp = await rpc(ug, "/getAccountEvents", { account_id: OAUTH_ACCOUNT_ID });
      const eventsData = (await eventsResp.json()) as { events: CanonicalEvent[] };
      expect(eventsData.events).toHaveLength(1);
      expect(eventsData.events[0].title).toBe("Brand New Event");
      expect(eventsData.events[0].source).toBe("provider");
    });
  });

  // -------------------------------------------------------------------------
  // Route registry completeness (per TM-946 learning)
  // -------------------------------------------------------------------------

  describe("route registry completeness", () => {
    it("unknown routes return 404", async () => {
      // Trigger migration
      ug.getSyncHealth();

      const resp = await rpc(ug, "/nonExistentRoute", {});
      expect(resp.status).toBe(404);
    });

    it("/getAccountEvents is registered in the handleFetch switch", async () => {
      // Trigger migration
      ug.getSyncHealth();

      // This proves the route exists and does not return 404
      const resp = await rpc(ug, "/getAccountEvents", {
        account_id: "some_account",
      });
      expect(resp.status).toBe(200);
      // Not 404 -- route exists
    });

    it("/executeUpgrade is registered in the handleFetch switch", async () => {
      // Trigger migration
      ug.getSyncHealth();

      const resp = await rpc(ug, "/executeUpgrade", {
        ics_account_id: ICS_ACCOUNT_ID,
        oauth_account_id: OAUTH_ACCOUNT_ID,
        merged_events: [],
        new_events: [],
        orphaned_events: [],
      });
      expect(resp.status).toBe(200);
      // Not 404 -- route exists
    });
  });
});
