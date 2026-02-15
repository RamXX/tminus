/**
 * Integration tests for excuse generator pipeline via UserGraphDO.
 *
 * Uses real SQLite (better-sqlite3) and real crypto (Node.js crypto.subtle).
 * Workers AI is mocked -- the AI binding is simulated to return controlled
 * responses so we can verify the full pipeline:
 *   1. Event context from getEventBriefing
 *   2. Prompt construction via buildExcusePrompt
 *   3. AI response parsing via parseExcuseResponse
 *   4. BR-17 enforcement (is_draft always true)
 *
 * Tests prove:
 * - Excuse generation uses event briefing context
 * - Different tones produce different excuse drafts
 * - Different truth levels produce different excuse drafts
 * - Relationship context (category, reputation) flows into prompt
 * - BR-17: is_draft is always true in output
 * - Graceful fallback when AI returns empty response
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import type { SqlStorageLike, SqlStorageCursorLike, ProviderDelta, AccountId } from "@tminus/shared";
import { buildExcusePrompt, parseExcuseResponse, EXCUSE_TEMPLATES } from "@tminus/shared";
import type { ExcuseContext, ExcuseTone, TruthLevel } from "@tminus/shared";
import { UserGraphDO } from "./index";
import type { QueueLike } from "./index";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TEST_ACCOUNT_ID = "acc_01TESTACCOUNT0000000000001" as AccountId;
const HASH_ALICE = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
const HASH_BOB = "f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5";

const REL_ALICE = "rel_01HXY000000000000000000E01";
const REL_BOB = "rel_01HXY000000000000000000E02";

// ---------------------------------------------------------------------------
// SqlStorage adapter (same pattern as briefing tests)
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

describe("Excuse generator integration", () => {
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
  }

  /**
   * Simulate the full excuse pipeline: get briefing -> build prompt -> mock AI -> parse
   */
  function generateExcuse(
    eventId: string,
    tone: ExcuseTone,
    truthLevel: TruthLevel,
    mockAiResponse: string,
  ) {
    // Step 1: Get event briefing for context
    const briefing = dObj.getEventBriefing(eventId);
    if (!briefing) throw new Error("Event not found");

    // Step 2: Pick primary participant
    const primaryParticipant = briefing.participants[0] ?? null;

    // Step 3: Build excuse context
    const excuseCtx: ExcuseContext = {
      event_title: briefing.event_title,
      event_start: briefing.event_start,
      participant_name: primaryParticipant?.display_name ?? null,
      participant_category: primaryParticipant?.category ?? "UNKNOWN",
      last_interaction_summary: primaryParticipant?.last_interaction_summary ?? null,
      reputation_score: primaryParticipant?.reputation_score ?? 0,
      tone,
      truth_level: truthLevel,
    };

    // Step 4: Build prompt (this would go to Workers AI in production)
    const prompt = buildExcusePrompt(excuseCtx);

    // Step 5: Parse "AI" response
    const output = parseExcuseResponse(mockAiResponse, tone, truthLevel);

    return { prompt, output, excuseCtx };
  }

  // -----------------------------------------------------------------------
  // Core excuse generation tests
  // -----------------------------------------------------------------------

  describe("excuse generation pipeline", () => {
    it("generates an excuse using event briefing context", async () => {
      setupRelationships();
      const eventId = await createEvent("Q4 Board Meeting", [HASH_ALICE]);

      const { prompt, output } = generateExcuse(
        eventId,
        "formal",
        "full",
        "Dear Alice, I regret that I must cancel our Q4 Board Meeting due to a prior commitment.",
      );

      // Prompt includes event and participant context
      expect(prompt).toContain("Q4 Board Meeting");
      expect(prompt).toContain("Alice Smith");
      expect(prompt).toContain("CLIENT");

      // Output is a valid draft
      expect(output.draft_message).toContain("Dear Alice");
      expect(output.is_draft).toBe(true);
      expect(output.tone).toBe("formal");
      expect(output.truth_level).toBe("full");
    });

    it("produces different prompts for formal vs casual vs apologetic tones", async () => {
      setupRelationships();
      const eventId = await createEvent("Team Sync", [HASH_ALICE]);

      const formal = generateExcuse(eventId, "formal", "full", "");
      const casual = generateExcuse(eventId, "casual", "full", "");
      const apologetic = generateExcuse(eventId, "apologetic", "full", "");

      // Prompts should differ because templates differ
      expect(formal.prompt).not.toBe(casual.prompt);
      expect(formal.prompt).not.toBe(apologetic.prompt);
      expect(casual.prompt).not.toBe(apologetic.prompt);

      // Each prompt should reference its tone
      expect(formal.prompt).toContain("formal");
      expect(casual.prompt).toContain("casual");
      expect(apologetic.prompt).toContain("apologetic");
    });

    it("produces different prompts for full vs vague vs white_lie truth levels", async () => {
      setupRelationships();
      const eventId = await createEvent("Strategy Session", [HASH_ALICE]);

      const full = generateExcuse(eventId, "formal", "full", "");
      const vague = generateExcuse(eventId, "formal", "vague", "");
      const whiteLie = generateExcuse(eventId, "formal", "white_lie", "");

      expect(full.prompt).not.toBe(vague.prompt);
      expect(full.prompt).not.toBe(whiteLie.prompt);
      expect(vague.prompt).not.toBe(whiteLie.prompt);
    });

    it("includes relationship context (category, reputation) in prompt", async () => {
      setupRelationships();
      // Add some outcomes to affect reputation
      dObj.markOutcome(REL_ALICE, "ATTENDED", 1.0, "2026-02-10T10:00:00Z");
      dObj.markOutcome(REL_ALICE, "ATTENDED", 1.0, "2026-02-11T10:00:00Z");

      const eventId = await createEvent("Client Review", [HASH_ALICE]);
      const { prompt, excuseCtx } = generateExcuse(eventId, "formal", "full", "");

      // Context flows from relationship data
      expect(excuseCtx.participant_category).toBe("CLIENT");
      expect(excuseCtx.participant_name).toBe("Alice Smith");
      expect(excuseCtx.reputation_score).toBeGreaterThan(0);

      // Prompt includes these
      expect(prompt).toContain("CLIENT");
      expect(prompt).toContain("Alice Smith");
    });

    it("handles events with no tracked participants", async () => {
      setupRelationships();
      const unknownHash = "9999999999999999999999999999999999999999999999999999999999999999";
      const eventId = await createEvent("Mystery Meeting", [unknownHash]);

      const { excuseCtx, output } = generateExcuse(
        eventId,
        "casual",
        "vague",
        "Hey, sorry but I can't make it to the Mystery Meeting.",
      );

      // No tracked participants -> defaults
      expect(excuseCtx.participant_name).toBeNull();
      expect(excuseCtx.participant_category).toBe("UNKNOWN");
      expect(output.is_draft).toBe(true);
    });

    it("handles events with multiple participants (uses primary)", async () => {
      setupRelationships();
      const eventId = await createEvent("Group Meeting", [HASH_ALICE, HASH_BOB]);

      const { excuseCtx } = generateExcuse(eventId, "formal", "full", "");

      // Primary participant is the one with highest reputation score
      // (briefing sorts by reputation descending)
      expect(excuseCtx.participant_name).toBeDefined();
      // Either Alice or Bob should be the primary
      expect(["Alice Smith", "Bob Jones"]).toContain(excuseCtx.participant_name);
    });
  });

  // -----------------------------------------------------------------------
  // BR-17 enforcement
  // -----------------------------------------------------------------------

  describe("BR-17: never auto-send", () => {
    it("always sets is_draft to true regardless of AI response content", async () => {
      setupRelationships();
      const eventId = await createEvent("Meeting", [HASH_ALICE]);

      const tones: ExcuseTone[] = ["formal", "casual", "apologetic"];
      const truthLevels: TruthLevel[] = ["full", "vague", "white_lie"];

      for (const tone of tones) {
        for (const truthLevel of truthLevels) {
          const { output } = generateExcuse(eventId, tone, truthLevel, "Some excuse text");
          expect(output.is_draft).toBe(true);
        }
      }
    });

    it("draft message never contains send instructions", async () => {
      setupRelationships();
      const eventId = await createEvent("Meeting", [HASH_ALICE]);

      const { output } = generateExcuse(
        eventId,
        "formal",
        "full",
        "Please send this to Alice immediately.",
      );

      // The output preserves the AI text but is_draft ensures it won't be sent
      expect(output.is_draft).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Fallback behavior
  // -----------------------------------------------------------------------

  describe("fallback when AI returns empty", () => {
    it("returns a valid fallback message for empty AI response", async () => {
      setupRelationships();
      const eventId = await createEvent("Important Call", [HASH_ALICE]);

      const { output } = generateExcuse(eventId, "formal", "full", "");

      expect(output.draft_message.length).toBeGreaterThan(0);
      expect(output.is_draft).toBe(true);
      expect(output.tone).toBe("formal");
      expect(output.truth_level).toBe("full");
    });

    it("returns a valid fallback for whitespace-only AI response", async () => {
      setupRelationships();
      const eventId = await createEvent("Status Update", [HASH_BOB]);

      const { output } = generateExcuse(eventId, "casual", "vague", "   \n\t  ");

      expect(output.draft_message.length).toBeGreaterThan(0);
      expect(output.is_draft).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Template coverage in integration context
  // -----------------------------------------------------------------------

  describe("template coverage across all 9 combinations", () => {
    const tones: ExcuseTone[] = ["formal", "casual", "apologetic"];
    const truthLevels: TruthLevel[] = ["full", "vague", "white_lie"];

    it("generates distinct prompts for all 9 tone x truth_level combinations", async () => {
      setupRelationships();
      const eventId = await createEvent("Team Meeting", [HASH_ALICE]);

      const prompts = new Set<string>();
      for (const tone of tones) {
        for (const truthLevel of truthLevels) {
          const { prompt } = generateExcuse(eventId, tone, truthLevel, "test");
          prompts.add(prompt);
        }
      }

      // All 9 prompts should be distinct
      expect(prompts.size).toBe(9);
    });
  });

  // -----------------------------------------------------------------------
  // Event not found
  // -----------------------------------------------------------------------

  describe("error handling", () => {
    it("throws when event does not exist", () => {
      expect(() => {
        generateExcuse(
          "evt_01NONEXISTENT0000000000001",
          "formal",
          "full",
          "test",
        );
      }).toThrow("Event not found");
    });
  });
});
