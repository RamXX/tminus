/**
 * Unit tests for pre-meeting context briefing assembly.
 *
 * Tests topic extraction from event titles and briefing assembly
 * from relationship context data.
 */

import { describe, it, expect } from "vitest";
import {
  extractTopics,
  summarizeLastInteraction,
  assembleBriefing,
} from "./briefing";
import type { BriefingParticipantInput } from "./briefing";

// ---------------------------------------------------------------------------
// extractTopics
// ---------------------------------------------------------------------------

describe("extractTopics", () => {
  it("returns empty array for null/undefined/empty title", () => {
    expect(extractTopics(null)).toEqual([]);
    expect(extractTopics(undefined)).toEqual([]);
    expect(extractTopics("")).toEqual([]);
    expect(extractTopics("   ")).toEqual([]);
  });

  it("extracts single keyword from title", () => {
    expect(extractTopics("Team Sync")).toContain("sync");
  });

  it("extracts multiple keywords from title", () => {
    const topics = extractTopics("Sprint Planning Review");
    expect(topics).toContain("planning");
    expect(topics).toContain("review");
    expect(topics).toContain("sprint");
  });

  it("performs case-insensitive matching", () => {
    expect(extractTopics("STANDUP")).toContain("standup");
    expect(extractTopics("Weekly SYNC")).toContain("sync");
    expect(extractTopics("Weekly SYNC")).toContain("weekly");
  });

  it("matches multi-word keywords as substrings", () => {
    expect(extractTopics("Q4 Board Meeting")).toContain("board meeting");
    expect(extractTopics("Annual Town Hall")).toContain("town hall");
    expect(extractTopics("Team Happy Hour")).toContain("happy hour");
  });

  it("matches hyphenated keywords", () => {
    expect(extractTopics("Morning Stand-up")).toContain("stand-up");
    expect(extractTopics("Project Kick-off")).toContain("kick-off");
    expect(extractTopics("Team Check-in")).toContain("check-in");
  });

  it("matches 1:1 keyword", () => {
    expect(extractTopics("1:1 with Alice")).toContain("1:1");
  });

  it("does not match partial single-word keywords", () => {
    // "call" should not match inside "callback"
    const topics = extractTopics("Callback handler design");
    expect(topics).not.toContain("call");
  });

  it("returns sorted deduplicated array", () => {
    const topics = extractTopics("Weekly Sprint Review");
    // Should be alphabetically sorted
    for (let i = 1; i < topics.length; i++) {
      expect(topics[i] >= topics[i - 1]).toBe(true);
    }
  });

  it("returns empty array for titles with no recognized keywords", () => {
    expect(extractTopics("Alice and Bob")).toEqual([]);
    expect(extractTopics("Project Gamma")).toEqual([]);
  });

  it("extracts meeting from various contexts", () => {
    expect(extractTopics("Team meeting")).toContain("meeting");
    expect(extractTopics("Meeting with investors")).toContain("meeting");
  });
});

// ---------------------------------------------------------------------------
// summarizeLastInteraction
// ---------------------------------------------------------------------------

describe("summarizeLastInteraction", () => {
  const now = "2026-02-15T10:00:00Z";

  it("returns null for null input", () => {
    expect(summarizeLastInteraction(null, now)).toBeNull();
  });

  it('returns "today" for same-day interaction', () => {
    expect(summarizeLastInteraction("2026-02-15T08:00:00Z", now)).toBe("today");
  });

  it('returns "yesterday" for 1-day-old interaction', () => {
    expect(summarizeLastInteraction("2026-02-14T10:00:00Z", now)).toBe("yesterday");
  });

  it("returns days ago for 2-6 day old interactions", () => {
    expect(summarizeLastInteraction("2026-02-12T10:00:00Z", now)).toBe("3 days ago");
  });

  it("returns weeks ago for 7-29 day old interactions", () => {
    expect(summarizeLastInteraction("2026-02-01T10:00:00Z", now)).toBe("2 weeks ago");
    expect(summarizeLastInteraction("2026-02-08T10:00:00Z", now)).toBe("1 week ago");
  });

  it("returns months ago for 30-364 day old interactions", () => {
    expect(summarizeLastInteraction("2025-12-15T10:00:00Z", now)).toBe("2 months ago");
    expect(summarizeLastInteraction("2026-01-15T10:00:00Z", now)).toBe("1 month ago");
  });

  it("returns years ago for 365+ day old interactions", () => {
    expect(summarizeLastInteraction("2024-02-15T10:00:00Z", now)).toBe("2 years ago");
    expect(summarizeLastInteraction("2025-02-14T10:00:00Z", now)).toBe("1 year ago");
  });

  it('returns "upcoming" for future interactions', () => {
    expect(summarizeLastInteraction("2026-02-16T10:00:00Z", now)).toBe("upcoming");
  });
});

