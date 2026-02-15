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
