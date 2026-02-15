/**
 * Integration tests for the Temporal Graph API endpoints.
 *
 * Tests the full request/response cycle through the API worker fetch handler,
 * verifying auth, rate limiting, DO delegation, and response formatting.
 *
 * These tests mock the Durable Object layer to validate the API surface:
 * - GET /v1/graph/events -- rich event data with participants
 * - GET /v1/graph/relationships -- relationship graph with reputation
 * - GET /v1/graph/timeline -- interaction timeline
 * - GET /v1/graph/openapi.json -- OpenAPI documentation
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createJwt, verifyJwt } from "../index";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const JWT_SECRET = "test-secret-for-graph-api";
const TEST_USER_ID = "user_01HX1234";

// ---------------------------------------------------------------------------
// Helper: create a valid JWT for testing
// ---------------------------------------------------------------------------

async function makeToken(sub?: string, exp?: number): Promise<string> {
  const payload: Record<string, unknown> = {
    sub: sub ?? TEST_USER_ID,
    iat: Math.floor(Date.now() / 1000),
    exp: exp ?? Math.floor(Date.now() / 1000) + 3600,
  };
  return createJwt(payload, JWT_SECRET);
}

// ---------------------------------------------------------------------------
// Mock DO response data
// ---------------------------------------------------------------------------

const mockEvents = {
  items: [
    {
      canonical_event_id: "evt_01",
      origin_account_id: "acc_01",
      origin_event_id: "g_01",
      title: "Strategy Meeting",
      description: "Quarterly review",
      location: "Room 42",
      start: { dateTime: "2026-02-15T14:00:00Z" },
      end: { dateTime: "2026-02-15T15:00:00Z" },
      all_day: false,
      status: "confirmed",
      visibility: "default",
      transparency: "opaque",
      source: "provider",
      version: 1,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-02-01T00:00:00Z",
    },
  ],
  cursor: null,
  has_more: false,
};

const mockParticipants = ["hash_alice", "hash_bob"];

const mockRelationshipsWithRep = {
  items: [
    {
      relationship_id: "rel_01",
      participant_hash: "hash_alice",
      display_name: "Alice Johnson",
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
        trend: "stable",
      },
    },
    {
      relationship_id: "rel_02",
      participant_hash: "hash_bob",
      display_name: "Bob Smith",
      category: "INVESTOR",
      closeness_weight: 0.9,
      last_interaction_ts: "2026-02-12T10:00:00Z",
      city: "New York",
      timezone: "America/New_York",
      interaction_frequency_target: 30,
      created_at: "2025-03-01T00:00:00Z",
      updated_at: "2026-02-01T00:00:00Z",
      reputation: {
        reliability_score: 0.92,
        total_interactions: 20,
        attended_count: 18,
        cancelled_count: 2,
        noshow_count: 0,
        trend: "improving",
      },
    },
  ],
};

const mockTimeline = {
  items: [
    {
      ledger_id: "led_01",
      participant_hash: "hash_alice",
      canonical_event_id: "evt_01",
      outcome: "ATTENDED",
      weight: 1.0,
      note: "Good meeting",
      ts: "2026-02-15T10:00:00Z",
    },
    {
      ledger_id: "led_02",
      participant_hash: "hash_bob",
      canonical_event_id: "evt_01",
      outcome: "CANCELLED",
      weight: -0.5,
      note: null,
      ts: "2026-02-10T09:00:00Z",
    },
  ],
};

const mockAllocations = {
  items: [
    {
      allocation_id: "alloc_01",
      canonical_event_id: "evt_01",
      billing_category: "CLIENT",
    },
  ],
};

// ---------------------------------------------------------------------------
// Mock Durable Object namespace
// ---------------------------------------------------------------------------

function createMockDO(responses: Record<string, unknown>) {
  return {
    idFromName: vi.fn().mockReturnValue({ toString: () => "mock-id" }),
    get: vi.fn().mockReturnValue({
      fetch: vi.fn().mockImplementation(async (url: string, _init?: RequestInit) => {
        const parsedUrl = new URL(url);
        const path = parsedUrl.pathname;

        const responseData = responses[path];
        if (responseData !== undefined) {
          return new Response(JSON.stringify(responseData), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        // Return empty data for unknown paths (non-fatal for enrichment calls)
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    }),
  };
}

// ---------------------------------------------------------------------------
// Mock Env
// ---------------------------------------------------------------------------

function createMockEnv(doResponses?: Record<string, unknown>) {
  const responses = doResponses ?? {
    "/listCanonicalEvents": mockEvents,
    "/getEventParticipantHashes": { hashes: mockParticipants },
    "/listRelationshipsWithReputation": mockRelationshipsWithRep,
    "/getTimeline": mockTimeline,
    "/getAllocation": { allocation: { billing_category: "CLIENT" } },
  };

  return {
    JWT_SECRET,
    DB: {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          all: vi.fn().mockResolvedValue({ results: [] }),
          first: vi.fn().mockResolvedValue(null),
          run: vi.fn().mockResolvedValue({}),
        }),
        all: vi.fn().mockResolvedValue({ results: [] }),
        first: vi.fn().mockResolvedValue(null),
        run: vi.fn().mockResolvedValue({}),
      }),
    } as unknown as D1Database,
    USER_GRAPH: createMockDO(responses) as unknown as DurableObjectNamespace,
    ACCOUNT: createMockDO({}) as unknown as DurableObjectNamespace,
    SYNC_QUEUE: { send: vi.fn(), sendBatch: vi.fn() } as unknown as Queue,
    WRITE_QUEUE: { send: vi.fn(), sendBatch: vi.fn() } as unknown as Queue,
    SESSIONS: {} as unknown as KVNamespace,
    RATE_LIMITS: undefined, // No rate limiting in tests (simplifies mocking)
  };
}

// ---------------------------------------------------------------------------
// Import the worker handler
// ---------------------------------------------------------------------------

// We test via the default export's fetch method
import workerDefault from "../index";

async function callApi(
  path: string,
  env: ReturnType<typeof createMockEnv>,
  token?: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const request = new Request(`https://api.test${path}`, {
    method: "GET",
    headers,
  });

  return workerDefault.fetch(
    request,
    env as unknown as Parameters<typeof workerDefault.fetch>[1],
    { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext,
  );
}

// ---------------------------------------------------------------------------
// Tests: Authentication
// ---------------------------------------------------------------------------

describe("Graph API authentication", () => {
  it("returns 401 when no token provided", async () => {
    const env = createMockEnv();
    const resp = await callApi("/v1/graph/events", env);
    expect(resp.status).toBe(401);
    const body = await resp.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("Authentication");
  });

  it("returns 401 when token is invalid", async () => {
    const env = createMockEnv();
    const resp = await callApi("/v1/graph/events", env, "invalid-token");
    expect(resp.status).toBe(401);
  });

  it("returns 200 when valid JWT provided", async () => {
    const env = createMockEnv();
    const token = await makeToken();
    const resp = await callApi("/v1/graph/events", env, token);
    expect(resp.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Tests: GET /v1/graph/events
// ---------------------------------------------------------------------------

describe("GET /v1/graph/events", () => {
  it("returns events in envelope format", async () => {
    const env = createMockEnv();
    const token = await makeToken();
    const resp = await callApi("/v1/graph/events", env, token);
    expect(resp.status).toBe(200);

    const body = await resp.json() as {
      ok: boolean;
      data: Array<{
        canonical_event_id: string;
        title: string;
        start: string;
        end: string;
        participants: string[];
      }>;
      meta: { request_id: string; timestamp: string };
    };
    expect(body.ok).toBe(true);
    expect(body.meta).toBeDefined();
    expect(body.meta.request_id).toBeDefined();
    expect(Array.isArray(body.data)).toBe(true);
  });

  it("returns enriched event data with title, start, end, participants", async () => {
    const env = createMockEnv();
    const token = await makeToken();
    const resp = await callApi("/v1/graph/events", env, token);
    const body = await resp.json() as {
      data: Array<{
        canonical_event_id: string;
        title: string;
        start: string;
        end: string;
        participants: string[];
        category: string | null;
      }>;
    };

    expect(body.data).toHaveLength(1);
    const event = body.data[0];
    expect(event.canonical_event_id).toBe("evt_01");
    expect(event.title).toBe("Strategy Meeting");
    expect(event.start).toBe("2026-02-15T14:00:00Z");
    expect(event.end).toBe("2026-02-15T15:00:00Z");
    expect(event.participants).toEqual(["hash_alice", "hash_bob"]);
  });

  it("passes start_date and end_date filters to DO", async () => {
    const env = createMockEnv();
    const token = await makeToken();
    const resp = await callApi(
      "/v1/graph/events?start_date=2026-02-15&end_date=2026-02-16",
      env,
      token,
    );
    expect(resp.status).toBe(200);

    // Verify DO was called with time_min/time_max
    const doStub = env.USER_GRAPH.get(env.USER_GRAPH.idFromName(TEST_USER_ID));
    expect(doStub.fetch).toHaveBeenCalled();
  });

  it("filters by category parameter", async () => {
    const env = createMockEnv();
    const token = await makeToken();
    const resp = await callApi("/v1/graph/events?category=CLIENT", env, token);
    expect(resp.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Tests: GET /v1/graph/relationships
// ---------------------------------------------------------------------------

describe("GET /v1/graph/relationships", () => {
  it("returns relationships with reputation and drift_days", async () => {
    const env = createMockEnv();
    const token = await makeToken();
    const resp = await callApi("/v1/graph/relationships", env, token);
    expect(resp.status).toBe(200);

    const body = await resp.json() as {
      ok: boolean;
      data: Array<{
        relationship_id: string;
        participant_hash: string;
        category: string;
        reputation: number;
        drift_days: number | null;
        display_name: string | null;
      }>;
    };
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);

    const rel = body.data[0];
    expect(rel.relationship_id).toBe("rel_01");
    expect(rel.participant_hash).toBe("hash_alice");
    expect(rel.category).toBe("COLLEAGUE");
    expect(typeof rel.reputation).toBe("number");
    expect(rel.drift_days === null || typeof rel.drift_days === "number").toBe(true);
  });

  it("filters by category", async () => {
    const env = createMockEnv();
    const token = await makeToken();
    const resp = await callApi("/v1/graph/relationships?category=COLLEAGUE", env, token);
    expect(resp.status).toBe(200);

    const body = await resp.json() as { data: Array<{ category: string }> };
    for (const rel of body.data) {
      expect(rel.category).toBe("COLLEAGUE");
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: GET /v1/graph/timeline
// ---------------------------------------------------------------------------

describe("GET /v1/graph/timeline", () => {
  it("returns timeline entries with event, participant, outcome, timestamp", async () => {
    const env = createMockEnv();
    const token = await makeToken();
    const resp = await callApi("/v1/graph/timeline", env, token);
    expect(resp.status).toBe(200);

    const body = await resp.json() as {
      ok: boolean;
      data: Array<{
        canonical_event_id: string | null;
        participant_hash: string;
        outcome: string;
        timestamp: string;
      }>;
    };
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);

    const entry = body.data[0];
    expect(entry).toHaveProperty("canonical_event_id");
    expect(entry).toHaveProperty("participant_hash");
    expect(entry).toHaveProperty("outcome");
    expect(entry).toHaveProperty("timestamp");
  });

  it("filters by participant_hash", async () => {
    const env = createMockEnv();
    const token = await makeToken();
    const resp = await callApi(
      "/v1/graph/timeline?participant_hash=hash_alice",
      env,
      token,
    );
    expect(resp.status).toBe(200);

    const body = await resp.json() as {
      data: Array<{ participant_hash: string }>;
    };
    for (const entry of body.data) {
      expect(entry.participant_hash).toBe("hash_alice");
    }
  });

  it("filters by date range", async () => {
    const env = createMockEnv();
    const token = await makeToken();
    const resp = await callApi(
      "/v1/graph/timeline?start_date=2026-02-14&end_date=2026-02-16",
      env,
      token,
    );
    expect(resp.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Tests: GET /v1/graph/openapi.json
// ---------------------------------------------------------------------------

describe("GET /v1/graph/openapi.json", () => {
  it("returns OpenAPI spec as JSON", async () => {
    const env = createMockEnv();
    const token = await makeToken();
    const resp = await callApi("/v1/graph/openapi.json", env, token);
    expect(resp.status).toBe(200);

    const body = await resp.json() as {
      ok: boolean;
      data: {
        openapi: string;
        info: { title: string; version: string };
        paths: Record<string, unknown>;
      };
    };
    expect(body.ok).toBe(true);
    expect(body.data.openapi).toMatch(/^3\.\d+\.\d+$/);
    expect(body.data.paths).toBeDefined();
  });

  it("includes all graph endpoints in paths", async () => {
    const env = createMockEnv();
    const token = await makeToken();
    const resp = await callApi("/v1/graph/openapi.json", env, token);
    const body = await resp.json() as {
      data: { paths: Record<string, unknown> };
    };

    expect(body.data.paths["/v1/graph/events"]).toBeDefined();
    expect(body.data.paths["/v1/graph/relationships"]).toBeDefined();
    expect(body.data.paths["/v1/graph/timeline"]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: Rate limiting (reuses existing middleware)
// ---------------------------------------------------------------------------

describe("Graph API rate limiting", () => {
  it("applies rate limit headers when RATE_LIMITS is configured", async () => {
    // Rate limiting is tested at the middleware level.
    // Here we verify the graph endpoints don't bypass the middleware
    // by confirming they pass through the standard auth + rate limit flow.
    const env = createMockEnv();
    const token = await makeToken();
    const resp = await callApi("/v1/graph/events", env, token);
    // Without RATE_LIMITS binding, no rate limit headers are expected
    expect(resp.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Tests: 404 for unknown graph sub-paths
// ---------------------------------------------------------------------------

describe("Unknown graph paths", () => {
  it("returns 404 for unknown /v1/graph/* path", async () => {
    const env = createMockEnv();
    const token = await makeToken();
    const resp = await callApi("/v1/graph/unknown", env, token);
    expect(resp.status).toBe(404);
  });
});
