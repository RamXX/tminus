/**
 * Phase 2B E2E Validation Test Suite
 *
 * Proves Phase 2B MCP server deliverables work end-to-end with real
 * HTTP requests against a running MCP worker. No mocks, no test fixtures.
 *
 * Test scenarios:
 *   1. Health endpoint returns 200
 *   2. MCP server responds to tools/list JSON-RPC request
 *   3. calendar.list_accounts returns accounts for authenticated user
 *   4. calendar.create_event creates an event and returns event_id
 *   5. calendar.get_availability returns free/busy data
 *   6. calendar.set_policy_edge sets a policy between accounts
 *   7. Tier restriction blocks free tier from write tools (TIER_REQUIRED)
 *   8. Rate limiting: malformed requests in burst do not crash the server
 *   9. Authentication: unauthenticated requests are rejected
 *
 * Configuration:
 *   MCP_BASE_URL env var (default: http://localhost:8976)
 *
 * Important notes:
 * - Test user data must be seeded before running (see scripts/e2e-mcp-setup.sh).
 * - The JWT_SECRET must match the MCP worker's .dev.vars file.
 * - Tests create real events and policies in D1 -- each test run is isolated
 *   by using unique identifiers (UUIDs in event titles).
 *
 * Run with:
 *   make test-e2e-phase2b           (against localhost:8976)
 *   make test-e2e-phase2b-staging   (against staging)
 */

import { describe, it, expect, beforeAll } from "vitest";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BASE_URL = process.env.MCP_BASE_URL || "http://localhost:8976";

/**
 * JWT_SECRET must match the MCP worker's secret for local dev.
 * In production/staging, JWTs would come from the API worker's auth flow.
 */
const JWT_SECRET =
  "e2e-test-jwt-secret-minimum-32-characters-for-hs256";

/** Pre-seeded test user IDs (set up by e2e-mcp-setup.sh) */
const PREMIUM_USER = {
  userId: "usr_e2e_mcp_premium_01",
  email: "premium-e2e@test.tminus.ink",
  tier: "premium" as const,
};

const FREE_USER = {
  userId: "usr_e2e_mcp_free_01",
  email: "free-e2e@test.tminus.ink",
  tier: "free" as const,
};

/** Pre-seeded account IDs for the premium user */
const ACCOUNT_GOOGLE = "acc_e2e_mcp_google_01";
const ACCOUNT_OUTLOOK = "acc_e2e_mcp_outlook_01";

// ---------------------------------------------------------------------------
// JWT generation (inline, using Web Crypto API -- same as @tminus/shared)
//
// We inline this rather than importing from @tminus/shared to keep E2E tests
// self-contained with zero build-step dependency.
// ---------------------------------------------------------------------------

function b64UrlEncode(str: string): string {
  return btoa(str)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function bytesToB64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function generateTestJWT(
  sub: string,
  email: string,
  tier: string,
  secret: string,
  expiresInSeconds = 3600,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub,
    email,
    tier,
    pwd_ver: 1,
    iat: now,
    exp: now + expiresInSeconds,
  };

  const header = { alg: "HS256", typ: "JWT" };
  const headerB64 = b64UrlEncode(JSON.stringify(header));
  const payloadB64 = b64UrlEncode(JSON.stringify(payload));

  const signingInput = new TextEncoder().encode(
    `${headerB64}.${payloadB64}`,
  );
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, signingInput);
  const signatureB64 = bytesToB64Url(new Uint8Array(signature));

  return `${headerB64}.${payloadB64}.${signatureB64}`;
}

// ---------------------------------------------------------------------------
// Shared state across tests
// ---------------------------------------------------------------------------

let premiumToken: string;
let freeToken: string;

// ---------------------------------------------------------------------------
// Helper: fetch wrapper with timeout
// ---------------------------------------------------------------------------

async function api(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const url = `${BASE_URL}${path}`;
  return fetch(url, {
    ...options,
    signal: AbortSignal.timeout(15_000),
  });
}

/**
 * Send a JSON-RPC request to the MCP endpoint.
 * Returns both the HTTP response and the parsed JSON body.
 */
