/**
 * Real integration tests for UserGraphDO.
 *
 * Runs against a real wrangler dev server with Miniflare-backed DO SQLite.
 * No better-sqlite3. No mocks -- real DurableObject instances with real
 * SQLite storage, accessed via HTTP through the test worker's RPC proxy.
 *
 * What this proves that the better-sqlite3 tests do NOT:
 * - The DO class works when instantiated by the Cloudflare runtime
 * - Real DO SQLite storage handles all queries (CREATE TABLE, INSERT, etc.)
 * - The handleFetch() routing works end-to-end via HTTP
 * - Queue.send() works with real Miniflare queue bindings
 * - Event journal entries are written to real SQLite
 * - Policy edge CRUD works with real foreign key constraints
 * - Availability computation works entirely from DO SQLite
 *
 * Queue messages cannot be directly inspected in Miniflare local mode,
 * but we verify them indirectly via mirror state and applyProviderDelta
 * return values (mirrors_enqueued count).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve } from "node:path";
import { startWranglerDev } from "./integration-helpers.js";
import type { StartedWorker } from "./integration-helpers.js";
import { DoRpcClient } from "./do-rpc-client.js";
import type { ProviderDeltaPayload } from "./do-rpc-client.js";

const ROOT = resolve(import.meta.dirname, "../..");
const TEST_PORT = 18798;
const MASTER_KEY_HEX =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

// ---------------------------------------------------------------------------
// Shared test infrastructure
// ---------------------------------------------------------------------------

let worker: StartedWorker;
let client: DoRpcClient;

beforeAll(async () => {
  worker = await startWranglerDev({
    wranglerToml: resolve(ROOT, "scripts/test/wrangler-test.toml"),
    port: TEST_PORT,
    vars: {
      MASTER_KEY: MASTER_KEY_HEX,
    },
    healthTimeoutMs: 60_000,
  });

  client = new DoRpcClient({ baseUrl: worker.url });
}, 90_000);

afterAll(async () => {
  if (worker) {
    await worker.cleanup(true);
  }
}, 15_000);

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TEST_ACCOUNT_ID = "acc_01TESTACCOUNT0000000000001";
const OTHER_ACCOUNT_ID = "acc_01TESTACCOUNT0000000000002";

function makeCreatedDelta(
  overrides?: Partial<ProviderDeltaPayload>,
): ProviderDeltaPayload {
  return {
    type: "created",
    origin_event_id: "google_evt_001",
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

function makeUpdatedDelta(
  overrides?: Partial<ProviderDeltaPayload>,
): ProviderDeltaPayload {
  return {
    type: "updated",
    origin_event_id: "google_evt_001",
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

function makeDeletedDelta(
  overrides?: Partial<ProviderDeltaPayload>,
): ProviderDeltaPayload {
  return {
    type: "deleted",
    origin_event_id: "google_evt_001",
    ...overrides,
  };
}

// Each test uses a unique DO name to avoid state leaking between tests.
let testCounter = 0;
function uniqueDoName(): string {
  return `ug-test-${Date.now()}-${++testCounter}`;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("UserGraphDO real integration (wrangler dev)", () => {
  // -------------------------------------------------------------------------
  // applyProviderDelta -- created
  // -------------------------------------------------------------------------

  describe("applyProviderDelta with 'created' delta", () => {
    it("inserts canonical event and returns correct counts", async () => {
      const name = uniqueDoName();
      const ug = client.userGraph(name);

      const result = await ug.applyProviderDelta(TEST_ACCOUNT_ID, [
        makeCreatedDelta(),
      ]);

      expect(result.created).toBe(1);
      expect(result.updated).toBe(0);
      expect(result.deleted).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    it("created event is retrievable via listCanonicalEvents", async () => {
      const name = uniqueDoName();
      const ug = client.userGraph(name);

      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [makeCreatedDelta()]);

      const events = await ug.listCanonicalEvents();
      expect(events.items).toHaveLength(1);
      expect(events.items[0].title).toBe("Team Standup");
      expect(events.items[0].origin_event_id).toBe("google_evt_001");
      expect(events.items[0].version).toBe(1);
      expect(events.items[0].source).toBe("provider");

      // canonical_event_id follows the evt_ prefix pattern (Invariant B)
      const evtId = events.items[0].canonical_event_id as string;
      expect(evtId).toMatch(/^evt_[0-9A-Z]{26}$/);
    });

    it("creates journal entry (ADR-5)", async () => {
      const name = uniqueDoName();
      const ug = client.userGraph(name);

      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [makeCreatedDelta()]);

      const journal = await ug.queryJournal();
      expect(journal.items).toHaveLength(1);
      expect(journal.items[0].change_type).toBe("created");
      expect(journal.items[0].actor).toBe(`provider:${TEST_ACCOUNT_ID}`);
      expect(journal.items[0].journal_id).toMatch(/^jrn_/);
    });

    it("generates unique canonical_event_ids for multiple events", async () => {
      const name = uniqueDoName();
      const ug = client.userGraph(name);

      const delta1 = makeCreatedDelta({ origin_event_id: "google_evt_001" });
      const delta2 = makeCreatedDelta({
        origin_event_id: "google_evt_002",
        event: {
          ...makeCreatedDelta().event!,
          origin_event_id: "google_evt_002",
          title: "Second Event",
        },
      });

      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [delta1, delta2]);

      const events = await ug.listCanonicalEvents();
      expect(events.items).toHaveLength(2);
      const ids = events.items.map((e) => e.canonical_event_id);
      expect(ids[0]).not.toBe(ids[1]);
    });
  });

  // -------------------------------------------------------------------------
  // applyProviderDelta -- updated
  // -------------------------------------------------------------------------

  describe("applyProviderDelta with 'updated' delta", () => {
    it("updates canonical event and bumps version", async () => {
      const name = uniqueDoName();
      const ug = client.userGraph(name);

      // Create then update
      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [makeCreatedDelta()]);
      const result = await ug.applyProviderDelta(TEST_ACCOUNT_ID, [
        makeUpdatedDelta(),
      ]);

      expect(result.updated).toBe(1);
      expect(result.errors).toHaveLength(0);

      const events = await ug.listCanonicalEvents();
      expect(events.items).toHaveLength(1);
      expect(events.items[0].title).toBe("Team Standup (Moved)");
      expect(events.items[0].version).toBe(2);
    });

    it("writes journal entry for update", async () => {
      const name = uniqueDoName();
      const ug = client.userGraph(name);

      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [makeCreatedDelta()]);
      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [makeUpdatedDelta()]);

      const journal = await ug.queryJournal();
      expect(journal.items).toHaveLength(2);
      expect(journal.items[0].change_type).toBe("created");
      expect(journal.items[1].change_type).toBe("updated");
    });
  });

  // -------------------------------------------------------------------------
  // applyProviderDelta -- deleted
  // -------------------------------------------------------------------------

  describe("applyProviderDelta with 'deleted' delta", () => {
    it("removes canonical event (hard delete per BR-7)", async () => {
      const name = uniqueDoName();
      const ug = client.userGraph(name);

      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [makeCreatedDelta()]);

      const result = await ug.applyProviderDelta(TEST_ACCOUNT_ID, [
        makeDeletedDelta(),
      ]);

      expect(result.deleted).toBe(1);
      expect(result.errors).toHaveLength(0);

      // Verify event is gone
      const events = await ug.listCanonicalEvents();
      expect(events.items).toHaveLength(0);
    });

    it("writes journal entries for create and delete", async () => {
      const name = uniqueDoName();
      const ug = client.userGraph(name);

      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [makeCreatedDelta()]);
      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [makeDeletedDelta()]);

      const journal = await ug.queryJournal();
      expect(journal.items).toHaveLength(2);
      expect(journal.items[1].change_type).toBe("deleted");
    });

    it("ignores delete for non-existent event", async () => {
      const name = uniqueDoName();
      const ug = client.userGraph(name);

      const result = await ug.applyProviderDelta(TEST_ACCOUNT_ID, [
        makeDeletedDelta(),
      ]);

      expect(result.deleted).toBe(0);
      expect(result.errors).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // listCanonicalEvents -- time range filtering
  // -------------------------------------------------------------------------

  describe("listCanonicalEvents with filters", () => {
    it("filters by time range", async () => {
      const name = uniqueDoName();
      const ug = client.userGraph(name);

      const morning = makeCreatedDelta({
        origin_event_id: "evt_morning",
        event: {
          ...makeCreatedDelta().event!,
          origin_event_id: "evt_morning",
          title: "Morning",
          start: { dateTime: "2026-02-15T08:00:00Z" },
          end: { dateTime: "2026-02-15T09:00:00Z" },
        },
      });
      const afternoon = makeCreatedDelta({
        origin_event_id: "evt_afternoon",
        event: {
          ...makeCreatedDelta().event!,
          origin_event_id: "evt_afternoon",
          title: "Afternoon",
          start: { dateTime: "2026-02-15T14:00:00Z" },
          end: { dateTime: "2026-02-15T15:00:00Z" },
        },
      });

      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [morning, afternoon]);

      // Query for afternoon only
      const result = await ug.listCanonicalEvents({
        time_min: "2026-02-15T13:00:00Z",
        time_max: "2026-02-15T16:00:00Z",
      });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].title).toBe("Afternoon");
    });

    it("supports cursor-based pagination", async () => {
      const name = uniqueDoName();
      const ug = client.userGraph(name);

      // Insert 5 events
      const deltas: ProviderDeltaPayload[] = [];
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
      const page1 = await ug.listCanonicalEvents({ limit: 2 });
      expect(page1.items).toHaveLength(2);
      expect(page1.has_more).toBe(true);
      expect(page1.cursor).toBeDefined();

      // Page 2: next 2 items
      const page2 = await ug.listCanonicalEvents({
        limit: 2,
        cursor: page1.cursor!,
      });
      expect(page2.items).toHaveLength(2);
      expect(page2.has_more).toBe(true);

      // Page 3: last item
      const page3 = await ug.listCanonicalEvents({
        limit: 2,
        cursor: page2.cursor!,
      });
      expect(page3.items).toHaveLength(1);
      expect(page3.has_more).toBe(false);
      expect(page3.cursor).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // createPolicy and ensureDefaultPolicy
  // -------------------------------------------------------------------------

  describe("createPolicy()", () => {
    it("creates a named policy and returns its ID", async () => {
      const name = uniqueDoName();
      const ug = client.userGraph(name);

      const policy = await ug.createPolicy("My Test Policy");

      expect(policy.policy_id).toMatch(/^pol_/);
      expect(policy.name).toBe("My Test Policy");
      expect(policy.is_default).toBe(false);
      expect(policy.created_at).toBeDefined();
    });
  });

  describe("ensureDefaultPolicy()", () => {
    it("creates a default policy with bidirectional edges", async () => {
      const name = uniqueDoName();
      const ug = client.userGraph(name);

      await ug.ensureDefaultPolicy([TEST_ACCOUNT_ID, OTHER_ACCOUNT_ID]);

      // Verify via getSyncHealth (the policy doesn't directly affect health,
      // but we can check that no errors occurred by verifying the DO responds)
      const health = await ug.getSyncHealth();
      expect(health.total_events).toBe(0);
    });

    it("is idempotent", async () => {
      const name = uniqueDoName();
      const ug = client.userGraph(name);

      // Call twice
      await ug.ensureDefaultPolicy([TEST_ACCOUNT_ID, OTHER_ACCOUNT_ID]);
      await ug.ensureDefaultPolicy([TEST_ACCOUNT_ID, OTHER_ACCOUNT_ID]);

      // Should not error
      const health = await ug.getSyncHealth();
      expect(health.total_events).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Policy edges and mirror projection
  // -------------------------------------------------------------------------

  describe("policy edges and mirror projection", () => {
    it("enqueues UPSERT_MIRROR when policy edge exists", async () => {
      const name = uniqueDoName();
      const ug = client.userGraph(name);

      // Create a policy with an edge
      const policy = await ug.createPolicy("Test Policy");
      await ug.setPolicyEdges(policy.policy_id, [
        {
          from_account_id: TEST_ACCOUNT_ID,
          to_account_id: OTHER_ACCOUNT_ID,
          detail_level: "BUSY",
          calendar_kind: "BUSY_OVERLAY",
        },
      ]);

      // Now create an event
      const result = await ug.applyProviderDelta(TEST_ACCOUNT_ID, [
        makeCreatedDelta(),
      ]);

      // The result should indicate mirrors were enqueued
      expect(result.mirrors_enqueued).toBe(1);
    });

    it("does not enqueue when no policy edges exist", async () => {
      const name = uniqueDoName();
      const ug = client.userGraph(name);

      // Create event without any policy edges
      const result = await ug.applyProviderDelta(TEST_ACCOUNT_ID, [
        makeCreatedDelta(),
      ]);

      expect(result.mirrors_enqueued).toBe(0);
    });

    it("mirrors_enqueued reflects write-skipping on identical updates (Invariant C)", async () => {
      const name = uniqueDoName();
      const ug = client.userGraph(name);

      // Setup policy edge
      const policy = await ug.createPolicy("Skip Policy");
      await ug.setPolicyEdges(policy.policy_id, [
        {
          from_account_id: TEST_ACCOUNT_ID,
          to_account_id: OTHER_ACCOUNT_ID,
          detail_level: "BUSY",
          calendar_kind: "BUSY_OVERLAY",
        },
      ]);

      // Create event (first write)
      const result1 = await ug.applyProviderDelta(TEST_ACCOUNT_ID, [
        makeCreatedDelta(),
      ]);
      expect(result1.mirrors_enqueued).toBe(1);

      // Update with same content (should skip -- hash unchanged)
      const sameContentDelta: ProviderDeltaPayload = {
        type: "updated",
        origin_event_id: "google_evt_001",
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

      const result2 = await ug.applyProviderDelta(TEST_ACCOUNT_ID, [
        sameContentDelta,
      ]);
      expect(result2.updated).toBe(1);
      expect(result2.mirrors_enqueued).toBe(0); // Write-skipped!

      // Update with different content (should enqueue)
      const result3 = await ug.applyProviderDelta(TEST_ACCOUNT_ID, [
        makeUpdatedDelta(),
      ]);
      expect(result3.updated).toBe(1);
      expect(result3.mirrors_enqueued).toBe(1); // Hash changed, new write
    });
  });

  // -------------------------------------------------------------------------
  // Journal entries
  // -------------------------------------------------------------------------

  describe("journal entries (ADR-5)", () => {
    it("records create, update, delete in order", async () => {
      const name = uniqueDoName();
      const ug = client.userGraph(name);

      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [makeCreatedDelta()]);
      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [makeUpdatedDelta()]);
      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [makeDeletedDelta()]);

      const journal = await ug.queryJournal();
      expect(journal.items).toHaveLength(3);

      const types = journal.items.map((j) => j.change_type);
      expect(types).toEqual(["created", "updated", "deleted"]);
    });

    it("journal cursor pagination works", async () => {
      const name = uniqueDoName();
      const ug = client.userGraph(name);

      // Create 3 journal entries
      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [makeCreatedDelta()]);
      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [makeUpdatedDelta()]);
      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [makeDeletedDelta()]);

      // Page 1: first 2
      const page1 = await ug.queryJournal({ limit: 2 });
      expect(page1.items).toHaveLength(2);
      expect(page1.has_more).toBe(true);
      expect(page1.cursor).toBeDefined();

      // Page 2: last 1
      const page2 = await ug.queryJournal({
        limit: 2,
        cursor: page1.cursor!,
      });
      expect(page2.items).toHaveLength(1);
      expect(page2.has_more).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // getSyncHealth
  // -------------------------------------------------------------------------

  describe("getSyncHealth", () => {
    it("returns zero counts for empty DO", async () => {
      const name = uniqueDoName();
      const ug = client.userGraph(name);

      const health = await ug.getSyncHealth();
      expect(health.total_events).toBe(0);
      expect(health.total_mirrors).toBe(0);
      expect(health.total_journal_entries).toBe(0);
      expect(health.pending_mirrors).toBe(0);
      expect(health.error_mirrors).toBe(0);
      expect(health.last_journal_ts).toBeNull();
    });

    it("reflects actual event and journal counts", async () => {
      const name = uniqueDoName();
      const ug = client.userGraph(name);

      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [makeCreatedDelta()]);
      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [
        makeCreatedDelta({
          origin_event_id: "google_evt_002",
          event: {
            ...makeCreatedDelta().event!,
            origin_event_id: "google_evt_002",
            title: "Another Event",
          },
        }),
      ]);

      const health = await ug.getSyncHealth();
      expect(health.total_events).toBe(2);
      expect(health.total_journal_entries).toBe(2);
      expect(health.last_journal_ts).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // computeAvailability
  // -------------------------------------------------------------------------

  describe("computeAvailability", () => {
    it("returns busy and free intervals", async () => {
      const name = uniqueDoName();
      const ug = client.userGraph(name);

      // Create two non-overlapping events
      const morning = makeCreatedDelta({
        origin_event_id: "evt_morning",
        event: {
          ...makeCreatedDelta().event!,
          origin_event_id: "evt_morning",
          title: "Morning Meeting",
          start: { dateTime: "2026-02-15T09:00:00Z" },
          end: { dateTime: "2026-02-15T10:00:00Z" },
        },
      });
      const afternoon = makeCreatedDelta({
        origin_event_id: "evt_afternoon",
        event: {
          ...makeCreatedDelta().event!,
          origin_event_id: "evt_afternoon",
          title: "Afternoon Meeting",
          start: { dateTime: "2026-02-15T14:00:00Z" },
          end: { dateTime: "2026-02-15T15:00:00Z" },
        },
      });

      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [morning, afternoon]);

      const avail = await ug.computeAvailability({
        start: "2026-02-15T08:00:00Z",
        end: "2026-02-15T17:00:00Z",
      });

      expect(avail.busy_intervals.length).toBe(2);
      expect(avail.free_intervals.length).toBeGreaterThan(0);

      // First free interval should be before the morning meeting
      expect(avail.free_intervals[0].start).toBe("2026-02-15T08:00:00Z");
      expect(avail.free_intervals[0].end).toBe("2026-02-15T09:00:00Z");
    });

    it("returns all free when no events exist", async () => {
      const name = uniqueDoName();
      const ug = client.userGraph(name);

      const avail = await ug.computeAvailability({
        start: "2026-02-15T08:00:00Z",
        end: "2026-02-15T17:00:00Z",
      });

      expect(avail.busy_intervals).toHaveLength(0);
      expect(avail.free_intervals).toHaveLength(1);
      expect(avail.free_intervals[0].start).toBe("2026-02-15T08:00:00Z");
      expect(avail.free_intervals[0].end).toBe("2026-02-15T17:00:00Z");
    });
  });

  // -------------------------------------------------------------------------
  // unlinkAccount
  // -------------------------------------------------------------------------

  describe("unlinkAccount()", () => {
    it("removes all data for the unlinked account", async () => {
      const name = uniqueDoName();
      const ug = client.userGraph(name);

      // Create events for the account
      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [
        makeCreatedDelta(),
        makeCreatedDelta({
          origin_event_id: "google_evt_002",
          event: {
            ...makeCreatedDelta().event!,
            origin_event_id: "google_evt_002",
            title: "Second Event",
          },
        }),
      ]);

      // Verify events exist
      const beforeEvents = await ug.listCanonicalEvents();
      expect(beforeEvents.items).toHaveLength(2);

      // Unlink the account
      const result = await ug.unlinkAccount(TEST_ACCOUNT_ID);

      expect(result.events_deleted).toBe(2);

      // Verify events are gone
      const afterEvents = await ug.listCanonicalEvents();
      expect(afterEvents.items).toHaveLength(0);
    });

    it("writes journal entries recording the unlink", async () => {
      const name = uniqueDoName();
      const ug = client.userGraph(name);

      await ug.applyProviderDelta(TEST_ACCOUNT_ID, [makeCreatedDelta()]);
      await ug.unlinkAccount(TEST_ACCOUNT_ID);

      const journal = await ug.queryJournal();
      // Should have: create + delete (per-event) + account_unlinked (summary)
      const unlinkEntry = journal.items.find(
        (j) => j.change_type === "account_unlinked",
      );
      expect(unlinkEntry).toBeDefined();
      expect(unlinkEntry!.actor).toBe("system");
    });
  });

  // -------------------------------------------------------------------------
  // handleFetch routing
  // -------------------------------------------------------------------------

  describe("handleFetch routing", () => {
    it("returns 404 for unknown action", async () => {
      const name = uniqueDoName();
      const ug = client.userGraph(name);

      const result = await ug.raw<string>("/nonexistent", {});
      expect(result.status).toBe(404);
    });

    it("returns 500 with error for invalid policy edge", async () => {
      const name = uniqueDoName();
      const ug = client.userGraph(name);

      // Try to set edges on non-existent policy
      const result = await ug.raw<{ error: string }>("/setPolicyEdges", {
        policy_id: "pol_NONEXISTENT000000000000000",
        edges: [],
      });
      expect(result.status).toBe(500);
      expect(result.data.error).toMatch(/Policy not found/);
    });
  });

  // -------------------------------------------------------------------------
  // DO isolation
  // -------------------------------------------------------------------------

  describe("DO isolation", () => {
    it("different DO names have isolated storage", async () => {
      const name1 = uniqueDoName();
      const name2 = uniqueDoName();
      const ug1 = client.userGraph(name1);
      const ug2 = client.userGraph(name2);

      // Create event in ug1
      await ug1.applyProviderDelta(TEST_ACCOUNT_ID, [makeCreatedDelta()]);

      // ug1 should have 1 event
      const events1 = await ug1.listCanonicalEvents();
      expect(events1.items).toHaveLength(1);

      // ug2 should have 0 events (isolated storage)
      const events2 = await ug2.listCanonicalEvents();
      expect(events2.items).toHaveLength(0);
    });
  });
});
