/**
 * Unit tests for tminus-api worker.
 *
 * Tests the core building blocks:
 * - JWT validation logic (create, verify, expiry, bad signature)
 * - Response envelope construction (success, error)
 * - Request validation for each endpoint
 * - Routing logic (method + path matching)
 * - Auth middleware (missing, invalid, valid)
 */

import { describe, it, expect, vi } from "vitest";
import { APP_NAME, SCHEMA_VERSION } from "@tminus/shared";
import {
  createHandler,
  createJwt,
  verifyJwt,
  successEnvelope,
  errorEnvelope,
  ErrorCode,
} from "./index";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const JWT_SECRET = "test-jwt-secret-for-unit-tests-must-be-long-enough";
const TEST_USER_ID = "usr_01HXYZ000000000000000001";

// ---------------------------------------------------------------------------
// JWT helpers for tests
// ---------------------------------------------------------------------------

async function makeAuthHeader(
  userId?: string,
  extraClaims?: Record<string, unknown>,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const token = await createJwt(
    {
      sub: userId ?? TEST_USER_ID,
      iat: now,
      exp: now + 3600,
      ...extraClaims,
    },
    JWT_SECRET,
  );
  return `Bearer ${token}`;
}

// ---------------------------------------------------------------------------
// Minimal mock Env
// ---------------------------------------------------------------------------

function createMinimalEnv(): Env {
  return {
    JWT_SECRET,
    DB: {} as D1Database,
    USER_GRAPH: {} as DurableObjectNamespace,
    ACCOUNT: {} as DurableObjectNamespace,
    SYNC_QUEUE: {} as Queue,
    WRITE_QUEUE: {} as Queue,
    SESSIONS: {} as KVNamespace,
  };
}

const mockCtx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

// ---------------------------------------------------------------------------
// Workspace dependency resolution
// ---------------------------------------------------------------------------