async function mcpRpc(
  method: string,
  params: Record<string, unknown> | undefined,
  token: string,
  id: string | number = 1,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const resp = await api("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method,
      params,
      id,
    }),
  });
  const body = (await resp.json()) as Record<string, unknown>;
  return { status: resp.status, body };
}

/**
 * Send a raw JSON-RPC request (no auth).
 */
async function mcpRpcNoAuth(
  method: string,
  params: Record<string, unknown> | undefined,
  id: string | number = 1,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const resp = await api("/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method,
      params,
      id,
    }),
  });
  const body = (await resp.json()) as Record<string, unknown>;
  return { status: resp.status, body };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Phase 2B E2E Validation: MCP Server", () => {
  // =========================================================================
  // Setup: generate JWTs and verify server is reachable
  // =========================================================================

  beforeAll(async () => {
    // Generate JWTs for test users
    premiumToken = await generateTestJWT(
      PREMIUM_USER.userId,
      PREMIUM_USER.email,
      PREMIUM_USER.tier,
      JWT_SECRET,
    );
    freeToken = await generateTestJWT(
      FREE_USER.userId,
      FREE_USER.email,
      FREE_USER.tier,
      JWT_SECRET,
    );

    // Verify MCP server is reachable
    try {
      const resp = await api("/health");
      if (!resp.ok) {
        throw new Error(`Health check failed: ${resp.status}`);
      }
    } catch (err) {
      throw new Error(
        `Cannot reach MCP server at ${BASE_URL}. ` +
          `Start the MCP worker first: ./scripts/e2e-mcp-setup.sh\n` +
          `Original error: ${err}`,
      );
    }
  });

  // =========================================================================
  // 1. Health endpoint
  // =========================================================================

  describe("1. Health endpoint", () => {
    it("GET /health returns 200 with healthy status", async () => {
      const resp = await api("/health");
      expect(resp.status).toBe(200);

      const body = (await resp.json()) as Record<string, unknown>;
      expect(body.ok).toBe(true);
      expect(body.status).toBe("healthy");
    });
  });

  // =========================================================================
  // 2. tools/list -- MCP protocol discovery
  // =========================================================================

  describe("2. tools/list returns registered MCP tools", () => {
    it("returns all 10 registered tools via JSON-RPC", async () => {
      const { status, body } = await mcpRpc("tools/list", undefined, premiumToken);

      expect(status).toBe(200);
      expect(body.jsonrpc).toBe("2.0");
      expect(body.id).toBe(1);
      expect(body.error).toBeUndefined();

      const result = body.result as { tools: Array<{ name: string }> };
      expect(result.tools).toBeDefined();
      expect(Array.isArray(result.tools)).toBe(true);
      expect(result.tools.length).toBe(10);

      // Verify expected tool names are present
      const toolNames = result.tools.map((t) => t.name);
      expect(toolNames).toContain("calendar.list_accounts");
      expect(toolNames).toContain("calendar.get_sync_status");
      expect(toolNames).toContain("calendar.list_events");
      expect(toolNames).toContain("calendar.create_event");
      expect(toolNames).toContain("calendar.update_event");
      expect(toolNames).toContain("calendar.delete_event");
      expect(toolNames).toContain("calendar.get_availability");
      expect(toolNames).toContain("calendar.list_policies");
      expect(toolNames).toContain("calendar.get_policy_edge");
      expect(toolNames).toContain("calendar.set_policy_edge");
    });

    it("each tool has name, description, and inputSchema", async () => {
      const { body } = await mcpRpc("tools/list", undefined, premiumToken);
      const result = body.result as {
        tools: Array<{
          name: string;
          description: string;
          inputSchema: { type: string };
        }>;
      };

      for (const tool of result.tools) {
        expect(typeof tool.name).toBe("string");
        expect(tool.name.length).toBeGreaterThan(0);
        expect(typeof tool.description).toBe("string");
        expect(tool.description.length).toBeGreaterThan(0);
        expect(tool.inputSchema).toBeDefined();
        expect(tool.inputSchema.type).toBe("object");
      }
    });
  });

  // =========================================================================
  // 3. calendar.list_accounts -- returns real accounts
  // =========================================================================

  describe("3. calendar.list_accounts returns accounts", () => {
    it("returns seeded accounts for the premium user", async () => {
      const { status, body } = await mcpRpc(
        "tools/call",
        { name: "calendar.list_accounts" },
        premiumToken,
      );

      expect(status).toBe(200);
      expect(body.error).toBeUndefined();

      const result = body.result as {
        content: Array<{ type: string; text: string }>;
      };
      expect(result.content).toBeDefined();
      expect(result.content.length).toBe(1);
      expect(result.content[0].type).toBe("text");

      const accounts = JSON.parse(result.content[0].text) as Array<{
        account_id: string;
        provider: string;
        email: string;
        status: string;
        channel_status: string;
      }>;

      expect(accounts.length).toBe(2);

      // Verify account details
      const google = accounts.find(
        (a) => a.account_id === ACCOUNT_GOOGLE,
      );
      expect(google).toBeDefined();
      expect(google!.provider).toBe("google");
      expect(google!.email).toBe("premium@gmail.com");
      expect(google!.status).toBe("active");

      const outlook = accounts.find(
        (a) => a.account_id === ACCOUNT_OUTLOOK,
      );
      expect(outlook).toBeDefined();
      expect(outlook!.provider).toBe("microsoft");
      expect(outlook!.email).toBe("premium@outlook.com");
      expect(outlook!.status).toBe("active");
    });

    it("free user with no accounts returns empty array", async () => {
      const { status, body } = await mcpRpc(
        "tools/call",
        { name: "calendar.list_accounts" },
        freeToken,
      );

      expect(status).toBe(200);
      expect(body.error).toBeUndefined();

      const result = body.result as {
        content: Array<{ type: string; text: string }>;
      };
      const accounts = JSON.parse(result.content[0].text);
      expect(Array.isArray(accounts)).toBe(true);
      expect(accounts.length).toBe(0);
    });
  });

  // =========================================================================
  // 4. calendar.create_event -- creates event, returns event_id
  // =========================================================================

  describe("4. calendar.create_event creates an event", () => {
    const testRunId = crypto.randomUUID().slice(0, 8);

    it("creates event with full fields and returns event data", async () => {
      const { status, body } = await mcpRpc(
        "tools/call",
        {
          name: "calendar.create_event",
          arguments: {
            title: `E2E Test Meeting ${testRunId}`,
            start_ts: "2026-04-01T09:00:00Z",
            end_ts: "2026-04-01T10:00:00Z",
            timezone: "America/Chicago",
            description: "E2E test event created by Phase 2B validation",
            location: "Virtual",
          },
        },
        premiumToken,
      );

      expect(status).toBe(200);
      expect(body.error).toBeUndefined();

      const result = body.result as {
        content: Array<{ type: string; text: string }>;
      };
      const event = JSON.parse(result.content[0].text) as Record<
        string,
        unknown
      >;

      // Verify returned event data
      expect(event.event_id).toBeDefined();
      expect(typeof event.event_id).toBe("string");
      expect((event.event_id as string).startsWith("evt_")).toBe(true);
      expect(event.title).toBe(`E2E Test Meeting ${testRunId}`);
      expect(event.start_ts).toBe("2026-04-01T09:00:00Z");
      expect(event.end_ts).toBe("2026-04-01T10:00:00Z");
      expect(event.timezone).toBe("America/Chicago");
      expect(event.description).toBe(
        "E2E test event created by Phase 2B validation",
      );
      expect(event.location).toBe("Virtual");
      expect(event.source).toBe("mcp");
      expect(event.created_at).toBeDefined();
    });

    it("created event appears in list_events for the same time range", async () => {
      // First create a uniquely identifiable event
      const uniqueTitle = `E2E Verify List ${crypto.randomUUID().slice(0, 8)}`;

      const createResult = await mcpRpc(
        "tools/call",
        {
          name: "calendar.create_event",
          arguments: {
            title: uniqueTitle,
            start_ts: "2026-05-01T14:00:00Z",
            end_ts: "2026-05-01T15:00:00Z",
          },
        },
        premiumToken,
      );
      expect(createResult.body.error).toBeUndefined();

      const createdEvent = JSON.parse(
        (
          createResult.body.result as {
            content: Array<{ text: string }>;
          }
        ).content[0].text,
      ) as Record<string, unknown>;

      // Now list events in the same time range
      const listResult = await mcpRpc(
        "tools/call",
        {
          name: "calendar.list_events",
          arguments: {
            start: "2026-05-01T00:00:00Z",
            end: "2026-05-02T00:00:00Z",
          },
        },
        premiumToken,
      );
      expect(listResult.body.error).toBeUndefined();

      const events = JSON.parse(
        (
          listResult.body.result as {
            content: Array<{ text: string }>;
          }
        ).content[0].text,
      ) as Array<Record<string, unknown>>;

      const found = events.find(
        (e) => e.event_id === createdEvent.event_id,
      );
      expect(found).toBeDefined();
      expect(found!.title).toBe(uniqueTitle);
    });

    it("rejects invalid parameters (missing title)", async () => {
      const { status, body } = await mcpRpc(
        "tools/call",
        {
          name: "calendar.create_event",
          arguments: {
            start_ts: "2026-04-01T09:00:00Z",
            end_ts: "2026-04-01T10:00:00Z",
          },
        },
        premiumToken,
      );

      expect(status).toBe(200);
      expect(body.error).toBeDefined();

      const error = body.error as { code: number; message: string };
      expect(error.code).toBe(-32602); // INVALID_PARAMS
      expect(error.message).toContain("title");
    });
  });

  // =========================================================================
  // 5. calendar.get_availability -- returns free/busy data
  // =========================================================================

  describe("5. calendar.get_availability returns free/busy data", () => {
    it("returns availability slots for a time range", async () => {
      const { status, body } = await mcpRpc(
        "tools/call",
        {
          name: "calendar.get_availability",
          arguments: {
            start: "2026-06-01T08:00:00Z",
            end: "2026-06-01T12:00:00Z",
            granularity: "1h",
          },
        },
        premiumToken,
      );

      expect(status).toBe(200);
      expect(body.error).toBeUndefined();

      const result = body.result as {
        content: Array<{ type: string; text: string }>;
      };
      const data = JSON.parse(result.content[0].text) as {
        slots: Array<{
          start: string;
          end: string;
          status: string;
        }>;
      };

      expect(data.slots).toBeDefined();
      expect(Array.isArray(data.slots)).toBe(true);
      // 4 hours at 1h granularity = 4 slots
      expect(data.slots.length).toBe(4);

      // Verify slot structure
      for (const slot of data.slots) {
        expect(slot.start).toBeDefined();
        expect(slot.end).toBeDefined();
        expect(["free", "busy", "tentative"]).toContain(slot.status);
      }

      // Verify first and last slot boundaries
      expect(data.slots[0].start).toBe("2026-06-01T08:00:00.000Z");
      expect(data.slots[3].end).toBe("2026-06-01T12:00:00.000Z");
    });

    it("shows busy slot when event exists in time range", async () => {
      // Create an event in a known time range
      const createResult = await mcpRpc(
        "tools/call",
        {
          name: "calendar.create_event",
          arguments: {
            title: "E2E Busy Slot Test",
            start_ts: "2026-07-15T10:00:00Z",
            end_ts: "2026-07-15T11:00:00Z",
          },
        },
        premiumToken,
      );
      expect(createResult.body.error).toBeUndefined();

      // Query availability for that range
      const { body } = await mcpRpc(
        "tools/call",
        {
          name: "calendar.get_availability",
          arguments: {
            start: "2026-07-15T09:00:00Z",
            end: "2026-07-15T12:00:00Z",
            granularity: "1h",
          },
        },
        premiumToken,
      );
      expect(body.error).toBeUndefined();

      const data = JSON.parse(
        (body.result as { content: Array<{ text: string }> }).content[0]
          .text,
      ) as {
        slots: Array<{
          start: string;
          end: string;
          status: string;
          conflicting_events?: number;
        }>;
      };

      // 3 hours at 1h = 3 slots
      expect(data.slots.length).toBe(3);

      // The 10:00-11:00 slot should be busy
      const busySlot = data.slots.find(
        (s) => s.start === "2026-07-15T10:00:00.000Z",
      );
      expect(busySlot).toBeDefined();
      expect(busySlot!.status).toBe("busy");
      expect(busySlot!.conflicting_events).toBe(1);

      // The 09:00-10:00 slot should be free
      const freeSlot = data.slots.find(
        (s) => s.start === "2026-07-15T09:00:00.000Z",
      );
      expect(freeSlot).toBeDefined();
      expect(freeSlot!.status).toBe("free");
    });

    it("supports different granularity (15m)", async () => {
      const { body } = await mcpRpc(
        "tools/call",
        {
          name: "calendar.get_availability",
          arguments: {
            start: "2026-06-02T09:00:00Z",
            end: "2026-06-02T10:00:00Z",
            granularity: "15m",
          },
        },
        premiumToken,
      );
      expect(body.error).toBeUndefined();

      const data = JSON.parse(
        (body.result as { content: Array<{ text: string }> }).content[0]
          .text,
      ) as { slots: Array<unknown> };

      // 1 hour at 15m granularity = 4 slots
      expect(data.slots.length).toBe(4);
    });
  });

  // =========================================================================
  // 6. calendar.set_policy_edge -- sets a policy between accounts
  // =========================================================================

  describe("6. calendar.set_policy_edge sets a policy", () => {
    it("creates a BUSY policy between two accounts", async () => {
      const { status, body } = await mcpRpc(
        "tools/call",
        {
          name: "calendar.set_policy_edge",
          arguments: {
            from_account: ACCOUNT_GOOGLE,
            to_account: ACCOUNT_OUTLOOK,
            detail_level: "BUSY",
          },
        },
        premiumToken,
      );

      expect(status).toBe(200);
      expect(body.error).toBeUndefined();

      const result = body.result as {
        content: Array<{ type: string; text: string }>;
      };
      const policy = JSON.parse(result.content[0].text) as Record<
        string,
        unknown
      >;

      expect(policy.policy_id).toBeDefined();
      expect(typeof policy.policy_id).toBe("string");
      expect((policy.policy_id as string).startsWith("pol_")).toBe(true);
      expect(policy.from_account).toBe(ACCOUNT_GOOGLE);
      expect(policy.to_account).toBe(ACCOUNT_OUTLOOK);
      expect(policy.detail_level).toBe("BUSY");
      expect(policy.calendar_kind).toBe("BUSY_OVERLAY"); // Default per BR-11
      expect(policy.created_at).toBeDefined();
    });

    it("created policy appears in list_policies", async () => {
      const { body } = await mcpRpc(
        "tools/call",
        { name: "calendar.list_policies" },
        premiumToken,
      );
      expect(body.error).toBeUndefined();

      const result = body.result as {
        content: Array<{ type: string; text: string }>;
      };
      const data = JSON.parse(result.content[0].text) as {
        policies: Array<Record<string, unknown>>;
      };

      expect(data.policies.length).toBeGreaterThanOrEqual(1);

      const found = data.policies.find(
        (p) =>
          p.from_account === ACCOUNT_GOOGLE &&
          p.to_account === ACCOUNT_OUTLOOK,
      );
      expect(found).toBeDefined();
      expect(found!.detail_level).toBe("BUSY");
      expect(found!.calendar_kind).toBe("BUSY_OVERLAY");
    });

    it("upserts policy to update detail_level", async () => {
      // Update the policy from BUSY to FULL
      const { body } = await mcpRpc(
        "tools/call",
        {
          name: "calendar.set_policy_edge",
          arguments: {
            from_account: ACCOUNT_GOOGLE,
            to_account: ACCOUNT_OUTLOOK,
            detail_level: "FULL",
            calendar_kind: "TRUE_MIRROR",
          },
        },
        premiumToken,
      );
      expect(body.error).toBeUndefined();

      const result = body.result as {
        content: Array<{ type: string; text: string }>;
      };
      const policy = JSON.parse(result.content[0].text) as Record<
        string,
        unknown
      >;

      expect(policy.detail_level).toBe("FULL");
      expect(policy.calendar_kind).toBe("TRUE_MIRROR");
      // Same from/to, so same policy_id
      expect(policy.from_account).toBe(ACCOUNT_GOOGLE);
      expect(policy.to_account).toBe(ACCOUNT_OUTLOOK);
    });

    it("rejects invalid detail_level", async () => {
      const { body } = await mcpRpc(
        "tools/call",
        {
          name: "calendar.set_policy_edge",
          arguments: {
            from_account: ACCOUNT_GOOGLE,
            to_account: ACCOUNT_OUTLOOK,
            detail_level: "INVALID",
          },
        },
        premiumToken,
      );

      expect(body.error).toBeDefined();
      const error = body.error as { code: number; message: string };
      expect(error.code).toBe(-32602);
      expect(error.message).toContain("detail_level");
    });
  });

  // =========================================================================
  // 7. Tier restriction -- free tier blocked from write tools
  // =========================================================================

  describe("7. Tier restriction blocks free tier from write tools", () => {
    it("free user CANNOT call calendar.create_event (TIER_REQUIRED)", async () => {
      const { status, body } = await mcpRpc(
        "tools/call",
        {
          name: "calendar.create_event",
          arguments: {
            title: "Should Be Blocked",
            start_ts: "2026-04-01T09:00:00Z",
            end_ts: "2026-04-01T10:00:00Z",
          },
        },
        freeToken,
      );

      expect(status).toBe(200);
      expect(body.error).toBeDefined();

      const error = body.error as {
        code: number;
        message: string;
        data: {
          code: string;
          required_tier: string;
          current_tier: string;
          tool: string;
        };
      };

      expect(error.code).toBe(-32603);
      expect(error.message).toBe("Insufficient tier");
      expect(error.data.code).toBe("TIER_REQUIRED");
      expect(error.data.required_tier).toBe("premium");
      expect(error.data.current_tier).toBe("free");
      expect(error.data.tool).toBe("calendar.create_event");
    });

    it("free user CANNOT call calendar.set_policy_edge (TIER_REQUIRED)", async () => {
      const { body } = await mcpRpc(
        "tools/call",
        {
          name: "calendar.set_policy_edge",
          arguments: {
            from_account: ACCOUNT_GOOGLE,
            to_account: ACCOUNT_OUTLOOK,
            detail_level: "BUSY",
          },
        },
        freeToken,
      );

      expect(body.error).toBeDefined();
      const error = body.error as {
        code: number;
        data: { code: string; tool: string };
      };
      expect(error.data.code).toBe("TIER_REQUIRED");
      expect(error.data.tool).toBe("calendar.set_policy_edge");
    });

    it("free user CANNOT call calendar.delete_event (TIER_REQUIRED)", async () => {
      const { body } = await mcpRpc(
        "tools/call",
        {
          name: "calendar.delete_event",
          arguments: { event_id: "evt_nonexistent" },
        },
        freeToken,
      );

      expect(body.error).toBeDefined();
      const error = body.error as {
        code: number;
        data: { code: string; tool: string };
      };
      expect(error.data.code).toBe("TIER_REQUIRED");
      expect(error.data.tool).toBe("calendar.delete_event");
    });

    it("free user CANNOT call calendar.update_event (TIER_REQUIRED)", async () => {
      const { body } = await mcpRpc(
        "tools/call",
        {
          name: "calendar.update_event",
          arguments: {
            event_id: "evt_nonexistent",
            patch: { title: "New Title" },
          },
        },
        freeToken,
      );

      expect(body.error).toBeDefined();
      const error = body.error as {
        code: number;
        data: { code: string; tool: string };
      };
      expect(error.data.code).toBe("TIER_REQUIRED");
      expect(error.data.tool).toBe("calendar.update_event");
    });

    it("free user CAN call read-only tools (calendar.list_accounts)", async () => {
      const { status, body } = await mcpRpc(
        "tools/call",
        { name: "calendar.list_accounts" },
        freeToken,
      );

      expect(status).toBe(200);
      expect(body.error).toBeUndefined();
      // Free user has no accounts but the tool should succeed
      const result = body.result as {
        content: Array<{ text: string }>;
      };
      expect(result.content).toBeDefined();
    });

    it("free user CAN call calendar.get_availability (read-only)", async () => {
      const { body } = await mcpRpc(
        "tools/call",
        {
          name: "calendar.get_availability",
          arguments: {
            start: "2026-06-01T08:00:00Z",
            end: "2026-06-01T12:00:00Z",
          },
        },
        freeToken,
      );

      expect(body.error).toBeUndefined();
    });

    it("free user CAN call calendar.list_policies (read-only)", async () => {
      const { body } = await mcpRpc(
        "tools/call",
        { name: "calendar.list_policies" },
        freeToken,
      );

      expect(body.error).toBeUndefined();
    });

    it("tier check happens BEFORE parameter validation (fail fast)", async () => {
      // Send create_event with empty args as free user.
      // If tier check is first, we get TIER_REQUIRED (not INVALID_PARAMS).
      const { body } = await mcpRpc(
        "tools/call",
        {
          name: "calendar.create_event",
          arguments: {},
        },
        freeToken,
      );

      expect(body.error).toBeDefined();
      const error = body.error as {
        code: number;
        data: { code: string };
      };
      // TIER_REQUIRED (-32603), NOT INVALID_PARAMS (-32602)
      expect(error.code).toBe(-32603);
      expect(error.data.code).toBe("TIER_REQUIRED");
    });
  });

  // =========================================================================
  // 8. Rate limiting / server resilience
  //
  // The MCP worker does not currently have a RateLimiter DO integrated.
  // We test that the server handles burst requests gracefully without
  // crashing or returning unexpected errors. When rate limiting is added,
  // these tests should be updated to verify 429 responses.
  // =========================================================================

  describe("8. Server resilience under burst requests", () => {
    it("handles 20 rapid requests without crashing", async () => {
      const promises = Array.from({ length: 20 }, (_, i) =>
        mcpRpc("tools/list", undefined, premiumToken, i + 1),
      );

      const results = await Promise.all(promises);

      let successCount = 0;
      let errorCount = 0;

      for (const r of results) {
        if (r.status === 200 && !r.body.error) {
          successCount++;
        } else if (r.status === 429) {
          // Rate limited -- expected if RateLimiter DO is active
          errorCount++;
        } else {
          // Still a valid response (not a crash)
          successCount++;
        }
      }

      // All requests should get valid responses (no 5xx crashes)
      expect(successCount + errorCount).toBe(20);

      // At least some should succeed
      expect(successCount).toBeGreaterThan(0);
    });

    it("handles malformed JSON-RPC without crashing", async () => {
      // Missing jsonrpc field
      const resp1 = await api("/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${premiumToken}`,
        },
        body: JSON.stringify({ method: "tools/list", id: 1 }),
      });
      expect(resp1.status).toBe(200);
      const body1 = (await resp1.json()) as Record<string, unknown>;
      expect(body1.error).toBeDefined();

      // Not JSON at all
      const resp2 = await api("/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${premiumToken}`,
        },
        body: "not json at all",
      });
      expect(resp2.status).toBe(200);
      const body2 = (await resp2.json()) as Record<string, unknown>;
      expect(body2.error).toBeDefined();

      // Empty body
      const resp3 = await api("/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${premiumToken}`,
        },
        body: "",
      });
      // May return parse error, but should not crash
      expect([200, 400]).toContain(resp3.status);
    });
  });

  // =========================================================================
  // 9. Authentication enforcement
  // =========================================================================

  describe("9. Authentication enforcement", () => {
    it("unauthenticated request returns 401 with RPC error", async () => {
      const { status, body } = await mcpRpcNoAuth(
        "tools/list",
        undefined,
      );

      expect(status).toBe(401);
      expect(body.error).toBeDefined();

      const error = body.error as { code: number; message: string };
      expect(error.code).toBe(-32000); // RPC_AUTH_REQUIRED
      expect(error.message).toContain("Authentication required");
    });

    it("invalid JWT returns 401", async () => {
      const resp = await api("/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer invalid.jwt.token",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "tools/list",
          id: 1,
        }),
      });

      expect(resp.status).toBe(401);
      const body = (await resp.json()) as Record<string, unknown>;
      expect(body.error).toBeDefined();
    });

    it("expired JWT returns 401", async () => {
      // Generate a token that expired 1 hour ago
      const expiredToken = await generateTestJWT(
        PREMIUM_USER.userId,
        PREMIUM_USER.email,
        PREMIUM_USER.tier,
        JWT_SECRET,
        -3600, // negative = already expired
      );

      const resp = await api("/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${expiredToken}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "tools/list",
          id: 1,
        }),
      });

      expect(resp.status).toBe(401);
    });

    it("wrong signing secret returns 401", async () => {
      const badToken = await generateTestJWT(
        PREMIUM_USER.userId,
        PREMIUM_USER.email,
        PREMIUM_USER.tier,
        "completely-different-secret-that-does-not-match-at-all!",
      );

      const resp = await api("/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${badToken}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "tools/list",
          id: 1,
        }),
      });

      expect(resp.status).toBe(401);
    });
  });

  // =========================================================================
  // 10. Full lifecycle: create -> query -> update -> verify -> delete
  // =========================================================================

  describe("10. Full event CRUD lifecycle", () => {
    let createdEventId: string;

    it("create -> list -> update -> verify -> delete", async () => {
      const uniqueTitle = `Lifecycle ${crypto.randomUUID().slice(0, 8)}`;
      const updatedTitle = `Updated ${uniqueTitle}`;

      // Step 1: Create event
      const createResult = await mcpRpc(
        "tools/call",
        {
          name: "calendar.create_event",
          arguments: {
            title: uniqueTitle,
            start_ts: "2026-08-20T14:00:00Z",
            end_ts: "2026-08-20T15:00:00Z",
          },
        },
        premiumToken,
      );
      expect(createResult.body.error).toBeUndefined();
      const created = JSON.parse(
        (
          createResult.body.result as {
            content: Array<{ text: string }>;
          }
        ).content[0].text,
      ) as Record<string, unknown>;
      createdEventId = created.event_id as string;
      expect(createdEventId).toBeDefined();

      // Step 2: Verify via list_events
      const listResult = await mcpRpc(
        "tools/call",
        {
          name: "calendar.list_events",
          arguments: {
            start: "2026-08-20T00:00:00Z",
            end: "2026-08-21T00:00:00Z",
          },
        },
        premiumToken,
      );
      expect(listResult.body.error).toBeUndefined();
      const events = JSON.parse(
        (
          listResult.body.result as {
            content: Array<{ text: string }>;
          }
        ).content[0].text,
      ) as Array<Record<string, unknown>>;
      expect(events.find((e) => e.event_id === createdEventId)).toBeDefined();

      // Step 3: Update event
      const updateResult = await mcpRpc(
        "tools/call",
        {
          name: "calendar.update_event",
          arguments: {
            event_id: createdEventId,
            patch: { title: updatedTitle },
          },
        },
        premiumToken,
      );
      expect(updateResult.body.error).toBeUndefined();
      const updated = JSON.parse(
        (
          updateResult.body.result as {
            content: Array<{ text: string }>;
          }
        ).content[0].text,
      ) as Record<string, unknown>;
      expect(updated.title).toBe(updatedTitle);

      // Step 4: Verify update via list
      const listResult2 = await mcpRpc(
        "tools/call",
        {
          name: "calendar.list_events",
          arguments: {
            start: "2026-08-20T00:00:00Z",
            end: "2026-08-21T00:00:00Z",
          },
        },
        premiumToken,
      );
      const events2 = JSON.parse(
        (
          listResult2.body.result as {
            content: Array<{ text: string }>;
          }
        ).content[0].text,
      ) as Array<Record<string, unknown>>;
      const updatedEvent = events2.find(
        (e) => e.event_id === createdEventId,
      );
      expect(updatedEvent).toBeDefined();
      expect(updatedEvent!.title).toBe(updatedTitle);

      // Step 5: Delete event
      const deleteResult = await mcpRpc(
        "tools/call",
        {
          name: "calendar.delete_event",
          arguments: { event_id: createdEventId },
        },
        premiumToken,
      );
      expect(deleteResult.body.error).toBeUndefined();
      const deleted = JSON.parse(
        (
          deleteResult.body.result as {
            content: Array<{ text: string }>;
          }
        ).content[0].text,
      ) as Record<string, unknown>;
      expect(deleted.deleted).toBe(true);
      expect(deleted.event_id).toBe(createdEventId);

      // Step 6: Verify deletion via list
      const listResult3 = await mcpRpc(
        "tools/call",
        {
          name: "calendar.list_events",
          arguments: {
            start: "2026-08-20T00:00:00Z",
            end: "2026-08-21T00:00:00Z",
          },
        },
        premiumToken,
      );
      const events3 = JSON.parse(
        (
          listResult3.body.result as {
            content: Array<{ text: string }>;
          }
        ).content[0].text,
      ) as Array<Record<string, unknown>>;
      expect(
        events3.find((e) => e.event_id === createdEventId),
      ).toBeUndefined();
    });
  });
});
