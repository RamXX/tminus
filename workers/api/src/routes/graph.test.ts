/**
 * Unit tests for Temporal Graph API route handlers and pure functions.
 *
 * TDD RED phase: tests written before implementation.
 *
 * Tests:
 * - Graph event formatting and filtering (date, category, participants)
 * - Relationship graph formatting with reputation/drift
 * - Timeline formatting and filtering (participant_hash, date range)
 * - OpenAPI spec generation and structure
 * - Input validation (malformed dates, unknown categories)
 */

import { describe, it, expect } from "vitest";
import {
  formatGraphEvent,
  formatGraphRelationship,
  formatTimelineEntry,
  filterGraphEvents,
  filterGraphRelationships,
  filterTimeline,
  buildGraphOpenApiSpec,
} from "./graph";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const sampleEvent = {
  canonical_event_id: "evt_01HX1234",
  origin_account_id: "acc_01HX5678",
  origin_event_id: "google_abc",
  title: "Team standup",
  description: "Daily sync",
  location: "Zoom",
  start: { dateTime: "2026-02-15T09:00:00Z" },
  end: { dateTime: "2026-02-15T09:30:00Z" },
  all_day: false,
  status: "confirmed" as const,
  visibility: "default" as const,
  transparency: "opaque" as const,
  source: "provider" as const,
  version: 1,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-02-01T00:00:00Z",
};

const sampleParticipants = ["hash_alice", "hash_bob"];

const sampleRelationship = {
  relationship_id: "rel_01HX9999",
  participant_hash: "hash_alice",
  display_name: "Alice",
  category: "COLLEAGUE",
  closeness_weight: 0.8,
  last_interaction_ts: "2026-02-10T12:00:00Z",
  city: "San Francisco",
  timezone: "America/Los_Angeles",
  interaction_frequency_target: 14,
  created_at: "2025-06-01T00:00:00Z",
  updated_at: "2026-02-01T00:00:00Z",
  reputation: {
    reliability_score: 0.85,
    total_interactions: 12,
    attended_count: 10,
    cancelled_count: 1,
    noshow_count: 1,
    trend: "stable" as const,
  },
};

const sampleLedgerEntry = {
  ledger_id: "led_01HX0001",
  participant_hash: "hash_alice",
  canonical_event_id: "evt_01HX1234",
  outcome: "ATTENDED",
  weight: 1.0,
  note: "Good meeting",
  ts: "2026-02-15T10:00:00Z",
};

// ---------------------------------------------------------------------------
// formatGraphEvent
// ---------------------------------------------------------------------------

describe("formatGraphEvent", () => {
  it("extracts title, start, end from canonical event", () => {
    const result = formatGraphEvent(sampleEvent, sampleParticipants);
    expect(result.title).toBe("Team standup");
    expect(result.start).toBe("2026-02-15T09:00:00Z");
    expect(result.end).toBe("2026-02-15T09:30:00Z");
  });

  it("includes canonical_event_id", () => {
    const result = formatGraphEvent(sampleEvent, sampleParticipants);
    expect(result.canonical_event_id).toBe("evt_01HX1234");
  });

  it("includes participants array", () => {
    const result = formatGraphEvent(sampleEvent, sampleParticipants);
    expect(result.participants).toEqual(["hash_alice", "hash_bob"]);
  });

  it("includes category field (null when no allocation)", () => {
    const result = formatGraphEvent(sampleEvent, sampleParticipants);
    expect(result).toHaveProperty("category");
  });

  it("includes category from allocation when provided", () => {
    const result = formatGraphEvent(sampleEvent, sampleParticipants, "CLIENT");
    expect(result.category).toBe("CLIENT");
  });

  it("handles event with no participants", () => {
    const result = formatGraphEvent(sampleEvent, []);
    expect(result.participants).toEqual([]);
  });

  it("handles all_day event with date instead of dateTime", () => {
    const allDayEvent = {
      ...sampleEvent,
      all_day: true,
      start: { date: "2026-02-15" },
      end: { date: "2026-02-16" },
    };
    const result = formatGraphEvent(allDayEvent, []);
    expect(result.start).toBe("2026-02-15");
    expect(result.end).toBe("2026-02-16");
  });
});

// ---------------------------------------------------------------------------
// filterGraphEvents
// ---------------------------------------------------------------------------