describe("workspace dependency resolution", () => {
  it("imports APP_NAME from @tminus/shared via workspace link", () => {
    expect(APP_NAME).toBe("tminus");
  });

  it("imports SCHEMA_VERSION from @tminus/shared via workspace link", () => {
    expect(SCHEMA_VERSION).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// API worker: module shape
// ---------------------------------------------------------------------------

describe("api worker", () => {
  it("default export has a fetch handler", async () => {
    const mod = await import("./index");
    expect(mod.default).toBeDefined();
    expect(typeof mod.default.fetch).toBe("function");
  });

  it("exports createHandler factory", async () => {
    const mod = await import("./index");
    expect(typeof mod.createHandler).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// JWT validation unit tests
// ---------------------------------------------------------------------------

describe("JWT validation", () => {
  it("verifyJwt returns payload for valid token", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await createJwt(
      { sub: TEST_USER_ID, iat: now, exp: now + 3600 },
      JWT_SECRET,
    );

    const result = await verifyJwt(token, JWT_SECRET);
    expect(result).not.toBeNull();
    expect(result!.sub).toBe(TEST_USER_ID);
  });

  it("verifyJwt returns null for wrong secret", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await createJwt(
      { sub: TEST_USER_ID, iat: now, exp: now + 3600 },
      JWT_SECRET,
    );

    const result = await verifyJwt(token, "wrong-secret-entirely-different");
    expect(result).toBeNull();
  });

  it("verifyJwt returns null for expired token", async () => {
    const pastTime = Math.floor(Date.now() / 1000) - 7200; // 2 hours ago
    const token = await createJwt(
      { sub: TEST_USER_ID, iat: pastTime, exp: pastTime + 3600 },
      JWT_SECRET,
    );

    const result = await verifyJwt(token, JWT_SECRET);
    expect(result).toBeNull();
  });

  it("verifyJwt returns null for token without sub claim", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await createJwt(
      { user: TEST_USER_ID, iat: now, exp: now + 3600 },
      JWT_SECRET,
    );

    const result = await verifyJwt(token, JWT_SECRET);
    expect(result).toBeNull();
  });

  it("verifyJwt returns null for malformed token string", async () => {
    expect(await verifyJwt("not.a.valid.jwt", JWT_SECRET)).toBeNull();
    expect(await verifyJwt("", JWT_SECRET)).toBeNull();
    expect(await verifyJwt("just-one-part", JWT_SECRET)).toBeNull();
    expect(await verifyJwt("two.parts", JWT_SECRET)).toBeNull();
  });

  it("verifyJwt accepts token without exp (no expiry check)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await createJwt({ sub: TEST_USER_ID, iat: now }, JWT_SECRET);

    const result = await verifyJwt(token, JWT_SECRET);
    expect(result).not.toBeNull();
    expect(result!.sub).toBe(TEST_USER_ID);
  });

  it("createJwt produces a 3-part dot-separated string", async () => {
    const token = await createJwt({ sub: "test" }, JWT_SECRET);
    const parts = token.split(".");
    expect(parts).toHaveLength(3);
    // All parts should be non-empty
    expect(parts[0].length).toBeGreaterThan(0);
    expect(parts[1].length).toBeGreaterThan(0);
    expect(parts[2].length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Response envelope unit tests
// ---------------------------------------------------------------------------

describe("response envelope", () => {
  it("successEnvelope has ok=true, data, and meta with request_id and timestamp", () => {
    const envelope = successEnvelope({ items: [1, 2, 3] });
    expect(envelope.ok).toBe(true);
    expect(envelope.data).toEqual({ items: [1, 2, 3] });
    expect(envelope.error).toBeUndefined();
    expect(envelope.meta.request_id).toMatch(/^req_/);
    expect(typeof envelope.meta.timestamp).toBe("string");
    // Timestamp should be valid ISO
    expect(new Date(envelope.meta.timestamp).getTime()).not.toBeNaN();
  });

  it("successEnvelope includes next_cursor when provided", () => {
    const envelope = successEnvelope([], { next_cursor: "abc123" });
    expect(envelope.meta.next_cursor).toBe("abc123");
  });

  it("successEnvelope omits next_cursor when not provided", () => {
    const envelope = successEnvelope([]);
    expect(envelope.meta.next_cursor).toBeUndefined();
  });

  it("errorEnvelope has ok=false, error string, and meta", () => {
    const envelope = errorEnvelope("Something went wrong", "INTERNAL_ERROR");
    expect(envelope.ok).toBe(false);
    expect(envelope.error).toBe("Something went wrong");
    expect(envelope.data).toBeUndefined();
    expect(envelope.meta.request_id).toMatch(/^req_/);
    expect(typeof envelope.meta.timestamp).toBe("string");
  });

  it("ErrorCode maps error names to HTTP status codes", () => {
    expect(ErrorCode.VALIDATION_ERROR).toBe(400);
    expect(ErrorCode.AUTH_REQUIRED).toBe(401);
    expect(ErrorCode.FORBIDDEN).toBe(403);
    expect(ErrorCode.NOT_FOUND).toBe(404);
    expect(ErrorCode.CONFLICT).toBe(409);
    expect(ErrorCode.INTERNAL_ERROR).toBe(500);
    expect(ErrorCode.PROVIDER_ERROR).toBe(502);
    expect(ErrorCode.PROVIDER_QUOTA).toBe(429);
  });
});

// ---------------------------------------------------------------------------
// Routing: Health endpoint (no auth)
// ---------------------------------------------------------------------------

describe("routing: health endpoint", () => {
  it("GET /health returns 200 OK without auth", async () => {
    const handler = createHandler();
    const env = createMinimalEnv();
    const request = new Request("https://api.tminus.dev/health", {
      method: "GET",
    });

    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("OK");
  });
});

// ---------------------------------------------------------------------------
// Routing: CORS preflight
// ---------------------------------------------------------------------------

describe("routing: CORS preflight", () => {
  it("OPTIONS request returns 204 with CORS headers", async () => {
    const handler = createHandler();
    const env = createMinimalEnv();
    const request = new Request("https://api.tminus.dev/v1/events", {
      method: "OPTIONS",
    });

    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain("GET");
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(response.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
  });
});

// ---------------------------------------------------------------------------
// Routing: Auth enforcement
// ---------------------------------------------------------------------------

describe("routing: auth enforcement", () => {
  it("returns 401 for /v1/* routes without Authorization header", async () => {
    const handler = createHandler();
    const env = createMinimalEnv();
    const request = new Request("https://api.tminus.dev/v1/events", {
      method: "GET",
    });

    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(401);

    const body = await response.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("Authentication required");
  });

  it("returns 401 for invalid Bearer token", async () => {
    const handler = createHandler();
    const env = createMinimalEnv();
    const request = new Request("https://api.tminus.dev/v1/events", {
      method: "GET",
      headers: { Authorization: "Bearer invalid-token-here" },
    });

    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(401);
  });

  it("returns 401 for non-Bearer auth scheme", async () => {
    const handler = createHandler();
    const env = createMinimalEnv();
    const request = new Request("https://api.tminus.dev/v1/events", {
      method: "GET",
      headers: { Authorization: "Basic dXNlcjpwYXNz" },
    });

    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Routing: Unknown routes
// ---------------------------------------------------------------------------

describe("routing: unknown routes", () => {
  it("non-v1 paths return 404 with envelope", async () => {
    const handler = createHandler();
    const env = createMinimalEnv();
    const request = new Request("https://api.tminus.dev/unknown", {
      method: "GET",
    });

    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(404);

    const body = await response.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
  });

  it("unknown v1 path returns 404 with envelope (with valid auth)", async () => {
    const handler = createHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();
    const request = new Request("https://api.tminus.dev/v1/nonexistent", {
      method: "GET",
      headers: { Authorization: authHeader },
    });

    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(404);

    const body = await response.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("Not Found");
  });
});

// ---------------------------------------------------------------------------
// Routing: All defined routes return JSON with envelope structure
// ---------------------------------------------------------------------------

describe("routing: response format", () => {
  it("all error responses have Content-Type application/json", async () => {
    const handler = createHandler();
    const env = createMinimalEnv();

    // 404 response
    const req404 = new Request("https://api.tminus.dev/v1/nonexistent", {
      method: "GET",
      headers: { Authorization: await makeAuthHeader() },
    });
    const res404 = await handler.fetch(req404, env, mockCtx);
    expect(res404.headers.get("Content-Type")).toBe("application/json");

    // 401 response
    const req401 = new Request("https://api.tminus.dev/v1/events", {
      method: "GET",
    });
    const res401 = await handler.fetch(req401, env, mockCtx);
    expect(res401.headers.get("Content-Type")).toBe("application/json");
  });
});

// ---------------------------------------------------------------------------
// Request validation unit tests
// ---------------------------------------------------------------------------

describe("request validation: events", () => {
  it("POST /v1/events without body returns 400", async () => {
    // We need a mock DO namespace that won't be reached because validation
    // fails before the DO call
    const handler = createHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    const request = new Request("https://api.tminus.dev/v1/events", {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
    });

    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(400);

    const body = await response.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("valid JSON");
  });

  it("POST /v1/events without start/end returns 400", async () => {
    const handler = createHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    const request = new Request("https://api.tminus.dev/v1/events", {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title: "Test Event" }),
    });

    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(400);

    const body = await response.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("start and end");
  });

  it("GET /v1/events/:id with non-ULID ID returns 400", async () => {
    const handler = createHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    const request = new Request("https://api.tminus.dev/v1/events/not-a-valid-id", {
      method: "GET",
      headers: { Authorization: authHeader },
    });

    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(400);

    const body = await response.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("Invalid event ID");
  });

  it("PATCH /v1/events/:id with invalid ID returns 400", async () => {
    const handler = createHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    const request = new Request("https://api.tminus.dev/v1/events/bad-id", {
      method: "PATCH",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title: "Updated" }),
    });

    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(400);
  });

  it("DELETE /v1/events/:id with invalid ID returns 400", async () => {
    const handler = createHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    const request = new Request("https://api.tminus.dev/v1/events/bad-id", {
      method: "DELETE",
      headers: { Authorization: authHeader },
    });

    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(400);
  });
});

describe("request validation: accounts", () => {
  it("GET /v1/accounts/:id with invalid ID returns 400", async () => {
    const handler = createHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    const request = new Request("https://api.tminus.dev/v1/accounts/not-valid", {
      method: "GET",
      headers: { Authorization: authHeader },
    });

    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(400);
  });

  it("DELETE /v1/accounts/:id with invalid ID returns 400", async () => {
    const handler = createHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    const request = new Request("https://api.tminus.dev/v1/accounts/not-valid", {
      method: "DELETE",
      headers: { Authorization: authHeader },
    });

    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(400);
  });
});

describe("request validation: policies", () => {
  it("GET /v1/policies/:id with invalid ID returns 400", async () => {
    const handler = createHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    const request = new Request("https://api.tminus.dev/v1/policies/not-valid", {
      method: "GET",
      headers: { Authorization: authHeader },
    });

    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(400);
  });

  it("POST /v1/policies without name returns 400", async () => {
    const handler = createHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    const request = new Request("https://api.tminus.dev/v1/policies", {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ description: "No name provided" }),
    });

    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(400);

    const body = await response.json() as { ok: boolean; error: string };
    expect(body.error).toContain("name");
  });

  it("PUT /v1/policies/:id/edges without edges array returns 400", async () => {
    const handler = createHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    // Use a syntactically valid policy ID to get past ID validation
    // We need a pol_ prefix + 26 Crockford Base32 chars
    const request = new Request(
      "https://api.tminus.dev/v1/policies/pol_01HXYZ00000000000000000001/edges",
      {
        method: "PUT",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ not_edges: [] }),
      },
    );

    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(400);

    const body = await response.json() as { ok: boolean; error: string };
    expect(body.error).toContain("edges array");
  });
});

describe("request validation: sync status", () => {
  it("GET /v1/sync/status/:id with invalid ID returns 400", async () => {
    const handler = createHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    const request = new Request("https://api.tminus.dev/v1/sync/status/not-valid", {
      method: "GET",
      headers: { Authorization: authHeader },
    });

    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(400);
  });
});
