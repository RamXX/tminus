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
import { createMcpHandler } from "./index";

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
  it("returns registered tools with schemas", async () => {
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
    expect(resultData.tools.length).toBeGreaterThanOrEqual(1);

    // Verify calendar.list_accounts tool is registered
    const listAccountsTool = resultData.tools.find(
      (t) => t.name === "calendar.list_accounts",
    );
    expect(listAccountsTool).toBeDefined();
    expect(listAccountsTool?.description).toBeTruthy();
    expect(listAccountsTool?.inputSchema).toBeDefined();

    const schema = listAccountsTool?.inputSchema as Record<string, unknown>;
    expect(schema.type).toBe("object");
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