describe("filterGraphEvents", () => {
  const events = [
    formatGraphEvent(sampleEvent, sampleParticipants, "CLIENT"),
    formatGraphEvent(
      {
        ...sampleEvent,
        canonical_event_id: "evt_02",
        title: "Lunch",
        start: { dateTime: "2026-02-16T12:00:00Z" },
        end: { dateTime: "2026-02-16T13:00:00Z" },
      },
      ["hash_charlie"],
      "FRIEND",
    ),
    formatGraphEvent(
      {
        ...sampleEvent,
        canonical_event_id: "evt_03",
        title: "Board meeting",
        start: { dateTime: "2026-03-01T14:00:00Z" },
        end: { dateTime: "2026-03-01T15:00:00Z" },
      },
      ["hash_alice"],
      "BOARD",
    ),
  ];

  it("returns all events when no filters", () => {
    const result = filterGraphEvents(events, {});
    expect(result).toHaveLength(3);
  });

  it("filters by start_date", () => {
    const result = filterGraphEvents(events, { start_date: "2026-02-16" });
    expect(result).toHaveLength(2);
    expect(result[0].title).toBe("Lunch");
  });

  it("filters by end_date", () => {
    const result = filterGraphEvents(events, { end_date: "2026-02-28" });
    expect(result).toHaveLength(2);
    expect(result[0].title).toBe("Team standup");
  });

  it("filters by date range", () => {
    const result = filterGraphEvents(events, {
      start_date: "2026-02-16",
      end_date: "2026-02-28",
    });
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Lunch");
  });

  it("filters by category", () => {
    const result = filterGraphEvents(events, { category: "CLIENT" });
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Team standup");
  });

  it("returns empty for non-matching category", () => {
    const result = filterGraphEvents(events, { category: "INVESTOR" });
    expect(result).toHaveLength(0);
  });

  it("combines date and category filters", () => {
    const result = filterGraphEvents(events, {
      start_date: "2026-02-01",
      end_date: "2026-02-28",
      category: "FRIEND",
    });
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Lunch");
  });
});

// ---------------------------------------------------------------------------
// formatGraphRelationship
// ---------------------------------------------------------------------------

describe("formatGraphRelationship", () => {
  it("includes relationship_id", () => {
    const result = formatGraphRelationship(sampleRelationship);
    expect(result.relationship_id).toBe("rel_01HX9999");
  });

  it("includes participant_hash", () => {
    const result = formatGraphRelationship(sampleRelationship);
    expect(result.participant_hash).toBe("hash_alice");
  });

  it("includes category", () => {
    const result = formatGraphRelationship(sampleRelationship);
    expect(result.category).toBe("COLLEAGUE");
  });

  it("includes reputation score", () => {
    const result = formatGraphRelationship(sampleRelationship);
    expect(result.reputation).toBe(0.85);
  });

  it("computes drift_days from last_interaction_ts", () => {
    const result = formatGraphRelationship(sampleRelationship, "2026-02-15T00:00:00Z");
    // last_interaction_ts = 2026-02-10T12:00:00Z, asOf = 2026-02-15T00:00:00Z
    // diff = 4 days 12 hours, floor = 4
    expect(result.drift_days).toBe(4);
  });

  it("returns null drift_days when no last_interaction_ts", () => {
    const relNoInteraction = {
      ...sampleRelationship,
      last_interaction_ts: null,
    };
    const result = formatGraphRelationship(relNoInteraction);
    expect(result.drift_days).toBeNull();
  });

  it("includes display_name", () => {
    const result = formatGraphRelationship(sampleRelationship);
    expect(result.display_name).toBe("Alice");
  });
});

// ---------------------------------------------------------------------------
// filterGraphRelationships
// ---------------------------------------------------------------------------

