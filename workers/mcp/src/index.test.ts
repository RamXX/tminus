/**
 * Unit tests for tminus-mcp worker.
 *
 * Tests the core building blocks:
 * - Health endpoint
 * - JSON-RPC parsing (valid/invalid/malformed)
 * - MCP tool registration (tools/list)
 * - MCP tool invocation (tools/call)
 * - Authentication enforcement (missing/invalid/valid JWT)
 * - Error responses in JSON-RPC format
 * - CORS preflight handling
 * - 404 for unknown paths
 *
 * Uses generateJWT from @tminus/shared for token creation.
 */

import { describe, it, expect, vi } from "vitest";
import { generateJWT } from "@tminus/shared";
import {
  createMcpHandler,
  computeHealthStatus,
  computeOverallHealth,
  computeChannelStatus,
  validateListEventsParams,
  validateCreateEventParams,
  validateUpdateEventParams,
  validateDeleteEventParams,
  validateGetAvailabilityParams,
  generateTimeSlots,
  computeAvailabilitySlots,
  validateGetPolicyEdgeParams,
  validateSetPolicyEdgeParams,
  checkTierAccess,
  validateAddTripParams,
  validateAddConstraintParams,
  validateListConstraintsParams,
  validateGetCommitmentStatusParams,
  validateExportCommitmentProofParams,
} from "./index";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const JWT_SECRET = "test-mcp-jwt-secret-for-unit-tests-must-be-long-enough";
const TEST_USER_ID = "usr_01HXYZ000000000000000001";
const TEST_EMAIL = "test@example.com";

// ---------------------------------------------------------------------------
// JWT helper
// ---------------------------------------------------------------------------

async function makeAuthHeader(userId?: string): Promise<string> {
  const token = await generateJWT(
    {
      sub: userId ?? TEST_USER_ID,
      email: TEST_EMAIL,
      tier: "free",
      pwd_ver: 1,
    },
    JWT_SECRET,
    3600,
  );
  return `Bearer ${token}`;
}

async function makeExpiredAuthHeader(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const token = await generateJWT(
    {
      sub: TEST_USER_ID,
      email: TEST_EMAIL,
      tier: "free",
      pwd_ver: 1,
      iat: now - 7200,
      exp: now - 3600, // expired 1 hour ago
    },
    JWT_SECRET,
  );
  return `Bearer ${token}`;
}

// ---------------------------------------------------------------------------
// Minimal mock Env
// ---------------------------------------------------------------------------

function createMinimalEnv() {
  return {
    JWT_SECRET,
    DB: {} as D1Database,
    ENVIRONMENT: "development",
  };
}

const mockCtx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

// ---------------------------------------------------------------------------
// Helper: send a JSON-RPC request to the MCP endpoint
// ---------------------------------------------------------------------------