// ---------------------------------------------------------------------------
// assembleBriefing
// ---------------------------------------------------------------------------

describe("assembleBriefing", () => {
  const now = "2026-02-15T10:00:00Z";

  const alice: BriefingParticipantInput = {
    participant_hash: "hash_alice",
    display_name: "Alice Smith",
    category: "CLIENT",
    closeness_weight: 0.8,
    last_interaction_ts: "2026-02-10T09:00:00Z",
    reputation_score: 0.85,
    total_interactions: 12,
  };

  const bob: BriefingParticipantInput = {
    participant_hash: "hash_bob",
    display_name: "Bob Jones",
    category: "INVESTOR",
    closeness_weight: 0.6,
    last_interaction_ts: "2026-01-15T14:00:00Z",
    reputation_score: 0.92,
    total_interactions: 5,
  };

  it("assembles a complete briefing with participants", () => {
    const mutuals = new Map([
      ["hash_alice", 3],
      ["hash_bob", 1],
    ]);

    const briefing = assembleBriefing(
      "evt_123",
      "Q4 Board Meeting",
      "2026-02-16T14:00:00Z",
      [alice, bob],
      mutuals,
      now,
    );

    expect(briefing.event_id).toBe("evt_123");
    expect(briefing.event_title).toBe("Q4 Board Meeting");
    expect(briefing.event_start).toBe("2026-02-16T14:00:00Z");
    expect(briefing.topics).toContain("board meeting");
    expect(briefing.topics).toContain("meeting");
    expect(briefing.computed_at).toBe(now);
    expect(briefing.participants).toHaveLength(2);
  });

  it("sorts participants by reputation score descending", () => {
    const mutuals = new Map<string, number>();

    const briefing = assembleBriefing(
      "evt_123",
      "Team Sync",
      "2026-02-16T14:00:00Z",
      [alice, bob], // alice has 0.85, bob has 0.92
      mutuals,
      now,
    );

    // Bob (0.92) should come before Alice (0.85)
    expect(briefing.participants[0].display_name).toBe("Bob Jones");
    expect(briefing.participants[1].display_name).toBe("Alice Smith");
  });

  it("includes last_interaction_summary for each participant", () => {
    const mutuals = new Map<string, number>();

    const briefing = assembleBriefing(
      "evt_123",
      "Meeting",
      "2026-02-16T14:00:00Z",
      [alice],
      mutuals,
      now,
    );

    expect(briefing.participants[0].last_interaction_summary).toBe("5 days ago");
  });

  it("includes mutual_connections_count from the map", () => {
    const mutuals = new Map([["hash_alice", 7]]);

    const briefing = assembleBriefing(
      "evt_123",
      "Call",
      "2026-02-16T14:00:00Z",
      [alice],
      mutuals,
      now,
    );

    expect(briefing.participants[0].mutual_connections_count).toBe(7);
  });

  it("defaults mutual_connections_count to 0 when not in map", () => {
    const mutuals = new Map<string, number>();

    const briefing = assembleBriefing(
      "evt_123",
      "Call",
      "2026-02-16T14:00:00Z",
      [alice],
      mutuals,
      now,
    );

    expect(briefing.participants[0].mutual_connections_count).toBe(0);
  });

  it("handles empty participants list", () => {
    const briefing = assembleBriefing(
      "evt_123",
      "Solo Focus Time",
      "2026-02-16T14:00:00Z",
      [],
      new Map(),
      now,
    );

    expect(briefing.participants).toEqual([]);
    expect(briefing.topics).toEqual([]);
  });

  it("handles null event title", () => {
    const briefing = assembleBriefing(
      "evt_123",
      null,
      "2026-02-16T14:00:00Z",
      [alice],
      new Map(),
      now,
    );

    expect(briefing.event_title).toBeNull();
    expect(briefing.topics).toEqual([]);
  });

  it("rounds reputation scores to 2 decimal places", () => {
    const participant: BriefingParticipantInput = {
      ...alice,
      reputation_score: 0.8567,
    };

    const briefing = assembleBriefing(
      "evt_123",
      "Call",
      "2026-02-16T14:00:00Z",
      [participant],
      new Map(),
      now,
    );

    expect(briefing.participants[0].reputation_score).toBe(0.86);
  });
});