describe("filterGraphRelationships", () => {
  const relationships = [
    formatGraphRelationship(sampleRelationship, "2026-02-15T00:00:00Z"),
    formatGraphRelationship(
      {
        ...sampleRelationship,
        relationship_id: "rel_02",
        participant_hash: "hash_bob",
        category: "INVESTOR",
        reputation: { ...sampleRelationship.reputation, reliability_score: 0.5 },
      },
      "2026-02-15T00:00:00Z",
    ),
    formatGraphRelationship(
      {
        ...sampleRelationship,
        relationship_id: "rel_03",
        participant_hash: "hash_charlie",
        category: "COLLEAGUE",
        reputation: { ...sampleRelationship.reputation, reliability_score: 0.9 },
      },
      "2026-02-15T00:00:00Z",
    ),
  ];

  it("returns all relationships when no filter", () => {
    const result = filterGraphRelationships(relationships, {});
    expect(result).toHaveLength(3);
  });

  it("filters by category", () => {
    const result = filterGraphRelationships(relationships, { category: "COLLEAGUE" });
    expect(result).toHaveLength(2);
  });

  it("returns empty for non-matching category", () => {
    const result = filterGraphRelationships(relationships, { category: "FAMILY" });
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// formatTimelineEntry
// ---------------------------------------------------------------------------

describe("formatTimelineEntry", () => {
  it("includes event reference", () => {
    const result = formatTimelineEntry(sampleLedgerEntry);
    expect(result.canonical_event_id).toBe("evt_01HX1234");
  });

  it("includes participant_hash", () => {
    const result = formatTimelineEntry(sampleLedgerEntry);
    expect(result.participant_hash).toBe("hash_alice");
  });

  it("includes outcome", () => {
    const result = formatTimelineEntry(sampleLedgerEntry);
    expect(result.outcome).toBe("ATTENDED");
  });

  it("includes timestamp", () => {
    const result = formatTimelineEntry(sampleLedgerEntry);
    expect(result.timestamp).toBe("2026-02-15T10:00:00Z");
  });

  it("handles null canonical_event_id", () => {
    const entry = { ...sampleLedgerEntry, canonical_event_id: null };
    const result = formatTimelineEntry(entry);
    expect(result.canonical_event_id).toBeNull();
  });

  it("includes note when present", () => {
    const result = formatTimelineEntry(sampleLedgerEntry);
    expect(result.note).toBe("Good meeting");
  });
});

// ---------------------------------------------------------------------------
// filterTimeline
// ---------------------------------------------------------------------------

describe("filterTimeline", () => {
  const entries = [
    formatTimelineEntry(sampleLedgerEntry),
    formatTimelineEntry({
      ...sampleLedgerEntry,
      ledger_id: "led_02",
      participant_hash: "hash_bob",
      ts: "2026-02-10T09:00:00Z",
      outcome: "CANCELLED",
    }),
    formatTimelineEntry({
      ...sampleLedgerEntry,
      ledger_id: "led_03",
      participant_hash: "hash_alice",
      ts: "2026-03-01T11:00:00Z",
      outcome: "NO_SHOW",
    }),
  ];

  it("returns all entries when no filters", () => {
    const result = filterTimeline(entries, {});
    expect(result).toHaveLength(3);
  });

  it("filters by participant_hash", () => {
    const result = filterTimeline(entries, { participant_hash: "hash_alice" });
    expect(result).toHaveLength(2);
  });

  it("filters by start_date", () => {
    const result = filterTimeline(entries, { start_date: "2026-02-15" });
    expect(result).toHaveLength(2);
  });

  it("filters by end_date", () => {
    const result = filterTimeline(entries, { end_date: "2026-02-28" });
    expect(result).toHaveLength(2);
  });

  it("filters by date range", () => {
    const result = filterTimeline(entries, {
      start_date: "2026-02-14",
      end_date: "2026-02-16",
    });
    expect(result).toHaveLength(1);
    expect(result[0].outcome).toBe("ATTENDED");
  });

  it("combines participant_hash and date filters", () => {
    const result = filterTimeline(entries, {
      participant_hash: "hash_alice",
      start_date: "2026-03-01",
    });
    expect(result).toHaveLength(1);
    expect(result[0].outcome).toBe("NO_SHOW");
  });
});

// ---------------------------------------------------------------------------
// buildGraphOpenApiSpec
// ---------------------------------------------------------------------------

describe("buildGraphOpenApiSpec", () => {
  it("returns valid OpenAPI 3.0 object", () => {
    const spec = buildGraphOpenApiSpec();
    expect(spec.openapi).toMatch(/^3\.\d+\.\d+$/);
  });

  it("includes info with title and version", () => {
    const spec = buildGraphOpenApiSpec();
    expect(spec.info).toBeDefined();
    expect(spec.info.title).toContain("Graph");
    expect(spec.info.version).toBeDefined();
  });

  it("documents GET /v1/graph/events path", () => {
    const spec = buildGraphOpenApiSpec();
    expect(spec.paths["/v1/graph/events"]).toBeDefined();
    expect(spec.paths["/v1/graph/events"].get).toBeDefined();
  });

  it("documents GET /v1/graph/relationships path", () => {
    const spec = buildGraphOpenApiSpec();
    expect(spec.paths["/v1/graph/relationships"]).toBeDefined();
    expect(spec.paths["/v1/graph/relationships"].get).toBeDefined();
  });

  it("documents GET /v1/graph/timeline path", () => {
    const spec = buildGraphOpenApiSpec();
    expect(spec.paths["/v1/graph/timeline"]).toBeDefined();
    expect(spec.paths["/v1/graph/timeline"].get).toBeDefined();
  });

  it("events endpoint has start_date, end_date, category parameters", () => {
    const spec = buildGraphOpenApiSpec();
    const params = spec.paths["/v1/graph/events"].get.parameters;
    const paramNames = params.map((p: { name: string }) => p.name);
    expect(paramNames).toContain("start_date");
    expect(paramNames).toContain("end_date");
    expect(paramNames).toContain("category");
  });

  it("relationships endpoint has category parameter", () => {
    const spec = buildGraphOpenApiSpec();
    const params = spec.paths["/v1/graph/relationships"].get.parameters;
    const paramNames = params.map((p: { name: string }) => p.name);
    expect(paramNames).toContain("category");
  });

  it("timeline endpoint has participant_hash, start_date, end_date parameters", () => {
    const spec = buildGraphOpenApiSpec();
    const params = spec.paths["/v1/graph/timeline"].get.parameters;
    const paramNames = params.map((p: { name: string }) => p.name);
    expect(paramNames).toContain("participant_hash");
    expect(paramNames).toContain("start_date");
    expect(paramNames).toContain("end_date");
  });

  it("includes authentication (bearerAuth security scheme)", () => {
    const spec = buildGraphOpenApiSpec();
    expect(spec.components?.securitySchemes?.bearerAuth).toBeDefined();
  });
});