async function sendMcpRequest(
  handler: ReturnType<typeof createMcpHandler>,
  env: ReturnType<typeof createMinimalEnv>,
  body: unknown,
  authHeader?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (authHeader) {
    headers["Authorization"] = authHeader;
  }

  const request = new Request("https://mcp.tminus.ink/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const response = await handler.fetch(request, env, mockCtx);
  const responseBody = (await response.json()) as Record<string, unknown>;
  return { status: response.status, body: responseBody };
}

// ---------------------------------------------------------------------------
// Module shape
// ---------------------------------------------------------------------------

describe("MCP worker module shape", () => {
  it("default export has a fetch handler", async () => {
    const mod = await import("./index");
    expect(mod.default).toBeDefined();
    expect(typeof mod.default.fetch).toBe("function");
  });

  it("exports createMcpHandler factory", async () => {
    const mod = await import("./index");
    expect(typeof mod.createMcpHandler).toBe("function");
  });

  it("createMcpHandler returns object with fetch method", () => {
    const handler = createMcpHandler();
    expect(typeof handler.fetch).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Health endpoint
// ---------------------------------------------------------------------------

describe("GET /health", () => {
  it("returns 200 with ok: true", async () => {
    const handler = createMcpHandler();
    const env = createMinimalEnv();
    const request = new Request("https://mcp.tminus.ink/health", {
      method: "GET",
    });
    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.status).toBe("healthy");
  });

  it("includes Content-Type application/json header", async () => {
    const handler = createMcpHandler();
    const env = createMinimalEnv();
    const request = new Request("https://mcp.tminus.ink/health", {
      method: "GET",
    });
    const response = await handler.fetch(request, env, mockCtx);
    expect(response.headers.get("Content-Type")).toBe("application/json");
  });
});

// ---------------------------------------------------------------------------
// CORS preflight
// ---------------------------------------------------------------------------

describe("OPTIONS (CORS preflight)", () => {
  it("returns 204 for OPTIONS request", async () => {
    const handler = createMcpHandler();
    const env = createMinimalEnv();
    const request = new Request("https://mcp.tminus.ink/mcp", {
      method: "OPTIONS",
      headers: {
        Origin: "https://app.tminus.ink",
      },
    });
    const response = await handler.fetch(request, env, mockCtx);
    // buildPreflightResponse returns 204
    expect(response.status).toBe(204);
  });
});

// ---------------------------------------------------------------------------
// 404 for unknown paths
// ---------------------------------------------------------------------------

describe("unknown paths", () => {
  it("returns 404 for GET /unknown", async () => {
    const handler = createMcpHandler();
    const env = createMinimalEnv();
    const request = new Request("https://mcp.tminus.ink/unknown", {
      method: "GET",
    });
    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(404);
  });

  it("returns 404 for POST /unknown", async () => {
    const handler = createMcpHandler();
    const env = createMinimalEnv();
    const request = new Request("https://mcp.tminus.ink/unknown", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// JSON-RPC parse errors
// ---------------------------------------------------------------------------

describe("POST /mcp -- parse errors", () => {
  it("returns parse error for malformed JSON", async () => {
    const handler = createMcpHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    const request = new Request("https://mcp.tminus.ink/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
      },
      body: "{ not valid json",
    });

    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(200); // JSON-RPC errors use 200
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.jsonrpc).toBe("2.0");
    const error = body.error as Record<string, unknown>;
    expect(error.code).toBe(-32700); // Parse error
  });

  it("returns invalid request for missing jsonrpc field", async () => {
    const handler = createMcpHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    const result = await sendMcpRequest(
      handler,
      env,
      { method: "tools/list", id: 1 },
      authHeader,
    );

    expect(result.body.jsonrpc).toBe("2.0");
    const error = result.body.error as Record<string, unknown>;
    expect(error.code).toBe(-32600); // Invalid Request
  });

  it("returns invalid request for missing method field", async () => {
    const handler = createMcpHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    const result = await sendMcpRequest(
      handler,
      env,
      { jsonrpc: "2.0", id: 1 },
      authHeader,
    );

    const error = result.body.error as Record<string, unknown>;
    expect(error.code).toBe(-32600);
  });
});

// ---------------------------------------------------------------------------
// Authentication enforcement
// ---------------------------------------------------------------------------

describe("POST /mcp -- authentication", () => {
  it("returns auth error when no Authorization header", async () => {
    const handler = createMcpHandler();
    const env = createMinimalEnv();

    const result = await sendMcpRequest(handler, env, {
      jsonrpc: "2.0",
      method: "tools/list",
      id: 1,
    });

    expect(result.status).toBe(401);
    const error = result.body.error as Record<string, unknown>;
    expect(error.code).toBe(-32000); // Auth required
    expect(error.message).toContain("Authentication required");
  });

  it("returns auth error for invalid JWT", async () => {
    const handler = createMcpHandler();
    const env = createMinimalEnv();

    const result = await sendMcpRequest(
      handler,
      env,
      { jsonrpc: "2.0", method: "tools/list", id: 1 },
      "Bearer invalid.jwt.token",
    );

    expect(result.status).toBe(401);
    const error = result.body.error as Record<string, unknown>;
    expect(error.code).toBe(-32000);
  });

  it("returns auth error for expired JWT", async () => {
    const handler = createMcpHandler();
    const env = createMinimalEnv();
    const expiredAuth = await makeExpiredAuthHeader();

    const result = await sendMcpRequest(
      handler,
      env,
      { jsonrpc: "2.0", method: "tools/list", id: 1 },
      expiredAuth,
    );

    expect(result.status).toBe(401);
    const error = result.body.error as Record<string, unknown>;
    expect(error.code).toBe(-32000);
  });

  it("returns auth error for malformed Authorization header", async () => {
    const handler = createMcpHandler();
    const env = createMinimalEnv();

    const result = await sendMcpRequest(
      handler,
      env,
      { jsonrpc: "2.0", method: "tools/list", id: 1 },
      "NotBearer sometoken",
    );

    expect(result.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// tools/list
// ---------------------------------------------------------------------------

describe("POST /mcp -- tools/list", () => {
  it("returns registered tools including list_accounts and get_sync_status", async () => {
    const handler = createMcpHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    const result = await sendMcpRequest(
      handler,
      env,
      { jsonrpc: "2.0", method: "tools/list", id: 1 },
      authHeader,
    );

    expect(result.status).toBe(200);
    expect(result.body.jsonrpc).toBe("2.0");
    expect(result.body.id).toBe(1);
    expect(result.body.error).toBeUndefined();

    const resultData = result.body.result as { tools: Array<Record<string, unknown>> };
    expect(resultData.tools).toBeInstanceOf(Array);
    expect(resultData.tools.length).toBeGreaterThanOrEqual(2);

    // Verify calendar.list_accounts tool is registered
    const listAccountsTool = resultData.tools.find(
      (t) => t.name === "calendar.list_accounts",
    );
    expect(listAccountsTool).toBeDefined();
    expect(listAccountsTool?.description).toBeTruthy();
    expect(listAccountsTool?.inputSchema).toBeDefined();

    const listSchema = listAccountsTool?.inputSchema as Record<string, unknown>;
    expect(listSchema.type).toBe("object");

    // Verify calendar.get_sync_status tool is registered
    const syncStatusTool = resultData.tools.find(
      (t) => t.name === "calendar.get_sync_status",
    );
    expect(syncStatusTool).toBeDefined();
    expect(syncStatusTool?.description).toBeTruthy();
    expect(syncStatusTool?.inputSchema).toBeDefined();

    const syncSchema = syncStatusTool?.inputSchema as { type: string; properties: Record<string, unknown> };
    expect(syncSchema.type).toBe("object");
    expect(syncSchema.properties).toHaveProperty("account_id");
  });

  it("preserves the request id in response", async () => {
    const handler = createMcpHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    const result = await sendMcpRequest(
      handler,
      env,
      { jsonrpc: "2.0", method: "tools/list", id: "my-custom-id" },
      authHeader,
    );

    expect(result.body.id).toBe("my-custom-id");
  });

  it("handles null id in request", async () => {
    const handler = createMcpHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    const result = await sendMcpRequest(
      handler,
      env,
      { jsonrpc: "2.0", method: "tools/list", id: null },
      authHeader,
    );

    expect(result.body.id).toBeNull();
    expect(result.body.result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// tools/call -- parameter validation
// ---------------------------------------------------------------------------

describe("POST /mcp -- tools/call parameter validation", () => {
  it("returns error when params.name is missing", async () => {
    const handler = createMcpHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    const result = await sendMcpRequest(
      handler,
      env,
      { jsonrpc: "2.0", method: "tools/call", params: {}, id: 1 },
      authHeader,
    );

    const error = result.body.error as Record<string, unknown>;
    expect(error.code).toBe(-32602); // Invalid params
    expect(error.message).toContain("params.name");
  });

  it("returns error for unknown tool name", async () => {
    const handler = createMcpHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    const result = await sendMcpRequest(
      handler,
      env,
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "nonexistent.tool" },
        id: 1,
      },
      authHeader,
    );

    const error = result.body.error as Record<string, unknown>;
    expect(error.code).toBe(-32601); // Method not found
    expect(error.message).toContain("nonexistent.tool");
  });
});

// ---------------------------------------------------------------------------
// Unknown JSON-RPC methods
// ---------------------------------------------------------------------------

describe("POST /mcp -- unknown methods", () => {
  it("returns method not found for unknown method", async () => {
    const handler = createMcpHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    const result = await sendMcpRequest(
      handler,
      env,
      { jsonrpc: "2.0", method: "unknown/method", id: 1 },
      authHeader,
    );

    const error = result.body.error as Record<string, unknown>;
    expect(error.code).toBe(-32601); // Method not found
  });
});

// ---------------------------------------------------------------------------
// tools/list includes new event tools
// ---------------------------------------------------------------------------

describe("POST /mcp -- tools/list includes event management tools", () => {
  it("includes all 4 event management tools in registry", async () => {
    const handler = createMcpHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    const result = await sendMcpRequest(
      handler,
      env,
      { jsonrpc: "2.0", method: "tools/list", id: 1 },
      authHeader,
    );

    expect(result.status).toBe(200);
    const resultData = result.body.result as { tools: Array<Record<string, unknown>> };

    const toolNames = resultData.tools.map((t) => t.name);
    expect(toolNames).toContain("calendar.list_events");
    expect(toolNames).toContain("calendar.create_event");
    expect(toolNames).toContain("calendar.update_event");
    expect(toolNames).toContain("calendar.delete_event");
  });

  it("calendar.list_events schema has required start and end fields", async () => {
    const handler = createMcpHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    const result = await sendMcpRequest(
      handler,
      env,
      { jsonrpc: "2.0", method: "tools/list", id: 1 },
      authHeader,
    );

    const resultData = result.body.result as { tools: Array<Record<string, unknown>> };
    const listEvents = resultData.tools.find((t) => t.name === "calendar.list_events");
    expect(listEvents).toBeDefined();

    const schema = listEvents?.inputSchema as { required?: string[] };
    expect(schema.required).toContain("start");
    expect(schema.required).toContain("end");
  });

  it("calendar.create_event schema has required title, start_ts, end_ts fields", async () => {
    const handler = createMcpHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    const result = await sendMcpRequest(
      handler,
      env,
      { jsonrpc: "2.0", method: "tools/list", id: 1 },
      authHeader,
    );

    const resultData = result.body.result as { tools: Array<Record<string, unknown>> };
    const createEvent = resultData.tools.find((t) => t.name === "calendar.create_event");
    expect(createEvent).toBeDefined();

    const schema = createEvent?.inputSchema as { required?: string[] };
    expect(schema.required).toContain("title");
    expect(schema.required).toContain("start_ts");
    expect(schema.required).toContain("end_ts");
  });

  it("calendar.update_event schema has required event_id and patch fields", async () => {
    const handler = createMcpHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    const result = await sendMcpRequest(
      handler,
      env,
      { jsonrpc: "2.0", method: "tools/list", id: 1 },
      authHeader,
    );

    const resultData = result.body.result as { tools: Array<Record<string, unknown>> };
    const updateEvent = resultData.tools.find((t) => t.name === "calendar.update_event");
    expect(updateEvent).toBeDefined();

    const schema = updateEvent?.inputSchema as { required?: string[] };
    expect(schema.required).toContain("event_id");
    expect(schema.required).toContain("patch");
  });

  it("calendar.delete_event schema has required event_id field", async () => {
    const handler = createMcpHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    const result = await sendMcpRequest(
      handler,
      env,
      { jsonrpc: "2.0", method: "tools/list", id: 1 },
      authHeader,
    );

    const resultData = result.body.result as { tools: Array<Record<string, unknown>> };
    const deleteEvent = resultData.tools.find((t) => t.name === "calendar.delete_event");
    expect(deleteEvent).toBeDefined();

    const schema = deleteEvent?.inputSchema as { required?: string[] };
    expect(schema.required).toContain("event_id");
  });
});

// ---------------------------------------------------------------------------
// validateListEventsParams (pure function tests)
// ---------------------------------------------------------------------------

describe("validateListEventsParams", () => {
  it("throws on undefined args", () => {
    expect(() => validateListEventsParams(undefined)).toThrow("Missing required parameters");
  });

  it("throws when start is missing", () => {
    expect(() =>
      validateListEventsParams({ end: "2026-12-31T23:59:59Z" }),
    ).toThrow("'start' is required");
  });

  it("throws when end is missing", () => {
    expect(() =>
      validateListEventsParams({ start: "2026-01-01T00:00:00Z" }),
    ).toThrow("'end' is required");
  });

  it("throws when start is not a valid ISO datetime", () => {
    expect(() =>
      validateListEventsParams({ start: "not-a-date", end: "2026-12-31T23:59:59Z" }),
    ).toThrow("'start' is not a valid ISO 8601");
  });

  it("throws when end is not a valid ISO datetime", () => {
    expect(() =>
      validateListEventsParams({ start: "2026-01-01T00:00:00Z", end: "not-a-date" }),
    ).toThrow("'end' is not a valid ISO 8601");
  });

  it("throws when start >= end", () => {
    expect(() =>
      validateListEventsParams({
        start: "2026-12-31T23:59:59Z",
        end: "2026-01-01T00:00:00Z",
      }),
    ).toThrow("'start' must be before 'end'");
  });

  it("throws when start equals end", () => {
    expect(() =>
      validateListEventsParams({
        start: "2026-06-15T10:00:00Z",
        end: "2026-06-15T10:00:00Z",
      }),
    ).toThrow("'start' must be before 'end'");
  });

  it("throws when limit is not a positive integer", () => {
    expect(() =>
      validateListEventsParams({
        start: "2026-01-01T00:00:00Z",
        end: "2026-12-31T23:59:59Z",
        limit: -1,
      }),
    ).toThrow("'limit' must be a positive integer");
  });

  it("throws when limit is zero", () => {
    expect(() =>
      validateListEventsParams({
        start: "2026-01-01T00:00:00Z",
        end: "2026-12-31T23:59:59Z",
        limit: 0,
      }),
    ).toThrow("'limit' must be a positive integer");
  });

  it("throws when limit is a float", () => {
    expect(() =>
      validateListEventsParams({
        start: "2026-01-01T00:00:00Z",
        end: "2026-12-31T23:59:59Z",
        limit: 10.5,
      }),
    ).toThrow("'limit' must be a positive integer");
  });

  it("returns validated params for valid input", () => {
    const result = validateListEventsParams({
      start: "2026-01-01T00:00:00Z",
      end: "2026-12-31T23:59:59Z",
    });
    expect(result.start).toBe("2026-01-01T00:00:00Z");
    expect(result.end).toBe("2026-12-31T23:59:59Z");
    expect(result.account_id).toBeNull();
    expect(result.limit).toBe(100);
  });

  it("clamps limit to 500", () => {
    const result = validateListEventsParams({
      start: "2026-01-01T00:00:00Z",
      end: "2026-12-31T23:59:59Z",
      limit: 1000,
    });
    expect(result.limit).toBe(500);
  });

  it("passes through account_id when provided", () => {
    const result = validateListEventsParams({
      start: "2026-01-01T00:00:00Z",
      end: "2026-12-31T23:59:59Z",
      account_id: "acc_123",
    });
    expect(result.account_id).toBe("acc_123");
  });
});

// ---------------------------------------------------------------------------
// validateCreateEventParams (pure function tests)
// ---------------------------------------------------------------------------

describe("validateCreateEventParams", () => {
  it("throws on undefined args", () => {
    expect(() => validateCreateEventParams(undefined)).toThrow("Missing required parameters");
  });

  it("throws when title is missing", () => {
    expect(() =>
      validateCreateEventParams({
        start_ts: "2026-03-15T09:00:00Z",
        end_ts: "2026-03-15T10:00:00Z",
      }),
    ).toThrow("'title' is required");
  });

  it("throws when title is empty string", () => {
    expect(() =>
      validateCreateEventParams({
        title: "   ",
        start_ts: "2026-03-15T09:00:00Z",
        end_ts: "2026-03-15T10:00:00Z",
      }),
    ).toThrow("'title' is required");
  });

  it("throws when start_ts is missing", () => {
    expect(() =>
      validateCreateEventParams({
        title: "Meeting",
        end_ts: "2026-03-15T10:00:00Z",
      }),
    ).toThrow("'start_ts' is required");
  });

  it("throws when end_ts is missing", () => {
    expect(() =>
      validateCreateEventParams({
        title: "Meeting",
        start_ts: "2026-03-15T09:00:00Z",
      }),
    ).toThrow("'end_ts' is required");
  });

  it("throws when start_ts is not a valid ISO datetime", () => {
    expect(() =>
      validateCreateEventParams({
        title: "Meeting",
        start_ts: "garbage",
        end_ts: "2026-03-15T10:00:00Z",
      }),
    ).toThrow("'start_ts' is not a valid ISO 8601");
  });

  it("throws when end_ts is not a valid ISO datetime", () => {
    expect(() =>
      validateCreateEventParams({
        title: "Meeting",
        start_ts: "2026-03-15T09:00:00Z",
        end_ts: "garbage",
      }),
    ).toThrow("'end_ts' is not a valid ISO 8601");
  });

  it("throws when start_ts >= end_ts", () => {
    expect(() =>
      validateCreateEventParams({
        title: "Meeting",
        start_ts: "2026-03-15T10:00:00Z",
        end_ts: "2026-03-15T09:00:00Z",
      }),
    ).toThrow("'start_ts' must be before 'end_ts'");
  });

  it("returns validated params with defaults for optional fields", () => {
    const result = validateCreateEventParams({
      title: " Meeting ",
      start_ts: "2026-03-15T09:00:00Z",
      end_ts: "2026-03-15T10:00:00Z",
    });
    expect(result.title).toBe("Meeting"); // trimmed
    expect(result.start_ts).toBe("2026-03-15T09:00:00Z");
    expect(result.end_ts).toBe("2026-03-15T10:00:00Z");
    expect(result.timezone).toBe("UTC");
    expect(result.description).toBeNull();
    expect(result.location).toBeNull();
  });

  it("passes through optional fields when provided", () => {
    const result = validateCreateEventParams({
      title: "Meeting",
      start_ts: "2026-03-15T09:00:00Z",
      end_ts: "2026-03-15T10:00:00Z",
      timezone: "America/Chicago",
      description: "Team sync",
      location: "Room 101",
    });
    expect(result.timezone).toBe("America/Chicago");
    expect(result.description).toBe("Team sync");
    expect(result.location).toBe("Room 101");
  });
});

// ---------------------------------------------------------------------------
// validateUpdateEventParams (pure function tests)
// ---------------------------------------------------------------------------

describe("validateUpdateEventParams", () => {
  it("throws on undefined args", () => {
    expect(() => validateUpdateEventParams(undefined)).toThrow("Missing required parameters");
  });

  it("throws when event_id is missing", () => {
    expect(() =>
      validateUpdateEventParams({ patch: { title: "New" } }),
    ).toThrow("'event_id' is required");
  });

  it("throws when event_id is empty string", () => {
    expect(() =>
      validateUpdateEventParams({ event_id: "", patch: { title: "New" } }),
    ).toThrow("'event_id' is required");
  });

  it("throws when patch is missing", () => {
    expect(() =>
      validateUpdateEventParams({ event_id: "evt_123" }),
    ).toThrow("'patch' is required");
  });

  it("throws when patch is not an object", () => {
    expect(() =>
      validateUpdateEventParams({ event_id: "evt_123", patch: "not-an-object" }),
    ).toThrow("'patch' is required and must be an object");
  });

  it("throws when patch is an array", () => {
    expect(() =>
      validateUpdateEventParams({ event_id: "evt_123", patch: [] }),
    ).toThrow("'patch' is required and must be an object");
  });

  it("throws when patch is empty object", () => {
    expect(() =>
      validateUpdateEventParams({ event_id: "evt_123", patch: {} }),
    ).toThrow("at least one field to update");
  });

  it("throws when patch title is empty string", () => {
    expect(() =>
      validateUpdateEventParams({ event_id: "evt_123", patch: { title: "  " } }),
    ).toThrow("'title' must be a non-empty string");
  });

  it("throws when patch start_ts is invalid datetime", () => {
    expect(() =>
      validateUpdateEventParams({ event_id: "evt_123", patch: { start_ts: "bad" } }),
    ).toThrow("'start_ts' is not a valid ISO 8601");
  });

  it("throws when patch end_ts is invalid datetime", () => {
    expect(() =>
      validateUpdateEventParams({ event_id: "evt_123", patch: { end_ts: "bad" } }),
    ).toThrow("'end_ts' is not a valid ISO 8601");
  });

  it("throws when patch description is not a string", () => {
    expect(() =>
      validateUpdateEventParams({ event_id: "evt_123", patch: { description: 123 } }),
    ).toThrow("'description' must be a string");
  });

  it("throws when patch location is not a string", () => {
    expect(() =>
      validateUpdateEventParams({ event_id: "evt_123", patch: { location: 123 } }),
    ).toThrow("'location' must be a string");
  });

  it("returns validated params for valid title patch", () => {
    const result = validateUpdateEventParams({
      event_id: "evt_123",
      patch: { title: " Updated Title " },
    });
    expect(result.event_id).toBe("evt_123");
    expect(result.patch.title).toBe("Updated Title"); // trimmed
  });

  it("returns validated params for valid multi-field patch", () => {
    const result = validateUpdateEventParams({
      event_id: "evt_123",
      patch: {
        title: "New Title",
        start_ts: "2026-04-01T09:00:00Z",
        end_ts: "2026-04-01T10:00:00Z",
        description: "Updated description",
        location: "Room 202",
      },
    });
    expect(result.patch.title).toBe("New Title");
    expect(result.patch.start_ts).toBe("2026-04-01T09:00:00Z");
    expect(result.patch.end_ts).toBe("2026-04-01T10:00:00Z");
    expect(result.patch.description).toBe("Updated description");
    expect(result.patch.location).toBe("Room 202");
  });
});

// ---------------------------------------------------------------------------
// validateDeleteEventParams (pure function tests)
// ---------------------------------------------------------------------------

describe("validateDeleteEventParams", () => {
  it("throws on undefined args", () => {
    expect(() => validateDeleteEventParams(undefined)).toThrow("Missing required parameter");
  });

  it("throws when event_id is missing", () => {
    expect(() => validateDeleteEventParams({})).toThrow("'event_id' is required");
  });

  it("throws when event_id is empty string", () => {
    expect(() => validateDeleteEventParams({ event_id: "" })).toThrow("'event_id' is required");
  });

  it("throws when event_id is not a string", () => {
    expect(() => validateDeleteEventParams({ event_id: 123 })).toThrow("'event_id' is required");
  });

  it("returns validated params for valid event_id", () => {
    const result = validateDeleteEventParams({ event_id: "evt_123" });
    expect(result.event_id).toBe("evt_123");
  });
});

// ---------------------------------------------------------------------------
// computeHealthStatus (pure function tests)
// ---------------------------------------------------------------------------

describe("computeHealthStatus", () => {
  // Use a fixed "now" for deterministic tests
  const NOW_MS = new Date("2026-02-14T12:00:00Z").getTime();

  it("returns 'error' when account status is 'error' regardless of sync time", () => {
    // Even if last sync was 1 second ago, error status takes priority
    const recentSync = new Date(NOW_MS - 1000).toISOString();
    expect(computeHealthStatus("error", recentSync, NOW_MS)).toBe("error");
  });

  it("returns 'error' for error status even with null last_sync_ts", () => {
    expect(computeHealthStatus("error", null, NOW_MS)).toBe("error");
  });

  it("returns 'unhealthy' when last_sync_ts is null", () => {
    expect(computeHealthStatus("active", null, NOW_MS)).toBe("unhealthy");
  });

  it("returns 'unhealthy' when last_sync_ts is an invalid date string", () => {
    expect(computeHealthStatus("active", "not-a-date", NOW_MS)).toBe("unhealthy");
  });

  it("returns 'healthy' when synced within 1 hour", () => {
    // 30 minutes ago
    const ts = new Date(NOW_MS - 30 * 60 * 1000).toISOString();
    expect(computeHealthStatus("active", ts, NOW_MS)).toBe("healthy");
  });

  it("returns 'healthy' at exactly 1 hour boundary", () => {
    const ts = new Date(NOW_MS - 60 * 60 * 1000).toISOString();
    expect(computeHealthStatus("active", ts, NOW_MS)).toBe("healthy");
  });

  it("returns 'degraded' when synced between 1 and 6 hours ago", () => {
    // 3 hours ago
    const ts = new Date(NOW_MS - 3 * 60 * 60 * 1000).toISOString();
    expect(computeHealthStatus("active", ts, NOW_MS)).toBe("degraded");
  });

  it("returns 'degraded' at exactly 6 hour boundary", () => {
    const ts = new Date(NOW_MS - 6 * 60 * 60 * 1000).toISOString();
    expect(computeHealthStatus("active", ts, NOW_MS)).toBe("degraded");
  });

  it("returns 'stale' when synced between 6 and 24 hours ago", () => {
    // 12 hours ago
    const ts = new Date(NOW_MS - 12 * 60 * 60 * 1000).toISOString();
    expect(computeHealthStatus("active", ts, NOW_MS)).toBe("stale");
  });

  it("returns 'stale' at exactly 24 hour boundary", () => {
    const ts = new Date(NOW_MS - 24 * 60 * 60 * 1000).toISOString();
    expect(computeHealthStatus("active", ts, NOW_MS)).toBe("stale");
  });

  it("returns 'unhealthy' when synced more than 24 hours ago", () => {
    // 48 hours ago
    const ts = new Date(NOW_MS - 48 * 60 * 60 * 1000).toISOString();
    expect(computeHealthStatus("active", ts, NOW_MS)).toBe("unhealthy");
  });

  it("returns 'healthy' when sync was just now (0ms ago)", () => {
    const ts = new Date(NOW_MS).toISOString();
    expect(computeHealthStatus("active", ts, NOW_MS)).toBe("healthy");
  });
});

// ---------------------------------------------------------------------------
// computeOverallHealth (pure function tests)
// ---------------------------------------------------------------------------

describe("computeOverallHealth", () => {
  it("returns 'healthy' for empty array", () => {
    expect(computeOverallHealth([])).toBe("healthy");
  });

  it("returns 'healthy' when all are healthy", () => {
    expect(computeOverallHealth(["healthy", "healthy"])).toBe("healthy");
  });

  it("returns worst status: error beats everything", () => {
    expect(computeOverallHealth(["healthy", "error", "degraded"])).toBe("error");
  });

  it("returns worst status: unhealthy beats degraded and stale", () => {
    expect(computeOverallHealth(["healthy", "unhealthy", "degraded"])).toBe("unhealthy");
  });

  it("returns worst status: stale beats degraded", () => {
    expect(computeOverallHealth(["healthy", "stale", "degraded"])).toBe("stale");
  });

  it("returns worst status: degraded beats healthy", () => {
    expect(computeOverallHealth(["healthy", "degraded"])).toBe("degraded");
  });

  it("returns single status for single-element array", () => {
    expect(computeOverallHealth(["stale"])).toBe("stale");
  });
});

// ---------------------------------------------------------------------------
// computeChannelStatus (pure function tests)
// ---------------------------------------------------------------------------

describe("computeChannelStatus", () => {
  const NOW_MS = new Date("2026-02-14T12:00:00Z").getTime();

  it("returns 'none' when channel_id is null", () => {
    expect(computeChannelStatus(null, null, NOW_MS)).toBe("none");
  });

  it("returns 'active' when channel exists and expiry is in the future", () => {
    const futureExpiry = new Date(NOW_MS + 60 * 60 * 1000).toISOString(); // 1 hour from now
    expect(computeChannelStatus("ch_123", futureExpiry, NOW_MS)).toBe("active");
  });

  it("returns 'expired' when channel exists and expiry is in the past", () => {
    const pastExpiry = new Date(NOW_MS - 60 * 60 * 1000).toISOString(); // 1 hour ago
    expect(computeChannelStatus("ch_123", pastExpiry, NOW_MS)).toBe("expired");
  });

  it("returns 'active' when channel exists but no expiry timestamp", () => {
    expect(computeChannelStatus("ch_123", null, NOW_MS)).toBe("active");
  });

  it("returns 'active' when channel exists and expiry is invalid date", () => {
    expect(computeChannelStatus("ch_123", "not-a-date", NOW_MS)).toBe("active");
  });
});

// ---------------------------------------------------------------------------
// validateGetAvailabilityParams (pure function tests)
// ---------------------------------------------------------------------------

describe("validateGetAvailabilityParams", () => {
  it("throws on undefined args", () => {
    expect(() => validateGetAvailabilityParams(undefined)).toThrow(
      "Missing required parameters",
    );
  });

  it("throws when start is missing", () => {
    expect(() =>
      validateGetAvailabilityParams({ end: "2026-03-15T17:00:00Z" }),
    ).toThrow("'start' is required");
  });

  it("throws when end is missing", () => {
    expect(() =>
      validateGetAvailabilityParams({ start: "2026-03-15T09:00:00Z" }),
    ).toThrow("'end' is required");
  });

  it("throws when start is not a valid ISO datetime", () => {
    expect(() =>
      validateGetAvailabilityParams({
        start: "not-a-date",
        end: "2026-03-15T17:00:00Z",
      }),
    ).toThrow("'start' is not a valid ISO 8601");
  });

  it("throws when end is not a valid ISO datetime", () => {
    expect(() =>
      validateGetAvailabilityParams({
        start: "2026-03-15T09:00:00Z",
        end: "not-a-date",
      }),
    ).toThrow("'end' is not a valid ISO 8601");
  });

  it("throws when start >= end", () => {
    expect(() =>
      validateGetAvailabilityParams({
        start: "2026-03-15T17:00:00Z",
        end: "2026-03-15T09:00:00Z",
      }),
    ).toThrow("'start' must be before 'end'");
  });

  it("throws when start equals end", () => {
    expect(() =>
      validateGetAvailabilityParams({
        start: "2026-03-15T09:00:00Z",
        end: "2026-03-15T09:00:00Z",
      }),
    ).toThrow("'start' must be before 'end'");
  });

  it("throws for invalid granularity value", () => {
    expect(() =>
      validateGetAvailabilityParams({
        start: "2026-03-15T09:00:00Z",
        end: "2026-03-15T17:00:00Z",
        granularity: "45m",
      }),
    ).toThrow("'granularity' must be one of");
  });

  it("throws for non-string granularity", () => {
    expect(() =>
      validateGetAvailabilityParams({
        start: "2026-03-15T09:00:00Z",
        end: "2026-03-15T17:00:00Z",
        granularity: 30,
      }),
    ).toThrow("'granularity' must be one of");
  });

  it("throws when time range exceeds 7 days", () => {
    expect(() =>
      validateGetAvailabilityParams({
        start: "2026-03-01T00:00:00Z",
        end: "2026-03-15T00:00:00Z",
      }),
    ).toThrow("must not exceed 7 days");
  });

  it("throws when accounts is not an array", () => {
    expect(() =>
      validateGetAvailabilityParams({
        start: "2026-03-15T09:00:00Z",
        end: "2026-03-15T17:00:00Z",
        accounts: "acc_123",
      }),
    ).toThrow("'accounts' must be an array");
  });

  it("throws when accounts contains non-string elements", () => {
    expect(() =>
      validateGetAvailabilityParams({
        start: "2026-03-15T09:00:00Z",
        end: "2026-03-15T17:00:00Z",
        accounts: [123],
      }),
    ).toThrow("'accounts' must be a non-empty string");
  });

  it("throws when accounts contains empty strings", () => {
    expect(() =>
      validateGetAvailabilityParams({
        start: "2026-03-15T09:00:00Z",
        end: "2026-03-15T17:00:00Z",
        accounts: [""],
      }),
    ).toThrow("'accounts' must be a non-empty string");
  });

  it("returns validated params with defaults", () => {
    const result = validateGetAvailabilityParams({
      start: "2026-03-15T09:00:00Z",
      end: "2026-03-15T17:00:00Z",
    });
    expect(result.start).toBe("2026-03-15T09:00:00Z");
    expect(result.end).toBe("2026-03-15T17:00:00Z");
    expect(result.granularity).toBe("30m");
    expect(result.accounts).toBeNull();
  });

  it("accepts 15m granularity", () => {
    const result = validateGetAvailabilityParams({
      start: "2026-03-15T09:00:00Z",
      end: "2026-03-15T17:00:00Z",
      granularity: "15m",
    });
    expect(result.granularity).toBe("15m");
  });

  it("accepts 1h granularity", () => {
    const result = validateGetAvailabilityParams({
      start: "2026-03-15T09:00:00Z",
      end: "2026-03-15T17:00:00Z",
      granularity: "1h",
    });
    expect(result.granularity).toBe("1h");
  });

  it("passes through accounts filter", () => {
    const result = validateGetAvailabilityParams({
      start: "2026-03-15T09:00:00Z",
      end: "2026-03-15T17:00:00Z",
      accounts: ["acc_123", "acc_456"],
    });
    expect(result.accounts).toEqual(["acc_123", "acc_456"]);
  });

  it("treats empty accounts array as null (no filter)", () => {
    const result = validateGetAvailabilityParams({
      start: "2026-03-15T09:00:00Z",
      end: "2026-03-15T17:00:00Z",
      accounts: [],
    });
    expect(result.accounts).toBeNull();
  });

  it("accepts exactly 7-day range", () => {
    const result = validateGetAvailabilityParams({
      start: "2026-03-01T00:00:00Z",
      end: "2026-03-08T00:00:00Z",
    });
    expect(result.start).toBe("2026-03-01T00:00:00Z");
    expect(result.end).toBe("2026-03-08T00:00:00Z");
  });
});

// ---------------------------------------------------------------------------
// generateTimeSlots (pure function tests)
// ---------------------------------------------------------------------------

describe("generateTimeSlots", () => {
  const HOUR_MS = 60 * 60 * 1000;
  const HALF_HOUR_MS = 30 * 60 * 1000;
  const QUARTER_HOUR_MS = 15 * 60 * 1000;

  it("generates correct number of 30m slots for 2-hour range", () => {
    const start = new Date("2026-03-15T09:00:00Z").getTime();
    const end = new Date("2026-03-15T11:00:00Z").getTime();
    const slots = generateTimeSlots(start, end, HALF_HOUR_MS);
    expect(slots.length).toBe(4); // 2 hours / 30 min = 4 slots
  });

  it("generates correct number of 15m slots for 1-hour range", () => {
    const start = new Date("2026-03-15T09:00:00Z").getTime();
    const end = new Date("2026-03-15T10:00:00Z").getTime();
    const slots = generateTimeSlots(start, end, QUARTER_HOUR_MS);
    expect(slots.length).toBe(4); // 1 hour / 15 min = 4 slots
  });

  it("generates correct number of 1h slots for 8-hour range", () => {
    const start = new Date("2026-03-15T09:00:00Z").getTime();
    const end = new Date("2026-03-15T17:00:00Z").getTime();
    const slots = generateTimeSlots(start, end, HOUR_MS);
    expect(slots.length).toBe(8); // 8 hours / 1 hour = 8 slots
  });

  it("generates consecutive non-overlapping slots", () => {
    const start = new Date("2026-03-15T09:00:00Z").getTime();
    const end = new Date("2026-03-15T11:00:00Z").getTime();
    const slots = generateTimeSlots(start, end, HALF_HOUR_MS);

    for (let i = 0; i < slots.length - 1; i++) {
      expect(slots[i].endMs).toBe(slots[i + 1].startMs);
    }
  });

  it("first slot starts at range start and last slot ends at range end", () => {
    const start = new Date("2026-03-15T09:00:00Z").getTime();
    const end = new Date("2026-03-15T11:00:00Z").getTime();
    const slots = generateTimeSlots(start, end, HALF_HOUR_MS);

    expect(slots[0].startMs).toBe(start);
    expect(slots[slots.length - 1].endMs).toBe(end);
  });

  it("handles range that is not evenly divisible by granularity", () => {
    const start = new Date("2026-03-15T09:00:00Z").getTime();
    const end = new Date("2026-03-15T09:45:00Z").getTime(); // 45 min, not divisible by 30m
    const slots = generateTimeSlots(start, end, HALF_HOUR_MS);

    expect(slots.length).toBe(2);
    // First slot: 09:00 - 09:30
    expect(slots[0].startMs).toBe(start);
    expect(slots[0].endMs).toBe(start + HALF_HOUR_MS);
    // Second slot: 09:30 - 09:45 (truncated to range end)
    expect(slots[1].startMs).toBe(start + HALF_HOUR_MS);
    expect(slots[1].endMs).toBe(end);
  });

  it("returns empty array for zero-length range", () => {
    const t = new Date("2026-03-15T09:00:00Z").getTime();
    const slots = generateTimeSlots(t, t, HALF_HOUR_MS);
    expect(slots.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computeAvailabilitySlots (pure function tests)
// ---------------------------------------------------------------------------

describe("computeAvailabilitySlots", () => {
  const HOUR_MS = 60 * 60 * 1000;
  const HALF_HOUR_MS = 30 * 60 * 1000;

  // Helper to create time slots for a 2-hour window (9:00 - 11:00) at 30m granularity
  function makeSlots(): Array<{ startMs: number; endMs: number }> {
    const start = new Date("2026-03-15T09:00:00Z").getTime();
    const end = new Date("2026-03-15T11:00:00Z").getTime();
    return generateTimeSlots(start, end, HALF_HOUR_MS);
  }

  it("marks all slots as free when no events exist", () => {
    const slots = makeSlots();
    const result = computeAvailabilitySlots(slots, []);

    expect(result.length).toBe(4);
    for (const slot of result) {
      expect(slot.status).toBe("free");
      expect(slot.conflicting_events).toBeUndefined();
    }
  });

  it("marks overlapping slots as busy for confirmed events", () => {
    const slots = makeSlots();
    const events = [
      {
        start_ts: "2026-03-15T09:00:00Z",
        end_ts: "2026-03-15T10:00:00Z",
        status: "confirmed",
        account_id: "acc_1",
      },
    ];

    const result = computeAvailabilitySlots(slots, events);

    // Slots 09:00-09:30 and 09:30-10:00 should be busy
    expect(result[0].status).toBe("busy");
    expect(result[0].conflicting_events).toBe(1);
    expect(result[1].status).toBe("busy");
    expect(result[1].conflicting_events).toBe(1);
    // Slots 10:00-10:30 and 10:30-11:00 should be free
    expect(result[2].status).toBe("free");
    expect(result[3].status).toBe("free");
  });

  it("marks overlapping slots as tentative for tentative-only events", () => {
    const slots = makeSlots();
    const events = [
      {
        start_ts: "2026-03-15T09:30:00Z",
        end_ts: "2026-03-15T10:30:00Z",
        status: "tentative",
        account_id: "acc_1",
      },
    ];

    const result = computeAvailabilitySlots(slots, events);

    expect(result[0].status).toBe("free"); // 09:00-09:30
    expect(result[1].status).toBe("tentative"); // 09:30-10:00
    expect(result[1].conflicting_events).toBe(1);
    expect(result[2].status).toBe("tentative"); // 10:00-10:30
    expect(result[2].conflicting_events).toBe(1);
    expect(result[3].status).toBe("free"); // 10:30-11:00
  });

  it("confirmed event overrides tentative in same slot", () => {
    const slots = makeSlots();
    const events = [
      {
        start_ts: "2026-03-15T09:00:00Z",
        end_ts: "2026-03-15T09:30:00Z",
        status: "tentative",
        account_id: "acc_1",
      },
      {
        start_ts: "2026-03-15T09:00:00Z",
        end_ts: "2026-03-15T09:30:00Z",
        status: "confirmed",
        account_id: "acc_2",
      },
    ];

    const result = computeAvailabilitySlots(slots, events);

    expect(result[0].status).toBe("busy"); // confirmed wins
    expect(result[0].conflicting_events).toBe(2);
  });

  it("ignores cancelled events", () => {
    const slots = makeSlots();
    const events = [
      {
        start_ts: "2026-03-15T09:00:00Z",
        end_ts: "2026-03-15T11:00:00Z",
        status: "cancelled",
        account_id: "acc_1",
      },
    ];

    const result = computeAvailabilitySlots(slots, events);

    for (const slot of result) {
      expect(slot.status).toBe("free");
      expect(slot.conflicting_events).toBeUndefined();
    }
  });

  it("counts multiple conflicting events in the same slot", () => {
    const slots = makeSlots();
    const events = [
      {
        start_ts: "2026-03-15T09:00:00Z",
        end_ts: "2026-03-15T10:00:00Z",
        status: "confirmed",
        account_id: "acc_1",
      },
      {
        start_ts: "2026-03-15T09:15:00Z",
        end_ts: "2026-03-15T09:45:00Z",
        status: "confirmed",
        account_id: "acc_2",
      },
    ];

    const result = computeAvailabilitySlots(slots, events);

    // 09:00-09:30 overlaps both events
    expect(result[0].status).toBe("busy");
    expect(result[0].conflicting_events).toBe(2);
    // 09:30-10:00 overlaps both events: event 1 spans to 10:00, event 2 ends at 09:45 (> 09:30)
    expect(result[1].status).toBe("busy");
    expect(result[1].conflicting_events).toBe(2);
  });

  it("merges availability across multiple accounts (any busy = busy)", () => {
    const slots = makeSlots();
    const events = [
      {
        start_ts: "2026-03-15T09:00:00Z",
        end_ts: "2026-03-15T09:30:00Z",
        status: "confirmed",
        account_id: "acc_1",
      },
      {
        start_ts: "2026-03-15T10:00:00Z",
        end_ts: "2026-03-15T10:30:00Z",
        status: "confirmed",
        account_id: "acc_2",
      },
    ];

    const result = computeAvailabilitySlots(slots, events);

    expect(result[0].status).toBe("busy"); // acc_1 busy
    expect(result[1].status).toBe("free"); // both free
    expect(result[2].status).toBe("busy"); // acc_2 busy
    expect(result[3].status).toBe("free"); // both free
  });

  it("returns correct ISO 8601 timestamps in slots", () => {
    const slots = makeSlots();
    const result = computeAvailabilitySlots(slots, []);

    expect(result[0].start).toBe("2026-03-15T09:00:00.000Z");
    expect(result[0].end).toBe("2026-03-15T09:30:00.000Z");
    expect(result[3].start).toBe("2026-03-15T10:30:00.000Z");
    expect(result[3].end).toBe("2026-03-15T11:00:00.000Z");
  });

  it("handles event that partially overlaps a slot boundary", () => {
    const slots = makeSlots();
    // Event starts at 09:15, ends at 09:45 -- overlaps first two slots
    const events = [
      {
        start_ts: "2026-03-15T09:15:00Z",
        end_ts: "2026-03-15T09:45:00Z",
        status: "confirmed",
        account_id: "acc_1",
      },
    ];

    const result = computeAvailabilitySlots(slots, events);

    expect(result[0].status).toBe("busy"); // 09:00-09:30 overlaps
    expect(result[0].conflicting_events).toBe(1);
    expect(result[1].status).toBe("busy"); // 09:30-10:00 overlaps (event ends at 09:45)
    expect(result[1].conflicting_events).toBe(1);
    expect(result[2].status).toBe("free"); // 10:00-10:30 no overlap
    expect(result[3].status).toBe("free"); // 10:30-11:00 no overlap
  });

  it("event that exactly matches slot boundaries", () => {
    const slots = makeSlots();
    const events = [
      {
        start_ts: "2026-03-15T09:30:00Z",
        end_ts: "2026-03-15T10:00:00Z",
        status: "confirmed",
        account_id: "acc_1",
      },
    ];

    const result = computeAvailabilitySlots(slots, events);

    expect(result[0].status).toBe("free"); // 09:00-09:30 -- event starts at boundary, no overlap
    expect(result[1].status).toBe("busy"); // 09:30-10:00 -- exact match
    expect(result[1].conflicting_events).toBe(1);
    expect(result[2].status).toBe("free"); // 10:00-10:30 -- event ends at boundary, no overlap
    expect(result[3].status).toBe("free");
  });
});

// ---------------------------------------------------------------------------
// tools/list includes availability tool
// ---------------------------------------------------------------------------

describe("POST /mcp -- tools/list includes availability tool", () => {
  it("includes calendar.get_availability with required start and end fields", async () => {
    const handler = createMcpHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    const result = await sendMcpRequest(
      handler,
      env,
      { jsonrpc: "2.0", method: "tools/list", id: 1 },
      authHeader,
    );

    expect(result.status).toBe(200);
    const resultData = result.body.result as { tools: Array<Record<string, unknown>> };
    const availabilityTool = resultData.tools.find(
      (t) => t.name === "calendar.get_availability",
    );
    expect(availabilityTool).toBeDefined();
    expect(availabilityTool?.description).toContain("free/busy");

    const schema = availabilityTool?.inputSchema as {
      type: string;
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(schema.type).toBe("object");
    expect(schema.required).toContain("start");
    expect(schema.required).toContain("end");
    expect(schema.properties).toHaveProperty("start");
    expect(schema.properties).toHaveProperty("end");
    expect(schema.properties).toHaveProperty("accounts");
    expect(schema.properties).toHaveProperty("granularity");
  });
});

// ---------------------------------------------------------------------------
// validateGetPolicyEdgeParams (pure function tests)
// ---------------------------------------------------------------------------

describe("validateGetPolicyEdgeParams", () => {
  it("throws on undefined args", () => {
    expect(() => validateGetPolicyEdgeParams(undefined)).toThrow(
      "Missing required parameters",
    );
  });

  it("throws when neither policy_id nor from/to_account provided", () => {
    expect(() => validateGetPolicyEdgeParams({})).toThrow(
      "Provide either 'policy_id' or both 'from_account' and 'to_account'",
    );
  });

  it("throws when only from_account provided (missing to_account)", () => {
    expect(() =>
      validateGetPolicyEdgeParams({ from_account: "acc_aaa" }),
    ).toThrow("Provide either 'policy_id' or both");
  });

  it("throws when only to_account provided (missing from_account)", () => {
    expect(() =>
      validateGetPolicyEdgeParams({ to_account: "acc_bbb" }),
    ).toThrow("Provide either 'policy_id' or both");
  });

  it("returns policy_id when provided", () => {
    const result = validateGetPolicyEdgeParams({ policy_id: "pol_123" });
    expect(result.policy_id).toBe("pol_123");
    expect(result.from_account).toBeNull();
    expect(result.to_account).toBeNull();
  });

  it("returns from/to_account when both provided", () => {
    const result = validateGetPolicyEdgeParams({
      from_account: "acc_aaa",
      to_account: "acc_bbb",
    });
    expect(result.policy_id).toBeNull();
    expect(result.from_account).toBe("acc_aaa");
    expect(result.to_account).toBe("acc_bbb");
  });

  it("prefers policy_id over from/to_account when all provided", () => {
    const result = validateGetPolicyEdgeParams({
      policy_id: "pol_123",
      from_account: "acc_aaa",
      to_account: "acc_bbb",
    });
    // When policy_id is provided, it takes precedence
    expect(result.policy_id).toBe("pol_123");
  });

  it("treats empty string policy_id as missing", () => {
    expect(() =>
      validateGetPolicyEdgeParams({ policy_id: "" }),
    ).toThrow("Provide either 'policy_id' or both");
  });
});

// ---------------------------------------------------------------------------
// validateSetPolicyEdgeParams (pure function tests)
// ---------------------------------------------------------------------------

describe("validateSetPolicyEdgeParams", () => {
  it("throws on undefined args", () => {
    expect(() => validateSetPolicyEdgeParams(undefined)).toThrow(
      "Missing required parameters",
    );
  });

  it("throws when from_account is missing", () => {
    expect(() =>
      validateSetPolicyEdgeParams({
        to_account: "acc_bbb",
        detail_level: "BUSY",
      }),
    ).toThrow("'from_account' is required");
  });

  it("throws when to_account is missing", () => {
    expect(() =>
      validateSetPolicyEdgeParams({
        from_account: "acc_aaa",
        detail_level: "BUSY",
      }),
    ).toThrow("'to_account' is required");
  });

  it("throws when from_account equals to_account", () => {
    expect(() =>
      validateSetPolicyEdgeParams({
        from_account: "acc_aaa",
        to_account: "acc_aaa",
        detail_level: "BUSY",
      }),
    ).toThrow("must be different accounts");
  });

  it("throws when detail_level is missing", () => {
    expect(() =>
      validateSetPolicyEdgeParams({
        from_account: "acc_aaa",
        to_account: "acc_bbb",
      }),
    ).toThrow("'detail_level' must be one of: BUSY, TITLE, FULL");
  });

  it("throws when detail_level is invalid", () => {
    expect(() =>
      validateSetPolicyEdgeParams({
        from_account: "acc_aaa",
        to_account: "acc_bbb",
        detail_level: "PARTIAL",
      }),
    ).toThrow("'detail_level' must be one of: BUSY, TITLE, FULL");
  });

  it("throws when detail_level is not a string", () => {
    expect(() =>
      validateSetPolicyEdgeParams({
        from_account: "acc_aaa",
        to_account: "acc_bbb",
        detail_level: 1,
      }),
    ).toThrow("'detail_level' must be one of: BUSY, TITLE, FULL");
  });

  it("throws when calendar_kind is invalid", () => {
    expect(() =>
      validateSetPolicyEdgeParams({
        from_account: "acc_aaa",
        to_account: "acc_bbb",
        detail_level: "BUSY",
        calendar_kind: "SHARED_CALENDAR",
      }),
    ).toThrow("'calendar_kind' must be one of: BUSY_OVERLAY, TRUE_MIRROR");
  });

  it("accepts BUSY detail_level", () => {
    const result = validateSetPolicyEdgeParams({
      from_account: "acc_aaa",
      to_account: "acc_bbb",
      detail_level: "BUSY",
    });
    expect(result.detail_level).toBe("BUSY");
  });

  it("accepts TITLE detail_level", () => {
    const result = validateSetPolicyEdgeParams({
      from_account: "acc_aaa",
      to_account: "acc_bbb",
      detail_level: "TITLE",
    });
    expect(result.detail_level).toBe("TITLE");
  });

  it("accepts FULL detail_level", () => {
    const result = validateSetPolicyEdgeParams({
      from_account: "acc_aaa",
      to_account: "acc_bbb",
      detail_level: "FULL",
    });
    expect(result.detail_level).toBe("FULL");
  });

  it("defaults calendar_kind to BUSY_OVERLAY when not provided (BR-11)", () => {
    const result = validateSetPolicyEdgeParams({
      from_account: "acc_aaa",
      to_account: "acc_bbb",
      detail_level: "BUSY",
    });
    expect(result.calendar_kind).toBe("BUSY_OVERLAY");
  });

  it("accepts BUSY_OVERLAY calendar_kind", () => {
    const result = validateSetPolicyEdgeParams({
      from_account: "acc_aaa",
      to_account: "acc_bbb",
      detail_level: "BUSY",
      calendar_kind: "BUSY_OVERLAY",
    });
    expect(result.calendar_kind).toBe("BUSY_OVERLAY");
  });

  it("accepts TRUE_MIRROR calendar_kind", () => {
    const result = validateSetPolicyEdgeParams({
      from_account: "acc_aaa",
      to_account: "acc_bbb",
      detail_level: "FULL",
      calendar_kind: "TRUE_MIRROR",
    });
    expect(result.calendar_kind).toBe("TRUE_MIRROR");
  });

  it("returns all validated params for complete input", () => {
    const result = validateSetPolicyEdgeParams({
      from_account: "acc_aaa",
      to_account: "acc_bbb",
      detail_level: "TITLE",
      calendar_kind: "TRUE_MIRROR",
    });
    expect(result.from_account).toBe("acc_aaa");
    expect(result.to_account).toBe("acc_bbb");
    expect(result.detail_level).toBe("TITLE");
    expect(result.calendar_kind).toBe("TRUE_MIRROR");
  });
});

// ---------------------------------------------------------------------------
// tools/list includes policy management tools
// ---------------------------------------------------------------------------

describe("POST /mcp -- tools/list includes policy management tools", () => {
  it("includes all 3 policy management tools in registry", async () => {
    const handler = createMcpHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    const result = await sendMcpRequest(
      handler,
      env,
      { jsonrpc: "2.0", method: "tools/list", id: 1 },
      authHeader,
    );

    expect(result.status).toBe(200);
    const resultData = result.body.result as { tools: Array<Record<string, unknown>> };

    const toolNames = resultData.tools.map((t) => t.name);
    expect(toolNames).toContain("calendar.list_policies");
    expect(toolNames).toContain("calendar.get_policy_edge");
    expect(toolNames).toContain("calendar.set_policy_edge");
  });

  it("calendar.set_policy_edge schema has required from_account, to_account, detail_level fields", async () => {
    const handler = createMcpHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    const result = await sendMcpRequest(
      handler,
      env,
      { jsonrpc: "2.0", method: "tools/list", id: 1 },
      authHeader,
    );

    const resultData = result.body.result as { tools: Array<Record<string, unknown>> };
    const setPolicyTool = resultData.tools.find(
      (t) => t.name === "calendar.set_policy_edge",
    );
    expect(setPolicyTool).toBeDefined();

    const schema = setPolicyTool?.inputSchema as { required?: string[] };
    expect(schema.required).toContain("from_account");
    expect(schema.required).toContain("to_account");
    expect(schema.required).toContain("detail_level");
  });

  it("calendar.set_policy_edge schema describes detail_level enum", async () => {
    const handler = createMcpHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    const result = await sendMcpRequest(
      handler,
      env,
      { jsonrpc: "2.0", method: "tools/list", id: 1 },
      authHeader,
    );

    const resultData = result.body.result as { tools: Array<Record<string, unknown>> };
    const setPolicyTool = resultData.tools.find(
      (t) => t.name === "calendar.set_policy_edge",
    );

    const schema = setPolicyTool?.inputSchema as {
      properties: Record<string, { enum?: string[] }>;
    };
    expect(schema.properties.detail_level.enum).toEqual(["BUSY", "TITLE", "FULL"]);
    expect(schema.properties.calendar_kind.enum).toEqual(["BUSY_OVERLAY", "TRUE_MIRROR"]);
  });
});

// ---------------------------------------------------------------------------
// Tier-based tool permissions (checkTierAccess)
// ---------------------------------------------------------------------------

describe("checkTierAccess", () => {
  // -- Free tier: read-only tools are allowed --
  const FREE_TOOLS = [
    "calendar.list_accounts",
    "calendar.get_sync_status",
    "calendar.list_events",
    "calendar.get_availability",
    "calendar.list_policies",
    "calendar.get_policy_edge",
  ];

  for (const tool of FREE_TOOLS) {
    it(`allows free tier to access ${tool}`, () => {
      const result = checkTierAccess(tool, "free");
      expect(result.allowed).toBe(true);
    });
  }

  // -- Premium tier: write tools require premium --
  const PREMIUM_TOOLS = [
    "calendar.create_event",
    "calendar.update_event",
    "calendar.delete_event",
    "calendar.set_policy_edge",
  ];

  for (const tool of PREMIUM_TOOLS) {
    it(`denies free tier access to ${tool}`, () => {
      const result = checkTierAccess(tool, "free");
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.required_tier).toBe("premium");
        expect(result.current_tier).toBe("free");
        expect(result.tool).toBe(tool);
      }
    });

    it(`allows premium tier to access ${tool}`, () => {
      const result = checkTierAccess(tool, "premium");
      expect(result.allowed).toBe(true);
    });

    it(`allows enterprise tier to access ${tool}`, () => {
      const result = checkTierAccess(tool, "enterprise");
      expect(result.allowed).toBe(true);
    });
  }

  // -- Tier hierarchy: premium and enterprise can access all free tools --
  for (const tool of FREE_TOOLS) {
    it(`allows premium tier to access free tool ${tool}`, () => {
      const result = checkTierAccess(tool, "premium");
      expect(result.allowed).toBe(true);
    });

    it(`allows enterprise tier to access free tool ${tool}`, () => {
      const result = checkTierAccess(tool, "enterprise");
      expect(result.allowed).toBe(true);
    });
  }

  it("maps every registered tool to a tier", () => {
    const allTools = [...FREE_TOOLS, ...PREMIUM_TOOLS];
    for (const tool of allTools) {
      const result = checkTierAccess(tool, "enterprise");
      expect(result.allowed).toBe(true);
    }
  });

  it("treats unknown tool name as free tier", () => {
    const result = checkTierAccess("calendar.unknown_tool", "free");
    expect(result.allowed).toBe(true);
  });

  it("treats unknown user tier as level 0 (no access to premium)", () => {
    const result = checkTierAccess("calendar.create_event", "bogus_tier");
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.required_tier).toBe("premium");
      expect(result.current_tier).toBe("bogus_tier");
    }
  });

  it("returns structured error data matching TIER_REQUIRED format", () => {
    const result = checkTierAccess("calendar.create_event", "free");
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result).toEqual({
        allowed: false,
        required_tier: "premium",
        current_tier: "free",
        tool: "calendar.create_event",
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Tier gating in dispatch: free user calling premium tool -> TIER_REQUIRED
// ---------------------------------------------------------------------------

describe("tier gating in MCP dispatch", () => {
  it("free user calling a premium tool returns TIER_REQUIRED error", async () => {
    const handler = createMcpHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    const result = await sendMcpRequest(
      handler,
      env,
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "calendar.create_event", arguments: {} },
        id: 42,
      },
      authHeader,
    );

    expect(result.status).toBe(200);
    const error = result.body.error as {
      code: number;
      message: string;
      data: { code: string; required_tier: string; current_tier: string; tool: string };
    };
    expect(error).toBeDefined();
    expect(error.code).toBe(-32603);
    expect(error.message).toContain("requires a premium subscription");
    expect(error.data.code).toBe("TIER_REQUIRED");
    expect(error.data.required_tier).toBe("premium");
    expect(error.data.current_tier).toBe("free");
    expect(error.data.tool).toBe("calendar.create_event");
  });

  it("free user calling a free tool is NOT tier-gated", async () => {
    const handler = createMcpHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    const result = await sendMcpRequest(
      handler,
      env,
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "calendar.list_accounts", arguments: {} },
        id: 43,
      },
      authHeader,
    );

    if (result.body.error) {
      const error = result.body.error as { code: number; data?: { code?: string } };
      expect(error.data?.code).not.toBe("TIER_REQUIRED");
    }
  });

  it("tier check happens before tool execution (fail fast)", async () => {
    const handler = createMcpHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    const result = await sendMcpRequest(
      handler,
      env,
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "calendar.delete_event", arguments: {} },
        id: 44,
      },
      authHeader,
    );

    const error = result.body.error as { code: number; data?: { code?: string } };
    expect(error).toBeDefined();
    expect(error.code).toBe(-32603);
    expect(error.data?.code).toBe("TIER_REQUIRED");
  });

  it("TIER_REQUIRED error for each premium tool from free user", async () => {
    const handler = createMcpHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    const premiumTools = [
      "calendar.create_event",
      "calendar.update_event",
      "calendar.delete_event",
      "calendar.set_policy_edge",
      "calendar.add_trip",
      "calendar.add_constraint",
    ];

    for (const toolName of premiumTools) {
      const result = await sendMcpRequest(
        handler,
        env,
        {
          jsonrpc: "2.0",
          method: "tools/call",
          params: { name: toolName, arguments: {} },
          id: Math.random(),
        },
        authHeader,
      );

      const error = result.body.error as {
        code: number;
        message: string;
        data: { code: string; required_tier: string; current_tier: string; tool: string };
      };
      expect(error).toBeDefined();
      expect(error.code).toBe(-32603);
      expect(error.message).toContain("requires a premium subscription");
      expect(error.data.code).toBe("TIER_REQUIRED");
      expect(error.data.required_tier).toBe("premium");
      expect(error.data.current_tier).toBe("free");
      expect(error.data.tool).toBe(toolName);
    }
  });
});

// ---------------------------------------------------------------------------
// validateAddTripParams (pure function tests)
// ---------------------------------------------------------------------------

describe("validateAddTripParams", () => {
  it("throws on undefined args", () => {
    expect(() => validateAddTripParams(undefined)).toThrow(
      "Missing required parameters",
    );
  });

  it("throws when name is missing", () => {
    expect(() =>
      validateAddTripParams({
        start: "2026-03-15T00:00:00Z",
        end: "2026-03-20T00:00:00Z",
        timezone: "America/New_York",
      }),
    ).toThrow("'name' is required");
  });

  it("throws when name is empty string", () => {
    expect(() =>
      validateAddTripParams({
        name: "   ",
        start: "2026-03-15T00:00:00Z",
        end: "2026-03-20T00:00:00Z",
        timezone: "America/New_York",
      }),
    ).toThrow("'name' is required");
  });

  it("throws when start is missing", () => {
    expect(() =>
      validateAddTripParams({
        name: "NYC Trip",
        end: "2026-03-20T00:00:00Z",
        timezone: "America/New_York",
      }),
    ).toThrow("'start' is required");
  });

  it("throws when start is not a valid ISO datetime", () => {
    expect(() =>
      validateAddTripParams({
        name: "NYC Trip",
        start: "not-a-date",
        end: "2026-03-20T00:00:00Z",
        timezone: "America/New_York",
      }),
    ).toThrow("'start' is not a valid ISO 8601");
  });

  it("throws when end is missing", () => {
    expect(() =>
      validateAddTripParams({
        name: "NYC Trip",
        start: "2026-03-15T00:00:00Z",
        timezone: "America/New_York",
      }),
    ).toThrow("'end' is required");
  });

  it("throws when end is not a valid ISO datetime", () => {
    expect(() =>
      validateAddTripParams({
        name: "NYC Trip",
        start: "2026-03-15T00:00:00Z",
        end: "garbage",
        timezone: "America/New_York",
      }),
    ).toThrow("'end' is not a valid ISO 8601");
  });

  it("throws when start >= end", () => {
    expect(() =>
      validateAddTripParams({
        name: "NYC Trip",
        start: "2026-03-20T00:00:00Z",
        end: "2026-03-15T00:00:00Z",
        timezone: "America/New_York",
      }),
    ).toThrow("'start' must be before 'end'");
  });

  it("throws when start equals end", () => {
    expect(() =>
      validateAddTripParams({
        name: "NYC Trip",
        start: "2026-03-15T00:00:00Z",
        end: "2026-03-15T00:00:00Z",
        timezone: "America/New_York",
      }),
    ).toThrow("'start' must be before 'end'");
  });

  it("throws when timezone is missing", () => {
    expect(() =>
      validateAddTripParams({
        name: "NYC Trip",
        start: "2026-03-15T00:00:00Z",
        end: "2026-03-20T00:00:00Z",
      }),
    ).toThrow("'timezone' is required");
  });

  it("throws when timezone is empty", () => {
    expect(() =>
      validateAddTripParams({
        name: "NYC Trip",
        start: "2026-03-15T00:00:00Z",
        end: "2026-03-20T00:00:00Z",
        timezone: "  ",
      }),
    ).toThrow("'timezone' is required");
  });

  it("throws when block_policy is invalid", () => {
    expect(() =>
      validateAddTripParams({
        name: "NYC Trip",
        start: "2026-03-15T00:00:00Z",
        end: "2026-03-20T00:00:00Z",
        timezone: "America/New_York",
        block_policy: "FULL",
      }),
    ).toThrow("'block_policy' must be one of: BUSY, TITLE");
  });

  it("throws when block_policy is not a string", () => {
    expect(() =>
      validateAddTripParams({
        name: "NYC Trip",
        start: "2026-03-15T00:00:00Z",
        end: "2026-03-20T00:00:00Z",
        timezone: "America/New_York",
        block_policy: 42,
      }),
    ).toThrow("'block_policy' must be one of: BUSY, TITLE");
  });

  it("returns validated params with default block_policy=BUSY", () => {
    const result = validateAddTripParams({
      name: " NYC Trip ",
      start: "2026-03-15T00:00:00Z",
      end: "2026-03-20T00:00:00Z",
      timezone: " America/New_York ",
    });

    expect(result.kind).toBe("trip");
    expect(result.config_json.name).toBe("NYC Trip"); // trimmed
    expect(result.config_json.timezone).toBe("America/New_York"); // trimmed
    expect(result.config_json.block_policy).toBe("BUSY"); // default
    expect(result.active_from).toBe("2026-03-15T00:00:00Z");
    expect(result.active_to).toBe("2026-03-20T00:00:00Z");
  });

  it("accepts TITLE block_policy", () => {
    const result = validateAddTripParams({
      name: "London Trip",
      start: "2026-04-01T00:00:00Z",
      end: "2026-04-10T00:00:00Z",
      timezone: "Europe/London",
      block_policy: "TITLE",
    });

    expect(result.config_json.block_policy).toBe("TITLE");
  });

  it("accepts BUSY block_policy explicitly", () => {
    const result = validateAddTripParams({
      name: "Trip",
      start: "2026-05-01T00:00:00Z",
      end: "2026-05-05T00:00:00Z",
      timezone: "UTC",
      block_policy: "BUSY",
    });

    expect(result.config_json.block_policy).toBe("BUSY");
  });

  it("transforms input to constraint API shape", () => {
    const result = validateAddTripParams({
      name: "Business Trip",
      start: "2026-06-01T09:00:00Z",
      end: "2026-06-05T17:00:00Z",
      timezone: "America/Chicago",
      block_policy: "TITLE",
    });

    // Verify the shape matches what the constraint API expects
    expect(result).toEqual({
      kind: "trip",
      config_json: {
        name: "Business Trip",
        timezone: "America/Chicago",
        block_policy: "TITLE",
      },
      active_from: "2026-06-01T09:00:00Z",
      active_to: "2026-06-05T17:00:00Z",
    });
  });
});

// ---------------------------------------------------------------------------
// validateAddConstraintParams (pure function tests)
// ---------------------------------------------------------------------------

describe("validateAddConstraintParams", () => {
  it("throws on undefined args", () => {
    expect(() => validateAddConstraintParams(undefined)).toThrow(
      "Missing required parameters",
    );
  });

  it("throws when kind is missing", () => {
    expect(() =>
      validateAddConstraintParams({ config: { minutes: 15 } }),
    ).toThrow("'kind' is required");
  });

  it("throws when kind is empty string", () => {
    expect(() =>
      validateAddConstraintParams({ kind: "  ", config: {} }),
    ).toThrow("'kind' is required");
  });

  it("throws when kind is not a string", () => {
    expect(() =>
      validateAddConstraintParams({ kind: 42, config: {} }),
    ).toThrow("'kind' is required");
  });

  it("throws when config is missing", () => {
    expect(() =>
      validateAddConstraintParams({ kind: "buffer" }),
    ).toThrow("'config' is required and must be an object");
  });

  it("throws when config is null", () => {
    expect(() =>
      validateAddConstraintParams({ kind: "buffer", config: null }),
    ).toThrow("'config' is required and must be an object");
  });

  it("throws when config is an array", () => {
    expect(() =>
      validateAddConstraintParams({ kind: "buffer", config: [1, 2] }),
    ).toThrow("'config' is required and must be an object");
  });

  it("throws when config is a string", () => {
    expect(() =>
      validateAddConstraintParams({ kind: "buffer", config: "not-object" }),
    ).toThrow("'config' is required and must be an object");
  });

  it("returns validated params for valid buffer input", () => {
    const result = validateAddConstraintParams({
      kind: " buffer ",
      config: { type: "travel", minutes: 15, applies_to: "all" },
    });

    expect(result.kind).toBe("buffer"); // trimmed
    expect(result.config_json).toEqual({
      type: "travel",
      minutes: 15,
      applies_to: "all",
    });
  });

  it("returns validated params for valid working_hours input", () => {
    const result = validateAddConstraintParams({
      kind: "working_hours",
      config: {
        days: [1, 2, 3, 4, 5],
        start_time: "09:00",
        end_time: "17:00",
        timezone: "America/Chicago",
      },
    });

    expect(result.kind).toBe("working_hours");
    expect(result.config_json.days).toEqual([1, 2, 3, 4, 5]);
  });

  it("passes any kind string through (API validates kind)", () => {
    const result = validateAddConstraintParams({
      kind: "no_meetings_after",
      config: { time: "18:00", timezone: "America/Chicago" },
    });

    expect(result.kind).toBe("no_meetings_after");
  });
});

// ---------------------------------------------------------------------------
// validateListConstraintsParams (pure function tests)
// ---------------------------------------------------------------------------

describe("validateListConstraintsParams", () => {
  it("returns null kind when args is undefined", () => {
    const result = validateListConstraintsParams(undefined);
    expect(result.kind).toBeNull();
  });

  it("returns null kind when args is empty object", () => {
    const result = validateListConstraintsParams({});
    expect(result.kind).toBeNull();
  });

  it("returns kind when provided", () => {
    const result = validateListConstraintsParams({ kind: "trip" });
    expect(result.kind).toBe("trip");
  });

  it("trims kind string", () => {
    const result = validateListConstraintsParams({ kind: " buffer " });
    expect(result.kind).toBe("buffer");
  });

  it("throws when kind is empty string", () => {
    expect(() =>
      validateListConstraintsParams({ kind: "" }),
    ).toThrow("'kind' must be a non-empty string");
  });

  it("throws when kind is whitespace-only string", () => {
    expect(() =>
      validateListConstraintsParams({ kind: "   " }),
    ).toThrow("'kind' must be a non-empty string");
  });

  it("throws when kind is not a string", () => {
    expect(() =>
      validateListConstraintsParams({ kind: 42 }),
    ).toThrow("'kind' must be a non-empty string");
  });
});

// ---------------------------------------------------------------------------
// tools/list includes constraint tools
// ---------------------------------------------------------------------------

describe("POST /mcp -- tools/list includes constraint tools", () => {
  it("includes all 3 constraint tools in registry", async () => {
    const handler = createMcpHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    const result = await sendMcpRequest(
      handler,
      env,
      { jsonrpc: "2.0", method: "tools/list", id: 1 },
      authHeader,
    );

    expect(result.status).toBe(200);
    const resultData = result.body.result as { tools: Array<Record<string, unknown>> };

    const toolNames = resultData.tools.map((t) => t.name);
    expect(toolNames).toContain("calendar.add_trip");
    expect(toolNames).toContain("calendar.add_constraint");
    expect(toolNames).toContain("calendar.list_constraints");
  });

  it("calendar.add_trip schema has required name, start, end, timezone fields", async () => {
    const handler = createMcpHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    const result = await sendMcpRequest(
      handler,
      env,
      { jsonrpc: "2.0", method: "tools/list", id: 1 },
      authHeader,
    );

    const resultData = result.body.result as { tools: Array<Record<string, unknown>> };
    const addTripTool = resultData.tools.find(
      (t) => t.name === "calendar.add_trip",
    );
    expect(addTripTool).toBeDefined();

    const schema = addTripTool?.inputSchema as { required?: string[]; properties: Record<string, unknown> };
    expect(schema.required).toContain("name");
    expect(schema.required).toContain("start");
    expect(schema.required).toContain("end");
    expect(schema.required).toContain("timezone");
    expect(schema.properties).toHaveProperty("block_policy");
  });

  it("calendar.add_trip schema has block_policy enum", async () => {
    const handler = createMcpHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    const result = await sendMcpRequest(
      handler,
      env,
      { jsonrpc: "2.0", method: "tools/list", id: 1 },
      authHeader,
    );

    const resultData = result.body.result as { tools: Array<Record<string, unknown>> };
    const addTripTool = resultData.tools.find(
      (t) => t.name === "calendar.add_trip",
    );

    const schema = addTripTool?.inputSchema as {
      properties: Record<string, { enum?: string[] }>;
    };
    expect(schema.properties.block_policy.enum).toEqual(["BUSY", "TITLE"]);
  });

  it("calendar.add_constraint schema has required kind and config fields", async () => {
    const handler = createMcpHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    const result = await sendMcpRequest(
      handler,
      env,
      { jsonrpc: "2.0", method: "tools/list", id: 1 },
      authHeader,
    );

    const resultData = result.body.result as { tools: Array<Record<string, unknown>> };
    const addConstraintTool = resultData.tools.find(
      (t) => t.name === "calendar.add_constraint",
    );
    expect(addConstraintTool).toBeDefined();

    const schema = addConstraintTool?.inputSchema as { required?: string[] };
    expect(schema.required).toContain("kind");
    expect(schema.required).toContain("config");
  });

  it("calendar.list_constraints schema has optional kind field (no required)", async () => {
    const handler = createMcpHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    const result = await sendMcpRequest(
      handler,
      env,
      { jsonrpc: "2.0", method: "tools/list", id: 1 },
      authHeader,
    );

    const resultData = result.body.result as { tools: Array<Record<string, unknown>> };
    const listConstraintsTool = resultData.tools.find(
      (t) => t.name === "calendar.list_constraints",
    );
    expect(listConstraintsTool).toBeDefined();

    const schema = listConstraintsTool?.inputSchema as {
      type: string;
      required?: string[];
      properties: Record<string, unknown>;
    };
    expect(schema.type).toBe("object");
    // No required fields -- kind is optional
    expect(schema.required).toBeUndefined();
    expect(schema.properties).toHaveProperty("kind");
  });
});

// ---------------------------------------------------------------------------
// Tier checks for constraint tools
// ---------------------------------------------------------------------------

describe("checkTierAccess for constraint tools", () => {
  it("denies free tier access to calendar.add_trip", () => {
    const result = checkTierAccess("calendar.add_trip", "free");
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.required_tier).toBe("premium");
    }
  });

  it("allows premium tier access to calendar.add_trip", () => {
    const result = checkTierAccess("calendar.add_trip", "premium");
    expect(result.allowed).toBe(true);
  });

  it("allows enterprise tier access to calendar.add_trip", () => {
    const result = checkTierAccess("calendar.add_trip", "enterprise");
    expect(result.allowed).toBe(true);
  });

  it("denies free tier access to calendar.add_constraint", () => {
    const result = checkTierAccess("calendar.add_constraint", "free");
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.required_tier).toBe("premium");
    }
  });

  it("allows premium tier access to calendar.add_constraint", () => {
    const result = checkTierAccess("calendar.add_constraint", "premium");
    expect(result.allowed).toBe(true);
  });

  it("allows free tier access to calendar.list_constraints (read-only)", () => {
    const result = checkTierAccess("calendar.list_constraints", "free");
    expect(result.allowed).toBe(true);
  });

  it("allows premium tier access to calendar.list_constraints", () => {
    const result = checkTierAccess("calendar.list_constraints", "premium");
    expect(result.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Constraint tool dispatch: tier gating for add_trip and add_constraint
// ---------------------------------------------------------------------------

describe("tier gating for constraint tools in MCP dispatch", () => {
  it("free user calling calendar.add_trip returns TIER_REQUIRED error", async () => {
    const handler = createMcpHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    const result = await sendMcpRequest(
      handler,
      env,
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "calendar.add_trip",
          arguments: {
            name: "NYC",
            start: "2026-03-15T00:00:00Z",
            end: "2026-03-20T00:00:00Z",
            timezone: "America/New_York",
          },
        },
        id: 100,
      },
      authHeader,
    );

    expect(result.status).toBe(200);
    const error = result.body.error as {
      code: number;
      data: { code: string; required_tier: string; current_tier: string; tool: string };
    };
    expect(error).toBeDefined();
    expect(error.code).toBe(-32603);
    expect(error.data.code).toBe("TIER_REQUIRED");
    expect(error.data.required_tier).toBe("premium");
    expect(error.data.current_tier).toBe("free");
    expect(error.data.tool).toBe("calendar.add_trip");
  });

  it("free user calling calendar.add_constraint returns TIER_REQUIRED error", async () => {
    const handler = createMcpHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    const result = await sendMcpRequest(
      handler,
      env,
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "calendar.add_constraint",
          arguments: { kind: "buffer", config: { type: "travel", minutes: 15, applies_to: "all" } },
        },
        id: 101,
      },
      authHeader,
    );

    expect(result.status).toBe(200);
    const error = result.body.error as {
      code: number;
      data: { code: string };
    };
    expect(error).toBeDefined();
    expect(error.code).toBe(-32603);
    expect(error.data.code).toBe("TIER_REQUIRED");
  });

  it("free user calling calendar.list_constraints is NOT tier-gated", async () => {
    const handler = createMcpHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    const result = await sendMcpRequest(
      handler,
      env,
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "calendar.list_constraints", arguments: {} },
        id: 102,
      },
      authHeader,
    );

    // list_constraints is free tier -- should NOT get TIER_REQUIRED error.
    // It may get an internal error (no API binding in test env), but NOT a tier error.
    if (result.body.error) {
      const error = result.body.error as { data?: { code?: string } };
      expect(error.data?.code).not.toBe("TIER_REQUIRED");
    }
  });
});

// ---------------------------------------------------------------------------
// Constraint tools: API binding missing error
// ---------------------------------------------------------------------------

describe("constraint tools with missing API binding", () => {
  it("calendar.list_constraints returns internal error when API binding missing", async () => {
    const handler = createMcpHandler();
    // Env without API binding
    const env = createMinimalEnv();
    // Need premium tier for add_trip/add_constraint, free for list_constraints
    const authHeader = await makeAuthHeader();

    const result = await sendMcpRequest(
      handler,
      env,
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "calendar.list_constraints", arguments: {} },
        id: 200,
      },
      authHeader,
    );

    expect(result.status).toBe(200);
    const error = result.body.error as { code: number; message: string };
    expect(error).toBeDefined();
    expect(error.code).toBe(-32603);
    expect(error.message).toContain("service binding");
  });
});

// ---------------------------------------------------------------------------
// Scheduling tools: Zod schema validation (TM-946.5)
// ---------------------------------------------------------------------------

import {
  validateProposeTimesParams,
  validateCommitCandidateParams,
} from "./index";

describe("validateProposeTimesParams (Zod)", () => {
  // -- Happy path --

  it("accepts valid minimal input", () => {
    const result = validateProposeTimesParams({
      participants: ["acc_001"],
      window: {
        start: "2026-03-15T09:00:00Z",
        end: "2026-03-15T17:00:00Z",
      },
      duration_minutes: 30,
    });

    expect(result.participants).toEqual(["acc_001"]);
    expect(result.window.start).toBe("2026-03-15T09:00:00Z");
    expect(result.window.end).toBe("2026-03-15T17:00:00Z");
    expect(result.duration_minutes).toBe(30);
    expect(result.constraints).toBeUndefined();
    expect(result.objective).toBeUndefined();
  });

  it("accepts valid input with all optional fields", () => {
    const result = validateProposeTimesParams({
      participants: ["acc_001", "acc_002"],
      window: {
        start: "2026-03-15T09:00:00Z",
        end: "2026-03-15T17:00:00Z",
      },
      duration_minutes: 60,
      constraints: { prefer_morning: true },
      objective: "least_conflicts",
    });

    expect(result.participants).toEqual(["acc_001", "acc_002"]);
    expect(result.duration_minutes).toBe(60);
    expect(result.constraints).toEqual({ prefer_morning: true });
    expect(result.objective).toBe("least_conflicts");
  });

  it("accepts all valid objective values", () => {
    for (const obj of ["earliest", "least_conflicts", "best_distribution"]) {
      const result = validateProposeTimesParams({
        participants: ["acc_001"],
        window: {
          start: "2026-03-15T09:00:00Z",
          end: "2026-03-15T17:00:00Z",
        },
        duration_minutes: 30,
        objective: obj,
      });
      expect(result.objective).toBe(obj);
    }
  });

  // -- Missing required fields --

  it("throws when args is undefined", () => {
    expect(() => validateProposeTimesParams(undefined)).toThrow(
      "Missing required parameters",
    );
  });

  it("throws when participants is missing", () => {
    expect(() =>
      validateProposeTimesParams({
        window: {
          start: "2026-03-15T09:00:00Z",
          end: "2026-03-15T17:00:00Z",
        },
        duration_minutes: 30,
      }),
    ).toThrow("Invalid parameters");
  });

  it("throws when participants is empty array", () => {
    expect(() =>
      validateProposeTimesParams({
        participants: [],
        window: {
          start: "2026-03-15T09:00:00Z",
          end: "2026-03-15T17:00:00Z",
        },
        duration_minutes: 30,
      }),
    ).toThrow("At least one participant");
  });

  it("throws when participants contains empty string", () => {
    expect(() =>
      validateProposeTimesParams({
        participants: ["acc_001", ""],
        window: {
          start: "2026-03-15T09:00:00Z",
          end: "2026-03-15T17:00:00Z",
        },
        duration_minutes: 30,
      }),
    ).toThrow("non-empty string");
  });

  it("throws when window is missing", () => {
    expect(() =>
      validateProposeTimesParams({
        participants: ["acc_001"],
        duration_minutes: 30,
      }),
    ).toThrow("Invalid parameters");
  });

  it("throws when window.start is missing", () => {
    expect(() =>
      validateProposeTimesParams({
        participants: ["acc_001"],
        window: { end: "2026-03-15T17:00:00Z" },
        duration_minutes: 30,
      }),
    ).toThrow("Invalid parameters");
  });

  it("throws when window.start is invalid ISO 8601", () => {
    expect(() =>
      validateProposeTimesParams({
        participants: ["acc_001"],
        window: {
          start: "not-a-date",
          end: "2026-03-15T17:00:00Z",
        },
        duration_minutes: 30,
      }),
    ).toThrow("valid ISO 8601");
  });

  it("throws when window.start is after window.end", () => {
    expect(() =>
      validateProposeTimesParams({
        participants: ["acc_001"],
        window: {
          start: "2026-03-15T17:00:00Z",
          end: "2026-03-15T09:00:00Z",
        },
        duration_minutes: 30,
      }),
    ).toThrow("before window.end");
  });

  it("throws when window.start equals window.end", () => {
    expect(() =>
      validateProposeTimesParams({
        participants: ["acc_001"],
        window: {
          start: "2026-03-15T09:00:00Z",
          end: "2026-03-15T09:00:00Z",
        },
        duration_minutes: 30,
      }),
    ).toThrow("before window.end");
  });

  it("throws when duration_minutes is missing", () => {
    expect(() =>
      validateProposeTimesParams({
        participants: ["acc_001"],
        window: {
          start: "2026-03-15T09:00:00Z",
          end: "2026-03-15T17:00:00Z",
        },
      }),
    ).toThrow("Invalid parameters");
  });

  it("throws when duration_minutes is below 15", () => {
    expect(() =>
      validateProposeTimesParams({
        participants: ["acc_001"],
        window: {
          start: "2026-03-15T09:00:00Z",
          end: "2026-03-15T17:00:00Z",
        },
        duration_minutes: 10,
      }),
    ).toThrow("at least 15");
  });

  it("throws when duration_minutes is above 480", () => {
    expect(() =>
      validateProposeTimesParams({
        participants: ["acc_001"],
        window: {
          start: "2026-03-15T09:00:00Z",
          end: "2026-03-15T17:00:00Z",
        },
        duration_minutes: 500,
      }),
    ).toThrow("at most 480");
  });

  it("throws when duration_minutes is not an integer", () => {
    expect(() =>
      validateProposeTimesParams({
        participants: ["acc_001"],
        window: {
          start: "2026-03-15T09:00:00Z",
          end: "2026-03-15T17:00:00Z",
        },
        duration_minutes: 30.5,
      }),
    ).toThrow("integer");
  });

  it("throws when duration_minutes is a string", () => {
    expect(() =>
      validateProposeTimesParams({
        participants: ["acc_001"],
        window: {
          start: "2026-03-15T09:00:00Z",
          end: "2026-03-15T17:00:00Z",
        },
        duration_minutes: "30" as unknown as number,
      }),
    ).toThrow("Invalid parameters");
  });

  it("throws when objective is invalid", () => {
    expect(() =>
      validateProposeTimesParams({
        participants: ["acc_001"],
        window: {
          start: "2026-03-15T09:00:00Z",
          end: "2026-03-15T17:00:00Z",
        },
        duration_minutes: 30,
        objective: "invalid_objective",
      }),
    ).toThrow("Invalid parameters");
  });

  // -- Edge cases --

  it("accepts duration_minutes at minimum boundary (15)", () => {
    const result = validateProposeTimesParams({
      participants: ["acc_001"],
      window: {
        start: "2026-03-15T09:00:00Z",
        end: "2026-03-15T17:00:00Z",
      },
      duration_minutes: 15,
    });
    expect(result.duration_minutes).toBe(15);
  });

  it("accepts duration_minutes at maximum boundary (480)", () => {
    const result = validateProposeTimesParams({
      participants: ["acc_001"],
      window: {
        start: "2026-03-15T09:00:00Z",
        end: "2026-03-15T17:00:00Z",
      },
      duration_minutes: 480,
    });
    expect(result.duration_minutes).toBe(480);
  });
});

describe("validateCommitCandidateParams (Zod)", () => {
  // -- Happy path --

  it("accepts valid input", () => {
    const result = validateCommitCandidateParams({
      session_id: "sched_01abc",
      candidate_id: "cand_01xyz",
    });

    expect(result.session_id).toBe("sched_01abc");
    expect(result.candidate_id).toBe("cand_01xyz");
  });

  // -- Missing required fields --

  it("throws when args is undefined", () => {
    expect(() => validateCommitCandidateParams(undefined)).toThrow(
      "Missing required parameters",
    );
  });

  it("throws when session_id is missing", () => {
    expect(() =>
      validateCommitCandidateParams({ candidate_id: "cand_01xyz" }),
    ).toThrow("Invalid parameters");
  });

  it("throws when candidate_id is missing", () => {
    expect(() =>
      validateCommitCandidateParams({ session_id: "sched_01abc" }),
    ).toThrow("Invalid parameters");
  });

  it("throws when session_id is empty string", () => {
    expect(() =>
      validateCommitCandidateParams({
        session_id: "",
        candidate_id: "cand_01xyz",
      }),
    ).toThrow("session_id is required");
  });

  it("throws when candidate_id is empty string", () => {
    expect(() =>
      validateCommitCandidateParams({
        session_id: "sched_01abc",
        candidate_id: "",
      }),
    ).toThrow("candidate_id is required");
  });

  it("throws when session_id is not a string", () => {
    expect(() =>
      validateCommitCandidateParams({
        session_id: 123,
        candidate_id: "cand_01xyz",
      }),
    ).toThrow("Invalid parameters");
  });

  it("throws when candidate_id is not a string", () => {
    expect(() =>
      validateCommitCandidateParams({
        session_id: "sched_01abc",
        candidate_id: 456,
      }),
    ).toThrow("Invalid parameters");
  });
});

// ---------------------------------------------------------------------------
// Scheduling tools: tier check (TM-946.5 AC #4)
// ---------------------------------------------------------------------------

describe("checkTierAccess for scheduling tools", () => {
  it("free user is denied calendar.propose_times", () => {
    const result = checkTierAccess("calendar.propose_times", "free");
    if (result.allowed) throw new Error("Expected denied");
    expect(result.allowed).toBe(false);
    expect(result.required_tier).toBe("premium");
  });

  it("premium user is allowed calendar.propose_times", () => {
    const result = checkTierAccess("calendar.propose_times", "premium");
    expect(result.allowed).toBe(true);
  });

  it("enterprise user is allowed calendar.propose_times", () => {
    const result = checkTierAccess("calendar.propose_times", "enterprise");
    expect(result.allowed).toBe(true);
  });

  it("free user is denied calendar.commit_candidate", () => {
    const result = checkTierAccess("calendar.commit_candidate", "free");
    if (result.allowed) throw new Error("Expected denied");
    expect(result.allowed).toBe(false);
    expect(result.required_tier).toBe("premium");
  });

  it("premium user is allowed calendar.commit_candidate", () => {
    const result = checkTierAccess("calendar.commit_candidate", "premium");
    expect(result.allowed).toBe(true);
  });

  it("enterprise user is allowed calendar.commit_candidate", () => {
    const result = checkTierAccess("calendar.commit_candidate", "enterprise");
    expect(result.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scheduling tools: tool registration in TOOL_REGISTRY (TM-946.5)
// ---------------------------------------------------------------------------

describe("scheduling tools in tools/list", () => {
  it("tools/list includes calendar.propose_times and calendar.commit_candidate", async () => {
    const handler = createMcpHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    const result = await sendMcpRequest(
      handler,
      env,
      { jsonrpc: "2.0", method: "tools/list", id: 1 },
      authHeader,
    );

    expect(result.status).toBe(200);
    const resultData = result.body.result as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> };
    const toolNames = resultData.tools.map((t) => t.name);
    expect(toolNames).toContain("calendar.propose_times");
    expect(toolNames).toContain("calendar.commit_candidate");
  });

  it("calendar.propose_times has correct required fields in schema", async () => {
    const handler = createMcpHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    const result = await sendMcpRequest(
      handler,
      env,
      { jsonrpc: "2.0", method: "tools/list", id: 1 },
      authHeader,
    );

    const resultData = result.body.result as { tools: Array<{ name: string; inputSchema: { type: string; properties: Record<string, unknown>; required?: string[] } }> };
    const proposeTool = resultData.tools.find((t) => t.name === "calendar.propose_times");
    expect(proposeTool).toBeDefined();
    expect(proposeTool!.inputSchema.type).toBe("object");
    expect(proposeTool!.inputSchema.properties).toHaveProperty("participants");
    expect(proposeTool!.inputSchema.properties).toHaveProperty("window");
    expect(proposeTool!.inputSchema.properties).toHaveProperty("duration_minutes");
    expect(proposeTool!.inputSchema.properties).toHaveProperty("constraints");
    expect(proposeTool!.inputSchema.properties).toHaveProperty("objective");
    expect(proposeTool!.inputSchema.required).toEqual(["participants", "window", "duration_minutes"]);
  });

  it("calendar.commit_candidate has correct required fields in schema", async () => {
    const handler = createMcpHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    const result = await sendMcpRequest(
      handler,
      env,
      { jsonrpc: "2.0", method: "tools/list", id: 1 },
      authHeader,
    );

    const resultData = result.body.result as { tools: Array<{ name: string; inputSchema: { type: string; properties: Record<string, unknown>; required?: string[] } }> };
    const commitTool = resultData.tools.find((t) => t.name === "calendar.commit_candidate");
    expect(commitTool).toBeDefined();
    expect(commitTool!.inputSchema.type).toBe("object");
    expect(commitTool!.inputSchema.properties).toHaveProperty("session_id");
    expect(commitTool!.inputSchema.properties).toHaveProperty("candidate_id");
    expect(commitTool!.inputSchema.required).toEqual(["session_id", "candidate_id"]);
  });
});

// ---------------------------------------------------------------------------
// Scheduling tools: tier-gating via full MCP dispatch (TM-946.5)
// ---------------------------------------------------------------------------

describe("scheduling tools tier-gating via MCP dispatch", () => {
  it("free user calling calendar.propose_times is tier-gated", async () => {
    const handler = createMcpHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader(); // defaults to free tier

    const result = await sendMcpRequest(
      handler,
      env,
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "calendar.propose_times",
          arguments: {
            participants: ["acc_001"],
            window: { start: "2026-03-15T09:00:00Z", end: "2026-03-15T17:00:00Z" },
            duration_minutes: 30,
          },
        },
        id: 300,
      },
      authHeader,
    );

    const error = result.body.error as {
      code: number;
      message: string;
      data?: { code?: string; required_tier?: string };
    };
    expect(error).toBeDefined();
    expect(error.code).toBe(-32603);
    expect(error.data?.code).toBe("TIER_REQUIRED");
    expect(error.data?.required_tier).toBe("premium");
  });

  it("free user calling calendar.commit_candidate is tier-gated", async () => {
    const handler = createMcpHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader(); // defaults to free tier

    const result = await sendMcpRequest(
      handler,
      env,
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "calendar.commit_candidate",
          arguments: {
            session_id: "sched_01abc",
            candidate_id: "cand_01xyz",
          },
        },
        id: 301,
      },
      authHeader,
    );

    const error = result.body.error as {
      code: number;
      message: string;
      data?: { code?: string; required_tier?: string };
    };
    expect(error).toBeDefined();
    expect(error.code).toBe(-32603);
    expect(error.data?.code).toBe("TIER_REQUIRED");
    expect(error.data?.required_tier).toBe("premium");
  });
});

// ---------------------------------------------------------------------------
// Scheduling tools: API binding missing (TM-946.5)
// ---------------------------------------------------------------------------

describe("scheduling tools with missing API binding", () => {
  it("calendar.propose_times returns internal error when API binding missing", async () => {
    const handler = createMcpHandler();
    const env = createMinimalEnv(); // no API binding
    // Need premium tier for this tool
    const token = await generateJWT(
      {
        sub: TEST_USER_ID,
        email: TEST_EMAIL,
        tier: "premium",
        pwd_ver: 1,
      },
      JWT_SECRET,
      3600,
    );
    const authHeader = `Bearer ${token}`;

    const result = await sendMcpRequest(
      handler,
      env,
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "calendar.propose_times",
          arguments: {
            participants: ["acc_001"],
            window: {
              start: "2026-03-15T09:00:00Z",
              end: "2026-03-15T17:00:00Z",
            },
            duration_minutes: 30,
          },
        },
        id: 400,
      },
      authHeader,
    );

    expect(result.status).toBe(200);
    const error = result.body.error as { code: number; message: string };
    expect(error).toBeDefined();
    expect(error.code).toBe(-32603);
    expect(error.message).toContain("service binding");
  });

  it("calendar.commit_candidate returns internal error when API binding missing", async () => {
    const handler = createMcpHandler();
    const env = createMinimalEnv(); // no API binding
    const token = await generateJWT(
      {
        sub: TEST_USER_ID,
        email: TEST_EMAIL,
        tier: "premium",
        pwd_ver: 1,
      },
      JWT_SECRET,
      3600,
    );
    const authHeader = `Bearer ${token}`;

    const result = await sendMcpRequest(
      handler,
      env,
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "calendar.commit_candidate",
          arguments: {
            session_id: "sched_01abc",
            candidate_id: "cand_01xyz",
          },
        },
        id: 401,
      },
      authHeader,
    );

    expect(result.status).toBe(200);
    const error = result.body.error as { code: number; message: string };
    expect(error).toBeDefined();
    expect(error.code).toBe(-32603);
    expect(error.message).toContain("service binding");
  });
});

// ---------------------------------------------------------------------------
// Governance tools: Zod validation for calendar.get_commitment_status
// ---------------------------------------------------------------------------

describe("validateGetCommitmentStatusParams", () => {
  it("accepts empty args (no filter)", () => {
    const result = validateGetCommitmentStatusParams(undefined);
    expect(result).toEqual({});
  });

  it("accepts empty object (no filter)", () => {
    const result = validateGetCommitmentStatusParams({});
    expect(result).toEqual({});
  });

  it("accepts valid client filter", () => {
    const result = validateGetCommitmentStatusParams({ client: "acme-corp" });
    expect(result.client).toBe("acme-corp");
  });

  it("rejects empty string client", () => {
    expect(() =>
      validateGetCommitmentStatusParams({ client: "" }),
    ).toThrow("client must be a non-empty string");
  });

  it("strips unknown fields", () => {
    const result = validateGetCommitmentStatusParams({
      client: "acme",
      unknown_field: 123,
    });
    expect(result.client).toBe("acme");
    expect((result as Record<string, unknown>)["unknown_field"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Governance tools: Zod validation for calendar.export_commitment_proof
// ---------------------------------------------------------------------------

describe("validateExportCommitmentProofParams", () => {
  it("accepts valid commitment_id with default format", () => {
    const result = validateExportCommitmentProofParams({
      commitment_id: "cmt_01abc",
    });
    expect(result.commitment_id).toBe("cmt_01abc");
    expect(result.format).toBe("pdf");
  });

  it("accepts valid commitment_id with pdf format", () => {
    const result = validateExportCommitmentProofParams({
      commitment_id: "cmt_01abc",
      format: "pdf",
    });
    expect(result.commitment_id).toBe("cmt_01abc");
    expect(result.format).toBe("pdf");
  });

  it("accepts valid commitment_id with csv format", () => {
    const result = validateExportCommitmentProofParams({
      commitment_id: "cmt_01abc",
      format: "csv",
    });
    expect(result.commitment_id).toBe("cmt_01abc");
    expect(result.format).toBe("csv");
  });

  it("rejects missing args (undefined)", () => {
    expect(() =>
      validateExportCommitmentProofParams(undefined),
    ).toThrow("Missing required parameters: commitment_id");
  });

  it("rejects empty commitment_id", () => {
    expect(() =>
      validateExportCommitmentProofParams({ commitment_id: "" }),
    ).toThrow("commitment_id is required");
  });

  it("rejects missing commitment_id", () => {
    expect(() =>
      validateExportCommitmentProofParams({}),
    ).toThrow("commitment_id");
  });

  it("rejects invalid format", () => {
    expect(() =>
      validateExportCommitmentProofParams({
        commitment_id: "cmt_01abc",
        format: "docx",
      }),
    ).toThrow("Invalid");
  });
});

// ---------------------------------------------------------------------------
// Governance tools: checkTierAccess for commitment tools
// ---------------------------------------------------------------------------

describe("checkTierAccess for governance commitment tools", () => {
  const GOVERNANCE_PREMIUM_TOOLS = [
    "calendar.get_commitment_status",
    "calendar.export_commitment_proof",
  ];

  for (const tool of GOVERNANCE_PREMIUM_TOOLS) {
    it(`free user is denied ${tool}`, () => {
      const result = checkTierAccess(tool, "free");
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.required_tier).toBe("premium");
        expect(result.current_tier).toBe("free");
        expect(result.tool).toBe(tool);
      }
    });

    it(`premium user is allowed ${tool}`, () => {
      const result = checkTierAccess(tool, "premium");
      expect(result.allowed).toBe(true);
    });

    it(`enterprise user is allowed ${tool}`, () => {
      const result = checkTierAccess(tool, "enterprise");
      expect(result.allowed).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Governance tools: tier gating via MCP dispatch
// ---------------------------------------------------------------------------

describe("tier gating for governance commitment tools via MCP dispatch", () => {
  it("free user calling calendar.get_commitment_status returns TIER_REQUIRED", async () => {
    const handler = createMcpHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader(); // free tier

    const result = await sendMcpRequest(
      handler,
      env,
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "calendar.get_commitment_status",
          arguments: {},
        },
        id: 501,
      },
      authHeader,
    );

    expect(result.status).toBe(200);
    const error = result.body.error as { code: number; message: string; data?: Record<string, unknown> };
    expect(error).toBeDefined();
    expect(error.message).toContain("premium");
    expect(error.data?.code).toBe("TIER_REQUIRED");
  });

  it("free user calling calendar.export_commitment_proof returns TIER_REQUIRED", async () => {
    const handler = createMcpHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader(); // free tier

    const result = await sendMcpRequest(
      handler,
      env,
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "calendar.export_commitment_proof",
          arguments: { commitment_id: "cmt_01abc" },
        },
        id: 502,
      },
      authHeader,
    );

    expect(result.status).toBe(200);
    const error = result.body.error as { code: number; message: string; data?: Record<string, unknown> };
    expect(error).toBeDefined();
    expect(error.message).toContain("premium");
    expect(error.data?.code).toBe("TIER_REQUIRED");
  });

  it("premium user calling calendar.get_commitment_status without API binding returns service binding error", async () => {
    const handler = createMcpHandler();
    const env = createMinimalEnv(); // no API binding
    const token = await generateJWT(
      {
        sub: TEST_USER_ID,
        email: TEST_EMAIL,
        tier: "premium",
        pwd_ver: 1,
      },
      JWT_SECRET,
      3600,
    );
    const authHeader = `Bearer ${token}`;

    const result = await sendMcpRequest(
      handler,
      env,
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "calendar.get_commitment_status",
          arguments: {},
        },
        id: 503,
      },
      authHeader,
    );

    expect(result.status).toBe(200);
    const error = result.body.error as { code: number; message: string };
    expect(error).toBeDefined();
    expect(error.code).toBe(-32603);
    expect(error.message).toContain("service binding");
  });

  it("premium user calling calendar.export_commitment_proof without API binding returns service binding error", async () => {
    const handler = createMcpHandler();
    const env = createMinimalEnv(); // no API binding
    const token = await generateJWT(
      {
        sub: TEST_USER_ID,
        email: TEST_EMAIL,
        tier: "premium",
        pwd_ver: 1,
      },
      JWT_SECRET,
      3600,
    );
    const authHeader = `Bearer ${token}`;

    const result = await sendMcpRequest(
      handler,
      env,
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "calendar.export_commitment_proof",
          arguments: { commitment_id: "cmt_01abc" },
        },
        id: 504,
      },
      authHeader,
    );

    expect(result.status).toBe(200);
    const error = result.body.error as { code: number; message: string };
    expect(error).toBeDefined();
    expect(error.code).toBe(-32603);
    expect(error.message).toContain("service binding");
  });
});

// ---------------------------------------------------------------------------
// Governance tools: tools/list registration
// ---------------------------------------------------------------------------

describe("governance commitment tools registration", () => {
  it("tools/list includes calendar.get_commitment_status and calendar.export_commitment_proof", async () => {
    const handler = createMcpHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    const result = await sendMcpRequest(
      handler,
      env,
      {
        jsonrpc: "2.0",
        method: "tools/list",
        id: 510,
      },
      authHeader,
    );

    expect(result.status).toBe(200);
    expect(result.body.error).toBeUndefined();
    const resultData = result.body.result as { tools: Array<{ name: string }> };
    const toolNames = resultData.tools.map((t) => t.name);
    expect(toolNames).toContain("calendar.get_commitment_status");
    expect(toolNames).toContain("calendar.export_commitment_proof");
    // Also verify existing governance tools are still registered
    expect(toolNames).toContain("calendar.set_vip");
    expect(toolNames).toContain("calendar.tag_billable");
  });
});

// ---------------------------------------------------------------------------
// Relationship tools: tier gating (TM-4wb.5)
// ---------------------------------------------------------------------------

describe("checkTierAccess for relationship tools (enterprise-gated)", () => {
  const relationshipTools = [
    "calendar.add_relationship",
    "calendar.get_drift_report",
    "calendar.mark_outcome",
    "calendar.get_reconnection_suggestions",
  ];

  for (const tool of relationshipTools) {
    it(`free tier denied for ${tool}`, () => {
      const result = checkTierAccess(tool, "free");
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.required_tier).toBe("enterprise");
      }
    });

    it(`premium tier denied for ${tool}`, () => {
      const result = checkTierAccess(tool, "premium");
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.required_tier).toBe("enterprise");
      }
    });

    it(`enterprise tier allowed for ${tool}`, () => {
      const result = checkTierAccess(tool, "enterprise");
      expect(result.allowed).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Relationship tools: tool registration in TOOL_REGISTRY (TM-4wb.5)
// ---------------------------------------------------------------------------

describe("relationship tools in tools/list", () => {
  it("tools/list includes all 4 relationship tools", async () => {
    const handler = createMcpHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    const result = await sendMcpRequest(
      handler,
      env,
      { jsonrpc: "2.0", method: "tools/list", id: 600 },
      authHeader,
    );

    expect(result.status).toBe(200);
    const resultData = result.body.result as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> };
    const toolNames = resultData.tools.map((t) => t.name);
    expect(toolNames).toContain("calendar.add_relationship");
    expect(toolNames).toContain("calendar.get_drift_report");
    expect(toolNames).toContain("calendar.mark_outcome");
    expect(toolNames).toContain("calendar.get_reconnection_suggestions");
  });

  it("calendar.get_reconnection_suggestions has correct schema", async () => {
    const handler = createMcpHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    const result = await sendMcpRequest(
      handler,
      env,
      { jsonrpc: "2.0", method: "tools/list", id: 601 },
      authHeader,
    );

    const resultData = result.body.result as {
      tools: Array<{
        name: string;
        inputSchema: { type: string; properties: Record<string, unknown>; required?: string[] };
      }>;
    };
    const tool = resultData.tools.find((t) => t.name === "calendar.get_reconnection_suggestions");
    expect(tool).toBeDefined();
    expect(tool!.inputSchema.type).toBe("object");
    expect(tool!.inputSchema.properties).toHaveProperty("trip_id");
    expect(tool!.inputSchema.properties).toHaveProperty("city");
    // No required fields -- either trip_id or city can be provided
    expect(tool!.inputSchema.required).toBeUndefined();
  });

  it("calendar.add_trip includes destination_city in schema", async () => {
    const handler = createMcpHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    const result = await sendMcpRequest(
      handler,
      env,
      { jsonrpc: "2.0", method: "tools/list", id: 602 },
      authHeader,
    );

    const resultData = result.body.result as {
      tools: Array<{
        name: string;
        inputSchema: { type: string; properties: Record<string, unknown> };
      }>;
    };
    const tripTool = resultData.tools.find((t) => t.name === "calendar.add_trip");
    expect(tripTool).toBeDefined();
    expect(tripTool!.inputSchema.properties).toHaveProperty("destination_city");
  });

  it("total tool count is 36 (25 base + reconnection + briefing + 3 milestone + group_schedule + cognitive_load + context_switches + simulate + caldav_feed + query_graph)", async () => {
    const handler = createMcpHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    const result = await sendMcpRequest(
      handler,
      env,
      { jsonrpc: "2.0", method: "tools/list", id: 603 },
      authHeader,
    );

    const resultData = result.body.result as { tools: Array<{ name: string }> };
    expect(resultData.tools.length).toBe(36);
  });
});

// ---------------------------------------------------------------------------
// validateAddTripParams: destination_city pass-through (TM-4wb.5)
// ---------------------------------------------------------------------------

describe("validateAddTripParams with destination_city", () => {
  it("includes destination_city in config_json when provided", () => {
    const result = validateAddTripParams({
      name: "NYC Trip",
      start: "2026-03-15T00:00:00Z",
      end: "2026-03-20T00:00:00Z",
      timezone: "America/New_York",
      destination_city: "New York",
    });
    expect(result.config_json.destination_city).toBe("New York");
  });

  it("omits destination_city from config_json when not provided", () => {
    const result = validateAddTripParams({
      name: "Generic Trip",
      start: "2026-03-15T00:00:00Z",
      end: "2026-03-20T00:00:00Z",
      timezone: "America/New_York",
    });
    expect(result.config_json.destination_city).toBeUndefined();
  });

  it("trims destination_city whitespace", () => {
    const result = validateAddTripParams({
      name: "Trip",
      start: "2026-03-15T00:00:00Z",
      end: "2026-03-20T00:00:00Z",
      timezone: "America/New_York",
      destination_city: "  San Francisco  ",
    });
    expect(result.config_json.destination_city).toBe("San Francisco");
  });

  it("ignores empty destination_city", () => {
    const result = validateAddTripParams({
      name: "Trip",
      start: "2026-03-15T00:00:00Z",
      end: "2026-03-20T00:00:00Z",
      timezone: "America/New_York",
      destination_city: "   ",
    });
    expect(result.config_json.destination_city).toBeUndefined();
  });
});
